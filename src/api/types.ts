export type AgentKind = 'claude' | 'codex' | 'antigravity' | 'opencode' | 'grok' | 'custom';

export interface Tile {
  x: number;
  y: number;
}

/** Walled interior in tiles; (x0, y0) is the top-left interior tile. */
export interface Compound {
  x0: number;
  y0: number;
  w: number;
  h: number;
  house: Tile;
}

export interface Stats {
  shippedTotal: number;
  /** Ship times in ms, last 48 h. */
  recentShips: number[];
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  missing: boolean;
  level: number;
  /** XP progress within the current level. */
  xp: number;
  compound: Compound | null;
  /** The roof colour (#rrggbb) the owner chose; null picks one from the id. */
  color?: string | null;
}

export interface Builder {
  id: string;
  name: string;
  agent: AgentKind;
  model: string | null;
  effort: string | null;
  customCommand: string | null;
}

export type SessionState =
  | { kind: 'starting' }
  | { kind: 'working' }
  | { kind: 'needsYou'; reason: string }
  | { kind: 'finished' }
  | { kind: 'stuck'; reason: string }
  | { kind: 'ended'; exitCode: number | null };

export type SessionKind = { kind: 'agent'; builderId: string } | { kind: 'terminal' };

/** A closed agent session that can be opened again on its conversation (`history.json`). */
export interface HistoryEntry {
  id: string;
  workspaceId: string;
  builderId: string;
  agent: AgentKind;
  builderName: string;
  task: string | null;
  title: string | null;
  lastMessage: string | null;
  conversation: string;
  startedAt: number;
  closedAt: number;
  steps: number;
  reachedFinished: boolean;
  worktree: WorktreeInfo | null;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
}

export interface SessionInfo {
  id: string;
  workspaceId: string;
  kind: SessionKind;
  task: string | null;
  /** The agent's short name for the conversation (its terminal title), once it has named it. */
  title?: string | null;
  state: SessionState;
  steps: number;
  startedAt: number;
  lastOutputAt: number;
  reachedFinished: boolean;
  worktree: WorktreeInfo | null;
  commandPreview: string;
  /** A permission prompt can be answered with approve/deny right now. */
  awaitingDecision: boolean;
  /** Terminals: a command (not the idle shell) is running in the foreground. Always false for agents. */
  busy: boolean;
  /** Strictly increasing per session; the store drops updates older than the one it holds. */
  rev: number;
  /** Where the builder stands in the village. */
  spot: Tile | null;
  /** Brought back after the app quit or restarted (state `ended`, no process); `resumeSession` starts it again. */
  paused?: boolean;
  /** The agent's own subagents running right now, drawn as minions by its builder. */
  subagents?: Subagent[];
  /** When `state` last changed (ms): how long it has waited on the owner. */
  stateSince?: number;
  /** The agent's last reply (the end of its latest turn), when the agent reports it. */
  lastMessage?: string | null;
  /** The tool call it is about to make (`Bash: npm test`), while it waits on it. */
  asking?: string | null;
  /** The questions of its open picker (Claude's AskUserQuestion), offered as buttons; absent when none. */
  questions?: AskQuestion[];
  /** Put aside out of the owner's queue, with this note (maybe empty), until its state changes. */
  parked?: string | null;
}

/** One question of an agent's open picker; options in the order its picker numbers them. */
export interface AskQuestion {
  question: string;
  /** A short label for the question (`Auth method`). */
  header?: string | null;
  options: { label: string; description?: string | null }[];
  /** Several options may be picked instead of one. */
  multiSelect: boolean;
}

/** A subagent a session's agent spawned (Claude's Agent tool), from its start until its stop. */
export interface Subagent {
  id: string;
  /** The agent's name for its kind (`general-purpose`, `Explore`, ...). */
  agentType: string | null;
}

/** A task written down for a workspace and not started yet (the Kanban's To Do). */
export interface Todo {
  id: string;
  workspaceId: string;
  /** May be empty when the task is only images. */
  text: string;
  /** Attachment names, handed to the session that starts it. */
  images?: string[];
  createdAt: number;
  /** Starts on its own once `builderId` is free (and the running-session limit allows). */
  auto?: boolean;
  /** The builder it goes to (needed for `auto`). */
  builderId?: string | null;
  /** Starts in its own git worktree, on a new branch, so its changes wait apart for review. */
  worktree?: boolean;
}

export interface ListState {
  workspaces: Workspace[];
  builders: Builder[];
  sessions: SessionInfo[];
  stats: Stats;
  /** Collectors the owner has dragged (top-left tiles). */
  collectorSpots?: Partial<Record<AgentKind, Tile>>;
  todos?: Todo[];
}

/** A local web app running in a workspace (see src-tauri/src/apps.rs): it gets a board with a live preview. */
export interface AppPreview {
  workspaceId: string;
  port: number;
  url: string;
  /** The page's `<title>`, if it has one. */
  title: string | null;
  /** False when the page forbids framing, so the board shows no live preview. */
  frameable: boolean;
  /** The listening process (`node`, `python3`, ...). */
  command: string;
}

/** One rationed window an agent reports (see src-tauri/src/quota.rs). */
export interface QuotaWindow {
  id: string;
  label: string;
  /** Model group the window applies to (Antigravity). */
  group: string | null;
  /** Percent left, 0-100. */
  leftPct: number;
  /** Epoch ms; past means the window has refilled. */
  resetsAt: number | null;
  windowMins: number | null;
}

