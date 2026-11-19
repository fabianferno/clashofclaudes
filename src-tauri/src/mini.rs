//! The mini village: the village alone in a small panel that floats above other apps, on every
//! Space and over full-screen apps, and never takes the keyboard from the app in front. The page
//! is the main window's with `?view=mini` (src/MiniApp.tsx): it draws, and starts nothing.
//!
//! macOS only lets a real `NSPanel` be non-activating, and Tauri's window cannot be turned into
//! one after the fact (macOS observes a window from the moment it is made, and those observers do
//! not survive a change of class). So Tauri builds its window hidden, as the web view's owner, and
//! the web view is shown in a native panel made here (`panel`). The panel has the system's small
//! title bar: dragging, resizing and the close button are AppKit's own.

use crate::commands::AppState;
use crate::model::MiniWindow;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// The mini village's window label (its capability: `capabilities/mini.json`).
pub const LABEL: &str = "mini";
pub const MIN_W: f64 = 240.0;
pub const MIN_H: f64 = 160.0;
const DEFAULT_W: f64 = 360.0;
const DEFAULT_H: f64 = 240.0;
/// Room left to the screen's edge where the window is first put.
pub const MARGIN: f64 = 16.0;
/// At least this much of it (each way) must be on a screen, or it is put back in view.
const MIN_SHOWING: f64 = 40.0;
/// A move or resize is written down once the window has stood still this long.
const SAVE_AFTER: std::time::Duration = std::time::Duration::from_millis(500);

/// A rectangle in screen points (top-left origin).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Where the mini village first stands: the top-right corner of the first screen.
pub fn default_rect(screens: &[Rect]) -> Rect {
    match screens.first() {
        Some(s) => Rect { x: s.x + s.w - DEFAULT_W - MARGIN, y: s.y + MARGIN, w: DEFAULT_W, h: DEFAULT_H },
        None => Rect { x: MARGIN, y: MARGIN, w: DEFAULT_W, h: DEFAULT_H },
    }
}

/// `rect` as it can be shown now: left alone while enough of it is on a screen; otherwise (its
/// monitor was unplugged) put in the first screen's top-right corner. Never smaller than the
/// minimum or larger than the screen.
pub fn clamp(rect: Rect, screens: &[Rect]) -> Rect {
    if ![rect.x, rect.y, rect.w, rect.h].iter().all(|v| v.is_finite()) {
        return default_rect(screens);
    }
    let showing = |s: &Rect, r: &Rect| {
        let w = (r.x + r.w).min(s.x + s.w) - r.x.max(s.x);
        let h = (r.y + r.h).min(s.y + s.h) - r.y.max(s.y);
        w >= MIN_SHOWING && h >= MIN_SHOWING
    };
    let sized = |s: Option<&Rect>| Rect {
        w: rect.w.max(MIN_W).min(s.map_or(f64::MAX, |s| s.w.max(MIN_W))),
        h: rect.h.max(MIN_H).min(s.map_or(f64::MAX, |s| s.h.max(MIN_H))),
        ..rect
    };
    if let Some(s) = screens.iter().find(|s| showing(s, &sized(Some(s)))) {
        return sized(Some(s));
    }
    let first = screens.first();
    let r = sized(first);
    match first {
        Some(s) => Rect { x: s.x + s.w - r.w - MARGIN, y: s.y + MARGIN, ..r },
        None => Rect { x: MARGIN, y: MARGIN, ..r },
    }
}

/// Counts moves and resizes, so only the last of a drag is written down.
#[derive(Default)]
pub struct MiniState {
    moves: AtomicU64,
}

/// The connected screens, in points (top-left origin, the primary screen first).
fn screens<R: Runtime>(app: &AppHandle<R>) -> Vec<Rect> {
    let mut all = app.available_monitors().unwrap_or_default();
    // the primary screen first: where a panel with no usable place goes
    if let Ok(Some(primary)) = app.primary_monitor() {
        all.sort_by_key(|m| m.name() != primary.name());
    }
    all.iter()
        .map(|m| {
            let f = m.scale_factor();
            let (p, s) = (m.position(), m.size());
            Rect { x: p.x as f64 / f, y: p.y as f64 / f, w: s.width as f64 / f, h: s.height as f64 / f }
        })
        .collect()
}

pub fn is_open<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(LABEL).is_some()
}

