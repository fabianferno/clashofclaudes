import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { Frame } from '../api/types';

const writes: Uint8Array[] = [];
let disposeCount = 0;
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24;
    loadAddon() {} open() {} onData() { return { dispose() {} }; }
    write(d: Uint8Array) { writes.push(d); }
    dispose() { disposeCount++; }
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
    },
  };
});
import TerminalView from './TerminalView';

const f = (offset: number, s: string): Frame => ({ offset, data: new TextEncoder().encode(s) });
const text = () => writes.map((w) => new TextDecoder().decode(w)).join('|');

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); writes.length = 0; log.length = 0; disposeCount = 0; });

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
