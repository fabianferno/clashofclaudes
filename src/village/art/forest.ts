import type { Compound } from '../../api/types';
import { toGrid } from '../iso';
import { villageRect, type Rect } from '../layout';
import { withContext } from './draw';
import { paintTree } from './scenery';

/**
 * The deep forest around the village. One field (`forestField`) says how deep in the forest each
 * spot is: open near the hall, the compounds and the collectors, thickening over a ragged edge.
 * The ground bake's trees, its grass and its shade all follow it, so the clearing has a natural
 * shape and melts into the endless canopy drawn behind (`forestTile`), whose shade it matches.
 */

const rng = (seed: number) => {
  let s = seed;
  return () => (s = (s * 9301 + 49297) % 233280) / 233280;
};

/** A hash of a lattice point to [0, 1). */
function hash(i: number, j: number, seed: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1); with `period`, it repeats every `period` lattice cells. */
export function valueNoise(x: number, y: number, seed: number, period = 0): number {
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const w = (a: number) => (period ? ((a % period) + period) % period : a);
  const h = (a: number, b: number) => hash(w(a), w(b), seed);
  const top = h(i, j) + (h(i + 1, j) - h(i, j)) * u;
  const bot = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * u;
  return top + (bot - top) * v;
}

const smoothstep = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

const rectDist = (r: Rect, x: number, y: number) =>
  Math.hypot(Math.max(r.x0 - x, 0, x - (r.x0 + r.w)), Math.max(r.y0 - y, 0, y - (r.y0 + r.h)));

/** Tiles from the nearest open place where the forest starts to thicken, and where it is full. */
export const FOREST_START = 3;
export const FOREST_FULL = 10;
/** How far (tiles) the noise pushes the forest's edge in or out. */
const EDGE_WOBBLE = 3.5;
/** Within this many tiles of the bake's edge the forest is full, whatever the field says. */
const EDGE_FULL = 1;
const EDGE_EASE = 4;

/**
 * How deep in the forest tile point (x, y) is, 0 (open) to 1 (deep forest): by its distance from
 * the nearest open place (the village's whole extent, hall to outermost walls, and each clearing;
 * so no gap between compounds or road legs ever thickens into forest mid-village), pushed in and out by noise so
 * the edge wanders, and always full at the edge of the bake `b` (where the backdrop takes over).
 */
export function forestField(b: Rect, compounds: Compound[], clearings: readonly Rect[], seed: number): (x: number, y: number) => number {
  const open = [villageRect(compounds), ...clearings];
  return (x, y) => {
    let d = Infinity;
    for (const r of open) d = Math.min(d, rectDist(r, x, y));
    const n = (valueNoise(x / 7, y / 7, seed) - 0.5) * 2 * EDGE_WOBBLE + (valueNoise(x / 2.5 + 31, y / 2.5 + 17, seed + 1) - 0.5) * 2;
    const edge = Math.min(x - b.x0, b.x0 + b.w - x, y - b.y0, b.y0 + b.h - y);
    return Math.max(smoothstep(FOREST_START, FOREST_FULL, d + n), smoothstep(EDGE_FULL + EDGE_EASE, EDGE_FULL, edge));
  };
}

/** The shade under the canopy: laid over the backdrop and, as deep as the field says, over the bake. */
export const SHADE_RGB = [14, 34, 26] as const;
export const SHADE_ALPHA = 0.42;

/**
 * Two small masks over the bake's rectangle (world origin `o`, size `w` x `h`): `grass`, white as
 * opaque as the spot is open (the grass is kept by it), and `shade`, the canopy's shade as strong
 * as the spot is deep. Stretched to the bake, which smooths them.
 */
