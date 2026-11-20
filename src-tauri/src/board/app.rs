//! The board in the app: what joins the publisher to the app's data, sessions and commands.
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::cli::{status, BoardCli, BoardStatus, Target, VercelCli};
use super::listen::{Following, Listener};
use super::remote_app::{Remote, RemoteStatus, Sessions, Village};
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
    /// The phone remote, and the listener that feeds it.
    pub remote: Arc<Remote>,
    listener: Arc<Listener>,
    /// The village's map for visitors: when it was last written.
    map: Arc<Mutex<super::map::MapWriter>>,
    /// The villages this login was invited to.
    visits: Arc<Mutex<super::visits::Visits>>,
}

/// The session manager, as the phone remote uses it.
struct ManagerSessions(std::sync::Weak<crate::sessions::SessionManager>);

impl ManagerSessions {
    fn with(&self, f: impl FnOnce(&crate::sessions::SessionManager) -> anyhow::Result<()>) -> Result<(), String> {
        let m = self.0.upgrade().ok_or("the app is quitting")?;
        f(&m).map_err(|e| format!("{e:#}"))
    }
}

impl Sessions for ManagerSessions {
    fn since(&self, id: &str) -> Option<i64> {
        self.0.upgrade()?.list().into_iter().find(|s| s.id == id).map(|s| s.state_since)
    }
    fn approve_if(&self, id: &str, since: i64) -> Result<(), String> {
        self.with(|m| m.approve_if(id, since))
    }
    fn deny_if(&self, id: &str, since: i64) -> Result<(), String> {
        self.with(|m| m.deny_if(id, since))
    }
    fn prompt_if(&self, id: &str, since: i64, text: &str) -> Result<(), String> {
        self.with(|m| m.prompt_if(id, since, text))
    }
    fn pick_if(&self, id: &str, since: i64, pick: Option<usize>, text: &str) -> Result<(), String> {
        self.with(|m| m.pick_if(id, since, pick, text))
    }
}

impl BoardState {
    /// `data_dir`: where `board.json` lives and where `vercel` runs. `files`: a session's changed files.
    /// `changed`: called when what Settings › Phone remote shows has changed. `visits_changed`:
    /// when the villages to visit, or one of their maps, changed.
    pub fn new(data_dir: &Path, files: super::publisher::Files, manager: std::sync::Weak<crate::sessions::SessionManager>, changed: Arc<dyn Fn() + Send + Sync>, visits_changed: Arc<dyn Fn() + Send + Sync>) -> BoardState {
        let cli: Arc<dyn BoardCli> = Arc::new(VercelCli { program: None, cwd: data_dir.to_path_buf(), timeout: CLI_TIMEOUT });
        let now: super::publisher::Clock = Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0));
        let publisher = Publisher::start(cli.clone(), data_dir.join("board.json"), files, now.clone());
        let remote = Arc::new(Remote::new(
            publisher.clone(),
            Arc::new(ManagerSessions(manager)),
            Arc::new(super::phones::Keychain::app()),
            data_dir.join("board-remote.json"),
            now,
            changed,
        ));
        let visits = Arc::new(Mutex::new(super::visits::Visits::load(data_dir.join("board-visits.json"))));
        let (hears, sees) = (remote.clone(), visits.clone());
        let listener = Listener::start(
            cli.clone(),
            data_dir.join("board-listen.json"),
            Box::new(move |e| {
                // another village's owner wrote their map: the people row follows
                if sees.lock().unwrap_or_else(|p| p.into_inner()).on_event(&e, now_ms()) {
                    visits_changed();
                }
                hears.handle(e);
            }),
        );
        // the remote's clock: an expired pairing ends, the village root says the Mac is there
        let ticks = Arc::downgrade(&remote);
        std::thread::Builder::new()
            .name("board-remote-tick".into())
            .spawn(move || {
                while let Some(r) = ticks.upgrade() {
                    r.tick();
                    drop(r);
                    std::thread::sleep(Duration::from_secs(1));
                }
            })
            .expect("remote tick thread");
        BoardState { publisher, cli, link: Arc::default(), active: AtomicBool::new(false), remote, listener, map: Arc::default(), visits }
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
/// `answerable`: the app has the keys for its open permission prompt.
pub fn session_view(data: &AppData, owner: &str, info: &SessionInfo, answerable: bool) -> Option<SessionView> {
    let SessionKind::Agent { builder_id } = &info.kind else { return None };
    let builder = data.builders.iter().find(|b| &b.id == builder_id)?;
    let ws = data.workspaces.iter().find(|w| w.id == info.workspace_id)?;
    let channel = ws.board_shared.then(|| channel(owner, &workspace_slugs(&data.workspaces)[&ws.id]));
    Some(SessionView { info: info.clone(), builder: builder.name.clone(), agent: builder.agent.clone(), channel, answerable })
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
            bs.listener.configure(None);
            bs.remote.configure(None, None);
            return;
        };
        let sessions = st.manager.list();
        drop(d);
        // asked outside the data lock: it takes the session manager's
        let answerable: Vec<bool> = sessions.iter().map(|i| st.manager.answerable(&i.id)).collect();
        let d = st.data();
        let views: Vec<SessionView> = sessions.iter().zip(answerable).filter_map(|(i, a)| session_view(&d, owner, i, a)).collect();
        (config(&d, owner), views, board)
    };
    // The listener follows the board whenever it is connected (the villages this login may read:
    // its own, and the ones it was invited to). The phone remote takes what it hears only while
    // its own switch is on.
    let village = board.remote.enabled.then(|| Village { host: cfg.host_id.clone(), owner: cfg.owner.clone(), version: env!("CARGO_PKG_VERSION").to_string() });
    bs.listener.configure(Some(Following { target: cfg.target.clone(), owner: cfg.owner.clone() }));
    bs.remote.configure(village, board.remote.paused.clone());
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

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_millis() as i64).unwrap_or(0)
}

