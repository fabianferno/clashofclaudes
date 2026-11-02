import { create } from 'zustand';
import { ipc } from '../api/ipc';
import type { AgentInfo, AgentKind, AgentQuota, AppPreview, Todo, Builder, CloseOutcome, Compound, ListState, SessionInfo, SessionState, Stats, Tile, Workspace } from '../api/types';
import { HOUSE, STRUCT, canPlace, compoundFits, gapBetween, placeCompound, shiftCompound, spotFor, wallRect } from '../village/layout';
import { collectorFits, collectorTiles, shownCollectors } from '../village/quota';

export type Selection =
  | { kind: 'hall' }
  /** `builder`: open the new-session form with this idle builder picked (dropped on the workspace). */
  | { kind: 'workspace'; id: string; builder?: string }
  | { kind: 'session'; id: string }
  | { kind: 'builder'; id: string }
  | { kind: 'quota'; agent: AgentKind };

export interface VillageActions {
  /** The workspace's compound, placing and persisting one first if it has none. */
  ensureCompound: (wsId: string) => Promise<Compound>;
  /**
   * The session's spot (agent tent or terminal rune stone), finding (expanding the compound if full) and persisting one if it has none.
   * Shifting the other structures of a relocated compound never stops at one failure (a mate may have
   * closed meanwhile): the rest are still shifted and the failures are reported once via `onError`
   * (default: the app's error toast).
   */
  ensureSpot: (sessionId: string, onError?: (e: unknown) => void) => Promise<Tile>;
  /** A board's spot (see `boardItems`), found the same way; null when the board went away first. */
  ensureBoardSpot: (key: string, onError?: (e: unknown) => void) => Promise<Tile | null>;
  /**
   * Persist a move to `at`: a structure (session), a compound's house within its walls (workspace),
   * a whole compound (`at` its new interior origin) or a collector; false (and no ipc) when blocked.
   */
  commitMove: (target: MoveTarget, at: Tile, onError?: (e: unknown) => void) => Promise<boolean>;
}

export type MoveTarget =
  | { kind: 'session'; id: string }
  | { kind: 'workspace'; id: string }
  | { kind: 'compound'; id: string }
  | { kind: 'collector'; agent: AgentKind }
  /** An app or browser board, by its `boardItems` key. */
  | { kind: 'board'; key: string };

type MoveState = Pick<AppState, 'workspaces' | 'sessions'> & Partial<Pick<AppState, 'quotas' | 'agents' | 'collectorSpots' | 'boardSpots'>>;

/** An app's board, by workspace and port (workspace ids hold no ':'). */
export const boardKey = (a: Pick<AppPreview, 'workspaceId' | 'port'>): string => `${a.workspaceId}:${a.port}`;

/** A browser the owner opened in a workspace (not persisted, like sessions). */
export interface Browser { id: string; workspaceId: string; url: string }

/** Everything that stands as a board: the owner's browsers, then the detected apps they do not already show. */
export interface BoardItem {
  key: string;
  workspaceId: string;
  url: string;
  /** The page title or process name (apps), or the host (browsers). */
  label: string;
  port: number | null;
  frameable: boolean;
  /** Set for a browser the owner opened (it can be closed and navigated). */
  browserId?: string;
}

const sameUrl = (a: string, b: string) => {
  try { return new URL(a).href === new URL(b).href; } catch { return a === b; }
};

export function boardItems(st: Pick<AppState, 'apps' | 'browsers'>): BoardItem[] {
  const opened: BoardItem[] = st.browsers.map((b) => {
    let label = b.url, port: number | null = null;
    try { const u = new URL(b.url); label = u.hostname; port = u.port ? Number(u.port) : null; } catch { /* shown as typed */ }
    return { key: `${b.workspaceId}:web-${b.id}`, workspaceId: b.workspaceId, url: b.url, label, port, frameable: true, browserId: b.id };
  });
  const found: BoardItem[] = st.apps
    .filter((a) => !st.browsers.some((b) => b.workspaceId === a.workspaceId && sameUrl(b.url, a.url)))
    .map((a) => ({ key: boardKey(a), workspaceId: a.workspaceId, url: a.url, label: a.title ?? a.command, port: a.port, frameable: a.frameable }));
  return [...opened, ...found];
}

