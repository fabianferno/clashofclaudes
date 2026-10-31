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

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    pub x: i32,
    pub y: i32,
}

/// A workspace's walled compound: the interior in tiles, `(x0, y0)` the top-left interior tile.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Compound {
    pub x0: i32,
    pub y0: i32,
    pub w: u32,
    pub h: u32,
    pub house: Tile,
}

/// Village-wide stats. `recent_ships` holds ship times in ms, pruned to the last 48 h on save.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    #[serde(default)]
    pub shipped_total: u32,
    #[serde(default)]
    pub recent_ships: Vec<i64>,
}

fn one() -> u32 {
    1
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
    /// House level, starting at 1.
    #[serde(default = "one")]
    pub level: u32,
    /// XP progress within the current level.
    #[serde(default)]
    pub xp: u32,
    #[serde(default)]
    pub compound: Option<Compound>,
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
    #[serde(default)]
    pub stats: Stats,
    #[serde(default)]
    pub settings: Settings,
}

/// User preferences. `updates_enabled` gates the updater, the app's only network access.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_true")]
    pub updates_enabled: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self { updates_enabled: true }
    }
}

impl Default for AppData {
    fn default() -> Self {
        Self { version: 2, workspaces: Vec::new(), builders: Vec::new(), stats: Stats::default(), settings: Settings::default() }
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
    /// Where the session's builder stands in the village. Never persisted: sessions do not
    /// outlive the app.
    pub spot: Option<Tile>,
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
