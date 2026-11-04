import type { Compound, Tile } from '../../api/types';
import { iso, TW, TH } from '../iso';
import { GAP, HALL, HOUSE, wallRect, gateInside, roadRects, type Rect } from '../layout';
import { bake, ctx, type Art, type Pt } from './draw';
import { paintTree, TREE_K, TREE_REACH } from './scenery';

const PAD_TOP = 90;
const PAD = 40;

/**
 * Canvas px per world px of the ground bake. Half density: grass may be soft, and a full-density
 * bake of a large village is tens of MB (it is uploaded once and displayed at 1 / GROUND_SCALE).
 */
export const GROUND_SCALE = 0.5;

/** World px (iso space) of the ground canvas' top-left corner: place the bare canvas sprite there at scale 1 / GROUND_SCALE. */
export function groundOrigin(b: Rect): Pt {
  return { x: iso(b.x0, b.y0 + b.h).x - PAD, y: iso(b.x0, b.y0).y - PAD_TOP };
}

/** Size of the ground bake: `w`/`h` in world px, `cw`/`ch` the canvas in px (at GROUND_SCALE), `bytes` its RGBA size. */
export function groundBakeSize(b: Rect, scale = GROUND_SCALE): { w: number; h: number; cw: number; ch: number; bytes: number } {
  const o = groundOrigin(b);
  const w = iso(b.x0 + b.w, b.y0).x + PAD - o.x;
  const h = iso(b.x0 + b.w, b.y0 + b.h).y + PAD - o.y;
  const cw = Math.ceil(w * scale), ch = Math.ceil(h * scale);
  return { w, h, cw, ch, bytes: cw * ch * 4 };
}

/** Tiles of forest kept clear around a clearing; trees in front reach furthest over it. */
export const CLEARING_PAD = 1.5;

const inRect = (x: number, y: number, r: Rect, pad = 0) =>
  x > r.x0 - pad && x < r.x0 + r.w + pad && y > r.y0 - pad && y < r.y0 + r.h + pad;

/**
 * Grass and forest, cleared from every wall rect (+GAP), the hall, the roads (laid as `pathTiles`) and
 * the `clearings` (collector footprints, + CLEARING_PAD so no canopy is drawn over them).
 * Deterministic for a given seed. Returns a bare canvas at GROUND_SCALE density (no anchor, unlike Art),
 * sized by `groundBakeSize(bounds)`: place it at `groundOrigin(bounds)` in world px with scale 1 / GROUND_SCALE.
 */
export function drawGround(
  b: Rect, compounds: Compound[], seed: number, clearings: readonly Rect[] = [],
  lifted: (t: GroundTree) => boolean = () => false,
): HTMLCanvasElement {
  const { forest, blobs, tufts } = groundPlan(b, seed);
  const o = groundOrigin(b);
  const { w, h } = groundBakeSize(b);
  return bake(w, h, 0, 0, () => {
    const g = ctx();
    g.fillStyle = '#5aa832';
    g.fillRect(o.x, o.y, w, h);
    for (const t of blobs) {
      const p = iso(t.x, t.y);
      const rgb = t.light ? '120,196,64' : '62,130,34';
      const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, t.rx);
      gr.addColorStop(0, `rgba(${rgb},.5)`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.beginPath(); g.ellipse(p.x, p.y, t.rx, t.ry, 0, 0, Math.PI * 2); g.fill();
    }

    for (const t of tufts) {
      const p = iso(t.x, t.y);
      if (t.r < 0.2) {
        g.fillStyle = ['#fff6a8', '#ffffff', '#ff9fb8', '#ffd166'][t.ci];
        g.beginPath(); g.arc(p.x, p.y, 1.8, 0, Math.PI * 2); g.fill();
      } else {
        g.strokeStyle = 'rgba(40,100,20,.5)'; g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(p.x - 3, p.y); g.lineTo(p.x - 1, p.y - 5);
        g.moveTo(p.x, p.y); g.lineTo(p.x + 1, p.y - 6);
        g.moveTo(p.x + 3, p.y); g.lineTo(p.x + 4, p.y - 4);
        g.stroke();
      }
    }
    for (const t of standing(forest, compounds, clearings)) {
      if (lifted(t)) continue;
      const p = iso(t.x, t.y);
      g.save(); g.translate(p.x, p.y);
      paintTree(t.pine, t.s);
      g.restore();
    }
  }, o, GROUND_SCALE).canvas;
}

/** A tree of the ground's forest: its trunk base (tile coords), scale and kind. */
export interface GroundTree { x: number; y: number; s: number; pine: boolean; r: number }

