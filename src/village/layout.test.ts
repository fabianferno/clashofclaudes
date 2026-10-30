import { describe, expect, it } from 'vitest';
import type { Compound, Tile } from '../api/types';
import {
  GAP, GROW, HALL, HOUSE, START, STRUCT, Rect, assertNoCollisions, canPlace, expand,
  findSpot, gapBetween, gateSide, placeCompound, spotFor, wallRect,
} from './layout';

const sq = (t: Tile, s: number): Rect => ({ x0: t.x, y0: t.y, w: s, h: s });
const placeN = (n: number) => {
  const all: Compound[] = [];
  for (let i = 0; i < n; i++) all.push(placeCompound(all));
  return all;
};

describe('gapBetween', () => {
  it('counts empty tiles along the separating axis', () => {
    const a = { x0: 0, y0: 0, w: 2, h: 2 };
    expect(gapBetween(a, { x0: 2, y0: 0, w: 2, h: 2 })).toBe(0);
    expect(gapBetween(a, { x0: 5, y0: 0, w: 2, h: 2 })).toBe(3);
    expect(gapBetween(a, { x0: 5, y0: 9, w: 2, h: 2 })).toBe(7);
    expect(gapBetween(a, { x0: 1, y0: 1, w: 2, h: 2 })).toBeLessThan(0);
  });
});

describe('placeCompound', () => {
  it('first_compound_is_near_hall_and_clear', () => {
    const c = placeCompound([]);
    expect(c.w).toBe(START);
    expect(c.h).toBe(START);
    expect(gapBetween(wallRect(c), HALL)).toBeGreaterThanOrEqual(GAP);
    expect(c.house.x).toBeGreaterThanOrEqual(c.x0);
    expect(c.house.y).toBeGreaterThanOrEqual(c.y0);
    expect(c.house.x + HOUSE).toBeLessThanOrEqual(c.x0 + c.w);
    expect(c.house.y + HOUSE).toBeLessThanOrEqual(c.y0 + c.h);
    // corner nearest hall: house touches interior edges facing the hall
    const cx = c.x0 + c.w / 2, cy = c.y0 + c.h / 2;
    const hx = cx > 0.5 ? c.x0 : c.x0 + c.w - HOUSE;
    const hy = cy > 0.5 ? c.y0 : c.y0 + c.h - HOUSE;
    expect(c.house).toEqual({ x: hx, y: hy });
  });
  it('eight_compounds_never_overlap', () => {
    const all = placeN(8);
    assertNoCollisions(all);
    for (const c of all) expect(gapBetween(wallRect(c), HALL)).toBeGreaterThanOrEqual(GAP);
  });
});

describe('findSpot', () => {
  it('find_spot_prefers_gap_then_packs', () => {
    const c = placeCompound([]);
    const taken: Tile[] = [];
    for (let i = 0; i < 2; i++) {
      const s = findSpot(c, taken)!;
      expect(s).not.toBeNull();
      for (const o of [...taken.map((t) => sq(t, STRUCT)), sq(c.house, HOUSE)])
        expect(gapBetween(sq(s, STRUCT), o)).toBeGreaterThanOrEqual(1);
      taken.push(s);
    }
    let n = 2;
    for (;;) {
      const s = findSpot(c, taken);
      if (!s) break;
      expect(canPlace(c, taken, s, STRUCT)).toBe(true);
      taken.push(s);
      n++;
      expect(n).toBeLessThan(50);
    }
    expect(n).toBeGreaterThan(2);
    expect(findSpot(c, taken)).toBeNull();
  });
});

