//! Still pictures of the apps on the village's boards. A board used to show its app live in an
//! iframe, which ran the whole app (often a dev build with WebGL and animations) on the village's
//! own main thread all the time. Now one hidden window loads the app, waits for it to settle,
//! takes WebKit's snapshot of it and goes back to a blank page, so the app only runs for those
//! few seconds, in a process of its own.

use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "snapper";
/// The page is laid out at a laptop size, then pictured this many points wide (small: it is a thumbnail).
const PAGE_W: f64 = 1280.0;
const PAGE_H: f64 = 800.0;
const SNAP_W: f64 = 360.0;
/// How long a page may take to load, and how long it gets after loading to draw (fonts, client rendering).
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);
const SETTLE: Duration = Duration::from_millis(2200);
/// The hidden window (and its ~200 MB web process) goes away after this long without a capture.
const IDLE: Duration = Duration::from_secs(45);

/// One capture at a time: they share the hidden window.
#[derive(Default)]
pub struct Snapper {
    busy: Mutex<()>,
    loaded: Mutex<Option<mpsc::Sender<String>>>,
    /// When the last capture ended, for closing the window once idle.
    last: Mutex<Option<std::time::Instant>>,
}

/// Closes the hidden window now (the village's window went away).
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
}

/// Only local web apps and the owner's own http(s) browsers are pictured.
pub fn check_url(url: &str) -> Result<Url> {
    let u = Url::parse(url)?;
    if u.scheme() != "http" && u.scheme() != "https" {
        bail!("only http(s) pages can be pictured");
    }
    Ok(u)
}

impl Snapper {
    /// A JPEG of `url`, about SNAP_W points wide. Blocks (call it off the main thread).
    pub fn capture<R: Runtime>(&self, app: &AppHandle<R>, url: &str) -> Result<Vec<u8>> {
        let target = check_url(url)?;
        let _one = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel::<String>();
        *self.loaded.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        let win = match app.get_webview_window(LABEL) {
            Some(w) => {
                w.navigate(target.clone())?;
                w
            }
            None => {
                let handle = app.clone();
                WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(target.clone()))
                    .title("Snapshot")
                    .inner_size(PAGE_W, PAGE_H)
                    .visible(false)
                    .decorations(false)
                    .focused(false)
                    .skip_taskbar(true)
                    .on_page_load(move |_, p| {
                        if p.event() == PageLoadEvent::Finished {
                            let st = handle.state::<Snapper>();
                            let tx = st.loaded.lock().unwrap_or_else(|e| e.into_inner()).clone();
                            if let Some(tx) = tx {
                                let _ = tx.send(p.url().to_string());
                            }
                        }
                    })
                    .build()?
            }
        };
        let deadline = std::time::Instant::now() + LOAD_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let loaded = rx.recv_timeout(left).map_err(|_| anyhow!("{url} did not load in time"))?;
            // a redirect may finish first on another address; anything but the blank page counts
            if loaded != "about:blank" {
                break;
            }
        }
        std::thread::sleep(SETTLE);
        let shot = snap(&win);
        // stop the app running in the background until the next picture
        let _ = win.navigate(Url::parse("about:blank")?);
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(IDLE);
            let st = app.state::<Snapper>();
            let Ok(_one) = st.busy.try_lock() else { return }; // a capture is running: it schedules its own close
            let idle = st.last.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|t| t.elapsed() >= IDLE);
            if idle {
                close(&app);
            }
        });
        shot
    }
}

#[cfg(target_os = "macos")]
fn snap<R: Runtime>(win: &tauri::WebviewWindow<R>) -> Result<Vec<u8>> {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{MainThreadMarker, NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    let (tx, rx) = mpsc::channel::<Result<Vec<u8>>>();
    win.with_webview(move |pw| {
        // runs on the main thread
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(Err(anyhow!("snapshot off the main thread")));
            return;
        };
        let view: &WKWebView = unsafe { &*(pw.inner() as *const WKWebView) };
        let config = unsafe { WKSnapshotConfiguration::new(mtm) };
        unsafe {
            config.setSnapshotWidth(Some(&NSNumber::new_f64(SNAP_W)));
            config.setAfterScreenUpdates(true);
        }
        let done = RcBlock::new(move |img: *mut NSImage, err: *mut NSError| {
            let out = if img.is_null() {
                let why = unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string()).unwrap_or_default();
                Err(anyhow!("WebKit took no snapshot: {why}"))
            } else {
                let img = unsafe { &*img };
                img.TIFFRepresentation()
                    .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                    .and_then(|rep| unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &NSDictionary::new()) })
                    .map(|d| d.to_vec())
                    .ok_or_else(|| anyhow!("could not encode the snapshot"))
            };
            let _ = tx.send(out);
        });
        unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &done) };
    })?;
    rx.recv_timeout(Duration::from_secs(10)).map_err(|_| anyhow!("the snapshot never came back"))?
}

#[cfg(not(target_os = "macos"))]
fn snap<R: Runtime>(_win: &tauri::WebviewWindow<R>) -> Result<Vec<u8>> {
    bail!("board snapshots are only available on macOS")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_pages_are_pictured() {
        assert!(check_url("http://localhost:3000/").is_ok());
        assert!(check_url("https://example.com").is_ok());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("tauri://localhost").is_err());
        assert!(check_url("not a url").is_err());
    }
}