/// Reads again which villages this login may visit (blocking: one `vercel` call, plus one per
/// village). Run at connect, every five minutes, and when asked.
pub fn refresh_visits<R: Runtime>(app: &AppHandle<R>) {
    let (Some(bs), Some(st)) = (app.try_state::<BoardState>(), app.try_state::<AppState>()) else { return };
    let board = st.data().settings.board.clone();
    let Some(me) = bs.link().owner.filter(|_| board.enabled) else {
        bs.visits.lock().unwrap_or_else(|e| e.into_inner()).clear();
        let _ = app.emit("visits-changed", Vec::<super::visits::VisitView>::new());
        return;
    };
    // The calls run without the lock: the listener keeps feeding the store meanwhile.
    let mut fresh = super::visits::Visits::load(st.data_path.with_file_name("board-visits.json"));
    if fresh.refresh(bs.cli.as_ref(), &target(&board), &me, now_ms()).is_ok() {
        *bs.visits.lock().unwrap_or_else(|e| e.into_inner()) = fresh;
    }
    let _ = app.emit("visits-changed", visits_of(app));
}

fn visits_of<R: Runtime>(app: &AppHandle<R>) -> Vec<super::visits::VisitView> {
    app.try_state::<BoardState>().map(|bs| bs.visits.lock().unwrap_or_else(|e| e.into_inner()).list(now_ms())).unwrap_or_default()
}

/// The villages this login was invited to, for the people row.
#[tauri::command]
pub fn visits(app: AppHandle) -> Vec<super::visits::VisitView> {
    visits_of(&app)
}

/// One village's map, to draw it.
#[tauri::command]
pub fn visit(owner: String, app: AppHandle) -> Option<super::snapshot::Snapshot> {
    app.try_state::<BoardState>()?.visits.lock().unwrap_or_else(|e| e.into_inner()).get(&owner).cloned()
}

#[tauri::command]
pub async fn visits_refresh(app: AppHandle) -> Result<Vec<super::visits::VisitView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        refresh_visits(&app);
        visits_of(&app)
    })
    .await
    .map_err(|e| e.to_string())
}

