import { iso } from '../iso';
import { RESOURCE } from '../look';
import { OUT, bake, ctx, dot, flag, line, outlinedText, poly, roundRect, shadow, up, type Art, type Pt } from './draw';
import { paintTreeAt, paintedBubble, paintedGate, paintedPuff, paintedTree, paintedWall } from './sprites';

const LOG = '#a0703c';
const LOG_LIT = '#c8935a';

/** One upright log from ground point `p`, `h` px tall with a sharpened top, `r` px half-width. */
function log(p: Pt, h: number, r: number): void {
  const top = up(p, h);
  line(p, top, OUT, r * 2 + 3);
  line(p, top, LOG, r * 2);
  line({ x: p.x - r * 0.45, y: p.y }, { x: top.x - r * 0.45, y: top.y }, LOG_LIT, Math.max(1.2, r * 0.6));
  poly([{ x: top.x - r - 0.5, y: top.y }, { x: top.x, y: top.y - r * 1.6 - 2 }, { x: top.x + r + 0.5, y: top.y }], LOG, OUT, 1.5);
}

/**
 * One tile of wooden palisade, joined to the neighbouring wall tiles in `links` (see `WallTile`),
 * with a thicker post where it turns, ends or branches.
 * Anchor: the tile's front corner, grid point (tx+1, ty+1) for tile (tx, ty).
 */
export function drawWallSeg(links: string): Art {
  const p = paintedWall(links);
  if (p) return p;
  return bake(110, 90, 55, 72, () => {
    // Half a run from the tile's centre toward each linked neighbour (n: y-1, e: x+1, s: y+1,
    // w: x-1). Back to front: the n and w halves sit behind the centre, e and s in front of it.
    const half = (d: string) => {
      const along = (t: number) => (d === 'n' || d === 's' ? iso(0.5, t) : iso(t, 0.5));
      const [t0, t1] = d === 'n' || d === 'w' ? [0.02, 0.5] : [0.5, 0.98];
      const rail = (h: number) => {
        const a = up(along(t0), h), b = up(along(t1), h);
        line(a, b, OUT, 5); line(a, b, '#8a5e30', 2.6);
      };
      rail(7);
      for (const t of [t0 + 0.11, t0 + 0.355]) log(along(t), 21 + ((Math.round(t * 8) * 7) % 3) * 1.5, 3.4);
      rail(16);
    };
    const straight = links === 'ew' || links === 'ns';
    for (const d of ['n', 'w']) if (links.includes(d)) half(d);
    if (!straight) log(iso(0.5, 0.5), 27, 4.2); // a corner, end or junction post
    for (const d of ['e', 's']) if (links.includes(d)) half(d);
  }, iso(1, 1));
}

/**
 * Gate on the wall tile facing the hall: two log posts joined by a wooden lintel, open between.
 * n/s gates run along x, e/w along y. Anchor: the tile's front corner, grid point (tx+1, ty+1) for tile (tx, ty).
 */
export function drawGate(side: 'n' | 's' | 'e' | 'w'): Art {
  const p = paintedGate(side);
  if (p) return p;
  return bake(120, 110, 60, 92, () => {
    const alongX = side === 'n' || side === 's';
    const base = (a: number) => (alongX ? iso(a, 0.5) : iso(0.5, a));
    const pt = (a: number, h: number) => up(base(a), h);
    log(base(0.14), 30, 4.5);
    // lintel (drawn between the posts, behind the near post)
    const l0 = pt(0.14, 25), l1 = pt(0.86, 25);
    line(l0, l1, OUT, 8, 'round');
    line(l0, l1, '#8a5e30', 4.5, 'round');
    log(base(0.86), 30, 4.5);
    flag(pt(0.5, 25), '#ffcf33', 20);
  }, iso(1, 1));
}

/** Painted trees are drawn this much smaller than their sprite, times the tree's scale. */
export const TREE_K = 0.8;
/** How far a tree's canopy reaches from its trunk base at scale TREE_K: each side and up (world px). */
export const TREE_REACH = { half: 42, up: 112 };

