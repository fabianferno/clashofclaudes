pub mod account;
pub mod adapters;
pub mod apps;
pub mod attachments;
pub mod commands;
#[cfg(debug_assertions)]
pub mod driver;
pub mod git;
pub mod history;
pub mod hooks;
pub mod model;
pub mod bugreport;
pub mod notify;
pub mod osc;
pub mod title;
pub mod tray;
pub mod persist;
pub mod platform;
pub mod pty;
pub mod queue;
pub mod quota;
pub mod saved;
pub mod scrollback;
pub mod sessions;
pub mod shortcut;
pub mod snapshot;
pub mod sounds;
pub mod status;
pub mod updater;
pub mod usage;
pub mod xp;

use commands::{AppState, Channels, Removed};
use sessions::{Emit, ManagerEvent, SessionManager};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tauri::ipc::InvokeResponseBody;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Runtime, WindowEvent};
use tauri_plugin_notification::{NotificationExt, PermissionState};

/// `denied`: set once permission was refused, so it is never asked again this run.
struct NotifyState {
    notifier: notify::Notifier,
    denied: AtomicBool,
    badge: notify::BadgeCache,
}

/// The notification action type whose one button approves the prompt the note was shown for.
/// One button only: macOS folds two or more into an "Options" menu whose own click reports the
/// first action, so a Deny next to it could be picked by a click meant to open the menu (or the
/// reverse). Deny stays one click away: clicking the note opens the session's briefing.
const DECIDE_ACTIONS: &str = "decide";
const ALLOW_ACTION: &str = "allow";

/// Shows `note` (lazily asking permission the first time); silent when refused or on error.
/// `allow`: give it the Allow button (the prompt is still open and the app can answer it).
fn show_note<R: Runtime>(app: &AppHandle<R>, st: &NotifyState, note: notify::Note, session_id: &str, allow: bool) {
    if st.denied.load(Ordering::SeqCst) {
        return;
    }
    let n = app.notification();
    if !matches!(n.permission_state(), Ok(PermissionState::Granted)) {
        match n.request_permission() {
            Ok(PermissionState::Granted) => {}
            _ => {
                st.denied.store(true, Ordering::SeqCst);
                return;
            }
        }
    }
    let mut b = n.builder().title(note.title).body(note.body).extra("sessionId", session_id);
    if let Some(since) = note.allow_since.filter(|_| allow) {
        b = b.action_type_id(DECIDE_ACTIONS).extra("stateSince", since);
    }
    let _ = b.show();
}

/// The owner's queue right now: the live sessions that wait on them, in a workspace that is there.
pub(crate) fn queue_now<R: Runtime>(app: &AppHandle<R>) -> Vec<queue::QueueItem> {
    let Some(state) = app.try_state::<AppState>() else { return Vec::new() };
    let ids: Vec<String> = state.data.lock().unwrap_or_else(|e| e.into_inner()).workspaces.iter().map(|w| w.id.clone()).collect();
    queue::owner_queue(&state.manager.list(), &ids)
}

/// Recomputes the dock badge from the owner's queue (none when the setting is off); the dock is
/// only touched on a change.
pub(crate) fn refresh_badge<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let shown = state.data.lock().unwrap_or_else(|e| e.into_inner()).settings.dock_badge;
    let n = if shown { queue_now(app).len() as i64 } else { 0 };
    if app.try_state::<NotifyState>().is_some_and(|ns| !ns.badge.changed(n)) {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(notify::badge_value(n));
    }
}

/// Brings the village's window up: shown again if it was closed (hidden), out of the Dock, in front.
pub(crate) fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// A notification was clicked: bring the window up and ask the frontend to select the session.
pub(crate) fn focus_and_select<R: Runtime>(app: &AppHandle<R>, session_id: &str) {
    show_main(app);
    let _ = app.emit("select-session", serde_json::json!({ "id": session_id }));
}