/** The latest quota reading for one agent. */
export interface AgentQuota {
  agent: AgentKind;
  windows: QuotaWindow[];
  updatedAt: number;
  source: string;
}

/** Who an agent is signed in as (see src-tauri/src/account.rs). */
export interface AgentAccount {
  agent: AgentKind | null;
  signedIn: boolean;
  email: string | null;
  /** Readable plan name, e.g. "Max 20x". */
  plan: string | null;
  /** How it signs in when that is not an account ("API key"). */
  detail: string | null;
}

/** A model as the picker offers it: the id passed to the agent, its name, and the efforts it takes (empty: the agent's). */
export interface ModelChoice {
  id: string;
  name: string;
  efforts: string[];
}

export interface AgentInfo {
  kind: AgentKind;
  label: string;
  installed: boolean;
  version: string | null;
  models: string[];
  /** The models with display names and their own efforts (Codex reads them from its live catalog). */
  modelChoices?: ModelChoice[];
  efforts: string[];
  canApprove: boolean;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

export interface Review {
  isGit: boolean;
  branch: string | null;
  files: FileChange[];
  untracked: string[];
  otherSessionsActive: boolean;
}

export interface CloseOutcome {
  earnedXp: boolean;
  xpGained: number;
  levelBefore: number;
  levelAfter: number;
  workspaceId: string;
  /** An agent was closed before it finished. */
  unfinished: boolean;
  /** An agent was closed while Stuck. */
  stuck: boolean;
  /** The owner discarded it (no XP). */
  discarded?: boolean;
}

export interface ConfirmQuit {
  live: number;
  /** The confirmation is for an update restart, not a quit. */
  restart?: boolean;
}

export interface Settings {
  updatesEnabled: boolean;
  /** Notify when a builder needs you, while the window is in the background. */
  notifyNeedsYou: boolean;
  /** Notify when a builder finishes, while the window is in the background. */
  notifyFinished: boolean;
  /** The Dock icon counts the sessions waiting on you (your queue). */
  dockBadge: boolean;
  /** ⌃⌥⌘J from any app opens the queue. On until turned off. */
  globalShortcut?: boolean;
  /** What the owner asked to be called (the Town Hall's plate); null until given. */
  playerName?: string | null;
  /** The first-run welcome (and its tour) was completed or skipped. */
  onboarded?: boolean;
  /** Structures placed before they kept their padding have been spaced out once. */
  spotsTidied?: boolean;
  /** The spacing rules the village was last tidied to (`SPOTS_TIDY`). */
  spotsTidy?: number;
  /** The owner shares anonymous usage counts (see src-tauri/src/usage.rs). Off until turned on. */
  shareUsage?: boolean;
  /** This install's random usage id, made by the backend while sharing is on. */
  installId?: string | null;
  /** At most this many agent sessions at work at once; null: no limit. */
  sessionLimit?: number | null;
  /** The trackpad haptic as the pointer comes over a house or the Town Hall. */
  hapticHover?: HapticKind;
  /** The trackpad haptic as a held builder comes over a workspace it can be dropped on. */
  hapticDrop?: HapticKind;
  /** Auto-started To Dos wait while their agent has this percent or less left of any limit; 0: never. */
  elixirReserve?: number;
  /** A To Do held for elixir goes to a free builder whose agent has some. */
  elixirStandIn?: boolean;
  /** The village plays sounds. */
  soundsOn?: boolean;
  /** Sound volume, 0-100. */
  soundVolume?: number;
  /** The sound file each moment plays; "" is silent. */
  sounds?: Partial<Record<SoundMoment, string>>;
  /** Day and night over the village, from the owner's clock. On until turned off. */
  dayNight?: boolean;
  /** A quiet village ambience under the sounds (birds by day, crickets at night), while the window is open. Off until turned on. */
  ambienceOn?: boolean;
  /** Ambience volume, 0-100, under the sound volume. */
  ambienceVolume?: number;
}

/** A moment that can play a sound (see src/state/sounds.ts and src-tauri/src/sounds.rs). */
export type SoundMoment = 'decide' | 'answer' | 'finished' | 'stuck' | 'start' | 'minion' | 'working';

/** A trackpad haptic (AppKit's patterns, a double tick, or none); felt only on a Force Touch trackpad. */
export type HapticKind = 'off' | 'alignment' | 'generic' | 'levelChange' | 'double';

export interface UpdateStatus {
  available: boolean;
  version?: string | null;
  notes?: string | null;
}

export interface Frame {
  /** Stream position of data[0] (for a marker: where output resumes). */
  offset: number;
  data: Uint8Array;
  /** Skip marker: display-only bytes outside the stream; written as-is, never acked. */
  marker?: boolean;
}

/** What the backend adds to every bug report, and whether this build can send one. */
export interface BugReportInfo {
  enabled: boolean;
  system: Array<[string, string]>;
}

/** A report is about something broken or something wanted. */
export type ReportKind = 'bug' | 'feature';

export interface BugReport {
  kind: ReportKind;
  text: string;
  contact: string | null;
  /** Shown to the owner before sending. */
  details: Array<[string, string]>;
  /** Base64 JPEG of the window. */
  screenshot: string | null;
}
