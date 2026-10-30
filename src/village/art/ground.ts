import type { Compound } from '../../api/types';
import { iso } from '../iso';
import { GAP, HALL, wallRect, gateSide, type Rect } from '../layout';
import { bake, ctx, poly, type Pt } from './draw';
import { paintTree } from './scenery';

const PAD_TOP = 90;
const PAD = 40;

/** World px (iso space) of the ground canvas' top-left corner. Ground is baked at 1x. */
export function groundOrigin(b: Rect): Pt {
  return { x: iso(b.x0, b.y0 + b.h).x - PAD, y: iso(b.x0, b.y0).y - PAD_TOP };
}

const inRect = (x: number, y: number, r: Rect, pad = 0) =>
  x > r.x0 - pad && x < r.x0 + r.w + pad && y > r.y0 - pad && y < r.y0 + r.h + pad;

function gatePoint(c: Compound): Pt {
  const w = wallRect(c);
  switch (gateSide(c)) {
    case 'n': return { x: w.x0 + w.w / 2, y: w.y0 };
    case 's': return { x: w.x0 + w.w / 2, y: w.y0 + w.h };
    case 'w': return { x: w.x0, y: w.y0 + w.h / 2 };
    default: return { x: w.x0 + w.w, y: w.y0 + w.h / 2 };
  }
}

/**
 * Grass, dirt paths hall -> each gate, and forest cleared from every wall rect (+GAP) and the hall.
 * Deterministic for a given seed. Returns a 1x-density canvas; `groundOrigin(bounds)` locates it.
 */
export function drawGround(b: Rect, compounds: Compound[], seed: number): HTMLCanvasElement {
  let s = (Math.abs(Math.floor(seed)) % 233280) || 5;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const o = groundOrigin(b);
  const w = iso(b.x0 + b.w, b.y0).x + PAD - o.x;
  const h = iso(b.x0 + b.w, b.y0 + b.h).y + PAD - o.y;
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

    // hall plaza
    poly(rect(HALL.x0 - 0.3, HALL.y0 - 0.3, HALL.x0 + HALL.w + 0.3, HALL.y0 + HALL.h + 0.3), '#b48c55');
    poly(rect(HALL.x0 - 0.1, HALL.y0 - 0.1, HALL.x0 + HALL.w + 0.1, HALL.y0 + HALL.h + 0.1), '#dcbb80');
    // paths hall -> gate
    for (const c of compounds) {
      const gp = gatePoint(c);
      const steps = Math.ceil(Math.hypot(gp.x - cx, gp.y - cy) * 3);
      for (const [r, col] of [[0.6, '#b48c55'], [0.46, '#dcbb80']] as [number, string][])
        for (let i = 0; i <= steps; i++) {
          const t = i / steps, x = cx + (gp.x - cx) * t, y = cy + (gp.y - cy) * t;
          poly(rect(x - r, y - r, x + r, y + r), col);
        }
    }
    for (const c of compounds) {
      const hs = c.house;
      poly(rect(hs.x - 0.4, hs.y - 0.4, hs.x + 3.4, hs.y + 3.4), '#b48c55');
      poly(rect(hs.x - 0.25, hs.y - 0.25, hs.x + 3.25, hs.y + 3.25), '#d4b177');
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
  }, o, 1).canvas;
}
