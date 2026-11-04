import { vi } from 'vitest';
import type { CloseOutcome } from '../api/types';
import { autoLayout, boardItems, boardKey, browserUrl, moveValid, useApp, sessionsByWorkspace, idleBuilders, stateLabel } from './store';
import type { AppPreview, Builder, Compound, SessionInfo, SessionState, Tile, Workspace } from '../api/types';
import { ipc } from '../api/ipc';
import { GAP, assertNoCollisions, findSpot, placeCompound, shiftCompound, spotFor } from '../village/layout';

vi.mock('../api/ipc', () => ({ ipc: { setCompound: vi.fn(), setSessionSpot: vi.fn(), setCollectorSpot: vi.fn(), moveCompound: vi.fn() } }));

const sess = (id: string, ws: string, builderId?: string, startedAt = 0, state: SessionState = { kind: 'working' }): SessionInfo => ({
  id, workspaceId: ws, kind: builderId ? { kind: 'agent', builderId } : { kind: 'terminal' },
  task: null, state, steps: 0, startedAt, lastOutputAt: 0, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot: null,
});
const bld = (id: string): Builder => ({ id, name: id, agent: 'claude', model: null, effort: null, customCommand: null });

beforeEach(() => {
  useApp.setState({ workspaces: [], builders: [], sessions: {}, agents: [], selectedSessionId: null, apps: [], boardSpots: {}, appPopout: null, browsers: [], hiddenApps: [] });
});

const appIn = (ws: string, port: number): AppPreview =>
  ({ workspaceId: ws, port, url: `http://localhost:${port}/`, title: null, frameable: true, command: 'node' });

test('upsert then remove session', () => {
  useApp.getState().upsertSession(sess('s1', 'w1'));
  expect(useApp.getState().sessions.s1).toBeDefined();
  useApp.getState().removeSession('s1');
  expect(useApp.getState().sessions.s1).toBeUndefined();
});

test('removing selected session clears selection', () => {
  useApp.getState().upsertSession(sess('s1', 'w1'));
  useApp.getState().select('s1');
  useApp.getState().removeSession('s1');
  expect(useApp.getState().selectedSessionId).toBeNull();
});

test('idleBuilders excludes busy builders', () => {
  useApp.getState().addBuilder(bld('b1'));
  useApp.getState().addBuilder(bld('b2'));
  useApp.getState().upsertSession(sess('s1', 'w1', 'b1'));
  expect(idleBuilders(useApp.getState()).map((b) => b.id)).toEqual(['b2']);
  useApp.getState().upsertSession(sess('s1', 'w1', 'b1', 0, { kind: 'ended', exitCode: 0 }));
  expect(idleBuilders(useApp.getState()).map((b) => b.id)).toEqual(['b1', 'b2']);
});

test('sessionsByWorkspace sorts by startedAt', () => {
  const s = useApp.getState();
  s.upsertSession(sess('a', 'w1', undefined, 30));
  s.upsertSession(sess('b', 'w1', undefined, 10));
  s.upsertSession(sess('c', 'w2', undefined, 20));
  expect(sessionsByWorkspace(useApp.getState(), 'w1').map((x) => x.id)).toEqual(['b', 'a']);
});

test('stateLabel maps needsYou', () => {
  expect(stateLabel({ kind: 'needsYou', reason: 'x' })).toBe('Needs you');
});

test('updateWorkspace replaces the matching workspace', () => {
  const w = (id: string, missing = false) => ({ id, name: id, path: `/p/${id}`, createdAt: 0, missing, level: 1, xp: 0, compound: null });
  useApp.getState().addWorkspace(w('w1'));
  useApp.getState().addWorkspace(w('w2'));
  useApp.getState().updateWorkspace(w('w2', true));
  expect(useApp.getState().workspaces.map((x) => [x.id, x.missing])).toEqual([['w1', false], ['w2', true]]);
});

