import { describe, expect, it } from 'vitest';
import { MAX_MINIONS, POP_IN, POP_OUT, minionSpots, popScale, shownMinions } from './minions';
import { onGround, walkable } from './walkers';

const tiles = (x0: number, y0: number, w: number, h: number) => {
  const s = new Set<string>();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) s.add(`${x},${y}`);
  return s;
};

describe('minions', () => {
  // the compound from the live check: 7x7 at (-6,12), house at (-2,12), tents at (-2,16) and (-6,14)
  const c = { x0: -6, y0: 12, w: 7, h: 7, house: { x: -2, y: 12 } };
  const inside = tiles(-6, 12, 7, 7);
  const walk = walkable(inside, c, [{ x: -2, y: 16 }, { x: -6, y: 14 }]);
  /** Whether nothing at all (building or wall) stands within `d` tiles in front of `p`. */
  const clearAhead = (p: { x: number; y: number }, d: number) => {
    for (let u = 0.2; u <= d; u += 0.2) if (!onGround(walk, { x: p.x + u, y: p.y + u })) return false;
    return true;
  };

  it('stand on open ground that no tent, house or wall in front of them covers', () => {
    const got = minionSpots({ x: -3.55, y: 15.1 }, walk, inside, MAX_MINIONS);
    expect(got).toHaveLength(MAX_MINIONS);
    const open = got.filter((p) => !p.huddled);
    expect(open.length).toBeGreaterThan(0);
    for (const p of open) {
      expect(onGround(walk, p)).toBe(true);
      expect(clearAhead(p, 1)).toBe(true);
    }
  });

  it('never stand just behind a tent (drawn under its roof)', () => {
    // the spot that looked like a minion on the roof: behind the tent at (-2,16)
    const behind = { x: -2.47, y: 15.57 };
    const got = minionSpots({ x: -2.9, y: 14.45 }, walk, inside, MAX_MINIONS);
    for (const p of got.filter((q) => !q.huddled)) expect(Math.hypot(p.x - behind.x, p.y - behind.y)).toBeGreaterThan(0.2);
    for (const p of got.filter((q) => !q.huddled)) {
      const inTentShadow = [0.4, 0.8, 1.2, 1.6, 2].some((u) => { const q = { x: p.x + u, y: p.y + u }; return q.x >= -2 && q.x < 0 && q.y >= 16 && q.y < 18; });
      expect(inTentShadow).toBe(false);
    }
  });

  it('keep apart from each other and their builder', () => {
    const open = walkable(inside, c, []);
    const got = minionSpots({ x: -4, y: 15 }, open, inside, 5);
    expect(got.every((p) => !p.huddled)).toBe(true);
    const all = [{ x: -4, y: 15 }, ...got];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) expect(Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y)).toBeGreaterThanOrEqual(0.45);
  });

  it('huddle at the builder\'s feet, in front of it, when there is no room', () => {
    const got = minionSpots({ x: 0.5, y: 0.5 }, new Set(), new Set(), 3);
    expect(got.every((p) => p.huddled && p.x + p.y > 1)).toBe(true);
  });

  it('show at most MAX_MINIONS, oldest first', () => {
    const ids = Array.from({ length: MAX_MINIONS + 3 }, (_, i) => `a${i}`);
    expect(shownMinions(ids)).toEqual(ids.slice(0, MAX_MINIONS));
    expect(shownMinions(['x'])).toEqual(['x']);
  });

  it('pop in with an overshoot and shrink away', () => {
    expect(popScale(0, null)).toBeCloseTo(0);
    expect(popScale(POP_IN / 2, null)).toBeGreaterThan(1);
    expect(popScale(POP_IN, null)).toBe(1);
    expect(popScale(10, null)).toBe(1);
    expect(popScale(10, 0)).toBe(1);
    expect(popScale(10, POP_OUT / 2)).toBeCloseTo(0.5);
    expect(popScale(10, POP_OUT * 2)).toBe(0);
  });
});
