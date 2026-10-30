//! Agent adapters: how each agent CLI is detected, launched and observed.
#![allow(dead_code)] // TODO(Task 8): remove once SessionManager consumes adapters
pub mod generic;

use crate::model::AgentKind;
use crate::platform::default_shell;
use crate::pty::LaunchSpec;
use crate::status::{StatusEvent, StatusPolicy};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use generic::CustomAdapter;

#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub installed: bool,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
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
}

pub struct AdapterRegistry {
    adapters: Vec<Arc<dyn AgentAdapter>>,
}

impl AdapterRegistry {
    pub fn new() -> Self {
        let adapters: Vec<Arc<dyn AgentAdapter>> = vec![
            // Task 6: register `Arc::new(claude::ClaudeAdapter)` here.
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

    #[test]
    #[ignore = "passes after Task 6 registers ClaudeAdapter"]
    fn registry_has_claude_and_custom() {
        let r = AdapterRegistry::new();
        assert!(r.get(AgentKind::Claude).is_some());
        assert!(r.get(AgentKind::Custom).is_some());
    }
}
