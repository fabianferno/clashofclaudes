// Shared data model. Not every type is consumed yet; later tasks build on them.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Gemini,
    OpenCode,
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub created_at: i64,
    /// Recomputed by `persist::mark_missing` on every load; serialized so the
    /// frontend receives it over IPC.
    #[serde(default)]
    pub missing: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Builder {
    pub id: String,
    pub name: String,
    pub agent: AgentKind,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub custom_command: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppData {
    pub version: u32,
    pub workspaces: Vec<Workspace>,
    pub builders: Vec<Builder>,
}

impl Default for AppData {
    fn default() -> Self {
        Self { version: 1, workspaces: Vec::new(), builders: Vec::new() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SessionState {
    Starting,
    Working,
    NeedsYou { reason: String },
    Finished,
    Stuck { reason: String },
    Ended { exit_code: Option<i32> },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SessionKind {
    Agent { builder_id: String },
    Terminal,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub workspace_id: String,
    pub kind: SessionKind,
    pub task: Option<String>,
    pub state: SessionState,
    pub steps: u32,
    pub started_at: i64,
    pub last_output_at: i64,
    pub reached_finished: bool,
    pub worktree: Option<WorktreeInfo>,
    pub command_preview: String,
    /// A permission prompt is open and can be answered with approve/deny. False after an
    /// answer until the agent asks again.
    pub awaiting_decision: bool,
    /// Strictly increasing per session across every emitted update (first is 1); lets the
    /// frontend drop an update that arrives after a newer one.
    pub rev: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serde_shapes_are_stable() {
        let v = |x: &dyn Jsonable| x.json();
        assert_eq!(v(&SessionState::NeedsYou { reason: "x".into() }), json!({"kind":"needsYou","reason":"x"}));
        assert_eq!(v(&SessionState::Ended { exit_code: Some(3) }), json!({"kind":"ended","exitCode":3}));
        assert_eq!(v(&SessionKind::Agent { builder_id: "b".into() }), json!({"kind":"agent","builderId":"b"}));
        assert_eq!(v(&SessionKind::Terminal), json!({"kind":"terminal"}));
    }

    trait Jsonable { fn json(&self) -> serde_json::Value; }
    impl<T: Serialize> Jsonable for T { fn json(&self) -> serde_json::Value { serde_json::to_value(self).unwrap() } }
}
