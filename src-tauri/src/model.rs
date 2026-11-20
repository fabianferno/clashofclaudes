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
    /// Grok Build (xAI).
    Grok,
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
    /// The owner's notepad for this workspace: ideas and reminders, apart from the To Do. Kept here only.
    #[serde(default)]
    pub notes: String,
    /// Its agent sessions are published to the team's board (while Settings › Team is on).
    #[serde(default)]
    pub board_shared: bool,
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
    /// Where the mini village was last left, and whether it was open (`mini.rs`).
    #[serde(default)]
    pub mini_window: Option<MiniWindow>,
}

/// The mini village's window: its place and size in screen points, and whether it is open (it
/// comes back on the next launch when it was).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MiniWindow {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub open: bool,
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
    /// Starts on its own once `builder_id` is free (and the running-session limit allows).
    #[serde(default)]
    pub auto: bool,
    /// The builder it goes to (needed for `auto`; the Kanban's picker otherwise).
    #[serde(default)]
    pub builder_id: Option<String>,
    /// Starts in its own git worktree, on a new branch, so its changes wait apart for review.
    #[serde(default)]
    pub worktree: bool,
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
    /// The Dock icon counts the sessions waiting on the owner (their queue).
    #[serde(default = "default_true")]
    pub dock_badge: bool,
    /// ⌃⌥⌘J from any app opens the owner's queue (`shortcut.rs`).
    #[serde(default = "default_true")]
    pub global_shortcut: bool,
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
    /// At most this many agent sessions at work at once (auto-started To Dos wait; + New session
    /// suggests the To Do). None: no limit.
    #[serde(default)]
    pub session_limit: Option<u32>,
    /// The trackpad haptic as the pointer comes over a house or the Town Hall (`platform::Haptic` names).
    #[serde(default = "default_haptic_hover")]
    pub haptic_hover: String,
    /// The trackpad haptic as a held builder comes over a workspace it can be dropped on.
    #[serde(default = "default_haptic_drop")]
    pub haptic_drop: String,
    /// Auto-started To Dos wait while their agent has this percent or less left of any limit; 0: never.
    #[serde(default = "default_elixir_reserve")]
    pub elixir_reserve: u32,
    /// A To Do held for elixir goes to a free builder whose agent has some.
    #[serde(default)]
    pub elixir_stand_in: bool,
    /// The village plays sounds (`sounds.rs`).
    #[serde(default = "default_true")]
    pub sounds_on: bool,
    /// Sound volume, 0-100.
    #[serde(default = "default_sound_volume")]
    pub sound_volume: u32,
    /// The sound file each moment plays (`sounds::MOMENTS`); "" is silent.
    #[serde(default = "crate::sounds::default_sounds")]
    pub sounds: BTreeMap<String, String>,
    /// Day and night over the village, from the owner's clock (drawn by the frontend).
    #[serde(default = "default_true")]
    pub day_night: bool,
    /// A quiet village ambience under the sounds, while the window is open (played by the frontend).
    #[serde(default)]
    pub ambience_on: bool,
    /// Ambience volume, 0-100, under the sound volume.
    #[serde(default = "default_ambience_volume")]
    pub ambience_volume: u32,
    /// The village on the owner's Vercel Board (`board/`). Off until they turn it on.
    #[serde(default)]
    pub board: BoardSettings,
}

/// Settings › Team (Vercel Board): what the app writes to the team's board, through the `vercel` CLI.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BoardSettings {
    pub enabled: bool,
    /// The Vercel team's slug; None is the login's default team.
    pub team: Option<String>,
    /// The board's name on that team.
    pub name: String,
    /// Tasks, tool calls, the agent's last reply and changed file names are written, not only states.
    pub share_details: bool,
    /// Sessions in shared workspaces get `BOARD_PROFILE` and `BOARD_URL`, so their own posts carry the builder's name.
    pub session_env: bool,
    /// A workspace added later starts shared.
    pub share_new: bool,
    /// A random id for this install's village (`coc.host`), made when the feature is first turned on.
    pub host_id: Option<String>,
    /// The phone remote: a web app the team deploys, whose paired phones answer builders.
    pub remote: RemoteSettings,
    /// Who may see this village on the board: closed to the team or not, and the people invited.
    pub access: AccessSettings,
}

