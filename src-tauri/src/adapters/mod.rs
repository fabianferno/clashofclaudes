//! Agent adapters: how each agent CLI is detected, launched and observed.
pub mod claude;
pub mod codex;
pub mod generic;
pub mod opencode;

use crate::model::AgentKind;
use crate::platform::default_shell;
use crate::pty::LaunchSpec;
use crate::status::{StatusEvent, StatusPolicy};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use claude::ClaudeAdapter;
pub use codex::CodexAdapter;
pub use generic::CustomAdapter;
pub use opencode::OpenCodeAdapter;

#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub installed: bool,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
}

/// How long a detection result is reused.
pub const DETECTION_TTL: Duration = Duration::from_secs(60);

/// Caches an adapter's `detect()` result (it runs the agent's `--version`) for `ttl`.
pub struct DetectionCache {
    ttl: Duration,
    probes: AtomicUsize,
    last: Mutex<Option<(Instant, Detection)>>,
}

impl DetectionCache {
    pub const fn new(ttl: Duration) -> Self {
        Self { ttl, probes: AtomicUsize::new(0), last: Mutex::new(None) }
    }

    /// The cached detection while it is younger than `ttl`; otherwise runs `probe` and caches it.
    /// Concurrent callers wait for one probe instead of each running their own.
    pub fn get(&self, now: Instant, probe: impl FnOnce() -> Detection) -> Detection {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, d)) = last.as_ref().filter(|(at, _)| now.saturating_duration_since(*at) < self.ttl) {
            return d.clone();
        }
        self.probes.fetch_add(1, Ordering::SeqCst);
        let d = probe();
        *last = Some((now, d.clone()));
        d
    }

    /// How many times `get` ran its probe.
    pub fn probes(&self) -> usize {
        self.probes.load(Ordering::SeqCst)
    }
}

pub struct LaunchRequest<'a> {
    pub session_id: &'a str,
    pub cwd: &'a Path,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub task: Option<&'a str>,
    pub hook_url: &'a str,
    pub data_dir: &'a Path,
    pub custom_command: Option<&'a str>,
}

/// A full-screen prompt the agent shows without any hook (e.g. a first-run trust menu).
/// `needle` is matched against `status::screen_text` of the recent output.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenPrompt {
    pub needle: &'static str,
    pub reason: &'static str,
    pub approve: &'static [u8],
    pub deny: &'static [u8],
}

pub trait AgentAdapter: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn label(&self) -> &'static str;
    fn detect(&self) -> Detection;
    fn models(&self) -> Vec<String>;
    fn efforts(&self) -> Vec<String>;
    fn launch(&self, req: &LaunchRequest) -> anyhow::Result<LaunchSpec>;
    fn policy(&self) -> StatusPolicy;
    fn parse_hook(&self, _body: &serde_json::Value) -> Vec<StatusEvent> {
        vec![]
    }
    fn approve_keys(&self) -> Option<&'static [u8]> {
        None
    }
    fn deny_keys(&self) -> Option<&'static [u8]> {
        None
    }
    fn screen_prompts(&self) -> Vec<ScreenPrompt> {
        vec![]
    }
}

pub struct AdapterRegistry {
    adapters: Vec<Arc<dyn AgentAdapter>>,
}

impl AdapterRegistry {
    pub fn new() -> Self {
        let adapters: Vec<Arc<dyn AgentAdapter>> = vec![
            Arc::new(ClaudeAdapter),
            Arc::new(CodexAdapter),
            Arc::new(OpenCodeAdapter),
            Arc::new(CustomAdapter),
        ];
        Self { adapters }
    }

    pub fn get(&self, kind: AgentKind) -> Option<Arc<dyn AgentAdapter>> {
        self.adapters.iter().find(|a| a.kind() == kind).cloned()
    }

    pub fn all(&self) -> Vec<Arc<dyn AgentAdapter>> {
        self.adapters.clone()
    }
}

impl Default for AdapterRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// The user's shell as a login shell in `cwd`; no adapter involved.
pub fn terminal_launch(cwd: &Path) -> LaunchSpec {
    LaunchSpec {
        program: default_shell(),
        args: vec!["-l".into()],
        env: vec![],
        cwd: cwd.to_path_buf(),
    }
}

/// Status policy for plain terminal sessions (no status inference).
pub fn terminal_policy() -> StatusPolicy {
    StatusPolicy {
        uses_hooks: false,
        finished_after_silence_secs: None,
        stuck_after_silence_secs: None,
        any_exit_ends: true,
        silence_finishes_until_first_event: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_uses_login_shell_in_cwd() {
        let s = terminal_launch(Path::new("/tmp"));
        assert_eq!(s.args, vec!["-l"]);
        assert_eq!(s.cwd, PathBuf::from("/tmp"));
    }

    fn det(v: &str) -> Detection {
        Detection { installed: true, path: None, version: Some(v.into()) }
    }

    #[test]
    fn detection_cache_expires_after_ttl() {
        let c = DetectionCache::new(Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(c.get(t0, || det("1")).version.as_deref(), Some("1"));
        assert_eq!(c.get(t0 + Duration::from_secs(59), || det("2")).version.as_deref(), Some("1"), "cached");
        assert_eq!(c.probes(), 1);
        assert_eq!(c.get(t0 + Duration::from_secs(60), || det("3")).version.as_deref(), Some("3"), "expired");
        assert_eq!(c.get(t0 + Duration::from_secs(61), || det("4")).version.as_deref(), Some("3"));
        assert_eq!(c.probes(), 2);
    }

    #[test]
    fn registry_has_claude_and_custom() {
        let r = AdapterRegistry::new();
        assert!(r.get(AgentKind::Codex).is_some());
        assert!(r.get(AgentKind::OpenCode).is_some());
        assert!(r.get(AgentKind::Claude).is_some());
        assert!(r.get(AgentKind::Custom).is_some());
    }
}