/** A typed address as a URL to open: `localhost:3000` and bare hosts get http://; null unless http(s). */
export function browserUrl(typed: string): string | null {
  const t = typed.trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Top-left tiles of the app boards standing in a workspace's compound. */
export function boardSpotsIn(spots: Record<string, Tile> | undefined, wsId: string, except: string | null = null): Tile[] {
  return Object.entries(spots ?? {}).flatMap(([k, t]) => (k.startsWith(`${wsId}:`) && k !== except ? [t] : []));
}

/**
 * Whether the structure or house may stand with its top-left on `at`: inside its compound, clear of
 * everything else. A collector stands outside every compound (see `collectorFits`); a whole compound
 * keeps its walls GAP tiles from the hall and the other compounds, and a tile clear of every collector.
 */
export function moveValid(st: MoveState, target: MoveTarget, at: Tile): boolean {
  if (target.kind === 'collector' || target.kind === 'compound') {
    const compounds = st.workspaces.flatMap((w) => (w.compound ? [w.compound] : []));
    const shown = shownCollectors(st.quotas, st.agents?.filter((a) => a.installed).map((a) => a.kind));
    const tiles = collectorTiles(shown, st.collectorSpots, compounds);
    if (target.kind === 'collector') {
      if (!tiles[target.agent as keyof typeof tiles]) return false;
      return collectorFits(at, compounds, shown.filter((a) => a !== target.agent).map((a) => tiles[a]!));
    }
    const c = st.workspaces.find((w) => w.id === target.id)?.compound;
    if (!c) return false;
    const moved = shiftCompound(c, at.x - c.x0, at.y - c.y0);
    const walls = wallRect(moved);
    return compoundFits(moved, compounds.filter((o) => o !== c))
      && shown.every((a) => gapBetween({ x0: tiles[a]!.x, y0: tiles[a]!.y, w: STRUCT, h: STRUCT }, walls) >= 1);
  }
  if (target.kind === 'board') {
    const wsId = target.key.split(':')[0];
    const c = st.workspaces.find((w) => w.id === wsId)?.compound;
    if (!c || !st.boardSpots?.[target.key]) return false;
    const taken = Object.values(st.sessions).filter((x) => x.workspaceId === wsId && x.spot).map((x) => x.spot!)
      .concat(boardSpotsIn(st.boardSpots, wsId, target.key));
    return canPlace(c, taken, at, STRUCT);
  }
  const wsId = target.kind === 'workspace' ? target.id : st.sessions[target.id]?.workspaceId;
  const c = st.workspaces.find((w) => w.id === wsId)?.compound;
  if (!c) return false;
  const mates = (except: string | null) => Object.values(st.sessions)
    .filter((x) => x.workspaceId === wsId && x.spot && x.id !== except)
    .map((x) => x.spot!)
    .concat(boardSpotsIn(st.boardSpots, wsId!));
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
  error: string | null;
  setError: (e: string | null) => void;
  /** XP-earning close outcomes by session id, for the village to play the orbs; cleared once consumed. */
  lastClosed: Record<string, CloseOutcome>;
  /** A session was closed: pushes its notice(s) and remembers an earning outcome for the scene. Terminals stay silent. */
  onClosed: (o: CloseOutcome, sessionId?: string) => void;
  consumeClosed: (sessionId: string) => void;
  /** True once the first `hydrate` (listState) has completed. */
  loaded: boolean;
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
  /** The first `listState` failed: count as loaded (empty), so first-run UI still shows. */
  markLoaded: () => void;
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
  /** Latest quota reading per agent. */
  quotas: Partial<Record<AgentKind, AgentQuota>>;
  setQuota: (q: AgentQuota) => void;
  setQuotas: (qs: AgentQuota[]) => void;
  /** Collectors the owner has dragged (top-left tiles); the rest stand in their default slots. */
  collectorSpots: Partial<Record<AgentKind, Tile>>;
  setCollectorSpots: (spots: Partial<Record<AgentKind, Tile>>) => void;
  /** Local web apps found in the workspaces; setting them drops the boards of apps that are gone. */
  apps: AppPreview[];
  setApps: (a: AppPreview[]) => void;
  /** Where each app's board stands (top-left tile), by `boardKey`; not persisted. */
  boardSpots: Record<string, Tile>;
  /** The app popped out full-window from its board, if any (`browserId` for the owner's browsers). */
  appPopout: { url: string; title: string; browserId?: string } | null;
  setAppPopout: (a: { url: string; title: string; browserId?: string } | null) => void;
  /** The latest snapshot of each board's page, by url: a data: JPEG and when it was taken. */
  snapshots: Record<string, { data: string; at: number }>;
  setSnapshot: (url: string, data: string, at: number) => void;
  /** Full-window views open over the village (pop-outs, Kanban); the village stops drawing under them. */
  covers: number;
  /** Count one more cover; returns its removal. */
  cover: () => () => void;
  /** Tasks written down and not started yet, oldest first (persisted by the backend). */
  todos: Todo[];
  addTodo: (t: Todo) => void;
  removeTodo: (id: string) => void;
  /** The workspace whose Kanban is open full-page, if any. */
  kanban: string | null;
  setKanban: (workspaceId: string | null) => void;
  /** Browsers the owner opened, each standing as a board in its workspace. */
  browsers: Browser[];
  openBrowser: (workspaceId: string, url: string) => Browser;
  closeBrowser: (id: string) => void;
  setBrowserUrl: (id: string, url: string) => void;
  setBoardSpots: (spots: Record<string, Tile>) => void;
  /** A whole compound moved: its workspace and its sessions' new spots land in one update. */
  applyCompoundMove: (w: Workspace, sessions: SessionInfo[]) => void;
  addBuilder: (b: Builder) => void;
  updateBuilder: (b: Builder) => void;
  removeBuilder: (id: string) => void;
  /** Ask the village to fit a workspace's compound (the Workspace panel's Zoom in); `n` makes repeats distinct. */
  zoomRequest: { id: string; n: number } | null;
  requestZoom: (workspaceId: string) => void;
}

export const useApp = create<AppState>((set, get) => ({
  loaded: false,
  workspaces: [],
  builders: [],
  sessions: {},
  agents: [],
  stats: { shippedTotal: 0, recentShips: [] },
  quotas: {},
  collectorSpots: {},
  apps: [],
  boardSpots: {},
  appPopout: null,
  snapshots: {},
  covers: 0,
  todos: [],
  kanban: null,
  browsers: [],
  selectedSessionId: null,
  selection: null,
  panelOpen: false,
  village: villageActions(get),
  notices: [],
  error: null,
  setError: (error) => set({ error }),
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
      push(`+${o.xpGained} XP`, 'xp');
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
      loaded: true,
      workspaces: s.workspaces,
      builders: s.builders,
      sessions: Object.fromEntries(s.sessions.map((x) => [x.id, x])),
      ...(s.stats ? { stats: s.stats } : {}),
      ...(s.collectorSpots ? { collectorSpots: s.collectorSpots } : {}),
      ...(s.todos ? { todos: s.todos } : {}),
    }),
  markLoaded: () => set({ loaded: true }),
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
  // Upserts: a workspace (or builder) already present by id is replaced, never listed twice.
  addWorkspace: (w) => set((st) => ({ workspaces: upsertById(st.workspaces, w) })),
  updateWorkspace: (w) => set((st) => ({ workspaces: st.workspaces.map((x) => (x.id === w.id ? w : x)) })),
  removeWorkspace: (id) => set((st) => ({
    workspaces: st.workspaces.filter((x) => x.id !== id),
    browsers: st.browsers.filter((b) => b.workspaceId !== id),
    todos: st.todos.filter((t) => t.workspaceId !== id),
    ...(st.kanban === id ? { kanban: null } : {}),
  })),
  setStats: (stats) => set({ stats }),
  setQuota: (q) => set((st) => ({ quotas: { ...st.quotas, [q.agent]: q } })),
  setQuotas: (qs) => set((st) => ({ quotas: { ...st.quotas, ...Object.fromEntries(qs.map((q) => [q.agent, q])) } })),
  setCollectorSpots: (collectorSpots) => set({ collectorSpots }),
  setApps: (apps) => set((st) => ({ apps, ...prunedSpots({ ...st, apps }) })),
  openBrowser: (workspaceId, url) => {
    const b = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, workspaceId, url };
    set((st) => ({ browsers: [...st.browsers, b] }));
    return b;
  },
  closeBrowser: (id) =>
    set((st) => {
      const browsers = st.browsers.filter((b) => b.id !== id);
      return {
        browsers,
        ...prunedSpots({ ...st, browsers }),
        ...(st.appPopout?.browserId === id ? { appPopout: null } : {}),
      };
    }),
  setSnapshot: (url, data, at) => set((st) => ({ snapshots: { ...st.snapshots, [url]: { data, at } } })),
  cover: () => {
    set((st) => ({ covers: st.covers + 1 }));
    let done = false;
    return () => { if (!done) { done = true; set((st) => ({ covers: st.covers - 1 })); } };
  },
  addTodo: (t) => set((st) => ({ todos: [...st.todos.filter((x) => x.id !== t.id), t] })),
  removeTodo: (id) => set((st) => ({ todos: st.todos.filter((x) => x.id !== id) })),
  setKanban: (kanban) => set({ kanban }),
  setBrowserUrl: (id, url) => set((st) => ({ browsers: st.browsers.map((b) => (b.id === id ? { ...b, url } : b)) })),
  setBoardSpots: (boardSpots) => set({ boardSpots }),
  setAppPopout: (appPopout) => set({ appPopout }),
  applyCompoundMove: (w, moved) =>
    set((st) => {
      const sessions = { ...st.sessions };
      for (const s of moved) if (!sessions[s.id] || s.rev >= sessions[s.id].rev) sessions[s.id] = s;
      // boards are not persisted, so they move with their compound here
      const was = st.workspaces.find((x) => x.id === w.id)?.compound;
      const dx = was && w.compound ? w.compound.x0 - was.x0 : 0, dy = was && w.compound ? w.compound.y0 - was.y0 : 0;
      const boardSpots = dx || dy
        ? Object.fromEntries(Object.entries(st.boardSpots).map(([k, t]) => [k, k.startsWith(`${w.id}:`) ? { x: t.x + dx, y: t.y + dy } : t]))
        : st.boardSpots;
      return { workspaces: st.workspaces.map((x) => (x.id === w.id ? w : x)), sessions, boardSpots };
    }),
  addBuilder: (b) => set((st) => ({ builders: upsertById(st.builders, b) })),
  updateBuilder: (b) => set((st) => ({ builders: st.builders.map((x) => (x.id === b.id ? b : x)) })),
  removeBuilder: (id) => set((st) => ({ builders: st.builders.filter((x) => x.id !== id) })),
  zoomRequest: null,
  requestZoom: (id) => set((st) => ({ zoomRequest: { id, n: (st.zoomRequest?.n ?? 0) + 1 } })),
}));