/// Settings › Team: Private village and People. What the owner set; the board's grants are what
/// counts, and Settings shows those.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AccessSettings {
    /// The owner wants the village closed to everyone they did not invite.
    pub private: bool,
    /// The grants this Mac made to close it (their ids on the board).
    pub grants: Vec<String>,
    pub invites: Vec<Invite>,
    /// The default (private) was applied once; after that the switch is the owner's.
    pub asked: bool,
    /// What the board said when it would not let this login close the village (not a team owner).
    pub refused: Option<String>,
}

/// One invited teammate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    /// Their Vercel login's email.
    pub email: String,
    /// What the owner wants them to be. Acting needs their Mac paired as well; until then they see only.
    pub level: Level,
    /// Workspace ids they may see; None is every shared workspace.
    #[serde(default)]
    pub workspaces: Option<Vec<String>>,
    /// Their grant's id on the board.
    #[serde(default)]
    pub grant: Option<String>,
    /// Their Vercel user id, once the board has named it.
    #[serde(default)]
    pub user_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// Sees builders and what they wait for.
    Visitor,
    /// Also answers questions and sends follow-ups.
    Helper,
    /// Also allows and denies tool calls.
    Trusted,
}

/// Settings › Team › Phone remote. The paired phones themselves are in the Keychain.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteSettings {
    /// The Mac listens to the board and takes paired phones' actions.
    pub enabled: bool,
    /// Where the team's remote is deployed.
    pub url: Option<String>,
    /// Production deployments of the remote this Mac made or the owner trusted.
    pub trusted: Vec<String>,
    /// Why actions are refused for now (the remote was redeployed by someone else).
    pub paused: Option<String>,
}

impl Default for BoardSettings {
    fn default() -> Self {
        Self { enabled: false, team: None, name: "village".into(), share_details: true, session_env: true, share_new: false, host_id: None, remote: RemoteSettings::default(), access: AccessSettings::default() }
    }
}

fn default_elixir_reserve() -> u32 {
    10
}
fn default_sound_volume() -> u32 {
    70
}

fn default_ambience_volume() -> u32 {
    50
}

fn default_haptic_hover() -> String {
    "alignment".into()
}
fn default_haptic_drop() -> String {
    "levelChange".into()
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
        self.session_limit = self.session_limit.filter(|n| *n > 0).map(|n| n.min(32));
        if crate::platform::Haptic::parse(&self.haptic_hover).is_none() {
            self.haptic_hover = default_haptic_hover();
        }
        if crate::platform::Haptic::parse(&self.haptic_drop).is_none() {
            self.haptic_drop = default_haptic_drop();
        }
        self.elixir_reserve = self.elixir_reserve.min(50);
        self.sound_volume = self.sound_volume.min(100);
        self.ambience_volume = self.ambience_volume.min(100);
        self.sounds = crate::sounds::normalized(std::mem::take(&mut self.sounds));
        self.install_id = if self.share_usage { self.install_id.filter(|i| !i.trim().is_empty()).or_else(|| Some(uuid::Uuid::new_v4().to_string())) } else { None };
        self
    }
}

