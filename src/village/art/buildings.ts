import type { AgentKind } from '../../api/types';
import { iso } from '../iso';
import { PALETTE } from '../look';
import {
  OUT, bake, ctx, dot, faceQuad, flag, isoBox, lerp, line, outlinedText, poly, roof, shadow, shade, spire, up,
  type Art, type Box, type Pt, type RoofPts,
} from './draw';

const GOLD = '#ffcf33';

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
/**
 * A session's structure as a camp tent in the agent's colours: a ground cloth and pegs while it
 * starts, the tent being pitched (poles, canvas rising with the session's progress, a dashed ghost
 * of the full tent) while it works, and the pitched tent with its door, guy ropes, pennant and the
 * review ribbon once finished.
 */
export function drawStructure(agent: AgentKind, stage: StructStage, height01: number): Art {
  const P = PALETTE[agent];
  const gx = 0.2, gy = 0.2, w = 1.6, RH = 46; // footprint and ridge height (px)
  const canvasLit = shade(P.body, 0.18), canvasDark = shade(P.body, -0.12);
  return bake(220, 250, 110, 200, () => {
    const g = ctx();
    const at = (x: number, y: number, h = 0) => up(iso(x, y), h);
    // ridge along x, over the footprint's middle
    const ym = gy + w / 2;
    const R1 = at(gx, ym, RH), R2 = at(gx + w, ym, RH);
    const eS1 = at(gx, gy + w), eS2 = at(gx + w, gy + w); // south eave (front-left face)
    const eN1 = at(gx, gy), eN2 = at(gx + w, gy);
    const gE1 = eN2, gE2 = eS2; // east gable base (front-right face)
    shadow(iso(1, 1), 50, 26, 0.2, 6, 4);
    // ground cloth
    poly([at(gx - 0.08, gy - 0.08), at(gx + w + 0.08, gy - 0.08), at(gx + w + 0.08, gy + w + 0.08), at(gx - 0.08, gy + w + 0.08)],
      'rgba(120, 96, 60, 0.55)', 'rgba(29,19,11,.45)', 1.5);
    const peg = (x: number, y: number) => {
      const p = at(x, y);
      line(p, up(p, 6), OUT, 3.2, 'round');
      line(p, up(p, 6), '#d8b679', 1.6, 'round');
    };
    const pegs: [number, number][] = [[gx - 0.25, ym], [gx + w + 0.25, ym], [gx, gy - 0.12], [gx + w, gy + w + 0.12]];
    if (stage === 'foundation') {
      pegs.forEach(([x, y]) => peg(x, y));
      ghost();
      return;
    }
    const prog = stage === 'complete' ? 1 : Math.max(0, Math.min(1, height01));
    // back slope (north) shows only above the ridge line: draw it first
    poly([eN1, eN2, R2, R1], canvasDark, OUT, 2);
    if (stage === 'complete') {
      poly([eS1, eS2, R2, R1], canvasLit, OUT, 2.2);
      // seams down the front slope
      g.strokeStyle = 'rgba(29,19,11,.22)'; g.lineWidth = 1.2;
      for (const t of [0.33, 0.66]) {
        const a = lerp(R1, R2, t), b = lerp(eS1, eS2, t);
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      }
      poly([gE1, gE2, R2], canvasDark, OUT, 2.2);
      // open door on the east gable: a dark opening with the flap folded back
      const mid = lerp(gE1, gE2, 0.5), top = lerp(mid, R2, 0.62);
      const dl = lerp(gE1, gE2, 0.28), dr = lerp(gE1, gE2, 0.72);
      poly([dl, top, dr], '#2b2018', OUT, 1.5);
      poly([dr, top, lerp(dr, gE2, 0.7)], shade(P.body, 0.32), OUT, 1.5);
      // poles poking out of the ridge, guy ropes and the pennant
      line(R1, up(R1, 7), OUT, 3.5, 'round'); line(R2, up(R2, 9), OUT, 3.5, 'round');
      g.strokeStyle = 'rgba(29,19,11,.55)'; g.lineWidth = 1.2;
      for (const [r, x] of [[R1, gx - 0.25], [R2, gx + w + 0.25]] as [Pt, number][]) {
        const p = at(x, ym);
        g.beginPath(); g.moveTo(r.x, r.y); g.lineTo(p.x, p.y); g.stroke();
      }
      pegs.forEach(([x, y]) => peg(x, y));
      const fp = up(R2, 9);
      poly([fp, { x: fp.x + 13, y: fp.y + 4 }, { x: fp.x, y: fp.y + 8 }], P.hat, OUT, 1.5);
      ribbon(up(lerp(R1, R2, 0.5), 30));
      return;
    }
    // pitching: A-frame poles and the ridge pole, canvas rising from the eaves with progress
    const pole = (a: Pt, b: Pt) => { line(a, b, OUT, 5, 'round'); line(a, b, '#a0703c', 2.6, 'round'); };
    pole(eN1, R1); pole(eN2, R2);
    if (prog > 0.02) {
      poly([eS1, eS2, lerp(eS2, R2, prog), lerp(eS1, R1, prog)], canvasLit, OUT, 2);
      poly([gE1, gE2, lerp(gE2, R2, prog), lerp(gE1, R2, prog)], canvasDark, OUT, 2);
    }
    pole(eS1, R1); pole(eS2, R2); pole(R1, R2);
    pegs.forEach(([x, y]) => peg(x, y));
    ghost();

    /** Dashed outline of the pitched tent. */
    function ghost() {
      g.setLineDash([5, 5]); g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2;
      for (const path of [[eS1, R1, R2, eS2], [eN2, R2]] as Pt[][]) {
        g.beginPath(); g.moveTo(path[0].x, path[0].y);
        for (const p of path.slice(1)) g.lineTo(p.x, p.y);
        g.stroke();
      }
      g.setLineDash([]);
    }
  }, iso(2, 2));
}

