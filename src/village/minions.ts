import type { Tile } from '../api/types';
import { onGround } from './walkers';

/** Most minions shown by one builder; a session running more shows this many. */
export const MAX_MINIONS = 8;
/** A minion's size next to its builder's (both drawn from the same art). */
export const MINION_SCALE = 0.55;
/** Seconds a minion takes to pop up when its subagent starts, and to shrink away when it stops. */
export const POP_IN = 0.3;
export const POP_OUT = 0.25;
/** Tiles kept between minions, and between a minion and its builder; closer only when short of room. */
const SPACING = 0.45;
const SPACING_TIGHT = 0.3;
/**
 * How far in front of a minion (in tiles of depth, along +x and +y together) a sprite still reaches
 * up over it: a tent or the house (an iso tile is 32 px of depth; a tent rises ~70 px over its
 * footprint), or the much lower palisade. What stands behind a minion is drawn under it.
 */
const REACH = { building: 2.4, wall: 1 };
/** Half a minion's width, in tiles across the line of sight. */
const HALF_W = 0.2;

/** Where minions trail their builder while it walks, in tiles from its feet (no ground to check on the way). */
const TRAIL: readonly Tile[] = [
  { x: 0.45, y: 0.1 }, { x: 0.1, y: 0.45 }, { x: -0.35, y: 0.3 }, { x: 0.3, y: -0.35 },
  { x: 0.6, y: 0.55 }, { x: -0.5, y: -0.1 }, { x: -0.1, y: -0.5 }, { x: 0.75, y: -0.15 },
];

export function trailOffset(slot: number): Tile {
  return TRAIL[slot % TRAIL.length];
}

/** Huddled at the builder's feet when the compound has no open ground to spare: a V to either side of it, a step forward. */
const HUDDLE: readonly Tile[] = [
  { x: 0.35, y: -0.25 }, { x: -0.25, y: 0.35 }, { x: 0.55, y: -0.05 }, { x: -0.05, y: 0.55 },
  { x: 0.6, y: -0.45 }, { x: -0.45, y: 0.6 }, { x: 0.75, y: 0.15 }, { x: 0.15, y: 0.75 },
];

/** A minion's spot; `huddled` ones stand at their builder's feet and are drawn at its depth. */
export interface MinionSpot extends Tile {
  huddled: boolean;
}

/**
 * Where up to `n` minions stand around a builder at work at `at`, inside a compound whose walled
 * ground is `inside` and whose open ground (no house or structure) is `walk`: on open ground that
 * nothing in front of them would cover, nearest first and in front of the builder before behind it.
 * Short of such spots they stand closer together, and short of those they huddle at its feet.
 */
export function minionSpots(at: Tile, walk: Set<string>, inside: Set<string>, n: number): MinionSpot[] {
  const cands: Tile[] = [];
  const rank = new Map<Tile, number>();
  for (let r = 0.6; r <= 2.4; r += 0.3) {
    for (let k = 0; k < 24; k++) {
      const a = (k * Math.PI) / 12 + r; // turned per ring, so the rings don't line up
      const d = { x: r * Math.cos(a), y: r * Math.sin(a) };
      const p = { x: at.x + d.x, y: at.y + d.y };
      cands.push(p);
      rank.set(p, r + (d.x + d.y < -0.2 ? 1 : 0) - (d.x + d.y) * 0.05);
    }
  }
  cands.sort((a, b) => rank.get(a)! - rank.get(b)!);
  const seen = (p: Tile) => {
    if (!onGround(walk, p)) return false;
    for (let u = 0.2; u <= REACH.building; u += 0.2) {
      for (const w of [-HALF_W, 0, HALF_W]) {
        const q = { x: p.x + u + w, y: p.y + u - w };
        if (onGround(walk, q)) continue;
        if (onGround(inside, q) || u <= REACH.wall) return false; // a building, or the wall right in front
      }
    }
    return true;
  };
  const open = cands.filter(seen);
  const out: MinionSpot[] = [];
  for (const gap of [SPACING, SPACING_TIGHT]) {
    for (const p of open) {
      if (out.length >= n) break;
      if ([at, ...out].every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= gap)) out.push({ ...p, huddled: false });
    }
  }
  for (let i = out.length; i < n; i++) {
    const h = HUDDLE[i % HUDDLE.length];
    out.push({ x: at.x + h.x, y: at.y + h.y, huddled: true });
  }
  return out;
}

/** The subagents shown as minions: the first MAX_MINIONS by start order. */
export function shownMinions(ids: readonly string[]): string[] {
  return ids.slice(0, MAX_MINIONS);
}

/**
 * A minion's size factor `age` s after it appeared, or `gone` s after its subagent stopped
 * (null while it runs): a quick overshoot on the way in, a plain shrink on the way out.
 */
export function popScale(age: number, gone: number | null): number {
  if (gone !== null) return Math.max(0, 1 - gone / POP_OUT);
  if (age >= POP_IN) return 1;
  const u = age / POP_IN - 1; // ease-out-back
  return 1 + 2.70158 * u ** 3 + 1.70158 * u ** 2;
}