/// The app data dir: `override_dir` (debug builds only, from `COC_DATA_DIR`; empty is ignored)
/// wins over `default`. Release builds always use `default`.
pub fn resolve_data_dir(default: std::path::PathBuf, override_dir: Option<&str>) -> std::path::PathBuf {
    #[cfg(debug_assertions)]
    if let Some(o) = override_dir.filter(|o| !o.is_empty()) {
        return std::path::PathBuf::from(o);
    }
    let _ = override_dir;
    default
}

/// The bundle identifier before 0.2.0; its data folder moves to the current one on first launch.
const OLD_IDENTIFIER: &str = "dev.clashofclaudes.app";

/// Moves the data folder of builds before the identifier change (`dev.clashofclaudes.app`) to `data_dir`,
/// once, when `data_dir` doesn't exist yet. The old path is left as a link to the new one, so paths
/// already handed to agents (session images, settings files) still resolve.
pub fn migrate_old_data_dir(data_dir: &std::path::Path) {
    let Some(old) = data_dir.parent().map(|p| p.join(OLD_IDENTIFIER)) else { return };
    if old == data_dir || data_dir.exists() || !old.symlink_metadata().is_ok_and(|m| m.is_dir()) {
        return;
    }
    match std::fs::rename(&old, data_dir) {
        Ok(()) => {
            if let Err(e) = std::os::unix::fs::symlink(data_dir, &old) {
                eprintln!("data folder moved, but the link at the old path failed: {e}");
            }
        }
        Err(e) => eprintln!("could not move the old data folder: {e}"),
    }
}

const QUIT_MENU_ID: &str = "app-quit";
const SETTINGS_MENU_ID: &str = "app-settings";
const BUG_MENU_ID: &str = "app-report-bug";
const FEATURE_MENU_ID: &str = "app-request-feature";
const WEBSITE_MENU_ID: &str = "app-website";
const NOTES_MENU_ID: &str = "app-release-notes";
/// Opened in the browser from the Help menu.
const WEBSITE_URL: &str = "https://clashofclaudes.crevn.xyz";
const RELEASES_URL: &str = "https://github.com/fabianferno/clashofclaudes-releases/releases";