/** Every random draw of the ground, up front, so the output depends only on (bounds, seed), not on filtering. */
function groundPlan(b: Rect, seed: number) {
  let s = (Math.abs(Math.floor(seed)) % 233280) || 5;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const area = b.w * b.h;
  const rx = () => b.x0 + rnd() * b.w;
  const ry = () => b.y0 + rnd() * b.h;
  const forest: GroundTree[] = Array.from({ length: Math.min(6000, Math.round(area * 0.65)) }, () =>
    ({ x: rx(), y: ry(), s: 0.9 + rnd() * 0.5, pine: rnd() < 0.45, r: rnd() }));
  const blobs = Array.from({ length: Math.round(area * 0.18) }, () =>
    ({ x: rx(), y: ry(), rx: 40 + rnd() * 90, ry: 20 + rnd() * 45, light: rnd() < 0.5 }));
  const tufts = Array.from({ length: Math.round(area * 0.4) }, () =>
    ({ x: rx(), y: ry(), r: rnd(), ci: Math.floor(rnd() * 4) }));
  return { forest, blobs, tufts };
}

/** The forest that stands, back to front: sparse near the village, dense further out; never inside a wall rect + GAP, the hall, a road or a clearing. */
function standing(forest: GroundTree[], compounds: Compound[], clearings: readonly Rect[]): GroundTree[] {
  const cx = HALL.x0 + HALL.w / 2, cy = HALL.y0 + HALL.h / 2;
  const walls = compounds.map(wallRect);
  const roads = compounds.flatMap(roadRects);
  return forest
    .filter((t) => {
      const d = Math.max(Math.abs(t.x - cx), Math.abs(t.y - cy));
      if (inRect(t.x, t.y, HALL, 1.5)) return false;
      if (walls.some((r) => inRect(t.x, t.y, r, GAP))) return false;
      if (clearings.some((r) => inRect(t.x, t.y, r, CLEARING_PAD))) return false;
      if (roads.some((r) => inRect(t.x, t.y, r, 1))) return false;
      return t.r < Math.max(0.06, Math.min(0.95, (d - 8) / 6));
    })
    .sort((a, c) => a.x + a.y - (c.x + c.y));
}

/**
 * The ground's trees whose canopy reaches over a path tile from in front of it. The path tiles are
 * sprites over the ground, so these are left out of the bake (`drawGround`'s `lifted`) and stood
 * over the paths instead, back to front.
 */
export function treesOverPaths(b: Rect, compounds: Compound[], seed: number, clearings: readonly Rect[], tiles: Map<string, Tile>): GroundTree[] {
  const centres = [...tiles.values()].map((t) => iso(t.x + 0.5, t.y + 0.5));
  return standing(groundPlan(b, seed).forest, compounds, clearings).filter((t) => {
    const p = iso(t.x, t.y), k = t.s * TREE_K;
    const half = TREE_REACH.half * k + TW / 2, up = TREE_REACH.up * k;
    return centres.some((c) => Math.abs(c.x - p.x) < half && c.y - TH / 2 < p.y && c.y + TH / 2 > p.y - up);
  });
}

// Packed earth in the painted kit's palette: warm fill, darker mottling, a shaded lip where the
// grass overhangs it (scalloped, outlined like the kit), outlined two-tone stones and tufts.
const DIRT = '#c4945a';
const DIRT_WORN = 'rgba(232, 194, 132, 0.55)';
const DIRT_MOTTLE = ['rgba(140, 92, 50, 0.22)', 'rgba(244, 212, 156, 0.28)'];
const GRASS_LIP = '#5aa832', GRASS_LIT = '#78c445', GRASS_OUT = '#2f5a1a';

const tkey = (x: number, y: number) => `${x},${y}`;

/**
 * The tiles laid as dirt path, by `x,y`: the hall's plaza, the road to each gate, each house's
 * footprint and the way in from its gate. Laid on the grid as sprites (`drawPathTile`), crisp at
 * the art's density, rather than painted into the half-density ground.
 */
export function pathTiles(compounds: Compound[]): Map<string, Tile> {
  const out = new Map<string, Tile>();
  const add = (x: number, y: number) => out.set(tkey(x, y), { x, y });
  const rect = (r: Rect) => { for (let y = r.y0; y < r.y0 + r.h; y++) for (let x = r.x0; x < r.x0 + r.w; x++) add(x, y); };
  rect(HALL);
  for (const c of compounds) {
    for (const r of roadRects(c)) rect(r);
    rect({ x0: c.house.x, y0: c.house.y, w: HOUSE, h: HOUSE });
    // from inside the gate to the house: along one axis, then the other
    let { x, y } = gateInside(c);
    const hx = (v: number) => Math.min(Math.max(v, c.house.x), c.house.x + HOUSE - 1);
    const hy = (v: number) => Math.min(Math.max(v, c.house.y), c.house.y + HOUSE - 1);
    add(x, y);
    while (x !== hx(x)) { x += Math.sign(hx(x) - x); add(x, y); }
    while (y !== hy(y)) { y += Math.sign(hy(y) - y); add(x, y); }
  }
  return out;
}

