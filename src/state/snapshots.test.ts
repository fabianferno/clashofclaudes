import { expect, test, vi } from 'vitest';
import type { AppPreview } from '../api/types';

vi.mock('../api/ipc', () => ({ ipc: {} }));
import { useApp } from './store';
import { SNAP_EVERY, SNAP_RETRY, nextSnapshot } from './snapshots';

const app = (port: number): AppPreview =>
  ({ workspaceId: 'w1', port, url: `http://localhost:${port}/`, title: null, frameable: true, command: 'node' });
const spots = { 'w1:3000': { x: 0, y: 0 }, 'w1:4000': { x: 3, y: 0 }, 'w1:5000': { x: 6, y: 0 } };
const now = 1_000_000;

test('pages with no picture come first, then the stalest; fresh ones and recent failures wait', () => {
  const st = { apps: [app(3000), app(4000), app(5000)], browsers: [], boardSpots: spots, snapshots: {} as Record<string, { data: string; at: number }> };
  expect(nextSnapshot(st, new Map(), now)).toBe('http://localhost:3000/');
  st.snapshots = {
    'http://localhost:3000/': { data: '', at: now - 1000 }, // fresh
    'http://localhost:4000/': { data: '', at: now - SNAP_EVERY - 5 },
  };
  expect(nextSnapshot(st, new Map(), now)).toBe('http://localhost:5000/'); // never pictured beats stale
  expect(nextSnapshot(st, new Map([['http://localhost:5000/', now - 10]]), now)).toBe('http://localhost:4000/');
  st.snapshots['http://localhost:5000/'] = { data: '', at: now - SNAP_EVERY - 50 };
  expect(nextSnapshot(st, new Map(), now)).toBe('http://localhost:5000/'); // the stalest
  st.snapshots['http://localhost:4000/'].at = now;
  st.snapshots['http://localhost:5000/'].at = now;
  expect(nextSnapshot(st, new Map(), now)).toBeNull();
  // a failure is retried once SNAP_RETRY has passed
  st.snapshots = {};
  const failed = new Map([['http://localhost:3000/', now - SNAP_RETRY - 1], ['http://localhost:4000/', now], ['http://localhost:5000/', now]]);
  expect(nextSnapshot(st, failed, now)).toBe('http://localhost:3000/');
  // a board with no spot yet is not pictured
  expect(nextSnapshot({ ...st, boardSpots: {} }, new Map(), now)).toBeNull();
});

test('covers count up and down once each', () => {
  const a = useApp.getState().cover();
  const b = useApp.getState().cover();
  expect(useApp.getState().covers).toBe(2);
  a();
  a();
  expect(useApp.getState().covers).toBe(1);
  b();
  expect(useApp.getState().covers).toBe(0);
});
