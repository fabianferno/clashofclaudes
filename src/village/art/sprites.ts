import type { AgentKind } from '../../api/types';
import { MARK_FILL_RULE, MARK_GRADIENT, MARK_PATHS, PROMPT_GLYPH, TILES } from '../../agentMarks';
import { RESOURCE, HOUSE_COLORS, type ClassTier, type Gear } from '../look';
import { outlinedText, withContext, type Art } from './draw';

/**
 * The v7 painted art (public/assets/village, described in its manifest.json): sprites at the same
 * 2x density and anchors as the baked art, so each draw function returns one or the other. They
 * are loaded once (`loadSprites`, awaited by `prepareArt`); until then, when one is missing, in
 * unit tests, or with `?art=v6` (or localStorage `coc.art` = `v6`), the draw functions fall back to
 * the procedural art. Geometry below is measured on the images, in canvas px.
 */
const BASE = '/assets/village/';

const CLASSES = ['apprentice', 'craftsman', 'master'] as const;
/** The painted strips; a Legend (tier 3) is drawn from the Master's. */
type Strip = 0 | 1 | 2;
const stripOf = (cls: ClassTier): Strip => (cls === 3 ? 2 : cls);
/** How much bigger a Legend stands than a Master (about the feet). */
export const LEGEND_SCALE = 1.08;
const AGENTS: AgentKind[] = ['claude', 'codex', 'antigravity', 'opencode', 'grok', 'custom'];
/** The frames of a class's strip, in order. The kit's second hammer frame (hammer on the other shoulder, mid-stride) is unused: see `paintedBuilder`. */
const STRIP = ['idle', 'walk0', 'walk1', 'hammer0', 'kitHammer1', 'cheer', 'sad'] as const;
type BuilderPose = 'idle' | 'walk0' | 'walk1' | 'hammer0' | 'hammer1' | 'hammer2' | 'cheer' | 'sad';
/** Pre-tinted house roofs, by the roof colour they were painted in (coral is the untinted default). */
const HOUSE_TINTS: Record<string, string> = {
  '': '#c64a32', '-teal': '#3a8f82', '-orange': '#d4852a', '-blue': '#4f6ec8', '-purple': '#7a4ca8',
};
/** Wall tile by its links (nesw order); the kit names the es corner `se`. */
const WALL_FILE: Record<string, string> = { '': 'post', es: 'se' };
const WALL_LINKS = ['', 'n', 'e', 's', 'w', 'ne', 'ns', 'nw', 'es', 'ew', 'sw', 'nes', 'new', 'nsw', 'esw', 'nesw'];

/** A decoded sprite: an ImageBitmap in the app (always resident, so a bake never draws a purged image), an <img> in tests. */
type Pic = CanvasImageSource & { width: number; height: number };
const images = new Map<string, Pic>();
let loading: Promise<void> | null = null;
let ready = false;
const listeners = new Set<() => void>();