/** Paint a tree with its trunk base at the current origin. */
export function paintTree(pine: boolean, s: number): void {
  const g = ctx();
  // painted: pines are frames 1 (tall) and 3, oaks 0 and 2 (big)
  if (paintTreeAt(g, pine ? (s > 1.1 ? 1 : 3) : (s > 1.2 ? 2 : 0), s * TREE_K)) return;
  shadow({ x: 4, y: 2 }, 16 * s, 8 * s, 0.2);
  g.fillStyle = '#6b4423'; g.strokeStyle = OUT; g.lineWidth = 2;
  g.beginPath(); g.rect(-3 * s, -14 * s, 6 * s, 14 * s); g.fill(); g.stroke();
  if (pine) {
    ([[46, 13, '#2e7a2a'], [36, 17, '#348a2e'], [25, 20, '#3b9a33']] as [number, number, string][]).forEach(([dy, r, c]) => {
      g.fillStyle = c; g.strokeStyle = OUT; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, -(dy + 16) * s); g.lineTo(r * s, -(dy - 8) * s); g.lineTo(-r * s, -(dy - 8) * s); g.closePath();
      g.fill(); g.stroke();
    });
  } else {
    ([[0, 26, 17, '#3f9a30'], [-6, 34, 12, '#4caf3a'], [6, 36, 12, '#4caf3a'], [0, 42, 11, '#62c349']] as [number, number, number, string][])
      .forEach(([dx, dy, r, c], i) => {
        g.fillStyle = c; g.strokeStyle = OUT; g.lineWidth = i ? 0 : 2;
        g.beginPath(); g.arc(dx * s, -dy * s, r * s, 0, Math.PI * 2); g.fill(); if (!i) g.stroke();
      });
    g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.arc(-4 * s, -44 * s, 4 * s, 0, Math.PI * 2); g.fill();
  }
}

/** Tree on a 1x1 tile; anchor is the trunk base, at the tree's world position iso(x, y). Variants: 0 oak, 1 pine, 2 big oak, 3 small pine. */
/**
 * A builder's contact shadow, in the painted kit's shadow colour (a warm near-black, soft edged),
 * a little to the right as the kit's light falls from the left. Anchor: under the feet.
 */
export function drawBuilderShadow(): Art {
  return bake(44, 20, 20, 10, () => {
    const g = ctx();
    g.save();
    g.translate(2, 0);
    g.scale(1, 0.42);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, 17);
    gr.addColorStop(0, 'rgba(36, 20, 16, 0.62)');
    gr.addColorStop(0.55, 'rgba(36, 20, 16, 0.48)');
    gr.addColorStop(1, 'rgba(36, 20, 16, 0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(0, 0, 17, 0, Math.PI * 2); g.fill();
    g.restore();
  });
}

/** One of the ground's trees (see `paintTree`), stood up as a sprite. Anchor: the trunk base. */
export function drawGroundTree(pine: boolean, s: number): Art {
  return bake(120, 150, 60, 128, () => paintTree(pine, s));
}

export function drawTree(variant: 0 | 1 | 2 | 3): Art {
  const p = paintedTree(variant);
  if (p) return p;
  const s = [1.05, 1.15, 1.35, 0.95][variant];
  return bake(100, 130, 50, 112, () => paintTree(variant === 1 || variant === 3, s));
}

/** Speech bubble over a builder's head: "!" (needs you) or "?!" (stuck). Anchor: the tail tip. */
export function drawBubble(kind: 'needs' | 'stuck'): Art {
  const p = paintedBubble(kind);
  if (p) return p;
  return bake(60, 60, 30, 56, () => {
    const g = ctx();
    const col = kind === 'needs' ? '#ff4b3e' : '#8e8e8e';
    g.beginPath(); g.moveTo(-6, -14); g.lineTo(0, 0); g.lineTo(6, -14); g.closePath();
    g.fillStyle = col; g.fill(); g.strokeStyle = OUT; g.lineWidth = 2.5; g.lineJoin = 'round'; g.stroke();
    roundRect(-19, -46, 38, 34, 12);
    g.fillStyle = col; g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-5, -14); g.lineTo(5, -14); g.strokeStyle = col; g.lineWidth = 3; g.stroke();
    outlinedText(kind === 'needs' ? '!' : '?!', 0, -20, 26, '#fff', 4);
  });
}

