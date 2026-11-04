import type { AgentKind } from '../../api/types';
import { PALETTE, type ClassTier, type Gear } from '../look';
import { OUT, bake, ctx, dot, line, roundRect, shade, shadow, type Art } from './draw';
import { paintedBuilder } from './sprites';

export type Pose = 'idle' | 'walk0' | 'walk1' | 'hammer0' | 'hammer1' | 'cheer' | 'sad';

const CLASS_SCALE = [1.05, 1.25, 1.45];
const HEAD: Record<Gear, string> = { 0: '#8a5a2b', 1: '#9aa3a8', 2: '#ffcf33', 3: '#8fb3c9', 4: '#fff1a0' };


function hammer(gear: Gear): void {
  const g = ctx();
  line({ x: 0, y: 2 }, { x: 0, y: -15 }, OUT, 4.5);
  line({ x: 0, y: 2 }, { x: 0, y: -15 }, '#a0703c', 2.5);
  if (gear === 4) {
    const gr = g.createRadialGradient(0, -16, 1, 0, -16, 14);
    gr.addColorStop(0, 'rgba(255,240,150,.9)'); gr.addColorStop(1, 'rgba(255,240,150,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, -16, 14, 0, Math.PI * 2); g.fill();
  }
  roundRect(-5 - gear * 0.4, -19, 10 + gear * 0.8, 6, 1.5);
  g.fillStyle = HEAD[gear]; g.fill(); g.lineWidth = 1.8; g.strokeStyle = OUT; g.stroke();
  if (gear === 3) {
    // rune line across the head
    g.strokeStyle = '#2b4a63'; g.lineWidth = 1.1;
    g.beginPath(); g.moveTo(-3, -17.5); g.lineTo(-1, -14.5); g.lineTo(1, -17.5); g.lineTo(3, -14.5); g.stroke();
  }
}

/** Mockup `drawFigure` at the feet origin; pose picks step, hammer swing or cheer arms. */
function figure(agent: AgentKind, cls: ClassTier, gear: Gear, pose: Pose, face: 1 | -1): void {
  const g = ctx();
  const T = PALETTE[agent];
  const S = CLASS_SCALE[cls];
  g.scale(S, S);
  const sad = pose === 'sad' ? 2 : 0;
  g.lineWidth = 1.8; g.strokeStyle = OUT;
  if (cls === 2) {
    g.beginPath(); g.moveTo(-6, -20 + sad); g.quadraticCurveTo(-12 * face, -8, -9 * face, 0); g.lineTo(4 * -face, -2); g.closePath();
    g.fillStyle = '#b8282a'; g.fill(); g.stroke();
  }
  const step = pose === 'walk0' ? 2 : pose === 'walk1' ? -2 : 0;
  roundRect(-5, -8 + step * 0.3, 4, 8, 1.5); g.fillStyle = '#4a3423'; g.fill(); g.stroke();
  roundRect(1, -8 - step * 0.3, 4, 8, 1.5); g.fill(); g.stroke();
  roundRect(-7, -21 + sad, 14, 15, 5); g.fillStyle = T.body; g.fill(); g.stroke();
  g.fillStyle = 'rgba(255,255,255,.25)'; roundRect(-5, -19 + sad, 4, 9, 2); g.fill();
  g.fillStyle = cls === 0 ? '#8a6a4a' : T.dark; g.fillRect(-6, -11 + sad, 12, 3);
  g.fillStyle = cls === 2 ? '#ffcf33' : '#c9b48a'; g.fillRect(-1.5, -11 + sad, 3, 3);
  dot(0, -27 + sad, 7, '#f5c99c', OUT, 1.8);
  dot(2.2 * face, -27 + sad, 1.3, OUT);
  g.fillStyle = cls === 2 ? '#e8e2d6' : '#7a4a26';
  g.beginPath(); g.arc(-1.5 * face, -23 + sad, cls === 2 ? 4.5 : 3.2, 0, Math.PI); g.fill();
  if (cls === 0) {
    g.beginPath(); g.arc(0, -30 + sad, 7, Math.PI, 0); g.closePath(); g.fillStyle = shade(T.body, 0.35); g.fill(); g.stroke();
    roundRect(face > 0 ? 2 : -9, -31 + sad, 7, 2.5, 1); g.fill(); g.stroke();
  } else {
    g.beginPath(); g.arc(0, -30 + sad, 7.6, Math.PI, 0); g.closePath(); g.fillStyle = cls === 2 ? '#ffcf33' : T.hat; g.fill(); g.stroke();
    roundRect(-9.5, -31 + sad, 19, 3, 1.5); g.fill(); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.5)'; g.beginPath(); g.arc(-2.5, -34 + sad, 2, 0, Math.PI * 2); g.fill();
    if (cls === 2) {
      g.beginPath(); g.moveTo(0, -37 + sad); g.quadraticCurveTo(-8 * face, -48 + sad, -12 * face, -40 + sad);
      g.quadraticCurveTo(-6 * face, -42 + sad, 0, -36 + sad); g.fillStyle = '#e8392a'; g.fill(); g.stroke();
    }
  }
  if (pose === 'hammer0' || pose === 'hammer1') {
    g.save();
    g.translate(-6, -17);
    g.rotate(pose === 'hammer0' ? -1.1 : 0.55);
    hammer(gear);
    g.restore();
  } else if (pose === 'cheer') {
    const a = { x: -6, y: -17 }, b = { x: -11, y: -28 }, c = { x: 6, y: -17 }, d = { x: 11, y: -28 };
    line(a, b, OUT, 3.5); line(c, d, OUT, 3.5);
    line(a, b, T.body, 2); line(c, d, T.body, 2);
  }
}

/** Builder art. Anchor: the feet, at the builder's world position iso(x, y). Idle builders carry no hammer. */
export function drawBuilder(agent: AgentKind, cls: ClassTier, gear: Gear, pose: Pose, face: 1 | -1): Art {
  const p = paintedBuilder(agent, cls, gear, pose, face);
  if (p) return p;
  const S = CLASS_SCALE[cls];
  return bake(110, 130, 55, 100, () => {
    shadow({ x: 0, y: 0 }, 8 * S, 4 * S, 0.25);
    ctx().save();
    figure(agent, cls, gear, pose, face);
    ctx().restore();
  });
}
