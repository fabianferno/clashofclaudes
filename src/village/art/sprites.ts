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
    'structures/collector.png', 'structures/forge-cold.png', 'structures/forge-warm.png', 'structures/forge-hot.png',
    'structures/portal.png', 'ui/bubble-needs.png', 'ui/bubble-stuck.png', 'ui/ribbon.png', 'ui/puff.png',
  ];
  for (const a of AGENTS) out.push(`structures/structure-complete-${a}.png`);
  for (const l of WALL_LINKS) out.push(`scenery/wall-${WALL_FILE[l] ?? l}.png`);
  out.push('scenery/gate-ns.png', 'scenery/gate-ew.png', 'scenery/dirt.png');
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

/**
 * The kit is painted in true isometric: its ground edges fall 0.58-0.64 px per px across (measured on
 * each family's plinth), where the grid, the paths and everything drawn here fall 0.5. `grounded`
 * presses a sprite down to the grid's angle about the middle of its `tiles`-wide footprint, so its
 * plinth lies along the tile edges; widths, and so where it stands, do not change unless `size`
 * scales the whole sprite too (the tent's cloth was painted 2.6 tiles wide for its 2x2 spot).
 */
const TENT_SIZE = 0.87;
const GROUND_SLOPE = { building: 0.58, tent: 0.644, wall: 0.56, gate: 0.6 };
/** Half a tile's height in art px (the art is 2x): a footprint's centre is this far above its front corner, per tile. */
const HALF_TILE = 32;

function grounded(art: Art | null, slope: number, tiles: number, size = 1): Art | null {
  if (!art) return null;
  const k = (0.5 / slope) * size, up = tiles * HALF_TILE;
  const w = Math.ceil(art.canvas.width * size), h = Math.ceil(art.canvas.height * k);
  return canvasArt(w, h, art.ax * size, (art.ay - up) * k + up, (g) => {
    g.imageSmoothingQuality = 'high';
    g.drawImage(art.canvas, 0, 0, art.canvas.width, art.canvas.height, 0, 0, art.canvas.width * size, art.canvas.height * k);
  });
}

// Anchors put the painted footprint's centre on the grid footprint's centre (measured).
export const paintedHall = () => grounded(whole('buildings/hall.png', 380, 600), GROUND_SLOPE.building, 5);
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
  return grounded(canvasArt(img.width, img.height, 300, 600, (g) => {
    const x = HOUSE_POLE[stage];
    // the pole carried on down behind the roof, from its own lowest pixels
    if (x != null) g.drawImage(img, x, POLE_END - 6, 5, 6, x, POLE_END - 1, 5, POLE_FOOT - POLE_END + 1);
    g.drawImage(img, 0, 0);
    if (mask) g.drawImage(tinted(mask, roof), 0, 0);
  }), GROUND_SLOPE.building, 3);
}
export const paintedBubble = (kind: 'needs' | 'stuck') => whole(`ui/bubble-${kind}.png`, 60, 112);
export const paintedPuff = () => whole('ui/puff.png', 40, 40);

export const paintedWall = (links: string) => grounded(whole(`scenery/wall-${WALL_FILE[links] ?? links}.png`, 110, 144), GROUND_SLOPE.wall, 1);
/** n/s gates run along x (the kit's `ns` gate), e/w along y. */
export const paintedGate = (side: 'n' | 's' | 'e' | 'w') => grounded(whole(`scenery/gate-${side === 'n' || side === 's' ? 'ns' : 'ew'}.png`, 120, 184), GROUND_SLOPE.gate, 1);

/** The dirt texture (seen from straight above, seamless) is laid over this many tiles a side. */
export const DIRT_SPAN = 4;

/**
 * Paint the trodden-earth texture over the unit square of `g` (tile space) for the tile at
 * (`i`, `j`) of the texture's `DIRT_SPAN` x `DIRT_SPAN` block, `o` past each edge so no seam shows.
 * Returns false when the sprites are not loaded.
 */
export function paintDirt(g: CanvasRenderingContext2D, i: number, j: number, o: number): boolean {
  const img = get('scenery/dirt.png');
  if (!img) return false;
  g.save();
  g.beginPath(); g.rect(-o, -o, 1 + o * 2, 1 + o * 2); g.clip();
  g.imageSmoothingQuality = 'high';
  // the block and its neighbours, so the overlap at the block's own edges is textured too
  for (const dy of [-DIRT_SPAN, 0, DIRT_SPAN]) for (const dx of [-DIRT_SPAN, 0, DIRT_SPAN]) {
    if (dx - i > 1 + o || dx - i + DIRT_SPAN < -o || dy - j > 1 + o || dy - j + DIRT_SPAN < -o) continue;
    g.drawImage(img, dx - i, dy - j, DIRT_SPAN, DIRT_SPAN);
  }
  g.restore();
  return true;
}

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
  return grounded(canvasArt(S_W, S_H, S_AX, S_AY, (g) => {
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
  }), GROUND_SLOPE.tent, 2, TENT_SIZE);
}

