//! Debug-only localhost endpoint that evaluates JS in the main webview and returns the result.
//! Compiled out of release builds (see `lib.rs`).

use std::collections::HashMap;
use std::path::Path as FsPath;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

pub const EVAL_TIMEOUT: Duration = Duration::from_secs(10);

/// `Ok(value)` for a successful evaluation, `Err(value)` for a script error.
type Outcome = Result<serde_json::Value, serde_json::Value>;

/// Evaluations awaiting a result from the webview, keyed by id.
#[derive(Default)]
pub struct Driver {
    pending: Mutex<HashMap<u64, oneshot::Sender<Outcome>>>,
    next: AtomicU64,
}

impl Driver {
    /// Called by the `driver_result` command.
    pub fn resolve(&self, id: u64, ok: bool, value: serde_json::Value) {
        if let Some(tx) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
            let _ = tx.send(if ok { Ok(value) } else { Err(value) });
        }
    }
}

/// Starts evaluating `code` under `id`; the result arrives through `Driver::resolve`.
pub type Evaluator = Arc<dyn Fn(u64, String) + Send + Sync>;

#[derive(Clone)]
struct RouteState {
    token: String,
    driver: Arc<Driver>,
    eval: Evaluator,
    timeout: Duration,
}

fn token_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn error_body(status: StatusCode, msg: impl ToString) -> Response {
    (status, axum::Json(serde_json::json!({ "error": msg.to_string() }))).into_response()
}

async fn handle(State(st): State<RouteState>, Path(token): Path<String>, body: Bytes) -> Response {
    if !token_eq(&st.token, &token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(code) = String::from_utf8(body.to_vec()) else {
        return error_body(StatusCode::BAD_REQUEST, "body is not UTF-8");
    };
    let id = st.driver.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = oneshot::channel();
    st.driver.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
    (st.eval)(id, code);
    let outcome = tokio::time::timeout(st.timeout, rx).await;
    st.driver.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    match outcome {
        Ok(Ok(Ok(v))) => axum::Json(v).into_response(),
        Ok(Ok(Err(e))) => {
            let msg = e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string());
            error_body(StatusCode::INTERNAL_SERVER_ERROR, msg)
        }
        Ok(Err(_)) => error_body(StatusCode::INTERNAL_SERVER_ERROR, "driver dropped"),
        Err(_) => error_body(StatusCode::GATEWAY_TIMEOUT, "timed out"),
    }
}

pub fn router(token: String, driver: Arc<Driver>, eval: Evaluator, timeout: Duration) -> Router {
    Router::new()
        .route("/eval/{token}", post(handle))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .with_state(RouteState { token, driver, eval, timeout })
}

pub fn write_driver_file(dir: &FsPath, port: u16, token: &str) -> anyhow::Result<()> {
    use std::io::Write;
    let path = dir.join("driver.json");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut f = opts.open(&path)?;
    // `mode` applies only on create; tighten a file left from before.
    f.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    f.write_all(serde_json::json!({ "port": port, "token": token }).to_string().as_bytes())?;
    Ok(())
}

/// Binds 127.0.0.1 on a random port, publishes `driver.json`, and serves until the app exits.
pub fn start(app: AppHandle, data_dir: &FsPath) -> anyhow::Result<()> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("OS randomness unavailable");
    let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    let listener = tauri::async_runtime::block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))?;
    let port = listener.local_addr()?.port();
    write_driver_file(data_dir, port, &token)?;

    let driver = app.state::<Arc<Driver>>().inner().clone();
    let handle = app.clone();
    let eval: Evaluator = Arc::new(move |id, code| {
        let js = format!(
            "window.__cocDriver&&window.__cocDriver.run({id},{})",
            serde_json::to_string(&code).unwrap_or_else(|_| "\"\"".into())
        );
        if let Some(w) = handle.get_webview_window("main") {
            let _ = w.eval(js);
        }
    });
    let app = router(token, driver, eval, EVAL_TIMEOUT);
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    async fn serve(eval_for: impl FnOnce(Arc<Driver>) -> Evaluator, timeout: Duration) -> String {
        let driver = Arc::new(Driver::default());
        let eval = eval_for(driver.clone());
        let app = router("tok".into(), driver, eval, timeout);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://127.0.0.1:{port}")
    }

    fn resolving(ok: bool, value: serde_json::Value) -> impl FnOnce(Arc<Driver>) -> Evaluator {
        move |d| Arc::new(move |id, _| d.resolve(id, ok, value.clone()))
    }

    #[test]
    fn driver_json_is_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        write_driver_file(dir.path(), 4321, "abc").unwrap();
        let path = dir.path().join("driver.json");
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(v, serde_json::json!({"port": 4321, "token": "abc"}));
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[tokio::test]
    async fn bad_token_is_403() {
        let base = serve(resolving(true, 1.into()), Duration::from_secs(1)).await;
        let r = reqwest::Client::new().post(format!("{base}/eval/nope")).body("1").send().await.unwrap();
        assert_eq!(r.status(), 403);
    }

    #[tokio::test]
    async fn eval_round_trip() {
        let base = serve(resolving(true, 42.into()), Duration::from_secs(1)).await;
        let r = reqwest::Client::new().post(format!("{base}/eval/tok")).body("6*7").send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.text().await.unwrap(), "42");
    }

    #[tokio::test]
    async fn script_error_is_500() {
        let base = serve(resolving(false, "Error: x".into()), Duration::from_secs(1)).await;
        let r = reqwest::Client::new().post(format!("{base}/eval/tok")).body("x").send().await.unwrap();
        assert_eq!(r.status(), 500);
        assert_eq!(r.json::<serde_json::Value>().await.unwrap(), serde_json::json!({"error": "Error: x"}));
    }

    #[tokio::test]
    async fn eval_times_out_504() {
        let base = serve(|_| Arc::new(|_, _| {}), Duration::from_millis(200)).await;
        let r = reqwest::Client::new().post(format!("{base}/eval/tok")).body("1").send().await.unwrap();
        assert_eq!(r.status(), 504);
    }
}
