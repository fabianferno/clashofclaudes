export type AgentKind = 'claude' | 'codex' | 'gemini' | 'opencode' | 'custom';

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
  /** Strictly increasing per session; the store drops updates older than the one it holds. */
  rev: number;
  /** Where the builder stands in the village; not persisted. */
  spot: Tile | null;
}

export interface ListState {
  workspaces: Workspace[];
  builders: Builder[];
  sessions: SessionInfo[];
  stats: Stats;
}

export interface AgentInfo {
  kind: AgentKind;
  label: string;
  installed: boolean;
  version: string | null;
  models: string[];
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
}

export interface ConfirmQuit {
  live: number;
}

export interface Frame {
  /** Stream position of data[0] (for a marker: where output resumes). */
  offset: number;
  data: Uint8Array;
  /** Skip marker: display-only bytes outside the stream; written as-is, never acked. */
  marker?: boolean;
}