// The collector, the forge and the portal share one cobbled plinth, painted to the grid: its foot is
// the 2x2 footprint and an eighth more (like the tent's cloth), centred on it, edges along the tile edges
// (no `grounded` needed).
const C_W = 400, C_H = 440, C_AX = 200, C_AY = 372;
/**
 * The collector's tank: centre x, half width and its rims' ellipse half height; the resource's
 * bottom and its surface when full (ellipse centres). Measured on collector.png.
 */
const GLASS = { cx: 203, rx: 47, ry: 19.5, bot: 290, top: 216 };
let glassMask: HTMLCanvasElement | null = null;

/**
 * The tank's glass (white, by colour: smoky blue-grey, where the bands, rivets and lid are gold and
 * wood), so the resource shows through the glass alone and the bands stay in front of it.
 */
function glass(img: Pic): HTMLCanvasElement {
  if (glassMask) return glassMask;
  const c = document.createElement('canvas');
  c.width = C_W; c.height = C_H;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  const { cx, rx, ry, bot, top } = GLASS, x0 = cx - rx, y0 = top - ry, w = rx * 2, h = bot - top + ry * 2 + 2;
  const d = g.getImageData(x0, y0, w, h), px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    const on = px[i + 3] > 200 && px[i + 2] > px[i] - 10;
    px[i] = px[i + 1] = px[i + 2] = 255; px[i + 3] = on ? 255 : 0;
  }
  g.clearRect(0, 0, C_W, C_H);
  g.putImageData(d, x0, y0);
  return (glassMask = c);
}

