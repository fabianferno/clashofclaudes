import { invoke, Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentInfo, AgentKind, AgentQuota, Builder, CloseOutcome, Compound, ConfirmQuit, Frame, ListState, Review, SessionInfo, Settings, Stats, Tile, UpdateStatus, Workspace } from './types';

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
  /** Reads every quota source now (Antigravity takes a second or two). */
  refreshQuotas: () => invoke<AgentQuota[]>('refresh_quotas'),
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
  startSession: (workspaceId: string, builderId: string, task: string) =>
    invoke<SessionInfo>('start_session', { workspaceId, builderId, task }),
  startTerminal: (workspaceId: string) => invoke<SessionInfo>('start_terminal', { workspaceId }),
  writeSession: (id: string, data: number[]) => invoke<void>('write_session', { id, data }),
  resizeSession: (id: string, cols: number, rows: number) => invoke<void>('resize_session', { id, cols, rows }),
  approve: (id: string) => invoke<void>('approve', { id }),
  deny: (id: string) => invoke<void>('deny', { id }),
  stopSession: (id: string) => invoke<void>('stop_session', { id }),
  closeSession: (id: string) => invoke<CloseOutcome>('close_session', { id }),
  setCompound: (workspaceId: string, compound: Compound) =>
    invoke<Workspace>('set_compound', { workspaceId, compound }),
  setSessionSpot: (id: string, spot: Tile) => invoke<SessionInfo>('set_session_spot', { id, spot }),
  openInEditor: (path: string) => invoke<void>('open_in_editor', { path }),
  reviewSession: (id: string) => invoke<Review>('review_session', { id }),
  detachSession: (id: string) => invoke<void>('detach_session', { id }),
  /** The terminal finished writing output up to stream position `offset`; lets the next frame through. */
  ackOutput: (id: string, offset: number) => invoke<void>('ack_output', { id, offset }),
  /** `restart`: relaunch into an installed update instead of exiting. */
  quitNow: (restart = false) => invoke<void>('quit_now', { restart }),
  getSettings: () => invoke<Settings>('get_settings'),
  setSettings: (settings: Settings) => invoke<Settings>('set_settings', { settings }),
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
};
