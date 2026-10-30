mod adapters;
mod commands;
mod git;
mod hooks;
mod model;
mod persist;
mod platform;
mod pty;
mod scrollback;
mod sessions;
mod status;

use commands::{AppState, Channels, Removed};
use sessions::{Emit, ManagerEvent, SessionManager};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tauri::ipc::InvokeResponseBody;
use tauri::{Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
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
                    let _ = handle.emit("session-updated", info);
                }
                ManagerEvent::Removed { id } => {
                    let _ = handle.emit("session-removed", Removed { id });
                }
                ManagerEvent::Output { id, offset, data } => {
                    if let Some(ch) = chans.lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
                        let _ = ch.send(InvokeResponseBody::Raw(commands::frame(offset, &data)));
                    }
                }
            });
            let manager = SessionManager::new(adapters::AdapterRegistry::new(), Arc::new(hooks), data_dir, emit);
            let _ = cell.set(Arc::downgrade(&manager));
            app.manage(AppState {
                data: Mutex::new(data),
                data_path,
                manager,
                registry: adapters::AdapterRegistry::new(),
                channels,
                exit_confirmed: AtomicBool::new(false),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let st = window.state::<AppState>();
                let live = st.manager.live_count();
                if commands::should_block_exit(live, st.exit_confirmed.load(Ordering::SeqCst)) {
                    api.prevent_close();
                    commands::emit_confirm_quit(window.app_handle(), live);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_state,
            commands::detect_agents,
            commands::add_workspace,
            commands::create_workspace,
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
            commands::review_session,
            commands::attach_session,
            commands::detach_session,
            commands::quit_now,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Cmd+Q / app-menu Quit never raise CloseRequested, so guard the exit itself.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let st = app.state::<AppState>();
                let live = st.manager.live_count();
                if commands::should_block_exit(live, st.exit_confirmed.load(Ordering::SeqCst)) {
                    api.prevent_exit();
                    commands::emit_confirm_quit(app, live);
                }
            }
        });
}

#[cfg(test)] mod smoke { #[test] fn it_builds() { assert_eq!(2 + 2, 4); } }
