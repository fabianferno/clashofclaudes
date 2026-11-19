//! Tauri commands, app events and shared state. JS names are the camelCase of these fns.
//! Events: `session-updated` (SessionInfo), `session-removed` {id}, `workspace-updated`
//! (Workspace), `stats-updated` (Stats), `confirm-quit` {live, restart}, `update-progress` {pct}.
use crate::adapters::{AdapterRegistry, AgentAdapter};
use crate::attachments;
use crate::git::{self, Review};
use crate::history::{self, HistoryEntry};
use crate::saved::SavedSession;
use crate::model::{AgentKind, AppData, Builder, Compound, SessionInfo, SessionKind, Settings, Stats, Tile, Todo, Workspace};
use crate::persist;
use crate::updater::{self, UpdateStatus};
use crate::sessions::{ClosedSession, SessionManager, WorkspaceMissing};
use crate::xp;
use anyhow::{anyhow, bail, Context};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, Emitter, Manager, State};
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
    /// A found-but-not-yet-installed update (set by `check_for_update`).
    pub pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
}

impl AppState {
    pub(crate) fn data(&self) -> MutexGuard<'_, AppData> {
        self.data.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The folder holding state.json, sessions/ and attachments/.
    fn data_dir(&self) -> &Path {
        self.data_path.parent().unwrap_or(Path::new("."))
    }

