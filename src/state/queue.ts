import type { AgentKind, AgentQuota, Builder, SessionInfo, Settings, Todo, Workspace } from '../api/types';
import { isLow, standInFor, type ElixirRules } from './elixir';

/**
 * The owner's queue: every agent session waiting on them, one at a time. Take the first, read its
 * briefing, decide, and it leaves the queue; the next one comes up.
 *
 * Order: a decision the app can take (Allow / Deny) first, then a question answered in the
 * terminal, then a stuck session, then finished work to review. Oldest wait first within each.
 * Parked (put aside) and paused sessions stay out until their state changes or they are resumed.
 */
export type QueueReason = 'decide' | 'answer' | 'stuck' | 'review';

export interface QueueItem { session: SessionInfo; reason: QueueReason }

const RANK: Record<QueueReason, number> = { decide: 0, answer: 1, stuck: 2, review: 3 };

export const QUEUE_LABEL: Record<QueueReason, string> = {
  decide: 'Wants a decision',
  answer: 'Asking you',
  stuck: 'Stuck',
  review: 'Ready to review',
};

// Mirrored in src-tauri/src/queue.rs (menu bar, Dock badge): change both, and both tests.
/** Why the session waits on the owner, or null when it does not. */
export function queueReason(s: SessionInfo): QueueReason | null {
  if (s.kind.kind !== 'agent' || s.paused || s.parked != null) return null;
  switch (s.state.kind) {
    case 'needsYou': return s.awaitingDecision ? 'decide' : 'answer';
    case 'stuck': return 'stuck';
    case 'finished': return 'review';
    default: return null;
  }
}

/** Since when it has waited (its last state change; its start for saves from before that was kept). */
export const waitingSince = (s: SessionInfo): number => s.stateSince || s.lastOutputAt || s.startedAt;

export function ownerQueue(st: { sessions: Record<string, SessionInfo>; workspaces: Pick<Workspace, 'id'>[] }): QueueItem[] {
  const out: QueueItem[] = [];
  for (const s of Object.values(st.sessions)) {
    const reason = queueReason(s);
    if (reason && st.workspaces.some((w) => w.id === s.workspaceId)) out.push({ session: s, reason });
  }
  return out.sort((a, b) => RANK[a.reason] - RANK[b.reason] || waitingSince(a.session) - waitingSince(b.session) || a.session.id.localeCompare(b.session.id));
}

/** The item to take after `current` (the first other one), or null when nothing else waits. */
export function nextInQueue(queue: QueueItem[], current: string | null): QueueItem | null {
  return queue.find((q) => q.session.id !== current) ?? null;
}

/** Agent sessions at work or about to be (counted against the running-session limit). */
export function runningAgents(sessions: Record<string, SessionInfo>): number {
  return Object.values(sessions).filter((s) => s.kind.kind === 'agent' && !s.paused && (s.state.kind === 'starting' || s.state.kind === 'working')).length;
}

/** Whether the limit leaves room for one more session at work. */
export const roomToStart = (sessions: Record<string, SessionInfo>, settings: Pick<Settings, 'sessionLimit'> | null): boolean =>
  !settings?.sessionLimit || runningAgents(sessions) < settings.sessionLimit;

/** A To Do picked to start now, with the builder that takes it (`standInFor`: the one it was for, when another takes it). */
export type StartPick = Todo & { builderId: string; standInFor?: string };

/**
 * The To Dos set to start on their own that can start now, oldest first: their builder is free,
 * their workspace is there, and the running-session limit leaves room (each one started takes a slot,
 * and a builder takes one task at a time). A To Do whose builder's agent is at or under the elixir
 * reserve waits, unless stand-ins are on and a free builder with elixir can take it instead.
 */
export function autoStartable(st: {
  todos: Todo[];
  builders: Builder[];
  sessions: Record<string, SessionInfo>;
  workspaces: Pick<Workspace, 'id' | 'missing'>[];
  settings: (Pick<Settings, 'sessionLimit'> & ElixirRules) | null;
  quotas?: Partial<Record<AgentKind, AgentQuota>>;
  now?: number;
}): StartPick[] {
  const busy = new Set<string>();
  for (const s of Object.values(st.sessions)) {
    if (s.kind.kind === 'agent' && s.state.kind !== 'ended') busy.add(s.kind.builderId);
  }
  const quotas = st.quotas ?? {};
  const now = st.now ?? Date.now();
  const limit = st.settings?.sessionLimit ?? null;
  let room = limit ? Math.max(0, limit - runningAgents(st.sessions)) : Infinity;
  const out: StartPick[] = [];
  for (const t of [...st.todos].sort((a, b) => a.createdAt - b.createdAt)) {
    if (room <= 0) break;
    if (!t.auto || !t.builderId || busy.has(t.builderId)) continue;
    const b = st.builders.find((x) => x.id === t.builderId);
    if (!b) continue;
    const ws = st.workspaces.find((w) => w.id === t.workspaceId);
    if (!ws || ws.missing) continue;
    let pick: StartPick = { ...t, builderId: b.id };
    if (isLow(b.agent, quotas, now, st.settings)) {
      const sub = st.settings?.elixirStandIn ? standInFor(st.builders, busy, quotas, now, st.settings) : null;
      if (!sub) continue;
      pick = { ...t, builderId: sub.id, standInFor: b.id };
    }
    out.push(pick);
    busy.add(pick.builderId);
    room -= 1;
  }
  return out;
}

/** "3m", "1h 20m": how long something has waited. */
export function waitedLabel(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return 'just now';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}
