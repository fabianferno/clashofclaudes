import type { AgentKind } from '../../api/types';
import { iso } from '../iso';
import { PALETTE } from '../look';
import {
  OUT, bake, ctx, dot, faceQuad, flag, isoBox, lerp, line, poly, roof, shadow, shade, spire, up,
  type Art, type Box, type Pt, type RoofPts,
} from './draw';

const GOLD = '#ffcf33';

function stoneCourses(k: Box, from: number, to: number, step: number, col: string, lw: number): void {
  const g = ctx();
  g.strokeStyle = col; g.lineWidth = lw;
  for (let v = from; v < to; v += step) {
    const a = up(k.D, v), c = up(k.C, v), b = up(k.B, v);
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(c.x, c.y); g.lineTo(b.x, b.y); g.stroke();
  }
}

/** Walled stone foundation plus plastered body, door, windows and roof (mockup `houseBody`). */
function houseBody(
  gx: number, gy: number, w: number, d: number, h: number, wall: string, roofColor: string, rh: number,
  gold = false, lit = '#ffe08a',
): { k: Box; r: RoofPts; H: number } {
  const g = ctx();
  const base = 10;
  const f = isoBox(gx - 0.14, gy - 0.14, w + 0.28, d + 0.28, base, '#a9a196', '#bdb5a8', '#958d80');
  g.strokeStyle = 'rgba(29,19,11,.35)'; g.lineWidth = 1.2;
  for (let u = 0.12; u < 1; u += 0.16) {
    for (const [a, b] of [[f.D, f.C], [f.C, f.B]]) {
      const p = lerp(a, b, u);
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x, p.y - base); g.stroke();
    }
  }
  const H = h + base;
  const k = isoBox(gx, gy, w, d, H, null, wall, shade(wall, -0.22));
  const beam = gold ? GOLD : '#7a4a26';
  ([[k.D, k.C, 0.035], [k.D, k.C, 0.965], [k.C, k.B, 0.965]] as [Pt, Pt, number][]).forEach(([a, b, u]) =>
    faceQuad(a, b, H, u - 0.035, u + 0.035, base / H, 1, '#7a4a26', 1.5));
  for (const [p0, p1] of [[k.D, k.C], [k.C, k.B]]) {
    const v = H * 0.58;
    poly([up(p0, v), up(p1, v), up(p1, v + 5), up(p0, v + 5)], beam, OUT, 1.5);
  }
  faceQuad(k.D, k.C, H, 0.4, 0.6, base / H, 0.48, gold ? '#8a5a1a' : '#5a3518');
  ([[k.D, k.C, 0.12, 0.28], [k.D, k.C, 0.72, 0.88], [k.C, k.B, 0.2, 0.4], [k.C, k.B, 0.6, 0.8]] as [Pt, Pt, number, number][])
    .forEach(([a, b, u0, u1]) => faceQuad(a, b, H, u0, u1, 0.7, 0.9, lit));
  const r = roof(gx, gy, w, d, H, rh, roofColor, gold ? GOLD : undefined);
  return { k, r, H };
}

/** Town hall, 5x5 footprint. Anchor: the footprint's front corner, grid point (gx+5, gy+5), i.e. iso(gx+5, gy+5) in world px. */
export function drawHall(): Art {
  return bake(380, 340, 190, 290, () => {
    const n = 5;
    shadow(iso(n / 2, n / 2), 62, 34, 0.22, 10, 6);
    const { k, r, H } = houseBody(1.3, 1.3, 2.4, 2.4, 58, '#cfc6b4', '#c2372b', 44);
    for (const p of [r.r1, r.r2]) dot(p.x, p.y - 2, 5, GOLD, OUT, 2);
    flag(r.apex, GOLD, 40);
    const bp = lerp(k.D, k.C, 0.5);
    poly([up(bp, H * 0.95), { x: bp.x + 10, y: bp.y - H * 0.95 + 5 }, { x: bp.x + 10, y: bp.y - H * 0.58 + 5 },
      { x: bp.x, y: bp.y - H * 0.53 }, { x: bp.x - 10, y: bp.y - H * 0.58 - 5 }, { x: bp.x - 10, y: bp.y - H * 0.95 - 5 }],
    '#c2372b', OUT, 2);
  }, iso(5, 5));
}

/** Workspace house, 3x3 footprint. Anchor: the footprint's front corner, grid point (gx+3, gy+3).  Stages: 0 plain, 1 banner, 2 wing, 3 tower, 4 gold trim. */
export function drawHouse(stage: 0 | 1 | 2 | 3 | 4, roofColor: string, wall: string): Art {
  return bake(300, 330, 150, 300, () => {
    const gold = stage >= 4;
    shadow(iso(1.5, 1.5), 60, 30, 0.22, 10, 6);
    // Tower (back-left) and wing (left) sit behind/beside the main block, all inside the 3x3.
    if (stage >= 3) {
      const t = isoBox(0.1, 0.1, 0.9, 0.9, 74, null, shade(wall, -0.05), shade(wall, -0.27));
      faceQuad(t.D, t.C, 74, 0.35, 0.65, 0.55, 0.7, '#2b2018');
      faceQuad(t.C, t.B, 74, 0.35, 0.65, 0.55, 0.7, '#2b2018');
      const sp = spire(0.1, 0.1, 0.9, 0.9, 74, 34, gold ? GOLD : roofColor);
      line(sp.apex, up(sp.apex, 14), OUT, 3);
    }
    if (stage >= 2) houseBody(0.1, 1.3, 0.7, 1.5, 24, wall, roofColor, 14, gold);
    const main = houseBody(0.8, 0.8, 2.0, 2.0, 50, wall, roofColor, 36, gold);
    if (stage >= 1) flag(main.r.apex, gold ? GOLD : roofColor, 34);
  }, iso(3, 3));
}

