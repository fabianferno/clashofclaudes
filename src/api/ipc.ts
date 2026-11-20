import { invoke, Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { HistoryEntry, HapticKind, Todo, AppPreview, AgentAccount, AgentInfo, AgentKind, AgentQuota, Builder, CloseOutcome, Compound, ConfirmQuit, Frame, ListState, Review, SessionInfo, Settings, Stats, Tile, UpdateStatus, Workspace, BugReport, BugReportInfo, ReportKind, RaidReport, BoardStatus, RemoteStatus, AccessStatus, Level, VisitView, VillageMap, VisitedBuilder } from './types';

const SKIP_FLAG = 1n << 63n;

/**
 * Frame layout: [u64 LE header][payload bytes]. The header is the stream offset of the first
 * payload byte; with bit 63 set the frame is a skip marker (see `attach_session` in Rust).
 */
export function decodeFrame(buf: ArrayBuffer): Frame {
  const header = new DataView(buf).getBigUint64(0, true);
  const marker = (header & SKIP_FLAG) !== 0n;
  return { offset: Number(header & ~SKIP_FLAG), data: new Uint8Array(buf, 8), marker };
}

/** Drop bytes at stream positions < writtenUntil; returns data to write and the new high-water mark. */
export function trimSeen(frame: Frame, writtenUntil: number): { data: Uint8Array; writtenUntil: number } {
  const end = frame.offset + frame.data.length;
  if (end <= writtenUntil) return { data: new Uint8Array(0), writtenUntil };
  const skip = Math.max(0, writtenUntil - frame.offset);
  return { data: frame.data.subarray(skip), writtenUntil: end };
}

export const ipc = {
  listState: () => invoke<ListState>('list_state'),
  /** `force` bypasses the 60 s detection cache (Re-check). */
  detectAgents: (force = false) => invoke<AgentInfo[]>('detect_agents', { force }),
  getQuotas: () => invoke<AgentQuota[]>('get_quotas'),
  /** `images`: attachment names (from `saveAttachment` / `importAttachment`). */
  addTodo: (workspaceId: string, text: string, images: string[] = []) => invoke<Todo>('add_todo', { workspaceId, text, images }),
  /** Saves an image pasted into a task; returns its attachment name. The bytes travel raw. */
  saveAttachment: (bytes: Uint8Array) => invoke<string>('save_attachment', bytes),
  /** Saves a copy of an image file dropped on a task; returns its attachment name. */
  importAttachment: (path: string) => invoke<string>('import_attachment', { path }),
  readAttachment: (name: string) => invoke<ArrayBuffer>('read_attachment', { name }),
  /** Removes attachments taken off a task before it was added or started (ones a To Do keeps stay). */
  discardAttachments: (names: string[]) => invoke<void>('discard_attachments', { names }),
  removeTodo: (id: string) => invoke<void>('remove_todo', { id }),
  /** How a To Do starts: on its own (`auto`, needs a builder), with which builder, in its own worktree. */
  updateTodo: (id: string, auto: boolean, builderId: string | null, worktree: boolean) =>
    invoke<Todo>('update_todo', { id, auto, builderId, worktree }),
  /** Rewrites a To Do's text and images; images it no longer carries are deleted. */
  editTodo: (id: string, text: string, images: string[]) => invoke<Todo>('edit_todo', { id, text, images }),
  /** A small JPEG of a page for its board, as a data: URL (taken in a hidden window; a few seconds). */
  snapshotApp: (url: string) => invoke<string>('snapshot_app', { url }),
  /** Local web apps last found in the workspaces. */
  getApps: () => invoke<AppPreview[]>('get_apps'),
  onAppsUpdated: (cb: (a: AppPreview[]) => void): Promise<UnlistenFn> =>
    listen<AppPreview[]>('apps-updated', (e) => cb(e.payload)),
  /** Reads every quota source now (Antigravity takes a second or two). */
  refreshQuotas: () => invoke<AgentQuota[]>('refresh_quotas'),
  /** Who the agent is signed in as; null when it has none to show. */
  getAccount: (agent: AgentKind) => invoke<AgentAccount | null>('get_account', { agent }),
  onQuotaUpdated: (cb: (q: AgentQuota) => void): Promise<UnlistenFn> =>
    listen<AgentQuota>('quota-updated', (e) => cb(e.payload)),
  addWorkspace: (path: string) => invoke<Workspace>('add_workspace', { path }),
  /** `parent` null: inside the default projects folder (~/Documents/.clashofclaudes). */
  createWorkspace: (parent: string | null, name: string) => invoke<Workspace>('create_workspace', { parent, name }),
  removeWorkspace: (id: string) => invoke<void>('remove_workspace', { id }),
  createBuilder: (name: string, agent: AgentKind, model: string | null, effort: string | null, customCommand: string | null) =>
    invoke<Builder>('create_builder', { name, agent, model, effort, customCommand }),
  updateBuilder: (builder: Builder) => invoke<void>('update_builder', { builder }),
  deleteBuilder: (id: string) => invoke<void>('delete_builder', { id }),
  /** `images`: attachment names; the session takes them over (their originals are removed). */
  startSession: (workspaceId: string, builderId: string, task: string, images: string[] = [], worktree = false) =>
    invoke<SessionInfo>('start_session', { workspaceId, builderId, task, images, worktree }),
  startTerminal: (workspaceId: string) => invoke<SessionInfo>('start_terminal', { workspaceId }),
  writeSession: (id: string, data: number[]) => invoke<void>('write_session', { id, data }),
  resizeSession: (id: string, cols: number, rows: number) => invoke<void>('resize_session', { id, cols, rows }),
  approve: (id: string) => invoke<void>('approve', { id }),
  deny: (id: string) => invoke<void>('deny', { id }),
  stopSession: (id: string) => invoke<void>('stop_session', { id }),
  resumeSession: (id: string) => invoke<SessionInfo>('resume_session', { id }),
  /** `discard`: the owner didn't want its work: not shipped even when finished. */
  closeSession: (id: string, discard = false) => invoke<CloseOutcome>('close_session', { id, discard }),
  /** Closed agent sessions that can be continued, newest first (all workspaces). */
  listHistory: () => invoke<HistoryEntry[]>('list_history'),
  /** Opens a past session's conversation again as a new session; `builderId` runs the same agent (its own builder when null). */
  continueHistory: (id: string, builderId: string | null = null) => invoke<SessionInfo>('continue_history', { id, builderId }),
  forgetHistory: (id: string) => invoke<void>('forget_history', { id }),
  onHistoryUpdated: (cb: () => void): Promise<UnlistenFn> => listen('history-updated', () => cb()),
  /** Puts a session aside out of the queue with a note; null takes it back. */
  parkSession: (id: string, note: string | null) => invoke<SessionInfo>('park_session', { id, note }),
  setCompound: (workspaceId: string, compound: Compound) =>
    invoke<Workspace>('set_compound', { workspaceId, compound }),
  /** null goes back to the automatic colour. */
  /** Replaces a workspace's notepad. */
  setWorkspaceNotes: (workspaceId: string, notes: string) => invoke<Workspace>('set_workspace_notes', { workspaceId, notes }),
  setWorkspaceColor: (workspaceId: string, color: string | null) =>
    invoke<Workspace>('set_workspace_color', { workspaceId, color }),
  setSessionSpot: (id: string, spot: Tile) => invoke<SessionInfo>('set_session_spot', { id, spot }),
  moveCompound: (workspaceId: string, dx: number, dy: number) =>
    invoke<{ workspace: Workspace; sessions: SessionInfo[] }>('move_compound', { workspaceId, dx, dy }),
  setCollectorSpot: (agent: AgentKind, spot: Tile) =>
    invoke<Partial<Record<AgentKind, Tile>>>('set_collector_spot', { agent, spot }),
  openInEditor: (path: string) => invoke<void>('open_in_editor', { path }),
  openInFinder: (path: string) => invoke<void>('open_in_finder', { path }),
  /** A Force Touch trackpad tap (nothing with a mouse or off macOS). */
  haptic: (kind?: Exclude<HapticKind, 'off' | 'double'>) => invoke<void>('haptic', { kind: kind ?? null }),
  /** Plays a sound file (nothing while sounds are off, unless `preview`); `volume` 0-100, else the saved one. */
  playSound: (path: string, volume?: number, preview = false) => invoke<void>('play_sound', { path, volume: volume ?? null, preview }),
  /** The macOS system sounds' names (`Basso`, `Blow`, ...). */
  systemSounds: () => invoke<string[]>('system_sounds'),
  /** Copies a sound file into the data folder; returns the copy's path. */
  importSound: (path: string) => invoke<string>('import_sound', { path }),
  reviewSession: (id: string) => invoke<Review>('review_session', { id }),
  /** What shipped and how long builders waited on the owner between `from` and `to` (ms). */
  raidReport: (from: number, to: number) => invoke<RaidReport>('raid_report', { from, to }),
  /** Saves an exported raid report card (base64 PNG) in Downloads; returns its path. */
  saveRaidCard: (png: string, day: string) => invoke<string>('save_raid_card', { png, day }),
  /** A markdown doc the session points to (a plan it wrote): `path` as written, relative to its folder or repository. */
  readSessionDoc: (id: string, path: string) => invoke<{ path: string; text: string }>('read_session_doc', { id, path }),
  detachSession: (id: string) => invoke<void>('detach_session', { id }),
  /** The terminal finished writing output up to stream position `offset`; lets the next frame through. */
  ackOutput: (id: string, offset: number) => invoke<void>('ack_output', { id, offset }),
  /** `restart`: relaunch into an installed update instead of exiting. */
  quitNow: (restart = false) => invoke<void>('quit_now', { restart }),
  /** Opens the mini village (a small window that stays on top), or closes it. */
  toggleMini: () => invoke<void>('toggle_mini'),
  /** From the mini village: bring the main window up, on this session when one is given. */
  focusSession: (id: string | null) => invoke<void>('focus_session', { id }),
  getSettings: () => invoke<Settings>('get_settings'),
  /** The global shortcut: on in Settings, and whether another app holds its keys. */
  shortcutStatus: () => invoke<{ enabled: boolean; taken: boolean }>('shortcut_status'),
  setSettings: (settings: Settings) => invoke<Settings>('set_settings', { settings }),
  /** Settings › Team: where the connection to Vercel Board stands (runs the `vercel` CLI). */
  boardStatus: () => invoke<BoardStatus>('board_status'),
  /** After installing, updating or signing in to `vercel`: look again. */
  boardCheck: () => invoke<BoardStatus>('board_check'),
  /** Shares a workspace on the team's board, or stops. */
  setWorkspaceShared: (workspaceId: string, shared: boolean) => invoke<Workspace>('set_workspace_shared', { workspaceId, shared }),
  /** Settings › Team: who can see the village (reads the board; the first time, closes the village). */
  accessStatus: () => invoke<AccessStatus>('access_status'),
  accessSetPrivate: (on: boolean) => invoke<AccessStatus>('access_set_private', { on }),
  /** Makes the board what the owner set again. */
  accessPutBack: () => invoke<AccessStatus>('access_put_back'),
  invitePut: (email: string, level: Level, workspaces: string[] | null) => invoke<AccessStatus>('invite_put', { email, level, workspaces }),
  inviteRemove: (email: string) => invoke<AccessStatus>('invite_remove', { email }),
  /** Opens a pairing for an invited teammate's Mac; the code to send them. */
  matePairStart: (email: string) => invoke<string>('mate_pair_start', { email }),
  /** This Mac's key id, when it has a key. */
  mateKey: () => invoke<string | null>('mate_key'),
  /** Asks a village's owner to pair this Mac, with the code they sent; the check number to read back. */
  matePair: (owner: string, code: string) => invoke<string>('mate_pair', { owner, code }),
  /** Sends a signed action for a builder in a visited village. */
  visitAct: (owner: string, root: string, action: { do: 'allow' | 'deny' | 'answer' | 'followup'; pick?: number; text?: string; prompt: string }) =>
    invoke<void>('visit_act', { owner, root, do: action.do, pick: action.pick ?? null, text: action.text ?? null, prompt: action.prompt }),
  /** The villages this login was invited to. */
  visits: () => invoke<VisitView[]>('visits'),
  visit: (owner: string) => invoke<VillageMap | null>('visit', { owner }),
  visitsRefresh: () => invoke<VisitView[]>('visits_refresh'),
  visitBuilder: (owner: string, root: string) => invoke<VisitedBuilder | null>('visit_builder', { owner, root }),
  onVisitsChanged: (cb: (v: VisitView[]) => void): Promise<UnlistenFn> => listen<VisitView[]>('visits-changed', (e) => cb(e.payload)),
  /** Settings › Phone remote: paired phones, pairing, whether the Mac listens. */
  remoteStatus: () => invoke<RemoteStatus>('remote_status'),
  /** Opens a pairing; the six-digit code to type on the phone. */
  remotePairStart: () => invoke<string>('remote_pair_start'),
  remotePairConfirm: () => invoke<void>('remote_pair_confirm'),
  remotePairCancel: () => invoke<void>('remote_pair_cancel'),
  remoteRemovePhone: (key: string) => invoke<void>('remote_remove_phone', { key }),
  /** The team's remote, if it has one (runs the `vercel` CLI). */
  remoteFind: () => invoke<string | null>('remote_find'),
  /** Uses the team's remote (null), or one at an address the owner deployed. */
  remoteConnect: (url: string | null) => invoke<void>('remote_connect', { url }),
  /** Deploys or updates the remote this app carries (a minute or two). */
  remoteDeploy: () => invoke<void>('remote_deploy'),
  remoteDeployedVersion: () => invoke<string | null>('remote_deployed_version'),
  /** Trusts the remote as it is deployed now. */
  remoteTrust: () => invoke<void>('remote_trust'),
  onRemoteChanged: (cb: (s: RemoteStatus) => void): Promise<UnlistenFn> => listen<RemoteStatus>('remote-changed', (e) => cb(e.payload)),
  /** The app changed settings itself (the phone remote's address, its switch after a deploy). */
  onSettingsChanged: (cb: (s: Settings) => void): Promise<UnlistenFn> => listen<Settings>('settings-changed', (e) => cb(e.payload)),
  onRemoteProgress: (cb: (line: string) => void): Promise<UnlistenFn> => listen<string>('remote-progress', (e) => cb(e.payload)),
  /** The folder holding the app's data. */
  dataFolder: () => invoke<string>('data_folder'),
  bugReportInfo: () => invoke<BugReportInfo>('bug_report_info'),
  /** Posts the report to the project's Discord. */
  sendBugReport: (report: BugReport) => invoke<void>('send_bug_report', { report }),
  /** An anonymous usage event the frontend sees; sent only while the owner shares usage. */
  trackUsage: (event: 'kanbanOpened') => invoke<void>('track_usage', { event }),
  /** Opens the data folder in Finder. */
  showDataFolder: () => invoke<void>('show_data_folder'),
  /** Rejects with "disabled" (no network call made) in debug builds, with the placeholder key, or when updates are off. */
  checkForUpdate: () => invoke<UpdateStatus>('check_for_update'),
  /** Downloads and installs the pending update; the backend then asks (if sessions run) before restarting. */
  installUpdate: () => invoke<void>('install_update'),
  /** Restarts into an already installed update, through the quit guard. */
  restartForUpdate: () => invoke<void>('restart_for_update'),
  /** Download progress of `installUpdate`: whole percent, null while the size is unknown. */
  onUpdateProgress: (cb: (pct: number | null) => void): Promise<UnlistenFn> =>
    listen<{ pct: number | null }>('update-progress', (e) => cb(e.payload.pct)),
  /** Registers a channel for live frames and returns the decoded snapshot frame. */
  attachSession: async (id: string, onFrame: (f: Frame) => void): Promise<Frame> => {
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => onFrame(decodeFrame(buf));
    const snap = await invoke<ArrayBuffer>('attach_session', { id, onData: ch });
    return decodeFrame(snap);
  },
  onSessionUpdated: (cb: (s: SessionInfo) => void): Promise<UnlistenFn> =>
    listen<SessionInfo>('session-updated', (e) => cb(e.payload)),
  onSessionRemoved: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<{ id: string }>('session-removed', (e) => cb(e.payload.id)),
  /** A workspace changed on the backend (e.g. its folder was found missing when starting). */
  onWorkspaceUpdated: (cb: (w: Workspace) => void): Promise<UnlistenFn> =>
    listen<Workspace>('workspace-updated', (e) => cb(e.payload)),
  onStatsUpdated: (cb: (s: Stats) => void): Promise<UnlistenFn> =>
    listen<Stats>('stats-updated', (e) => cb(e.payload)),
  /** A notification was clicked: select that session (and open its panel). */
  onSelectSession: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<{ id: string }>('select-session', (e) => cb(e.payload.id)),
  onConfirmQuit: (cb: (q: ConfirmQuit) => void): Promise<UnlistenFn> =>
    listen<ConfirmQuit>('confirm-quit', (e) => cb(e.payload)),
  /** Settings… (Cmd+,) was chosen in the app menu. */
  onOpenSettings: (cb: () => void): Promise<UnlistenFn> =>
    listen('open-settings', () => cb()),
  /** Help › Report a Bug… or Request a Feature… was chosen in the app menu. */
  onOpenBugReport: (cb: (kind: ReportKind) => void): Promise<UnlistenFn> =>
    listen<ReportKind>('open-bug-report', (e) => cb(e.payload === 'feature' ? 'feature' : 'bug')),
};
