import { iso } from '../iso';
import type { Rect } from '../layout';
import { withContext } from './draw';
import { paintTree } from './scenery';

/**
 * The deep forest around the village: an endless canopy behind everything (`forestTile`), the
 * village's grass faded into it at the ground bake's edge (`grassFade`), and a haze over the far
 * forest (`hazeTexture`) so it reads deeper and smokier than the trees ringing the village.
 */

const rng = (seed: number) => {
  let s = seed;
  return () => (s = (s * 9301 + 49297) % 233280) / 233280;
};

/** A seamless 512px grass tile (drawn at 2x density, shown at half size): the village's grass, painted into the ground bake. */
let grass: HTMLCanvasElement | null = null;
export function grassTile(): HTMLCanvasElement {
  if (grass) return grass;
  const N = 512, c = document.createElement('canvas');
  grass = c;
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5aa832'; g.fillRect(0, 0, N, N);
  let s = 7;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const wrap = (x: number, y: number, f: (x: number, y: number) => void) => {
    for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) f(x + dx, y + dy);
  };
  for (let i = 0; i < 40; i++) {
    const x = rnd() * N, y = rnd() * N, rx = 40 + rnd() * 80, ry = rx / 2, rgb = rnd() < 0.5 ? '120,196,64' : '62,130,34';
    wrap(x, y, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, rx);
      gr.addColorStop(0, `rgba(${rgb},.5)`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.beginPath(); g.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2); g.fill();
    });
  }
  g.strokeStyle = 'rgba(40,100,20,.5)'; g.lineWidth = 2;
  for (let i = 0; i < 120; i++) {
    wrap(rnd() * N, rnd() * N, (x, y) => {
      g.beginPath(); g.moveTo(x - 4, y); g.lineTo(x - 1, y - 7); g.moveTo(x, y); g.lineTo(x + 1, y - 8); g.moveTo(x + 4, y); g.lineTo(x + 5, y - 6); g.stroke();
    });
  }
  return c;
}

/** World px of one forest tile (drawn at 2x density, so its canvas is twice this). */
export const FOREST_TILE = 512;

/** The colour between the crowns, and the renderer's clear colour (the forest's floor in shade). */
export const FOREST_FLOOR = '#1f4a1c';

/**
 * A seamless tile of dense canopy: the village's own trees, packed on a jittered grid and painted
 * back to front, every copy across the wrap seam in one sorted pass so the tile repeats cleanly.
 */
export function forestTile(): HTMLCanvasElement {
  const W = FOREST_TILE, c = document.createElement('canvas');
  c.width = c.height = W * 2;
  const g = c.getContext('2d')!;
  g.fillStyle = FOREST_FLOOR;
  g.fillRect(0, 0, c.width, c.height);
  const rnd = rng(11);
  const COLS = 13, ROWS = 22;
  const trees: Array<{ x: number; y: number; s: number; pine: boolean }> = [];
  for (let r = 0; r < ROWS; r++) {
    for (let k = 0; k < COLS; k++) {
      const x = ((k + (r % 2) * 0.5) / COLS) * W + (rnd() - 0.5) * 18;
      const y = (r / ROWS) * W + (rnd() - 0.5) * 10;
      trees.push({ x, y, s: 0.95 + rnd() * 0.45, pine: rnd() < 0.45 });
    }
  }
  // a crown reaches ~45 px either side and ~115 px up from its trunk, its foot ~20 px below it
  const copies = trees.flatMap((t) => [-W, 0, W].flatMap((dx) => [-W, 0, W].map((dy) => ({ ...t, x: t.x + dx, y: t.y + dy }))))
    .filter((t) => t.x > -60 && t.x < W + 60 && t.y > -30 && t.y - 130 < W)
    .sort((a, b) => a.y - b.y);
  withContext(g, () => {
    for (const t of copies) {
      g.setTransform(2, 0, 0, 2, t.x * 2, t.y * 2);
      paintTree(t.pine, t.s);
    }
  });
  g.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

/** Tiles in from the ground bake's edge where its grass is fully opaque, and where it has faded out. */
export const FADE_IN = 8;
export const FADE_OUT = 1.5;

/**
 * A small white mask of the bake's diamond (tile rect `b`): opaque deeper than FADE_IN tiles in,
 * clear within FADE_OUT of the edge, stepped between (smoothed once it is stretched to the bake).
 * `o`/`w`/`h` are the bake's world origin and size; the mask covers exactly that rectangle.
 */
export function grassFade(b: Rect, o: { x: number; y: number }, w: number, h: number): HTMLCanvasElement {
  const MW = 256, MH = Math.max(16, Math.round((MW * h) / w));
  const c = document.createElement('canvas');
  c.width = MW; c.height = MH;
  const g = c.getContext('2d')!;
  const sx = MW / w, sy = MH / h;
  const diamond = (inset: number) => {
    const pts = [iso(b.x0 + inset, b.y0 + inset), iso(b.x0 + b.w - inset, b.y0 + inset), iso(b.x0 + b.w - inset, b.y0 + b.h - inset), iso(b.x0 + inset, b.y0 + b.h - inset)];
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, (p.x - o.x) * sx, (p.y - o.y) * sy));
    g.closePath();
    g.fill();
  };
  const STEPS = 16;
  g.fillStyle = 'rgba(255,255,255,0.2)';
  for (let i = 0; i < STEPS; i++) {
    const inset = FADE_OUT + ((FADE_IN - FADE_OUT) * i) / STEPS;
    if (inset * 2 < Math.min(b.w, b.h)) diamond(inset);
  }
  g.fillStyle = '#fff';
  if (FADE_IN * 2 < Math.min(b.w, b.h)) diamond(FADE_IN);
  return c;
}

/**
 * A soft haze laid over the far forest, under the village: a light veil in the middle that thickens
 * into smoky shade toward the window's edges. Stretched to the window.
 */
export function hazeTexture(): HTMLCanvasElement {
  const N = 256, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(N / 2, N / 2, N * 0.1, N / 2, N / 2, N * 0.72);
  gr.addColorStop(0, 'rgba(20,44,34,0.22)');
  gr.addColorStop(0.55, 'rgba(18,40,32,0.38)');
  gr.addColorStop(1, 'rgba(10,24,20,0.7)');
  g.fillStyle = gr;
  g.fillRect(0, 0, N, N);
  return c;
}