/** Pulsing ring on the ground around a structure that needs you. Anchor: its centre. */
export function drawRing(): Art {
  return bake(180, 100, 90, 50, () => {
    const g = ctx();
    g.beginPath(); g.ellipse(0, 0, 76, 38, 0, 0, Math.PI * 2);
    g.strokeStyle = OUT; g.lineWidth = 9; g.stroke();
    g.strokeStyle = '#ff4b3e'; g.lineWidth = 5; g.stroke();
  });
}

/** One smoke puff for a stuck structure. Anchor: its centre. */
export function drawPuff(): Art {
  const p = paintedPuff();
  if (p) return p;
  return bake(40, 40, 20, 20, () => {
    dot(0, 0, 11, 'rgba(120,120,120,.75)', 'rgba(60,60,60,.5)', 1.5);
    dot(-3, -3, 5, 'rgba(190,190,190,.6)');
  });
}

const STATUS_FILL = {
  working: '#f5a623', needs: '#ff4b3e', stuck: '#8e8e8e', app: '#2fbf71', house: '#9a6634',
  'resource-claude': RESOURCE.claude.label, 'resource-codex': RESOURCE.codex.label, 'resource-antigravity': RESOURCE.antigravity.label,
} as const;

/**
 * The small bar over a structure at work (spec 5.3.2): elapsed time and steps, "Waiting for you" or
 * "Stuck". Static (no moving stripes: no per-frame drawing). Anchor: the bar's bottom centre.
 */
export function drawStatusBar(tone: keyof typeof STATUS_FILL, label: string): Art {
  const bw = Math.max(92, Math.ceil(label.length * 6.4) + 18);
  return bake(bw + 8, 24, bw / 2 + 4, 21, () => {
    const g = ctx();
    roundRect(-bw / 2, -18, bw, 16, 8);
    g.fillStyle = '#2b2018'; g.fill(); g.strokeStyle = OUT; g.lineWidth = 2.5; g.stroke();
    g.save();
    roundRect(-bw / 2 + 2, -16, bw - 4, 12, 6);
    g.clip();
    g.fillStyle = STATUS_FILL[tone]; g.fillRect(-bw / 2, -18, bw, 16);
    g.restore();
    outlinedText(label, 0, -5.5, 11, '#fff', 3);
  });
}

const PLATE_FONT = 15;

/** Width of `label` in the plate's font (an estimate where the canvas cannot measure, as in tests). */
function plateTextWidth(label: string): number {
  const g = document.createElement('canvas').getContext('2d');
  if (g) {
    g.font = `400 ${PLATE_FONT}px "Lilita One", sans-serif`;
    const w = g.measureText(label).width;
    if (w > 0) return w;
  }
  return label.length * PLATE_FONT * 0.56;
}

/**
 * The Town Hall's name plate ("Fabian's Town Hall"): a wooden board with gold trim on a red ribbon,
 * larger than a house's plate. Anchor: the board's bottom centre.
 */
export function drawHallPlate(label: string): Art {
  const bw = Math.max(120, Math.ceil(plateTextWidth(label)) + 34);
  const tail = 16, h = 26;
  return bake(bw + 2 * tail + 8, h + 12, bw / 2 + tail + 4, h + 6, () => {
    const g = ctx();
    // ribbon tails behind the board, notched at their ends
    for (const s of [-1, 1]) {
      const x0 = s * (bw / 2 - 6), x1 = s * (bw / 2 + tail);
      poly([{ x: x0, y: -h + 7 }, { x: x1, y: -h + 7 }, { x: x1 - s * 6, y: -h / 2 + 3 }, { x: x1, y: 1 }, { x: x0, y: 1 }], '#b8322a', OUT, 2.5);
    }
    roundRect(-bw / 2, -h - 2, bw, h, 9);
    const wood = g.createLinearGradient(0, -h - 2, 0, -2);
    wood.addColorStop(0, '#7a4e2b'); wood.addColorStop(1, '#4a2d17');
    g.fillStyle = wood; g.fill();
    g.strokeStyle = OUT; g.lineWidth = 3; g.stroke();
    roundRect(-bw / 2 + 3, -h + 1, bw - 6, h - 6, 6);
    g.strokeStyle = '#ffcf33'; g.lineWidth = 1.6; g.stroke();
    outlinedText(label, 0, -h / 2 + 3.5, PLATE_FONT, '#ffe9a8', 3.5);
  });
}
