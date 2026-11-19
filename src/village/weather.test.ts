import type { SessionInfo, SessionState } from '../api/types';
import { NIGHT_AFTER_MS, onLightning, strike, weatherOf } from './weather';
import { boltPoints, tintOf } from './weatherFx';

const NOW = 1_000_000;
const ws = [{ id: 'w1', compound: { x0: 0, y0: 0, w: 8, h: 8, house: { x: 1, y: 1 } } }, { id: 'w2', compound: { x0: 10, y0: 0, w: 8, h: 8, house: { x: 11, y: 1 } } }];

const sess = (id: string, state: SessionState, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, workspaceId: 'w1', kind: { kind: 'agent', builderId: 'b' }, task: 't', state, steps: 0, startedAt: 0, lastOutputAt: 0,
  reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot: null,
  stateSince: NOW - 60_000, ...extra,
});

test('sunny while builders work and nothing waits; day when something waits', () => {
  expect(weatherOf([sess('a', { kind: 'working' })], ws, NOW).sky).toBe('sunny');
  expect(weatherOf([sess('a', { kind: 'starting' })], ws, NOW).sky).toBe('sunny');
  expect(weatherOf([sess('a', { kind: 'working' }), sess('b', { kind: 'finished' })], ws, NOW).sky).toBe('day');
  expect(weatherOf([sess('a', { kind: 'working' }), sess('b', { kind: 'needsYou', reason: 'q' })], ws, NOW).sky).toBe('day');
});

test('night once nothing has run for a while, not at once', () => {
  expect(weatherOf([], ws, NOW).sky).toBe('night');
  expect(weatherOf([sess('a', { kind: 'finished' })], ws, NOW).sky).toBe('night');
  const justDone = sess('a', { kind: 'finished' }, { stateSince: NOW - 5_000 });
  expect(weatherOf([justDone], ws, NOW).sky).toBe('day');
  expect(weatherOf([justDone], ws, NOW - 5_000 + NIGHT_AFTER_MS + 1).sky).toBe('night');
});

test('a terminal running a command keeps the day; one at its prompt does not', () => {
  const term = (busy: boolean) => sess('t', { kind: 'working' }, { kind: { kind: 'terminal' }, busy });
  expect(weatherOf([term(true)], ws, NOW).sky).toBe('sunny');
  expect(weatherOf([term(false)], ws, NOW).sky).toBe('night');
});

test('paused sessions and workspaces without a compound do not count', () => {
  expect(weatherOf([sess('a', { kind: 'working' }, { paused: true })], ws, NOW).sky).toBe('night');
  expect(weatherOf([sess('a', { kind: 'working' }, { workspaceId: 'gone' })], ws, NOW).sky).toBe('night');
});

test('a storm over each compound with a stuck session, not over a parked one', () => {
  const w = weatherOf([
    sess('a', { kind: 'stuck', reason: 'x' }, { workspaceId: 'w2' }),
    sess('b', { kind: 'stuck', reason: 'x' }, { workspaceId: 'w2' }),
    sess('c', { kind: 'stuck', reason: 'x' }, { workspaceId: 'w1', parked: '' }),
    sess('d', { kind: 'working' }),
  ], ws, NOW);
  expect(w.storms).toEqual(['w2']);
  expect(w.sky).toBe('day'); // the stuck one waits on the owner
});

test('the tint is clear by day, blue by night and warm in the sun', () => {
  expect(tintOf(0, 0).alpha).toBe(0);
  const night = tintOf(1, 0);
  expect(night.alpha).toBeGreaterThan(0.5);
  expect(night.color & 0xff).toBeGreaterThan((night.color >> 16) & 0xff); // more blue than red
  const sun = tintOf(0, 1);
  expect(sun.alpha).toBeLessThan(0.3);
  expect((sun.color >> 16) & 0xff).toBeGreaterThan(sun.color & 0xff); // more red than blue
});

test('a bolt runs from the cloud to the ground', () => {
  const pts = boltPoints(10, -200, 0, 3);
  expect(pts.slice(0, 2)).toEqual([10, -200]);
  expect(pts[pts.length - 1]).toBe(0);
  expect(pts.length).toBe(16);
});

test('lightning reaches its listeners until they leave', () => {
  const heard: string[] = [];
  const off = onLightning((id) => heard.push(id));
  strike('w1');
  off();
  strike('w2');
  expect(heard).toEqual(['w1']);
});
