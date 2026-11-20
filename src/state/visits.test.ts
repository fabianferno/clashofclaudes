import { expect, test } from 'vitest';
import type { VillageMap } from '../api/types';
import { visitInput, waitingIn } from './visits';

const map: VillageMap = {
  v: 1, host: 'h1', owner: 'ada', name: 'Ada', seen: 5,
  workspaces: [{ s: 'api', n: 'API', l: 4, a: 2, c: '#3d6fd6', p: [4, 5, 6, 7, 5, 6] }, { s: 'new', n: 'New', l: 1 }],
  builders: [{ p: 'wizard', n: 'Wizard', a: 'claude' }],
  sessions: [
    { i: 's1', r: 'msg_1', w: 'api', b: 'wizard', s: 'needs_you', t: 'decide', n: 77, a: 10, p: [7, 8], k: 3 },
    { i: 's2', w: 'api', b: 'wizard', s: 'working', n: 80, a: 11, p: [9, 8], k: 1 },
    { i: 's3', w: 'api', b: 'wizard', s: 'finished', t: 'review', n: 81, a: 12, k: 0 },
    { i: 's4', w: 'api', b: 'wizard', s: 'stuck', t: 'stuck', n: 82, a: 12, p: [1, 1], k: 0 },
    { i: 's5', w: 'api', b: 'wizard', s: 'paused', n: 83, a: 12, p: [2, 1], k: 0 },
    { i: 's6', w: 'gone', b: 'wizard', s: 'working', n: 84, a: 12, p: [3, 1], k: 0 },
  ],
};

test('a visited village becomes what the canvas draws', () => {
  const input = visitInput(map);
  expect(input.ownerName).toBe('Ada');
  expect(input.workspaces.map((w) => [w.id, w.name, w.stage, w.color, w.compound])).toEqual([
    ['api', 'API', 2, '#3d6fd6', { x0: 4, y0: 5, w: 6, h: 7, house: { x: 5, y: 6 } }],
    ['new', 'New', 0, undefined, null],
  ]);
  expect(input.builders).toEqual([{ id: 'wizard', name: 'Wizard', agent: 'claude', model: null, effort: null, customCommand: null }]);
  const s1 = input.sessions.find((s) => s.id === 's1')!;
  expect(s1).toMatchObject({ workspaceId: 'api', kind: { kind: 'agent', builderId: 'wizard' }, state: { kind: 'needsYou', reason: '' }, awaitingDecision: true, steps: 3, startedAt: 10, stateSince: 77, spot: { x: 7, y: 8 }, task: null });
  expect(input.sessions.find((s) => s.id === 's2')!.state).toEqual({ kind: 'working' });
  expect(input.sessions.find((s) => s.id === 's3')!).toMatchObject({ state: { kind: 'finished' }, reachedFinished: true, spot: null });
  expect(input.sessions.find((s) => s.id === 's4')!.state).toEqual({ kind: 'stuck', reason: '' });
  expect(input.sessions.find((s) => s.id === 's5')!).toMatchObject({ state: { kind: 'ended', exitCode: null }, paused: true });
  // a session whose workspace the map does not carry is not drawn
  expect(input.sessions.some((s) => s.id === 's6')).toBe(false);
  // nothing of the visitor's own village leaks in
  expect(input.quotas).toBeUndefined();
  expect(input.boards).toEqual([]);
});

test('how many wait there', () => {
  expect(waitingIn(map)).toBe(3);
});

test('visitInput falls back to l when a is missing (a map from an older app)', () => {
  const old: VillageMap = { ...map, workspaces: [{ s: 'api', n: 'API', l: 6 }], sessions: [] };
  expect(visitInput(old).workspaces[0].stage).toBe(3);
});
