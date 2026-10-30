import { iso } from '../iso';
import { OUT, bake, chip, ctx, dot, flag, isoBox, line, outlinedText, roundRect, shadow, up, type Art } from './draw';

/** One tile of wall running along x or y. Anchor: the tile's front corner, grid point (tx+1, ty+1) for tile (tx, ty). */
export function drawWallSeg(dir: 'x' | 'y'): Art {
  return bake(110, 80, 55, 62, () => {
    const L = 0.96, T = 0.44, hh = 14;
    const [x, y, w, d] = dir === 'x' ? [0.5 - L / 2, 0.5 - T / 2, L, T] : [0.5 - T / 2, 0.5 - L / 2, T, L];
    const k = isoBox(x, y, w, d, hh, '#d9d2c4', '#bbb3a4', '#9b9385', 1.8);
    const g = ctx();
    g.strokeStyle = 'rgba(29,19,11,.3)'; g.lineWidth = 1;
    const m1 = up(k.D, hh / 2), m2 = up(k.C, hh / 2), m3 = up(k.B, hh / 2);
    g.beginPath(); g.moveTo(m1.x, m1.y); g.lineTo(m2.x, m2.y); g.lineTo(m3.x, m3.y); g.stroke();
  }, iso(1, 1));
}

/**
 * Gate on the wall tile facing the hall: two stone posts joined by a wooden lintel, open between.
 * n/s gates run along x, e/w along y. Anchor: the tile's front corner, grid point (tx+1, ty+1) for tile (tx, ty).
 */
export function drawGate(side: 'n' | 's' | 'e' | 'w'): Art {
  return bake(120, 110, 60, 92, () => {
    const alongX = side === 'n' || side === 's';
    const post = (a: number) => {
      const [x, y] = alongX ? [a - 0.18, 0.5 - 0.18] : [0.5 - 0.18, a - 0.18];
      isoBox(x, y, 0.36, 0.36, 26, '#cfc7b8', '#e1dacb', '#9b9385');
    };
    const pt = (a: number, h: number) => up(alongX ? iso(a, 0.5) : iso(0.5, a), h);
    post(0.14);
    // lintel (drawn between the posts, behind the near post)
    const l0 = pt(0.14, 22), l1 = pt(0.86, 22);
    line(l0, l1, OUT, 8, 'round');
    line(l0, l1, '#a0703c', 4.5, 'round');
    post(0.86);
    flag(pt(0.5, 22), '#ffcf33', 20);
  }, iso(1, 1));
}

/** Paint a tree with its trunk base at the current origin. */
export function paintTree(pine: boolean, s: number): void {
  const g = ctx();
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
export function drawTree(variant: 0 | 1 | 2 | 3): Art {
  const s = [1.05, 1.15, 1.35, 0.95][variant];
  return bake(100, 130, 50, 112, () => paintTree(variant === 1 || variant === 3, s));
}

/**
 * Count of a workspace's live plain terminals, shown on its house (spec 5.2). Anchor: the house
 * footprint's centre, grid point (hx+1.5, hy+1.5); the chip floats above the roof's right side.
 */
export function drawBadge(count: number): Art {
  return bake(160, 180, 50, 170, () => {
    chip(40, -150, `>_ ${count}`, '#2b2f3a', 20);
  });
}

/** Speech bubble over a builder's head: "!" (needs you) or "?!" (stuck). Anchor: the tail tip. */
export function drawBubble(kind: 'needs' | 'stuck'): Art {
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
  return bake(40, 40, 20, 20, () => {
    dot(0, 0, 11, 'rgba(120,120,120,.75)', 'rgba(60,60,60,.5)', 1.5);
    dot(-3, -3, 5, 'rgba(190,190,190,.6)');
  });
}