/** Resource collector: the painted tank, filled `tenths` (0-10) with the agent's resource; null shows "?". */
export function paintedCollector(agent: keyof typeof RESOURCE, tenths: number | null): Art | null {
  const base = get('structures/collector.png');
  if (!base) return null;
  const E = RESOURCE[agent];
  const { cx, rx, ry, bot, top } = GLASS;
  return canvasArt(C_W, C_H, C_AX, C_AY, (g) => {
    g.drawImage(base, 0, 0);
    const level = tenths === null ? 0 : Math.max(0, Math.min(10, tenths)) / 10;
    if (level > 0) {
      const surf = bot - (bot - top) * level;
      // the resource on its own canvas, cut to the glass, then laid in the tank
      const fill = canvasArt(C_W, C_H, 0, 0, (f) => {
        // the column, to the surface
        f.beginPath(); f.ellipse(cx, bot, rx, ry, 0, 0, Math.PI); f.lineTo(cx - rx, surf); f.lineTo(cx + rx, surf); f.closePath();
        const gr = f.createLinearGradient(cx - rx, 0, cx + rx, 0);
        gr.addColorStop(0, E.deep); gr.addColorStop(0.35, E.mid); gr.addColorStop(0.7, E.mid); gr.addColorStop(1, E.deep);
        f.fillStyle = gr; f.fill();
        for (const [dx, dy, r] of [[-20, 0.35, 5], [12, 0.6, 4], [26, 0.25, 3.5], [-8, 0.8, 3]] as const) {
          const y = bot + ry * 0.6 - (bot - surf) * dy;
          if (y > surf + ry + 4) { f.beginPath(); f.arc(cx + dx, y, r, 0, Math.PI * 2); f.fillStyle = E.bubble; f.fill(); }
        }
        // the surface seen from above: a little lighter than the resource, lit along its far rim
        const sg = f.createLinearGradient(0, surf - ry, 0, surf + ry);
        sg.addColorStop(0, E.lit); sg.addColorStop(1, E.mid);
        f.beginPath(); f.ellipse(cx, surf, rx - 1, ry - 1, 0, 0, Math.PI * 2);
        f.fillStyle = sg; f.fill();
        f.globalAlpha = 0.7; f.strokeStyle = E.deep; f.lineWidth = 1.5; f.stroke();
        f.globalAlpha = 1;
        f.globalCompositeOperation = 'destination-in';
        f.drawImage(glass(base), 0, 0);
      }).canvas;
      g.globalAlpha = 0.88;
      g.drawImage(fill, 0, 0);
      g.globalAlpha = 1;
      // the glass' own reflections, over the resource
      const shine = canvasArt(C_W, C_H, 0, 0, (f) => {
        f.drawImage(base, 0, 0);
        f.globalCompositeOperation = 'destination-in';
        f.drawImage(fill, 0, 0);
      }).canvas;
      g.save();
      g.globalCompositeOperation = 'screen';
      g.globalAlpha = 0.45;
      g.drawImage(shine, 0, 0);
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

/** A point of the forge's sprite (art px) in world px from the footprint's front corner (the art is drawn at 2x). */
const forgeAt = (x: number, y: number) => ({ x: (x - C_AX) / 2, y: (y - C_AY) / 2 });
/** Where the forge's smoke and sparks start, and its light at night, in world px from its anchor (measured on forge-*.png). */
export const FORGE_FX = {
  flue: forgeAt(228, 162),
  bed: forgeAt(198, 222),
  mouth: forgeAt(156, 268),
};

/**
 * A terminal's forge: a stone hearth with a coal bed and an arched fire mouth, a brick chimney, an
 * anvil on a stump and a quench bucket, on the cobbled plinth. One painting per heat, alike but for
 * the fire: `hot` roars (flames, a glowing mouth, a bar on the anvil), `warm` smoulders, `cold` is
 * ash. The chimney's smoke and sparks are particles (see `FORGE_FX`).
 */
export const paintedForge = (heat: Heat) => whole(`structures/forge-${heat}.png`, C_AX, C_AY);

/** The portal's dark pane on its sprite: top-left, top-right and bottom-left corners (the sill and pillars stand in front of its edges). */
const SCREEN = { tl: { x: 151, y: 168 }, tr: { x: 251, y: 218 }, bl: { x: 151, y: 257 } };
/** The pane's own colour on the sprite, and how far a pixel may stray from it and still be pane. */
const PANE = { r: 38, g: 48, b: 61, tol: 20 };
let paneMask: HTMLCanvasElement | null = null;

/** The pane's pixels (white, by colour) within the screen's box, so what is drawn on it stays behind the frame. */
function pane(img: Pic): HTMLCanvasElement {
  if (paneMask) return paneMask;
  const c = document.createElement('canvas');
  c.width = C_W; c.height = C_H;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  const { tl, tr, bl } = SCREEN, x0 = tl.x - 2, y0 = tl.y - 2, w = tr.x - tl.x + 4, h = tr.y - tl.y + bl.y - tl.y + 4;
  const d = g.getImageData(x0, y0, w, h), px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    // fully pane within the tolerance, fading out over the next 14 (the frame's soft inner edge)
    const off = Math.max(Math.abs(px[i] - PANE.r), Math.abs(px[i + 1] - PANE.g), Math.abs(px[i + 2] - PANE.b));
    const a = px[i + 3] > 200 ? Math.max(0, Math.min(1, 1 - (off - PANE.tol) / 14)) : 0;
    px[i] = px[i + 1] = px[i + 2] = 255; px[i + 3] = Math.round(a * 255);
  }
  g.clearRect(0, 0, C_W, C_H);
  g.putImageData(d, x0, y0);
  return (paneMask = c);
}

/**
 * A running app's portal: a rune-carved stone gateway under a timber lintel, on the cobbled plinth.
 * Its pane shows `img` (the app's snapshot), or `label` as a card until one is taken.
 */
export function paintedBoard(label: string, img: (CanvasImageSource & { width: number; height: number }) | undefined): Art | null {
  const base = get('structures/portal.png');
  if (!base) return null;
  const { tl, tr, bl } = SCREEN;
  const k = (tr.y - tl.y) / (tr.x - tl.x); // the face falls this much per px to the right
  return canvasArt(C_W, C_H, C_AX, C_AY, (g) => {
    g.drawImage(base, 0, 0);
    // the picture on its own canvas, cut to the pane, then laid over the sprite
    const face = canvasArt(C_W, C_H, 0, 0, (f) => {
      f.save();
      if (img) {
        f.fillStyle = '#ffffff';
        f.fillRect(0, 0, C_W, C_H);
        f.transform((tr.x - tl.x) / img.width, (tr.y - tl.y) / img.width, (bl.x - tl.x) / img.height, (bl.y - tl.y) / img.height, tl.x, tl.y);
        f.imageSmoothingQuality = 'high';
        f.drawImage(img, 0, 0);
      } else {
        // the card: the app's name lying on the pane, in the runes' blue
        const mx = (tl.x + tr.x) / 2, my = (tl.y + bl.y) / 2 + (tr.y - tl.y) / 2;
        f.translate(mx, my);
        f.transform(1, k, 0, 1, 0, 0);
        f.textAlign = 'center'; f.textBaseline = 'middle';
        f.shadowColor = 'rgba(90,190,255,.9)'; f.shadowBlur = 8;
        f.fillStyle = '#9fd3ff';
        f.font = '400 24px "Lilita One", sans-serif';
        f.fillText('\u2197', 0, -14);
        f.fillStyle = '#e9f4ff';
        f.font = '400 15px "Lilita One", sans-serif';
        f.fillText(label.length > 9 ? `${label.slice(0, 8)}\u2026` : label, 0, 12);
      }
      f.restore();
      f.globalCompositeOperation = 'destination-in';
      f.drawImage(pane(base), 0, 0);
    }).canvas;
    g.drawImage(face, 0, 0);
    if (img) {
      // the pane's sheen over the picture, and a faint rune-blue cast, so it sits in the gateway
      const sheen = g.createLinearGradient(tl.x, tl.y, tr.x, bl.y + tr.y - tl.y);
      sheen.addColorStop(0, 'rgba(160,215,255,.22)'); sheen.addColorStop(0.5, 'rgba(160,215,255,0)'); sheen.addColorStop(1, 'rgba(20,30,60,.18)');
      const glaze = canvasArt(C_W, C_H, 0, 0, (f) => {
        f.fillStyle = sheen; f.fillRect(0, 0, C_W, C_H);
        f.globalCompositeOperation = 'destination-in';
        f.drawImage(pane(base), 0, 0);
      }).canvas;
      g.drawImage(glaze, 0, 0);
    }
  });
}