function procedural(): boolean {
  if (import.meta.env?.VITEST) return true;
  try {
    if (new URLSearchParams(location.search).get('art') === 'v6') return true;
    return localStorage.getItem('coc.art') === 'v6';
  } catch {
    return false;
  }
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The pre-tinted house whose roof is nearest `roof`. */
function houseTint(roof: string): string {
  const [r, g, b] = rgb(roof);
  let best = '', d = Infinity;
  for (const [suffix, c] of Object.entries(HOUSE_TINTS)) {
    const [r2, g2, b2] = rgb(c);
    const e = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (e < d) { d = e; best = suffix; }
  }
  return best;
}

function paths(): string[] {
  const out = [
    'buildings/hall.png', 'sheets/trees-sheet.png', 'structures/structure-foundation.png',
    'structures/collector-base.png', 'ui/bubble-needs.png', 'ui/bubble-stuck.png', 'ui/ribbon.png', 'ui/puff.png',
  ];
  for (const a of AGENTS) out.push(`structures/structure-complete-${a}.png`);
  for (const l of WALL_LINKS) out.push(`scenery/wall-${WALL_FILE[l] ?? l}.png`);
  out.push('scenery/gate-ns.png', 'scenery/gate-ew.png');
  for (const c of CLASSES) for (const a of AGENTS) out.push(`sheets/builder-${c}-${a}.png`);
  const tints = new Set(HOUSE_COLORS.map((h) => houseTint(h.roof)));
  for (let s = 0; s < 5; s++) for (const t of tints) out.push(`buildings/house-stage-${s}${t}.png`);
  // a white-roofed house and its roof-and-flag shading, tinted to any other colour (`paintedHouse`)
  for (let s = 0; s < 5; s++) out.push(`buildings/house-stage-${s}-base.png`, `buildings/house-stage-${s}-mask.png`);
  return out;
}

/** Loads and decodes the sprites; idempotent. Never rejects: a sprite that fails stays procedural. */
export function loadSprites(): Promise<void> {
  if (loading) return loading;
  if (procedural() || typeof Image === 'undefined') return (loading = Promise.resolve());
  loading = Promise.all(paths().map(async (p) => {
    const img = new Image();
    img.src = BASE + p;
    try {
      await img.decode();
      images.set(p, typeof createImageBitmap === 'function' ? await createImageBitmap(img) : img);
    } catch {
      console.warn(`village art: ${p} did not load; drawing it procedurally`);
    }
  })).then(() => {
    ready = images.size > 0;
    for (const fn of listeners) fn();
  });
  return loading;
}

export function spritesReady(): boolean {
  return ready;
}

/** Calls `fn` once the sprites have loaded; returns the unsubscribe. */
export function onSprites(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tests: use these images (by path) as the loaded sprites; null forgets them. */
export function setSpritesForTest(imgs: Record<string, Pic> | null): void {
  images.clear();
  for (const [p, img] of Object.entries(imgs ?? {})) images.set(p, img);
  ready = images.size > 0;
}

function get(p: string): Pic | undefined {
  return ready ? images.get(p) : undefined;
}

/** A canvas of w x h canvas px with its anchor at (ax, ay); `fn` draws in canvas px. */
function canvasArt(w: number, h: number, ax: number, ay: number, fn: (g: CanvasRenderingContext2D) => void): Art {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  fn(canvas.getContext('2d')!);
  return { canvas, ax, ay };
}

/** A whole image as art; `ax, ay` is where the footprint's front corner falls on it. */
function whole(p: string, ax: number, ay: number): Art | null {
  const img = get(p);
  return img ? canvasArt(img.width, img.height, ax, ay, (g) => g.drawImage(img, 0, 0)) : null;
}

// Anchors put the painted footprint's centre on the grid footprint's centre (measured).
export const paintedHall = () => whole('buildings/hall.png', 380, 600);
/** Left edge of each house stage's flag pole (5 px wide), which stops short of the roof. */
const HOUSE_POLE = [null, 295, 313, 313, 313];
/** Where the poles end, and how far down to run them so they reach behind the ridge. */
const POLE_END = 237, POLE_FOOT = 256;

/** `mask` (grey shading) multiplied by `color`, keeping the mask's alpha. */
function tinted(mask: Pic, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = mask.width;
  c.height = mask.height;
  const g = c.getContext('2d')!;
  g.drawImage(mask, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(mask, 0, 0);
  return c;
}

/**
 * A house with a `roof`-coloured roof and flag. The automatic colours use the kit's hand-tinted
 * houses; any other colour tints the white-roofed one through its mask.
 */
export function paintedHouse(stage: number, roof: string): Art | null {
  const own = HOUSE_COLORS.some((h) => h.roof === roof);
  const img = get(own ? `buildings/house-stage-${stage}${houseTint(roof)}.png` : `buildings/house-stage-${stage}-base.png`);
  const mask = own ? null : get(`buildings/house-stage-${stage}-mask.png`);
  if (!img || (!own && !mask)) return null;
  return canvasArt(img.width, img.height, 300, 600, (g) => {
    const x = HOUSE_POLE[stage];
    // the pole carried on down behind the roof, from its own lowest pixels
    if (x != null) g.drawImage(img, x, POLE_END - 6, 5, 6, x, POLE_END - 1, 5, POLE_FOOT - POLE_END + 1);
    g.drawImage(img, 0, 0);
    if (mask) g.drawImage(tinted(mask, roof), 0, 0);
  });
}
export const paintedBubble = (kind: 'needs' | 'stuck') => whole(`ui/bubble-${kind}.png`, 60, 112);
export const paintedPuff = () => whole('ui/puff.png', 40, 40);

export const paintedWall = (links: string) => whole(`scenery/wall-${WALL_FILE[links] ?? links}.png`, 110, 144);
/** n/s gates run along x (the kit's `ns` gate), e/w along y. */
export const paintedGate = (side: 'n' | 's' | 'e' | 'w') => whole(`scenery/gate-${side === 'n' || side === 's' ? 'ns' : 'ew'}.png`, 120, 184);

const TREE_W = 200, TREE_H = 260, TREE_AX = 100, TREE_AY = 224;

/** Tree frame 0 oak, 1 pine, 2 big oak, 3 small pine. */
export function paintedTree(v: number): Art | null {
  const img = get('sheets/trees-sheet.png');
  return img ? canvasArt(TREE_W, TREE_H, TREE_AX, TREE_AY, (g) => g.drawImage(img, v * TREE_W, 0, TREE_W, TREE_H, 0, 0, TREE_W, TREE_H)) : null;
}

/**
 * Paint tree frame `v` with its trunk base at the current origin of `g` (world px), `k` times its
 * painted size. Returns false when the sprites are not loaded.
 */
export function paintTreeAt(g: CanvasRenderingContext2D, v: number, k: number): boolean {
  const img = get('sheets/trees-sheet.png');
  if (!img) return false;
  const s = k / 2; // the sheet is 2x
  g.drawImage(img, v * TREE_W, 0, TREE_W, TREE_H, -TREE_AX * s, -TREE_AY * s, TREE_W * s, TREE_H * s);
  return true;
}

const B_W = 220, B_H = 260, B_AX = 110, B_AY = 200;

/** Each gear's hammer head (sampled from the kit's hammer sheet): wooden, iron, gold, runed, enchanted. */
const GEAR_HEAD = ['#926132', '#9da8b2', '#efc53f', '#98c3df', '#fbe48d'];
interface Box { x: number; y: number; w: number; h: number }
/** The hammer head on each class's raised-hammer frame (unflipped frame px); the strips all paint one iron hammer. */
const HAMMER_BOX: Record<Strip, Box> = {
  0: { x: 70, y: 118, w: 24, h: 30 },
  1: { x: 63, y: 106, w: 28, h: 30 },
  2: { x: 58, y: 92, w: 30, h: 36 },
};
/** The front fist on each class's idle frame (unflipped frame px; the feet stand at y 200), and its hammer's handle length. */
const FIST: Record<Strip, { x: number; y: number; len: number }> = {
  0: { x: 131, y: 167, len: 36 },
  1: { x: 136, y: 165, len: 39 },
  2: { x: 143, y: 162, len: 42 },
};
/**
 * Where the agent's badge sits on the hat front (the cap's crown, the helmet's dome, the crown's
 * middle) on the idle frame, its radius, and how far the head moves on the other frames (matched
 * against the idle head; the same on every agent's strip). Unflipped frame px.
 */
const BADGE: Record<Strip, { x: number; y: number; r: number }> = {
  0: { x: 116, y: 102, r: 11.5 },
  1: { x: 116, y: 93, r: 12.5 },
  2: { x: 118, y: 84, r: 12 },
};
const HEAD_SHIFT: Record<Strip, Partial<Record<(typeof STRIP)[number], [number, number]>>> = {
  0: { walk0: [-3, 0], walk1: [-2, 1], hammer0: [6, 0], cheer: [-3, -2], sad: [6, 4] },
  1: { walk0: [1, 0], walk1: [0, 2], hammer0: [7, -1], cheer: [-3, -3], sad: [7, 4] },
  2: { walk0: [1, 0], walk1: [1, 2], hammer0: [2, -3], cheer: [-9, -4], sad: [13, 9] },
};

/** The agent's mark on a round badge (its logo tile's colours) centred at (x, y), radius r. */
function capBadge(g: CanvasRenderingContext2D, agent: AgentKind, x: number, y: number, r: number): void {
  const t = TILES[agent];
  g.save();
  const bg = g.createLinearGradient(x, y - r, x, y + r);
  bg.addColorStop(0, t.top); bg.addColorStop(1, t.bottom);
  // a pin badge: dark edge, cream rim, the tile's colours inside
  g.fillStyle = '#fff3dc'; g.strokeStyle = 'rgba(42,29,20,.9)'; g.lineWidth = 1.6;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = bg;
  g.beginPath(); g.arc(x, y, r - 1.6, 0, Math.PI * 2); g.fill();
  // the mark in its 24px box, filling most of the badge
  const k = (r * 1.3) / 24;
  g.translate(x - 12 * k, y - 12 * k); g.scale(k, k);
  if (t.fg === 'gradient') {
    const m = g.createLinearGradient(0, 0, 24, 24);
    for (const [o, c] of MARK_GRADIENT) m.addColorStop(o, c);
    g.fillStyle = m; g.strokeStyle = m;
  } else {
    g.fillStyle = t.fg; g.strokeStyle = t.fg;
  }
  const path = MARK_PATHS[agent];
  if (typeof Path2D !== 'undefined') {
    if (path) g.fill(new Path2D(path), MARK_FILL_RULE[agent] ?? 'nonzero');
    else {
      g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round';
      for (const d of PROMPT_GLYPH) g.stroke(new Path2D(d));
    }
  }
  g.restore();
  // a glint along the top, like the logo tile's gloss
  g.save();
  g.fillStyle = 'rgba(255,255,255,.35)';
  g.beginPath(); g.ellipse(x - r * 0.15, y - r * 0.55, r * 0.55, r * 0.22, -0.2, 0, Math.PI * 2); g.fill();
  g.restore();
}

/** A Legend's golden aura behind the figure and twinkles round its head (frame px, unflipped). */
function legendGlow(g: CanvasRenderingContext2D, head: { x: number; y: number }): void {
  g.save();
  g.globalCompositeOperation = 'destination-over';
  const glow = g.createRadialGradient(head.x, head.y + 40, 10, head.x, head.y + 40, 92);
  glow.addColorStop(0, 'rgba(255,226,120,.55)');
  glow.addColorStop(0.6, 'rgba(255,206,90,.22)');
  glow.addColorStop(1, 'rgba(255,206,90,0)');
  g.fillStyle = glow; g.fillRect(0, 0, B_W, B_H);
  g.restore();
  g.save();
  g.fillStyle = '#fff6c8'; g.strokeStyle = 'rgba(190,130,20,.8)'; g.lineWidth = 1.2;
  for (const [dx, dy, r] of [[-44, -20, 7], [40, -34, 5.5], [48, 14, 4.5]] as const) {
    const cx = head.x + dx, cy = head.y + dy;
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4, d = i % 2 ? r * 0.32 : r;
      g.lineTo(cx + Math.sin(a) * d, cy - Math.cos(a) * d);
    }
    g.closePath(); g.fill(); g.stroke();
  }
  g.restore();
}

/** The swing in radians from straight up, toward the way the builder faces: level mid-swing, then down on the work. */
const SWING = { hammer1: 1.65, hammer2: 2.45 } as const;

/** Hammer-grey: dull, a little purple (never the warm grey of a custom builder's coat), neither outline nor highlight. */
const isHammer = (r: number, g: number, b: number) =>
  Math.max(r, g, b) - Math.min(r, g, b) < 40 && b >= g - 4 && r >= g - 4 && r + g + b > 90 && r + g + b < 450;

/** Paint the hammer head in `box` in its gear's colour, keeping its shading; runed and enchanted heads glow. */
function gearHammer(g: CanvasRenderingContext2D, box: Box, gear: Gear): void {
  const d = g.getImageData(box.x, box.y, box.w, box.h);
  const px = d.data;
  let sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && isHammer(px[i], px[i + 1], px[i + 2])) { sum += px[i] + px[i + 1] + px[i + 2]; n++; }
  if (!n) return;
  const mean = sum / n, [R, G, B] = rgb(GEAR_HEAD[gear]);
  for (let i = 0; i < px.length; i += 4) {
    if (!(px[i + 3] > 0 && isHammer(px[i], px[i + 1], px[i + 2]))) continue;
    const k = (px[i] + px[i + 1] + px[i + 2]) / mean;
    px[i] = Math.min(255, R * k); px[i + 1] = Math.min(255, G * k); px[i + 2] = Math.min(255, B * k);
  }
  g.putImageData(d, box.x, box.y);
  if (gear >= 3) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2, r = Math.max(box.w, box.h);
    const glow = g.createRadialGradient(cx, cy, 2, cx, cy, r);
    glow.addColorStop(0, gear === 4 ? 'rgba(255,240,150,.55)' : 'rgba(150,210,255,.45)');
    glow.addColorStop(1, 'rgba(255,240,150,0)');
    g.save();
    g.globalCompositeOperation = 'destination-over'; // behind the builder, around the head
    g.fillStyle = glow; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.restore();
  }
}

