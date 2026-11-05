import { describe, expect, it } from 'vitest';
import type { Compound, Tile } from '../api/types';
import {
  EDGE_PAD, GAP, GROW, HALL, HOUSE, START, STRUCT, STRUCT_PAD, Rect, assertNoCollisions, canPlace, expand,
  findSpot, gapBetween, gateInside, gateOutside, gateSide, gateTile, padded, placeCompound, roadPath, spotFor, tidySpots, wallRect,
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
  it('keeps every structure padded from the house, the others and the wall, then reports full', () => {
    const c = placeCompound([]);
    const taken: Tile[] = [];
    for (let s = findSpot(c, taken); s; s = findSpot(c, taken)) {
      for (const o of [...taken.map((t) => sq(t, STRUCT)), sq(c.house, HOUSE)])
        expect(gapBetween(sq(s, STRUCT), o)).toBeGreaterThanOrEqual(STRUCT_PAD);
      expect(s.x - c.x0).toBeGreaterThanOrEqual(EDGE_PAD);
      expect(s.y - c.y0).toBeGreaterThanOrEqual(EDGE_PAD);
      expect(c.x0 + c.w - (s.x + STRUCT)).toBeGreaterThanOrEqual(EDGE_PAD);
      expect(c.y0 + c.h - (s.y + STRUCT)).toBeGreaterThanOrEqual(EDGE_PAD);
      expect(canPlace(c, taken, s, STRUCT)).toBe(true);
      taken.push(s);
      expect(taken.length).toBeLessThan(50);
    }
    expect(taken.length).toBeGreaterThanOrEqual(2); // a fresh compound holds a few before it grows
    // a full compound grows instead of packing a structure against its neighbours
    const r = spotFor(c, [c], taken);
    expect(r.expanded).toBe(true);
    for (const o of taken) expect(gapBetween(sq(r.spot, STRUCT), sq(o, STRUCT))).toBeGreaterThanOrEqual(STRUCT_PAD);
  });
});