/// What a builder in a visited village is doing and waiting for, from its thread (one `vercel` call).
#[tauri::command]
pub async fn visit_builder(owner: String, root: String, app: AppHandle) -> Result<Option<super::visits::VisitedBuilder>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (cli, board, _) = board_of(&app)?;
        let thread = cli.run(&super::visits::thread_args(&root, &target(&board))).map_err(|e| format!("{e:?}"))?;
        Ok(super::visits::visited_builder(&thread, &owner))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Once a second: keeps the village's map on the board current for visitors (a change within ten
/// seconds, a heartbeat every five minutes). Never calls the board itself.
pub fn tick_map<R: Runtime>(app: &AppHandle<R>) {
    let (Some(bs), Some(st)) = (app.try_state::<BoardState>(), app.try_state::<AppState>()) else { return };
    if !bs.active.load(Ordering::SeqCst) {
        return;
    }
    let Some(owner) = bs.link().owner else { return };
    let sessions = st.manager.list();
    let (snap, key) = {
        let d = st.data();
        let b = &d.settings.board;
        let host = b.host_id.clone().unwrap_or_default();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_millis() as i64).unwrap_or(0);
        let snap = super::snapshot::build(&d, &owner, &host, &sessions, &|id| bs.publisher.root_of(id), now);
        (snap, format!("{}#{owner}", target(b).key()))
    };
    let write = bs.map.lock().unwrap_or_else(|e| e.into_inner()).tick(&key, &snap, snap.seen);
    match write {
        Some(post @ super::cli::MsgWrite::Post { .. }) => {
            let map = bs.map.clone();
            bs.publisher.send(post, Some(Box::new(move |id| map.lock().unwrap_or_else(|e| e.into_inner()).posted(id))));
        }
        Some(edit) => bs.publisher.send(edit, None),
        None => {}
    }
}

/// A session changed. Cheap while the feature is off; never calls the board.
pub fn on_update<R: Runtime>(app: &AppHandle<R>, info: &SessionInfo) {
    let Some(bs) = app.try_state::<BoardState>() else { return };
    if !bs.active.load(Ordering::SeqCst) || !matches!(info.kind, SessionKind::Agent { .. }) {
        return;
    }
    let (Some(st), Some(owner)) = (app.try_state::<AppState>(), bs.link().owner) else { return };
    let answerable = info.awaiting_decision && st.manager.answerable(&info.id);
    let view = session_view(&st.data(), &owner, info, answerable);
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
    if let Some(bs) = app.try_state::<BoardState>() {
        bs.listener.stop();
    }
}

/// Settings › Team › Phone remote: phones, pairing, and whether the Mac is listening.
pub fn remote_status_of<R: Runtime>(app: &AppHandle<R>) -> RemoteStatus {
    let Some(bs) = app.try_state::<BoardState>() else { return RemoteStatus::default() };
    let mut s = bs.remote.status();
    s.listening = bs.listener.status().0;
    s.bundled_version = super::remote_src::version();
    if let Some(st) = app.try_state::<AppState>() {
        let d = st.data();
        s.url = d.settings.board.remote.url.clone();
        s.paused = d.settings.board.remote.paused.clone();
    }
    s
}

/// Changes the phone remote's own settings, saves them, applies them and tells the window.
fn update_remote<R: Runtime>(app: &AppHandle<R>, f: impl FnOnce(&mut crate::model::RemoteSettings)) -> Result<(), String> {
    let st = app.try_state::<AppState>().ok_or("the app is starting")?;
    let saved = {
        let mut d = st.data();
        f(&mut d.settings.board.remote);
        // a long history of deployments is not worth keeping
        let n = d.settings.board.remote.trusted.len();
        if n > 100 {
            d.settings.board.remote.trusted.drain(..n - 100);
        }
        crate::persist::save(&st.data_path, &d).map_err(|e| format!("{e:#}"))?;
        d.settings.clone()
    };
    let _ = app.emit("settings-changed", saved);
    apply(app);
    let _ = app.emit("remote-changed", remote_status_of(app));
    Ok(())
}

