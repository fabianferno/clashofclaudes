// What may not overlap on screen. Trees are baked into the ground, under everything, so a builder
// or building in front of a tree's canopy draws over it: such trees are cleared from the ground
// (`keepClearOfTrees`), and idle builders keep off what a canopy covers (`underTree`).
import type { Tile } from '../api/types';
import { TREE_K, TREE_REACH } from './art/scenery';
import { iso } from './iso';
import { HALL, type Rect } from './layout';
import { HALL_C, RING_MAX, RING_MIN } from './walkers';

/** A screen-space box in world px (iso): x0..x1 across, y0 (top) ..y1. */
export interface Box { x0: number; x1: number; y0: number; y1: number }

export const meet = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** A box drawn up from a footprint's front corner (where its art is anchored). */
const fromFront = (x: number, y: number, half: number, up: number, down: number): Box => {
  const f = iso(x, y);
  return { x0: f.x - half, x1: f.x + half, y0: f.y - up, y1: f.y + down };
};

/** The hall's painted extent (hall.png, anchored at its front corner, at half size). */
export const hallBox = (): Box => fromFront(HALL.x0 + HALL.w, HALL.y0 + HALL.h, 190, 300, 40);
/** A collector's painted extent (collector-base.png at half size) on its 2x2 footprint `r`. */
export const collectorBox = (r: Rect): Box => fromFront(r.x0 + r.w, r.y0 + r.h, 100, 190, 30);
/** A builder standing at `p`: the figure, feet to hat. */
export const builderBox = (p: Tile): Box => fromFront(p.x, p.y, 20, 82, 6);
/** A ground tree's canopy and trunk, as `treesOverPaths` measures it. */
export function canopyBox(t: { x: number; y: number; s: number }): Box {
  const k = t.s * TREE_K;
  return fromFront(t.x, t.y, TREE_REACH.half * k, TREE_REACH.up * k, 6);
}

/** How far behind a builder (in x + y) a tree still counts: just behind, its trunk shows through the figure. */
const BEHIND = 0.7;

/** Something no tree may stand over: its box, and the depth (x + y) a tree must be behind to stay. */
export interface Keep { box: Box; depth: number }

/**
 * What the forest is cleared from: the hall, the collectors (`clearings`, their 2x2 footprints)
 * and the ring idle builders stroll around the hall.
 */
export function keepClearOfTrees(clearings: readonly Rect[]): Keep[] {
  const out: Keep[] = [{ box: hallBox(), depth: HALL.x0 + HALL.y0 }];
  for (const r of clearings) out.push({ box: collectorBox(r), depth: r.x0 + r.y0 });
  for (const rr of [RING_MIN, (RING_MIN + RING_MAX) / 2, RING_MAX]) {
    for (let a = 0; a < Math.PI * 2; a += 0.1) {
      const p = { x: HALL_C.x + Math.cos(a) * rr, y: HALL_C.y + Math.sin(a) * rr };
      out.push({ box: builderBox(p), depth: p.x + p.y - BEHIND });
    }
  }
  return out;
}

/** Whether a tree stands over any of `keep`: in front of (or level with) it and reaching it. */
export function treeOver(t: { x: number; y: number; s: number }, keep: readonly Keep[]): boolean {
  const c = canopyBox(t);
  return keep.some((k) => t.x + t.y > k.depth && meet(c, k.box));
}

/** Trees indexed by tile, for `underTree`. */
export type TreeIndex = Map<string, Array<{ x: number; y: number; s: number }>>;

export function indexTrees(trees: ReadonlyArray<{ x: number; y: number; s: number }>): TreeIndex {
  const out: TreeIndex = new Map();
  for (const t of trees) {
    const k = `${Math.floor(t.x)},${Math.floor(t.y)}`;
    const list = out.get(k);
    if (list) list.push(t); else out.set(k, [t]);
  }
  return out;
}

/** Whether a builder at `p` would stand in a trunk or under a canopy in front of it. */
export function underTree(index: TreeIndex, p: Tile): boolean {
  const me = builderBox(p), depth = p.x + p.y - BEHIND;
  // a canopy reaches at most ~8 tiles of x + y up the screen and ~2 across: these tiles hold every candidate
  for (let x = Math.floor(p.x - 2); x <= Math.floor(p.x + 6); x++) {
    for (let y = Math.floor(p.y - 2); y <= Math.floor(p.y + 6); y++) {
      for (const t of index.get(`${x},${y}`) ?? []) if (t.x + t.y > depth && meet(canopyBox(t), me)) return true;
    }
  }
  return false;
}
