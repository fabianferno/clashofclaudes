import { describe, expect, it } from 'vitest';
import { ZMAX, ZMIN, dragCam, ease, fitRect, keepVisible, screenToWorld, worldToScreen, zoomAt, type Cam } from './camera';

describe('camera', () => {
  it('zoom_at_keeps_point_fixed', () => {
    const c: Cam = { x: 100, y: 50, zoom: 1 };
    const before = screenToWorld(c, 300, 200);
    const z = zoomAt(c, 300, 200, 1.7);
    expect(z.zoom).toBeCloseTo(1.7);
    const s = worldToScreen(z, before.x, before.y);
    expect(s.x).toBeCloseTo(300, 6);
    expect(s.y).toBeCloseTo(200, 6);
  });

  it('zoom_clamps', () => {
    const c: Cam = { x: 0, y: 0, zoom: 1 };
    expect(zoomAt(c, 10, 10, 0.1).zoom).toBe(ZMIN);
    expect(zoomAt(c, 10, 10, 10).zoom).toBe(ZMAX);
    // clamped zoom still keeps the point fixed
    const z = zoomAt(c, 10, 10, 10);
    const w = screenToWorld(c, 10, 10);
    expect(worldToScreen(z, w.x, w.y).x).toBeCloseTo(10, 6);
  });

  it('world_screen_roundtrip', () => {
    const c: Cam = { x: -40, y: 12, zoom: 0.8 };
    const s = worldToScreen(c, 55, -20);
    const w = screenToWorld(c, s.x, s.y);
    expect(w.x).toBeCloseTo(55, 9);
    expect(w.y).toBeCloseTo(-20, 9);
  });

  it('fit_centres_left_of_panel', () => {
    const r = { l: -300, t: -200, r: 500, b: 400 };
    const c = fitRect(r, 1400, 900, 420);
    const mid = worldToScreen(c, (r.l + r.r) / 2, (r.t + r.b) / 2);
    expect(mid.x).toBeCloseTo((1400 - 420) / 2, 6);
    expect(mid.y).toBeCloseTo(450, 6);
    const tl = worldToScreen(c, r.l, r.t);
    const br = worldToScreen(c, r.r, r.b);
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(1400 - 420);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.y).toBeLessThanOrEqual(900);
  });

  it('ease_converges_without_overshoot', () => {
    const target: Cam = { x: -120, y: 80, zoom: 2 };
    let c: Cam = { x: 40, y: -30, zoom: 0.5 };
    let lastZ = c.zoom;
    for (let i = 0; i < 120; i++) {
      c = ease(c, target, 1 / 60);
      expect(c.zoom).toBeGreaterThanOrEqual(lastZ);
      expect(c.zoom).toBeLessThanOrEqual(target.zoom);
      lastZ = c.zoom;
    }
    expect(Math.abs(c.x - target.x)).toBeLessThan(1e-3);
    expect(Math.abs(c.y - target.y)).toBeLessThan(1e-3);
    expect(Math.abs(c.zoom - target.zoom)).toBeLessThan(1e-3);
  });

  it('ease_never_jumps_on_a_long_frame', () => {
    const c = ease({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 0, zoom: 1 }, 10);
    expect(c.x).toBeLessThanOrEqual(100);
    expect(c.x).toBeGreaterThan(99);
  });

  it('keep_visible_null_when_already_visible', () => {
    const c: Cam = { x: 0, y: 0, zoom: 1 };
    expect(keepVisible(c, 300, 300, 1400, 900, 420, 60)).toBeNull();
  });

  it('keep_visible_moves_point_out_from_under_the_panel', () => {
    const c: Cam = { x: 0, y: 0, zoom: 1 };
    const n = keepVisible(c, 1200, 300, 1400, 900, 420, 60)!;
    expect(n).not.toBeNull();
    expect(n.zoom).toBe(1);
    const s = worldToScreen(n, 1200, 300);
    expect(s.x).toBeLessThanOrEqual(1400 - 420 - 60 + 1e-9);
    expect(s.y).toBe(300);
  });

  it('drag_during_ease_continues_from_current_camera', () => {
    const target: Cam = { x: -500, y: 300, zoom: 2 };
    let cam: Cam = { x: 0, y: 0, zoom: 1 };
    for (let i = 0; i < 10; i++) cam = ease(cam, target, 1 / 60); // ease in flight
    // press cancels the ease: the drag base is the camera now, not the press-time pose or the target
    const base = { ...cam };
    const dragged = dragCam(base, 30, -20);
    expect(dragged.x).toBeCloseTo(cam.x + 30, 9);
    expect(dragged.y).toBeCloseTo(cam.y - 20, 9);
    expect(dragged.zoom).toBe(cam.zoom);
    // and with no ease running, nothing moves the base between frames
    expect(dragCam(dragged, 0, 0)).toEqual(dragged);
  });
});
