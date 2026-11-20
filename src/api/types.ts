import type { Stage } from '../village/activity';
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

/** A finished session the owner accepted, for the raid report (`raid.rs`). */
export interface RaidShip {
  at: number;
  workspaceId: string;
  builderName: string;
  agent: AgentKind;
  title: string | null;
  added: number;
  removed: number;
}

/** One day's raid report. */
export interface RaidReport {
  ships: RaidShip[];
  /** Time sessions waited on the owner, added up over sessions, ongoing waits included. */
  waitedMs: number;
  waitingNow: number;
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
  /** When its sessions were accepted (ms, the last 14 days): the house's look follows them. */
  ships?: number[];
  /** Visited villages only: the house's stage the owner's app sent. */
  stage?: Stage;
  compound: Compound | null;
  /** The roof colour (#rrggbb) the owner chose; null picks one from the id. */
  color?: string | null;
  /** The owner's notepad for this workspace (kept in the app's data only). */
  notes?: string;
  /** Its agent sessions are published to the team's Vercel Board (while Settings › Team is on). */
  boardShared?: boolean;
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
  /** It counted as shipped (an agent that finished, closed not stuck and not discarded). */
  shipped: boolean;
  /** The house's stage before and after this close. */
  stageBefore: number;
  stageAfter: number;
  workspaceId: string;
  /** An agent was closed before it finished. */
  unfinished: boolean;
  /** An agent was closed while Stuck. */
  stuck: boolean;
  /** The owner discarded it (not shipped). */
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
  /** A quiet village ambience under the sounds (birds by day, crickets at night), while the window is open. Off until turned on. */
  ambienceOn?: boolean;
  /** Ambience volume, 0-100, under the sound volume. */
  ambienceVolume?: number;
  /** The village on the owner's Vercel Board. Off until they turn it on. */
  board?: BoardSettings;
}

/** Settings › Team (Vercel Board). */
export interface BoardSettings {
  enabled: boolean;
  /** The Vercel team's slug; null is the login's default team. */
  team: string | null;
  name: string;
  shareDetails: boolean;
  sessionEnv: boolean;
  shareNew: boolean;
  hostId: string | null;
  /** The phone remote. Absent in settings saved before it existed. */
  remote?: RemoteSettings;
}

export type Level = 'visitor' | 'helper' | 'trusted';

/** One invited teammate, as Settings › People shows them. */
export interface InviteView {
  email: string;
  level: Level;
  /** Workspace ids they may see; null is every shared workspace. */
  workspaces: string[] | null;
  /** Their grant is on the board. */
  onBoard: boolean;
  /** Their Mac is paired with this village: only then can they act. */
  paired?: boolean;
  /** Their Mac can be paired (a Helper or Trusted the board has named). */
  pairable?: boolean;
}

/** Settings › Team: Private village and People, as the board has it now. */
export interface AccessStatus {
  state: 'closed' | 'open' | 'unknown';
  /** False once the board refused to let this login close the village (not a team owner). */
  canClose: boolean;
  refused: string | null;
  /** For a team owner to run, when this login may not. */
  command: string | null;
  who: string[];
  /** What on the board is not as the owner set it. */
  drift: string | null;
  invites: InviteView[];
}

/** How a builder is lent (kept in the Keychain on the lender's Mac). */
export interface Lend {
  builder: string;
  /** Paired key ids it is lent to; null: every paired Mac. */
  keys: string[] | null;
  /** Workspace ids it may work in; null: every shared workspace. */
  workspaces: string[] | null;
  /** Requests are refused at or under this much elixir left (percent); 0: no floor. */
  floor: number;
  /** The first task waits for Accept. */
  ask: boolean;
}

/** Settings › Lent builders. */
export interface Lending {
  builders: { builder: string; name: string; lend: Lend | null }[];
  workspaces: { id: string; name: string; lendable: boolean; why: string | null }[];
  mates: { key: string; email: string; handle: string }[];
  reserve: number;
}

/** A borrow request waiting for the lender. */
export interface BorrowRequest { id: string; who: string; builder: string; workspace: string; task: string; until: number }