/** The board spots of boards that still stand (`{}` when none went away, so the store keeps its object). */
function prunedSpots(st: Pick<AppState, 'apps' | 'browsers' | 'boardSpots'>): Partial<Pick<AppState, 'boardSpots'>> {
  const live = new Set(boardItems(st).map((b) => b.key));
  const kept = Object.entries(st.boardSpots).filter(([k]) => live.has(k));
  return kept.length !== Object.keys(st.boardSpots).length ? { boardSpots: Object.fromEntries(kept) } : {};
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];
}

/** Whether the selection's target still exists (the hall always does). */
function selectionAlive(st: Pick<AppState, 'selection' | 'workspaces' | 'builders' | 'sessions'>): boolean {
  const sel = st.selection;
  if (!sel || sel.kind === 'hall') return true;
  if (sel.kind === 'workspace') return st.workspaces.some((w) => w.id === sel.id);
  if (sel.kind === 'builder') return st.builders.some((b) => b.id === sel.id);
  if (sel.kind === 'quota') return true;
  return sel.id in st.sessions;
}

// A selection never outlives its target: the panel (and the scene's/HUD's room for it) goes away with it.
useApp.subscribe((st, prev) => {
  if (st.workspaces === prev.workspaces && st.builders === prev.builders && st.sessions === prev.sessions) return;
  if (!selectionAlive(st)) st.setSelection(null);
});

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

  /**
   * A free spot for a structure or board in the workspace's compound, expanding it (and moving what
   * stands in it) when it is full. `exceptSession`/`exceptBoard` is the thing being placed.
   */
  const freeSpot = async (wsId: string, exceptSession: string | null, exceptBoard: string | null, onError: (e: unknown) => void): Promise<Tile> => {
    const c = await compoundOf(wsId);
    const st = get();
    const mates = Object.values(st.sessions).filter((x) => x.id !== exceptSession && x.workspaceId === wsId && x.spot);
    const boards = Object.keys(st.boardSpots).filter((k) => k.startsWith(`${wsId}:`) && k !== exceptBoard);
    const all = st.workspaces.flatMap((w) => (w.compound ? [w.compound] : []));
    const r = spotFor(c, all, [...mates.map((x) => x.spot!), ...boards.map((k) => st.boardSpots[k])]);
    if (r.expanded) get().updateWorkspace(await ipc.setCompound(wsId, r.compound));
    if (r.shift.x !== 0 || r.shift.y !== 0) {
      const failed: unknown[] = [];
      for (const m of mates) {
        const moved = { x: m.spot!.x + r.shift.x, y: m.spot!.y + r.shift.y };
        try { get().upsertSession(await ipc.setSessionSpot(m.id, moved)); } catch (e) { failed.push(e); }
      }
      const spots = { ...get().boardSpots };
      for (const k of boards) if (spots[k]) spots[k] = { x: spots[k].x + r.shift.x, y: spots[k].y + r.shift.y };
      get().setBoardSpots(spots);
      if (failed.length)
        onError(new Error(`Could not move ${failed.length} of ${mates.length} structures with their compound: ${String(failed[0])}`));
    }
    return r.spot;
  };

  const spotOf = async (sessionId: string, onError: (e: unknown) => void): Promise<Tile> => {
    const s = get().sessions[sessionId];
    if (!s) throw new Error(`unknown session ${sessionId}`);
    if (s.spot) return s.spot;
    const spot = await freeSpot(s.workspaceId, sessionId, null, onError);
    get().upsertSession(await ipc.setSessionSpot(sessionId, spot));
    return spot;
  };

  const boardSpotOf = async (key: string, onError: (e: unknown) => void): Promise<Tile | null> => {
    const item = boardItems(get()).find((b) => b.key === key);
    if (!item) return null; // gone before its turn came
    if (get().boardSpots[key]) return get().boardSpots[key];
    const spot = await freeSpot(item.workspaceId, null, key, onError);
    if (!boardItems(get()).some((b) => b.key === key)) return null;
    get().setBoardSpots({ ...get().boardSpots, [key]: spot });
    return spot;
  };

  return {
    ensureCompound: (wsId) => serial(() => compoundOf(wsId)),
    ensureSpot: (sessionId, onError) => serial(() => spotOf(sessionId, onError ?? ((e) => get().setError(String(e))))),
    ensureBoardSpot: (key, onError) => serial(() => boardSpotOf(key, onError ?? ((e) => get().setError(String(e))))),
    commitMove: (target, at, onError) => serial(async () => {
      const st = get();
      if (!moveValid(st, target, at)) return false;
      try {
        if (target.kind === 'board') {
          st.setBoardSpots({ ...st.boardSpots, [target.key]: at }); // boards are not persisted
        } else if (target.kind === 'session') {
          st.upsertSession(await ipc.setSessionSpot(target.id, at));
        } else if (target.kind === 'collector') {
          st.setCollectorSpots(await ipc.setCollectorSpot(target.agent, at));
        } else if (target.kind === 'compound') {
          const c = st.workspaces.find((w) => w.id === target.id)!.compound!;
          const r = await ipc.moveCompound(target.id, at.x - c.x0, at.y - c.y0);
          st.applyCompoundMove(r.workspace, r.sessions);
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
 * Keeps the village layout complete: every workspace gets a compound, and every agent session and app board a
 * spot as soon as it appears in the store (a terminal that already ended gets none). Returns an unsubscribe.
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
      if (!s.spot && !(s.kind.kind === 'terminal' && s.state.kind === 'ended')) run(`s:${s.id}`, () => st.village.ensureSpot(s.id, onError));
    for (const b of boardItems(st)) {
      if (!st.boardSpots[b.key] && st.workspaces.some((w) => w.id === b.workspaceId)) run(`b:${b.key}`, () => st.village.ensureBoardSpot(b.key, onError));
    }
  };
  check(useApp.getState());
  return useApp.subscribe(check);
}
