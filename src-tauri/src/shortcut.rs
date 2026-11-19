//! The system-wide shortcut: ⌃⌥⌘J from any app brings the village up on the first item of the
//! owner's queue (as ⌘J does inside the window). On by default; Settings turns it off.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// The keys, as shown: Control + Option + Command + J. Three modifiers, so it takes no app's own shortcut.
pub const KEYS: &str = "⌃⌥⌘J";

fn keys() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER), Code::KeyJ)
}

/// Whether registering the keys last failed (another app holds them as its global shortcut).
#[derive(Default)]
pub struct Hotkey {
    pub taken: AtomicBool,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub enabled: bool,
    pub taken: bool,
}

/// The plugin, with the handler for the keys going down.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                on_pressed(app);
            }
        })
        .build()
}

/// Registers the keys (`enabled`) or lets them go. A failed registration is remembered for Settings.
pub fn apply<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    let gs = app.global_shortcut();
    let registered = gs.is_registered(keys());
    let taken = if enabled && !registered {
        gs.register(keys()).is_err()
    } else {
        if !enabled && registered {
            let _ = gs.unregister(keys());
        }
        false
    };
    if let Some(h) = app.try_state::<Hotkey>() {
        h.taken.store(taken, Ordering::SeqCst);
    }
}

/// The keys were pressed: the first of the queue, or just the window when nothing waits.
pub fn on_pressed<R: Runtime>(app: &AppHandle<R>) {
    match crate::queue_now(app).first() {
        Some(first) => crate::focus_and_select(app, &first.session.id),
        None => crate::show_main(app),
    }
}

#[tauri::command]
pub fn shortcut_status(app: AppHandle, state: tauri::State<'_, crate::commands::AppState>) -> ShortcutStatus {
    let enabled = state.data.lock().unwrap_or_else(|e| e.into_inner()).settings.global_shortcut;
    ShortcutStatus { enabled, taken: app.try_state::<Hotkey>().is_some_and(|h| h.taken.load(Ordering::SeqCst)) }
}
