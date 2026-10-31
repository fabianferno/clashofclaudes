pub mod adapters;
pub mod commands;
#[cfg(debug_assertions)]
pub mod driver;
pub mod git;
pub mod hooks;
pub mod model;
pub mod notify;
pub mod persist;
pub mod platform;
pub mod pty;
pub mod scrollback;
pub mod sessions;
pub mod status;
pub mod updater;
pub mod xp;

use commands::{AppState, Channels, Removed};
use sessions::{Emit, ManagerEvent, SessionManager};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tauri::ipc::InvokeResponseBody;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Manager, Runtime, WindowEvent};
use tauri_plugin_notification::{NotificationExt, PermissionState};

/// `denied`: set once permission was refused, so it is never asked again this run.
struct NotifyState {
    notifier: notify::Notifier,
    denied: AtomicBool,
    badge: notify::BadgeCache,
}

/// Shows `note` (lazily asking permission the first time); silent when refused or on error.
fn show_note<R: Runtime>(app: &AppHandle<R>, st: &NotifyState, note: notify::Note, session_id: &str) {
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
    let _ = n.builder().title(note.title).body(note.body).extra("sessionId", session_id).show();
}

/// Recomputes the dock badge from the live sessions; the dock is only touched on a change.
fn refresh_badge<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let n = notify::badge_count(&state.manager.list());
    if app.try_state::<NotifyState>().is_some_and(|ns| !ns.badge.changed(n)) {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(notify::badge_value(n));
    }
}

/// A notification was clicked: bring the window up and ask the frontend to select the session.
fn focus_and_select<R: Runtime>(app: &AppHandle<R>, session_id: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
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

const QUIT_MENU_ID: &str = "app-quit";

/// The default menu, except Quit: the predefined item terminates the process directly (macOS
/// `terminate:`) and never raises ExitRequested, so it is swapped for one that calls
/// `app.exit`, which goes through the exit guard in `run`.
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
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
        .menu(app_menu)
        .on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ID {
                app.exit(0);
            }
        })
        .setup(|app| {
            let data_dir = resolve_data_dir(app.path().app_data_dir()?, std::env::var("COC_DATA_DIR").ok().as_deref());
            std::fs::create_dir_all(&data_dir)?;
            let data_path = data_dir.join("state.json");
            let mut data = persist::load(&data_path);
            persist::mark_missing(&mut data);

            // The hook sink needs the manager, which needs the hook server: close the loop lazily.
            let cell: Arc<OnceLock<Weak<SessionManager>>> = Arc::default();
            let sink_cell = cell.clone();
            let hooks = tauri::async_runtime::block_on(hooks::HookServer::start(Arc::new(move |id, body| {
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
                            let name = st
                                .data
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .builders
                                .iter()
                                .find(|b| &b.id == bid)
                                .map(|b| b.name.clone())
                                .unwrap_or_else(|| "Builder".to_string());
                            if let Some(note) = ns.notifier.on_update(None, &info, &name) {
                                show_note(&handle, &ns, note, &info.id);
                            }
                        }
                    }
                    let _ = handle.emit("session-updated", info);
                    refresh_badge(&handle);
                }
                ManagerEvent::Removed { id } => {
                    if let Some(ns) = handle.try_state::<NotifyState>() {
                        ns.notifier.forget(&id);
                    }
                    let _ = handle.emit("session-removed", Removed { id });
                    refresh_badge(&handle);
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
            #[cfg(debug_assertions)]
            let data_dir_for_driver = data_dir.clone();
            let manager = SessionManager::new(adapters::AdapterRegistry::new(), Arc::new(hooks), data_dir, emit);
            let _ = cell.set(Arc::downgrade(&manager));
            // Session dirs left by a crash; none is live yet, so this only removes leftovers.
            manager.sweep_stale_session_dirs();
            // A launch in the background (`open -g`, or focus moved away while starting) is
            // unfocused from the start; a later focus event corrects either way.
            let focused = app.get_webview_window("main").is_some_and(|w| w.is_focused().unwrap_or(false));
            app.manage(NotifyState { notifier: notify::Notifier::with_focus(focused), denied: AtomicBool::new(false), badge: notify::BadgeCache::default() });
            let click_handle = app.handle().clone();
            let _ = app.notification().on_action(move |a| {
                if a.action_id() != "tap" {
                    return;
                }
                if let Some(id) = a.notification().and_then(|n| n.extra().get("sessionId")).and_then(|v| v.as_str()) {
                    focus_and_select(&click_handle, id);
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
                let st = window.state::<AppState>();
                let live = st.manager.running_process_count();
                if commands::should_block_exit(live, st.exit_confirmed.load(Ordering::SeqCst)) {
                    api.prevent_close();
                    commands::emit_confirm_quit(window.app_handle(), live, false);
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
            commands::close_session,
            commands::set_compound,
            commands::set_session_spot,
            commands::open_in_editor,
            commands::review_session,
            commands::attach_session,
            commands::detach_session,
            commands::ack_output,
            commands::quit_now,
            commands::get_settings,
            commands::set_settings,
            commands::check_for_update,
            commands::install_update,
            commands::restart_for_update,
            commands::driver_result,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Quit from the menu or Cmd+Q (see `app_menu`) never raises CloseRequested, so guard
            // the exit itself.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let st = app.state::<AppState>();
                let live = st.manager.running_process_count();
                if commands::should_block_exit(live, st.exit_confirmed.load(Ordering::SeqCst)) {
                    api.prevent_exit();
                    commands::emit_confirm_quit(app, live, false);
                }
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
}

#[cfg(test)] mod smoke { #[test] fn it_builds() { assert_eq!(2 + 2, 4); } }
