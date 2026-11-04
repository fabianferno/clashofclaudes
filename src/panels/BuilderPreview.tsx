import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { AgentKind } from '../api/types';
import { drawBuilder, hammerPose, type Pose } from '../village/art/entities';
import { loadSprites, onSprites, spritesReady } from '../village/art/sprites';
import { classOf, gearOf } from '../village/look';

const SIZE = 120;
const FRAME_MS = 40; // checks the stroke; draws only when its pose changes
const ZOOM = 1.2;

/** A 120x120 canvas of the builder hammering. Animates only while mounted. */
export default function BuilderPreview({ agent, model, effort }: { agent: AgentKind; model: string | null; effort: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const painted = useSyncExternalStore(onSprites, spritesReady);

  useEffect(() => { void loadSprites(); }, []);

  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(SIZE * dpr);
    canvas.height = Math.round(SIZE * dpr);
    const cls = classOf(agent, model);
    const gear = gearOf(effort);
    const frames = new Map<Pose, ReturnType<typeof drawBuilder>>();
    const start = performance.now();
    let shown: Pose | null = null;
    const draw = () => {
      const pose = hammerPose((performance.now() - start) / 1000);
      if (pose === shown) return;
      shown = pose;
      let a = frames.get(pose);
      if (!a) { a = drawBuilder(agent, cls, gear, pose, 1); frames.set(pose, a); }
      // baked art is 2x; its anchor (the feet) goes to the middle, near the bottom
      const k = dpr * 0.5 * ZOOM;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.setTransform(k, 0, 0, k, (SIZE / 2) * dpr - a.ax * k, (SIZE - 18) * dpr - a.ay * k);
      g.drawImage(a.canvas, 0, 0);
    };
    draw();
    const timer = setInterval(draw, FRAME_MS);
    return () => clearInterval(timer);
  }, [agent, model, effort, painted]);

  return <canvas ref={ref} className="builder-preview" width={SIZE} height={SIZE} style={{ width: SIZE, height: SIZE }} aria-label="Builder preview" />;
}
