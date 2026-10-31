import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { Frame } from '../api/types';

const writes: Array<Uint8Array | string> = [];
const writeDone: Array<() => void> = [];
let disposeCount = 0;
let created = 0;
let resets = 0;
let typed: (d: string) => void = () => {};
let termOptions: Record<string, unknown> = {};
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(o: Record<string, unknown>) { termOptions = o; created++; }
    cols = 80; rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {} open() {}
    onData(cb: (d: string) => void) { typed = cb; return { dispose() {} }; }
    write(d: Uint8Array | string, cb?: () => void) { writes.push(d); writeDone.push(cb ?? (() => {})); }
    dispose() { disposeCount++; }
    reset() { resets++; }
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));

const log: string[] = [];
let onFrame: (f: Frame) => void = () => {};
let resolveSnap: (f: Frame) => void = () => {};
vi.mock('../api/ipc', async () => {
  const actual = await vi.importActual<typeof import('../api/ipc')>('../api/ipc');
  return {
    trimSeen: actual.trimSeen,
    ipc: {
      resizeSession: vi.fn().mockResolvedValue(undefined),
      writeSession: vi.fn().mockResolvedValue(undefined),
      attachSession: vi.fn((_id: string, cb: (f: Frame) => void) => {
        log.push('attach'); onFrame = cb;
        return new Promise<Frame>((r) => { resolveSnap = r; });
      }),
      detachSession: vi.fn(async () => { log.push('detach'); }),
      ackOutput: vi.fn(async (_id: string, end: number) => { log.push(`ack ${end}`); }),
    },
  };
});
import TerminalView from './TerminalView';
import { ipc } from '../api/ipc';
import { screen } from '@testing-library/react';

const f = (offset: number, s: string): Frame => ({ offset, data: new TextEncoder().encode(s) });
const text = () => writes.map((w) => (typeof w === 'string' ? w : new TextDecoder().decode(w))).join('|');

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); writes.length = 0; writeDone.length = 0; log.length = 0; disposeCount = 0; created = 0; resets = 0;
  vi.mocked(ipc.attachSession).mockClear(); vi.mocked(ipc.detachSession).mockClear(); vi.mocked(ipc.resizeSession).mockClear(); vi.mocked(ipc.ackOutput).mockClear(); });

test('queues live frames until snapshot, trims overlap, ignores frames after unmount', async () => {
  const { unmount } = render(<TerminalView sessionId="t1" />);
  await vi.waitFor(() => expect(log).toEqual(['attach']));
  onFrame(f(2, 'cdef')); // arrives before snapshot; overlaps "c"
  expect(writes).toHaveLength(0);
  resolveSnap(f(0, 'abc'));
  await vi.waitFor(() => expect(text()).toBe('abc|def'));
  unmount();
  onFrame(f(7, 'late'));
  expect(text()).toBe('abc|def');
  expect(disposeCount).toBe(1);
  await vi.waitFor(() => expect(log).toEqual(['attach', 'detach']));
});

test('detach waits for attach to settle; next attach waits for detach', async () => {
  const a = render(<TerminalView sessionId="t2" />);
  await vi.waitFor(() => expect(log).toEqual(['attach']));
  a.unmount();
  const b = render(<TerminalView sessionId="t2" />);
  await Promise.resolve();
  expect(log).toEqual(['attach']); // detach not yet, second attach not yet
  resolveSnap(f(0, ''));
  await vi.waitFor(() => expect(log).toEqual(['attach', 'detach', 'attach']));
  b.unmount();
  resolveSnap(f(0, ''));
  await vi.waitFor(() => expect(log).toEqual(['attach', 'detach', 'attach', 'detach']));
});

test('acks each frame with its end offset only after xterm finished writing it', async () => {
  const { unmount } = render(<TerminalView sessionId="t3" />);
  await vi.waitFor(() => expect(log).toEqual(['attach']));
  resolveSnap(f(10, 'abc'));
  await vi.waitFor(() => expect(text()).toBe('abc'));
  expect(log).toEqual(['attach']); // not acked before the write completes
  writeDone[0]();
  expect(log).toEqual(['attach', 'ack 13']);
  onFrame(f(13, 'de'));
  expect(text()).toBe('abc|de');
  expect(log).toEqual(['attach', 'ack 13']);
  writeDone[1]();
  expect(log).toEqual(['attach', 'ack 13', 'ack 15']);
  onFrame(f(12, 'cd')); // fully seen: nothing written, still acked
  expect(text()).toBe('abc|de');
  expect(log).toEqual(['attach', 'ack 13', 'ack 15', 'ack 14']);
  onFrame({ offset: 15, data: new TextEncoder().encode('[skipped]'), marker: true });
  expect(text()).toBe('abc|de|[skipped]');
  onFrame(f(15, 'g')); // a marker does not advance the stream position
  expect(text()).toBe('abc|de|[skipped]|g');
  writeDone[writeDone.length - 1]();
  expect(log.filter((l) => l.startsWith('ack'))).toEqual(['ack 13', 'ack 15', 'ack 14', 'ack 16']);
  unmount();
});

