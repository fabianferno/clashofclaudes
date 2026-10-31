import type { Compound } from '../../api/types';
import { iso, TW, TH } from '../iso';
import { GAP, HALL, wallRect, gateTile, type Rect } from '../layout';
import { bake, ctx, poly, type Pt } from './draw';
import { paintTree } from './scenery';

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

const inRect = (x: number, y: number, r: Rect, pad = 0) =>
  x > r.x0 - pad && x < r.x0 + r.w + pad && y > r.y0 - pad && y < r.y0 + r.h + pad;

/**
 * Grass, dirt paths hall -> each gate, and forest cleared from every wall rect (+GAP) and the hall.
 * Deterministic for a given seed. Returns a bare canvas at GROUND_SCALE density (no anchor, unlike Art),
 * sized by `groundBakeSize(bounds)`: place it at `groundOrigin(bounds)` in world px with scale 1 / GROUND_SCALE.
 */
export function drawGround(b: Rect, compounds: Compound[], seed: number): HTMLCanvasElement {
  let s = (Math.abs(Math.floor(seed)) % 233280) || 5;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const o = groundOrigin(b);
  const { w, h } = groundBakeSize(b);
  const area = b.w * b.h;
  const cx = HALL.x0 + HALL.w / 2, cy = HALL.y0 + HALL.h / 2;
  const walls = compounds.map(wallRect);
  const rx = () => b.x0 + rnd() * b.w;
  const ry = () => b.y0 + rnd() * b.h;

  // Generate every random draw up front so output depends only on (bounds, seed), not on filtering.
  const forest = Array.from({ length: Math.min(6000, Math.round(area * 0.65)) }, () =>
    ({ x: rx(), y: ry(), s: 0.9 + rnd() * 0.5, pine: rnd() < 0.45, r: rnd() }));
  const blobs = Array.from({ length: Math.round(area * 0.18) }, () =>
    ({ x: rx(), y: ry(), rx: 40 + rnd() * 90, ry: 20 + rnd() * 45, light: rnd() < 0.5 }));
  const tufts = Array.from({ length: Math.round(area * 0.4) }, () =>
    ({ x: rx(), y: ry(), r: rnd(), ci: Math.floor(rnd() * 4) }));

  return bake(w, h, 0, 0, () => {
    const g = ctx();
    const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] =>
      [iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)];
    g.fillStyle = '#5aa832';
    g.fillRect(o.x, o.y, w, h);
    for (const t of blobs) {
      const p = iso(t.x, t.y);
      const rgb = t.light ? '120,196,64' : '62,130,34';
      const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, t.rx);
      gr.addColorStop(0, `rgba(${rgb},.5)`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.beginPath(); g.ellipse(p.x, p.y, t.rx, t.ry, 0, 0, Math.PI * 2); g.fill();
    }
    for (const r of walls) poly(rect(r.x0, r.y0, r.x0 + r.w, r.y0 + r.h), 'rgba(170,235,100,.3)');

    // hall plaza, dirt roads hall -> each gate, house pads: drawn in tile space so the iso
    // foreshortening is exact, with rounded ends, layered soft rims and scattered pebbles (no
    // stamped diamonds, whose stepped edges read as pixels once the half-density bake is scaled up)
    inTiles((t) => {
      dirtPad(t, HALL.x0 - 0.3, HALL.y0 - 0.3, HALL.w + 0.6, HALL.h + 0.6, 0.7);
      for (const c of compounds) {
        const gt = gateTile(c);
        dirtRoad(t, { x: cx, y: cy }, { x: gt.x + 0.5, y: gt.y + 0.5 }, gt.x * 31 + gt.y * 17);
      }
      // the plaza on top, so roads run out from under it
      dirtPad(t, HALL.x0 - 0.3, HALL.y0 - 0.3, HALL.w + 0.6, HALL.h + 0.6, 0.7, false);
      for (const c of compounds) dirtPad(t, c.house.x - 0.4, c.house.y - 0.4, 3.8, 3.8, 0.55);
    });
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
    // forest: sparse near the village, dense further out; never inside a wall rect + GAP or the hall
    forest
      .filter((t) => {
        const d = Math.max(Math.abs(t.x - cx), Math.abs(t.y - cy));
        if (inRect(t.x, t.y, HALL, 1.5)) return false;
        if (walls.some((r) => inRect(t.x, t.y, r, GAP))) return false;
        return t.r < Math.max(0.06, Math.min(0.95, (d - 8) / 6));
      })
      .sort((a, c) => a.x + a.y - (c.x + c.y))
      .forEach((t) => {
        const p = iso(t.x, t.y);
        g.save(); g.translate(p.x, p.y);
        paintTree(t.pine, t.s);
        g.restore();
      });
  }, o, GROUND_SCALE).canvas;
}