    /// Changes where the mini village stands or whether it is open (`f` gets what was saved), and
    /// writes it down when `persist`.
    pub(crate) fn update_mini(&self, persist: bool, f: impl FnOnce(Option<crate::model::MiniWindow>) -> Option<crate::model::MiniWindow>) {
        let mut d = self.data();
        d.mini_window = f(d.mini_window);
        if persist {
            let _ = self.save(&d);
        }
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
    Ok(Workspace { id: Uuid::new_v4().to_string(), name, path: path.to_path_buf(), created_at: now, missing: false, level: 1, xp: 0, compound: None, color: None })
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
    collector_spots: BTreeMap<AgentKind, Tile>,
    todos: Vec<Todo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    kind: AgentKind,
    label: &'static str,
    installed: bool,
    version: Option<String>,
    models: Vec<String>,
    /// The models with display names and their own efforts (the picker's labels).
    model_choices: Vec<crate::adapters::ModelChoice>,
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
    /// The confirmation is for an update restart, not a quit.
    pub restart: bool,
}

#[tauri::command]
pub fn list_state(state: State<'_, AppState>) -> StateSnapshot {
    let d = state.data();
    StateSnapshot {
        workspaces: d.workspaces.clone(),
        builders: d.builders.clone(),
        sessions: state.manager.list(),
        stats: d.stats.clone(),
        collector_spots: d.collector_spots.clone(),
        todos: d.todos.clone(),
    }
}

#[tauri::command]
pub async fn detect_agents(force: Option<bool>, state: State<'_, AppState>) -> Result<Vec<AgentInfo>, String> {
    // Probes run `--version` (each time-limited by `adapters::PROBE_TIMEOUT`): keep them off the
    // async workers.
    let adapters = state.registry.all();
    tauri::async_runtime::spawn_blocking(move || detect_all(&adapters, force.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())
}

fn detect_all(adapters: &[Arc<dyn AgentAdapter>], force: bool) -> Vec<AgentInfo> {
    adapters
        .iter()
        .map(|a| {
            if force {
                a.invalidate_detection();
            }
            let d = a.detect();
            AgentInfo {
                kind: a.kind(),
                label: a.label(),
                installed: d.installed,
                version: d.version,
                models: a.models(),
                model_choices: a.model_choices(),
                efforts: a.efforts(),
                can_approve: a.approve_keys().is_some() && a.deny_keys().is_some(),
            }
        })
        .collect()
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

/// Where new folders go unless the user picks a parent: `~/Documents/.clashofclaudes`.
pub const DEFAULT_PROJECTS_DIR: &str = ".clashofclaudes";

/// Creates folder `name` inside `parent` and makes it a git repo; returns its canonical path.
/// `create_parent` creates a missing parent (the default projects folder); a picked parent
/// must already exist.
pub fn make_project_dir(parent: &Path, name: &str, create_parent: bool) -> Result<PathBuf, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err("invalid folder name".into());
    }
    if create_parent {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let dir = parent.join(name);
    if dir.exists() {
        return Err(format!("{} already exists", dir.display()));
    }
    std::fs::create_dir(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    if let Err(e) = git::init_repo(&dir) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(fmt_err(e));
    }
    Ok(std::fs::canonicalize(&dir).unwrap_or(dir))
}

/// The default parent for new folders (`~/Documents/.clashofclaudes`), shown in the UI.
#[tauri::command]
pub fn default_projects_dir(app: AppHandle) -> Result<String, String> {
    Ok(projects_dir(&app)?.display().to_string())
}

fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let docs = app.path().document_dir().map_err(|e| format!("cannot find Documents: {e}"))?;
    Ok(docs.join(DEFAULT_PROJECTS_DIR))
}

/// Creates folder `name` as a new workspace: inside `parent` when given (picked by the user),
/// otherwise inside the default projects folder, created on first use.
#[tauri::command]
pub async fn create_workspace(parent: Option<String>, name: String, app: AppHandle, state: State<'_, AppState>) -> Result<Workspace, String> {
    let p = match parent {
        Some(p) => make_project_dir(Path::new(&p), &name, false)?,
        None => make_project_dir(&projects_dir(&app)?, &name, true)?,
    };
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
    let gone: Vec<String> = d.todos.iter().filter(|t| t.workspace_id == id).flat_map(|t| t.images.clone()).collect();
    d.todos.retain(|t| t.workspace_id != id);
    state.save(&d)?;
    attachments::remove(state.data_dir(), &gone);
    drop(d);
    // Ended sessions would otherwise linger with no workspace to show them.
    for s in state.manager.list().into_iter().filter(|s| s.workspace_id == id) {
        let _ = state.manager.close(&s.id);
    }
    Ok(())
}

/// Re-checks every workspace folder (run when the window gains focus): a folder that came back
/// clears its `missing` badge, one that vanished gets it. Changes are saved and sent. The
/// folders are checked without the data lock (`is_dir` can stall on a network mount), and only
/// one recheck runs at a time.
pub fn recheck_workspaces(app: &AppHandle, state: &AppState) {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let paths: Vec<(String, PathBuf)> = state.data().workspaces.iter().map(|w| (w.id.clone(), w.path.clone())).collect();
    let checked: Vec<(String, bool)> = paths.into_iter().map(|(id, p)| (id, !p.is_dir())).collect();
    let mut d = state.data();
    let changed = persist::apply_missing(&mut d, &checked);
    if !changed.is_empty() {
        let _ = state.save(&d);
        // Sent under the lock, so a newer update to the same workspace can't be overtaken.
        for w in changed {
            let _ = app.emit("workspace-updated", w);
        }
    }
    drop(d);
    RUNNING.store(false, Ordering::SeqCst);
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
/// `worktree`: start it in its own git worktree, on a new branch from HEAD, kept in the app's data
/// folder (`worktrees/`), so its changes wait apart from the workspace's for review.
#[allow(clippy::too_many_arguments)]
pub async fn start_session(workspace_id: String, builder_id: String, task: String, images: Vec<String>, worktree: Option<bool>, app: AppHandle, state: State<'_, AppState>) -> Result<SessionInfo, String> {
    let mut ws = find_workspace(&state, &workspace_id)?;
    let builder = state.data().builders.iter().find(|b| b.id == builder_id).cloned().ok_or("unknown builder")?;
    let task = task.trim();
    let repo = ws.path.clone();
    let wt = if worktree.unwrap_or(false) {
        if ws.missing || !ws.path.exists() {
            return Err(start_err(&app, &state, &workspace_id, anyhow::Error::new(WorkspaceMissing(ws.path.clone()))));
        }
        let (at, branch) = worktree_place(state.data_dir(), &ws.name, task);
        let (info, cwd) = git::add_worktree(&ws.path, &at, &branch).map_err(fmt_err)?;
        ws.path = cwd;
        Some(info)
    } else {
        None
    };
    let s = match state.manager.start_agent(&ws, &builder, (!task.is_empty()).then_some(task), &images) {
        Ok(s) => s,
        Err(e) => {
            if let Some(wt) = &wt {
                git::remove_worktree(&repo, wt);
            }
            return Err(start_err(&app, &state, &workspace_id, e));
        }
    };
    crate::usage::track(&app, crate::usage::Event::SessionStarted(builder.agent));
    let Some(wt) = wt else { return Ok(s) };
    state.manager.set_worktree(&s.id, wt);
    Ok(state.manager.list().into_iter().find(|x| x.id == s.id).unwrap_or(s))
}

/// Where a new worktree for a task goes (under the app's data folder) and its branch name.
pub fn worktree_place(data_dir: &std::path::Path, ws_name: &str, task: &str) -> (PathBuf, String) {
    let short = Uuid::new_v4().simple().to_string()[..6].to_string();
    let name = git::slug(task, 32);
    let branch = if name.is_empty() { format!("coc/{short}") } else { format!("coc/{name}-{short}") };
    let ws = git::slug(ws_name, 24);
    let dir = if ws.is_empty() { short.clone() } else { format!("{ws}-{short}") };
    (data_dir.join("worktrees").join(dir), branch)
}

/// Puts a session aside out of the owner's queue with a note (`None` takes it back); it comes back
/// by itself when its state changes.
#[tauri::command]
pub fn park_session(id: String, note: Option<String>, state: State<'_, AppState>) -> Result<SessionInfo, String> {
    state.manager.set_parked(&id, note).map_err(fmt_err)
}

/// Saves an image pasted into a task (the raw bytes are the request body) and returns its name.
#[tauri::command]
pub fn save_attachment(request: tauri::ipc::Request<'_>, state: State<'_, AppState>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected the image bytes".into()) };
    attachments::save(state.data_dir(), bytes).map_err(fmt_err)
}

/// Saves a copy of an image file dropped on a task and returns its name.
#[tauri::command]
pub async fn import_attachment(path: PathBuf, state: State<'_, AppState>) -> Result<String, String> {
    attachments::import(state.data_dir(), &path).map_err(fmt_err)
}

/// An attachment's bytes, for its thumbnail.
#[tauri::command]
pub async fn read_attachment(name: String, state: State<'_, AppState>) -> Result<Response, String> {
    attachments::read(state.data_dir(), &name).map(Response::new).map_err(fmt_err)
}

/// Removes attachments taken off a task before it was added or started. Ones a To Do keeps stay.
#[tauri::command]
pub fn discard_attachments(names: Vec<String>, state: State<'_, AppState>) {
    let d = state.data();
    let kept: Vec<String> = names.into_iter().filter(|n| !d.todos.iter().any(|t| t.images.contains(n))).collect();
    attachments::remove(state.data_dir(), &kept);
}

#[tauri::command]
pub async fn start_terminal(workspace_id: String, app: AppHandle, state: State<'_, AppState>) -> Result<SessionInfo, String> {
    let ws = find_workspace(&state, &workspace_id)?;
    let s = state.manager.start_terminal(&ws).map_err(|e| start_err(&app, &state, &workspace_id, e))?;
    crate::usage::track(&app, crate::usage::Event::TerminalStarted);
    Ok(s)
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
pub fn approve(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.approve(&id).map_err(fmt_err)?;
    crate::usage::track(&app, crate::usage::Event::PromptAnswered { allowed: true });
    Ok(())
}

#[tauri::command]
pub fn deny(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.deny(&id).map_err(fmt_err)?;
    crate::usage::track(&app, crate::usage::Event::PromptAnswered { allowed: false });
    Ok(())
}

#[tauri::command]
pub fn stop_session(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.stop(&id).map_err(fmt_err)
}

/// Starts a paused session (one listed when the app last quit) again, on its agent's conversation.
#[tauri::command]
pub async fn resume_session(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<SessionInfo, String> {
    let s = state.manager.list().into_iter().find(|s| s.id == id).ok_or("unknown session")?;
    let ws = find_workspace(&state, &s.workspace_id)?;
    let builder = match &s.kind {
        SessionKind::Agent { builder_id } => Some(state.data().builders.iter().find(|b| &b.id == builder_id).cloned().ok_or("this session's builder was deleted")?),
        SessionKind::Terminal => None,
    };
    state.manager.resume(&ws, builder.as_ref(), &id).map_err(|e| start_err(&app, &state, &s.workspace_id, e))
}

#[tauri::command]
/// `discard`: the owner did not want its work; it earns nothing even when finished.
pub async fn close_session(id: String, discard: Option<bool>, app: AppHandle, state: State<'_, AppState>) -> Result<CloseOutcome, String> {
    state.channels.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    let mut closed = state.manager.close(&id).map_err(fmt_err)?;
    if let Some(saved) = closed.saved.take() {
        record_history(&state, saved, &app);
    }
    let discard = discard.unwrap_or(false) && closed.is_agent;
    if discard {
        closed.reached_finished = false;
    }
    let mut outcome;
    let (ws, stats) = {
        let mut d = state.data();
        let before = d.workspaces.iter().find(|w| w.id == closed.workspace_id).cloned();
        outcome = apply_close(&mut d, &closed, now_ms());
        outcome.discarded = discard;
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

/// Serializes reads and writes of `history.json`.
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

fn history_path(state: &AppState) -> PathBuf {
    state.data_dir().join("history.json")
}

/// Adds a closed agent session (with a known conversation) to the history.
fn record_history(state: &AppState, saved: SavedSession, app: &AppHandle) {
    let SessionKind::Agent { builder_id } = &saved.kind else { return };
    let Some(conversation) = saved.conversation.clone() else { return };
    let (agent, builder_name) = match state.data().builders.iter().find(|b| &b.id == builder_id) {
        Some(b) => (b.agent.clone(), b.name.clone()),
        None => return,
    };
    let e = HistoryEntry {
        id: saved.id,
        workspace_id: saved.workspace_id,
        builder_id: builder_id.clone(),
        agent,
        builder_name,
        task: saved.task,
        title: saved.title,
        last_message: saved.last_message,
        conversation,
        started_at: saved.started_at,
        closed_at: now_ms(),
        steps: saved.steps,
        reached_finished: saved.reached_finished,
        worktree: saved.worktree,
    };
    let _g = HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = history_path(state);
    let mut list = history::load(&path);
    history::push(&mut list, e);
    if let Err(err) = history::save(&path, &list) {
        eprintln!("saving the session history: {err:#}");
    }
    let _ = app.emit("history-updated", ());
}

/// Closed agent sessions that can be opened again, newest first (all workspaces).
#[tauri::command]
pub fn list_history(state: State<'_, AppState>) -> Vec<HistoryEntry> {
    let _g = HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    history::load(&history_path(&state))
}

/// Opens a past session's conversation again as a new session with `builder_id` (the one it had
/// when None), which must run the same agent. The entry leaves the history while it is open; it
/// comes back when that session is closed.
#[tauri::command]
pub async fn continue_history(id: String, builder_id: Option<String>, app: AppHandle, state: State<'_, AppState>) -> Result<SessionInfo, String> {
    let entry = {
        let _g = HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        history::load(&history_path(&state)).into_iter().find(|e| e.id == id).ok_or("this session is no longer in the history")?
    };
    let ws = find_workspace(&state, &entry.workspace_id)?;
    let want = builder_id.unwrap_or_else(|| entry.builder_id.clone());
    let builder = state.data().builders.iter().find(|b| b.id == want).cloned().ok_or("that builder was deleted")?;
    if builder.agent != entry.agent {
        return Err("that builder runs a different agent; a conversation continues on its own agent".into());
    }
    let prior = SavedSession {
        id: entry.id.clone(),
        workspace_id: entry.workspace_id.clone(),
        kind: SessionKind::Agent { builder_id: builder.id.clone() },
        task: entry.task.clone(),
        title: entry.title.clone(),
        state: None,
        started_at: entry.started_at,
        steps: entry.steps,
        reached_finished: false,
        spot: None,
        worktree: entry.worktree.clone(),
        conversation: Some(entry.conversation.clone()),
        rev: 0,
        running: false,
        state_since: 0,
        last_message: entry.last_message.clone(),
        parked: None,
    };
    let s = state.manager.continue_conversation(&ws, &builder, prior).map_err(|e| start_err(&app, &state, &entry.workspace_id, e))?;
    {
        let _g = HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = history_path(&state);
        let mut list = history::load(&path);
        if history::take(&mut list, &id).is_some() {
            let _ = history::save(&path, &list);
        }
    }
    let _ = app.emit("history-updated", ());
    Ok(s)
}

/// Removes an entry from the history (the agent's own files are left alone).
#[tauri::command]
pub fn forget_history(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _g = HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = history_path(&state);
    let mut list = history::load(&path);
    if history::take(&mut list, &id).is_some() {
        history::save(&path, &list).map_err(fmt_err)?;
    }
    let _ = app.emit("history-updated", ());
    Ok(())
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
    /// An agent was closed while Stuck (earns nothing).
    pub stuck: bool,
    /// The owner discarded it (earns nothing).
    pub discarded: bool,
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
        stuck: closed.is_agent && closed.stuck,
        discarded: false,
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

/// A `#rrggbb` colour, lowercased; None for anything else.
pub fn house_color(c: &str) -> Option<String> {
    let hex = c.strip_prefix('#')?;
    (hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit())).then(|| format!("#{}", hex.to_ascii_lowercase()))
}

/// Sets (or with None clears, back to the automatic one) workspace `id`'s house colour.
pub fn apply_workspace_color(d: &mut AppData, id: &str, color: Option<&str>) -> Result<Workspace, String> {
    let color = color.map(|c| house_color(c).ok_or("not a #rrggbb colour")).transpose()?;
    let w = d.workspaces.iter_mut().find(|w| w.id == id).ok_or("unknown workspace")?;
    w.color = color;
    Ok(w.clone())
}

#[tauri::command]
pub fn set_workspace_color(workspace_id: String, color: Option<String>, app: AppHandle, state: State<'_, AppState>) -> Result<Workspace, String> {
    let ws = {
        let mut d = state.data();
        let ws = apply_workspace_color(&mut d, &workspace_id, color.as_deref())?;
        state.save(&d)?;
        ws
    };
    let _ = app.emit("workspace-updated", ws.clone());
    Ok(ws)
}

/// Moves workspace `id`'s whole compound by (dx, dy): walls, house and every structure inside.
pub fn apply_compound_shift(d: &mut AppData, id: &str, dx: i32, dy: i32) -> Result<Workspace, String> {
    let w = d.workspaces.iter_mut().find(|w| w.id == id).ok_or("unknown workspace")?;
    let c = w.compound.as_mut().ok_or("workspace has no compound yet")?;
    c.x0 += dx;
    c.y0 += dy;
    c.house = Tile { x: c.house.x + dx, y: c.house.y + dy };
    Ok(w.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedCompound {
    workspace: Workspace,
    sessions: Vec<SessionInfo>,
}

/// The owner dragged a workspace: its compound and the spots of its sessions move together.
#[tauri::command]
pub fn move_compound(workspace_id: String, dx: i32, dy: i32, app: AppHandle, state: State<'_, AppState>) -> Result<MovedCompound, String> {
    let ws = {
        let mut d = state.data();
        let ws = apply_compound_shift(&mut d, &workspace_id, dx, dy)?;
        state.save(&d)?;
        ws
    };
    let sessions = state.manager.shift_spots(&workspace_id, dx, dy);
    let _ = app.emit("workspace-updated", ws.clone());
    Ok(MovedCompound { workspace: ws, sessions })
}

/// Moves `agent`'s resource collector (Claude Code, Codex and Antigravity have one); returns every moved collector.
pub fn apply_collector_spot(d: &mut AppData, agent: AgentKind, spot: Tile) -> Result<BTreeMap<AgentKind, Tile>, String> {
    if !matches!(agent, AgentKind::Claude | AgentKind::Codex | AgentKind::Antigravity) {
        return Err("this agent has no collector".into());
    }
    d.collector_spots.insert(agent, spot);
    Ok(d.collector_spots.clone())
}

#[tauri::command]
pub fn set_collector_spot(agent: AgentKind, spot: Tile, state: State<'_, AppState>) -> Result<BTreeMap<AgentKind, Tile>, String> {
    let mut d = state.data();
    let spots = apply_collector_spot(&mut d, agent, spot)?;
    state.save(&d)?;
    Ok(spots)
}

/// A small JPEG of a web page for its board, as a `data:` URL (see `snapshot`).
#[tauri::command]
pub async fn snapshot_app<R: tauri::Runtime>(url: String, app: tauri::AppHandle<R>) -> Result<String, String> {
    use base64::Engine;
    tauri::async_runtime::spawn_blocking(move || {
        let jpeg = app.state::<crate::snapshot::Snapper>().capture(&app, &url).map_err(fmt_err)?;
        Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes a task down in a workspace's To Do.
pub fn apply_add_todo(d: &mut AppData, workspace_id: &str, text: &str, images: Vec<String>, now: i64) -> anyhow::Result<Todo> {
    let text = text.trim();
    if text.is_empty() && images.is_empty() {
        anyhow::bail!("a task needs some text or an image");
    }
    attachments::validate(&images)?;
    if !d.workspaces.iter().any(|w| w.id == workspace_id) {
        anyhow::bail!("unknown workspace {workspace_id}");
    }
    let t = Todo { id: Uuid::new_v4().to_string(), workspace_id: workspace_id.to_string(), text: text.to_string(), images, created_at: now, auto: false, builder_id: None, worktree: false };
    d.todos.push(t.clone());
    Ok(t)
}

#[tauri::command]
pub fn add_todo(workspace_id: String, text: String, images: Vec<String>, state: State<'_, AppState>) -> Result<Todo, String> {
    let mut d = state.data();
    let t = apply_add_todo(&mut d, &workspace_id, &text, images, now_ms()).map_err(fmt_err)?;
    state.save(&d)?;
    Ok(t)
}

/// Sets how a To Do starts: on its own (`auto`, which needs a builder), with which builder, and
/// whether in its own worktree.
pub fn apply_update_todo(d: &mut AppData, id: &str, auto: bool, builder_id: Option<String>, worktree: bool) -> anyhow::Result<Todo> {
    let builder_id = builder_id.filter(|b| !b.is_empty());
    if let Some(b) = &builder_id
        && !d.builders.iter().any(|x| &x.id == b)
    {
        anyhow::bail!("unknown builder");
    }
    if auto && builder_id.is_none() {
        anyhow::bail!("pick a builder for the task to start on its own");
    }
    let t = d.todos.iter_mut().find(|t| t.id == id).ok_or_else(|| anyhow::anyhow!("this task is gone"))?;
    t.auto = auto;
    t.builder_id = builder_id;
    t.worktree = worktree;
    Ok(t.clone())
}

#[tauri::command]
pub fn update_todo(id: String, auto: bool, builder_id: Option<String>, worktree: bool, state: State<'_, AppState>) -> Result<Todo, String> {
    let mut d = state.data();
    let t = apply_update_todo(&mut d, &id, auto, builder_id, worktree).map_err(fmt_err)?;
    state.save(&d)?;
    Ok(t)
}

/// Crosses a task off the To Do (deleted, or started as a session). Unknown ids are fine: already gone.
#[tauri::command]
pub fn remove_todo(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut d = state.data();
    let Some(i) = d.todos.iter().position(|t| t.id == id) else { return Ok(()) };
    let t = d.todos.remove(i);
    state.save(&d)?;
    // a started task's images were already moved into its session
    attachments::remove(state.data_dir(), &t.images);
    Ok(())
}

/// The local web apps last found in the workspaces (see `apps`).
#[derive(Default)]
pub struct AppsState {
    pub latest: Mutex<Vec<crate::apps::AppPreview>>,
}

#[tauri::command]
pub fn get_apps(state: State<'_, AppsState>) -> Vec<crate::apps::AppPreview> {
    state.latest.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Quota readings and the poller behind `refresh_quotas`.
pub struct QuotaState {
    pub store: Arc<crate::quota::QuotaStore>,
    pub poller: Arc<crate::quota::Poller>,
}

#[tauri::command]
pub fn get_quotas(state: State<'_, QuotaState>) -> Vec<crate::quota::AgentQuota> {
    state.store.all()
}

/// Reads every source now (agy takes a second or two); returns the latest readings.
#[tauri::command]
pub async fn refresh_quotas(state: State<'_, QuotaState>) -> Result<Vec<crate::quota::AgentQuota>, String> {
    let (store, poller) = (state.store.clone(), state.poller.clone());
    tauri::async_runtime::spawn_blocking(move || {
        poller.poll(true);
        store.all()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Who `agent` is signed in as (Claude takes a second); None when it has no account to show.
#[tauri::command]
pub async fn get_account(agent: crate::model::AgentKind) -> Result<Option<crate::account::AgentAccount>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::account::read(&agent, &std::env::temp_dir()))
        .await
        .map_err(|e| e.to_string())
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

/// Opens the folder `path` in Finder (the system file manager elsewhere).
#[tauri::command]
pub fn open_in_finder(path: String, app: AppHandle) -> Result<(), String> {
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// A trackpad haptic (`kind`: see `platform::Haptic::parse`; the firm click when unknown or not
/// given). Sync, so it runs on the main thread.
#[tauri::command]
pub fn haptic(kind: Option<String>) {
    crate::platform::haptic(kind.as_deref().and_then(crate::platform::Haptic::parse).unwrap_or(crate::platform::Haptic::LevelChange));
}

/// Plays a sound file at `volume` (0-100; the saved volume when not given). Nothing while sounds are off,
/// unless `preview` (the owner trying one in Settings).
#[tauri::command]
pub fn play_sound(path: String, volume: Option<u32>, preview: Option<bool>, state: State<'_, AppState>) -> Result<(), String> {
    let (on, saved) = {
        let d = state.data();
        (d.settings.sounds_on, d.settings.sound_volume)
    };
    if !on && !preview.unwrap_or(false) {
        return Ok(());
    }
    crate::sounds::play(std::path::Path::new(&path), volume.unwrap_or(saved)).map_err(fmt_err)
}

/// The macOS system sounds' names.
#[tauri::command]
pub fn system_sounds() -> Vec<String> {
    crate::sounds::system_sounds()
}

/// Copies a sound file into the data folder; returns the copy's path.
#[tauri::command]
pub fn import_sound(path: String, state: State<'_, AppState>) -> Result<String, String> {
    crate::sounds::import(state.data_dir(), std::path::Path::new(&path)).map(|p| p.to_string_lossy().into_owned()).map_err(fmt_err)
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

/// Kills every session (each stays saved and comes back paused), then exits (or restarts into the new version when `restart`): SIGHUP, up
/// to `KILL_GRACE` for the process groups to exit, SIGKILL for the survivors. The wait runs on a
/// blocking worker, never on the UI thread, so the window keeps responding until the app exits.
async fn shutdown_and_exit(app: &AppHandle, state: &AppState, restart: bool) {
    state.exit_confirmed.store(true, Ordering::SeqCst);
    let manager = state.manager.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || manager.shutdown(crate::pty::KILL_GRACE)).await;
    if restart {
        app.restart();
    }
    app.exit(0);
}

/// The user confirmed quitting (or restarting for an update, `restart`).
#[tauri::command]
pub async fn quit_now(restart: Option<bool>, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    shutdown_and_exit(&app, &state, restart.unwrap_or(false)).await;
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.data().settings.clone()
}

#[tauri::command]
pub fn set_settings(settings: Settings, app: AppHandle, state: State<'_, AppState>) -> Result<Settings, String> {
    let saved = {
        let mut d = state.data();
        d.settings = settings.normalized();
        state.save(&d)?;
        d.settings.clone()
    };
    crate::refresh_badge(&app); // the Dock badge setting shows at once
    crate::shortcut::apply(&app, saved.global_shortcut); // and the shortcut's keys are taken or let go
    Ok(saved)
}

/// The folder holding the app's data (state.json, sessions/, attachments/).
#[tauri::command]
pub fn data_folder(state: State<'_, AppState>) -> String {
    state.data_dir().to_string_lossy().into_owned()
}

/// Opens the data folder in Finder.
#[tauri::command]
pub fn show_data_folder(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    app.opener().open_path(state.data_dir().to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Checks for an update. Refuses with "disabled" BEFORE any network call in debug builds, with
/// the placeholder pubkey or `OWNER/REPO` endpoint, or when the user turned updates off. Failures are logged, not shown.
#[tauri::command]
pub async fn check_for_update(app: AppHandle, state: State<'_, AppState>) -> Result<UpdateStatus, String> {
    use tauri_plugin_updater::UpdaterExt;
    let enabled = state.data().settings.updates_enabled;
    let conf = app.config().plugins.0.get("updater").cloned().unwrap_or_default();
    let pubkey = conf.get("pubkey").and_then(|k| k.as_str()).unwrap_or("");
    let endpoints: Vec<&str> = conf
        .get("endpoints")
        .and_then(|e| e.as_array())
        .map(|a| a.iter().map(|v| v.as_str().unwrap_or("")).collect())
        .unwrap_or_default();
    updater::gate(cfg!(debug_assertions), pubkey, &endpoints, enabled).map_err(String::from)?;
    let found = match app.updater() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    let status = updater::outcome(found.as_ref().map(|o| o.as_ref().map(|u| (u.version.clone(), u.body.clone()))));
    *state.pending_update.lock().unwrap_or_else(|e| e.into_inner()) = found.ok().flatten();
    Ok(status)
}

/// Downloads and installs the pending update, then restarts through the quit guard: with running
/// sessions it asks first (`confirm-quit` with `restart`), otherwise it restarts at once. Sends
/// `update-progress` {pct} (whole percent, null while the size is unknown) as it downloads. A
/// failed install keeps the update pending, so the user can try again.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let update = state.pending_update.lock().unwrap_or_else(|e| e.into_inner()).take();
    let Some(update) = update else { return Err("no update pending".into()) };
    let (progress_app, mut got, mut last) = (app.clone(), 0u64, None::<Option<u8>>);
    let on_chunk = move |n: usize, total: Option<u64>| {
        got += n as u64;
        let pct = updater::progress_pct(got, total);
        if last != Some(pct) {
            last = Some(pct);
            let _ = progress_app.emit("update-progress", UpdateProgress { pct });
        }
    };
    if let Err(e) = update.download_and_install(on_chunk, || {}).await {
        eprintln!("update install failed: {e}");
        *state.pending_update.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
        return Err("update failed".into());
    }
    restart_into_update(&app, &state).await;
    Ok(())
}

/// Restarts into an installed update through the quit guard (the toast's button after the user
/// cancelled the first restart).
#[tauri::command]
pub async fn restart_for_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    restart_into_update(&app, &state).await;
    Ok(())
}

async fn restart_into_update(app: &AppHandle, state: &AppState) {
    match updater::restart_plan(state.manager.running_process_count()) {
        updater::RestartPlan::Now => shutdown_and_exit(app, state, true).await,
        updater::RestartPlan::AskUser { live } => emit_confirm_quit(app, live, true),
    }
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    pct: Option<u8>,
}

/// Whether closing the window only hides it (the app stays in the menu bar and the Dock, sessions
/// keep running). Once quitting is confirmed (`exit_confirmed`) the window is let go.
pub fn close_hides(exit_confirmed: bool) -> bool {
    !exit_confirmed
}

/// Whether a close/exit request must be held back for the user to confirm.
pub fn should_block_exit(live: usize, confirmed: bool) -> bool {
    live > 0 && !confirmed
}

pub fn emit_confirm_quit(app: &AppHandle, live: usize, restart: bool) {
    crate::show_main(app); // the question is asked in the window, which may be closed (hidden)
    let _ = app.emit("confirm-quit", ConfirmQuit { live, restart });
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
    fn closing_the_window_hides_it_until_the_app_is_quitting() {
        assert!(close_hides(false));
        assert!(!close_hides(true), "a confirmed quit lets the window go");
    }

    #[test]
    fn project_dir_goes_in_a_created_default_parent_and_refuses_bad_names() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("Documents").join(DEFAULT_PROJECTS_DIR);
        let made = make_project_dir(&parent, " app ", true).unwrap();
        assert!(made.ends_with(format!("{DEFAULT_PROJECTS_DIR}/app")) && made.join(".git").is_dir());
        assert!(make_project_dir(&parent, "app", true).unwrap_err().contains("already exists"));
        for bad in ["", " ", ".", "..", "a/b"] {
            assert_eq!(make_project_dir(&parent, bad, true).unwrap_err(), "invalid folder name");
        }
        // A picked parent must exist: it is never created.
        assert!(make_project_dir(&tmp.path().join("nope"), "x", false).is_err());
        assert!(!tmp.path().join("nope").exists());
    }

    #[test]
    fn flag_missing_marks_only_that_workspace_once() {
        let ws = |id: &str| Workspace { id: id.into(), name: id.into(), path: PathBuf::from("/nope"), created_at: 0, missing: false, level: 1, xp: 0, compound: None, color: None };
        let mut d = AppData { workspaces: vec![ws("a"), ws("b")], ..AppData::default() };
        let w = flag_workspace_missing(&mut d, "b").unwrap();
        assert!(w.missing && w.id == "b");
        assert!(!d.workspaces[0].missing && d.workspaces[1].missing);
        assert!(flag_workspace_missing(&mut d, "b").is_none(), "already flagged: nothing to persist");
        assert!(flag_workspace_missing(&mut d, "zzz").is_none());
    }

    #[test]
    fn todos_need_text_and_a_workspace() {
        let mut d = village();
        let w = d.workspaces[0].id.clone();
        let t = apply_add_todo(&mut d, &w, "  Fix the login page \n", vec![], 5).unwrap();
        assert_eq!((t.text.as_str(), t.workspace_id.as_str(), t.created_at), ("Fix the login page", w.as_str(), 5));
        assert_eq!(d.todos, vec![t]);
        assert!(apply_add_todo(&mut d, &w, "   ", vec![], 6).is_err());
        assert!(apply_add_todo(&mut d, "nope", "x", vec![], 6).is_err());
        assert_eq!(d.todos.len(), 1);
    }

    #[test]
    fn house_colour_is_set_checked_and_cleared() {
        let mut d = AppData::default();
        d.workspaces.push(Workspace { id: "w1".into(), name: "w".into(), path: PathBuf::from("/nope"), created_at: 0, missing: false, level: 1, xp: 0, compound: None, color: None });
        assert_eq!(apply_workspace_color(&mut d, "w1", Some("#3FA34D")).unwrap().color.as_deref(), Some("#3fa34d"));
        for bad in ["3fa34d", "#3fa34", "#3fa34g", "red", "#3fa34d0"] {
            assert!(apply_workspace_color(&mut d, "w1", Some(bad)).is_err(), "{bad}");
        }
        assert_eq!(d.workspaces[0].color.as_deref(), Some("#3fa34d"), "a bad colour changes nothing");
        assert_eq!(apply_workspace_color(&mut d, "w1", None).unwrap().color, None);
        assert!(apply_workspace_color(&mut d, "nope", None).is_err());
    }

    #[test]
    fn a_todo_starts_on_its_own_only_with_a_builder() {
        let mut d = village();
        let w = d.workspaces[0].id.clone();
        d.builders.push(Builder { id: "b1".into(), name: "Ada".into(), agent: AgentKind::Claude, model: None, effort: None, custom_command: None });
        let t = apply_add_todo(&mut d, &w, "Fix it", vec![], 5).unwrap();
        assert!(!t.auto && !t.worktree && t.builder_id.is_none());
        assert!(apply_update_todo(&mut d, &t.id, true, None, false).is_err(), "auto needs a builder");
        assert!(apply_update_todo(&mut d, &t.id, true, Some("ghost".into()), false).is_err(), "unknown builder");
        let u = apply_update_todo(&mut d, &t.id, true, Some("b1".into()), true).unwrap();
        assert!(u.auto && u.worktree && u.builder_id.as_deref() == Some("b1"));
        assert_eq!(d.todos[0], u);
        assert!(apply_update_todo(&mut d, "gone", false, None, false).is_err());
    }

    #[test]
    fn worktrees_go_in_the_data_folder_on_a_coc_branch() {
        let (at, branch) = worktree_place(Path::new("/data"), "My App", "Fix the login page");
        assert!(at.starts_with("/data/worktrees") && at.file_name().unwrap().to_string_lossy().starts_with("my-app-"));
        assert!(branch.starts_with("coc/fix-the-login-page-"));
        let (_, bare) = worktree_place(Path::new("/data"), "!!", "");
        assert!(bare.starts_with("coc/") && bare.len() == "coc/".len() + 6);
    }

    #[test]
    fn todos_may_be_just_images_but_only_attachment_names() {
        let mut d = village();
        let w = d.workspaces[0].id.clone();
        let img = format!("{}.png", Uuid::new_v4());
        let t = apply_add_todo(&mut d, &w, " ", vec![img.clone()], 5).unwrap();
        assert_eq!((t.text.as_str(), t.images.clone()), ("", vec![img]));
        assert!(apply_add_todo(&mut d, &w, "x", vec!["../state.json".into()], 6).is_err());
        assert!(apply_add_todo(&mut d, &w, "x", vec![format!("{}.png", Uuid::new_v4()); 11], 6).is_err());
        assert_eq!(d.todos.len(), 1);
    }

    fn village() -> AppData {
        let ws = Workspace { id: "w1".into(), name: "w".into(), path: PathBuf::from("/nope"), created_at: 0, missing: false, level: 1, xp: 0, compound: None, color: None };
        AppData { workspaces: vec![ws], ..AppData::default() }
    }

    fn closed(is_agent: bool, reached_finished: bool, stuck: bool) -> ClosedSession {
        ClosedSession { workspace_id: "w1".into(), is_agent, reached_finished, stuck, saved: None }
    }

    #[test]
    fn close_finished_awards_xp_and_stats() {
        let mut d = village();
        let o = apply_close(&mut d, &closed(true, true, false), 5_000);
        assert_eq!(
            o,
            CloseOutcome { earned_xp: true, xp_gained: 100, level_before: 1, level_after: 2, workspace_id: "w1".into(), unfinished: false, stuck: false, discarded: false }
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
    fn close_reports_stuck_only_for_stuck_agents() {
        let mut d = village();
        let o = apply_close(&mut d, &closed(true, true, true), 1);
        assert!(o.stuck && !o.earned_xp);
        let o = apply_close(&mut d, &closed(true, false, true), 1);
        assert!(o.stuck && !o.earned_xp);
        let o = apply_close(&mut d, &closed(true, true, false), 1);
        assert!(!o.stuck && o.earned_xp);
        let o = apply_close(&mut d, &closed(false, false, true), 1);
        assert!(!o.stuck, "terminals stay quiet");
    }

    #[test]
    fn compound_shift_moves_walls_and_house_together() {
        let mut d = village();
        assert!(apply_compound_shift(&mut d, "w1", 1, 1).is_err(), "no compound yet");
        apply_compound(&mut d, "w1", Compound { x0: 2, y0: 3, w: 6, h: 5, house: Tile { x: 4, y: 5 } }).unwrap();
        let ws = apply_compound_shift(&mut d, "w1", -10, 4).unwrap();
        assert_eq!(ws.compound, Some(Compound { x0: -8, y0: 7, w: 6, h: 5, house: Tile { x: -6, y: 9 } }));
        assert!(apply_compound_shift(&mut d, "nope", 1, 1).is_err());
    }

    #[test]
    fn collector_spot_persists_and_rejects_agents_without_one() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        let mut d = village();
        let spots = apply_collector_spot(&mut d, AgentKind::Codex, Tile { x: 7, y: -6 }).unwrap();
        assert_eq!(spots.get(&AgentKind::Codex), Some(&Tile { x: 7, y: -6 }));
        persist::save(&p, &d).unwrap();
        assert_eq!(persist::load(&p).collector_spots, spots);
        assert!(apply_collector_spot(&mut d, AgentKind::OpenCode, Tile { x: 0, y: 9 }).is_err());
        assert_eq!(d.collector_spots.len(), 1);
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
