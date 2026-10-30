import { describe, expect, it } from 'vitest';
import type { Compound } from '../api/types';
import { gateInside, gateOutside } from './layout';
import { PLAZA, SPEED, routeHome, routeToSite, standTile, step, type Walker } from './walkers';

const mk = (over: Partial<Walker> = {}): Walker =>
  ({ id: 'b', x: 0, y: 0, path: [], mode: 'idle', face: 1, wait: 0, ...over });
const lcg = (seed = 1) => () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const east: Compound = { x0: 9, y0: -3, w: 7, h: 7, house: { x: 9, y: -3 } };
const centre = (t: { x: number; y: number }) => ({ x: t.x + 0.5, y: t.y + 0.5 });

describe('walkers', () => {
  it('route_goes_through_gate', () => {
    const spot = { x: 12, y: 1 };
    const r = routeToSite({ x: 4, y: 0 }, east, spot);
    const o = r.findIndex((p) => p.x === centre(gateOutside(east)).x && p.y === centre(gateOutside(east)).y);
    const i = r.findIndex((p) => p.x === centre(gateInside(east)).x && p.y === centre(gateInside(east)).y);
    expect(o).toBeGreaterThanOrEqual(0);
    expect(i).toBeGreaterThan(o);
    expect(r[r.length - 1]).toEqual(standTile(spot));
    const h = routeHome({ x: 12, y: 1 }, east);
    const ho = h.findIndex((p) => p.x === centre(gateOutside(east)).x && p.y === centre(gateOutside(east)).y);
    const hi = h.findIndex((p) => p.x === centre(gateInside(east)).x && p.y === centre(gateInside(east)).y);
    expect(hi).toBeGreaterThanOrEqual(0);
    expect(ho).toBeGreaterThan(hi);
  });

  it('standTile_offset', () => {
    expect(standTile({ x: 3, y: 4 })).toEqual({ x: 5.45, y: 5.1 });
  });

  it('step_reaches_target_at_speed', () => {
    const dt = 0.05;
    let w = mk({ mode: 'toSite', path: [{ x: 10, y: 0 }] });
    let t = 0;
    while (w.path.length && t < 30) { w = step(w, dt, lcg()); t += dt; }
    expect(Math.abs(t - 10 / SPEED)).toBeLessThanOrEqual(dt + 1e-9);
    expect(w.mode).toBe('atSite');
    expect(w.x).toBeCloseTo(10, 5);
  });

  it('idle_stays_in_plaza', () => {
    const rnd = lcg(7);
    let w = mk({ x: 5, y: 0.5 });
    let moved = false;
    for (let i = 0; i < 1000; i++) {
      w = step(w, 0.1, rnd);
      if (Math.hypot(w.x - 5, w.y - 0.5) > 0.5) moved = true;
      expect(Math.hypot(w.x, w.y)).toBeLessThanOrEqual(PLAZA + 0.5);
    }
    expect(moved).toBe(true);
    expect(w.mode).toBe('idle');
  });

  it('face_follows_direction', () => {
    const a = step(mk({ face: -1, path: [{ x: 5, y: -5 }] }), 0.1, lcg());
    expect(a.face).toBe(1);
    const b = step(mk({ face: 1, path: [{ x: -5, y: 5 }] }), 0.1, lcg());
    expect(b.face).toBe(-1);
  });
});