/** A hammer in the fist at `f`, `a` radians from straight up (clockwise), with its gear's head; drawn in frame px. */
function swungHammer(g: CanvasRenderingContext2D, f: { x: number; y: number; len: number }, a: number, gear: Gear): void {
  const OUT = 'rgba(42,29,20,.85)';
  g.save();
  g.translate(f.x, f.y);
  g.rotate(a);
  g.lineCap = 'round';
  for (const [c, w] of [[OUT, 6.5], ['#8a5a2b', 3.5]] as const) {
    g.strokeStyle = c; g.lineWidth = w;
    g.beginPath(); g.moveTo(0, 4); g.lineTo(0, -f.len); g.stroke();
  }
  // the head, across the handle's end: base, a shadowed lower half, a lit top edge
  const hw = 21, hh = 12, y0 = -f.len - hh / 2;
  const box = (x: number, y: number, w: number, h: number) => { g.beginPath(); g.roundRect(x, y, w, h, 3); };
  g.fillStyle = GEAR_HEAD[gear]; g.strokeStyle = OUT; g.lineWidth = 2;
  box(-hw / 2, y0, hw, hh); g.fill();
  g.fillStyle = 'rgba(40,24,16,.28)'; box(-hw / 2, y0 + hh * 0.55, hw, hh * 0.45); g.fill();
  g.fillStyle = 'rgba(255,255,255,.35)'; box(-hw / 2 + 3, y0 + 2, hw - 6, 2.5); g.fill();
  box(-hw / 2, y0, hw, hh); g.stroke();
  if (gear >= 3) {
    g.globalCompositeOperation = 'destination-over';
    const glow = g.createRadialGradient(0, -f.len, 2, 0, -f.len, 30);
    glow.addColorStop(0, gear === 4 ? 'rgba(255,240,150,.6)' : 'rgba(150,210,255,.5)');
    glow.addColorStop(1, 'rgba(255,240,150,0)');
    g.fillStyle = glow; g.fillRect(-30, -f.len - 30, 60, 60);
  }
  g.restore();
}

/** The arc the head just travelled, fading toward where it came from (the mid-swing frame). */
function swoosh(g: CanvasRenderingContext2D, f: { x: number; y: number; len: number }, to: number): void {
  const r = f.len + 2;
  g.save();
  g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const from = to - 0.35 * (i + 1);
    g.strokeStyle = `rgba(255,250,235,${0.42 - i * 0.1})`; g.lineWidth = 7 - i * 1.4;
    g.beginPath(); g.arc(f.x, f.y, r, from - Math.PI / 2, from + 0.35 - Math.PI / 2); g.stroke();
  }
  g.restore();
}

