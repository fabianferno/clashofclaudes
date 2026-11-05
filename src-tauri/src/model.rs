// Shared data model. Not every type is consumed yet; later tasks build on them.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    /// Antigravity CLI. Builders saved while this was Gemini CLI load as Antigravity.
    #[serde(alias = "gemini")]
    Antigravity,
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
    /// The house's roof colour (`#rrggbb`) the owner chose; None picks one from the id.
    #[serde(default)]
    pub color: Option<String>,
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
    /// Top-left tiles of the resource collectors the owner has dragged; the rest stand in their default slots.
    #[serde(default)]
    pub collector_spots: BTreeMap<AgentKind, Tile>,
    /// Tasks written down for the workspaces and not started yet (the Kanban's To Do), oldest first.
    #[serde(default)]
    pub todos: Vec<Todo>,
}

/// A task the owner wrote down for a workspace; starting it hands it to a builder as a session.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub workspace_id: String,
    pub text: String,
    /// Attachment names (see `attachments`); handed to the session that starts it.
    #[serde(default)]
    pub images: Vec<String>,
    pub created_at: i64,
}

/// User preferences. `updates_enabled` gates the updater, the app's only network access.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_true")]
    pub updates_enabled: bool,
    /// Notify when a builder needs you (while the window is in the background).
    #[serde(default = "default_true")]
    pub notify_needs_you: bool,
    /// Notify when a builder finishes (while the window is in the background).
    #[serde(default = "default_true")]
    pub notify_finished: bool,
    /// The Dock icon counts the sessions that need you or finished.
    #[serde(default = "default_true")]
    pub dock_badge: bool,
    /// What the owner asked to be called: the plate over the Town Hall reads "<name>'s Town Hall".
    #[serde(default)]
    pub player_name: Option<String>,
    /// The first-run welcome (and its tour) has been completed or skipped.
    #[serde(default)]
    pub onboarded: bool,
    /// Structures placed before they kept their padding have been spaced out once (see `tidySpots`).
    #[serde(default)]
    pub spots_tidied: bool,
    /// The spacing rules the village was last tidied to (`SPOTS_TIDY` in settings.ts); newer rules tidy it again.
    #[serde(default)]
    pub spots_tidy: u32,
    /// The owner chose to share anonymous usage counts (`usage.rs`). Off until they turn it on.
    #[serde(default)]
    pub share_usage: bool,
    /// A random id for this install's usage counts: made when sharing is turned on, dropped when it is turned off.
    #[serde(default)]
    pub install_id: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Longest name kept, in characters (it has to fit on the Town Hall's plate).
pub const PLAYER_NAME_MAX: usize = 24;

impl Settings {
    /// The name trimmed and capped at PLAYER_NAME_MAX characters; blank becomes None.
    pub fn normalized(mut self) -> Self {
        self.player_name = self
            .player_name
            .map(|n| n.trim().chars().take(PLAYER_NAME_MAX).collect::<String>().trim_end().to_string())
            .filter(|n| !n.is_empty());
        // a fresh id each time sharing is turned on; none while it is off
        self.install_id = if self.share_usage { self.install_id.filter(|i| !i.trim().is_empty()).or_else(|| Some(uuid::Uuid::new_v4().to_string())) } else { None };
        self
    }
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    #[test]
    fn sharing_usage_makes_an_install_id_keeps_it_and_turning_it_off_drops_it() {
        let on = Settings { share_usage: true, ..Settings::default() }.normalized();
        let id = on.install_id.clone().expect("an id once sharing is on");
        assert_eq!(id.len(), 36);
        assert_eq!(on.clone().normalized().install_id, Some(id), "kept while on");
        assert_eq!(Settings { share_usage: false, ..on }.normalized().install_id, None);
        assert_eq!(Settings::default().normalized().install_id, None, "off by default");
    }

    #[test]
    fn player_name_is_trimmed_capped_and_blank_dropped() {
        let named = |n: &str| Settings { player_name: Some(n.into()), ..Settings::default() }.normalized().player_name;
        assert_eq!(named("  Fabian "), Some("Fabian".into()));
        assert_eq!(named("   "), None);
        assert_eq!(named(&"é".repeat(40)).map(|n| n.chars().count()), Some(PLAYER_NAME_MAX));
        assert_eq!(Settings::default().normalized().player_name, None);
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            updates_enabled: true,
            notify_needs_you: true,
            notify_finished: true,
            dock_badge: true,
            player_name: None,
            onboarded: false,
            spots_tidied: false,
            spots_tidy: 0,
            share_usage: false,
            install_id: None,
        }
    }
}

impl Default for AppData {
    fn default() -> Self {
        Self {
            version: 2,
            workspaces: Vec::new(),
            builders: Vec::new(),
            stats: Stats::default(),
            settings: Settings::default(),
            collector_spots: BTreeMap::new(),
            todos: Vec::new(),
        }
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
    /// Terminals: a command (not the idle shell) is running in the foreground. Always false for agents.
    #[serde(default)]
    pub busy: bool,
    /// Strictly increasing per session across every emitted update (first is 1); lets the
    /// frontend drop an update that arrives after a newer one.
    pub rev: u64,
    /// Where the session's builder stands in the village.
    pub spot: Option<Tile>,
    /// Brought back after the app quit or restarted (state `Ended`, no process):
    /// `resume_session` starts it again, on the agent's own conversation when it has one.
    #[serde(default)]
    pub paused: bool,
    /// The agent's own subagents running right now (Claude's Agent tool): drawn as minions by its builder.
    #[serde(default)]
    pub subagents: Vec<Subagent>,
}

/// A subagent the session's agent spawned, from its start hook until its stop hook.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub id: String,
    /// The agent's own name for its kind (`general-purpose`, `Explore`, ...).
    pub agent_type: Option<String>,
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
