import type { Compound, Tile } from '../api/types';
import { HOUSE, STRUCT, gateInside, gateOutside } from './layout';

export interface Walker {
  id: string;
  x: number;
  y: number;
  /** Grid points still to visit (tile centres are +0.5); consumed front to back. */
  path: Tile[];
  mode: 'idle' | 'toSite' | 'atSite' | 'home';
  /** 1 when moving toward +x-y (screen right), -1 otherwise. */
  face: 1 | -1;
  /** Seconds left to stand still before the next wander (idle only). */
  wait: number;
}

/** Tiles per second. */
export const SPEED = 1.1;
/** Idle wander radius around (0,0). */
export const PLAZA = 6;

// Wander on a ring around the hall's centre, outside its footprint; short hops keep chords clear of it.
const HALL_C = { x: 0.5, y: 0.5 };
const RING_MIN = 4.6;
const RING_MAX = 5.6;

const centre = (t: Tile): Tile => ({ x: t.x + 0.5, y: t.y + 0.5 });
const key = (x: number, y: number) => `${x},${y}`;
const tileOf = (p: Tile) => key(Math.floor(p.x), Math.floor(p.y));

/** Ground a builder may cross inside a compound: the walled ground (`enclosure().inside`) minus the house and the structures. */
export function walkable(inside: Set<string>, c: Compound, spots: Tile[]): Set<string> {
  const walk = new Set(inside);
  const clear = (t: Tile, n: number) => {
    for (let y = t.y; y < t.y + n; y++) for (let x = t.x; x < t.x + n; x++) walk.delete(key(x, y));
  };
  clear(c.house, HOUSE);
  for (const s of spots) clear(s, STRUCT);
  return walk;
}

/** Whether the straight line a->b stays on walkable tiles (sampled every quarter tile). */
function clearLine(walk: Set<string>, a: Tile, b: Tile): boolean {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 4);
  for (let i = 1; i < n; i++) {
    if (!walk.has(tileOf({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }))) return false;
  }
  return true;
}

/**
 * Points to walk from `from` to `to` over walkable ground: the shortest 8-way tile path (no corner
 * cutting), then shortened to the turns where the line of sight breaks. Just `[to]` when either
 * end is off the walkable ground or no path exists.
 */
export function interiorPath(walk: Set<string>, from: Tile, to: Tile): Tile[] {
  const start = tileOf(from), goal = tileOf(to);
  if (!walk.has(start) || !walk.has(goal) || start === goal) return [to];
  const prev = new Map<string, string>([[start, '']]);
  const queue = [start];
  while (queue.length && !prev.has(goal)) {
    const k = queue.shift()!;
    const [x, y] = k.split(',').map(Number);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const n = key(x + dx, y + dy);
      if ((!dx && !dy) || prev.has(n) || !walk.has(n)) continue;
      if (dx && dy && !(walk.has(key(x + dx, y)) && walk.has(key(x, y + dy)))) continue;
      prev.set(n, k);
      queue.push(n);
    }
  }
  if (!prev.has(goal)) return [to];
  const tiles: Tile[] = [];
  for (let k = prev.get(goal)!; k && k !== start; k = prev.get(k)!) {
    const [x, y] = k.split(',').map(Number);
    tiles.unshift(centre({ x, y }));
  }
  const pts = [...tiles, to];
  const out: Tile[] = [];
  let at = from;
  for (let i = 0; i < pts.length; ) {
    let j = pts.length - 1;
    while (j > i && !clearLine(walk, at, pts[j])) j--;
    out.push(pts[j]);
    at = pts[j];
    i = j + 1;
  }
  return out;
}

/**
 * Where a builder stands beside a structure: the mockup's east offset when that point is inside the
 * compound and clear of the house (and, given `walk`, on walkable ground), else the first of
 * south, west, north that is.
 */
