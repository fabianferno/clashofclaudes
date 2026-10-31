//! Agent adapters: how each agent CLI is detected, launched and observed.
pub mod claude;
pub mod codex;
pub mod gemini;
pub mod generic;
pub mod opencode;

use crate::model::AgentKind;
use crate::platform::{default_shell, output_within, which, RunOutcome};
use crate::pty::LaunchSpec;
use crate::status::{StatusEvent, StatusPolicy};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use claude::ClaudeAdapter;
pub use codex::CodexAdapter;
pub use gemini::GeminiAdapter;
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

    /// Drops the cached result so the next `get` probes again ("Re-check").
    pub fn invalidate(&self) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// How many times `get` ran its probe.
    pub fn probes(&self) -> usize {
        self.probes.load(Ordering::SeqCst)
    }
}

/// Longest a `--version` probe may run; a hung one reports the agent as not installed.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Looks `program` up on PATH and probes it (see `probe_path`).
pub(crate) fn probe_program(program: &str, parse: impl Fn(&str) -> Option<String>) -> Detection {
    match which(program) {
        Some(path) => probe_path(path, PROBE_TIMEOUT, parse),
        None => Detection { installed: false, path: None, version: None },
    }
}

/// Runs `<path> --version` for at most `timeout`; `parse` reads the version from stdout. A
/// failing `--version` still counts as installed (version unknown); one that hangs past the
/// timeout is killed, logged and reported as not installed.
pub(crate) fn probe_path(path: PathBuf, timeout: Duration, parse: impl Fn(&str) -> Option<String>) -> Detection {
    let mut cmd = std::process::Command::new(&path);
    cmd.arg("--version");
    match output_within(cmd, timeout) {
        RunOutcome::Exited { success: true, stdout } => {
            let version = parse(&String::from_utf8_lossy(&stdout));
            Detection { installed: true, path: Some(path), version }
        }
        RunOutcome::Exited { .. } | RunOutcome::SpawnFailed => Detection { installed: true, path: Some(path), version: None },
        RunOutcome::TimedOut => {
            eprintln!("{} --version did not finish within {timeout:?}; reporting it as not installed", path.display());
            Detection { installed: false, path: None, version: None }
        }
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
    /// Forgets any cached detection so the next `detect` probes again. Adapters without a cache need nothing.
    fn invalidate_detection(&self) {}
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
            Arc::new(GeminiAdapter),
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
        silence_needs_you_until_first_event: false,
    }
}

/// Test support: proves an adapter writes nothing under the user's home or config dirs.
#[cfg(test)]
pub(crate) mod fake_home {
    /// Set in the child test process; only there do the `*_in_fake_home` tests do anything.
    pub const CHILD_FLAG: &str = "COC_FAKE_HOME_CHILD";

    /// True in the child process started by `run`.
    pub fn is_child() -> bool {
        std::env::var_os(CHILD_FLAG).is_some()
    }

    /// Runs the ignored test `name` in a child copy of this test binary whose `HOME`,
    /// `XDG_CONFIG_HOME` and `CODEX_HOME` point into an empty temp dir (the env is injected into
    /// the child only; this process's env is never changed), then asserts the child passed and
    /// that nothing at all was created in that dir.
    pub fn run(name: &str) {
        let home = tempfile::tempdir().unwrap();
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([name, "--exact", "--ignored", "--test-threads=1"])
            .env("HOME", home.path())
            .env("XDG_CONFIG_HOME", home.path().join(".config"))
            .env("CODEX_HOME", home.path().join(".codex"))
            .env_remove("GEMINI_CLI_SYSTEM_SETTINGS_PATH")
            .env_remove("OPENCODE_CONFIG_DIR")
            .env(CHILD_FLAG, "1")
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{name} failed in the fake home:\n{text}\n{}", String::from_utf8_lossy(&out.stderr));
        assert!(text.contains("test result: ok. 1 passed"), "the child did not run {name}:\n{text}");
        let left: Vec<_> = std::fs::read_dir(home.path()).unwrap().map(|e| e.unwrap().path()).collect();
        assert!(left.is_empty(), "{name} created files in HOME: {left:?}");
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
    fn invalidate_forces_a_new_probe_within_ttl() {
        let c = DetectionCache::new(Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(c.get(t0, || det("1")).version.as_deref(), Some("1"));
        c.invalidate();
        assert_eq!(c.get(t0 + Duration::from_secs(1), || det("2")).version.as_deref(), Some("2"), "force skipped the cache");
        assert_eq!(c.probes(), 2);
    }

    fn script(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join("fake-agent");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn probe_reads_version_and_survives_a_hung_cli() {
        let d = tempfile::tempdir().unwrap();
        let first = |s: &str| s.lines().next().map(|l| l.trim().to_string());
        let ok = probe_path(script(d.path(), "echo '9.8.7 (x)'"), PROBE_TIMEOUT, first);
        assert_eq!((ok.installed, ok.version.as_deref()), (true, Some("9.8.7 (x)")));
        let failing = probe_path(script(d.path(), "exit 3"), PROBE_TIMEOUT, first);
        assert_eq!((failing.installed, failing.version), (true, None), "installed, version unknown");
        let t = Instant::now();
        let hung = probe_path(script(d.path(), "sleep 30"), Duration::from_millis(200), first);
        assert!(!hung.installed && hung.path.is_none());
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        assert!(!probe_program("definitely-not-a-real-agent-xyz", first).installed);
    }

    #[test]
    fn registry_has_claude_and_custom() {
        let r = AdapterRegistry::new();
        assert!(r.get(AgentKind::Codex).is_some());
        assert!(r.get(AgentKind::OpenCode).is_some());
        assert!(r.get(AgentKind::Gemini).is_some());
        assert!(r.get(AgentKind::Claude).is_some());
        assert!(r.get(AgentKind::Custom).is_some());
    }
}
