//! Tauri commands, app events and shared state. JS names are the camelCase of these fns.
//! Events: `session-updated` (SessionInfo), `session-removed` {id}, `workspace-updated`
//! (Workspace), `stats-updated` (Stats), `confirm-quit` {live}.
use crate::adapters::AdapterRegistry;
use crate::git::{self, Review};
use crate::model::{AgentKind, AppData, Builder, Compound, SessionInfo, SessionKind, Stats, Tile, Workspace};
use crate::persist;
use crate::sessions::{ClosedSession, SessionManager, WorkspaceMissing};
use crate::xp;
use anyhow::{anyhow, bail, Context};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

/// Output channels by session id, shared with the manager's emit closure.
pub type Channels = Arc<Mutex<HashMap<String, Channel<InvokeResponseBody>>>>;

pub struct AppState {
    pub data: Mutex<AppData>,
    pub data_path: PathBuf,
    pub manager: Arc<SessionManager>,
    pub registry: AdapterRegistry,
    pub channels: Channels,
    /// Set once the user confirmed quitting, so the exit guard lets the exit through.
    pub exit_confirmed: AtomicBool,
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
    Ok(Workspace { id: Uuid::new_v4().to_string(), name, path: path.to_path_buf(), created_at: now, missing: false, level: 1, xp: 0, compound: None })
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
    stats: Stats,
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
    StateSnapshot { workspaces: d.workspaces.clone(), builders: d.builders.clone(), sessions: state.manager.list(), stats: d.stats.clone() }
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

/// Sets `missing` on workspace `id`; returns it when the flag changed (so it must be saved and sent).
pub fn flag_workspace_missing(d: &mut AppData, id: &str) -> Option<Workspace> {
    let w = d.workspaces.iter_mut().find(|w| w.id == id && !w.missing)?;
    w.missing = true;
    Some(w.clone())
}

fn find_workspace(state: &AppState, id: &str) -> Result<Workspace, String> {
    state.data().workspaces.iter().find(|w| w.id == id).cloned().ok_or_else(|| "unknown workspace".to_string())
}

/// Maps a start error; a vanished folder also flags the workspace missing (saved and sent as
/// `workspace-updated`) so the UI shows its badge.
fn start_err(app: &AppHandle, state: &AppState, workspace_id: &str, e: anyhow::Error) -> String {
    if e.downcast_ref::<WorkspaceMissing>().is_some() {
        let mut d = state.data();
        if let Some(w) = flag_workspace_missing(&mut d, workspace_id) {
            let _ = state.save(&d);
            let _ = app.emit("workspace-updated", w);
        }
    }
    fmt_err(e)
}

#[tauri::command]
pub async fn start_session(workspace_id: String, builder_id: String, task: String, app: AppHandle, state: State<'_, AppState>) -> Result<SessionInfo, String> {
    let ws = find_workspace(&state, &workspace_id)?;
    let builder = state.data().builders.iter().find(|b| b.id == builder_id).cloned().ok_or("unknown builder")?;
    let task = task.trim();
    state.manager.start_agent(&ws, &builder, (!task.is_empty()).then_some(task)).map_err(|e| start_err(&app, &state, &workspace_id, e))
}

#[tauri::command]
pub async fn start_terminal(workspace_id: String, app: AppHandle, state: State<'_, AppState>) -> Result<SessionInfo, String> {
    let ws = find_workspace(&state, &workspace_id)?;
    state.manager.start_terminal(&ws).map_err(|e| start_err(&app, &state, &workspace_id, e))
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
pub async fn close_session(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<CloseOutcome, String> {
    state.channels.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    let closed = state.manager.close(&id).map_err(fmt_err)?;
    let outcome;
    let (ws, stats) = {
        let mut d = state.data();
        let before = d.workspaces.iter().find(|w| w.id == closed.workspace_id).cloned();
        outcome = apply_close(&mut d, &closed, now_ms());
        if outcome.earned_xp {
            state.save(&d)?;
        }
        let after = d.workspaces.iter().find(|w| w.id == closed.workspace_id).cloned();
        (if before != after { after } else { None }, d.stats.clone())
    };
    if outcome.earned_xp {
        if let Some(w) = ws {
            let _ = app.emit("workspace-updated", w);
        }
        let _ = app.emit("stats-updated", stats);
    }
    Ok(outcome)
}

/// What closing a session did, for the UI notice.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseOutcome {
    pub earned_xp: bool,
    pub xp_gained: u32,
    pub level_before: u32,
    pub level_after: u32,
    pub workspace_id: String,
    /// An agent was closed before it ever finished (terminals never count).
    pub unfinished: bool,
}

/// Applies the XP rules for a closed session. A finished, not-stuck agent session earns
/// `XP_PER_SESSION` for its workspace and counts as a ship. XP never depends on the
/// session's builder settings (spec §4).
pub fn apply_close(d: &mut AppData, closed: &ClosedSession, now_ms: i64) -> CloseOutcome {
    let mut out = CloseOutcome {
        earned_xp: false,
        xp_gained: 0,
        level_before: 1,
        level_after: 1,
        workspace_id: closed.workspace_id.clone(),
        unfinished: closed.is_agent && !closed.reached_finished,
    };
    let earns = closed.is_agent && closed.reached_finished && !closed.stuck;
    let Some(w) = d.workspaces.iter_mut().find(|w| w.id == closed.workspace_id) else { return out };
    out.level_before = w.level;
    out.level_after = w.level;
    if !earns {
        return out;
    }
    let (level, xp_now) = xp::award(w.level, w.xp, xp::XP_PER_SESSION);
    w.level = level;
    w.xp = xp_now;
    out.earned_xp = true;
    out.xp_gained = xp::XP_PER_SESSION;
    out.level_after = level;
    d.stats.shipped_total += 1;
    d.stats.recent_ships.push(now_ms);
    d.stats.recent_ships.retain(|t| now_ms - t <= persist::SHIP_WINDOW_MS);
    out
}

/// Sets the compound of workspace `id`.
pub fn apply_compound(d: &mut AppData, id: &str, compound: Compound) -> Result<Workspace, String> {
    let w = d.workspaces.iter_mut().find(|w| w.id == id).ok_or("unknown workspace")?;
    w.compound = Some(compound);
    Ok(w.clone())
}

#[tauri::command]
pub fn set_compound(workspace_id: String, compound: Compound, app: AppHandle, state: State<'_, AppState>) -> Result<Workspace, String> {
    let ws = {
        let mut d = state.data();
        let ws = apply_compound(&mut d, &workspace_id, compound)?;
        state.save(&d)?;
        ws
    };
    let _ = app.emit("workspace-updated", ws.clone());
    Ok(ws)
}

/// Records where a session's builder stands; the manager emits `session-updated`.
#[tauri::command]
pub fn set_session_spot(id: String, spot: Tile, state: State<'_, AppState>) -> Result<SessionInfo, String> {
    state.manager.set_spot(&id, spot).map_err(fmt_err)
}

/// Opens `path` in VS Code or Cursor if either is on PATH, else with the system opener.
/// Argv only (no shell); the editor is spawned, not waited for.
#[tauri::command]
pub fn open_in_editor(path: String, app: AppHandle) -> Result<(), String> {
    for editor in ["code", "cursor"] {
        if let Some(bin) = crate::platform::which(editor) {
            return std::process::Command::new(bin)
                .arg(&path)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("cannot start {editor}: {e}"));
        }
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn review_session(id: String, state: State<'_, AppState>) -> Result<Review, String> {
    state.manager.review(&id).map_err(fmt_err)
}

/// Returns the scrollback snapshot, then streams the session's output to `on_data`.
///
/// Framing (both the returned body and every channel message): raw bytes
/// `[u64 little-endian header][payload bytes]`. Normally the header is `start_offset`, the
/// position, in bytes since the session started, of the first payload byte. The snapshot is
/// followed by output starting at `snapshot_start + snapshot_len`, but a frame already in
/// flight may overlap the snapshot, so the client must drop payload bytes at positions below
/// what it has already written (and may see a gap only if the snapshot itself was capped).
///
/// Flow control: after one output frame, no further one is sent until the client calls
/// `ack_output(id, end)` with `end` = that frame's `start_offset + payload_len`, once the
/// terminal has finished writing it. Acking a fully-overlapped frame is still required.
///
/// Skip marker: when the client fell so far behind that buffered output was dropped, the
/// next output frame is preceded by one frame whose header has bit 63 set (`SKIP_FLAG`); its
/// low bits are the stream position where output resumes and its payload is a dim
/// "output skipped" line. The client writes that payload as-is, does not count it in its
/// stream position and does not ack it.
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

/// Header bit marking a skip-marker frame (stream offsets never reach 2^63).
pub const SKIP_FLAG: u64 = 1 << 63;
const SKIP_MARKER: &str = "\r\n\x1b[2m[… output skipped …]\x1b[0m\r\n";

/// Skip-marker frame: header `SKIP_FLAG | offset` (the stream position where output resumes),
/// payload a dim marker line. Its bytes are display-only, outside the stream offset space.
pub fn skip_frame(offset: u64) -> Vec<u8> {
    frame(SKIP_FLAG | offset, SKIP_MARKER.as_bytes())
}

/// Output frame: `[u64 LE offset][payload]`.
pub fn frame(offset: u64, data: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(8 + data.len());
    f.extend_from_slice(&offset.to_le_bytes());
    f.extend_from_slice(data);
    f
}

/// The client finished writing output up to stream position `offset` (see `attach_session`).
#[tauri::command]
pub fn ack_output(id: String, offset: u64, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.ack(&id, offset).map_err(fmt_err)
}

#[tauri::command]
pub fn detach_session(id: String, state: State<'_, AppState>) {
    state.channels.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    let _ = state.manager.detach(&id);
}

/// Kills every session and exits (the user confirmed quitting).
#[tauri::command]
pub async fn quit_now(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.exit_confirmed.store(true, Ordering::SeqCst);
    for s in state.manager.list() {
        let _ = state.manager.close(&s.id);
    }
    app.exit(0);
    Ok(())
}

/// Whether a close/exit request must be held back for the user to confirm.
pub fn should_block_exit(live: usize, confirmed: bool) -> bool {
    live > 0 && !confirmed
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
    fn exit_blocked_only_when_live_and_unconfirmed() {
        assert!(!should_block_exit(0, false));
        assert!(should_block_exit(2, false));
        assert!(!should_block_exit(2, true));
    }

    #[test]
    fn flag_missing_marks_only_that_workspace_once() {
        let ws = |id: &str| Workspace { id: id.into(), name: id.into(), path: PathBuf::from("/nope"), created_at: 0, missing: false, level: 1, xp: 0, compound: None };
        let mut d = AppData { workspaces: vec![ws("a"), ws("b")], ..AppData::default() };
        let w = flag_workspace_missing(&mut d, "b").unwrap();
        assert!(w.missing && w.id == "b");
        assert!(!d.workspaces[0].missing && d.workspaces[1].missing);
        assert!(flag_workspace_missing(&mut d, "b").is_none(), "already flagged: nothing to persist");
        assert!(flag_workspace_missing(&mut d, "zzz").is_none());
    }

    fn village() -> AppData {
        let ws = Workspace { id: "w1".into(), name: "w".into(), path: PathBuf::from("/nope"), created_at: 0, missing: false, level: 1, xp: 0, compound: None };
        AppData { workspaces: vec![ws], ..AppData::default() }
    }

    fn closed(is_agent: bool, reached_finished: bool, stuck: bool) -> ClosedSession {
        ClosedSession { workspace_id: "w1".into(), is_agent, reached_finished, stuck }
    }

    #[test]
    fn close_finished_awards_xp_and_stats() {
        let mut d = village();
        let o = apply_close(&mut d, &closed(true, true, false), 5_000);
        assert_eq!(
            o,
            CloseOutcome { earned_xp: true, xp_gained: 100, level_before: 1, level_after: 2, workspace_id: "w1".into(), unfinished: false }
        );
        assert_eq!((d.workspaces[0].level, d.workspaces[0].xp), (2, 0));
        assert_eq!((d.stats.shipped_total, d.stats.recent_ships.clone()), (1, vec![5_000]));
        let json = serde_json::to_value(&o).unwrap();
        assert_eq!(json["earnedXp"], true);
        assert_eq!(json["levelAfter"], 2);
    }

    #[test]
    fn close_unfinished_reports_reason() {
        let mut d = village();
        let before = d.clone();
        let o = apply_close(&mut d, &closed(true, false, false), 5_000);
        assert_eq!((o.earned_xp, o.xp_gained, o.unfinished), (false, 0, true));
        assert_eq!(d, before);
    }

    #[test]
    fn close_terminal_is_quiet() {
        let mut d = village();
        let before = d.clone();
        let o = apply_close(&mut d, &closed(false, false, false), 5_000);
        assert_eq!((o.earned_xp, o.unfinished), (false, false));
        assert_eq!(d, before);
    }

    #[test]
    fn close_stuck_after_finish_earns_nothing() {
        let mut d = village();
        let o = apply_close(&mut d, &closed(true, true, true), 1);
        assert!(!o.earned_xp);
        assert_eq!(d.stats.shipped_total, 0);
    }

    #[test]
    fn set_compound_persists_and_rejects_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        let mut d = village();
        let c = Compound { x0: 2, y0: 3, w: 6, h: 5, house: Tile { x: 4, y: 5 } };
        let ws = apply_compound(&mut d, "w1", c.clone()).unwrap();
        assert_eq!(ws.compound, Some(c.clone()));
        persist::save(&p, &d).unwrap();
        assert_eq!(persist::load(&p).workspaces[0].compound, Some(c.clone()));
        assert!(apply_compound(&mut d, "nope", c).is_err());
    }

    #[test]
    fn skip_frame_sets_the_flag_bit_and_carries_the_marker() {
        let f = skip_frame(258);
        assert_eq!(u64::from_le_bytes(f[..8].try_into().unwrap()), SKIP_FLAG | 258);
        assert_eq!(&f[8..], "\r\n\x1b[2m[… output skipped …]\x1b[0m\r\n".as_bytes());
    }

    #[test]
    fn frame_is_le_offset_then_payload() {
        assert_eq!(frame(258, b"hi"), vec![2, 1, 0, 0, 0, 0, 0, 0, b'h', b'i']);
    }
}

/// Result of a driver evaluation, reported by the webview. Debug builds only.
#[cfg(debug_assertions)]
#[tauri::command]
pub fn driver_result(
    driver: State<'_, Arc<crate::driver::Driver>>,
    id: u64,
    ok: bool,
    value: serde_json::Value,
) -> Result<(), String> {
    driver.resolve(id, ok, value);
    Ok(())
}

#[cfg(not(debug_assertions))]
#[tauri::command]
pub fn driver_result(id: u64, ok: bool, value: serde_json::Value) -> Result<(), String> {
    let _ = (id, ok, value);
    Err("driver disabled".into())
}