/** Which of a path tile's neighbours (n: y-1, e: x+1, s: y+1, w: x-1) are path too, in `nesw` order. */
export function pathLinks(tiles: Map<string, Tile>, t: Tile): string {
  const dirs: [string, number, number][] = [['n', 0, -1], ['e', 1, 0], ['s', 0, 1], ['w', -1, 0]];
  return dirs.filter(([, dx, dy]) => tiles.has(tkey(t.x + dx, t.y + dy))).map(([d]) => d).join('');
}

/**
 * One tile of dirt path, its grass-facing edges (those not in `links`) under a scalloped grass lip
 * with a shade on the dirt; `variant` (0-2) shuffles the stones and patches. Anchor: the tile's
 * front corner, grid point (tx+1, ty+1) for tile (tx, ty).
 */
export function drawPathTile(links: string, variant: number): Art {
  return bake(84, 56, 42, 46, () => {
    const g = ctx();
    let s = 17 + variant * 7919 + [...links].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 0);
    const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    g.save();
    g.transform(TW / 2, TH / 2, -TW / 2, TH / 2, 0, 0); // tile space: u along x, v along y
    const has = (d: string) => links.includes(d);
    // dirt, overlapping its path neighbours a little so no seam shows
    const o = 0.03;
    const u0 = has('w') ? -o : 0, u1 = has('e') ? 1 + o : 1, v0 = has('n') ? -o : 0, v1 = has('s') ? 1 + o : 1;
    g.fillStyle = DIRT; g.fillRect(u0, v0, u1 - u0, v1 - v0);
    for (let i = 0; i < 4; i++) {
      g.fillStyle = DIRT_MOTTLE[rnd() < 0.6 ? 0 : 1];
      g.beginPath(); g.ellipse(0.15 + rnd() * 0.7, 0.15 + rnd() * 0.7, 0.12 + rnd() * 0.16, 0.08 + rnd() * 0.1, rnd() * Math.PI, 0, Math.PI * 2); g.fill();
    }
    if (links.length >= 3) { g.fillStyle = DIRT_WORN; g.beginPath(); g.ellipse(0.5, 0.5, 0.34, 0.3, 0, 0, Math.PI * 2); g.fill(); }
    // stones: outlined, a shadow side and a lit top
    for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) {
      const x = 0.18 + rnd() * 0.64, y = 0.18 + rnd() * 0.64, r = 0.035 + rnd() * 0.04;
      g.fillStyle = rnd() < 0.5 ? '#b9a07a' : '#a8a39a';
      g.beginPath(); g.ellipse(x, y, r, r * 0.85, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#4a3220'; g.lineWidth = 0.014; g.stroke();
      g.fillStyle = 'rgba(255, 246, 224, 0.65)';
      g.beginPath(); g.ellipse(x - r * 0.3, y - r * 0.3, r * 0.4, r * 0.3, 0, 0, Math.PI * 2); g.fill();
    }
    // each grass-facing edge: the dirt shaded under the lip, then the lip, scalloped and outlined
    const edges: [string, (t: number, d: number) => [number, number]][] = [
      ['n', (t, d) => [t, d]], ['s', (t, d) => [t, 1 - d]], ['w', (t, d) => [d, t]], ['e', (t, d) => [1 - d, t]],
    ];
    for (const [dir, at] of edges) {
      if (has(dir)) continue;
      const [ax, ay] = at(0, 0), [bx, by] = at(0, 0.2);
      const sh = g.createLinearGradient(ax, ay, bx, by);
      sh.addColorStop(0, 'rgba(70, 45, 22, 0.5)'); sh.addColorStop(1, 'rgba(70, 45, 22, 0)');
      g.fillStyle = sh;
      g.beginPath();
      for (const [t, d] of [[0, 0], [1, 0], [1, 0.2], [0, 0.2]]) { const [x, y] = at(t, d); g.lineTo(x, y); }
      g.closePath(); g.fill();
      // the lip: from just outside the edge to a scalloped line 0.06-0.1 in
      g.beginPath();
      { const [x, y] = at(-0.02, -0.06); g.moveTo(x, y); }
      { const [x, y] = at(1.02, -0.06); g.lineTo(x, y); }
      const k = 7;
      for (let i = k; i >= 0; i--) {
        const t = i / k, d = 0.05 + (i % 2 ? 0.05 : 0.015) + rnd() * 0.02;
        const [x, y] = at(t, d); g.lineTo(x, y);
      }
      g.closePath();
      g.fillStyle = GRASS_LIP; g.fill();
      g.strokeStyle = GRASS_OUT; g.lineWidth = 0.02; g.lineJoin = 'round'; g.stroke();
      g.fillStyle = GRASS_LIT;
      for (let i = 0; i < 3; i++) { const [x, y] = at(0.15 + rnd() * 0.7, 0.03); g.beginPath(); g.ellipse(x, y, 0.05, 0.03, 0, 0, Math.PI * 2); g.fill(); }
    }
    g.restore();
  }, iso(1, 1));
}
