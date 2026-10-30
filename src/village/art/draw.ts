import { iso } from '../iso';

/** Primitives ported from docs/mockups/village-v6.html. They draw into the context set by `bake`. */
export const OUT = '#1d130b';
export const SCALE = 2; // pixel density of baked art

export interface Pt { x: number; y: number }
export interface Art { canvas: HTMLCanvasElement; ax: number; ay: number }

let cur: CanvasRenderingContext2D | null = null;

/** The context of the bake in progress. */
export function ctx(): CanvasRenderingContext2D {
  if (!cur) throw new Error('draw primitive used outside bake()');
  return cur;
}

/**
 * Draw once into a fresh canvas of w x h logical px at 2x density. The origin (0,0) of `fn`
 * `origin` (world px, default 0,0) lands on logical (ax, ay), which is returned in canvas pixels.
 */
export function bake(w: number, h: number, ax: number, ay: number, fn: () => void, origin: Pt = { x: 0, y: 0 }, scale = SCALE): Art {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);
  const g = canvas.getContext('2d')!;
  g.setTransform(scale, 0, 0, scale, (ax - origin.x) * scale, (ay - origin.y) * scale);
  const prev = cur;
  cur = g;
  try { fn(); } finally { cur = prev; }
  return { canvas, ax: ax * scale, ay: ay * scale };
}

export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const up = (p: Pt, h: number): Pt => ({ x: p.x, y: p.y - h });

