import type { Compound, Tile } from '../api/types';

/** Half-open tile rect: [x0, x0+w) x [y0, y0+h). */
export interface Rect {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

export const HALL: Rect = { x0: -2, y0: -2, w: 5, h: 5 };
/** Min empty tiles between compound walls and anything else (roads). */
export const GAP = 4;
export const START = 10;
export const GROW = 4;
export const HOUSE = 3;
export const STRUCT = 2;

const HALL_CX = HALL.x0 + HALL.w / 2;
const HALL_CY = HALL.y0 + HALL.h / 2;

/**
 * Number of empty tiles between two half-open rects along the separating
 * axis (Chebyshev-style): max(gap on x, gap on y). Rects are "at least G
 * apart" if separated by >= G empty tiles on x OR on y. Touching rects give
 * 0; overlapping rects give a negative number.
 */
export function gapBetween(a: Rect, b: Rect): number {
  const gx = Math.max(a.x0 - (b.x0 + b.w), b.x0 - (a.x0 + a.w));
  const gy = Math.max(a.y0 - (b.y0 + b.h), b.y0 - (a.y0 + a.h));
  return Math.max(gx, gy);
}

const sq = (t: Tile, s: number): Rect => ({ x0: t.x, y0: t.y, w: s, h: s });
const same = (a: Compound, b: Compound) =>
  a.x0 === b.x0 && a.y0 === b.y0 && a.w === b.w && a.h === b.h && a.house.x === b.house.x && a.house.y === b.house.y;

/** Interior grown by 1 tile on each side. */
export function wallRect(c: Compound): Rect {
  return { x0: c.x0 - 1, y0: c.y0 - 1, w: c.w + 2, h: c.h + 2 };
}

const dist2 = (r: Rect) => (r.x0 + r.w / 2 - HALL_CX) ** 2 + (r.y0 + r.h / 2 - HALL_CY) ** 2;

function wallClear(wall: Rect, others: Compound[]): boolean {
  if (gapBetween(wall, HALL) < GAP) return false;
  return others.every((o) => gapBetween(wall, wallRect(o)) >= GAP);
}

/** Nearest-to-hall interior origin of size w x h whose walls keep GAP; deterministic. */
function findFree(w: number, h: number, others: Compound[]): Tile {
  for (let R = 40; ; R *= 2) {
    let best: Tile | null = null;
    let bestD = Infinity;
    for (let y = -R; y <= R; y++) {
      for (let x = -R; x <= R; x++) {
        const r = { x0: x, y0: y, w, h };
        const d = dist2(r);
        if (d >= bestD) continue;
        if (!wallClear({ x0: x - 1, y0: y - 1, w: w + 2, h: h + 2 }, others)) continue;
        best = { x, y };
        bestD = d;
      }
    }
    if (best) return best;
  }
}

/** House top-left in the interior corner nearest the hall. */
function houseCorner(x0: number, y0: number, w: number, h: number): Tile {
  const east = x0 + w / 2 > HALL_CX;
  const south = y0 + h / 2 > HALL_CY;
  return { x: east ? x0 : x0 + w - HOUSE, y: south ? y0 : y0 + h - HOUSE };
}

export function placeCompound(existing: Compound[]): Compound {
  const o = findFree(START, START, existing);
  return { x0: o.x, y0: o.y, w: START, h: START, house: houseCorner(o.x, o.y, START, START) };
}

/** Wall side facing the hall. */
export function gateSide(c: Compound): 'n' | 's' | 'e' | 'w' {
  const dx = c.x0 + c.w / 2 - HALL_CX;
  const dy = c.y0 + c.h / 2 - HALL_CY;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'w' : 'e';
  return dy > 0 ? 'n' : 's';
}

/**
 * The wall tile replaced by the gate: on the hall-facing side, at the position along that wall
 * nearest the house's 3-tile span while keeping one clear tile between them (and at least 1 tile
 * from the wall corners), so the entry lane to the house is short and the house never covers or
 * touches the gate. Ties go to the lower coordinate.
 */
export function gateTile(c: Compound): Tile {
  const r = wallRect(c);
  const side = gateSide(c);
  const alongX = side === 'n' || side === 's';
  const lo = (alongX ? r.x0 : r.y0) + 1;
  const hi = (alongX ? r.x0 + r.w : r.y0 + r.h) - 2;
  const s0 = alongX ? c.house.x : c.house.y;
  const s1 = s0 + HOUSE - 1;
  let best = lo, bestD = Infinity, far = lo, farD = -1;
  for (let t = lo; t <= hi; t++) {
    const d = Math.max(s0 - t, t - s1, 0);
    if (d >= 2 && d < bestD) { bestD = d; best = t; }
    if (d > farD) { farD = d; far = t; }
  }
  if (bestD === Infinity) best = far; // no position clears the house by a tile: the farthest one
  switch (side) {
    case 'n': return { x: best, y: r.y0 };
    case 's': return { x: best, y: r.y0 + r.h - 1 };
    case 'w': return { x: r.x0, y: best };
    default: return { x: r.x0 + r.w - 1, y: best };
  }
}

const SIDE_OUT = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 }, e: { x: 1, y: 0 } } as const;

