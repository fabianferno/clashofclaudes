//! Tauri commands, app events and shared state. JS names are the camelCase of these fns.
use crate::adapters::AdapterRegistry;
use crate::git::{self, Review};
use crate::model::{AgentKind, AppData, Builder, SessionInfo, SessionKind, Workspace};
use crate::persist;
use crate::sessions::{CloseOutcome, SessionManager};
use anyhow::{anyhow, bail, Context};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

/// Output channels by session id, shared with the manager's emit closure.
pub type Channels = Arc<Mutex<HashMap<String, Channel<InvokeResponseBody>>>>;

pub struct AppState {
    pub data: Mutex<AppData>,
    pub data_path: PathBuf,
    pub manager: Arc<SessionManager>,
    pub registry: AdapterRegistry,
    pub channels: Channels,
}

impl AppState {
    fn data(&self) -> MutexGuard<'_, AppData> {
        self.data.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Persists the current data (call with the guard still held so writes stay ordered).
    fn save(&self, d: &AppData) -> Result<(), String> {
        if let Some(dir) = self.data_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        persist::save(&self.data_path, d).map_err(fmt_err)
    }
}

fn fmt_err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A workspace named after the folder at `path`.
pub fn workspace_from_path(path: &Path, now: i64) -> anyhow::Result<Workspace> {
    if !path.is_dir() {
        bail!("{} is not a folder", path.display());
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| anyhow!("{} has no folder name", path.display()))?;
    Ok(Workspace { id: Uuid::new_v4().to_string(), name, path: path.to_path_buf(), created_at: now, missing: false })
}

/// Trimmed builder name, 1 to 40 characters.
pub fn validate_builder_name(name: &str) -> anyhow::Result<String> {
    let n = name.trim();
    let len = n.chars().count();
    if len == 0 || len > 40 {
        bail!("builder name must be 1 to 40 characters");
    }
    Ok(n.to_string())
}

