import type { AgentKind } from '../../api/types';
import { ELIXIR, HOUSE_COLORS, type ClassTier, type Gear } from '../look';
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
const AGENTS: AgentKind[] = ['claude', 'codex', 'antigravity', 'opencode', 'custom'];
const POSES = ['idle', 'walk0', 'walk1', 'hammer0', 'hammer1', 'cheer', 'sad'] as const;
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

export function paintedHouse(stage: number, roof: string): Art | null {
  const img = get(`buildings/house-stage-${stage}${houseTint(roof)}.png`);
  if (!img) return null;
  return canvasArt(img.width, img.height, 300, 600, (g) => {
    const x = HOUSE_POLE[stage];
    // the pole carried on down behind the roof, from its own lowest pixels
    if (x != null) g.drawImage(img, x, POLE_END - 6, 5, 6, x, POLE_END - 1, 5, POLE_FOOT - POLE_END + 1);
    g.drawImage(img, 0, 0);
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
/** The hammer head on each class's hammer0 and hammer1 frames (unflipped frame px); the strips all paint one iron hammer. */
const HAMMER_BOX: Record<ClassTier, [Box, Box]> = {
  0: [{ x: 70, y: 118, w: 24, h: 30 }, { x: 127, y: 127, w: 26, h: 28 }],
  1: [{ x: 63, y: 106, w: 28, h: 30 }, { x: 130, y: 114, w: 30, h: 34 }],
  2: [{ x: 58, y: 92, w: 30, h: 36 }, { x: 148, y: 98, w: 26, h: 44 }],
};

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

/** A builder pose from its class's strip, hammering with its gear's hammer; facing -1 mirrors it about the feet. */
export function paintedBuilder(agent: AgentKind, cls: ClassTier, gear: Gear, pose: (typeof POSES)[number], face: 1 | -1): Art | null {
  const img = get(`sheets/builder-${CLASSES[cls]}-${agent}.png`);
  if (!img) return null;
  const i = POSES.indexOf(pose);
  const art = canvasArt(B_W, B_H, B_AX, B_AY, (g) => {
    g.drawImage(img, i * B_W, 0, B_W, B_H, 0, 0, B_W, B_H);
    if (pose === 'hammer0' || pose === 'hammer1') gearHammer(g, HAMMER_BOX[cls][pose === 'hammer0' ? 0 : 1], gear);
  });
  if (face === 1) return art;
  return canvasArt(B_W, B_H, B_AX, B_AY, (g) => { g.translate(B_W, 0); g.scale(-1, 1); g.drawImage(art.canvas, 0, 0); });
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
 * (the glass shows below it), the elixir's bottom and its surface when full; and the gold bands'
 * centres, redrawn over the elixir. Measured on collector-base.png.
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

/** Elixir collector: the painted tank, filled `tenths` (0-10) with the agent's elixir; null shows "?". */
export function paintedCollector(agent: keyof typeof ELIXIR, tenths: number | null): Art | null {
  const base = get('structures/collector-base.png');
  if (!base) return null;
  const E = ELIXIR[agent];
  const { cx, rx, ry, bot, top } = GLASS;
  return canvasArt(C_W, C_H, C_AX, C_AY, (g) => {
    g.drawImage(base, 0, 0);
    const level = tenths === null ? 0 : Math.max(0, Math.min(10, tenths)) / 10;
    if (level > 0) {
      const surf = bot - (bot - top) * level;
      g.save();
      glassClip(g);
      // the column of elixir, to the surface
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
      // the surface seen from above: a little lighter than the elixir, lit along its far rim
      const sg = g.createLinearGradient(0, surf - ry, 0, surf + ry);
      sg.addColorStop(0, E.lit); sg.addColorStop(1, E.mid);
      g.beginPath(); g.ellipse(cx, surf, rx - 1, ry - 1, 0, 0, Math.PI * 2);
      g.globalAlpha = 0.8; g.fillStyle = sg; g.fill();
      g.globalAlpha = 0.7; g.strokeStyle = E.deep; g.lineWidth = 1.5; g.stroke();
      g.globalAlpha = 1;
      // the glass' own reflections, over the elixir
      column();
      g.ellipse(cx, surf, rx, ry, 0, 0, Math.PI * 2);
      g.clip();
      g.globalCompositeOperation = 'screen';
      g.globalAlpha = 0.35;
      g.drawImage(base, 0, 0);
      g.restore();
      // the gold bands in front of the elixir, from the painted tank
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
 * A terminal's rune stone in the painted style: a weathered standing stone with carved `>_` runes
 * (glowing green while a command runs) on the collector's cobbled plinth, whose tank it stands in
 * front of and hides. The kit's own rune stones are flat vector art, unlike the rest of it.
 */
export function paintedRuneStone(lit: boolean): Art | null {
  const base = get('structures/collector-base.png');
  if (!base) return null;
  return canvasArt(C_W, C_H, C_AX, C_AY, (g) => {
    g.drawImage(base, 0, 0);
    g.clearRect(250, 140, 70, 92); // the tank's crank, which would show past the stone (only air around it)
    type P = { x: number; y: number };
    const lerp = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const H = 190, TAPER = 0.12;
    const L = { x: 140, y: 290 }, F = { x: 210, y: 325 }, R = { x: 275, y: 292.5 };
    const C = lerp(L, R, 0.5);
    const top = (p: P): P => { const q = lerp(p, C, TAPER); return { x: q.x, y: q.y - H }; };
    const Lt = top(L), Ft = top(F), Rt = top(R), apex = { x: (Lt.x + Rt.x) / 2, y: (Lt.y + Rt.y) / 2 - 20 };
    const poly = (pts: P[], fill: string | CanvasGradient) => {
      g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) g.lineTo(q.x, q.y); g.closePath();
      g.fillStyle = fill; g.fill();
      g.strokeStyle = '#2a1d14'; g.lineWidth = 3; g.lineJoin = 'round'; g.stroke();
    };
    // contact shadow on the cobbles
    g.fillStyle = 'rgba(20,12,6,.35)';
    g.beginPath(); g.ellipse(F.x + 2, F.y - 18, 78, 30, 0, 0, Math.PI * 2); g.fill();
    const lg = g.createLinearGradient(L.x, Lt.y, F.x, F.y);
    lg.addColorStop(0, '#cbc5bb'); lg.addColorStop(0.55, '#a9a399'); lg.addColorStop(1, '#878177');
    const rg = g.createLinearGradient(F.x, Ft.y, R.x, R.y);
    rg.addColorStop(0, '#8a847b'); rg.addColorStop(1, '#5f5a54');
    poly([L, F, Ft, Lt], lg);
    poly([F, R, Rt, Ft], rg);
    poly([Lt, Ft, apex], '#d8d2c7');
    poly([Ft, Rt, apex], '#9e988e');
    // chisel highlight down the front edge and along the cap
    g.strokeStyle = 'rgba(255,248,232,.55)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(F.x - 3, F.y - 6); g.lineTo(Ft.x - 3, Ft.y + 4); g.lineTo(apex.x - 2, apex.y + 5); g.stroke();
    // a point on the left face: u from its left edge to the front edge, v from the foot up
    const at = (u: number, v: number): P => lerp(lerp(L, F, u), lerp(Lt, Ft, u), v);
    const side = (u: number, v: number): P => lerp(lerp(F, R, u), lerp(Ft, Rt, u), v);
    // weathering: speckle, a crack on the shaded face, moss at the foot
    let seed = 7;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 70; i++) {
      const q = i % 3 ? at(0.05 + rnd() * 0.9, 0.04 + rnd() * 0.92) : side(0.05 + rnd() * 0.9, 0.04 + rnd() * 0.92);
      g.fillStyle = rnd() < 0.5 ? 'rgba(40,30,22,.16)' : 'rgba(255,250,240,.18)';
      g.beginPath(); g.arc(q.x, q.y, 1 + rnd() * 2, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = 'rgba(42,29,20,.55)'; g.lineWidth = 2; g.lineCap = 'round';
    const crack = [side(0.4, 0.82), side(0.62, 0.7), side(0.48, 0.58), side(0.6, 0.5)];
    g.beginPath(); g.moveTo(crack[0].x, crack[0].y); for (const q of crack.slice(1)) g.lineTo(q.x, q.y); g.stroke();
    for (const [u, r, f] of [[0.1, 9, at], [0.32, 6, at], [0.86, 7, at], [0.25, 7, side], [0.7, 5, side]] as const) {
      const q = f(u, 0.03);
      g.fillStyle = '#5f9a3a'; g.strokeStyle = '#2a3d18'; g.lineWidth = 2;
      g.beginPath(); g.ellipse(q.x, q.y, r, r * 0.6, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = 'rgba(190,230,120,.6)'; g.beginPath(); g.arc(q.x - r * 0.3, q.y - r * 0.2, r * 0.3, 0, Math.PI * 2); g.fill();
    }
    // the runes: the prompt, then lines of output, carved (a dark groove over a pale lip) or glowing
    const runes: [P, P][] = [];
    const prompt = [at(0.18, 0.84), at(0.34, 0.78), at(0.18, 0.72)];
    runes.push([prompt[0], prompt[1]], [prompt[1], prompt[2]], [at(0.44, 0.71), at(0.7, 0.71)]);
    for (const [v, segs] of [[0.58, [[0.18, 0.5], [0.58, 0.8]]], [0.47, [[0.18, 0.36], [0.44, 0.82]]], [0.36, [[0.18, 0.64]]],
      [0.25, [[0.18, 0.3], [0.38, 0.58]]]] as [number, [number, number][]][])
      for (const [u0, u1] of segs) runes.push([at(u0, v), at(u1, v)]);
    const stroke = (color: string, lw: number, dy = 0) => {
      g.strokeStyle = color; g.lineWidth = lw; g.lineCap = 'round';
      g.beginPath();
      for (const [a, b] of runes) { g.moveTo(a.x, a.y + dy); g.lineTo(b.x, b.y + dy); }
      g.stroke();
    };
    if (lit) {
      const m = at(0.5, 0.55);
      const glow = g.createRadialGradient(m.x, m.y, 6, m.x, m.y, 110);
      glow.addColorStop(0, 'rgba(120,255,170,.45)'); glow.addColorStop(1, 'rgba(120,255,170,0)');
      g.fillStyle = glow; g.beginPath(); g.arc(m.x, m.y, 110, 0, Math.PI * 2); g.fill();
      stroke('#1f5c3a', 7);
      g.save(); g.shadowColor = 'rgba(90,255,160,.95)'; g.shadowBlur = 12;
      stroke('#7dffb3', 4); g.restore();
      stroke('#e6fff0', 1.5);
      for (const [u, v, r] of [[0.15, 1.1, 3.5], [0.85, 1.22, 3], [0.45, 1.34, 2.5], [1.05, 0.92, 2.6]] as const) {
        const q = at(u, v);
        g.fillStyle = 'rgba(120,255,170,.3)'; g.beginPath(); g.arc(q.x, q.y, r + 4, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#c8ffdc'; g.beginPath(); g.arc(q.x, q.y, r, 0, Math.PI * 2); g.fill();
      }
    } else {
      stroke('rgba(255,250,240,.45)', 5, 2);
      stroke('#4a443d', 4.5);
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
