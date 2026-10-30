import { vi } from 'vitest';
import { useApp, sessionsByWorkspace, idleBuilders, stateLabel } from './store';
import type { Builder, Compound, SessionInfo, SessionState, Tile, Workspace } from '../api/types';
import { ipc } from '../api/ipc';
import { GAP, assertNoCollisions, findSpot, placeCompound, spotFor } from '../village/layout';

vi.mock('../api/ipc', () => ({ ipc: { setCompound: vi.fn(), setSessionSpot: vi.fn() } }));

const sess = (id: string, ws: string, builderId?: string, startedAt = 0, state: SessionState = { kind: 'working' }): SessionInfo => ({
  id, workspaceId: ws, kind: builderId ? { kind: 'agent', builderId } : { kind: 'terminal' },
  task: null, state, steps: 0, startedAt, lastOutputAt: 0, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, rev: 1, spot: null,
});
const bld = (id: string): Builder => ({ id, name: id, agent: 'claude', model: null, effort: null, customCommand: null });

beforeEach(() => {
  useApp.setState({ workspaces: [], builders: [], sessions: {}, agents: [], selectedSessionId: null });
});

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

  it('ensureSpot creates the compound first when missing; terminals are refused', async () => {
    useApp.setState({ workspaces: [W('w1', null)] });
    useApp.getState().upsertSession(sess('a', 'w1', 'b1'));
    useApp.getState().upsertSession(sess('t', 'w1'));
    const v = useApp.getState().village;
    await v.ensureSpot('a');
    expect(useApp.getState().workspaces[0].compound).not.toBeNull();
    await expect(v.ensureSpot('t')).rejects.toThrow(/terminal/);
    expect(ipc.setSessionSpot).toHaveBeenCalledTimes(1);
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