fn check_builder(b: &Builder) -> anyhow::Result<()> {
    if b.agent == AgentKind::Custom && b.custom_command.as_deref().map_or(true, |c| c.trim().is_empty()) {
        bail!("a custom builder needs a command");
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    workspaces: Vec<Workspace>,
    builders: Vec<Builder>,
    sessions: Vec<SessionInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    kind: AgentKind,
    label: &'static str,
    installed: bool,
    version: Option<String>,
    models: Vec<String>,
    efforts: Vec<String>,
    can_approve: bool,
}

#[derive(Serialize, Clone)]
pub struct Removed {
    pub id: String,
}

#[derive(Serialize, Clone)]
pub struct ConfirmQuit {
    pub live: usize,
}

#[tauri::command]
pub fn list_state(state: State<'_, AppState>) -> StateSnapshot {
    let d = state.data();
    StateSnapshot { workspaces: d.workspaces.clone(), builders: d.builders.clone(), sessions: state.manager.list() }
}

#[tauri::command]
pub async fn detect_agents(state: State<'_, AppState>) -> Result<Vec<AgentInfo>, String> {
    Ok(state
        .registry
        .all()
        .iter()
        .map(|a| {
            let d = a.detect();
            AgentInfo {
                kind: a.kind(),
                label: a.label(),
                installed: d.installed,
                version: d.version,
                models: a.models(),
                efforts: a.efforts(),
                can_approve: a.approve_keys().is_some() && a.deny_keys().is_some(),
            }
        })
        .collect())
}

#[tauri::command]
pub fn add_workspace(path: String, state: State<'_, AppState>) -> Result<Workspace, String> {
    let p = std::fs::canonicalize(&path).with_context(|| format!("cannot open {path}")).map_err(fmt_err)?;
    let ws = workspace_from_path(&p, now_ms()).map_err(fmt_err)?;
    let mut d = state.data();
    if d.workspaces.iter().any(|w| w.path == ws.path) {
        return Err("this folder is already added".into());
    }
    d.workspaces.push(ws.clone());
    state.save(&d)?;
    Ok(ws)
}

#[tauri::command]
pub async fn create_workspace(parent: String, name: String, state: State<'_, AppState>) -> Result<Workspace, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err("invalid folder name".into());
    }
    let dir = Path::new(&parent).join(name);
    if dir.exists() {
        return Err(format!("{} already exists", dir.display()));
    }
    std::fs::create_dir(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    if let Err(e) = git::init_repo(&dir) {
        let _ = std::fs::remove_dir(&dir);
        return Err(fmt_err(e));
    }
    let p = std::fs::canonicalize(&dir).unwrap_or(dir);
    let ws = workspace_from_path(&p, now_ms()).map_err(fmt_err)?;
    let mut d = state.data();
    d.workspaces.push(ws.clone());
    state.save(&d)?;
    Ok(ws)
}

#[tauri::command]
pub fn remove_workspace(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let live = state.manager.list().iter().any(|s| s.workspace_id == id && !matches!(s.state, crate::model::SessionState::Ended { .. }));
    if live {
        return Err("this workspace has running sessions".into());
    }
    let mut d = state.data();
    d.workspaces.retain(|w| w.id != id);
    state.save(&d)
}

#[tauri::command]
pub fn create_builder(
    name: String,
    agent: AgentKind,
    model: Option<String>,
    effort: Option<String>,
    custom_command: Option<String>,
    state: State<'_, AppState>,
) -> Result<Builder, String> {
    let b = Builder { id: Uuid::new_v4().to_string(), name: validate_builder_name(&name).map_err(fmt_err)?, agent, model, effort, custom_command };
    check_builder(&b).map_err(fmt_err)?;
    let mut d = state.data();
    d.builders.push(b.clone());
    state.save(&d)?;
    Ok(b)
}

#[tauri::command]
pub fn update_builder(mut builder: Builder, state: State<'_, AppState>) -> Result<(), String> {
    builder.name = validate_builder_name(&builder.name).map_err(fmt_err)?;
    check_builder(&builder).map_err(fmt_err)?;
    let mut d = state.data();
    let slot = d.builders.iter_mut().find(|b| b.id == builder.id).ok_or("unknown builder")?;
    *slot = builder;
    state.save(&d)
}

#[tauri::command]
pub fn delete_builder(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let busy = state.manager.list().iter().any(|s| {
        !matches!(s.state, crate::model::SessionState::Ended { .. })
            && matches!(&s.kind, SessionKind::Agent { builder_id } if *builder_id == id)
    });
    if busy {
        return Err("this builder has a running session".into());
    }
    let mut d = state.data();
    d.builders.retain(|b| b.id != id);
    state.save(&d)
}

fn find_workspace(state: &AppState, id: &str) -> Result<Workspace, String> {
    state.data().workspaces.iter().find(|w| w.id == id).cloned().ok_or_else(|| "unknown workspace".to_string())
}

#[tauri::command]
pub async fn start_session(workspace_id: String, builder_id: String, task: String, state: State<'_, AppState>) -> Result<SessionInfo, String> {
    let ws = find_workspace(&state, &workspace_id)?;
    let builder = state.data().builders.iter().find(|b| b.id == builder_id).cloned().ok_or("unknown builder")?;
    let task = task.trim();
    state.manager.start_agent(&ws, &builder, (!task.is_empty()).then_some(task)).map_err(fmt_err)
}

#[tauri::command]
pub async fn start_terminal(workspace_id: String, state: State<'_, AppState>) -> Result<SessionInfo, String> {
    let ws = find_workspace(&state, &workspace_id)?;
    state.manager.start_terminal(&ws).map_err(fmt_err)
}

#[tauri::command]
pub fn write_session(id: String, data: Vec<u8>, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.write(&id, &data).map_err(fmt_err)
}

#[tauri::command]
pub fn resize_session(id: String, cols: u16, rows: u16, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.resize(&id, cols, rows).map_err(fmt_err)
}

#[tauri::command]
pub fn approve(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.approve(&id).map_err(fmt_err)
}

#[tauri::command]
pub fn deny(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.deny(&id).map_err(fmt_err)
}

#[tauri::command]
pub fn stop_session(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.stop(&id).map_err(fmt_err)
}

#[tauri::command]
pub async fn close_session(id: String, state: State<'_, AppState>) -> Result<CloseOutcome, String> {
    state.channels.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    state.manager.close(&id).map_err(fmt_err)
}

#[tauri::command]
pub async fn review_session(id: String, state: State<'_, AppState>) -> Result<Review, String> {
    state.manager.review(&id).map_err(fmt_err)
}

/// Returns the scrollback snapshot, then streams the session's output to `on_data`.
///
/// Framing (both the returned body and every channel message): raw bytes
/// `[u64 little-endian start_offset][payload bytes]`, where `start_offset` is the position,
/// in bytes since the session started, of the first payload byte. The snapshot is followed
/// by output starting at `snapshot_start + snapshot_len`, but an output frame already in
/// flight may overlap the snapshot, so the client must drop payload bytes at positions below
/// what it has already written (and may see a gap only if the snapshot itself was capped).
#[tauri::command]
pub fn attach_session(id: String, on_data: Channel<InvokeResponseBody>, state: State<'_, AppState>) -> Result<Response, String> {
    // Register first so no output falls between the snapshot and the channel.
    state.channels.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), on_data);
    match state.manager.attach(&id) {
        Ok((snap, start)) => Ok(Response::new(frame(start, &snap))),
        Err(e) => {
            state.channels.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            Err(fmt_err(e))
        }
    }
}

pub fn frame(offset: u64, data: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(8 + data.len());
    f.extend_from_slice(&offset.to_le_bytes());
    f.extend_from_slice(data);
    f
}

#[tauri::command]
pub fn detach_session(id: String, state: State<'_, AppState>) {
    state.channels.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
}

/// Kills every session and exits (the user confirmed quitting).
#[tauri::command]
pub async fn quit_now(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    for s in state.manager.list() {
        let _ = state.manager.close(&s.id);
    }
    app.exit(0);
    Ok(())
}

pub fn emit_confirm_quit(app: &AppHandle, live: usize) {
    let _ = app.emit("confirm-quit", ConfirmQuit { live });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_name_is_folder_name() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("my app");
        std::fs::create_dir(&p).unwrap();
        let w = workspace_from_path(&p, 5).unwrap();
        assert_eq!((w.name.as_str(), w.created_at, w.missing), ("my app", 5, false));
    }

    #[test]
    fn workspace_from_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, "x").unwrap();
        assert!(workspace_from_path(&f, 0).is_err());
        assert!(workspace_from_path(&dir.path().join("nope"), 0).is_err());
    }

    #[test]
    fn builder_name_trimmed_and_bounded() {
        assert_eq!(validate_builder_name("  Ada ").unwrap(), "Ada");
        assert!(validate_builder_name("").is_err());
        assert!(validate_builder_name("   ").is_err());
        assert!(validate_builder_name(&"x".repeat(41)).is_err());
        assert!(validate_builder_name(&"x".repeat(40)).is_ok());
    }

    #[test]
    fn frame_is_le_offset_then_payload() {
        assert_eq!(frame(258, b"hi"), vec![2, 1, 0, 0, 0, 0, 0, 0, b'h', b'i']);
    }
}