export function forestMasks(field: (x: number, y: number) => number, o: { x: number; y: number }, w: number, h: number): { grass: HTMLCanvasElement; shade: HTMLCanvasElement } {
  const MW = 320, MH = Math.max(16, Math.round((MW * h) / w));
  const make = () => {
    const c = document.createElement('canvas');
    c.width = MW; c.height = MH;
    const g = c.getContext('2d')!;
    return { c, g, img: g.createImageData(MW, MH) };
  };
  const grass = make(), shade = make();
  for (let py = 0; py < MH; py++) {
    for (let px = 0; px < MW; px++) {
      const t = toGrid(o.x + ((px + 0.5) * w) / MW, o.y + ((py + 0.5) * h) / MH);
      const f = field(t.x, t.y), k = (py * MW + px) * 4;
      grass.img.data[k] = grass.img.data[k + 1] = grass.img.data[k + 2] = 255;
      grass.img.data[k + 3] = Math.round((1 - f) * 255);
      shade.img.data[k] = SHADE_RGB[0]; shade.img.data[k + 1] = SHADE_RGB[1]; shade.img.data[k + 2] = SHADE_RGB[2];
      shade.img.data[k + 3] = Math.round(f * SHADE_ALPHA * 255);
    }
  }
  grass.g.putImageData(grass.img, 0, 0);
  shade.g.putImageData(shade.img, 0, 0);
  return { grass: grass.c, shade: shade.c };
}

let grass: HTMLCanvasElement | null = null;
/** A seamless 512px grass tile (drawn at 2x density, shown at half size): the village's grass, painted into the ground bake. Drawn once. */
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
export const FOREST_FLOOR = '#1a3d18';

/**
 * A seamless tile of dense canopy: the village's own trees, loosely scattered, pines and oaks in
 * clumps (noise that repeats with the tile), a few gaps, painted back to front with every copy
 * across the wrap seam in one sorted pass, then the canopy's shade over it all.
 */
export function forestTile(): HTMLCanvasElement {
  const W = FOREST_TILE, c = document.createElement('canvas');
  c.width = c.height = W * 2;
  const g = c.getContext('2d')!;
  g.fillStyle = FOREST_FLOOR;
  g.fillRect(0, 0, c.width, c.height);
  const rnd = rng(11);
  const COLS = 13, ROWS = 22, CLUMP = 5; // clump noise cells across the tile
  const trees: Array<{ x: number; y: number; s: number; pine: boolean }> = [];
  for (let r = 0; r < ROWS; r++) {
    for (let k = 0; k < COLS; k++) {
      if (rnd() < 0.07) continue; // a gap where the floor shows
      const x = ((k + rnd()) / COLS) * W;
      const y = ((r + rnd()) / ROWS) * W;
      const clump = valueNoise((x / W) * CLUMP, (y / W) * CLUMP, 7, CLUMP);
      trees.push({ x, y, s: 0.85 + rnd() * 0.6, pine: clump + (rnd() - 0.5) * 0.35 > 0.5 });
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
  g.fillStyle = `rgba(${SHADE_RGB.join(',')},${SHADE_ALPHA})`;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

/** Canvas px of a patch tile; it is stretched to `period` world px, so its repeat is far apart. */
export const PATCH_PX = 256;

/**
 * Soft light and dark patches that repeat every tile, seamlessly: laid over the forest at a size
 * unrelated to its tile (two of them, at two sizes), they break its repeat into an uneven canopy.
 */
export function patchTile(seed: number): HTMLCanvasElement {
  const N = PATCH_PX, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const rnd = rng(seed);
  for (let i = 0; i < 26; i++) {
    const x = rnd() * N, y = rnd() * N, r = 18 + rnd() * 46, dark = rnd() < 0.6;
    const rgb = dark ? '6,18,10' : '150,170,70';
    const a = dark ? 0.4 : 0.3;
    for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
      const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr;
      g.beginPath(); g.ellipse(x + dx, y + dy, r, r * 0.6, 0, 0, Math.PI * 2); g.fill();
    }
  }
  return c;
}

/** A light vignette over the whole view: clear in the middle, smoky toward the window's edges. */
export function vignetteTexture(): HTMLCanvasElement {
  const N = 256, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(N / 2, N / 2, N * 0.3, N / 2, N / 2, N * 0.72);
  gr.addColorStop(0, 'rgba(10,24,18,0)');
  gr.addColorStop(1, 'rgba(10,24,18,0.45)');
  g.fillStyle = gr;
  g.fillRect(0, 0, N, N);
  return c;
}
