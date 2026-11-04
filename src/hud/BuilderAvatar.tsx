import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { AgentKind } from '../api/types';
import { drawBuilder } from '../village/art/entities';
import { loadSprites, onSprites, spritesReady } from '../village/art/sprites';
import { classOf, gearOf } from '../village/look';

const SIZE = 46;
const TOP = 3; // css px above the hat
const SHOWN = 0.78; // of the figure's height: head to waist

/** Opaque bounds of a canvas (px), or null when it is blank or unreadable. */
function opaqueBox(c: HTMLCanvasElement): { x0: number; y0: number; x1: number; y1: number } | null {
  const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height)?.data;
  if (!d) return null;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (d[(y * c.width + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** The builder as it looks in the village (class, gear), head and shoulders filling the frame. */
export default function BuilderAvatar({ agent, model, effort, size = SIZE }: {
  agent: AgentKind; model: string | null; effort: string | null; size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const painted = useSyncExternalStore(onSprites, spritesReady);

  useEffect(() => { void loadSprites(); }, []);

  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const a = drawBuilder(agent, classOf(agent, model), gearOf(effort), 'idle', 1);
    const box = opaqueBox(a.canvas);
    if (!box) return;
    // scale the top of the figure to the frame's height, centred on the figure
    const top = (TOP * size) / SIZE;
    const k = ((size - top) * dpr) / ((box.y1 - box.y0) * SHOWN);
    const cx = (box.x0 + box.x1) / 2;
    g.setTransform(k, 0, 0, k, (size / 2) * dpr - cx * k, top * dpr - box.y0 * k);
    g.drawImage(a.canvas, 0, 0);
  }, [agent, model, effort, size, painted]);

  return <canvas ref={ref} className="hud-av-art" width={size} height={size} style={{ width: size, height: size }} aria-hidden="true" />;
}
