//! Loopback HTTP server receiving Claude Code hook POSTs.
// TODO(Task 8): remove once SessionManager uses these items.
#![allow(dead_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    routing::post,
};

pub type HookSink = Arc<dyn Fn(String, serde_json::Value) + Send + Sync>;

type Tokens = Arc<Mutex<HashMap<String, String>>>;

#[derive(Clone)]
struct AppState {
    tokens: Tokens,
    sink: HookSink,
}

/// Loopback-only server; each session gets its own random token.
pub struct HookServer {
    addr: SocketAddr,
    tokens: Tokens,
    task: tokio::task::JoinHandle<()>,
}

fn token_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

async fn handle(
    State(st): State<AppState>,
    Path((session, token)): Path<(String, String)>,
    body: Bytes,
) -> StatusCode {
    let expected = st.tokens.lock().unwrap().get(&session).cloned();
    match expected {
        None => return StatusCode::NOT_FOUND,
        Some(t) if !token_eq(&t, &token) => return StatusCode::FORBIDDEN,
        Some(_) => {}
    }
    match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(v) => {
            (st.sink)(session, v);
            StatusCode::NO_CONTENT
        }
        Err(_) => StatusCode::BAD_REQUEST,
    }
}

impl HookServer {
    pub async fn start(sink: HookSink) -> anyhow::Result<HookServer> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let tokens: Tokens = Arc::default();
        let app = Router::new()
            .route("/hook/{session}/{token}", post(handle))
            .layer(DefaultBodyLimit::max(1024 * 1024))
            .with_state(AppState { tokens: tokens.clone(), sink });
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(HookServer { addr, tokens, task })
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// Registers (or re-registers, rotating the token) a session; returns its hook URL.
    pub fn register(&self, session_id: &str) -> String {
        let mut buf = [0u8; 16];
        getrandom::fill(&mut buf).expect("OS randomness unavailable");
        let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        self.tokens.lock().unwrap().insert(session_id.to_string(), token.clone());
        format!("http://127.0.0.1:{}/hook/{}/{}", self.port(), session_id, token)
    }

    pub fn unregister(&self, session_id: &str) {
        self.tokens.lock().unwrap().remove(session_id);
    }
}

impl Drop for HookServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    type Got = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

    async fn setup() -> (HookServer, Got) {
        let got: Got = Arc::new(Mutex::new(vec![]));
        let g = got.clone();
        let sink: HookSink = Arc::new(move |s, v| g.lock().unwrap().push((s, v)));
        (HookServer::start(sink).await.unwrap(), got)
    }

    #[tokio::test]
    async fn valid_post_reaches_sink() {
        let (srv, got) = setup().await;
        let url = srv.register("s1");
        let body = serde_json::json!({"hook_event_name":"Stop"});
        let r = reqwest::Client::new().post(&url).json(&body).send().await.unwrap();
        assert_eq!(r.status(), 204);
        assert_eq!(*got.lock().unwrap(), vec![("s1".to_string(), body)]);
    }

    #[tokio::test]
    async fn wrong_token_is_403() {
        let (srv, got) = setup().await;
        srv.register("s1");
        let u = format!("http://127.0.0.1:{}/hook/s1/deadbeef", srv.port());
        let r = reqwest::Client::new().post(&u).body("{}").send().await.unwrap();
        assert_eq!(r.status(), 403);
        assert!(got.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unknown_session_is_404() {
        let (srv, _) = setup().await;
        let u = format!("http://127.0.0.1:{}/hook/zzz/abc", srv.port());
        let r = reqwest::Client::new().post(&u).body("{}").send().await.unwrap();
        assert_eq!(r.status(), 404);
    }

    #[tokio::test]
    async fn unregistered_session_is_404() {
        let (srv, got) = setup().await;
        let url = srv.register("s1");
        srv.unregister("s1");
        let r = reqwest::Client::new().post(&url).body("{}").send().await.unwrap();
        assert_eq!(r.status(), 404);
        assert!(got.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn invalid_json_is_400() {
        let (srv, got) = setup().await;
        let url = srv.register("s1");
        let r = reqwest::Client::new().post(&url).body("not json").send().await.unwrap();
        assert_eq!(r.status(), 400);
        assert!(got.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn binds_loopback_only() {
        let (srv, _) = setup().await;
        assert!(srv.addr.ip().is_loopback());
        assert_eq!(srv.register("a").matches("127.0.0.1").count(), 1);
    }
}
