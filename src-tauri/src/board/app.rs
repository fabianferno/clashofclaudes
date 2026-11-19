//! The board in the app: what joins the publisher to the app's data, sessions and commands.
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::cli::{status, BoardCli, BoardStatus, Target, VercelCli};
use super::publisher::{Config, Publisher, SessionView};
use super::{channel, profile_name, workspace_slugs, Outcome};
use crate::commands::AppState;
use crate::model::{AppData, BoardSettings, Builder, SessionInfo, SessionKind, Workspace};
use crate::sessions::EnvHook;

/// A `vercel` call still running after this long is killed.
const CLI_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a quit waits for the board to hear that the sessions are paused.
const QUIT_WAIT: Duration = Duration::from_secs(3);

/// Who the owner is on the board, from the last check that reached it.
#[derive(Default, Clone)]
struct Link {
    owner: Option<String>,
    board_url: Option<String>,
}

pub struct BoardState {
    publisher: Arc<Publisher>,
    cli: Arc<dyn BoardCli>,
    link: Arc<Mutex<Link>>,
    /// The feature is on and the owner is known: session updates are worth looking at.
    active: AtomicBool,
}

impl BoardState {
    /// `data_dir`: where `board.json` lives and where `vercel` runs. `files`: a session's changed files.
    pub fn new(data_dir: &Path, files: super::publisher::Files) -> BoardState {
        let cli: Arc<dyn BoardCli> = Arc::new(VercelCli { program: None, cwd: data_dir.to_path_buf(), timeout: CLI_TIMEOUT });
        let now: super::publisher::Clock = Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0));
        let publisher = Publisher::start(cli.clone(), data_dir.join("board.json"), files, now);
        BoardState { publisher, cli, link: Arc::default(), active: AtomicBool::new(false) }
    }

    fn link(&self) -> Link {
        self.link.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// The board the settings name; blanks fall back to the default team and to "village".
pub fn target(b: &BoardSettings) -> Target {
    let clean = |s: &str| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    Target { team: b.team.as_deref().and_then(clean), name: clean(&b.name).unwrap_or_else(|| BoardSettings::default().name) }
}

pub fn config(data: &AppData, owner: &str) -> Config {
    let b = &data.settings.board;
    Config { enabled: b.enabled, target: target(b), owner: owner.to_string(), host_id: b.host_id.clone().unwrap_or_default(), share_details: b.share_details }
}

/// An agent session as the publisher wants it; None for terminals and for sessions whose
/// workspace or builder is gone.
pub fn session_view(data: &AppData, owner: &str, info: &SessionInfo) -> Option<SessionView> {
    let SessionKind::Agent { builder_id } = &info.kind else { return None };
    let builder = data.builders.iter().find(|b| &b.id == builder_id)?;
    let ws = data.workspaces.iter().find(|w| w.id == info.workspace_id)?;
    let channel = ws.board_shared.then(|| channel(owner, &workspace_slugs(&data.workspaces)[&ws.id]));
    Some(SessionView { info: info.clone(), builder: builder.name.clone(), agent: builder.agent.clone(), channel })
}

/// What a session of `builder` in `ws` gets in its environment, so its own `vercel board` calls
/// reach this board under the builder's name.
pub fn env_for(b: &BoardSettings, board_url: Option<&str>, ws: &Workspace, builder: &Builder) -> Vec<(String, String)> {
    match board_url {
        Some(url) if b.enabled && b.session_env && ws.board_shared => {
            vec![("BOARD_PROFILE".to_string(), profile_name(&builder.name)), ("BOARD_URL".to_string(), url.to_string())]
        }
        _ => vec![],
    }
}

/// A workspace added now starts shared.
pub fn shares_new(b: &BoardSettings) -> bool {
    b.enabled && b.share_new
}

/// Gives the village its id the first time the feature is on.
pub fn ensure_host_id(b: &mut BoardSettings) {
    if b.enabled && b.host_id.is_none() {
        b.host_id = Some(uuid::Uuid::new_v4().simple().to_string()[..16].to_string());
    }
}

/// How long to wait before looking at the board again after a look that ended in `state`: only a
/// failure that may pass by itself (offline, a timeout) is worth it. None: stop looking.
pub fn retry_after(state: &str, tries: u32) -> Option<Duration> {
    (state == "error").then(|| Duration::from_secs((5u64 << tries.min(10)).min(300)))
}

/// What a look at the board means: who the owner is, a stopped worker going on once the board is
/// reached again, and the worker's own news for Settings.
fn after_status(publisher: &Publisher, link: &Mutex<Link>, s: &mut BoardStatus) {
    if s.state == "ready" {
        *link.lock().unwrap_or_else(|e| e.into_inner()) = Link { owner: s.handle.clone(), board_url: s.board_url.clone() };
        if publisher.stopped_reason().is_some() {
            publisher.check_again();
        }
    }
    let (last_error, last_write_at) = publisher.status();
    s.last_error = s.last_error.take().or(last_error);
    s.last_write_at = last_write_at;
}

/// At launch: looks at the board until it is reached, or until only the owner can help (no CLI,
/// not signed in) or the feature is off. Blocking; run it on its own thread.
pub fn connect_at_launch<R: Runtime>(app: &AppHandle<R>) {
    let mut tries = 0;
    while let Some(wait) = retry_after(&refresh(app).state, tries) {
        std::thread::sleep(wait);
        tries += 1;
    }
}

/// Settings, sharing or the owner changed: tells the publisher, sets what sessions get in their
/// environment, and hands the publisher every session as it stands (it only learns of them here
/// and from their updates).
pub fn apply<R: Runtime>(app: &AppHandle<R>) {
    let (Some(bs), Some(st)) = (app.try_state::<BoardState>(), app.try_state::<AppState>()) else { return };
    let link = bs.link();
    let (cfg, views, board) = {
        let d = st.data();
        let board = d.settings.board.clone();
        let Some(owner) = link.owner.as_deref().filter(|_| board.enabled) else {
            // Off, or on and not yet through to the board: nothing is published.
            let off = Config { enabled: false, ..config(&d, link.owner.as_deref().unwrap_or_default()) };
            drop(d);
            bs.active.store(false, Ordering::SeqCst);
            bs.publisher.configure(off);
            st.manager.set_env_hook(None);
            return;
        };
        let views: Vec<SessionView> = st.manager.list().iter().filter_map(|i| session_view(&d, owner, i)).collect();
        (config(&d, owner), views, board)
    };
    bs.publisher.configure(cfg);
    bs.active.store(true, Ordering::SeqCst);
    for v in views {
        bs.publisher.update(v);
    }
    let hook: Option<EnvHook> = (board.session_env && link.board_url.is_some()).then(|| {
        let (board, url) = (board.clone(), link.board_url.clone());
        Arc::new(move |ws: &Workspace, b: &Builder| env_for(&board, url.as_deref(), ws, b)) as EnvHook
    });
    st.manager.set_env_hook(hook);
}

/// A session changed. Cheap while the feature is off; never calls the board.
pub fn on_update<R: Runtime>(app: &AppHandle<R>, info: &SessionInfo) {
    let Some(bs) = app.try_state::<BoardState>() else { return };
    if !bs.active.load(Ordering::SeqCst) || !matches!(info.kind, SessionKind::Agent { .. }) {
        return;
    }
    let (Some(st), Some(owner)) = (app.try_state::<AppState>(), bs.link().owner) else { return };
    let view = session_view(&st.data(), &owner, info);
    if let Some(v) = view {
        bs.publisher.update(v);
    }
}

/// A session was closed; `accepted`: Some(true) accepted, Some(false) discarded, None unknown.
pub fn on_closed<R: Runtime>(app: &AppHandle<R>, session_id: &str, accepted: Option<bool>) {
    if let Some(bs) = app.try_state::<BoardState>() {
        bs.publisher.closed(session_id, accepted.map(|a| if a { Outcome::Accepted } else { Outcome::Discarded }));
    }
}

/// The app is quitting: live threads are marked paused (waits a few seconds at most). Blocking.
pub fn on_quit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(bs) = app.try_state::<BoardState>()
        && bs.active.load(Ordering::SeqCst)
    {
        bs.publisher.pause_all(QUIT_WAIT);
    }
}