function rgbOf(c: string): [number, number, number] {
  const s = c.trim();
  if (s.startsWith('#')) {
    const h = s.length === 4 ? s.slice(1).replace(/./g, (d) => d + d) : s.slice(1);
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return [128, 128, 128];
}

/** Lighten (f > 0) or darken (f < 0) a `#rrggbb` or `rgb(r,g,b)` colour. */
export function shade(c: string, f: number): string {
  const [r, g, b] = rgbOf(c);
  const m = (v: number) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

export function poly(pts: Pt[], fill: string | CanvasGradient | null, stroke?: string | null, lw = 2): void {
  const g = ctx();
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.lineJoin = 'round'; g.stroke(); }
}

export function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  const g = ctx();
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function line(a: Pt, b: Pt, color: string, lw: number, cap: CanvasLineCap = 'butt'): void {
  const g = ctx();
  g.lineCap = cap; g.strokeStyle = color; g.lineWidth = lw;
  g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  g.lineCap = 'butt';
}

export function outlinedText(txt: string, x: number, y: number, size: number, fill: string, lw = 4): void {
  const g = ctx();
  g.font = `400 ${size}px "Lilita One", sans-serif`;
  g.textAlign = 'center';
  g.lineJoin = 'round';
  g.lineWidth = lw;
  g.strokeStyle = OUT;
  g.strokeText(txt, x, y);
  g.fillStyle = fill;
  g.fillText(txt, x, y);
}

export function dot(x: number, y: number, r: number, fill: string, stroke?: string, lw = 2): void {
  const g = ctx();
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = fill; g.fill();
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
}

export function shadow(c: Pt, rx: number, ry: number, alpha = 0.22, dx = 0, dy = 0): void {
  const g = ctx();
  g.fillStyle = `rgba(0,0,0,${alpha})`;
  g.beginPath(); g.ellipse(c.x + dx, c.y + dy, rx, ry, 0, 0, Math.PI * 2); g.fill();
}

export interface Box { A: Pt; B: Pt; C: Pt; D: Pt }

export function isoBox(
  gx: number, gy: number, w: number, d: number, h: number,
  top: string | null, left: string, right: string, lw = 2,
): Box {
  const A = iso(gx, gy), B = iso(gx + w, gy), C = iso(gx + w, gy + d), D = iso(gx, gy + d);
  poly([D, C, up(C, h), up(D, h)], left, OUT, lw);
  poly([C, B, up(B, h), up(C, h)], right, OUT, lw);
  if (top) poly([up(A, h), up(B, h), up(C, h), up(D, h)], top, OUT, lw);
  return { A, B, C, D };
}

export function faceQuad(
  P0: Pt, P1: Pt, h: number, u0: number, u1: number, v0: number, v1: number, fill: string, lw = 2,
): void {
  const a = up(lerp(P0, P1, u0), v0 * h), b = up(lerp(P0, P1, u1), v0 * h);
  const c = up(lerp(P0, P1, u1), v1 * h), d = up(lerp(P0, P1, u0), v1 * h);
  poly([a, b, c, d], fill, lw ? OUT : null, lw);
}

export interface RoofPts { apex: Pt; r1: Pt; r2: Pt }

export function roof(
  gx: number, gy: number, w: number, d: number, h: number, rh: number, color: string, ridge?: string,
): RoofPts {
  const g = ctx();
  const o = 0.24;
  const A = up(iso(gx - o, gy - o), h), B = up(iso(gx + w + o, gy - o), h);
  const C = up(iso(gx + w + o, gy + d + o), h), D = up(iso(gx - o, gy + d + o), h);
  const r1 = up(iso(gx + w / 2, gy - o * 0.3), h + rh), r2 = up(iso(gx + w / 2, gy + d + o * 0.3), h + rh);
  poly([D, C, up(C, -4), up(D, -4)], shade(color, -0.45), OUT);
  poly([C, B, up(B, -4), up(C, -4)], shade(color, -0.55), OUT);
  const gL = g.createLinearGradient(D.x, D.y, r2.x, r2.y);
  gL.addColorStop(0, shade(color, -0.05)); gL.addColorStop(1, shade(color, 0.28));
  poly([A, D, r2, r1], gL, OUT, 2.5);
  const gR = g.createLinearGradient(C.x, C.y, r2.x, r2.y);
  gR.addColorStop(0, shade(color, -0.42)); gR.addColorStop(1, shade(color, -0.18));
  poly([C, B, r1, r2], gR, OUT, 2.5);
  poly([D, C, r2], shade(color, -0.25), OUT, 2.5);
  g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 1.5;
  for (let i = 1; i < 4; i++) {
    const t = i / 4;
    for (const [p1, p2] of [[lerp(C, r2, t), lerp(B, r1, t)], [lerp(D, r2, t), lerp(A, r1, t)]]) {
      g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke();
    }
  }
  line(r1, r2, OUT, 6, 'round');
  line(r1, r2, ridge ?? shade(color, 0.45), 3, 'round');
  return { apex: lerp(r1, r2, 0.5), r1, r2 };
}

export function spire(gx: number, gy: number, w: number, d: number, h: number, rh: number, color: string): { apex: Pt } {
  const o = 0.18;
  const A = up(iso(gx - o, gy - o), h), B = up(iso(gx + w + o, gy - o), h);
  const C = up(iso(gx + w + o, gy + d + o), h), D = up(iso(gx - o, gy + d + o), h);
  const ap = up(iso(gx + w / 2, gy + d / 2), h + rh);
  poly([A, D, ap], shade(color, 0.15), OUT, 2.5); poly([A, B, ap], shade(color, -0.1), OUT, 2.5);
  poly([D, C, ap], shade(color, -0.05), OUT, 2.5); poly([C, B, ap], shade(color, -0.35), OUT, 2.5);
  return { apex: ap };
}

/** Static pennant (the mockup animated the wave; baked art holds a mid-wave pose). */
export function flag(p: Pt, color: string, hgt = 30): void {
  const g = ctx();
  line(p, up(p, hgt), OUT, 4);
  line(p, up(p, hgt), '#8a5a2b', 2);
  const w1 = 1.5, w2 = -1;
  g.beginPath();
  g.moveTo(p.x, p.y - hgt);
  g.quadraticCurveTo(p.x + 12, p.y - hgt - 3 + w1, p.x + 24, p.y - hgt + 2 + w2);
  g.lineTo(p.x + 22, p.y - hgt + 13 + w2);
  g.quadraticCurveTo(p.x + 11, p.y - hgt + 9 + w1, p.x, p.y - hgt + 13);
  g.closePath();
  g.fillStyle = color; g.fill(); g.strokeStyle = OUT; g.lineWidth = 2; g.stroke();
  dot(p.x, p.y - hgt - 2, 3, OUT);
}

export function chip(x: number, y: number, text: string, color: string, size = 11): void {
  const g = ctx();
  g.font = `400 ${size}px "Lilita One", sans-serif`;
  const w = g.measureText(text).width + 14, h = size + 7;
  roundRect(x - w / 2, y, w, h, h / 2);
  g.fillStyle = color; g.fill(); g.strokeStyle = OUT; g.lineWidth = 2.5; g.stroke();
  outlinedText(text, x, y + size + 1.5, size, '#fff', 3);
}