#[cfg(test)]
mod settings_tests {
    #[test]
    fn day_night_is_on_and_ambience_off_for_saves_from_before_them() {
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert!(old.day_night);
        assert!(!old.ambience_on);
        assert_eq!(old.ambience_volume, 50);
        let set: Settings = serde_json::from_str(r#"{"dayNight":false,"ambienceOn":true,"ambienceVolume":250}"#).unwrap();
        let set = set.normalized();
        assert!(!set.day_night);
        assert!(set.ambience_on);
        assert_eq!(set.ambience_volume, 100);
    }

    #[test]
    fn global_shortcut_is_on_for_saves_from_before_it_existed() {
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert!(old.global_shortcut);
        let off: Settings = serde_json::from_str(r#"{"globalShortcut":false}"#).unwrap();
        assert!(!off.global_shortcut);
        assert!(Settings::default().global_shortcut);
    }

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
    fn haptics_default_light_on_hover_and_firm_on_drop_and_unknown_names_reset() {
        let d = Settings::default();
        assert_eq!((d.haptic_hover.as_str(), d.haptic_drop.as_str()), ("alignment", "levelChange"));
        let odd = Settings { haptic_hover: "buzz".into(), haptic_drop: "double".into(), ..Settings::default() }.normalized();
        assert_eq!((odd.haptic_hover.as_str(), odd.haptic_drop.as_str()), ("alignment", "double"));
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(old.haptic_hover, "alignment", "saved before the setting existed");
    }

    #[test]
    fn elixir_and_sounds_default_and_clamp() {
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!((old.elixir_reserve, old.elixir_stand_in, old.sounds_on, old.sound_volume), (10, false, true, 70));
        assert_eq!(old.sounds, crate::sounds::default_sounds(), "saved before sounds existed");
        let odd = Settings { elixir_reserve: 99, sound_volume: 400, ..Settings::default() }.normalized();
        assert_eq!((odd.elixir_reserve, odd.sound_volume), (50, 100));
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
            global_shortcut: true,
            player_name: None,
            onboarded: false,
            spots_tidied: false,
            spots_tidy: 0,
            share_usage: false,
            install_id: None,
            session_limit: None,
            haptic_hover: default_haptic_hover(),
            haptic_drop: default_haptic_drop(),
            elixir_reserve: default_elixir_reserve(),
            elixir_stand_in: false,
            sounds_on: true,
            sound_volume: default_sound_volume(),
            sounds: crate::sounds::default_sounds(),
            day_night: true,
            ambience_on: false,
            ambience_volume: default_ambience_volume(),
            board: BoardSettings::default(),
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
            mini_window: None,
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
    /// The agent's short name for the conversation, from its terminal title (Claude Code, Grok
    /// Build); shown in place of the task's start.
    #[serde(default)]
    pub title: Option<String>,
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
    /// When `state` last changed (ms): how long it has waited on the owner.
    #[serde(default)]
    pub state_since: i64,
    /// The agent's last reply (end of its latest turn), for the briefing; capped in length.
    #[serde(default)]
    pub last_message: Option<String>,
    /// The tool call the agent is about to make (`Bash: npm test`), while it waits on it.
    #[serde(default)]
    pub asking: Option<String>,
    /// The questions it asks with a picker (Claude's AskUserQuestion), while the picker is open:
    /// the briefing offers their options as buttons.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<AskQuestion>,
    /// The owner put it aside (out of the queue) with this note (maybe empty), until its state changes.
    #[serde(default)]
    pub parked: Option<String>,
}

/// One question of an open picker, with its options in the order the agent's picker numbers them.
/// No options: the agent named only the question (a terminal status report), answered there.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestion {
    pub question: String,
    /// A short label for the question (`Auth method`).
    #[serde(default)]
    pub header: Option<String>,
    pub options: Vec<AskOption>,
    /// Several options may be picked (checkboxes) instead of one.
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AskOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
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
    fn settings_without_board_load_with_defaults() {
        let s: Settings = serde_json::from_value(json!({"updatesEnabled": false})).unwrap();
        assert!(!s.board.enabled);
        assert_eq!(s.board.name, "village");
        assert!(s.board.share_details);
        assert!(s.board.session_env);
        assert!(!s.board.share_new);
        assert_eq!(s.board.team, None);
        assert_eq!(s.board.host_id, None);
        assert_eq!(Settings::default().board, s.board);
    }

    #[test]
    fn workspace_without_board_shared_loads_false() {
        let w: Workspace = serde_json::from_value(json!({"id":"w","name":"n","path":"/p","createdAt":1})).unwrap();
        assert!(!w.board_shared);
    }

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
