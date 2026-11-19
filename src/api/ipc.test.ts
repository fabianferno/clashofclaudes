import { vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { decodeFrame, ipc, trimSeen } from './ipc';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

function mk(offset: number, bytes: number[]): ArrayBuffer {
  const b = new ArrayBuffer(8 + bytes.length);
  new DataView(b).setBigUint64(0, BigInt(offset), true);
  new Uint8Array(b, 8).set(bytes);
  return b;
}

test('decodeFrame reads LE offset and payload', () => {
  const f = decodeFrame(mk(300, [1, 2, 3]));
  expect(f.offset).toBe(300);
  expect(Array.from(f.data)).toEqual([1, 2, 3]);
});

test('trimSeen: no overlap keeps all', () => {
  const r = trimSeen({ offset: 5, data: new Uint8Array([1, 2, 3]) }, 5);
  expect(Array.from(r.data)).toEqual([1, 2, 3]);
  expect(r.writtenUntil).toBe(8);
});

test('trimSeen: partial overlap drops seen prefix', () => {
  const r = trimSeen({ offset: 5, data: new Uint8Array([1, 2, 3]) }, 7);
  expect(Array.from(r.data)).toEqual([3]);
  expect(r.writtenUntil).toBe(8);
});

test('trimSeen: full overlap yields empty', () => {
  const r = trimSeen({ offset: 5, data: new Uint8Array([1, 2, 3]) }, 20);
  expect(r.data.length).toBe(0);
  expect(r.writtenUntil).toBe(20);
});

test('decodeFrame: header bit 63 marks a skip-marker frame', () => {
  const b = new ArrayBuffer(8 + 2);
  new DataView(b).setBigUint64(0, (1n << 63n) | 300n, true);
  new Uint8Array(b, 8).set([7, 8]);
  const f = decodeFrame(b);
  expect(f.marker).toBe(true);
  expect(f.offset).toBe(300);
  expect(Array.from(f.data)).toEqual([7, 8]);
  expect(decodeFrame(mk(5, [1])).marker).toBe(false);
});

test('decodes_close_outcome_shape: new fields pass through untouched', async () => {
  const outcome = { earnedXp: true, xpGained: 100, levelBefore: 1, levelAfter: 2, workspaceId: 'w1', unfinished: false };
  vi.mocked(invoke).mockResolvedValueOnce(outcome);
  await expect(ipc.closeSession('s1')).resolves.toEqual(outcome);
  expect(invoke).toHaveBeenCalledWith('close_session', { id: 's1', discard: false });
});

test('village commands use camelCase args', async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  const compound = { x0: 1, y0: 2, w: 3, h: 4, house: { x: 2, y: 3 } };
  await ipc.setCompound('w1', compound);
  expect(invoke).toHaveBeenCalledWith('set_compound', { workspaceId: 'w1', compound });
  await ipc.setSessionSpot('s1', { x: 1, y: 1 });
  expect(invoke).toHaveBeenCalledWith('set_session_spot', { id: 's1', spot: { x: 1, y: 1 } });
  await ipc.openInEditor('/p');
  expect(invoke).toHaveBeenCalledWith('open_in_editor', { path: '/p' });
  await ipc.openInFinder('/p');
  expect(invoke).toHaveBeenCalledWith('open_in_finder', { path: '/p' });
});

test('resume_session takes the session id', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ id: 's1' });
  await ipc.resumeSession('s1');
  expect(invoke).toHaveBeenCalledWith('resume_session', { id: 's1' });
});

test('the Team (Vercel Board) commands', async () => {
  const call = vi.mocked(invoke);
  call.mockClear();
  await ipc.boardStatus();
  await ipc.boardCheck();
  await ipc.setWorkspaceShared('w1', true);
  expect(call.mock.calls).toEqual([['board_status'], ['board_check'], ['set_workspace_shared', { workspaceId: 'w1', shared: true }]]);
});