/** A session on this Mac working for a teammate. */
export interface LentSession { session: string; key: string; handle: string; branch: string; request: string; pushed: boolean; pushError: string | null; worktree: string; repo: string }

/** A builder lent to this Mac, in a village it visits. */
export interface LentBuilder { profile: string; name: string }

/** A borrow request this Mac sent, and what came back. */
export interface SentBorrow { owner: string; request: string; builder: string; workspace: string; task: string; at: number; result: string | null; why: string | null }

/** A session in another village that works for this Mac. */
export interface BorrowedSession { owner: string; session: string; root: string | null; builder: string; workspace: string; state: string; wait: string | null }

/** A village this login was invited to, in the people row. */
export interface VisitView { owner: string; name: string | null; waiting: number; away: boolean; seen: number }

/** A visited village's map, as its owner's Mac wrote it (short keys: see src-tauri/src/board/snapshot.rs). */
export interface VillageMap {
  v: number;
  host: string;
  owner: string;
  name?: string | null;
  seen: number;
  workspaces: { s: string; n: string; l: number; a?: number; c?: string | null; p?: [number, number, number, number, number, number] | null }[];
  builders: { p: string; n: string; a: string }[];
  sessions: { i: string; r?: string | null; w: string; b: string; s: string; t?: string | null; n: number; a: number; p?: [number, number] | null; k: number }[];
  mates?: { key: string; handle: string; level: Level }[];
}

/** A builder in a visited village, from its thread. */
export interface VisitedBuilder {
  title: string;
  wait: string | null;
  words: string | null;
  question: string | null;
  options: string[] | null;
  /** What the owner's Mac will take for this wait. */
  can: ('allow' | 'deny' | 'answer' | 'followup' | 'close')[];
  /** The hash of the wait shown: what an action for it signs. */
  prompt: string | null;
  /** This Mac sent an action for this wait, and the owner's Mac's word on it. */
  sent: boolean;
  result: string | null;
}

/** Settings › Team › Phone remote (the paired phones themselves are in the Keychain). */
export interface RemoteSettings {
  enabled: boolean;
  /** Where the team's remote is deployed. */
  url: string | null;
  /** Production deployments of the remote this Mac made or the owner trusted. */
  trusted: string[];
  /** Why actions are refused for now. */
  paused: string | null;
}

export interface RemotePhone { key: string; name: string; pairedAt: number; lastUsed: number }

export interface RemotePairing {
  state: 'idle' | 'open' | 'asking' | 'cancelled';
  code: string | null;
  until: number | null;
  /** The phone that asks, and the number it shows. */
  name: string | null;
  check: string | null;
  why: string | null;
  /** The teammate whose Mac is being paired; null or absent for a phone. */
  forEmail?: string | null;
}

/** What Settings › Phone remote shows (the `remote-changed` event carries it too). */
export interface RemoteStatus {
  phones: RemotePhone[];
  pairing: RemotePairing;
  listening: boolean;
  paused: string | null;
  lastRefusedAt: number | null;
  keychainError: string | null;
  /** The last thing a teammate did in this village. */
  acted?: { who: string; what: string; at: number } | null;
  /** Where the team's remote is deployed, once set up. */
  url: string | null;
  /** The version of the remote this app carries. */
  bundledVersion: string;
}

/** A moment that can play a sound (see src/state/sounds.ts and src-tauri/src/sounds.rs). */
export type SoundMoment = 'decide' | 'answer' | 'finished' | 'stuck' | 'start' | 'minion' | 'working' | 'xp';

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

/** Settings › Team: the connection to Vercel Board, as `vercel` reports it. */
export interface BoardStatus {
  state: 'off' | 'noCli' | 'oldCli' | 'signedOut' | 'ready' | 'error';
  /** The owner's Vercel username. */
  handle: string | null;
  boardUrl: string | null;
  /** The login's team slugs; empty when they could not be listed. */
  teams: string[];
  lastError: string | null;
  lastWriteAt: number | null;
}