/// The default menu, plus Settings… (Cmd+,) after About and, in Help, Report a Bug… / Request a Feature…,
/// Release Notes and the website, except Quit: the predefined item
/// terminates the process directly (macOS `terminate:`) and never raises ExitRequested, so it is
/// swapped for one that calls `app.exit`, which goes through the exit guard in `run`.
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    if let Some(first) = menu.items()?.first().and_then(|t| t.as_submenu().cloned()) {
        first.insert(&PredefinedMenuItem::separator(app)?, 1)?;
        first.insert(&MenuItem::with_id(app, SETTINGS_MENU_ID, "Settings…", true, Some("CmdOrCtrl+,"))?, 2)?;
    }
    for top in menu.items()? {
        if let Some(sub) = top.as_submenu()
            && sub.text()? == "Help"
        {
            sub.append(&MenuItem::with_id(app, BUG_MENU_ID, "Report a Bug…", true, None::<&str>)?)?;
            sub.append(&MenuItem::with_id(app, FEATURE_MENU_ID, "Request a Feature…", true, None::<&str>)?)?;
            sub.append(&PredefinedMenuItem::separator(app)?)?;
            sub.append(&MenuItem::with_id(app, NOTES_MENU_ID, "Release Notes", true, None::<&str>)?)?;
            sub.append(&MenuItem::with_id(app, WEBSITE_MENU_ID, "Clash of Claudes Website", true, None::<&str>)?)?;
        }
    }
    for top in menu.items()? {
        let Some(sub) = top.as_submenu() else { continue };
        for (i, item) in sub.items()?.into_iter().enumerate() {
            let Some(p) = item.as_predefined_menuitem() else { continue };
            let text = p.text()?.replace('&', "");
            if text.starts_with("Quit") || text == "Exit" {
                sub.remove(p)?;
                sub.insert(&MenuItem::with_id(app, QUIT_MENU_ID, text, true, Some("CmdOrCtrl+Q"))?, i)?;
            }
        }
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// How often the machine is scanned for local web apps in a workspace.
const APP_SCAN_EVERY: std::time::Duration = std::time::Duration::from_secs(4);

/// Scans for local web apps in the workspaces (see `apps`) and emits `apps-updated` when the list changes.
fn spawn_app_scanner<R: Runtime>(app: AppHandle<R>) {
    // the app's own dev server is not a workspace app, even when the workspace is this repo
    let skip: Vec<u16> = if cfg!(debug_assertions) {
        app.config().build.dev_url.as_ref().and_then(|u| u.port()).into_iter().collect()
    } else {
        Vec::new()
    };
    std::thread::spawn(move || {
        let scanner = apps::Scanner::default();
        loop {
            let roots: Vec<(String, std::path::PathBuf)> = {
                let st = app.state::<AppState>();
                let data = st.data.lock().unwrap_or_else(|e| e.into_inner());
                let mut r: Vec<_> = data.workspaces.iter().filter(|w| !w.missing).map(|w| (w.id.clone(), w.path.clone())).collect();
                drop(data);
                r.extend(st.manager.list().into_iter().filter_map(|s| s.worktree.map(|wt| (s.workspace_id, wt.path))));
                r
            };
            let found = scanner.scan(&roots, &skip);
            let st = app.state::<commands::AppsState>();
            let mut cur = st.latest.lock().unwrap_or_else(|e| e.into_inner());
            if *cur != found {
                *cur = found.clone();
                drop(cur);
                let _ = app.emit("apps-updated", found);
            }
            std::thread::sleep(APP_SCAN_EVERY);
        }
    });
}

pub fn run() {
    // A Dock/Finder launch inherits launchd's minimal PATH: import the login shell's before
    // anything else, so `which`, the adapters' probes and PTY spawns find the agent CLIs.
    // SAFETY: first statement of `run`; no other thread exists yet.
    unsafe { platform::import_login_path() };
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(shortcut::plugin())
        .menu(app_menu)
        .on_menu_event(|app, event| {
            if tray::on_menu_event(app, event.id().as_ref()) {
                // the menu bar's menu
            } else if event.id() == QUIT_MENU_ID {
                app.exit(0);
            } else if event.id() == SETTINGS_MENU_ID {
                let _ = app.emit("open-settings", ());
            } else if event.id() == BUG_MENU_ID {
                let _ = app.emit("open-bug-report", "bug");
            } else if event.id() == FEATURE_MENU_ID {
                let _ = app.emit("open-bug-report", "feature");
            } else if event.id() == WEBSITE_MENU_ID || event.id() == NOTES_MENU_ID {
                use tauri_plugin_opener::OpenerExt;
                let url = if event.id() == WEBSITE_MENU_ID { WEBSITE_URL } else { RELEASES_URL };
                let _ = app.opener().open_url(url, None::<&str>);
            }
        })
        .setup(|app| {
            let default_dir = app.path().app_data_dir()?;
            let data_dir = resolve_data_dir(default_dir.clone(), std::env::var("COC_DATA_DIR").ok().as_deref());
            if data_dir == default_dir {
                migrate_old_data_dir(&data_dir);
            }
            std::fs::create_dir_all(&data_dir)?;
            let data_path = data_dir.join("state.json");
            let mut data = persist::load(&data_path);
            persist::mark_missing(&mut data);
            // images pasted into a task that was never added or started
            attachments::sweep(&data_dir, &data.todos.iter().flat_map(|t| t.images.iter().map(String::as_str)).collect());

            // The hook sink needs the manager, which needs the hook server: close the loop lazily.
            let cell: Arc<OnceLock<Weak<SessionManager>>> = Arc::default();
            let sink_cell = cell.clone();
            let quota_handle = app.handle().clone();
            let quotas = Arc::new(quota::QuotaStore::new(
                data_dir.join("quota.json"),
                Arc::new(move |q| {
                    let _ = quota_handle.emit("quota-updated", q);
                }),
            ));
            let sink_quotas = quotas.clone();
            let hooks = tauri::async_runtime::block_on(hooks::HookServer::start(Arc::new(move |id, body| {
                // Claude's status line (app-launched sessions) carries its rate limits.
                if let Some(w) = quota::parse_claude_status(&body) {
                    sink_quotas.set_keeping_reset(model::AgentKind::Claude, w, "Claude Code status line");
                }
                if let Some(m) = sink_cell.get().and_then(Weak::upgrade) {
                    m.on_hook(&id, body);
                }
            })))?;

            let channels: Channels = Arc::default();
            let (handle, chans) = (app.handle().clone(), channels.clone());
            let emit: Emit = Arc::new(move |ev| match ev {
                ManagerEvent::Updated(info) => {
                    if let Some(ns) = handle.try_state::<NotifyState>()
                        && let Some(st) = handle.try_state::<AppState>()
                        && let model::SessionKind::Agent { builder_id: bid } = &info.kind
                    {
                        if !ns.notifier.enters_notifiable(&info) {
                            // Most updates (output, steps): no window queries, no lookups.
                            ns.notifier.record(&info);
                        } else {
                            // Minimized or hidden counts as unfocused; errors too.
                            let obscured = handle
                                .get_webview_window("main")
                                .is_none_or(|w| w.is_minimized().unwrap_or(true) || !w.is_visible().unwrap_or(false));
                            ns.notifier.set_obscured(obscured);
                            let (name, settings) = {
                                let d = st.data.lock().unwrap_or_else(|e| e.into_inner());
                                let name = d.builders.iter().find(|b| &b.id == bid).map(|b| b.name.clone());
                                (name.unwrap_or_else(|| "Builder".to_string()), d.settings.clone())
                            };
                            // on_update first: it records the state even when the note is not wanted
                            if let Some(note) = ns.notifier.on_update(None, &info, &name)
                                && notify::wanted(&settings, &info.state)
                            {
                                let allow = note.allow_since.is_some() && st.manager.answerable(&info.id);
                                show_note(&handle, &ns, note, &info.id, allow);
                            }
                        }
                    }
                    let _ = handle.emit("session-updated", info);
                    refresh_badge(&handle);
                    tray::refresh(&handle);
                }
                ManagerEvent::Removed { id } => {
                    if let Some(ns) = handle.try_state::<NotifyState>() {
                        ns.notifier.forget(&id);
                    }
                    let _ = handle.emit("session-removed", Removed { id });
                    refresh_badge(&handle);
                    tray::refresh(&handle);
                }
                ManagerEvent::Output { id, offset, data } => {
                    if let Some(ch) = chans.lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
                        let _ = ch.send(InvokeResponseBody::Raw(commands::frame(offset, &data)));
                    }
                }
                ManagerEvent::Skipped { id, offset } => {
                    if let Some(ch) = chans.lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
                        let _ = ch.send(InvokeResponseBody::Raw(commands::skip_frame(offset)));
                    }
                }
            });
            let poller = Arc::new(quota::Poller::new(
                quotas.clone(),
                data_dir.clone(),
                quota::codex_sessions_dir(),
                quota::cli_usage_reader(Box::new(|agent| {
                    adapters::AdapterRegistry::new().get(agent.clone()).is_some_and(|a| a.detect().installed)
                })),
            ));
            poller.clone().spawn();
            app.manage(commands::QuotaState { store: quotas, poller });
            #[cfg(debug_assertions)]
            let data_dir_for_driver = data_dir.clone();
            let manager = SessionManager::new(adapters::AdapterRegistry::new(), Arc::new(hooks), data_dir, emit);
            let _ = cell.set(Arc::downgrade(&manager));
            // The sessions listed when the app last ran come back paused; then the dirs no session
            // owns (left by a crash) go, and the ones that were running resume (off the setup
            // thread: each is a process spawn).
            manager.restore(&data.workspaces, &data.builders);
            manager.sweep_stale_session_dirs();
            {
                let (m, workspaces, builders) = (manager.clone(), data.workspaces.clone(), data.builders.clone());
                std::thread::spawn(move || {
                    for (id, res) in m.resume_was_running(&workspaces, &builders) {
                        if let Err(e) = res {
                            eprintln!("could not resume session {id}: {e:#}");
                        }
                    }
                });
            }
            // A launch in the background (`open -g`, or focus moved away while starting) is
            // unfocused from the start; a later focus event corrects either way.
            let focused = app.get_webview_window("main").is_some_and(|w| w.is_focused().unwrap_or(false));
            app.manage(NotifyState { notifier: notify::Notifier::with_focus(focused), denied: AtomicBool::new(false), badge: notify::BadgeCache::default() });
            let click_handle = app.handle().clone();
            let _ = app.notification().register_action_types(vec![tauri_plugin_notification::ActionType::builder(DECIDE_ACTIONS)
                .actions(vec![tauri_plugin_notification::Action::builder(ALLOW_ACTION, "Allow").build()])
                .build()]);
            let _ = app.notification().on_action(move |a| {
                let Some(extra) = a.notification().map(|n| n.extra()) else { return };
                let Some(id) = extra.get("sessionId").and_then(|v| v.as_str()) else { return };
                match a.action_id() {
                    "tap" => focus_and_select(&click_handle, id),
                    ALLOW_ACTION => {
                        let since = extra.get("stateSince").and_then(|v| v.as_i64());
                        let approved = since.is_some_and(|since| {
                            click_handle.try_state::<AppState>().is_some_and(|st| st.manager.approve_if(id, since).is_ok())
                        });
                        if approved {
                            usage::track(&click_handle, usage::Event::PromptAnswered { allowed: true });
                        } else {
                            // Answered meanwhile, or a newer prompt is open: show where it stands instead.
                            focus_and_select(&click_handle, id);
                        }
                    }
                    _ => {}
                }
            });
            app.manage(AppState {
                data: Mutex::new(data),
                data_path,
                manager,
                registry: adapters::AdapterRegistry::new(),
                channels,
                exit_confirmed: AtomicBool::new(false),
                pending_update: Mutex::new(None),
            });
            app.manage(commands::AppsState::default());
            app.manage(snapshot::Snapper::default());
            let (workspaces, builders) = {
                let st = app.state::<commands::AppState>();
                let d = st.data();
                (d.workspaces.len(), d.builders.len())
            };
            usage::track(app.handle(), usage::Event::AppOpened { workspaces, builders });
            spawn_app_scanner(app.handle().clone());
            // the menu bar item: the queue's count and its menu, also while the window is closed
            tray::init(app.handle())?;
            // ⌃⌥⌘J from any app, unless Settings turned it off
            app.manage(shortcut::Hotkey::default());
            let hotkey = app.state::<commands::AppState>().data().settings.global_shortcut;
            shortcut::apply(app.handle(), hotkey);
            #[cfg(debug_assertions)]
            {
                app.manage(Arc::new(driver::Driver::default()));
                if std::env::var("COC_DRIVER").as_deref() == Ok("1") {
                    driver::start(app.handle().clone(), &data_dir_for_driver)?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // only the village's window counts: the hidden snapshot window (see `snapshot`) has no say
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::Destroyed = event {
                // the hidden window would otherwise keep the app alive with nothing on screen
                snapshot::close(window.app_handle());
            }
            if let WindowEvent::Focused(f) = event
                && let Some(ns) = window.try_state::<NotifyState>()
            {
                ns.notifier.set_focused(*f);
            }
            if let WindowEvent::Focused(true) = event {
                // Off the UI thread: `is_dir` on a stalled network mount can block.
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    if let Some(st) = app.try_state::<AppState>() {
                        commands::recheck_workspaces(&app, &st);
                    }
                });
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing the window only puts it away: the builders keep working and the app stays
                // in the menu bar and the Dock. Quitting (⌘Q, the menus) is guarded in `run` below.
                let st = window.state::<AppState>();
                if commands::close_hides(st.exit_confirmed.load(Ordering::SeqCst)) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_state,
            commands::detect_agents,
            commands::add_workspace,
            commands::create_workspace,
            commands::default_projects_dir,
            commands::remove_workspace,
            commands::create_builder,
            commands::update_builder,
            commands::delete_builder,
            commands::start_session,
            commands::start_terminal,
            commands::write_session,
            commands::resize_session,
            commands::approve,
            commands::deny,
            commands::stop_session,
            commands::resume_session,
            commands::close_session,
            commands::list_history,
            commands::continue_history,
            commands::forget_history,
            commands::set_compound,
            commands::set_workspace_color,
            commands::set_collector_spot,
            commands::move_compound,
            commands::set_session_spot,
            commands::get_quotas,
            commands::get_apps,
            commands::snapshot_app,
            commands::add_todo,
            commands::remove_todo,
            commands::update_todo,
            commands::park_session,
            commands::save_attachment,
            commands::import_attachment,
            commands::read_attachment,
            commands::discard_attachments,
            commands::refresh_quotas,
            commands::get_account,
            commands::open_in_editor,
            commands::open_in_finder,
            commands::haptic,
            commands::play_sound,
            commands::system_sounds,
            commands::import_sound,
            commands::review_session,
            commands::attach_session,
            commands::detach_session,
            commands::ack_output,
            commands::quit_now,
            commands::get_settings,
            commands::set_settings,
            commands::data_folder,
            bugreport::bug_report_info,
            bugreport::send_bug_report,
            usage::track_usage,
            commands::show_data_folder,
            commands::check_for_update,
            commands::install_update,
            commands::restart_for_update,
            shortcut::shortcut_status,
            commands::driver_result,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Quit from the menu or Cmd+Q (see `app_menu`) never raises CloseRequested, so guard
            // the exit itself.
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let st = app.state::<AppState>();
                    let live = st.manager.running_process_count();
                    if commands::should_block_exit(live, st.exit_confirmed.load(Ordering::SeqCst)) {
                        api.prevent_exit();
                        commands::emit_confirm_quit(app, live, false);
                    }
                }
                // The Dock icon clicked with the window closed (hidden): bring it back.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { has_visible_windows: false, .. } => show_main(app),
                _ => {}
            }
        });
}