/** The finished-structure review ribbon (gold medal with a check) centred at `p`. */
function ribbon(p: Pt): void {
  const g = ctx();
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
}

const ELIXIR = '#d23fd9', ELIXIR_LIT = '#f39af5', ELIXIR_DEEP = '#7d1d8f';

/**
 * Elixir collector, 2x2 footprint: a glass tank on a stone base, banded in gold, a pump on top and
 * the agent's pennant. `tenths` (0-10) is how full the tank is; null means no reading yet (an empty
 * tank with a "?"). Anchor: the footprint's front corner, grid point (gx+2, gy+2).
 */
export function drawCollector(agent: AgentKind, tenths: number | null): Art {
  const P = PALETTE[agent];
  return bake(200, 220, 100, 190, () => {
    const g = ctx();
    const c = iso(1, 1);
    shadow(c, 54, 27, 0.22, 4, 3);
    // stone base and a timber frame around the tank
    const base = 12;
    isoBox(0.22, 0.22, 1.56, 1.56, base, '#bdb5a8', '#a9a196', '#958d80');
    const rx = 27, ry = 13.5, bot = c.y - base, H = 58, top = bot - H;
    const post = (gx: number, gy: number) => {
      const p = up(iso(gx, gy), base);
      line(p, up(p, H + 6), OUT, 7, 'round');
      line(p, up(p, H + 6), '#9a6634', 4, 'round');
    };
    post(0.38, 0.38); // the back post stands behind the glass
    // glass back wall, then the elixir (body, then its surface), then the front glass
    g.save();
    g.beginPath();
    g.ellipse(c.x, bot, rx, ry, 0, 0, Math.PI);
    g.lineTo(c.x - rx, top);
    g.ellipse(c.x, top, rx, ry, 0, Math.PI, Math.PI * 2);
    g.lineTo(c.x + rx, bot);
    g.closePath();
    g.fillStyle = 'rgba(60, 44, 84, 0.78)'; g.fill();
    g.clip();
    const level = tenths === null ? 0 : Math.max(0, Math.min(10, tenths)) / 10;
    if (level > 0) {
      const surf = bot - (H - 4) * level;
      const gr = g.createLinearGradient(c.x - rx, 0, c.x + rx, 0);
      gr.addColorStop(0, ELIXIR_DEEP); gr.addColorStop(0.35, ELIXIR); gr.addColorStop(0.7, ELIXIR); gr.addColorStop(1, ELIXIR_DEEP);
      g.fillStyle = gr;
      g.fillRect(c.x - rx, surf, rx * 2, bot - surf + ry + 2);
      g.beginPath(); g.ellipse(c.x, surf, rx - 1, ry - 1, 0, 0, Math.PI * 2);
      g.fillStyle = ELIXIR_LIT; g.fill();
      g.strokeStyle = 'rgba(125, 29, 143, 0.6)'; g.lineWidth = 1.5; g.stroke();
      // a few bubbles rising through the elixir
      for (const [dx, dy, r] of [[-10, 0.35, 3], [6, 0.6, 2.2], [13, 0.25, 1.8], [-4, 0.8, 1.6]] as const)
        if (bot - (bot - surf) * dy > surf + 4) dot(c.x + dx, bot - (bot - surf) * dy, r, 'rgba(255, 214, 255, 0.75)');
    }
    // glass sheen
    g.fillStyle = 'rgba(255, 255, 255, 0.28)';
    g.fillRect(c.x - rx + 5, top, 6, H + ry);
    g.fillStyle = 'rgba(255, 255, 255, 0.14)';
    g.fillRect(c.x + rx - 11, top, 3, H + ry);
    g.restore();
    // outline and gold bands (front halves), then the rim
    g.strokeStyle = OUT; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(c.x - rx, top); g.lineTo(c.x - rx, bot); g.ellipse(c.x, bot, rx, ry, 0, Math.PI, 0, true); g.lineTo(c.x + rx, top); g.stroke();
    for (const y of [bot - 3, top + H * 0.5, top + 3]) {
      g.beginPath(); g.ellipse(c.x, y, rx + 1, ry + 0.5, 0, 0, Math.PI);
      g.strokeStyle = OUT; g.lineWidth = 6; g.stroke();
      g.strokeStyle = GOLD; g.lineWidth = 3; g.stroke();
    }
    g.beginPath(); g.ellipse(c.x, top, rx, ry, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(90, 70, 110, 0.55)'; g.fill(); g.strokeStyle = OUT; g.lineWidth = 2.5; g.stroke();
    // the cap: a gold-trimmed timber lid with the pump and its crank
    g.beginPath(); g.ellipse(c.x, top - 2, rx + 4, ry + 2, 0, 0, Math.PI * 2);
    g.fillStyle = '#8a5a2b'; g.fill(); g.strokeStyle = OUT; g.lineWidth = 2.5; g.stroke();
    poly([{ x: c.x - 9, y: top - 4 }, { x: c.x - 9, y: top - 20 }, { x: c.x + 9, y: top - 20 }, { x: c.x + 9, y: top - 4 }], '#6e4422', OUT, 2.2);
    g.beginPath(); g.ellipse(c.x, top - 20, 9, 4.5, 0, 0, Math.PI * 2);
    g.fillStyle = GOLD; g.fill(); g.strokeStyle = OUT; g.lineWidth = 2; g.stroke();
    line({ x: c.x + 9, y: top - 13 }, { x: c.x + 20, y: top - 22 }, OUT, 5, 'round');
    line({ x: c.x + 9, y: top - 13 }, { x: c.x + 20, y: top - 22 }, '#c9c3b8', 2.5, 'round');
    dot(c.x + 20, top - 22, 3.5, '#c2372b', OUT, 1.8);
    // front posts and the pennant in the agent's colour
    post(1.62, 1.62);
    post(1.62, 0.38);
    post(0.38, 1.62);
    flag(up(iso(0.38, 1.62), base + H + 6), P.body, 22);
    if (tenths === null) outlinedText('?', c.x, bot - H * 0.38, 30, '#ffffff', 5);
  }, iso(2, 2));
}

/**
 * A terminal's workshop, 2x2 footprint: a small timber shed with a slate roof, a chimney and a
 * window glowing with a prompt while the shell runs (dark once it has ended).
 * Anchor: the footprint's front corner, grid point (gx+2, gy+2).
 */
export function drawWorkshop(lit: boolean): Art {
  return bake(200, 220, 100, 190, () => {
    const g = ctx();
    shadow(iso(1, 1), 50, 25, 0.2, 5, 3);
    const gx = 0.3, w = 1.4, H = 40;
    isoBox(gx - 0.08, gx - 0.08, w + 0.16, w + 0.16, 7, '#b0a898', '#a19a8c', '#8d867a');
    const k = isoBox(gx, gx, w, w, H, null, '#9b6b40', '#7d5431');
    // plank seams
    g.strokeStyle = 'rgba(29,19,11,.28)'; g.lineWidth = 1.2;
    for (const [a, b] of [[k.D, k.C], [k.C, k.B]] as [Pt, Pt][]) {
      for (let v = 0.25; v < 1; v += 0.25) {
        const p = up(a, H * v), q = up(b, H * v);
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
      }
    }
    // the screen-window on the front-left face, the door on the front-right
    const glow = lit ? '#58e89a' : '#3a4048';
    faceQuad(k.D, k.C, H, 0.18, 0.82, 0.32, 0.86, '#2b2018', 2);
    faceQuad(k.D, k.C, H, 0.24, 0.76, 0.38, 0.8, glow, 0);
    if (lit) {
      const m = up(lerp(k.D, k.C, 0.5), H * 0.59);
      const gr = g.createRadialGradient(m.x, m.y, 2, m.x, m.y, 30);
      gr.addColorStop(0, 'rgba(120,255,170,.35)'); gr.addColorStop(1, 'rgba(120,255,170,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(m.x, m.y, 30, 0, Math.PI * 2); g.fill();
      g.save();
      g.translate(m.x, m.y);
      g.transform(1, -0.5, 0, 1, 0, 0); // lie on the face
      g.font = '400 12px "Lilita One", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#0d2b1a'; g.fillText('>_', 0, 0);
      g.restore();
    }
    faceQuad(k.C, k.B, H, 0.35, 0.65, 0, 0.72, '#5a3518', 2);
    dot(lerp(k.C, k.B, 0.6).x, lerp(k.C, k.B, 0.6).y - H * 0.36, 1.6, GOLD);
    // chimney behind the ridge, then the roof
    const ch = up(iso(gx + w * 0.75, gx + w * 0.3), H);
    poly([ch, { x: ch.x + 9, y: ch.y - 4 }, { x: ch.x + 9, y: ch.y - 34 }, { x: ch.x, y: ch.y - 30 }], '#8c8378', OUT, 2);
    poly([{ x: ch.x, y: ch.y - 30 }, { x: ch.x + 9, y: ch.y - 34 }, { x: ch.x + 15, y: ch.y - 31 }, { x: ch.x + 6, y: ch.y - 27 }], '#6d655b', OUT, 2);
    if (lit) for (const [dx, dy, r] of [[8, 42, 5], [12, 52, 4]] as const) dot(ch.x + dx, ch.y - dy, r, 'rgba(200,200,200,.6)');
    roof(gx, gx, w, w, H, 26, '#5b6472');
  }, iso(2, 2));
}