/** Interior tile just inside the gate. */
export function gateInside(c: Compound): Tile {
  const g = gateTile(c), d = SIDE_OUT[gateSide(c)];
  return { x: g.x - d.x, y: g.y - d.y };
}

/** Tile just outside the gate. */
export function gateOutside(c: Compound): Tile {
  const g = gateTile(c), d = SIDE_OUT[gateSide(c)];
  return { x: g.x + d.x, y: g.y + d.y };
}

/** Inside the interior and not overlapping the house or any taken 2x2 structure. */
export function canPlace(c: Compound, taken: Tile[], at: Tile, size: number): boolean {
  if (at.x < c.x0 || at.y < c.y0 || at.x + size > c.x0 + c.w || at.y + size > c.y0 + c.h) return false;
  const r = sq(at, size);
  if (gapBetween(r, sq(c.house, HOUSE)) < 0) return false;
  return taken.every((t) => gapBetween(r, sq(t, STRUCT)) >= 0);
}

/** Free spot nearest the house centre; prefers a >=1 tile gap around all occupants. */
export function findSpot(c: Compound, taken: Tile[]): Tile | null {
  const occ = [sq(c.house, HOUSE), ...taken.map((t) => sq(t, STRUCT))];
  const hx = c.house.x + HOUSE / 2;
  const hy = c.house.y + HOUSE / 2;
  let bestGap: Tile | null = null, bestGapD = Infinity;
  let bestAny: Tile | null = null, bestAnyD = Infinity;
  for (let y = c.y0; y + STRUCT <= c.y0 + c.h; y++) {
    for (let x = c.x0; x + STRUCT <= c.x0 + c.w; x++) {
      const r = { x0: x, y0: y, w: STRUCT, h: STRUCT };
      const min = Math.min(...occ.map((o) => gapBetween(r, o)));
      if (min < 0) continue;
      const d = (x + STRUCT / 2 - hx) ** 2 + (y + STRUCT / 2 - hy) ** 2;
      if (d < bestAnyD) { bestAnyD = d; bestAny = { x, y }; }
      if (min >= 1 && d < bestGapD) { bestGapD = d; bestGap = { x, y }; }
    }
  }
  return bestGap ?? bestAny;
}

/**
 * Grow by GROW away from the hall, alternating w/h (w first when w <= h).
 * Tries the other side on collision; otherwise relocates the grown compound
 * to free space (shift = translation of house/spots; zero otherwise).
 */
export function expand(c: Compound, all: Compound[]): { compound: Compound; shift: Tile } {
  const others = all.filter((o) => !same(o, c));
  const growW = c.w <= c.h;
  const away = growW ? c.x0 + c.w / 2 >= HALL_CX : c.y0 + c.h / 2 >= HALL_CY;
  const make = (positive: boolean): Compound =>
    growW
      ? { ...c, x0: positive ? c.x0 : c.x0 - GROW, w: c.w + GROW }
      : { ...c, y0: positive ? c.y0 : c.y0 - GROW, h: c.h + GROW };
  for (const positive of [away, !away]) {
    const n = make(positive);
    if (wallClear(wallRect(n), others)) return { compound: n, shift: { x: 0, y: 0 } };
  }
  const grown = make(true);
  const o = findFree(grown.w, grown.h, others);
  const shift = { x: o.x - c.x0, y: o.y - c.y0 };
  return {
    compound: { ...grown, x0: o.x, y0: o.y, house: { x: c.house.x + shift.x, y: c.house.y + shift.y } },
    shift,
  };
}

/** Find a spot, expanding (repeatedly if needed) until one exists. `shift` is cumulative. */
export function spotFor(
  c: Compound,
  all: Compound[],
  taken: Tile[],
): { compound: Compound; spot: Tile; expanded: boolean; shift: Tile } {
  let cur = c;
  const others = all.filter((o) => !same(o, c));
  let tk = taken;
  const shift = { x: 0, y: 0 };
  let expanded = false;
  for (;;) {
    const spot = findSpot(cur, tk);
    if (spot) return { compound: cur, spot, expanded, shift };
    const r = expand(cur, [...others, cur]);
    cur = r.compound;
    tk = tk.map((t) => ({ x: t.x + r.shift.x, y: t.y + r.shift.y }));
    shift.x += r.shift.x;
    shift.y += r.shift.y;
    expanded = true;
  }
}

/** Tiles: HALL and every wall rect (unpadded). */
export function villageRect(compounds: Compound[]): Rect {
  let x0 = HALL.x0, y0 = HALL.y0, x1 = HALL.x0 + HALL.w, y1 = HALL.y0 + HALL.h;
  for (const c of compounds) {
    const r = wallRect(c);
    x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0);
    x1 = Math.max(x1, r.x0 + r.w); y1 = Math.max(y1, r.y0 + r.h);
  }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

/** Test helper: throws if any wall rect is < GAP from another or from HALL. */
export function assertNoCollisions(all: Compound[]): void {
  all.forEach((c, i) => {
    if (gapBetween(wallRect(c), HALL) < GAP) throw new Error(`compound ${i} too close to hall`);
    for (let j = i + 1; j < all.length; j++)
      if (gapBetween(wallRect(c), wallRect(all[j])) < GAP) throw new Error(`compounds ${i} and ${j} too close`);
  });
}