fn board_of<R: Runtime>(app: &AppHandle<R>) -> Result<(Arc<dyn BoardCli>, BoardSettings, std::path::PathBuf), String> {
    let (bs, st) = (app.try_state::<BoardState>().ok_or("the board is not set up")?, app.try_state::<AppState>().ok_or("the app is starting")?);
    let board = st.data().settings.board.clone();
    let src = st.data_path.parent().map(|p| p.join("remote-src")).ok_or("no data folder")?;
    Ok((bs.cli.clone(), board, src))
}

/// Looks at the remote's production deployments; one this Mac neither made nor trusted pauses the
/// remote until the owner trusts it. Blocking (it runs `vercel`).
pub fn watch_remote<R: Runtime>(app: &AppHandle<R>) {
    let Ok((cli, board, _)) = board_of(app) else { return };
    if !board.enabled || !board.remote.enabled || board.remote.url.is_none() || board.remote.paused.is_some() {
        return;
    }
    let team = target(&board).team;
    let Ok(Some(seen)) = super::deploy::production_deployments(cli.as_ref(), team.as_deref()) else { return };
    if let Some(d) = super::deploy::unknown(&seen, &board.remote.trusted) {
        let why = super::deploy::pause_reason(d);
        let _ = update_remote(app, |r| r.paused = Some(why));
    }
}