describe('tidySpots', () => {
  const allPadded = (c: Compound, spots: Tile[]) => spots.every((t, i) => padded(c, spots.filter((_, j) => j !== i), t));

  it('spaces out structures packed against each other and the house, growing the compound', () => {
    const c = placeCompound([]);
    // packed the old way: touching the house and each other in a row
    const packed: Tile[] = [0, 2, 4, 6].map((d) => ({ x: c.x0 + d, y: c.house.y === c.y0 ? c.y0 + HOUSE : c.y0 }));
    expect(allPadded(c, packed)).toBe(false);
    const r = tidySpots(c, [c], packed);
    expect(r.spots).toHaveLength(4);
    expect(allPadded(r.compound, r.spots)).toBe(true);
    expect(r.moved).toBeGreaterThan(0);
    expect(r.compound.w * r.compound.h).toBeGreaterThan(c.w * c.h);
  });

  it('leaves an already padded village alone', () => {
    const c = placeCompound([]);
    const taken: Tile[] = [];
    for (let s = findSpot(c, taken); s; s = findSpot(c, taken)) taken.push(s);
    const r = tidySpots(c, [c], taken);
    expect(r.moved).toBe(0);
    expect(r.spots).toEqual(taken);
    expect(r.compound).toBe(c);
  });

  it('keeps the spot nearest the house and moves the one crowding it', () => {
    const c = placeCompound([]);
    const near = findSpot(c, [])!;
    const crowd = { x: near.x + STRUCT, y: near.y };
    const r = tidySpots(c, [c], [crowd, near]);
    expect(r.spots[1]).toEqual(near);
    expect(r.spots[0]).not.toEqual(crowd);
    expect(r.moved).toBe(1);
  });

  it('moves every spot with a relocated compound', () => {
    const all = placeN(4);
    const c = all[0];
    const packed: Tile[] = Array.from({ length: 8 }, (_, i) => ({ x: c.x0 + (i % 4) * 2, y: c.y0 + 5 + Math.floor(i / 4) * 2 }));
    const r = tidySpots(c, all, packed);
    expect(allPadded(r.compound, r.spots)).toBe(true);
    assertNoCollisions([r.compound, ...all.slice(1)]);
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
    expect(e.compound.x0).toBe(-15 - GROW);
    expect(e.compound.w).toBe(7 + GROW);
    expect(e.compound.house).toEqual(c.house);
    expect(e.shift).toEqual({ x: 0, y: 0 });
  });
  it('expand_relocates_when_blocked', () => {
    const c = east();
    const blocker: Compound = { x0: 23, y0: -3, w: 7, h: 7, house: { x: 23, y: -3 } };
    assertNoCollisions([c, blocker]);
    const r = expand(c, [c, blocker]);
    expect(r.shift.x !== 0 || r.shift.y !== 0).toBe(true);
    expect(r.compound.w).toBe(c.w + GROW);
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

describe('gate geometry', () => {
  const hallSideOnWall = (c: Compound) => {
    const r = wallRect(c), g = gateTile(c);
    switch (gateSide(c)) {
      case 'n': return g.y === r.y0;
      case 's': return g.y === r.y0 + r.h - 1;
      case 'w': return g.x === r.x0;
      default: return g.x === r.x0 + r.w - 1;
    }
  };
  const compounds = (): Compound[] => {
    const e: Compound = { x0: 9, y0: -3, w: 7, h: 7, house: { x: 9, y: -3 } };
    return [
      e,
      { ...e, x0: -16, house: { x: -16 + 4, y: -3 + 4 } },
      { x0: -3, y0: -16, w: 7, h: 7, house: { x: -3, y: -16 + 4 } },
      { x0: -3, y0: 9, w: 7, h: 7, house: { x: -3 + 4, y: 9 } },
      ...placeN(6),
    ];
  };
  it('gate_is_on_hall_wall_clear_of_house', () => {
    for (const c of compounds()) {
      const r = wallRect(c), g = gateTile(c);
      expect(hallSideOnWall(c)).toBe(true);
      const alongX = gateSide(c) === 'n' || gateSide(c) === 's';
      const t = alongX ? g.x - r.x0 : g.y - r.y0, len = alongX ? r.w : r.h;
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(len - 2);
      // the wall tile does not touch the house footprint (gap >= 1 including diagonals)
      expect(gapBetween({ x0: g.x, y0: g.y, w: 1, h: 1 }, sq(c.house, HOUSE))).toBeGreaterThanOrEqual(1);
    }
  });
  it('road_runs_along_grid_lines_from_hall_face_to_gate', () => {
    const hall = { x0: HALL.x0 - 0.3, y0: HALL.y0 - 0.3, w: HALL.w + 0.6, h: HALL.h + 0.6 };
    const inHall = (p: Tile) => p.x >= hall.x0 && p.x <= hall.x0 + hall.w && p.y >= hall.y0 && p.y <= hall.y0 + hall.h;
    for (const c of [...compounds(), { x0: 12, y0: -18, w: 7, h: 7, house: { x: 12, y: -14 } }]) {
      const r = roadPath(c), g = gateTile(c);
      expect(r[r.length - 1]).toEqual({ x: g.x + 0.5, y: g.y + 0.5 });
      expect(inHall(r[0])).toBe(true);
      // every leg is straight along x or y
      for (let i = 1; i < r.length; i++) expect(r[i].x === r[i - 1].x || r[i].y === r[i - 1].y).toBe(true);
      // it leaves the gate square to its wall
      const [a, b] = r.slice(-2), alongX = gateSide(c) === 'w' || gateSide(c) === 'e';
      expect(alongX ? a.y === b.y : a.x === b.x).toBe(true);
    }
  });
  it('road_is_straight_when_the_gate_faces_the_hall_and_jogs_otherwise', () => {
    const e: Compound = { x0: 9, y0: -3, w: 7, h: 7, house: { x: 9, y: -3 } };
    expect(roadPath(e)).toHaveLength(2);
    const ne: Compound = { x0: 12, y0: -18, w: 7, h: 7, house: { x: 12, y: -14 } };
    const r = roadPath(ne);
    expect(r).toHaveLength(4);
    expect(r[0].y).toBeGreaterThanOrEqual(HALL.y0);
    expect(r[1].x).toBeGreaterThan(HALL.x0 + HALL.w);
    expect(r[1].x).toBeLessThan(wallRect(ne).x0);
  });
  it('inside_is_interior_and_free_outside_is_beyond_wall', () => {
    for (const c of compounds()) {
      const i = gateInside(c), o = gateOutside(c), g = gateTile(c);
      expect(i.x).toBeGreaterThanOrEqual(c.x0);
      expect(i.y).toBeGreaterThanOrEqual(c.y0);
      expect(i.x).toBeLessThan(c.x0 + c.w);
      expect(i.y).toBeLessThan(c.y0 + c.h);
      expect(gapBetween({ x0: i.x, y0: i.y, w: 1, h: 1 }, sq(c.house, HOUSE))).toBeGreaterThanOrEqual(0);
      expect(Math.abs(i.x - g.x) + Math.abs(i.y - g.y)).toBe(1);
      expect(Math.abs(o.x - g.x) + Math.abs(o.y - g.y)).toBe(1);
      const r = wallRect(c);
      expect(o.x < r.x0 || o.y < r.y0 || o.x >= r.x0 + r.w || o.y >= r.y0 + r.h).toBe(true);
    }
  });
});
