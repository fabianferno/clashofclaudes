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

/** Whether compound `c` may stand where it is: its walls GAP tiles from the hall and from every other compound's walls. */
export function compoundFits(c: Compound, others: Compound[]): boolean {
  return wallClear(wallRect(c), others);
}

/** `c` moved by (dx, dy), house included. */
export function shiftCompound(c: Compound, dx: number, dy: number): Compound {
  return { ...c, x0: c.x0 + dx, y0: c.y0 + dy, house: { x: c.house.x + dx, y: c.house.y + dy } };
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

/**
 * The dirt road from the hall to the gate along grid lines, never diagonal: square out of the gate,
 * and when the gate is off the hall's face, a jog halfway along that lines up with the face, then
 * square into the hall. Points in tile coords, hall end (under the plaza) first, gate centre last.
 */
export function roadPath(c: Compound): Tile[] {
  const g = gateTile(c), side = gateSide(c);
  const alongX = side === 'w' || side === 'e';
  const pt = (a: number, b: number): Tile => (alongX ? { x: a, y: b } : { x: b, y: a });
  const ga = (alongX ? g.x : g.y) + 0.5, gc = (alongX ? g.y : g.x) + 0.5;
  const lo = alongX ? HALL.x0 : HALL.y0, len = alongX ? HALL.w : HALL.h;
  const clo = alongX ? HALL.y0 : HALL.x0, clen = alongX ? HALL.h : HALL.w;
  // the hall face the road enters: the near edge, toward the gate
  const edge = side === 'w' || side === 'n' ? lo + len : lo;
  const t = Math.min(Math.max(gc, clo + 0.5), clo + clen - 0.5);
  if (t === gc) return [pt(edge, gc), pt(ga, gc)];
  const mid = Math.floor((ga + edge) / 2) + 0.5;
  return [pt(edge, t), pt(mid, t), pt(mid, gc), pt(ga, gc)];
}

/** The tiles under each leg of `roadPath(c)`: one tile wide, end to end. Trees and collectors keep off them. */
export function roadRects(c: Compound): Rect[] {
  const r = roadPath(c);
  return r.slice(1).map((b, i) => {
    const a = r[i];
    const x0 = Math.floor(Math.min(a.x, b.x)), y0 = Math.floor(Math.min(a.y, b.y));
    return { x0, y0, w: Math.floor(Math.max(a.x, b.x)) + 1 - x0, h: Math.floor(Math.max(a.y, b.y)) + 1 - y0 };
  });
}

/** Inside the interior and not overlapping the house or any taken 2x2 structure. */
export function canPlace(c: Compound, taken: Tile[], at: Tile, size: number): boolean {
  if (at.x < c.x0 || at.y < c.y0 || at.x + size > c.x0 + c.w || at.y + size > c.y0 + c.h) return false;
  const r = sq(at, size);
  if (gapBetween(r, sq(c.house, HOUSE)) < 0) return false;
  return taken.every((t) => gapBetween(r, sq(t, STRUCT)) >= 0);
}

/** Clear tiles a new structure keeps from the house and every other structure: room to stand and work. */
export const STRUCT_PAD = 2;
/** Clear tiles a new structure keeps from the compound's edge, so the wall never presses on it. */
export const EDGE_PAD = 1;

/**
 * Free spot nearest the house centre, STRUCT_PAD clear of the house and every structure and EDGE_PAD
 * in from the compound's edge; null when there is none (the compound then grows, see `spotFor`).
 */
export function findSpot(c: Compound, taken: Tile[]): Tile | null {
  const occ = [sq(c.house, HOUSE), ...taken.map((t) => sq(t, STRUCT))];
  const hx = c.house.x + HOUSE / 2;
  const hy = c.house.y + HOUSE / 2;
  let best: Tile | null = null, bestD = Infinity;
  for (let y = c.y0 + EDGE_PAD; y + STRUCT + EDGE_PAD <= c.y0 + c.h; y++) {
    for (let x = c.x0 + EDGE_PAD; x + STRUCT + EDGE_PAD <= c.x0 + c.w; x++) {
      const r = { x0: x, y0: y, w: STRUCT, h: STRUCT };
      if (occ.some((o) => gapBetween(r, o) < STRUCT_PAD)) continue;
      const d = (x + STRUCT / 2 - hx) ** 2 + (y + STRUCT / 2 - hy) ** 2;
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best;
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

/** Whether a structure on `at` keeps `findSpot`'s padding: EDGE_PAD in from the edge, STRUCT_PAD from the house and `others`. */
export function padded(c: Compound, others: Tile[], at: Tile): boolean {
  if (at.x < c.x0 + EDGE_PAD || at.y < c.y0 + EDGE_PAD) return false;
  if (at.x + STRUCT + EDGE_PAD > c.x0 + c.w || at.y + STRUCT + EDGE_PAD > c.y0 + c.h) return false;
  const r = sq(at, STRUCT);
  return gapBetween(r, sq(c.house, HOUSE)) >= STRUCT_PAD && others.every((t) => gapBetween(r, sq(t, STRUCT)) >= STRUCT_PAD);
}

/**
 * `spots` spaced out to `findSpot`'s padding. Nearest the house first, a spot that is padded from the
 * house and the spots kept before it stays; the rest move to free spots, growing the compound when it is
 * full (as `spotFor` does: `shift` is the cumulative translation). Spots come back in the order given.
 */
export function tidySpots(
  c: Compound,
  all: Compound[],
  spots: Tile[],
): { compound: Compound; spots: Tile[]; moved: number; shift: Tile } {
  const out = spots.map((t) => ({ ...t }));
  const hx = c.house.x + HOUSE / 2, hy = c.house.y + HOUSE / 2;
  const order = spots.map((_, i) => i)
    .sort((a, b) => (spots[a].x - hx) ** 2 + (spots[a].y - hy) ** 2 - ((spots[b].x - hx) ** 2 + (spots[b].y - hy) ** 2));
  const kept: number[] = [];
  const stray: number[] = [];
  for (const i of order) (padded(c, kept.map((k) => out[k]), out[i]) ? kept : stray).push(i);
  const others = all.filter((o) => !same(o, c));
  let cur = c;
  const shift = { x: 0, y: 0 };
  for (const i of stray) {
    const r = spotFor(cur, [...others, cur], kept.map((k) => out[k]));
    for (const k of kept) out[k] = { x: out[k].x + r.shift.x, y: out[k].y + r.shift.y };
    shift.x += r.shift.x;
    shift.y += r.shift.y;
    out[i] = r.spot;
    kept.push(i);
    cur = r.compound;
  }
  return { compound: cur, spots: out, moved: stray.length, shift };
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
