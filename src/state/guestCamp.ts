import type { Builder, BorrowedSession, Compound, SessionInfo, SessionState, Workspace } from '../api/types';
import { placeCompound } from '../village/layout';

/** The camp's id among the workspaces the canvas draws. It is not a workspace: nothing is built in it. */
export const CAMP_ID = 'guest-camp';
const PREFIX = 'camp:';

function stateOf(s: string): SessionState {
  switch (s) {
    case 'needs_you': return { kind: 'needsYou', reason: '' };
    case 'finished': return { kind: 'finished' };
    case 'stuck': return { kind: 'stuck', reason: '' };
    case 'starting': return { kind: 'starting' };
    default: return { kind: 'working' };
  }
}

/** A camp session's id names the village and the session there. */
export function isCampSession(id: string): { owner: string; session: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const at = rest.indexOf(':');
  return at > 0 ? { owner: rest.slice(0, at), session: rest.slice(at + 1) } : null;
}

const apart = (a: Compound, b: Compound) => a.x0 >= b.x0 + b.w || b.x0 >= a.x0 + a.w || a.y0 >= b.y0 + b.h || b.y0 >= a.y0 + a.h;

/** Where the camp stands: where it stood, while no workspace has moved onto it; else a free place. */
export function campCompound(workspaces: Workspace[], kept: Compound | null): Compound {
  const taken = workspaces.map((w) => w.compound).filter((c): c is Compound => !!c);
  if (kept && taken.every((c) => apart(c, kept))) return kept;
  return placeCompound(taken);
}

/**
 * The guest camp: one compound in your own village where the builders working for you in other
 * villages stand, each with its owner's handle. Null when nothing is borrowed.
 */
export function guestCamp(borrowed: BorrowedSession[], at: Compound): { workspace: Workspace; sessions: SessionInfo[]; builders: Builder[] } | null {
  if (borrowed.length === 0) return null;
  // two tiles apart along the rows under the house, inside the walls
  const spots: { x: number; y: number }[] = [];
  for (let y = at.y0 + 1; y < at.y0 + at.h - 1 && spots.length < borrowed.length; y += 2) {
    for (let x = at.x0 + 1; x < at.x0 + at.w - 1 && spots.length < borrowed.length; x += 2) {
      const onHouse = x >= at.house.x - 1 && x <= at.house.x + 3 && y >= at.house.y - 1 && y <= at.house.y + 3;
      if (!onHouse) spots.push({ x, y });
    }
  }
  const sessions: SessionInfo[] = borrowed.map((b, i) => ({
    id: `${PREFIX}${b.owner}:${b.session}`,
    workspaceId: CAMP_ID,
    kind: { kind: 'agent', builderId: `${PREFIX}${b.owner}:${b.session}` },
    task: null,
    state: stateOf(b.state),
    steps: 0,
    startedAt: 0,
    lastOutputAt: 0,
    reachedFinished: b.state === 'finished',
    worktree: null,
    commandPreview: '',
    awaitingDecision: b.wait === 'decide',
    busy: b.state === 'working',
    rev: 0,
    spot: spots[i] ?? null,
  }));
  const builders: Builder[] = borrowed.map((b) => ({ id: `${PREFIX}${b.owner}:${b.session}`, name: `${b.builder} · ${b.owner}`, agent: 'claude', model: null, effort: null, customCommand: null }));
  const workspace = { id: CAMP_ID, name: 'Guest camp', path: '', createdAt: 0, missing: false, compound: at, boardShared: false } as Workspace;
  return { workspace, sessions, builders };
}
