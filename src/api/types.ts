export type AgentKind = 'claude' | 'codex' | 'antigravity' | 'opencode' | 'custom';

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

export interface WorktreeInfo {
  path: string;
  branch: string | null;
}

export interface SessionInfo {
  id: string;
  workspaceId: string;
  kind: SessionKind;
  task: string | null;
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
  /** The Dock icon counts the sessions that need you or finished. */
  dockBadge: boolean;
  /** What the owner asked to be called (the Town Hall's plate); null until given. */
  playerName?: string | null;
  /** The first-run welcome (and its tour) was completed or skipped. */
  onboarded?: boolean;
  /** Structures placed before they kept their padding have been spaced out once. */
  spotsTidied?: boolean;
}

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