/// Whether the team already has a remote; its address when it does.
#[tauri::command]
pub async fn remote_find(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (cli, board, _) = board_of(&app)?;
        Ok(match super::deploy::find(cli.as_ref(), target(&board).team.as_deref())? {
            super::deploy::Found::Team { url, .. } => Some(url),
            super::deploy::Found::None => None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Uses a remote that is already deployed: the team's own (no `url`), or one at an address the
/// owner deployed themselves. Its deployments as they are now are trusted.
#[tauri::command]
pub async fn remote_connect(url: Option<String>, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (cli, board, _) = board_of(&app)?;
        let team = target(&board).team;
        let address = match url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            Some(u) if u.starts_with("https://") => u.trim_end_matches('/').to_string(),
            Some(_) => return Err("The address must start with https://".to_string()),
            None => match super::deploy::find(cli.as_ref(), team.as_deref())? {
                super::deploy::Found::Team { url, .. } => url,
                super::deploy::Found::None => return Err("This team has no remote yet.".to_string()),
            },
        };
        let now = super::deploy::production_deployments(cli.as_ref(), team.as_deref())?.unwrap_or_default();
        update_remote(&app, |r| {
            r.url = Some(address);
            for d in now {
                if !r.trusted.contains(&d.id) {
                    r.trusted.push(d.id);
                }
            }
            r.paused = None;
            r.enabled = true;
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deploys the remote the app carries: the first time with fresh push keys and a setup secret,
/// later as an update that keeps them. Says how far it is with `remote-progress` events.
#[tauri::command]
pub async fn remote_deploy(app: AppHandle) -> Result<(), String> {
    let h = app.clone();
    let (deployed, setup) = tauri::async_runtime::spawn_blocking(move || {
        let (cli, board, src) = board_of(&h)?;
        let bs = h.try_state::<BoardState>().ok_or("the board is not set up")?;
        let team = target(&board).team;
        let exists = super::deploy::production_deployments(cli.as_ref(), team.as_deref())?.is_some();
        // Fresh secrets only for a project that is not there yet: making them again would cut
        // every phone's notifications off.
        let fresh = if exists { None } else { Some(super::deploy::new_secrets()?) };
        if let Some(n) = &fresh {
            bs.remote.reload();
            bs.remote.set_setup_secret(n.setup.clone())?;
        }
        let said = h.clone();
        let deployed = super::deploy::deploy(cli.as_ref(), team.as_deref(), &src, &target(&board).name, fresh.as_ref(), &move |m| {
            let _ = said.emit("remote-progress", m.to_string());
        })?;
        let _ = std::fs::remove_dir_all(&src);
        Ok::<_, String>((deployed, bs.remote.setup_secret()))
    })
    .await
    .map_err(|e| e.to_string())??;
    let url = deployed.url.clone();
    update_remote(&app, |r| {
        r.url = Some(deployed.url);
        if !r.trusted.contains(&deployed.deployment) {
            r.trusted.push(deployed.deployment);
        }
        r.paused = None;
        r.enabled = true;
    })?;
    // The watcher that sends notifications is registered by one call carrying the setup secret.
    // A Mac that did not make the project has no secret: Vercel registers it on the remote's first use.
    if let Some(secret) = setup {
        let _ = app.emit("remote-progress", "Turning on notifications…".to_string());
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let fail = |e: http_client::Error| format!("The remote is deployed, but its notifications could not be turned on: {}", e.without_url());
        let client = http_client::Client::builder().timeout(Duration::from_secs(60)).build().map_err(fail)?;
        let res = client.post(format!("{url}/api/board/watchers")).header("x-coc-setup", secret).send().await.map_err(fail)?;
        if !res.status().is_success() {
            return Err(format!("The remote is deployed, but its notifications could not be turned on (it answered {}).", res.status()));
        }
    }
    Ok(())
}

/// The version of the remote that is deployed, for "Update the remote".
#[tauri::command]
pub async fn remote_deployed_version(app: AppHandle) -> Result<Option<String>, String> {
    let Some(url) = app.try_state::<AppState>().and_then(|st| st.data().settings.board.remote.url.clone()) else { return Ok(None) };
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let fail = |e: http_client::Error| format!("The remote could not be reached: {}", e.without_url());
    let client = http_client::Client::builder().timeout(Duration::from_secs(20)).build().map_err(fail)?;
    let body = client.get(format!("{url}/api/version")).send().await.map_err(fail)?.text().await.map_err(fail)?;
    Ok(serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| v["version"].as_str().map(str::to_string)))
}

/// The owner looked at who redeployed the remote and trusts it as it is now.
#[tauri::command]
pub async fn remote_trust(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (cli, board, _) = board_of(&app)?;
        let now = super::deploy::production_deployments(cli.as_ref(), target(&board).team.as_deref())?.unwrap_or_default();
        update_remote(&app, |r| {
            for d in now {
                if !r.trusted.contains(&d.id) {
                    r.trusted.push(d.id);
                }
            }
            r.paused = None;
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn remote_status(app: AppHandle) -> RemoteStatus {
    remote_status_of(&app)
}

/// Opens a pairing; the six-digit code to show beside the remote's address.
#[tauri::command]
pub fn remote_pair_start(app: AppHandle) -> Result<String, String> {
    let bs = app.try_state::<BoardState>().ok_or("the board is not set up")?;
    let mut buf = [0u8; 8];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    bs.remote.pair_start(u64::from_be_bytes(buf))
}

#[tauri::command]
pub fn remote_pair_confirm(app: AppHandle) -> Result<(), String> {
    app.try_state::<BoardState>().ok_or("the board is not set up")?.remote.pair_confirm()
}

#[tauri::command]
pub fn remote_pair_cancel(app: AppHandle) {
    if let Some(bs) = app.try_state::<BoardState>() {
        bs.remote.pair_cancel();
    }
}

#[tauri::command]
pub fn remote_remove_phone(key: String, app: AppHandle) -> Result<(), String> {
    app.try_state::<BoardState>().ok_or("the board is not set up")?.remote.remove_phone(&key)
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
        d.settings.board = BoardSettings { enabled: true, team: Some("acme".into()), name: "ops".into(), share_details: false, session_env: true, share_new: false, host_id: Some("h1".into()), remote: Default::default(), access: Default::default() };
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
        let v = session_view(&d, "ada", &agent("w1", "b1"), false).unwrap();
        assert_eq!((v.builder.as_str(), v.agent, v.channel.as_deref()), ("Wizard", AgentKind::Claude, Some("v/ada/w/api-server")));
        assert_eq!(session_view(&d, "ada", &agent("w2", "b1"), false).unwrap().channel, None);
        assert!(session_view(&d, "ada", &info("w1", SessionKind::Terminal), false).is_none());
        assert!(session_view(&d, "ada", &agent("w1", "gone"), false).is_none());
        assert!(session_view(&d, "ada", &agent("gone", "b1"), false).is_none());
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
        p.update(session_view(&d, "ada", &agent("w1", "b1"), false).unwrap());
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