/** Dust and chips kicked up where the head lands (the strike frame). */
function impact(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.save();
  g.fillStyle = 'rgba(226,206,160,.75)';
  for (const [dx, dy, r] of [[-12, 2, 6], [11, 1, 7], [0, 5, 5], [-20, -3, 3.5], [19, -5, 3]] as const) {
    g.beginPath(); g.ellipse(x + dx, y + dy, r * 1.3, r, 0, 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = '#fff3c4'; g.lineWidth = 2.5; g.lineCap = 'round';
  for (const [dx, dy] of [[-14, -14], [0, -19], [14, -14]] as const) {
    g.beginPath(); g.moveTo(x + dx * 0.45, y + dy * 0.45); g.lineTo(x + dx, y + dy); g.stroke();
  }
  g.restore();
}

/**
 * A builder pose from its class's strip; facing -1 mirrors it about the feet. A hammer stroke is
 * hammer0 (the kit's raised hammer, recoloured for the gear), then hammer1 (level, mid-swing) and
 * hammer2 (down on the work, the body squashed a little) drawn on the planted idle frame: the kit's
 * own second frame only moves the hammer to the other shoulder and reads as a dance step.
 */
export function paintedBuilder(agent: AgentKind, cls: ClassTier, gear: Gear, pose: BuilderPose, face: 1 | -1): Art | null {
  const st = stripOf(cls);
  const img = get(`sheets/builder-${CLASSES[st]}-${agent}.png`);
  if (!img) return null;
  const body = canvasArt(B_W, B_H, B_AX, B_AY, (g) => {
    if (pose === 'hammer1' || pose === 'hammer2') {
      const f = FIST[st], a = SWING[pose];
      g.save();
      if (pose === 'hammer2') { g.translate(B_AX, B_AY); g.scale(1.03, 0.96); g.translate(-B_AX, -B_AY); }
      g.drawImage(img, 0, 0, B_W, B_H, 0, 0, B_W, B_H);
      g.restore();
      const fist = pose === 'hammer2' ? { ...f, y: B_AY - (B_AY - f.y) * 0.96 } : f;
      if (pose === 'hammer1') swoosh(g, fist, a);
      swungHammer(g, fist, a, gear);
      if (pose === 'hammer2') impact(g, fist.x + Math.sin(a) * (f.len + 4), fist.y - Math.cos(a) * (f.len + 4) + 8);
      return;
    }
    g.drawImage(img, STRIP.indexOf(pose) * B_W, 0, B_W, B_H, 0, 0, B_W, B_H);
    if (pose === 'hammer0') gearHammer(g, HAMMER_BOX[st], gear);
  });
  // the badge goes on after any mirroring, so the mark never reads backwards
  const b = BADGE[st];
  const [dx, dy] = pose === 'hammer1' || pose === 'hammer2' ? [0, 0] : HEAD_SHIFT[st][pose] ?? [0, 0];
  let bx = b.x + dx, by = b.y + dy;
  if (pose === 'hammer2') by = B_AY - (B_AY - by) * 0.96; // the squash
  if (face === -1) bx = B_W - bx;
  return canvasArt(B_W, B_H, B_AX, B_AY, (g) => {
    if (cls === 3) { g.translate(B_AX, B_AY); g.scale(LEGEND_SCALE, LEGEND_SCALE); g.translate(-B_AX, -B_AY); }
    if (face === -1) { g.save(); g.translate(B_W, 0); g.scale(-1, 1); g.drawImage(body.canvas, 0, 0); g.restore(); }
    else g.drawImage(body.canvas, 0, 0);
    capBadge(g, agent, bx, by, b.r);
    if (cls === 3) legendGlow(g, { x: bx, y: by });
  });
}

const S_W = 440, S_H = 500, S_AX = 220, S_AY = 392;
/** The pitched tent's frame on its sprite: ridge ends (where the A-frames cross), pole feet, eaves. */
const TENT = {
  backTop: { x: 172, y: 153 }, frontTop: { x: 278, y: 207 },
  backFeet: [{ x: 122, y: 283 }, { x: 226, y: 223 }], frontFeet: [{ x: 213, y: 343 }, { x: 317, y: 283 }],
  eaves: [{ x: 132, y: 263 }, { x: 217, y: 333 }], // the front slope's lower edge
};

type Pt2 = { x: number; y: number };
const mix = (a: Pt2, b: Pt2, t: number): Pt2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** A painted timber pole from a to b (outline, wood, a lit edge), overshooting the top a little. */
function pole(g: CanvasRenderingContext2D, a: Pt2, b: Pt2): void {
  const d = Math.hypot(b.x - a.x, b.y - a.y), top = { x: b.x + ((b.x - a.x) / d) * 14, y: b.y + ((b.y - a.y) / d) * 14 };
  g.lineCap = 'round';
  for (const [c, w, dx] of [['#2a1d14', 11, 0], ['#8a5a2b', 7, 0], ['#b98552', 2.5, -1.5]] as const) {
    g.strokeStyle = c; g.lineWidth = w;
    g.beginPath(); g.moveTo(a.x + dx, a.y); g.lineTo(top.x + dx, top.y); g.stroke();
  }
}

/** Rope lashed round where poles cross. */
function lashing(g: CanvasRenderingContext2D, p: Pt2): void {
  g.fillStyle = '#d9c08a'; g.strokeStyle = '#2a1d14'; g.lineWidth = 2;
  g.beginPath(); g.ellipse(p.x, p.y + 4, 9, 6, -0.4, 0, Math.PI * 2); g.fill(); g.stroke();
  g.strokeStyle = 'rgba(42,29,20,.5)'; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(p.x - 6, p.y + 1); g.lineTo(p.x + 5, p.y + 7); g.stroke();
}

/**
 * A session's tent: the ground cloth while it starts; while it works, the timber frame stands on
 * the cloth and the canvas climbs it from the eaves toward the ridge with the session's progress;
 * finished, the pitched tent with the review ribbon. (The kit paints only the cloth and the
 * pitched tent; the frame and the climbing canvas are drawn here.)
 */
export function paintedStructure(agent: AgentKind, stage: 'foundation' | 'scaffold' | 'complete', height01: number): Art | null {
  const cloth = get('structures/structure-foundation.png');
  const tent = get(`structures/structure-complete-${agent}.png`);
  const ribbon = get('ui/ribbon.png');
  if (!cloth || !tent || !ribbon) return null;
  return canvasArt(S_W, S_H, S_AX, S_AY, (g) => {
    if (stage === 'complete') {
      g.drawImage(tent, 0, 0);
      g.drawImage(ribbon, S_AX - 40, 78, 80, 80);
      return;
    }
    g.drawImage(cloth, 0, 0);
    if (stage === 'foundation') return;
    const p = Math.max(0, Math.min(1, height01));
    const { backTop: B, frontTop: F, backFeet, frontFeet, eaves: [E1, E2] } = TENT;
    for (const foot of backFeet) pole(g, foot, B);
    pole(g, B, F); // the ridge pole
    if (p > 0.02) {
      // the canvas up to `p` of the way from the eaves: the front slope and the door gable
      const s1 = mix(E1, B, p), s2 = mix(E2, F, p), [G1, G2] = frontFeet;
      g.save();
      g.beginPath();
      g.moveTo(E1.x - 6, E1.y + 4); g.lineTo(E2.x, E2.y + 10); g.lineTo(s2.x, s2.y); g.lineTo(s1.x, s1.y); g.closePath();
      g.moveTo(G1.x, G1.y + 10); g.lineTo(G2.x + 8, G2.y + 6); g.lineTo(mix(G2, F, p).x, mix(G2, F, p).y); g.lineTo(mix(G1, F, p).x, mix(G1, F, p).y); g.closePath();
      g.clip();
      g.drawImage(tent, 0, 0);
      g.restore();
      // the hem being hauled up, on a rope
      g.lineCap = 'round';
      for (const [c, w] of [['#2a1d14', 5], ['#d9c08a', 2.5]] as const) {
        g.strokeStyle = c; g.lineWidth = w;
        g.beginPath(); g.moveTo(s1.x, s1.y); g.lineTo(s2.x, s2.y); g.lineTo(mix(G2, F, p).x, mix(G2, F, p).y); g.stroke();
      }
    }
    for (const foot of frontFeet) pole(g, foot, F);
    lashing(g, B);
    lashing(g, F);
  });
}

const C_W = 400, C_H = 440, C_AX = 200, C_AY = 380;
/**
 * The collector's glass: centre x, half width, ellipse half height; the arc under the top band
 * (the glass shows below it), the resource's bottom and its surface when full; and the gold bands'
 * centres, redrawn over the resource. Measured on collector-base.png.
 */
const GLASS = { cx: 200, rx: 46, ry: 18, rim: 223, bot: 290, top: 228, bands: [217, 252, 286], band: 5 };

/** The glass under the top band: everything in the tank's column below the band's front arc. */
function glassClip(g: CanvasRenderingContext2D) {
  const { cx, rx, ry, rim } = GLASS;
  g.beginPath();
  g.ellipse(cx, rim, rx, ry, 0, Math.PI, 0, true);
  g.lineTo(cx + rx, C_H); g.lineTo(cx - rx, C_H); g.closePath();
  g.clip();
}

/** Resource collector: the painted tank, filled `tenths` (0-10) with the agent's resource; null shows "?". */
export function paintedCollector(agent: keyof typeof RESOURCE, tenths: number | null): Art | null {
  const base = get('structures/collector-base.png');
  if (!base) return null;
  const E = RESOURCE[agent];
  const { cx, rx, ry, bot, top } = GLASS;
  return canvasArt(C_W, C_H, C_AX, C_AY, (g) => {
    g.drawImage(base, 0, 0);
    const level = tenths === null ? 0 : Math.max(0, Math.min(10, tenths)) / 10;
    if (level > 0) {
      const surf = bot - (bot - top) * level;
      g.save();
      glassClip(g);
      // the column of resource, to the surface
      const column = () => {
        g.beginPath(); g.ellipse(cx, bot, rx, ry, 0, 0, Math.PI); g.lineTo(cx - rx, surf); g.lineTo(cx + rx, surf); g.closePath();
      };
      g.save();
      column();
      g.clip();
      const gr = g.createLinearGradient(cx - rx, 0, cx + rx, 0);
      gr.addColorStop(0, E.deep); gr.addColorStop(0.35, E.mid); gr.addColorStop(0.7, E.mid); gr.addColorStop(1, E.deep);
      g.globalAlpha = 0.88;
      g.fillStyle = gr; g.fillRect(cx - rx, surf, rx * 2, bot - surf + ry);
      g.globalAlpha = 1;
      for (const [dx, dy, r] of [[-20, 0.35, 5], [12, 0.6, 4], [26, 0.25, 3.5], [-8, 0.8, 3]] as const) {
        const y = bot - (bot - surf) * dy;
        if (y > surf + 8) { g.beginPath(); g.arc(cx + dx, y, r, 0, Math.PI * 2); g.fillStyle = E.bubble; g.fill(); }
      }
      g.restore();
      // the surface seen from above: a little lighter than the resource, lit along its far rim
      const sg = g.createLinearGradient(0, surf - ry, 0, surf + ry);
      sg.addColorStop(0, E.lit); sg.addColorStop(1, E.mid);
      g.beginPath(); g.ellipse(cx, surf, rx - 1, ry - 1, 0, 0, Math.PI * 2);
      g.globalAlpha = 0.8; g.fillStyle = sg; g.fill();
      g.globalAlpha = 0.7; g.strokeStyle = E.deep; g.lineWidth = 1.5; g.stroke();
      g.globalAlpha = 1;
      // the glass' own reflections, over the resource
      column();
      g.ellipse(cx, surf, rx, ry, 0, 0, Math.PI * 2);
      g.clip();
      g.globalCompositeOperation = 'screen';
      g.globalAlpha = 0.35;
      g.drawImage(base, 0, 0);
      g.restore();
      // the gold bands in front of the resource, from the painted tank
      g.save();
      g.beginPath();
      for (const c of GLASS.bands) {
        g.moveTo(cx + rx + 4, c + GLASS.band);
        g.ellipse(cx, c + GLASS.band, rx + 4, ry + 2, 0, 0, Math.PI);
        g.ellipse(cx, c - GLASS.band, rx + 4, ry + 2, 0, Math.PI, 0, true);
        g.closePath();
      }
      g.clip();
      g.drawImage(base, 0, 0);
      g.restore();
    }
    if (tenths === null) {
      g.save();
      g.scale(2, 2);
      withContext(g, () => outlinedText('?', cx / 2, (bot - 30) / 2, 30, '#ffffff', 5));
      g.restore();
    }
  });
}

/**
 * How hot a terminal's forge burns: `hot` while a command runs, `warm` while the shell waits at its
 * prompt (embers), `cold` once the shell has ended.
 */
export type Heat = 'hot' | 'warm' | 'cold';

/**
 * The forge's frame on the collector's plinth (art px): X runs to the lower right, Y to the lower
 * left, Z up; the hearth spans 0..110 on both, `HZ` high, with the chimney on its back half.
 */
const FORGE = { ox: 204, oy: 212, hz: 68, chimney: { x0: 6, x1: 58, z0: 70, z1: 178, taper: 8 } };
/** The forge is drawn at this size about the middle of its hearth's foot (art px), so it stands no taller than the house. */
const FORGE_SCALE = { k: 0.85, px: 204, py: 267 };
const forgeIso = (x: number, y: number, z = 0) => ({ x: FORGE.ox + (x - y), y: FORGE.oy + (x + y) / 2 - z });
/** A point of the forge's frame in world px from the footprint's front corner (the art is drawn at 2x). */
const forgeAt = (x: number, y: number, z: number) => {
  const p = forgeIso(x, y, z), { k, px, py } = FORGE_SCALE;
  return { x: (px + (p.x - px) * k - C_AX) / 2, y: (py + (p.y - py) * k - C_AY) / 2 };
};
/** Where the forge's smoke and sparks start, and its light at night, in world px from its anchor. */
export const FORGE_FX = {
  flue: forgeAt(32, 32, FORGE.chimney.z1 + 12),
  bed: forgeAt(83, 83, FORGE.hz + 14),
  mouth: forgeAt(57, 110, 22),
};

/**
 * A terminal's forge in the painted style, on the collector's cobbled plinth (whose tank the hearth
 * and chimney hide): a stone hearth with a coal bed and an arched fire mouth, a brick chimney, an
 * anvil on a stump and a quench bucket. `hot` roars (flames, glowing mouth, a bar on the anvil),
 * `warm` smoulders, `cold` is ash. The chimney's smoke and sparks are particles (see `FORGE_FX`).
 */
export function paintedForge(heat: Heat): Art | null {
  const base = get('structures/collector-base.png');
  if (!base) return null;
  const hot = heat === 'hot', warm = heat === 'warm';
  return canvasArt(C_W, C_H, C_AX, C_AY, (g) => {
    g.drawImage(base, 0, 0);
    g.clearRect(250, 140, 70, 92); // the tank's crank, which would show past the chimney (only air around it)
    g.translate(FORGE_SCALE.px, FORGE_SCALE.py); g.scale(FORGE_SCALE.k, FORGE_SCALE.k); g.translate(-FORGE_SCALE.px, -FORGE_SCALE.py);
    type P = { x: number; y: number };
    const OUTL = '#2a1d14';
    const at = forgeIso;
    const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const poly = (pts: P[], fill: string | CanvasGradient, lw = 3) => {
      g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) g.lineTo(q.x, q.y); g.closePath();
      g.fillStyle = fill; g.fill();
      if (lw) { g.strokeStyle = OUTL; g.lineWidth = lw; g.lineJoin = 'round'; g.stroke(); }
    };
    const seg = (a: P, b: P) => { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); };
    const glow = (c: P, r: number, inner: string, outer: string, k = 1) => {
      const gr = g.createRadialGradient(c.x, c.y, 2, c.x, c.y, r);
      gr.addColorStop(0, inner); gr.addColorStop(1, outer);
      g.fillStyle = gr; g.beginPath(); g.ellipse(c.x, c.y, r, r * k, 0, 0, Math.PI * 2); g.fill();
    };
    /** An iso box's two near faces and (optionally) its top. */
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
      top: string | null, left: string | CanvasGradient, right: string | CanvasGradient) => {
      poly([at(x0, y1, z0), at(x1, y1, z0), at(x1, y1, z1), at(x0, y1, z1)], left);
      poly([at(x1, y1, z0), at(x1, y0, z0), at(x1, y0, z1), at(x1, y1, z1)], right);
      if (top) poly([at(x0, y0, z1), at(x1, y0, z1), at(x1, y1, z1), at(x0, y1, z1)], top);
    };
    let seed = 11;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;

    // contact shadow on the cobbles
    g.fillStyle = 'rgba(20,12,6,.35)';
    g.beginPath(); g.ellipse(208, 314, 100, 44, 0, 0, Math.PI * 2); g.fill();

    // ---- the chimney, tapering up from the hearth's back half
    const { x0: c0, x1: c1, z0: cz0, z1: cz1, taper: tp } = FORGE.chimney;
    /** A point on the chimney's front-left (f 'L', u along x) or front-right face (f 'R', u along y) at height z. */
    const onChimney = (f: 'L' | 'R', u: number, z: number) => {
      const t = tp * (z - cz0) / (cz1 - cz0), lo = c0 + t, hi = c1 - t;
      return f === 'L' ? at(lo + (hi - lo) * u, hi, z) : at(hi, hi - (hi - lo) * u, z);
    };
    poly([onChimney('L', 0, cz0), onChimney('L', 1, cz0), onChimney('L', 1, cz1), onChimney('L', 0, cz1)], '#9a7a62');
    poly([onChimney('R', 0, cz0), onChimney('R', 1, cz0), onChimney('R', 1, cz1), onChimney('R', 0, cz1)], '#6e5444');
    g.strokeStyle = 'rgba(42,29,20,.45)'; g.lineWidth = 2;
    const rows = 8, rz = (cz1 - cz0) / rows;
    for (let r = 0; r < rows; r++) {
      for (const f of ['L', 'R'] as const) {
        if (r) seg(onChimney(f, 0.03, cz0 + r * rz), onChimney(f, 0.97, cz0 + r * rz));
        for (const u of r % 2 ? [0.3, 0.72] : [0.52]) seg(onChimney(f, u, cz0 + r * rz + 2), onChimney(f, u, cz0 + (r + 1) * rz - 2));
      }
    }
    // its cap, overhanging, and the flue's mouth (lit from below while hot)
    box(c0 + tp - 5, c1 - tp + 5, c0 + tp - 5, c1 - tp + 5, cz1, cz1 + 10, '#b39a84', '#8c7360', '#634c3e');
    const flue = [at(c0 + tp + 2, c0 + tp + 2, cz1 + 10), at(c1 - tp - 2, c0 + tp + 2, cz1 + 10),
      at(c1 - tp - 2, c1 - tp - 2, cz1 + 10), at(c0 + tp + 2, c1 - tp - 2, cz1 + 10)];
    poly(flue, hot ? '#5a2410' : '#1e1510', 2);
    if (hot) glow(mid(flue[0], flue[2]), 26, 'rgba(255,170,60,.55)', 'rgba(255,120,40,0)');

    // ---- the hearth: a stone block, coursed, with a coal bed on top
    const H = 110, hz = FORGE.hz;
    const sl = g.createLinearGradient(at(0, H).x, 0, at(H, H).x, 0);
    sl.addColorStop(0, '#bdb4a6'); sl.addColorStop(1, '#a0978a');
    const sr = g.createLinearGradient(at(H, H).x, 0, at(H, 0).x, 0);
    sr.addColorStop(0, '#857c70'); sr.addColorStop(1, '#6a6259');
    box(0, H, 0, H, 0, hz, null, sl, sr);
    for (const [f, color] of [['L', 'rgba(42,29,20,.4)'], ['R', 'rgba(30,20,14,.45)']] as const) {
      const p = (u: number, z: number) => (f === 'L' ? at(u, H, z) : at(H, u, z));
      g.strokeStyle = color; g.lineWidth = 2; g.lineCap = 'round';
      const courses = 4, ch = hz / courses;
      for (let r = 1; r < courses; r++) seg(p(2, r * ch), p(H - 2, r * ch));
      for (let r = 0; r < courses; r++)
        for (let u = (r % 2 ? 10 : 18) + rnd() * 6; u < H - 8; u += 20 + rnd() * 14) seg(p(u, r * ch + 2), p(u, (r + 1) * ch - 2));
    }
    // the top around the chimney's foot, then the foot itself over it, so it stands on the hearth
    poly([at(0, c1 + 2, hz), at(c1 + 2, c1 + 2, hz), at(c1 + 2, 0, hz), at(H, 0, hz), at(H, H, hz), at(0, H, hz)], '#c6bcac');
    const foot = cz0 + 12;
    poly([at(c0, c1, hz), at(c1, c1, hz), at(c1, c1, foot), at(c0, c1, foot)], '#9a7a62', 0);
    poly([at(c1, c1, hz), at(c1, c0, hz), at(c1, c0, foot), at(c1, c1, foot)], '#6e5444', 0);
    g.strokeStyle = OUTL; g.lineWidth = 3; g.lineJoin = 'round';
    g.beginPath();
    for (const q of [at(c0, c1, foot), at(c0, c1, hz), at(c1, c1, hz), at(c1, c0, hz), at(c1, c0, foot)]) g.lineTo(q.x, q.y);
    g.stroke();
    seg(at(c1, c1, hz), at(c1, c1, foot));
    // the coal bed, sunk into the front of the top
    const bed = [at(66, 66, hz), at(100, 66, hz), at(100, 100, hz), at(66, 100, hz)];
    poly(bed, OUTL, 2.5);
    for (let i = 0; i < 26; i++) {
      const q = at(70 + rnd() * 26, 70 + rnd() * 26, hz), r = 3 + rnd() * 3, k = rnd();
      g.fillStyle = hot ? (k < 0.5 ? '#ffd27a' : '#ff8a2a') : warm ? (k < 0.4 ? '#e0502a' : '#5a2a1c') : (k < 0.5 ? '#4a4440' : '#2e2a28');
      g.beginPath(); g.ellipse(q.x, q.y, r, r * 0.6, 0, 0, Math.PI * 2); g.fill();
    }
    const bc = mid(bed[0], bed[2]);
    if (hot) glow(bc, 60, 'rgba(255,190,80,.75)', 'rgba(255,120,40,0)');
    else if (warm) glow(bc, 34, 'rgba(255,90,40,.4)', 'rgba(255,120,40,0)');
    if (hot) {
      const flame = (dx: number, h: number, w: number, col: string) => {
        g.fillStyle = col; g.beginPath();
        g.moveTo(bc.x + dx - w, bc.y + 2);
        g.quadraticCurveTo(bc.x + dx - w * 0.9, bc.y - h * 0.5, bc.x + dx + w * 0.2, bc.y - h);
        g.quadraticCurveTo(bc.x + dx + w * 0.4, bc.y - h * 0.45, bc.x + dx + w, bc.y + 2);
        g.closePath(); g.fill();
      };
      g.save(); g.shadowColor = 'rgba(255,150,40,.9)'; g.shadowBlur = 14;
      flame(-14, 34, 11, '#ff7a1c'); flame(12, 40, 12, '#ff7a1c'); flame(-1, 54, 15, '#ff8f24');
      g.restore();
      flame(-12, 22, 7, '#ffc444'); flame(11, 27, 7, '#ffc444'); flame(0, 38, 9, '#ffd25a'); flame(0, 20, 5, '#fff3c0');
    }
    // the top's front lip, chiselled
    g.strokeStyle = 'rgba(255,248,232,.55)'; g.lineWidth = 2;
    g.beginPath(); for (const q of [at(3, H, hz - 3), at(H - 2, H, hz - 3), at(H, 3, hz - 3)]) g.lineTo(q.x, q.y); g.stroke();

    // ---- the fire mouth: an arch in the hearth's front-left face
    {
      const face = (u: number, z: number) => at(u, H, z);
      const a0 = 34, a1 = 80, z0 = 8, zs = 34, zr = 50; // jambs up to zs, the crown at zr
      const arch = (grow: number, i: number, n: number) => {
        const ang = Math.PI * i / n;
        return face((a0 + a1) / 2 - Math.cos(ang) * ((a1 - a0) / 2 + grow), zs + Math.sin(ang) * (zr - zs + grow));
      };
      g.beginPath();
      for (const q of [face(a0, z0), face(a0, zs)]) g.lineTo(q.x, q.y);
      for (let i = 1; i <= 16; i++) { const q = arch(0, i, 16); g.lineTo(q.x, q.y); }
      const q2 = face(a1, z0); g.lineTo(q2.x, q2.y); g.closePath();
      const m = face((a0 + a1) / 2, (z0 + zs) / 2);
      if (hot || warm) {
        const gr = g.createRadialGradient(m.x, m.y + (hot ? 6 : 10), 2, m.x, m.y, hot ? 40 : 36);
        if (hot) { gr.addColorStop(0, '#fff1b0'); gr.addColorStop(0.35, '#ffb236'); gr.addColorStop(0.8, '#d9481a'); gr.addColorStop(1, '#5a1a0c'); }
        else { gr.addColorStop(0, '#9a3a1c'); gr.addColorStop(0.45, '#4e1c10'); gr.addColorStop(1, '#1e120e'); }
        g.fillStyle = gr;
      } else g.fillStyle = '#1b1512';
      g.fill(); g.strokeStyle = OUTL; g.lineWidth = 3; g.stroke();
      // the voussoirs around it
      g.strokeStyle = 'rgba(42,29,20,.55)'; g.lineWidth = 2;
      for (let i = 1; i < 8; i++) seg(arch(0, i, 8), arch(8, i, 8));
      g.beginPath(); for (let i = 0; i <= 16; i++) { const q = arch(8, i, 16); g.lineTo(q.x, q.y); } g.stroke();
      for (let i = 0; i < 9; i++) {
        const q = face(a0 + 6 + rnd() * (a1 - a0 - 12), z0 + 2 + rnd() * 4), r = 3 + rnd() * 2;
        g.fillStyle = hot ? (i % 2 ? '#fff0a0' : '#ff9a2e') : warm ? (i % 3 ? '#7a2c18' : '#ff6a30') : (i % 2 ? '#3a3330' : '#4d4641');
        g.beginPath(); g.ellipse(q.x, q.y, r, r * 0.6, 0, 0, Math.PI * 2); g.fill();
      }
      if (hot) {
        // its light spilling onto the cobbles
        const f = face((a0 + a1) / 2, 0);
        g.save(); g.globalCompositeOperation = 'lighter';
        glow({ x: f.x - 10, y: f.y + 22 }, 80, 'rgba(255,150,50,.45)', 'rgba(255,120,40,0)', 0.5);
        g.restore();
      }
    }

    // ---- the anvil on a stump, front right
    {
      const s = { x: 296, y: 330 }, rx = 22, ry = 11, h = 26;
      g.fillStyle = 'rgba(20,12,6,.35)'; g.beginPath(); g.ellipse(s.x + 4, s.y + 2, rx + 10, ry + 5, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(s.x - rx, s.y); g.lineTo(s.x - rx, s.y - h);
      g.ellipse(s.x, s.y - h, rx, ry, 0, Math.PI, 0, false); g.lineTo(s.x + rx, s.y); g.ellipse(s.x, s.y, rx, ry, 0, 0, Math.PI, false); g.closePath();
      const wood = g.createLinearGradient(s.x - rx, 0, s.x + rx, 0); wood.addColorStop(0, '#9a6a3e'); wood.addColorStop(1, '#5e3c22');
      g.fillStyle = wood; g.fill(); g.strokeStyle = OUTL; g.lineWidth = 3; g.stroke();
      g.strokeStyle = 'rgba(42,29,20,.5)'; g.lineWidth = 2;
      for (const dx of [-10, 3, 12]) seg({ x: s.x + dx, y: s.y - h + ry - 2 }, { x: s.x + dx + 1, y: s.y + ry - 4 });
      g.beginPath(); g.ellipse(s.x, s.y - h, rx, ry, 0, 0, Math.PI * 2); g.fillStyle = '#d2a670'; g.fill(); g.strokeStyle = OUTL; g.lineWidth = 3; g.stroke();
      g.strokeStyle = 'rgba(120,70,30,.6)'; g.lineWidth = 1.5; g.beginPath(); g.ellipse(s.x, s.y - h, rx * 0.55, ry * 0.55, 0, 0, Math.PI * 2); g.stroke();
      const x = s.x, y = s.y - h - 12; // the anvil's face
      const iron = (pts: [number, number][], fill: string) => poly(pts.map(([dx, dy]) => ({ x: x + dx, y: y + dy })), fill, 2.5);
      iron([[-12, 14], [12, 14], [7, 2], [-7, 2]], '#3b3f46'); // waist
      iron([[-30, 8], [-14, -2], [20, -2], [20, -12], [-14, -12], [-34, 1]], '#4b5059'); // body and horn
      iron([[-14, -12], [20, -12], [26, -16], [-6, -17], [-34, 1]], '#7d848f'); // top
      iron([[20, -2], [26, -6], [26, -16], [20, -12]], '#2e3238'); // heel
      g.strokeStyle = 'rgba(230,236,245,.6)'; g.lineWidth = 1.6;
      g.beginPath(); for (const [dx, dy] of [[-28, -1], [-8, -13], [20, -13]]) g.lineTo(x + dx, y + dy); g.stroke();
      // the hammer resting on it
      g.lineCap = 'round';
      g.strokeStyle = OUTL; g.lineWidth = 5; seg({ x: x + 2, y: y - 16 }, { x: x + 24, y: y - 30 });
      g.strokeStyle = '#a8763f'; g.lineWidth = 2.5; seg({ x: x + 2, y: y - 16 }, { x: x + 24, y: y - 30 });
      iron([[-6, -12], [6, -19], [10, -15], [-2, -8]], '#5a6069');
      if (hot) {
        // a bar fresh from the fire
        g.save(); g.shadowColor = 'rgba(255,140,40,.95)'; g.shadowBlur = 10;
        g.strokeStyle = '#ff9a2e'; g.lineWidth = 4; seg({ x: x - 22, y: y - 6 }, { x: x - 4, y: y - 15 });
        g.restore();
        g.strokeStyle = '#ffe9a0'; g.lineWidth = 1.5; seg({ x: x - 20, y: y - 7 }, { x: x - 6, y: y - 14 });
      }
      g.lineCap = 'butt';
    }

    // ---- the quench bucket, front left
    {
      const b = { x: 112, y: 318 }, rx = 15, ry = 7.5, h = 20;
      g.fillStyle = 'rgba(20,12,6,.3)'; g.beginPath(); g.ellipse(b.x + 3, b.y + 2, rx + 7, ry + 4, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(b.x - rx, b.y - h); g.lineTo(b.x - rx + 2, b.y);
      g.ellipse(b.x, b.y, rx - 2, ry - 1, 0, Math.PI, 0, true); g.lineTo(b.x + rx, b.y - h); g.closePath();
      const wood = g.createLinearGradient(b.x - rx, 0, b.x + rx, 0); wood.addColorStop(0, '#a87244'); wood.addColorStop(1, '#6a4426');
      g.fillStyle = wood; g.fill(); g.strokeStyle = OUTL; g.lineWidth = 2.5; g.stroke();
      g.strokeStyle = '#3b3f46'; g.lineWidth = 3;
      for (const z of [5, 14]) { g.beginPath(); g.ellipse(b.x, b.y - z, rx - 0.5, ry - 0.5, 0, 0, Math.PI, false); g.stroke(); }
      g.beginPath(); g.ellipse(b.x, b.y - h, rx, ry, 0, 0, Math.PI * 2); g.fillStyle = '#4b7fa8'; g.fill(); g.strokeStyle = OUTL; g.lineWidth = 2.5; g.stroke();
      g.fillStyle = 'rgba(220,240,255,.6)'; g.beginPath(); g.ellipse(b.x - 4, b.y - h - 1, 5, 2, 0, 0, Math.PI * 2); g.fill();
    }
  });
}

/** The board's screen on its sprite: top-left, top-right and bottom-left corners. */
const SCREEN = { tl: { x: 148, y: 165 }, tr: { x: 238, y: 209 }, bl: { x: 148, y: 244 } };

/**
 * App board, painted to match the kit (its own board-frame is flat vector art): a timber easel with a
 * back prop, a bevelled plank frame under a little shingle canopy, gold nails, and a browser window
 * whose screen shows `img` (the app's snapshot) or `label` as a card.
 */
export function paintedBoard(label: string, img: (CanvasImageSource & { width: number; height: number }) | undefined): Art | null {
  if (!ready) return null;
  const { tl, tr, bl } = SCREEN;
  const k = (tr.y - tl.y) / (tr.x - tl.x); // the face falls this much per px to the right
  const at = (x: number, y0: number) => ({ x, y: y0 + (x - tl.x) * k }); // a point on the face's slope
  return canvasArt(C_W, C_H, C_AX, C_AY, (g) => {
    // drawn a fifth larger than measured, about its foot, to fill the 2x2 like the other props
    g.translate(200, 316); g.scale(1.2, 1.2); g.translate(-200, -316);
    const OUTL = '#2a1d14';
    const quad = (x0: number, x1: number, y0: number, y1: number, fill: string | CanvasGradient, lw = 3) => {
      const a = at(x0, y0), b = at(x1, y0), c = at(x1, y1), d = at(x0, y1);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(c.x, c.y); g.lineTo(d.x, d.y); g.closePath();
      g.fillStyle = fill; g.fill();
      if (lw) { g.strokeStyle = OUTL; g.lineWidth = lw; g.lineJoin = 'round'; g.stroke(); }
    };
    // contact shadow, the prop behind, then the posts
    g.fillStyle = 'rgba(20,12,6,.3)';
    g.beginPath(); g.ellipse(204, 322, 78, 26, 0.45, 0, Math.PI * 2); g.fill();
    pole(g, { x: 236, y: 286 }, { x: 206, y: 196 });
    pole(g, at(142, 296), at(142, 128));
    pole(g, at(244, 296), at(244, 128));
    // the frame: its thickness on the right, then the face in planks
    const X0 = 134, X1 = 252, Y0 = 136, Y1 = 262;
    const tr0 = at(X1, Y0), br0 = at(X1, Y1);
    g.beginPath(); g.moveTo(tr0.x, tr0.y); g.lineTo(tr0.x + 9, tr0.y - 5); g.lineTo(br0.x + 9, br0.y - 5); g.lineTo(br0.x, br0.y); g.closePath();
    g.fillStyle = '#5a3518'; g.fill(); g.strokeStyle = OUTL; g.lineWidth = 3; g.stroke();
    const wood = g.createLinearGradient(0, at(X0, Y0).y, 0, at(X0, Y1).y + 60);
    wood.addColorStop(0, '#b07a45'); wood.addColorStop(0.5, '#93602f'); wood.addColorStop(1, '#6e4422');
    quad(X0, X1, Y0, Y1, wood);
    g.strokeStyle = 'rgba(42,29,20,.35)'; g.lineWidth = 1.5;
    for (const y of [170, 205, 240]) { const a = at(X0 + 3, y), b = at(X1 - 3, y); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
    g.strokeStyle = 'rgba(255,236,200,.45)'; g.lineWidth = 2; // bevel catching the light
    { const a = at(X0 + 3, Y0 + 3), b = at(X1 - 3, Y0 + 3); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
    // the canopy: a short shingled roof over the top edge, in the hall's red
    const r0 = at(X0 - 10, Y0 + 2), r1 = at(X1 + 12, Y0 + 2), r2 = { x: r1.x + 10, y: r1.y - 22 }, r3 = { x: r0.x + 10, y: r0.y - 22 };
    const roof = g.createLinearGradient(0, r3.y, 0, r0.y);
    roof.addColorStop(0, '#d9594a'); roof.addColorStop(1, '#a3352a');
    g.beginPath(); g.moveTo(r0.x, r0.y); g.lineTo(r1.x, r1.y); g.lineTo(r2.x, r2.y); g.lineTo(r3.x, r3.y); g.closePath();
    g.fillStyle = roof; g.fill(); g.strokeStyle = OUTL; g.lineWidth = 3; g.stroke();
    g.strokeStyle = 'rgba(60,16,10,.45)'; g.lineWidth = 1.4;
    for (let i = 1; i < 7; i++) { const t = i / 7; const a = mix(r0, r1, t), b = mix(r3, r2, t); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
    { const a = mix(r0, r3, 0.5), b = mix(r1, r2, 0.5); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
    // the window: title bar with its lights and address pill, then the screen
    quad(tl.x, tr.x, tl.y - 16, tl.y, '#efe7d8', 2.5);
    ([[156, '#ff5f57'], [164, '#febc2e'], [172, '#28c840']] as const).forEach(([x, c]) => {
      const q = at(x, tl.y - 8); g.fillStyle = c; g.beginPath(); g.arc(q.x, q.y, 2.6, 0, Math.PI * 2); g.fill();
    });
    quad(182, tr.x - 6, tl.y - 12, tl.y - 4, '#ffffff', 0);
    g.save();
    g.beginPath();
    g.moveTo(tl.x, tl.y); g.lineTo(tr.x, tr.y); g.lineTo(tr.x + bl.x - tl.x, tr.y + bl.y - tl.y); g.lineTo(bl.x, bl.y);
    g.closePath();
    g.fillStyle = img ? '#ffffff' : '#26303d'; g.fill();
    g.clip();
    if (img) {
      g.transform((tr.x - tl.x) / img.width, (tr.y - tl.y) / img.width, (bl.x - tl.x) / img.height, (bl.y - tl.y) / img.height, tl.x, tl.y);
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0);
    } else {
      // the card: the app's name lying on the screen
      const mx = (tl.x + tr.x) / 2, my = (tl.y + bl.y) / 2 + (tr.y - tl.y) / 2;
      g.translate(mx, my);
      g.transform(1, k, 0, 1, 0, 0);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#9fd3ff';
      g.font = '400 26px "Lilita One", sans-serif';
      g.fillText('\u2197', 0, -18);
      g.fillStyle = '#e9eef5';
      g.font = '400 18px "Lilita One", sans-serif';
      g.fillText(label.length > 10 ? `${label.slice(0, 9)}\u2026` : label, 0, 14);
    }
    g.restore();
    quad(tl.x, tr.x, tl.y, bl.y, 'rgba(0,0,0,0)', 2.5); // the outline again, over the picture's edge
    for (const [x, y] of [[X0 + 7, Y0 + 9], [X1 - 7, Y0 + 9], [X0 + 7, Y1 - 8], [X1 - 7, Y1 - 8]]) {
      const q = at(x, y);
      g.fillStyle = '#ffcf33'; g.strokeStyle = OUTL; g.lineWidth = 1.5;
      g.beginPath(); g.arc(q.x, q.y, 3.2, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  });
}