const DIRT_EDGE = 'rgba(92, 66, 32, 0.28)';
const DIRT_RIM = '#b08752';
const DIRT = '#d8b679';
const DIRT_WORN = 'rgba(240, 216, 164, 0.55)';

/** Runs `fn` with the canvas mapped to tile space (1 unit = 1 tile, iso-projected). */
function inTiles(fn: (g: CanvasRenderingContext2D) => void): void {
  const g = ctx();
  g.save();
  g.transform(TW / 2, TH / 2, -TW / 2, TH / 2, 0, 0);
  try { fn(g); } finally { g.restore(); }
}

/** A small deterministic generator for decoration that must not shift the scene's main sequence. */
function seeded(seed: number): () => number {
  let s = (Math.abs(Math.floor(seed)) % 233280) || 7;
  return () => (s = (s * 9301 + 49297) % 233280) / 233280;
}

/** Pebbles and grass tufts scattered at `pts` (tile space), softening the rim. */
function speckle(g: CanvasRenderingContext2D, pts: { x: number; y: number }[], rnd: () => number): void {
  for (const p of pts) {
    const pebble = rnd() < 0.7;
    g.fillStyle = pebble ? (rnd() < 0.5 ? 'rgba(150, 112, 66, 0.75)' : 'rgba(246, 228, 186, 0.85)') : 'rgba(90, 168, 50, 0.95)';
    g.beginPath();
    g.arc(p.x, p.y, pebble ? 0.03 + rnd() * 0.04 : 0.06 + rnd() * 0.06, 0, Math.PI * 2);
    g.fill();
  }
}

/** A dirt road from `a` to `b` (tile coords): soft edge, rim, fill, a worn centre and pebbles. */
function dirtRoad(g: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, seed: number): void {
  const trace = () => { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); };
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [w, col] of [[1.42, DIRT_EDGE], [1.22, DIRT_RIM], [1.02, DIRT], [0.42, DIRT_WORN]] as [number, string][]) {
    g.strokeStyle = col;
    g.lineWidth = w;
    trace();
    g.stroke();
  }
  const rnd = seeded(seed);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const pts = Array.from({ length: Math.round(len * 9) }, () => {
    const t = rnd(), edge = rnd() < 0.35;
    // most specks inside the road; some grass sits on the rim to break its line
    const off = edge ? (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.12) : (rnd() - 0.5) * 0.85;
    return { x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off };
  });
  speckle(g, pts, rnd);
}

/** A dirt pad over the tile rect (x, y, w, h) with rounded corners `r`; `rim` draws the soft edge. */
function dirtPad(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, rim = true): void {
  const shape = (grow: number) => {
    g.beginPath();
    g.roundRect(x - grow, y - grow, w + grow * 2, h + grow * 2, Math.max(0, r + grow));
  };
  if (rim) {
    g.fillStyle = DIRT_EDGE; shape(0.2); g.fill();
    g.fillStyle = DIRT_RIM; shape(0.1); g.fill();
  }
  g.fillStyle = DIRT; shape(0); g.fill();
  const rnd = seeded(x * 13 + y * 7 + w);
  const pts = Array.from({ length: Math.round(w * h * 3) }, () => ({ x: x + 0.15 + rnd() * (w - 0.3), y: y + 0.15 + rnd() * (h - 0.3) }));
  speckle(g, pts, rnd);
}