test('stale_rev_is_ignored', () => {
  useApp.getState().upsertSession({ ...sess('s1', 'w1'), rev: 5, steps: 5 });
  useApp.getState().upsertSession({ ...sess('s1', 'w1'), rev: 4, steps: 4 });
  expect(useApp.getState().sessions.s1.rev).toBe(5);
  expect(useApp.getState().sessions.s1.steps).toBe(5);
  useApp.getState().upsertSession({ ...sess('s1', 'w1'), rev: 5, steps: 6 });
  expect(useApp.getState().sessions.s1.steps).toBe(6);
});

// ---- village slice ----
describe('village', () => {
  const W = (id: string, compound: Compound | null): Workspace =>
    ({ id, name: id, path: `/p/${id}`, createdAt: 0, missing: false, level: 1, xp: 0, compound });

  beforeEach(() => {
    vi.mocked(ipc.setCompound).mockReset().mockImplementation(async (id, c) => ({
      ...useApp.getState().workspaces.find((w) => w.id === id)!, compound: c,
    }));
    vi.mocked(ipc.setSessionSpot).mockReset().mockImplementation(async (id, spot) => {
      const s = useApp.getState().sessions[id];
      return { ...s, spot, rev: s.rev + 1 };
    });
  });

  it('ensureCompound places once and persists', async () => {
    useApp.setState({ workspaces: [W('w1', null), W('w2', null)] });
    const v = useApp.getState().village;
    const [a, b] = await Promise.all([v.ensureCompound('w1'), v.ensureCompound('w2')]);
    assertNoCollisions([a, b]);
    expect(ipc.setCompound).toHaveBeenCalledTimes(2);
    expect(useApp.getState().workspaces.map((w) => w.compound)).toEqual([a, b]);
    await expect(v.ensureCompound('w1')).resolves.toEqual(a);
    expect(ipc.setCompound).toHaveBeenCalledTimes(2);
  });

  it('concurrent ensureSpot calls get distinct spots (serialized)', async () => {
    const c = placeCompound([]);
    useApp.setState({ workspaces: [W('w1', c)] });
    for (const id of ['a', 'b', 'c']) useApp.getState().upsertSession(sess(id, 'w1', 'b1'));
    const v = useApp.getState().village;
    const spots = await Promise.all(['a', 'b', 'c'].map((id) => v.ensureSpot(id)));
    const keys = new Set(spots.map((t) => `${t.x},${t.y}`));
    expect(keys.size).toBe(3);
    expect(Object.values(useApp.getState().sessions).every((s) => s.spot)).toBe(true);
  });

  it('ensureSpot creates the compound first when missing; terminals get a spot of their own', async () => {
    useApp.setState({ workspaces: [W('w1', null)] });
    useApp.getState().upsertSession(sess('a', 'w1', 'b1'));
    useApp.getState().upsertSession(sess('t', 'w1'));
    const v = useApp.getState().village;
    const a = await v.ensureSpot('a');
    expect(useApp.getState().workspaces[0].compound).not.toBeNull();
    const t = await v.ensureSpot('t');
    expect(t).not.toEqual(a);
    expect(ipc.setSessionSpot).toHaveBeenCalledTimes(2);
  });

  it('autoLayout places live terminals but not ones that already ended', async () => {
    useApp.setState({ workspaces: [W('w1', null)] });
    useApp.getState().upsertSession(sess('t', 'w1'));
    useApp.getState().upsertSession(sess('old', 'w1', undefined, 0, { kind: 'ended', exitCode: 0 }));
    const stop = autoLayout();
    await vi.waitFor(() => expect(useApp.getState().sessions.t.spot).not.toBeNull());
    stop();
    expect(useApp.getState().sessions.old.spot).toBeNull();
  });

  it('autoLayout stands each app board on a spot of its own, clear of the structures', async () => {
    useApp.setState({ workspaces: [W('w1', null)] });
    useApp.getState().upsertSession(sess('a', 'w1', 'b1'));
    useApp.getState().setApps([appIn('w1', 3000), appIn('w1', 5173)]);
    const stop = autoLayout();
    await vi.waitFor(() => expect(Object.keys(useApp.getState().boardSpots)).toHaveLength(2));
    await vi.waitFor(() => expect(useApp.getState().sessions.a.spot).not.toBeNull());
    stop();
    const st = useApp.getState();
    const spots = [st.sessions.a.spot!, ...Object.values(st.boardSpots)].map((t) => `${t.x},${t.y}`);
    expect(new Set(spots).size).toBe(3);
    expect(ipc.setSessionSpot).toHaveBeenCalledTimes(1); // boards are not persisted
    // a structure may not be dragged onto a board
    expect(moveValid(st, { kind: 'session', id: 'a' }, st.boardSpots[boardKey(appIn('w1', 3000))])).toBe(false);
  });

  it('the owner\'s browsers stand as boards too, and stand in for an app at the same address', async () => {
    useApp.setState({ workspaces: [W('w1', placeCompound([]))] });
    useApp.getState().setApps([appIn('w1', 3000), appIn('w1', 4000)]);
    const b = useApp.getState().openBrowser('w1', 'http://localhost:3000/');
    const items = boardItems(useApp.getState());
    expect(items.map((x) => [x.label, x.port, x.browserId])).toEqual([['localhost', 3000, b.id], ['node', 4000, undefined]]);
    const stop = autoLayout();
    await vi.waitFor(() => expect(Object.keys(useApp.getState().boardSpots)).toHaveLength(2));
    stop();
    useApp.getState().closeBrowser(b.id);
    expect(Object.keys(useApp.getState().boardSpots)).toEqual([boardKey(appIn('w1', 4000))]);
    useApp.getState().openBrowser('w1', 'https://example.com');
    useApp.getState().removeWorkspace('w1');
    expect(useApp.getState().browsers).toEqual([]);
  });

  it('a board moves within its compound, never onto a structure, and nothing is persisted', async () => {
    const c = placeCompound([]);
    const s1 = findSpot(c, [])!;
    const s2 = findSpot(c, [s1])!;
    useApp.setState({ workspaces: [W('w1', c)], boardSpots: { 'w1:3000': s2 } });
    useApp.getState().upsertSession({ ...sess('a', 'w1', 'b1'), spot: s1 });
    useApp.getState().setApps([appIn('w1', 3000)]);
    const t = { kind: 'board', key: 'w1:3000' } as const;
    const v = useApp.getState().village;
    expect(await v.commitMove(t, s1)).toBe(false); // the structure's spot
    expect(await v.commitMove(t, { x: c.x0 + c.w + 5, y: c.y0 })).toBe(false); // outside the walls
    const free = findSpot(c, [s1, s2])!;
    expect(await v.commitMove(t, free)).toBe(true);
    expect(useApp.getState().boardSpots['w1:3000']).toEqual(free);
    expect(ipc.setSessionSpot).not.toHaveBeenCalled();
  });

  it('a removed app board stays down until its server stops, then comes back with it', () => {
    const c = placeCompound([]);
    useApp.setState({ workspaces: [W('w1', c)], hiddenApps: [], boardSpots: { 'w1:3000': { x: c.x0, y: c.y0 } } });
    useApp.getState().setApps([appIn('w1', 3000)]);
    useApp.getState().setAppPopout({ url: 'http://localhost:3000/', title: 'x', key: 'w1:3000' });
    useApp.getState().removeBoard({ key: 'w1:3000' });
    expect(boardItems(useApp.getState())).toEqual([]);
    expect(useApp.getState().boardSpots).toEqual({});
    expect(useApp.getState().appPopout).toBeNull();
    useApp.getState().setApps([appIn('w1', 3000)]); // still running: still hidden
    expect(boardItems(useApp.getState())).toEqual([]);
    useApp.getState().setApps([]); // stopped
    useApp.getState().setApps([appIn('w1', 3000)]); // started again
    expect(boardItems(useApp.getState()).map((b) => b.key)).toEqual(['w1:3000']);
  });

  it('autoLayout stands a board anew when its spot is no longer free', async () => {
    const c = placeCompound([]);
    useApp.setState({ workspaces: [W('w1', c)], boardSpots: { 'w1:3000': { x: c.x0 + c.w - 1, y: c.y0 } } }); // half in the wall
    useApp.getState().setApps([appIn('w1', 3000)]);
    const stop = autoLayout();
    try {
      await vi.waitFor(() => {
        const t = useApp.getState().boardSpots['w1:3000'];
        expect(t && moveValid(useApp.getState(), { kind: 'board', key: 'w1:3000' }, t)).toBe(true);
      });
    } finally {
      stop();
    }
  });

  it('a typed address becomes an http(s) url', () => {
    expect(browserUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(browserUrl(' https://example.com/a ')).toBe('https://example.com/a');
    expect(browserUrl('example.com')).toBe('http://example.com/');
    expect(browserUrl('ftp://x')).toBeNull();
    expect(browserUrl('')).toBeNull();
  });

  it('a board goes away with its app, and moves with its compound', () => {
    const c = placeCompound([]);
    useApp.setState({ workspaces: [W('w1', c)], boardSpots: { 'w1:3000': { x: c.x0, y: c.y0 }, 'w1:4000': { x: c.x0 + 3, y: c.y0 } } });
    useApp.getState().setApps([appIn('w1', 3000)]);
    expect(Object.keys(useApp.getState().boardSpots)).toEqual(['w1:3000']);
    useApp.getState().applyCompoundMove(W('w1', shiftCompound(c, 2, -1)), []);
    expect(useApp.getState().boardSpots['w1:3000']).toEqual({ x: c.x0 + 2, y: c.y0 - 1 });
  });

  it('relocation keeps shifting past a failed mate and reports the failure once', async () => {
    const c: Compound = { x0: 8, y0: -3, w: 10, h: 10, house: { x: 8, y: 4 } };
    const other: Compound = { x0: 8 + 10 + 1 + GAP + 1, y0: -3, w: 7, h: 7, house: { x: 24, y: 1 } };
    const taken: Tile[] = [];
    for (let t = findSpot(c, taken); t; t = findSpot(c, taken)) taken.push(t);
    const pre = spotFor(c, [c, other], taken);
    expect(taken.length).toBeGreaterThan(2);
    useApp.setState({ workspaces: [W('w1', c), W('w2', other)] });
    taken.forEach((t, i) => useApp.getState().upsertSession({ ...sess(`s${i}`, 'w1', 'b1'), spot: t }));
    useApp.getState().upsertSession(sess('new', 'w1', 'b1'));
    const setS = vi.mocked(ipc.setSessionSpot);
    const ok = setS.getMockImplementation()!;
    setS.mockImplementation(async (id, spot) => {
      if (id === 's0') throw 'unknown session s0'; // closed mid-relocation
      return ok(id, spot);
    });
    const errs: unknown[] = [];
    const spot = await useApp.getState().village.ensureSpot('new', (e) => errs.push(e));
    expect(spot).toEqual(pre.spot);
    expect(errs).toHaveLength(1);
    expect(String(errs[0])).toMatch(/1 of \d+ structures.*unknown session s0/);
    taken.forEach((t, i) => {
      if (i === 0) return;
      expect(useApp.getState().sessions[`s${i}`].spot).toEqual({ x: t.x + pre.shift.x, y: t.y + pre.shift.y });
    });
    expect(useApp.getState().sessions.new.spot).toEqual(pre.spot);
  });

  it('relocation persists the compound first, then shifts the other spots', async () => {
    // East of the hall, hemmed in: the hall blocks growth west, a neighbour blocks growth east.
    const c: Compound = { x0: 8, y0: -3, w: 7, h: 7, house: { x: 8, y: 1 } };
    const other: Compound = { x0: 8 + 7 + 1 + GAP + 1, y0: -3, w: 7, h: 7, house: { x: 21, y: 1 } };
    const taken: Tile[] = [];
    for (let t = findSpot(c, taken); t; t = findSpot(c, taken)) taken.push(t);
    const pre = spotFor(c, [c, other], taken);
    expect(pre.expanded).toBe(true);
    expect(pre.shift.x !== 0 || pre.shift.y !== 0).toBe(true);
    useApp.setState({ workspaces: [W('w1', c), W('w2', other)] });
    taken.forEach((t, i) => useApp.getState().upsertSession({ ...sess(`s${i}`, 'w1', 'b1'), spot: t }));
    useApp.getState().upsertSession(sess('new', 'w1', 'b1'));
    await useApp.getState().village.ensureSpot('new');
    const setC = vi.mocked(ipc.setCompound);
    const setS = vi.mocked(ipc.setSessionSpot);
    expect(setC).toHaveBeenCalledTimes(1);
    expect(setC.mock.calls[0][1]).toEqual(pre.compound);
    expect(setS).toHaveBeenCalledTimes(taken.length + 1);
    expect(setC.mock.invocationCallOrder[0]).toBeLessThan(Math.min(...setS.mock.invocationCallOrder));
    taken.forEach((t, i) =>
      expect(useApp.getState().sessions[`s${i}`].spot).toEqual({ x: t.x + pre.shift.x, y: t.y + pre.shift.y }));
    expect(useApp.getState().sessions.new.spot).toEqual(pre.spot);
    expect(useApp.getState().workspaces[0].compound).toEqual(pre.compound);
  });
});

describe('commitMove', () => {
  const c: Compound = { x0: 6, y0: 6, w: 8, h: 8, house: { x: 6, y: 6 } };
  const ws = { id: 'w1', compound: c } as unknown as Workspace;
  beforeEach(() => {
    vi.mocked(ipc.setSessionSpot).mockReset();
    vi.mocked(ipc.setCompound).mockReset();
    useApp.setState({ workspaces: [ws], sessions: {} });
    useApp.getState().upsertSession({ ...sess('s1', 'w1', 'b1'), spot: { x: 10, y: 10 } });
    useApp.getState().upsertSession({ ...sess('s2', 'w1', 'b2'), spot: { x: 12, y: 6 } });
  });

  it('release_on_red_does_not_persist', async () => {
    const t = { kind: 'session', id: 's1' } as const;
    expect(await useApp.getState().village.commitMove(t, { x: 12, y: 6 })).toBe(false); // on s2
    expect(await useApp.getState().village.commitMove(t, { x: 6, y: 6 })).toBe(false); // on the house
    expect(await useApp.getState().village.commitMove(t, { x: 13, y: 10 })).toBe(false); // out of the compound
    expect(ipc.setSessionSpot).not.toHaveBeenCalled();
    expect(ipc.setCompound).not.toHaveBeenCalled();
  });

  it('release_on_green_persists_once', async () => {
    vi.mocked(ipc.setSessionSpot).mockImplementation(async (id, spot) => ({ ...sess(id, 'w1', 'b1'), spot, rev: 2 }));
    expect(await useApp.getState().village.commitMove({ kind: 'session', id: 's1' }, { x: 10, y: 11 })).toBe(true);
    expect(ipc.setSessionSpot).toHaveBeenCalledTimes(1);
    expect(ipc.setSessionSpot).toHaveBeenCalledWith('s1', { x: 10, y: 11 });
    expect(useApp.getState().sessions.s1.spot).toEqual({ x: 10, y: 11 });
  });

  it('house_move_persists_compound_and_ignores_its_own_tile', async () => {
    vi.mocked(ipc.setCompound).mockImplementation(async (_id, comp) => ({ ...ws, compound: comp }) as Workspace);
    const t = { kind: 'workspace', id: 'w1' } as const;
    expect(await useApp.getState().village.commitMove(t, { x: 9, y: 9 })).toBe(false); // covers s1 (10,10)
    expect(ipc.setCompound).not.toHaveBeenCalled();
    expect(await useApp.getState().village.commitMove(t, { x: 7, y: 7 })).toBe(true); // overlaps its own old tile only
    expect(ipc.setCompound).toHaveBeenCalledWith('w1', { ...c, house: { x: 7, y: 7 } });
    expect(useApp.getState().workspaces[0].compound?.house).toEqual({ x: 7, y: 7 });
  });

  it('rejected_ipc_returns_false_leaves_state_and_reports', async () => {
    vi.mocked(ipc.setSessionSpot).mockRejectedValue(new Error('boom'));
    const errs: unknown[] = [];
    const before = useApp.getState().sessions.s1;
    expect(await useApp.getState().village.commitMove({ kind: 'session', id: 's1' }, { x: 10, y: 11 }, (e) => errs.push(e))).toBe(false);
    expect(useApp.getState().sessions.s1).toBe(before);
    expect(errs).toHaveLength(1);
    expect(String(errs[0])).toContain('boom');
    vi.mocked(ipc.setCompound).mockRejectedValue(new Error('nope'));
    expect(await useApp.getState().village.commitMove({ kind: 'workspace', id: 'w1' }, { x: 7, y: 7 }, (e) => errs.push(e))).toBe(false);
    expect(useApp.getState().workspaces[0]).toBe(ws);
    expect(errs).toHaveLength(2);
  });
});

describe('collector moves', () => {
  const agent = (kind: 'claude' | 'codex') => ({ kind, label: kind, installed: true, version: null, models: [], efforts: [], canApprove: false });
  beforeEach(() => {
    vi.mocked(ipc.setCollectorSpot).mockReset();
    useApp.setState({ workspaces: [], sessions: {}, quotas: {}, collectorSpots: {}, agents: [agent('claude'), agent('codex')] });
  });

  it('a_collector_drops_on_open_ground_and_is_remembered', async () => {
    vi.mocked(ipc.setCollectorSpot).mockImplementation(async (a, spot) => ({ [a]: spot }));
    const t = { kind: 'collector', agent: 'codex' } as const;
    expect(await useApp.getState().village.commitMove(t, { x: -6, y: -6 })).toBe(true);
    expect(ipc.setCollectorSpot).toHaveBeenCalledWith('codex', { x: -6, y: -6 });
    expect(useApp.getState().collectorSpots).toEqual({ codex: { x: -6, y: -6 } });
  });

  it('a_collector_never_lands_on_the_hall_another_collector_or_a_hidden_agent', async () => {
    const st = useApp.getState();
    expect(await st.village.commitMove({ kind: 'collector', agent: 'codex' }, { x: 0, y: 0 })).toBe(false); // the hall
    expect(await st.village.commitMove({ kind: 'collector', agent: 'codex' }, { x: -5, y: 3 })).toBe(false); // Claude's tank
    expect(await st.village.commitMove({ kind: 'collector', agent: 'antigravity' }, { x: -6, y: -6 })).toBe(false); // not installed
    expect(ipc.setCollectorSpot).not.toHaveBeenCalled();
  });
});

describe('compound moves', () => {
  // walls (5..14, 5..14); another compound's walls start at x 25
  const c: Compound = { x0: 6, y0: 6, w: 8, h: 8, house: { x: 6, y: 6 } };
  const other: Compound = { x0: 26, y0: 6, w: 8, h: 8, house: { x: 26, y: 6 } };
  const ws = (id: string, compound: Compound) => ({ id, compound }) as unknown as Workspace;
  beforeEach(() => {
    vi.mocked(ipc.moveCompound).mockReset();
    useApp.setState({ workspaces: [ws('w1', c), ws('w2', other)], sessions: {}, quotas: {}, collectorSpots: {}, agents: [] });
    useApp.getState().upsertSession({ ...sess('s1', 'w1', 'b1'), spot: { x: 10, y: 10 } });
  });

  it('a_compound_moves_with_its_structures_in_one_update', async () => {
    vi.mocked(ipc.moveCompound).mockImplementation(async (id, dx, dy) => ({
      workspace: ws(id, shiftCompound(c, dx, dy)),
      sessions: [{ ...sess('s1', 'w1', 'b1'), spot: { x: 10 + dx, y: 10 + dy }, rev: 2 }],
    }));
    const seen: string[] = [];
    const unsub = useApp.subscribe((st) => seen.push(`${st.workspaces[0].compound?.x0},${st.sessions.s1.spot?.x}`));
    expect(await useApp.getState().village.commitMove({ kind: 'compound', id: 'w1' }, { x: 6, y: 20 })).toBe(true);
    unsub();
    expect(ipc.moveCompound).toHaveBeenCalledWith('w1', 0, 14);
    expect(useApp.getState().workspaces[0].compound).toEqual({ ...c, y0: 20, house: { x: 6, y: 20 } });
    expect(useApp.getState().sessions.s1.spot).toEqual({ x: 10, y: 24 });
    expect(seen).toEqual(['6,10']); // compound and spots never land apart
  });

  it('a_compound_takes_its_boards_along_even_when_its_update_event_lands_first', async () => {
    const at = { x: c.x0 + 6, y: c.y0 }; // clear of the house (6..8) and s1 (10..11)
    useApp.setState({ boardSpots: { 'w1:3000': at }, hiddenApps: [], browsers: [] });
    useApp.getState().setApps([{ workspaceId: 'w1', port: 3000, url: 'http://localhost:3000/', title: null, frameable: true, command: 'node' }]);
    vi.mocked(ipc.moveCompound).mockImplementation(async (id, dx, dy) => {
      // the backend's workspace-updated event arrives before the command's result
      useApp.getState().updateWorkspace(ws(id, shiftCompound(c, dx, dy)));
      return { workspace: ws(id, shiftCompound(c, dx, dy)), sessions: [] };
    });
    // with the layout running, as in the app: the board must never be seen outside its walls
    const stop = autoLayout();
    try {
      expect(await useApp.getState().village.commitMove({ kind: 'compound', id: 'w1' }, { x: 6, y: 20 })).toBe(true);
      expect(useApp.getState().boardSpots['w1:3000']).toEqual({ x: at.x, y: at.y + 14 });
    } finally {
      stop();
    }
  });

  it('a_compound_keeps_its_distance_from_the_hall_other_compounds_and_collectors', async () => {
    const st = useApp.getState();
    const t = { kind: 'compound', id: 'w1' } as const;
    expect(await st.village.commitMove(t, { x: 2, y: 2 })).toBe(false); // over the hall
    expect(await st.village.commitMove(t, { x: 20, y: 6 })).toBe(false); // walls 3 tiles from w2's
    useApp.setState({
      agents: [{ kind: 'codex', label: 'Codex', installed: true, version: null, models: [], efforts: [], canApprove: false }],
      collectorSpots: { codex: { x: -10, y: 6 } },
    });
    expect(await st.village.commitMove(t, { x: -19, y: 6 })).toBe(false); // walls (x -20..-10) touch Codex's tank
    expect(ipc.moveCompound).not.toHaveBeenCalled();
    vi.mocked(ipc.moveCompound).mockResolvedValue({ workspace: ws('w1', shiftCompound(c, -27, 0)), sessions: [] });
    expect(await st.village.commitMove(t, { x: -21, y: 6 })).toBe(true); // a tile clear of it
  });
});

describe('close notices', () => {
  const out = (o: Partial<CloseOutcome> = {}): CloseOutcome => ({
    earnedXp: false, xpGained: 0, levelBefore: 1, levelAfter: 1, workspaceId: 'w1', unfinished: false, stuck: false, ...o,
  });
  const texts = () => useApp.getState().notices.map((n) => n.text);
  beforeEach(() => { vi.useFakeTimers(); useApp.setState({ notices: [], lastClosed: {} }); });
  afterEach(() => vi.useRealTimers());

  test('close_unfinished_shows_notice', () => {
    useApp.getState().onClosed(out({ unfinished: true }), 's1');
    expect(texts()).toEqual(['Closed \u2014 not finished, no XP']);
  });
  test('stuck beats unfinished', () => {
    useApp.getState().onClosed(out({ unfinished: true, stuck: true }), 's1');
    expect(texts()).toEqual(['Closed while stuck \u2014 no XP']);
  });
  test('earned shows +100 XP and records the outcome for the scene', () => {
    useApp.getState().onClosed(out({ earnedXp: true, xpGained: 100 }), 's1');
    expect(texts()).toEqual(['+100 XP']);
    expect(useApp.getState().lastClosed.s1.earnedXp).toBe(true);
    useApp.getState().consumeClosed('s1');
    expect(useApp.getState().lastClosed.s1).toBeUndefined();
  });
  test('xp notice shows the XP actually gained', () => {
    useApp.getState().onClosed(out({ earnedXp: true, xpGained: 140 }), 's1');
    expect(texts()).toEqual(['+140 XP']);
  });
  test('level_up_notice', () => {
    useApp.getState().onClosed(out({ earnedXp: true, xpGained: 100, levelBefore: 1, levelAfter: 2 }), 's1');
    expect(texts()).toEqual(['+100 XP', 'LEVEL UP! Level 2']);
    expect(useApp.getState().notices.map((n) => n.kind)).toEqual(['xp', 'level']);
  });
  test('terminal_close_is_silent', () => {
    useApp.getState().onClosed(out(), 's1');
    expect(texts()).toEqual([]);
    expect(useApp.getState().lastClosed).toEqual({});
  });
  test('notices expire after 3 s', () => {
    useApp.getState().onClosed(out({ unfinished: true }), 's1');
    vi.advanceTimersByTime(2999);
    expect(texts().length).toBe(1);
    vi.advanceTimersByTime(2);
    expect(texts()).toEqual([]);
  });
});

test('selection is cleared (panel closed) when its session disappears', () => {
  useApp.getState().upsertSession(sess('s1', 'w1', 'b1'));
  useApp.getState().setSelection({ kind: 'session', id: 's1' });
  expect(useApp.getState().panelOpen).toBe(true);
  useApp.getState().removeSession('s1');
  expect(useApp.getState().selection).toBeNull();
  expect(useApp.getState().panelOpen).toBe(false);
});

test('selection is cleared when its workspace disappears', () => {
  useApp.setState({ workspaces: [{ id: 'w1', name: 'w', path: '/w', createdAt: 0, missing: false, level: 1, xp: 0, compound: null }] });
  useApp.getState().setSelection({ kind: 'workspace', id: 'w1' });
  useApp.getState().removeWorkspace('w1');
  expect(useApp.getState().selection).toBeNull();
  expect(useApp.getState().panelOpen).toBe(false);
});

test('selection is cleared when its builder disappears; hall and other targets stay', () => {
  useApp.setState({ builders: [bld('b1'), bld('b2')] });
  useApp.getState().setSelection({ kind: 'builder', id: 'b1' });
  useApp.getState().removeBuilder('b2');
  expect(useApp.getState().selection).toEqual({ kind: 'builder', id: 'b1' });
  useApp.getState().removeBuilder('b1');
  expect(useApp.getState().selection).toBeNull();
  expect(useApp.getState().panelOpen).toBe(false);
  useApp.getState().setSelection({ kind: 'hall' });
  useApp.getState().removeBuilder('zzz');
  expect(useApp.getState().panelOpen).toBe(true);
});

test('adding a workspace or builder already present by id replaces it, never duplicates', () => {
  const w: Workspace = { id: 'w', name: 'a', path: '/a', createdAt: 0, missing: false, level: 1, xp: 0, compound: null };
  useApp.getState().addWorkspace(w);
  useApp.getState().addWorkspace({ ...w, name: 'b' });
  expect(useApp.getState().workspaces.map((x) => x.name)).toEqual(['b']);
  useApp.getState().addBuilder(bld('b1'));
  useApp.getState().addBuilder({ ...bld('b1'), name: 'Ada' });
  useApp.getState().addBuilder(bld('b2'));
  expect(useApp.getState().builders.map((x) => x.name)).toEqual(['Ada', 'b2']);
});
