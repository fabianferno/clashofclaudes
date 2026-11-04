import type { Compound, Tile } from '../api/types';
import { HOUSE, STRUCT, gateInside, gateSide } from './layout';

/**
 * A wall tile and the neighbouring wall tiles it joins, in `nesw` order: n is y-1, e is x+1, s is
 * y+1, w is x-1 (e.g. `ew` is a straight run along x, `es` a corner). The gate tile counts as wall,
 * so runs meet the gate.
 */
export interface WallTile { x: number; y: number; links: string }

export interface Enclosure {
  /** Interior tiles, as `x,y` keys. */
  inside: Set<string>;
  /** Every wall tile around them, gate included (the caller swaps the gate tile for the gate). */
  walls: WallTile[];
}

const key = (x: number, y: number) => `${x},${y}`;

/** Deterministic generator for a compound's shape (stable across renders and runs). */
function seeded(seed: number): () => number {
  let s = (Math.abs(Math.floor(seed)) % 233280) || 11;
  return () => (s = (s * 9301 + 49297) % 233280) / 233280;
}

/** A stable number for a workspace id. */
export function seedOf(id: string): number {
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1_000_003;
  return h;
}

/**
 * The compound's walled ground, which grows with use instead of filling its reserved rect: a ring
 * around the house, a lane from the gate to it, room around every structure (and a lane to the
 * house), plus `2 + level` (at most 6) random bulges; then notches are filled so the outline stays smooth.
 * Always inside the compound rect, so the rect still reserves the space (walls sit on its ring at
 * most) and the gate tile from `gateTile` is always a wall tile with ground behind it.
 */
export function enclosure(c: Compound, spots: Tile[], level: number, seed: number): Enclosure {
  const inRect = (x: number, y: number) => x >= c.x0 && y >= c.y0 && x < c.x0 + c.w && y < c.y0 + c.h;
  const inside = new Set<string>();
  const add = (x: number, y: number) => { if (inRect(x, y)) inside.add(key(x, y)); };
  const box = (x0: number, y0: number, w: number, h: number, pad: number) => {
    for (let y = y0 - pad; y < y0 + h + pad; y++) for (let x = x0 - pad; x < x0 + w + pad; x++) add(x, y);
  };
  const hc: Tile = { x: c.house.x + 1, y: c.house.y + 1 };
  // A 2-wide lane from `a` to the house: first along `firstX ? x : y`, then the other axis.
  const lane = (a: Tile, firstX: boolean) => {
    let { x, y } = a;
    const step = () => { add(x, y); add(x + 1, y); add(x, y + 1); add(x + 1, y + 1); };
    step();
    const goX = () => { while (x !== hc.x) { x += Math.sign(hc.x - x); step(); } };
    const goY = () => { while (y !== hc.y) { y += Math.sign(hc.y - y); step(); } };
    if (firstX) { goX(); goY(); } else { goY(); goX(); }
  };

  box(c.house.x, c.house.y, HOUSE, HOUSE, 1);
  const side = gateSide(c);
  lane(gateInside(c), side === 'w' || side === 'e');
  for (const s of spots) {
    box(s.x, s.y, STRUCT, STRUCT, 1);
    lane(s, true);
  }

  const rnd = seeded(seed);
  for (let i = 0; i < 2 + Math.min(Math.max(level, 0), 4); i++) {
    const tiles = [...inside];
    const [bx, by] = tiles[Math.floor(rnd() * tiles.length)].split(',').map(Number);
    const r = rnd() < 0.75 ? 1 : 2;
    const ox = bx + Math.round((rnd() - 0.5) * 3), oy = by + Math.round((rnd() - 0.5) * 3);
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + 1) add(ox + x, oy + y);
  }

  // Fill notches: an outside tile mostly surrounded by ground, or between ground on two opposite
  // sides, joins it (twice, for 2-tile dents).
  for (let pass = 0; pass < 2; pass++) {
    const fill: [number, number][] = [];
    for (let y = c.y0; y < c.y0 + c.h; y++) {
      for (let x = c.x0; x < c.x0 + c.w; x++) {
        if (inside.has(key(x, y))) continue;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && inside.has(key(x + dx, y + dy))) n++;
        // or a one-tile slot between ground on opposite sides (its wall would be a dead end)
        const slot = (inside.has(key(x, y - 1)) && inside.has(key(x, y + 1))) || (inside.has(key(x - 1, y)) && inside.has(key(x + 1, y)));
        if (n >= 6 || slot) fill.push([x, y]);
      }
    }
    for (const [x, y] of fill) inside.add(key(x, y));
  }

  // Walls: every non-ground tile touching ground (8-way), so the ring closes around corners.
  const wallSet = new Set<string>();
  for (const k of inside) {
    const [x, y] = k.split(',').map(Number);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const kk = key(x + dx, y + dy);
      if (!inside.has(kk)) wallSet.add(kk);
    }
  }
  const walls: WallTile[] = [...wallSet].map((k) => {
    const [x, y] = k.split(',').map(Number);
    const links = ([['n', 0, -1], ['e', 1, 0], ['s', 0, 1], ['w', -1, 0]] as const)
      .filter(([, dx, dy]) => wallSet.has(key(x + dx, y + dy))).map(([d]) => d).join('');
    return { x, y, links };
  });
  walls.sort((a, b) => a.y - b.y || a.x - b.x);
  return { inside, walls };
}
