import { create } from 'zustand';
import { ipc } from '../api/ipc';
import type { AgentInfo, Builder, CloseOutcome, Compound, ListState, SessionInfo, SessionState, Stats, Tile, Workspace } from '../api/types';
import { HOUSE, STRUCT, canPlace, placeCompound, spotFor } from '../village/layout';

export type Selection =
  | { kind: 'hall' }
  | { kind: 'workspace'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'builder'; id: string };

export interface VillageActions {
  /** The workspace's compound, placing and persisting one first if it has none. */
  ensureCompound: (wsId: string) => Promise<Compound>;
  /** The agent session's spot, finding (expanding the compound if full) and persisting one if it has none. */
  ensureSpot: (sessionId: string) => Promise<Tile>;
  /** Persist a move of a structure (session) or a compound's house (workspace) to `at`; false (and no ipc) when blocked. */
  commitMove: (target: MoveTarget, at: Tile, onError?: (e: unknown) => void) => Promise<boolean>;
}

export type MoveTarget = { kind: 'session'; id: string } | { kind: 'workspace'; id: string };

/** Whether the structure or house may stand with its top-left on `at`: inside its compound, clear of everything else. */
export function moveValid(st: Pick<AppState, 'workspaces' | 'sessions'>, target: MoveTarget, at: Tile): boolean {
  const wsId = target.kind === 'workspace' ? target.id : st.sessions[target.id]?.workspaceId;
  const c = st.workspaces.find((w) => w.id === wsId)?.compound;
  if (!c) return false;
  const mates = (except: string | null) => Object.values(st.sessions)
    .filter((x) => x.workspaceId === wsId && x.kind.kind === 'agent' && x.spot && x.id !== except)
    .map((x) => x.spot!);
  if (target.kind === 'session') return st.sessions[target.id]?.spot ? canPlace(c, mates(target.id), at, STRUCT) : false;
  // the house is checked against every structure, but not against its own current tile
  return canPlace({ ...c, house: { x: -1e6, y: -1e6 } }, mates(null), at, HOUSE);
}

export interface Notice { id: number; text: string; kind: 'xp' | 'level' | 'info' }

const NOTICE_MS = 3000;
const OUTCOME_MS = 10000;
let noticeSeq = 0;

export interface AppState {
  notices: Notice[];
  /** XP-earning close outcomes by session id, for the village to play the orbs; cleared once consumed. */
  lastClosed: Record<string, CloseOutcome>;
  /** A session was closed: pushes its notice(s) and remembers an earning outcome for the scene. Terminals stay silent. */
  onClosed: (o: CloseOutcome, sessionId?: string) => void;
  consumeClosed: (sessionId: string) => void;
  workspaces: Workspace[];
  builders: Builder[];
  sessions: Record<string, SessionInfo>;
  agents: AgentInfo[];
  stats: Stats;
  selectedSessionId: string | null;
  selection: Selection | null;
  panelOpen: boolean;
  village: VillageActions;
  hydrate: (s: ListState) => void;
  upsertSession: (s: SessionInfo) => void;
  removeSession: (id: string) => void;
  select: (id: string | null) => void;
  /** Village selection; opens the panel for anything selected. A selected session also drives Plan 1's panel. */
  setSelection: (sel: Selection | null) => void;
  setAgents: (a: AgentInfo[]) => void;
  addWorkspace: (w: Workspace) => void;
  updateWorkspace: (w: Workspace) => void;
  removeWorkspace: (id: string) => void;
  setStats: (s: Stats) => void;
  addBuilder: (b: Builder) => void;
  updateBuilder: (b: Builder) => void;
}

export const useApp = create<AppState>((set, get) => ({
  workspaces: [],
  builders: [],
  sessions: {},
  agents: [],
  stats: { shippedTotal: 0, recentShips: [] },
  selectedSessionId: null,
  selection: null,
  panelOpen: false,
  village: villageActions(get),
  notices: [],
  lastClosed: {},
  onClosed: (o, sessionId) => {
    const push = (text: string, kind: Notice['kind']) => {
      const id = ++noticeSeq;
      set((st) => ({ notices: [...st.notices, { id, text, kind }] }));
      setTimeout(() => set((st) => ({ notices: st.notices.filter((n) => n.id !== id) })), NOTICE_MS);
    };
    if (o.stuck) push('Closed while stuck \u2014 no XP', 'info');
    else if (o.unfinished) push('Closed \u2014 not finished, no XP', 'info');
    else if (o.earnedXp) {
      push('+100 XP', 'xp');
      if (o.levelAfter > o.levelBefore) push(`LEVEL UP! Level ${o.levelAfter}`, 'level');
      if (sessionId) {
        set((st) => ({ lastClosed: { ...st.lastClosed, [sessionId]: o } }));
        setTimeout(() => get().consumeClosed(sessionId), OUTCOME_MS); // never leak if no structure was on screen
      }
    }
  },
  consumeClosed: (sessionId) =>
    set((st) => {
      if (!(sessionId in st.lastClosed)) return st;
      const { [sessionId]: _gone, ...rest } = st.lastClosed;
      return { lastClosed: rest };
    }),
  hydrate: (s) =>
    set({
      workspaces: s.workspaces,
      builders: s.builders,
      sessions: Object.fromEntries(s.sessions.map((x) => [x.id, x])),
      ...(s.stats ? { stats: s.stats } : {}),
    }),
  upsertSession: (s) =>
    set((st) => {
      const cur = st.sessions[s.id];
      if (cur && s.rev < cur.rev) return st; // stale: a newer update already landed
      return { sessions: { ...st.sessions, [s.id]: s } };
    }),
  removeSession: (id) =>
    set((st) => {
      const { [id]: _removed, ...rest } = st.sessions;
      const gone = st.selection?.kind === 'session' && st.selection.id === id;
      return {
        sessions: rest,
        selectedSessionId: st.selectedSessionId === id ? null : st.selectedSessionId,
        ...(gone ? { selection: null, panelOpen: false } : {}),
      };
    }),
  select: (id) => set({ selectedSessionId: id }),
  setSelection: (sel) =>
    set({ selection: sel, panelOpen: sel !== null, selectedSessionId: sel?.kind === 'session' ? sel.id : null }),
  setAgents: (agents) => set({ agents }),
  addWorkspace: (w) => set((st) => ({ workspaces: [...st.workspaces, w] })),
  updateWorkspace: (w) => set((st) => ({ workspaces: st.workspaces.map((x) => (x.id === w.id ? w : x)) })),
  removeWorkspace: (id) => set((st) => ({ workspaces: st.workspaces.filter((x) => x.id !== id) })),
  setStats: (stats) => set({ stats }),
  addBuilder: (b) => set((st) => ({ builders: [...st.builders, b] })),
  updateBuilder: (b) => set((st) => ({ builders: st.builders.map((x) => (x.id === b.id ? b : x)) })),
}));