#[cfg(test)]
mod data_dir_tests {
    use super::resolve_data_dir;
    use std::path::PathBuf;

    #[test]
    fn empty_or_missing_override_uses_default() {
        let d = PathBuf::from("/default");
        assert_eq!(resolve_data_dir(d.clone(), None), d);
        assert_eq!(resolve_data_dir(d.clone(), Some("")), d);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_override_wins() {
        assert_eq!(resolve_data_dir(PathBuf::from("/default"), Some("/tmp/x")), PathBuf::from("/tmp/x"));
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn release_ignores_override() {
        assert_eq!(resolve_data_dir(PathBuf::from("/default"), Some("/tmp/x")), PathBuf::from("/default"));
    }

    #[test]
    fn the_old_data_folder_moves_once_and_leaves_a_link() {
        use super::migrate_old_data_dir;
        let support = tempfile::tempdir().unwrap();
        let old = support.path().join("dev.clashofclaudes.app");
        let new = support.path().join("dev.clashofclaudes.desktop");
        std::fs::create_dir_all(old.join("sessions")).unwrap();
        std::fs::write(old.join("state.json"), "{}").unwrap();
        migrate_old_data_dir(&new);
        assert_eq!(std::fs::read_to_string(new.join("state.json")).unwrap(), "{}");
        assert!(new.join("sessions").is_dir());
        assert!(old.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(old.join("state.json")).unwrap(), "{}", "old paths still resolve");
        std::fs::write(new.join("state.json"), "{\"v\":2}").unwrap();
        migrate_old_data_dir(&new); // second launch: nothing moves
        assert_eq!(std::fs::read_to_string(new.join("state.json")).unwrap(), "{\"v\":2}");
    }

    #[test]
    fn an_existing_new_folder_is_never_replaced() {
        use super::migrate_old_data_dir;
        let support = tempfile::tempdir().unwrap();
        let old = support.path().join("dev.clashofclaudes.app");
        let new = support.path().join("dev.clashofclaudes.desktop");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        migrate_old_data_dir(&new);
        assert!(!old.symlink_metadata().unwrap().file_type().is_symlink());
        migrate_old_data_dir(&support.path().join("fresh")); // nothing old: nothing happens
    }
}

#[cfg(test)] mod smoke { #[test] fn it_builds() { assert_eq!(2 + 2, 4); } }
