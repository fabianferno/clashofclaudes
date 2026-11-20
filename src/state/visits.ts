import type { AgentKind, SessionInfo, SessionState, VillageMap } from '../api/types';
import type { VillageInput } from '../village/scene';

const WAITING = ['needs_you', 'stuck', 'finished'];

/** How many builders wait on their owner in a visited village. */
export const waitingIn = (map: VillageMap): number => map.sessions.filter((s) => WAITING.includes(s.s)).length;

function stateOf(s: string): SessionState {
  switch (s) {
    case 'starting': return { kind: 'starting' };
    case 'needs_you': return { kind: 'needsYou', reason: '' };
    case 'finished': return { kind: 'finished' };
    case 'stuck': return { kind: 'stuck', reason: '' };
    case 'paused':
    case 'closed': return { kind: 'ended', exitCode: null };
    default: return { kind: 'working' };
  }
}

/**
 * A visited village as the canvas draws it: the owner's houses where they stand, and their
 * builders at them by state. Workspaces and builders are named by what the map calls them (slug,
 * profile). Nothing of the visitor's own village goes in: no collectors, no boards, no tasks.
 */
export function visitInput(map: VillageMap): VillageInput {
  const known = new Set(map.workspaces.map((w) => w.s));
  const sessions: SessionInfo[] = map.sessions
    .filter((s) => known.has(s.w))
    .map((s) => ({
      id: s.i,
      workspaceId: s.w,
      kind: { kind: 'agent', builderId: s.b },
      task: null,
      state: stateOf(s.s),
      steps: s.k,
      startedAt: s.a,
      lastOutputAt: s.n,
      reachedFinished: s.s === 'finished',
      worktree: null,
      commandPreview: '',
      awaitingDecision: s.t === 'decide',
      busy: s.s === 'working',
      rev: s.n,
      spot: s.p ? { x: s.p[0], y: s.p[1] } : null,
      paused: s.s === 'paused',
      stateSince: s.n,
    }));
  return {
    workspaces: map.workspaces.map((w) => ({
      id: w.s,
      name: w.n,
      path: '',
      createdAt: 0,
      missing: false,
      level: w.l,
      xp: 0,
      compound: w.p ? { x0: w.p[0], y0: w.p[1], w: w.p[2], h: w.p[3], house: { x: w.p[4], y: w.p[5] } } : null,
      color: w.c ?? undefined,
    })),
    sessions,
    builders: map.builders.map((b) => ({ id: b.p, name: b.n, agent: b.a as AgentKind, model: null, effort: null, customCommand: null })),
    boards: [],
    ownerName: map.name ?? map.owner,
  };
}
