import { describe, expect, it } from 'vitest';
import { TW, TH, iso, toGrid } from './iso';

describe('iso', () => {
  it('iso_round_trip', () => {
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 200 - 100;
    for (let i = 0; i < 20; i++) {
      const p = { x: rnd(), y: rnd() };
      const q = toGrid(iso(p.x, p.y).x, iso(p.x, p.y).y);
      expect(q.x).toBeCloseTo(p.x, 9);
      expect(q.y).toBeCloseTo(p.y, 9);
    }
  });
  it('tile constants', () => {
    expect(TW).toBe(64);
    expect(TH).toBe(32);
    expect(iso(1, 0)).toEqual({ x: 32, y: 16 });
  });
});