export function sessionsByWorkspace(state: Pick<AppState, 'sessions'>, wsId: string): SessionInfo[] {
  return Object.values(state.sessions)
    .filter((s) => s.workspaceId === wsId)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Builders with no live (non-ended) session. */
export function idleBuilders(state: Pick<AppState, 'builders' | 'sessions'>): Builder[] {
  const busy = new Set<string>();
  for (const s of Object.values(state.sessions)) {
    if (s.kind.kind === 'agent' && s.state.kind !== 'ended') busy.add(s.kind.builderId);
  }
  return state.builders.filter((b) => !busy.has(b.id));
}

export function stateLabel(s: SessionState): 'Starting' | 'Working' | 'Needs you' | 'Finished' | 'Stuck' | 'Ended' {
  switch (s.kind) {
    case 'starting': return 'Starting';
    case 'working': return 'Working';
    case 'needsYou': return 'Needs you';
    case 'finished': return 'Finished';
    case 'stuck': return 'Stuck';
    case 'ended': return 'Ended';
  }
}

/**
 * Layout writes go through one promise chain so two concurrent starts never compute a layout from
 * the same stale snapshot: each step reads the store only after the previous step's writes landed.
 */
function villageActions(get: () => AppState): VillageActions {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const compoundOf = async (wsId: string): Promise<Compound> => {
    const st = get();
    const ws = st.workspaces.find((w) => w.id === wsId);
    if (!ws) throw new Error(`unknown workspace ${wsId}`);
    if (ws.compound) return ws.compound;
    const others = st.workspaces.flatMap((w) => (w.compound ? [w.compound] : []));
    const c = placeCompound(others);
    get().updateWorkspace(await ipc.setCompound(wsId, c));
    return c;
  };

  const spotOf = async (sessionId: string): Promise<Tile> => {
    const s = get().sessions[sessionId];
    if (!s) throw new Error(`unknown session ${sessionId}`);
    if (s.kind.kind === 'terminal') throw new Error('terminal sessions have no spot');
    if (s.spot) return s.spot;
    const c = await compoundOf(s.workspaceId);
    const st = get();
    const mates = Object.values(st.sessions).filter(
      (x) => x.id !== sessionId && x.workspaceId === s.workspaceId && x.kind.kind === 'agent' && x.spot,
    );
    const all = st.workspaces.flatMap((w) => (w.compound ? [w.compound] : []));
    const r = spotFor(c, all, mates.map((x) => x.spot!));
    if (r.expanded) get().updateWorkspace(await ipc.setCompound(s.workspaceId, r.compound));
    if (r.shift.x !== 0 || r.shift.y !== 0) {
      for (const m of mates) {
        const moved = { x: m.spot!.x + r.shift.x, y: m.spot!.y + r.shift.y };
        get().upsertSession(await ipc.setSessionSpot(m.id, moved));
      }
    }
    get().upsertSession(await ipc.setSessionSpot(sessionId, r.spot));
    return r.spot;
  };

  return {
    ensureCompound: (wsId) => serial(() => compoundOf(wsId)),
    ensureSpot: (sessionId) => serial(() => spotOf(sessionId)),
    commitMove: (target, at, onError) => serial(async () => {
      const st = get();
      if (!moveValid(st, target, at)) return false;
      try {
        if (target.kind === 'session') {
          st.upsertSession(await ipc.setSessionSpot(target.id, at));
        } else {
          const c = st.workspaces.find((w) => w.id === target.id)!.compound!;
          st.updateWorkspace(await ipc.setCompound(target.id, { ...c, house: at }));
        }
        return true;
      } catch (e) {
        onError?.(e); // state is untouched: the store only updates after ipc succeeds
        return false;
      }
    }),
  };
}

/**
 * Keeps the village layout complete: every workspace gets a compound and every agent session a
 * spot as soon as it appears in the store. Terminals never get a spot. Returns an unsubscribe.
 */
export function autoLayout(onError: (e: unknown) => void = () => {}): () => void {
  const pending = new Set<string>();
  const run = (key: string, p: () => Promise<unknown>) => {
    if (pending.has(key)) return;
    pending.add(key);
    p().catch(onError).finally(() => pending.delete(key));
  };
  const check = (st: AppState) => {
    for (const w of st.workspaces) if (!w.compound) run(`ws:${w.id}`, () => st.village.ensureCompound(w.id));
    for (const s of Object.values(st.sessions))
      if (s.kind.kind === 'agent' && !s.spot) run(`s:${s.id}`, () => st.village.ensureSpot(s.id));
  };
  check(useApp.getState());
  return useApp.subscribe(check);
}
