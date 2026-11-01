import type { AgentKind, Compound, SessionInfo, Tile } from '../api/types';
import { builderTarget } from '../hud/hudState';
import type { Selection } from '../state/store';
import { iso } from './iso';
import { wallRect } from './layout';
import type { Entity } from './scene';

/** Clickable footprint (tiles) and height (px) above the front corner, as the mockup's boxHit. */
const BOX: Partial<Record<Entity['kind'], { w: number; h: number }>> = {
  hall: { w: 5, h: 150 },
  house: { w: 3, h: 130 },
  structure: { w: 2, h: 100 },
  collector: { w: 2, h: 100 },
};
const BUILDER_HALF_W = 16;
const BUILDER_H = 70;

function hits(e: Entity, wx: number, wy: number): boolean {
  if (e.kind === 'builder') {
    const p = iso(e.x, e.y);
    return Math.abs(wx - p.x) <= BUILDER_HALF_W && wy >= p.y - BUILDER_H && wy <= p.y + 6;
  }
  const b = BOX[e.kind];
  if (!b) return false;
  const gx = e.x - b.w, gy = e.y - b.w;
  const l = iso(gx, gy + b.w).x, r = iso(gx + b.w, gy).x;
  const top = iso(gx, gy).y - b.h, bot = iso(gx + b.w, gy + b.w).y + 8;
  return wx > l && wx < r && wy > top && wy < bot;
}

/** The topmost clickable entity at world point (wx, wy): builders first, then front-most by depth. */
export function hitTest(entities: readonly Entity[], wx: number, wy: number): Entity | null {
  let best: Entity | null = null;
  for (const e of entities) {
    if (!hits(e, wx, wy)) continue;
    const front = !best
      || (e.kind === 'builder' && best.kind !== 'builder')
      || ((e.kind === 'builder') === (best.kind === 'builder') && e.depth > best.depth);
    if (front) best = e;
  }
  return best;
}

/** The item whose compound's wall rect contains grid point (gx, gy). */
export function compoundAt<T extends { compound: Compound | null }>(items: readonly T[], gx: number, gy: number): T | null {
  for (const it of items) {
    if (!it.compound) continue;
    const r = wallRect(it.compound);
    if (gx >= r.x0 && gx < r.x0 + r.w && gy >= r.y0 && gy < r.y0 + r.h) return it;
  }
  return null;
}

/** A world point inside the entity's clickable box, near its middle. */
export function clickPoint(e: Entity): { x: number; y: number } {
  if (e.kind === 'builder') {
    const p = iso(e.x, e.y);
    return { x: p.x, y: p.y - BUILDER_H / 2 };
  }
  const b = BOX[e.kind];
  if (!b) { const p = iso(e.x, e.y); return { x: p.x, y: p.y }; }
  const c = iso(e.x - b.w / 2, e.y - b.w / 2);
  return { x: c.x, y: c.y - b.h / 3 };
}

/** The tile a dragged object's top-left lands on: the pointer's grid point minus where it grabbed, rounded. */
export function dragTarget(start: Tile, grabOffset: { x: number; y: number }, pointerGrid: { x: number; y: number }): Tile {
  void start; // the grab offset is relative to start already; kept for a self-describing signature
  return { x: Math.round(pointerGrid.x - grabOffset.x), y: Math.round(pointerGrid.y - grabOffset.y) };
}

/** What clicking an entity selects: a busy builder opens its session, an idle one the builder panel. */
export function selectionOf(e: Entity | null, sessions: readonly SessionInfo[]): Selection | null {
  if (!e) return null;
  if (e.kind === 'hall') return { kind: 'hall' };
  if (e.kind === 'house') return { kind: 'workspace', id: e.id.slice('house:'.length) };
  if (e.kind === 'structure') return { kind: 'session', id: e.id.slice('struct:'.length) };
  if (e.kind === 'collector') return { kind: 'quota', agent: e.id.slice('collector:'.length) as AgentKind };
  if (e.kind === 'builder') return builderTarget(e.id.slice('builder:'.length), [...sessions]);
  return null;
}