export function standTile(c: Compound, spot: Tile, house: Tile, walk?: Set<string>): Tile {
  const sides: Tile[] = [
    { x: spot.x + 2.45, y: spot.y + 1.1 }, // east
    { x: spot.x + 1.1, y: spot.y + 2.45 }, // south
    { x: spot.x - 0.45, y: spot.y + 1.1 }, // west
    { x: spot.x + 1.1, y: spot.y - 0.45 }, // north
  ];
  const ok = (p: Tile) =>
    p.x >= c.x0 && p.x < c.x0 + c.w && p.y >= c.y0 && p.y < c.y0 + c.h
    && !(p.x >= house.x && p.x < house.x + HOUSE && p.y >= house.y && p.y < house.y + HOUSE)
    && (!walk || walk.has(tileOf(p)));
  return sides.find(ok) ?? sides[0];
}

/** Point on the plaza ring in the direction of `p` from the hall. */
function plazaPoint(p: Tile): Tile {
  const dx = p.x - HALL_C.x, dy = p.y - HALL_C.y;
  const d = Math.hypot(dx, dy) || 1;
  const r = (RING_MIN + RING_MAX) / 2;
  return { x: HALL_C.x + (dx / d) * r, y: HALL_C.y + (dy / d) * r };
}

/**
 * Plaza -> gate (outside, then inside) -> the stand tile beside the spot; given `walk` (see
 * `walkable`), around the house, the structures and the bends of the wall.
 */
export function routeToSite(_from: Tile, c: Compound, spot: Tile, walk?: Set<string>): Tile[] {
  const gate = centre(gateInside(c)), stand = standTile(c, spot, c.house, walk);
  return [centre(gateOutside(c)), gate, ...(walk ? interiorPath(walk, gate, stand) : [stand])];
}

/** Back out through the gate (inside, then outside) to the plaza, over `walk` when given. */
export function routeHome(from: Tile, c: Compound, walk?: Set<string>): Tile[] {
  const gate = centre(gateInside(c)), out = centre(gateOutside(c));
  return [...(walk ? interiorPath(walk, from, gate) : [gate]), out, plazaPoint(out)];
}

/**
 * The compound's house moved (so the gate and stand tile may have too): re-aim a walker that is at
 * the site, walking to it, or walking home. `spot` is the site's structure (null when heading home).
 */
export function retarget(w: Walker, c: Compound, spot: Tile | null, walk?: Set<string>): Walker {
  if (w.mode === 'atSite' && spot) {
    const st = standTile(c, spot, c.house, walk);
    return { ...w, x: st.x, y: st.y, path: [] };
  }
  const keep = (route: Tile[]) => route.slice(Math.max(0, route.length - w.path.length));
  if (w.mode === 'toSite' && spot && w.path.length) return { ...w, path: keep(routeToSite(w, c, spot, walk)) };
  if (w.mode === 'home' && w.path.length) return { ...w, path: keep(routeHome(w, c, walk)) };
  return w;
}

/** Advance `dt` seconds: walk the path; when idle with an empty path, rest then pick a new plaza target. */
export function step(w: Walker, dt: number, rnd: () => number): Walker {
  let { x, y, face, mode, wait } = w;
  const path = w.path.slice();
  let budget = SPEED * dt;
  while (path.length && budget > 0) {
    const t = path[0];
    const dx = t.x - x, dy = t.y - y;
    const d = Math.hypot(dx, dy);
    if (dx - dy > 1e-9) face = 1;
    else if (dx - dy < -1e-9) face = -1;
    if (d <= budget) {
      x = t.x; y = t.y; budget -= d; path.shift();
    } else {
      x += (dx / d) * budget; y += (dy / d) * budget; budget = 0;
    }
  }
  if (!path.length && (mode === 'toSite' || mode === 'home') && w.path.length) {
    if (mode === 'toSite') mode = 'atSite';
    else { mode = 'idle'; wait = 1 + rnd() * 3; }
  } else if (!path.length && mode === 'idle') {
    wait -= dt;
    if (wait <= 0) {
      const a = Math.atan2(y - HALL_C.y, x - HALL_C.x) + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.7);
      const r = RING_MIN + rnd() * (RING_MAX - RING_MIN);
      path.push({ x: HALL_C.x + Math.cos(a) * r, y: HALL_C.y + Math.sin(a) * r });
      wait = 1 + rnd() * 3;
    }
  }
  return { ...w, x, y, path, face, mode, wait };
}
