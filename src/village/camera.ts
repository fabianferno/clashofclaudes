import { iso } from './iso';
import { wallRect, type Rect } from './layout';
import type { Compound } from '../api/types';

/** screen = world * zoom + (x, y) */
export interface Cam { x: number; y: number; zoom: number }
export interface PxRect { l: number; t: number; r: number; b: number }

export const ZMIN = 0.25;
export const ZMAX = 2.6;
/** Width of the side panel that can cover the right of the window. */
export const PANEL_W = 420;
/** Exponential easing time constant, seconds. */
export const EASE_TAU = 0.25;
const FIT_MARGIN = 40;

const clampZoom = (z: number) => Math.min(ZMAX, Math.max(ZMIN, z));

export const worldToScreen = (c: Cam, wx: number, wy: number) => ({ x: wx * c.zoom + c.x, y: wy * c.zoom + c.y });
export const screenToWorld = (c: Cam, sx: number, sy: number) => ({ x: (sx - c.x) / c.zoom, y: (sy - c.y) / c.zoom });

/** Zoom by `factor` keeping the world point under screen (sx, sy) fixed; zoom is clamped. */
export function zoomAt(c: Cam, sx: number, sy: number, factor: number): Cam {
  const zoom = clampZoom(c.zoom * factor);
  const w = screenToWorld(c, sx, sy);
  return { zoom, x: sx - w.x * zoom, y: sy - w.y * zoom };
}

/**
 * The camera that shows pixel rect `r` as large as fits (up to `maxZoom`), centred in the part of
 * the window left of a `panelW`-wide panel.
 */
export function fitRect(r: PxRect, vw: number, vh: number, panelW: number, maxZoom = ZMAX): Cam {
  const aw = Math.max(1, vw - panelW);
  const zoom = Math.min(
    maxZoom,
    Math.max(ZMIN, Math.min((aw - 2 * FIT_MARGIN) / (r.r - r.l), (vh - 2 * FIT_MARGIN) / (r.b - r.t))),
  );
  return { zoom, x: aw / 2 - ((r.l + r.r) / 2) * zoom, y: vh / 2 - ((r.t + r.b) / 2) * zoom };
}

/** One step of exponential easing toward `target`. Never overshoots; snaps when imperceptibly close. */
export function ease(c: Cam, target: Cam, dt: number): Cam {
  const k = 1 - Math.exp(-Math.max(0, dt) / EASE_TAU);
  const near = Math.abs(target.x - c.x) < 0.1 && Math.abs(target.y - c.y) < 0.1 && Math.abs(target.zoom - c.zoom) < 1e-3;
  if (near) return { ...target };
  return { x: c.x + (target.x - c.x) * k, y: c.y + (target.y - c.y) * k, zoom: c.zoom + (target.zoom - c.zoom) * k };
}

/**
 * If world point (wx, wy) is outside the window area left of the panel (inset by `margin`), the
 * camera panned the least needed to bring it in; null when it is already visible.
 */
export function keepVisible(
  c: Cam, wx: number, wy: number, vw: number, vh: number, panelW: number, margin: number,
): Cam | null {
  const s = worldToScreen(c, wx, wy);
  const minX = margin, maxX = Math.max(margin, vw - panelW - margin);
  const minY = margin, maxY = Math.max(margin, vh - margin);
  const dx = s.x < minX ? minX - s.x : s.x > maxX ? maxX - s.x : 0;
  const dy = s.y < minY ? minY - s.y : s.y > maxY ? maxY - s.y : 0;
  if (dx === 0 && dy === 0) return null;
  return { ...c, x: c.x + dx, y: c.y + dy };
}

/** Pixel bounds of a tile rect, including room above for tall roofs and flags. */
export function pxRectOfTiles(r: Rect): PxRect {
  return {
    l: iso(r.x0, r.y0 + r.h).x,
    r: iso(r.x0 + r.w, r.y0).x,
    t: iso(r.x0, r.y0).y - 140,
    b: iso(r.x0 + r.w, r.y0 + r.h).y + 20,
  };
}

export const pxRectOfCompound = (c: Compound): PxRect => pxRectOfTiles(wallRect(c));
