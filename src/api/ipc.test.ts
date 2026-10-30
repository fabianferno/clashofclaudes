import { decodeFrame, trimSeen } from './ipc';

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