test('read-only view of an ended session never resizes or writes', async () => {
  vi.mocked(ipc.resizeSession).mockClear();
  vi.mocked(ipc.writeSession).mockClear();
  vi.mocked(ipc.resizeSession).mockRejectedValue('session is not running');
  const { unmount, container } = render(<TerminalView sessionId="t4" readOnly />);
  await vi.waitFor(() => expect(log).toEqual(['attach']));
  typed('x');
  resolveSnap(f(0, 'bye'));
  await vi.waitFor(() => expect(text()).toBe('bye'));
  expect(ipc.resizeSession).not.toHaveBeenCalled();
  expect(ipc.writeSession).not.toHaveBeenCalled();
  expect(container.querySelector('.error')).toBeNull();
  expect(screen.queryByText(/not running/)).toBeNull();
  vi.mocked(ipc.resizeSession).mockResolvedValue(undefined);
  unmount();
});

test('keeps 2000 lines of scrollback', () => {
  // A full buffer costs ~4.7 MB at 5000 lines, ~1.9 MB at 2000 (docs/verification/plan-2-village.md).
  // xterm keeps the last 2000 lines; the backend keeps the last 2 MiB of raw output and replays it
  // on attach, so older output beyond those limits is not shown.
  const { unmount } = render(<TerminalView sessionId="t6" />);
  expect(termOptions.scrollback).toBe(2000);
  unmount();
});

test('reuses_terminal_across_session_switch', async () => {
  // Every new xterm builds a renderer, a WebGL context and a buffer; in a hidden webview xterm's
  // frame queue never drains and keeps the old buffers alive (docs/verification/plan-2-village.md).
  const { rerender, unmount } = render(<TerminalView sessionId="t7" />);
  await vi.waitFor(() => expect(log).toEqual(['attach']));
  const oldFrame = onFrame;
  resolveSnap(f(0, 'old'));
  await vi.waitFor(() => expect(text()).toBe('old'));

  rerender(<TerminalView sessionId="t8" />);
  await vi.waitFor(() => expect(log).toEqual(['attach', 'detach', 'attach']));
  expect(vi.mocked(ipc.detachSession).mock.calls).toEqual([['t7']]);
  expect(vi.mocked(ipc.attachSession).mock.calls.map((c) => c[0])).toEqual(['t7', 't8']);
  expect(created).toBe(1);
  expect(disposeCount).toBe(0);
  expect(vi.mocked(ipc.resizeSession).mock.lastCall).toEqual(['t8', 80, 24]);

  // The old session's queued output is parsed first, then the screen and scrollback are reset.
  expect(resets).toBe(0);
  writeDone[1]();
  expect(resets).toBe(1);
  // Late writes, frames and acks of the old session go nowhere.
  writeDone[0]();
  oldFrame(f(3, 'late'));
  expect(log.filter((l) => l.startsWith('ack'))).toEqual([]);

  resolveSnap(f(100, 'new'));
  await vi.waitFor(() => expect(text()).toBe('old||new'));
  writeDone[2]();
  expect(log.filter((l) => l.startsWith('ack'))).toEqual(['ack 103']);
  onFrame(f(103, '!'));
  expect(text()).toBe('old||new|!');

  unmount();
  expect(disposeCount).toBe(1);
  await vi.waitFor(() => expect(vi.mocked(ipc.detachSession).mock.calls).toEqual([['t7'], ['t8']]));
});

test('an error belongs to the session it happened in', async () => {
  vi.mocked(ipc.attachSession).mockImplementationOnce(async () => { log.push('attach'); throw 'unknown session t9'; });
  const { rerender, container, unmount } = render(<TerminalView sessionId="t9" />);
  await vi.waitFor(() => expect(container.querySelector('.error')?.textContent).toBe('unknown session t9'));
  rerender(<TerminalView sessionId="t10" />);
  await vi.waitFor(() => expect(log).toEqual(['attach', 'detach', 'attach']));
  expect(container.querySelector('.error')).toBeNull();
  // Back to t9, attaching fine this time: its old error is gone.
  resolveSnap(f(0, '')); // t10's snapshot
  rerender(<TerminalView sessionId="t9" />);
  await vi.waitFor(() => expect(vi.mocked(ipc.attachSession).mock.calls.map((c) => c[0])).toEqual(['t9', 't10', 't9']));
  resolveSnap(f(0, 'ok'));
  await vi.waitFor(() => expect(text()).toContain('ok'));
  expect(container.querySelector('.error')).toBeNull();
  unmount();
});