describe('spotFor', () => {
  it('twelve_sessions_expand_without_collision', () => {
    const all = placeN(4);
    let taken: Tile[] = [];
    let expandedAny = false;
    for (let i = 0; i < 12; i++) {
      const r = spotFor(all[0], all, taken);
      expandedAny ||= r.expanded;
      all[0] = r.compound;
      taken = taken.map((t) => ({ x: t.x + r.shift.x, y: t.y + r.shift.y }));
      taken.push(r.spot);
      const c = all[0];
      const rects = [sq(c.house, HOUSE), ...taken.map((t) => sq(t, STRUCT))];
      for (const r1 of rects) {
        expect(r1.x0).toBeGreaterThanOrEqual(c.x0);
        expect(r1.y0).toBeGreaterThanOrEqual(c.y0);
        expect(r1.x0 + r1.w).toBeLessThanOrEqual(c.x0 + c.w);
        expect(r1.y0 + r1.h).toBeLessThanOrEqual(c.y0 + c.h);
      }
      for (let a = 0; a < rects.length; a++)
        for (let b = a + 1; b < rects.length; b++) expect(overlap(rects[a], rects[b])).toBe(false);
      assertNoCollisions(all);
    }
    expect(expandedAny).toBe(true);
  });
  it('no expansion returns input compound and zero shift', () => {
    const c = placeCompound([]);
    const r = spotFor(c, [c], []);
    expect(r.expanded).toBe(false);
    expect(r.compound).toBe(c);
    expect(r.shift).toEqual({ x: 0, y: 0 });
  });
});

const overlap = (a: Rect, b: Rect) => gapBetween(a, b) < 0;

describe('expand', () => {
  const east = (): Compound => ({ x0: 8, y0: -3, w: 7, h: 7, house: { x: 8, y: -3 } });
  it('expand_prefers_away_from_hall_and_alternates', () => {
    const c = east();
    const e1 = expand(c, [c]);
    expect(e1.shift).toEqual({ x: 0, y: 0 });
    expect(e1.compound.x0).toBe(c.x0);
    expect(e1.compound.w).toBe(c.w + GROW);
    expect(e1.compound.h).toBe(c.h);
    const e2 = expand(e1.compound, [e1.compound]);
    expect(e2.compound.h).toBe(c.h + GROW);
    expect(e2.compound.w).toBe(c.w + GROW);
    expect(c.w).toBe(7); // not mutated
  });
  it('grows toward negative side when west of hall', () => {
    const c: Compound = { x0: -15, y0: -3, w: 7, h: 7, house: { x: -9, y: -3 } };
    const e = expand(c, [c]);
    expect(e.compound.x0).toBe(-18);
    expect(e.compound.w).toBe(10);
    expect(e.compound.house).toEqual(c.house);
    expect(e.shift).toEqual({ x: 0, y: 0 });
  });
  it('expand_relocates_when_blocked', () => {
    const c = east();
    const blocker: Compound = { x0: 23, y0: -3, w: 7, h: 7, house: { x: 23, y: -3 } };
    assertNoCollisions([c, blocker]);
    const r = expand(c, [c, blocker]);
    expect(r.shift.x !== 0 || r.shift.y !== 0).toBe(true);
    expect(r.compound.w).toBe(10);
    expect(r.compound.house).toEqual({ x: c.house.x + r.shift.x, y: c.house.y + r.shift.y });
    assertNoCollisions([r.compound, blocker]);
  });
});

describe('canPlace / gate', () => {
  it('move_rejects_overlap_and_outside', () => {
    const c: Compound = { x0: 8, y0: -3, w: 7, h: 7, house: { x: 8, y: -3 } };
    const taken = [{ x: 12, y: -3 }];
    expect(canPlace(c, taken, { x: 9, y: -2 }, STRUCT)).toBe(false); // house
    expect(canPlace(c, taken, { x: 14, y: 0 }, STRUCT)).toBe(false); // outside
    expect(canPlace(c, taken, { x: 7, y: 0 }, STRUCT)).toBe(false); // outside
    expect(canPlace(c, taken, { x: 13, y: -2 }, STRUCT)).toBe(false); // structure
    expect(canPlace(c, taken, { x: 12, y: 1 }, STRUCT)).toBe(true);
  });
  it('gate_faces_hall', () => {
    expect(gateSide({ x0: 8, y0: -3, w: 7, h: 7, house: { x: 8, y: -3 } })).toBe('w');
    expect(gateSide({ x0: -15, y0: -3, w: 7, h: 7, house: { x: -9, y: -3 } })).toBe('e');
    expect(gateSide({ x0: -3, y0: 8, w: 7, h: 7, house: { x: -3, y: 8 } })).toBe('n');
    expect(gateSide({ x0: -3, y0: -15, w: 7, h: 7, house: { x: -3, y: -9 } })).toBe('s');
  });
});