/// Asks the CLI where things stand (blocking: it runs `vercel`), remembers who the owner is, and
/// applies it.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) -> BoardStatus {
    let (Some(bs), Some(st)) = (app.try_state::<BoardState>(), app.try_state::<AppState>()) else { return BoardStatus::default() };
    let board = st.data().settings.board.clone();
    if !board.enabled {
        apply(app);
        return BoardStatus { state: "off".into(), ..Default::default() };
    }
    let mut s = status(bs.cli.as_ref(), &target(&board));
    after_status(&bs.publisher, &bs.link, &mut s);
    apply(app);
    s
}

/// Settings › Team: where the connection stands.
#[tauri::command]
pub async fn board_status(app: AppHandle) -> Result<BoardStatus, String> {
    tauri::async_runtime::spawn_blocking(move || refresh(&app)).await.map_err(|e| e.to_string())
}

/// Settings › Team › Check again: after installing, updating or signing in.
#[tauri::command]
pub async fn board_check(app: AppHandle) -> Result<BoardStatus, String> {
    if let Some(bs) = app.try_state::<BoardState>() {
        bs.publisher.check_again();
    }
    tauri::async_runtime::spawn_blocking(move || refresh(&app)).await.map_err(|e| e.to_string())
}

/// Shares workspace `workspace_id` on the team's board, or stops sharing it.
#[tauri::command]
pub fn set_workspace_shared(workspace_id: String, shared: bool, app: AppHandle, state: State<'_, AppState>) -> Result<Workspace, String> {
    let ws = {
        let mut d = state.data();
        let ws = d.workspaces.iter_mut().find(|w| w.id == workspace_id).ok_or("unknown workspace")?;
        ws.board_shared = shared;
        let ws = ws.clone();
        crate::persist::save(&state.data_path, &d).map_err(|e| format!("{e:#}"))?;
        ws
    };
    let _ = app.emit("workspace-updated", ws.clone());
    apply(&app);
    Ok(ws)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentKind, SessionInfo, SessionKind, SessionState};
    use std::path::PathBuf;

    fn data() -> AppData {
        let ws = |id: &str, name: &str, shared: bool| Workspace { id: id.into(), name: name.into(), path: PathBuf::from("/nope"), created_at: 0, missing: false, level: 1, xp: 0, compound: None, color: None, notes: String::new(), board_shared: shared };
        let mut d = AppData::default();
        d.workspaces = vec![ws("w1", "API Server", true), ws("w2", "site", false)];
        d.builders = vec![Builder { id: "b1".into(), name: "Wizard".into(), agent: AgentKind::Claude, model: None, effort: None, custom_command: None }];
        d.settings.board = BoardSettings { enabled: true, team: Some("acme".into()), name: "ops".into(), share_details: false, session_env: true, share_new: false, host_id: Some("h1".into()) };
        d
    }

    fn info(ws: &str, kind: SessionKind) -> SessionInfo {
        SessionInfo {
            id: "s1".into(),
            workspace_id: ws.into(),
            kind,
            task: None,
            title: None,
            state: SessionState::Working,
            steps: 0,
            started_at: 1,
            last_output_at: 1,
            reached_finished: false,
            worktree: None,
            command_preview: String::new(),
            awaiting_decision: false,
            busy: false,
            rev: 1,
            spot: None,
            paused: false,
            subagents: vec![],
            state_since: 1,
            last_message: None,
            asking: None,
            questions: vec![],
            parked: None,
        }
    }

    fn agent(ws: &str, builder: &str) -> SessionInfo {
        info(ws, SessionKind::Agent { builder_id: builder.into() })
    }

    #[test]
    fn config_reads_the_settings() {
        let c = config(&data(), "ada");
        assert_eq!(c, Config { enabled: true, target: Target { team: Some("acme".into()), name: "ops".into() }, owner: "ada".into(), host_id: "h1".into(), share_details: false });
        // A blank board name falls back to the default.
        let mut d = data();
        d.settings.board.name = "  ".into();
        d.settings.board.team = Some(" ".into());
        assert_eq!(config(&d, "ada").target, Target { team: None, name: "village".into() });
    }

    #[test]
    fn session_view_gives_shared_workspaces_a_channel() {
        let d = data();
        let v = session_view(&d, "ada", &agent("w1", "b1")).unwrap();
        assert_eq!((v.builder.as_str(), v.agent, v.channel.as_deref()), ("Wizard", AgentKind::Claude, Some("v/ada/w/api-server")));
        assert_eq!(session_view(&d, "ada", &agent("w2", "b1")).unwrap().channel, None);
        assert!(session_view(&d, "ada", &info("w1", SessionKind::Terminal)).is_none());
        assert!(session_view(&d, "ada", &agent("w1", "gone")).is_none());
        assert!(session_view(&d, "ada", &agent("gone", "b1")).is_none());
    }

    #[test]
    fn env_for_shared_workspaces_only() {
        let d = data();
        let (b, shared, private) = (&d.builders[0], &d.workspaces[0], &d.workspaces[1]);
        let url = Some("https://api.vercel.com/v1/messageboard/boards/brd_1?teamId=t");
        assert_eq!(
            env_for(&d.settings.board, url, shared, b),
            vec![("BOARD_PROFILE".to_string(), "wizard".to_string()), ("BOARD_URL".to_string(), url.unwrap().to_string())]
        );
        assert!(env_for(&d.settings.board, url, private, b).is_empty());
        // Without the board's address the agent's own calls could land on another team's board.
        assert!(env_for(&d.settings.board, None, shared, b).is_empty());
        let off = BoardSettings { session_env: false, ..d.settings.board.clone() };
        assert!(env_for(&off, url, shared, b).is_empty());
        let disabled = BoardSettings { enabled: false, ..d.settings.board.clone() };
        assert!(env_for(&disabled, url, shared, b).is_empty());
    }

    #[test]
    fn turning_it_on_makes_a_village_id_once() {
        let mut b = BoardSettings::default();
        ensure_host_id(&mut b);
        assert_eq!(b.host_id, None, "off: nothing is made");
        b.enabled = true;
        ensure_host_id(&mut b);
        let first = b.host_id.clone().unwrap();
        assert_eq!(first.len(), 16);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        ensure_host_id(&mut b);
        assert_eq!(b.host_id.as_deref(), Some(first.as_str()));
    }

    #[test]
    fn new_workspaces_start_shared_only_when_asked() {
        let mut b = BoardSettings { enabled: true, share_new: true, ..Default::default() };
        assert!(shares_new(&b));
        b.enabled = false;
        assert!(!shares_new(&b), "the feature is off");
        assert!(!shares_new(&BoardSettings { enabled: true, ..Default::default() }));
    }

    #[test]
    fn a_failed_first_look_is_tried_again_and_a_missing_login_is_not() {
        assert_eq!(retry_after("error", 0), Some(Duration::from_secs(5)));
        assert_eq!(retry_after("error", 2), Some(Duration::from_secs(20)));
        assert_eq!(retry_after("error", 30), Some(Duration::from_secs(300)));
        for s in ["ready", "off", "noCli", "oldCli", "signedOut"] {
            assert_eq!(retry_after(s, 0), None, "{s}");
        }
    }

    #[test]
    fn reaching_the_board_again_restarts_a_stopped_worker() {
        use crate::board::cli::{CliError, Output};
        struct SignedOutOnce(std::sync::atomic::AtomicBool);
        impl BoardCli for SignedOutOnce {
            fn raw(&self, _: &[String]) -> Result<Output, CliError> {
                if self.0.swap(false, Ordering::SeqCst) {
                    return Ok(Output { ok: false, stdout: r#"{"status":"error","reason":"not_authenticated","message":"Run vercel login."}"#.into(), stderr: String::new() });
                }
                Ok(Output { ok: true, stdout: r#"{"message":{"id":"msg_1"},"outcome":"posted"}"#.into(), stderr: String::new() })
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(1_000));
        let c = clock.clone();
        let p = Publisher::new(Arc::new(SignedOutOnce(AtomicBool::new(true))), dir.path().join("board.json"), Arc::new(|_| vec![]), Arc::new(move || c.load(Ordering::SeqCst)));
        let d = data();
        p.configure(config(&d, "ada"));
        p.update(session_view(&d, "ada", &agent("w1", "b1")).unwrap());
        clock.fetch_add(10_000, Ordering::SeqCst);
        p.step();
        assert!(p.stopped_reason().is_some());

        let link = Mutex::new(Link::default());
        // Still signed out: it stays stopped, and Settings says so even though nothing else is wrong.
        let mut s = BoardStatus { state: "signedOut".into(), ..Default::default() };
        after_status(&p, &link, &mut s);
        assert!(p.stopped_reason().is_some());
        // Signed in again: the worker goes on, and the owner is remembered.
        let mut s = BoardStatus { state: "ready".into(), handle: Some("ada".into()), board_url: Some("https://b".into()), ..Default::default() };
        after_status(&p, &link, &mut s);
        assert_eq!(p.stopped_reason(), None);
        assert_eq!(link.lock().unwrap().owner.as_deref(), Some("ada"));
        p.step();
        assert!(p.status().1.is_some(), "it wrote");
    }
}