/// Opens the mini village where it was last left (or does nothing when it is open).
pub fn open<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if is_open(app) {
        return Ok(());
    }
    let saved = app.try_state::<AppState>().and_then(|s| s.data().mini_window);
    let all = screens(app);
    let r = match saved {
        Some(m) => clamp(Rect { x: m.x, y: m.y, w: m.w, h: m.h }, &all),
        None => default_rect(&all),
    };
    // Tauri's window stays hidden: it owns the web view, which the panel shows.
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?view=mini".into()))
        .title("Mini Village")
        .visible(false)
        .focused(false)
        .focusable(false)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .background_color(tauri::window::Color(0x1d, 0x13, 0x0b, 0xff))
        .inner_size(r.w, r.h)
        .build()?;
    #[cfg(target_os = "macos")]
    {
        let (app, w) = (app.clone(), window.clone());
        window.run_on_main_thread(move || {
            let events = app.clone();
            panel::show(&w, r, Box::new(move |e| on_panel_event(&events, e)));
        })?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_always_on_top(true);
        let _ = window.show();
    }
    if let Some(s) = app.try_state::<AppState>() {
        s.update_mini(true, |_| Some(MiniWindow { x: r.x, y: r.y, w: r.w, h: r.h, open: true }));
    }
    crate::tray::refresh(app);
    Ok(())
}

/// Puts the mini village away; it stays away on the next launch.
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(s) = app.try_state::<AppState>() {
        s.update_mini(true, |m| m.map(|m| MiniWindow { open: false, ..m }));
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        #[cfg(target_os = "macos")]
        {
            // the web view goes back to its own window before that window is destroyed
            let husk = w.clone();
            let _ = w.run_on_main_thread(move || {
                panel::hide(&husk);
                let _ = husk.destroy();
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = w.destroy();
    }
    crate::tray::refresh(app);
}

pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    if is_open(app) {
        close(app);
    } else if let Err(e) = open(app) {
        eprintln!("mini village: {e}");
    }
}

/// At launch: the mini village comes back when it was open at the last quit.
pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    app.manage(MiniState::default());
    if app.try_state::<AppState>().and_then(|s| s.data().mini_window).is_some_and(|m| m.open) {
        let _ = open(app);
    }
}

/// What the panel reports.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PanelEvent {
    /// It stands here now (moved or resized).
    Placed(Rect),
    /// Its close button was clicked.
    CloseAsked,
}

fn on_panel_event<R: Runtime>(app: &AppHandle<R>, event: PanelEvent) {
    match event {
        // off the panel's own callback: closing takes the panel apart
        PanelEvent::CloseAsked => {
            let app = app.clone();
            std::thread::spawn(move || close(&app));
        }
        PanelEvent::Placed(r) => {
            let (Some(state), Some(mini)) = (app.try_state::<AppState>(), app.try_state::<MiniState>()) else { return };
            state.update_mini(false, |m| Some(MiniWindow { x: r.x, y: r.y, w: r.w, h: r.h, open: m.is_none_or(|m| m.open) }));
            // written down once the drag has settled: a drag sends a stream of these
            let mine = mini.moves.fetch_add(1, Ordering::SeqCst) + 1;
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(SAVE_AFTER);
                let (Some(state), Some(mini)) = (app.try_state::<AppState>(), app.try_state::<MiniState>()) else { return };
                if mini.moves.load(Ordering::SeqCst) == mine {
                    state.update_mini(true, |m| m);
                }
            });
        }
    }
}

#[tauri::command]
pub fn toggle_mini(app: AppHandle) {
    toggle(&app);
}

/// From the mini village: the main window, on this session when one was clicked.
#[tauri::command]
pub fn focus_session(id: Option<String>, app: AppHandle) {
    match id {
        Some(id) => crate::focus_and_select(&app, &id),
        None => crate::show_main(&app),
    }
}