type StructStage = 'foundation' | 'scaffold' | 'complete';

/** Agent structure. Anchor: the footprint's front corner, grid point (gx+2, gy+2). 2x2 footprint, body 1.6 tiles, h=28, roof 22. `height01` is built fraction. */
export function drawStructure(agent: AgentKind, stage: StructStage, height01: number): Art {
  const P = PALETTE[agent];
  const w = 1.6, h = 28, rh = 22, base = 8, gx = 0.2, gy = 0.2;
  return bake(220, 250, 110, 200, () => {
    const g = ctx();
    shadow(iso(1, 1), 52, 28, 0.2, 6, 4);
    isoBox(gx - 0.1, gy - 0.1, w + 0.2, w + 0.2, base, '#a9a196', '#bdb5a8', '#958d80');
    if (stage === 'complete') {
      const { r } = houseBody(gx, gy, w, w, h, P.wall, P.roof, rh);
      const cp = up(iso(gx + w * 0.75, gy + w * 0.25), h + base + rh * 0.4);
      poly([cp, { x: cp.x + 6, y: cp.y + 3 }, { x: cp.x + 6, y: cp.y - 9 }, { x: cp.x, y: cp.y - 12 }], '#8c857a', OUT, 1.5);
      // review ribbon
      const p = up(r.apex, 24);
      const gr = g.createRadialGradient(p.x, p.y, 2, p.x, p.y, 34);
      gr.addColorStop(0, 'rgba(255,230,120,.7)'); gr.addColorStop(1, 'rgba(255,230,120,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(p.x, p.y, 34, 0, Math.PI * 2); g.fill();
      poly([{ x: p.x - 9, y: p.y + 6 }, { x: p.x - 14, y: p.y + 22 }, { x: p.x - 7, y: p.y + 18 }, { x: p.x - 3, y: p.y + 24 }, { x: p.x - 1, y: p.y + 8 }], '#c2372b', OUT, 1.8);
      poly([{ x: p.x + 9, y: p.y + 6 }, { x: p.x + 14, y: p.y + 22 }, { x: p.x + 7, y: p.y + 18 }, { x: p.x + 3, y: p.y + 24 }, { x: p.x + 1, y: p.y + 8 }], '#c2372b', OUT, 1.8);
      dot(p.x, p.y, 13, GOLD, OUT, 2.5);
      dot(p.x, p.y, 9, 'rgba(0,0,0,0)', '#fff3b0', 1.5);
      // check mark drawn as a path (no font dependency)
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (const [col, lw] of [[OUT, 6], ['#fff', 3]] as [string, number][]) {
        g.strokeStyle = col; g.lineWidth = lw;
        g.beginPath(); g.moveTo(p.x - 5, p.y + 0.5); g.lineTo(p.x - 1.5, p.y + 4); g.lineTo(p.x + 5.5, p.y - 4); g.stroke();
      }
      g.lineCap = 'butt';
      return;
    }
    const prog = stage === 'foundation' ? 0 : Math.max(0, Math.min(1, height01));
    const H = h * prog;
    if (H > 0.5) {
      const k = isoBox(gx, gy, w, w, H + base, shade(P.wall, -0.06), P.wall, shade(P.wall, -0.22));
      stoneCourses(k, base + 8, H + base, 8, 'rgba(120,90,60,.35)', 1.1);
    }
    // blueprint ghost of the full size
    const HH = h + base, A = iso(gx, gy), B = iso(gx + w, gy), C = iso(gx + w, gy + w), D = iso(gx, gy + w);
    g.setLineDash([5, 5]); g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2;
    for (const p of [D, C, B]) { g.beginPath(); g.moveTo(p.x, p.y - H - base); g.lineTo(p.x, p.y - HH); g.stroke(); }
    poly([up(A, HH), up(B, HH), up(C, HH), up(D, HH)], null, 'rgba(255,255,255,.85)');
    g.setLineDash([]);
    if (stage === 'scaffold' && H > 0.5) {
      const o = 0.26;
      const S = [iso(gx - o, gy + w + o), iso(gx + w + o, gy + w + o), iso(gx + w + o, gy - o)];
      const beamAt = (p1: Pt, p2: Pt, bw: number, col: string) => { line(p1, p2, OUT, bw + 3, 'round'); line(p1, p2, col, bw, 'round'); };
      S.forEach((p) => beamAt(p, up(p, H + base + 14), 3, '#a0703c'));
      for (let v = 16; v < H + base + 8; v += 18) {
        beamAt(up(S[0], v), up(S[1], v), 3.5, '#d29a55');
        beamAt(up(S[1], v), up(S[2], v), 3.5, '#c48a48');
      }
    }
  }, iso(2, 2));
}
