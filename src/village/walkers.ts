import type { Compound, Tile } from '../api/types';
import { HOUSE, gateInside, gateOutside } from './layout';

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

/**
 * Where a builder stands beside a structure: the mockup's east offset when that point is inside the
 * compound and clear of the house, else the first of south, west, north that is.
 */
export function standTile(c: Compound, spot: Tile, house: Tile): Tile {
  const sides: Tile[] = [
    { x: spot.x + 2.45, y: spot.y + 1.1 }, // east
    { x: spot.x + 1.1, y: spot.y + 2.45 }, // south
    { x: spot.x - 0.45, y: spot.y + 1.1 }, // west
    { x: spot.x + 1.1, y: spot.y - 0.45 }, // north
  ];
  const ok = (p: Tile) =>
    p.x >= c.x0 && p.x < c.x0 + c.w && p.y >= c.y0 && p.y < c.y0 + c.h
    && !(p.x >= house.x && p.x < house.x + HOUSE && p.y >= house.y && p.y < house.y + HOUSE);
  return sides.find(ok) ?? sides[0];
}

/** Point on the plaza ring in the direction of `p` from the hall. */
function plazaPoint(p: Tile): Tile {
  const dx = p.x - HALL_C.x, dy = p.y - HALL_C.y;
  const d = Math.hypot(dx, dy) || 1;
  const r = (RING_MIN + RING_MAX) / 2;
  return { x: HALL_C.x + (dx / d) * r, y: HALL_C.y + (dy / d) * r };
}

/** Plaza -> gate (outside, then inside) -> the stand tile beside the spot. */
export function routeToSite(_from: Tile, c: Compound, spot: Tile): Tile[] {
  return [centre(gateOutside(c)), centre(gateInside(c)), standTile(c, spot, c.house)];
}

/** Back out through the gate (inside, then outside) to the plaza. */
export function routeHome(_from: Tile, c: Compound): Tile[] {
  const out = centre(gateOutside(c));
  return [centre(gateInside(c)), out, plazaPoint(out)];
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