/// The native panel that shows the mini village's web view. Everything here runs on the main
/// thread (AppKit's rule): `show` and `hide` are called from `run_on_main_thread`.
#[cfg(target_os = "macos")]
mod panel {
    use super::{PanelEvent, Rect};
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::{
        NSBackingStoreType, NSPanel, NSResponder, NSScreen, NSView, NSWindow, NSWindowCollectionBehavior, NSWindowDelegate, NSWindowStyleMask,
    };
    use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};
    use std::cell::RefCell;
    use tauri::{Runtime, WebviewWindow};

    type Report = Box<dyn Fn(PanelEvent)>;

    define_class!(
        // SAFETY: NSPanel may be subclassed; no ivars, no Drop.
        #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "CocMiniPanel"]
        struct MiniPanel;

        impl MiniPanel {
            /// Never the key window: typing stays with the app in front.
            #[unsafe(method(canBecomeKeyWindow))]
            fn can_become_key_window(&self) -> bool {
                false
            }

            #[unsafe(method(canBecomeMainWindow))]
            fn can_become_main_window(&self) -> bool {
                false
            }
        }
    );

    define_class!(
        // SAFETY: a plain NSObject subclass; its ivar is only touched on the main thread.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "CocMiniPanelDelegate"]
        #[ivars = Report]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl NSWindowDelegate for Delegate {
            /// The close button: the app closes the mini village itself (see `super::close`).
            #[unsafe(method(windowShouldClose:))]
            fn window_should_close(&self, _: Option<&AnyObject>) -> bool {
                (self.ivars())(PanelEvent::CloseAsked);
                false
            }

            #[unsafe(method(windowDidMove:))]
            fn window_did_move(&self, _: Option<&AnyObject>) {
                self.placed();
            }

            #[unsafe(method(windowDidResize:))]
            fn window_did_resize(&self, _: Option<&AnyObject>) {
                self.placed();
            }
        }
    );

    impl Delegate {
        fn placed(&self) {
            let Some(mtm) = MainThreadMarker::new() else { return };
            SHOWN.with(|s| {
                if let Some(shown) = s.borrow().as_ref() {
                    (self.ivars())(PanelEvent::Placed(from_frame(shown.panel.frame(), mtm)));
                }
            });
        }
    }

    /// The panel on screen, its delegate, and the view that stands in for the web view in Tauri's window.
    struct Shown {
        panel: Retained<MiniPanel>,
        _delegate: Retained<Delegate>,
    }

    thread_local! {
        static SHOWN: RefCell<Option<Shown>> = const { RefCell::new(None) };
    }

    /// The primary screen's height: AppKit measures from its bottom-left, the rest of the app from its top-left.
    fn primary_height(mtm: MainThreadMarker) -> f64 {
        NSScreen::screens(mtm).firstObject().map_or(0.0, |s| s.frame().size.height)
    }

    fn to_frame(r: Rect, mtm: MainThreadMarker) -> NSRect {
        NSRect::new(NSPoint::new(r.x, primary_height(mtm) - r.y - r.h), NSSize::new(r.w, r.h))
    }

    fn from_frame(f: NSRect, mtm: MainThreadMarker) -> Rect {
        Rect { x: f.origin.x, y: primary_height(mtm) - f.origin.y - f.size.height, w: f.size.width, h: f.size.height }
    }

    /// Shows `window`'s web view in a floating panel at `at`; `report` hears of moves and the close button.
    pub fn show<R: Runtime>(window: &WebviewWindow<R>, at: Rect, report: Report) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Ok(ptr) = window.ns_window() else { return };
        if ptr.is_null() {
            return;
        }
        // SAFETY: `ptr` is this window's live NSWindow, used on the main thread.
        let husk: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let Some(content) = husk.contentView() else { return };

        let mask = NSWindowStyleMask::Titled
            | NSWindowStyleMask::Closable
            | NSWindowStyleMask::Resizable
            | NSWindowStyleMask::UtilityWindow
            | NSWindowStyleMask::NonactivatingPanel;
        let frame = to_frame(at, mtm);
        let this = MiniPanel::alloc(mtm).set_ivars(());
        // SAFETY: NSPanel's designated initializer, with a valid rect and style mask.
        let panel: Retained<MiniPanel> = unsafe {
            msg_send![super(this), initWithContentRect: frame, styleMask: mask, backing: NSBackingStoreType::Buffered, defer: false]
        };
        // SAFETY: the panel is kept in `SHOWN`; it must not free itself when closed.
        unsafe { panel.setReleasedWhenClosed(false) };
        panel.setTitle(&NSString::from_str("Mini Village"));
        panel.setFloatingPanel(true);
        panel.setHidesOnDeactivate(false);
        panel.setBecomesKeyOnlyIfNeeded(true);
        panel.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary);
        panel.setContentMinSize(NSSize::new(super::MIN_W, super::MIN_H - 22.0));
        panel.setFrame_display(frame, false);

        let delegate: Retained<Delegate> = {
            let this = Delegate::alloc(mtm).set_ivars(report);
            // SAFETY: NSObject's init.
            unsafe { msg_send![super(this), init] }
        };
        panel.setDelegate(Some(objc2::runtime::ProtocolObject::from_ref(&*delegate)));

        // the web view's view moves into the panel; an empty one takes its place in Tauri's window
        husk.setContentView(Some(&NSView::new(mtm)));
        panel.setContentView(Some(&content));
        // on screen without this app becoming the active one
        panel.orderFrontRegardless();
        SHOWN.with(|s| *s.borrow_mut() = Some(Shown { panel, _delegate: delegate }));
    }

    /// Takes the panel away and gives the web view's view back to `window`, which is about to be destroyed.
    pub fn hide<R: Runtime>(window: &WebviewWindow<R>) {
        let Some(shown) = SHOWN.with(|s| s.borrow_mut().take()) else { return };
        shown.panel.setDelegate(None);
        let content = shown.panel.contentView();
        if let Some(mtm) = MainThreadMarker::new() {
            shown.panel.setContentView(Some(&NSView::new(mtm)));
        }
        if let (Ok(ptr), Some(content)) = (window.ns_window(), content)
            && !ptr.is_null()
        {
            // SAFETY: as in `show`.
            let husk: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            husk.setContentView(Some(&content));
        }
        shown.panel.orderOut(None);
        shown.panel.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect { x: 0.0, y: 0.0, w: 1440.0, h: 900.0 };

    #[test]
    fn clamp_keeps_visible_rect() {
        let r = Rect { x: 900.0, y: 500.0, w: 400.0, h: 300.0 };
        assert_eq!(clamp(r, &[SCREEN]), r);
        // partly off the edge, with plenty still showing: left where the owner put it
        let edge = Rect { x: 1300.0, y: 700.0, w: 360.0, h: 240.0 };
        assert_eq!(clamp(edge, &[SCREEN]), edge);
        // on a second screen to the left
        let second = Rect { x: -1920.0, y: 0.0, w: 1920.0, h: 1080.0 };
        let there = Rect { x: -500.0, y: 100.0, w: 360.0, h: 240.0 };
        assert_eq!(clamp(there, &[SCREEN, second]), there);
    }

    #[test]
    fn clamp_moves_offscreen_rect_onto_a_screen() {
        // it was on a monitor that is no longer connected
        let gone = Rect { x: 5000.0, y: 200.0, w: 360.0, h: 240.0 };
        assert_eq!(clamp(gone, &[SCREEN]), Rect { x: 1440.0 - 360.0 - 16.0, y: 16.0, w: 360.0, h: 240.0 });
        // only a sliver left showing counts as gone too
        let sliver = Rect { x: 1430.0, y: 100.0, w: 360.0, h: 240.0 };
        assert_eq!(clamp(sliver, &[SCREEN]).x, 1440.0 - 360.0 - 16.0);
    }

    #[test]
    fn clamp_enforces_min_and_max_size() {
        let tiny = clamp(Rect { x: 100.0, y: 100.0, w: 100.0, h: 50.0 }, &[SCREEN]);
        assert_eq!((tiny.w, tiny.h), (MIN_W, MIN_H));
        let huge = clamp(Rect { x: 0.0, y: 0.0, w: 4000.0, h: 3000.0 }, &[SCREEN]);
        assert_eq!((huge.w, huge.h), (1440.0, 900.0));
        // nonsense from a damaged save
        let nan = clamp(Rect { x: f64::NAN, y: 0.0, w: f64::NAN, h: -5.0 }, &[SCREEN]);
        assert_eq!(nan, default_rect(&[SCREEN]));
    }

    #[test]
    fn default_rect_is_top_right_of_the_first_screen() {
        assert_eq!(default_rect(&[SCREEN]), Rect { x: 1440.0 - 360.0 - 16.0, y: 16.0, w: 360.0, h: 240.0 });
        let offset = Rect { x: 1440.0, y: -200.0, w: 1920.0, h: 1080.0 };
        assert_eq!(default_rect(&[offset, SCREEN]), Rect { x: 1440.0 + 1920.0 - 376.0, y: -184.0, w: 360.0, h: 240.0 });
        // no screen reported at all: still somewhere sane
        assert_eq!(default_rect(&[]), Rect { x: MARGIN, y: MARGIN, w: 360.0, h: 240.0 });
    }
}
