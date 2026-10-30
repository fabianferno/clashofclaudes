import { invoke, Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AgentInfo, AgentKind, Builder, CloseOutcome, ConfirmQuit, Frame, ListState,
  Review, SessionInfo, Workspace,
} from './types';

/** Frame layout: [u64 LE start_offset][payload bytes]. */
export function decodeFrame(buf: ArrayBuffer): Frame {
  const offset = Number(new DataView(buf).getBigUint64(0, true));
  return { offset, data: new Uint8Array(buf, 8) };
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
  detectAgents: () => invoke<AgentInfo[]>('detect_agents'),
  addWorkspace: (path: string) => invoke<Workspace>('add_workspace', { path }),
  createWorkspace: (parent: string, name: string) => invoke<Workspace>('create_workspace', { parent, name }),
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
  reviewSession: (id: string) => invoke<Review>('review_session', { id }),
  detachSession: (id: string) => invoke<void>('detach_session', { id }),
  quitNow: () => invoke<void>('quit_now'),
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
  onConfirmQuit: (cb: (q: ConfirmQuit) => void): Promise<UnlistenFn> =>
    listen<ConfirmQuit>('confirm-quit', (e) => cb(e.payload)),
};
