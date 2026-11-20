import { describe, expect, it } from 'vitest';
import type { Compound } from '../api/types';
import { MAX_PARTICLES, Particles, lifecycleEvents, type Snap } from './effects';

const c = (x0: number, y0: number, w: number, h: number): Compound => ({ x0, y0, w, h, house: { x: x0 + 1, y: y0 + 1 } });

describe('Particles', () => {
  it('pool_caps_at_400', () => {
    const p = new Particles();
    p.dust({ x: 0, y: 0 }, 300, true);
    p.dust({ x: 0, y: 0 }, 300, false);
    expect(MAX_PARTICLES).toBe(400);
    expect(p.count).toBe(400);
    p.orbs({ x: 0, y: 0 }, { x: 50, y: -50 }, 20);
    expect(p.count).toBe(400);
  });

  it('particles_expire', () => {
    const p = new Particles();
    p.dust({ x: 0, y: 0 }, 10, true);
    p.smoke({ x: 0, y: 0 });
    p.orbs({ x: 0, y: 0 }, { x: 80, y: -40 }, 5);
    p.floatText({ x: 0, y: 0 }, '+100 XP', '#ffffff');
    expect(p.count).toBeGreaterThan(0);
    const maxLife = Math.max(...p.list.map((q) => q.max));
    p.update(maxLife / 2);
    expect(p.count).toBeGreaterThan(0);
    p.update(maxLife / 2 + 0.01);
    expect(p.count).toBe(0);
  });

  it('a forge_s sparks rise then fall back, and its chimney smoke fades in as it rises', () => {
    const p = new Particles();
    p.sparks({ x: 0, y: 0 }, 1);
    const s = p.list[0];
    const vy0 = s.vy;
    p.update(0.1);
    expect(s.y).toBeLessThan(0);
    expect(s.vy).toBeGreaterThan(vy0); // gravity pulls it back
    const q = new Particles();
    q.chimney({ x: 0, y: 0 });
    const c0 = q.list[0];
    q.update(0.02);
    const early = c0.alpha;
    q.update(0.3);
    expect(c0.alpha).toBeGreaterThan(early);
    expect(c0.alpha).toBeLessThanOrEqual(0.5);
    expect(c0.y).toBeLessThan(0);
    // at the cap, sparks give way like dust and smoke
    const full = new Particles();
    full.dust({ x: 0, y: 0 }, 400, false);
    full.sparks({ x: 0, y: 0 }, 5);
    expect(full.count).toBe(400);
    expect(full.list.filter((x) => x.kind === 'spark')).toHaveLength(5);
  });

  it('orbs arc to the target and float text rises 40 px over 1.4 s', () => {
    const p = new Particles();
    p.orbs({ x: 0, y: 0 }, { x: 100, y: 0 }, 1);
    const o = p.list[0];
    p.update(o.delay + o.max / 2 - o.delay);
    expect(o.y).toBeLessThan(0); // arcs above the straight line
    const t = new Particles();
    t.floatText({ x: 10, y: 20 }, 'x', '#fff');
    const f = t.list[0];
    expect(f.max).toBeCloseTo(1.4);
    t.update(1.39);
    expect(f.y).toBeCloseTo(-20, 0);
  });

  it('runs scheduled callbacks once and reports idle only when everything is done', () => {
    const p = new Particles();
    let n = 0;
    p.later(1.2, () => n++);
    expect(p.idle).toBe(false);
    p.update(1);
    expect(n).toBe(0);
    p.update(0.3);
    p.update(1);
    expect(n).toBe(1);
    expect(p.idle).toBe(true);
  });
});

describe('lifecycleEvents', () => {
  const snap = (structs: Array<[string, string]>, cs: Array<[string, Compound]>): Snap => ({ structs: new Map(structs), compounds: new Map(cs) });

  it('first snapshot raises nothing', () => {
    expect(lifecycleEvents(null, snap([['struct:s1', 'w1']], [['w1', c(2, 2, 6, 5)]]))).toEqual({ spawned: [], closed: [], expanded: [], relocated: [] });
  });

  it('spawn, close', () => {
    const a = snap([['struct:s1', 'w1']], [['w1', c(2, 2, 6, 5)]]);
    const b = snap([['struct:s2', 'w1']], [['w1', c(2, 2, 6, 5)]]);
    const e = lifecycleEvents(a, b);
    expect(e.spawned).toEqual([{ id: 'struct:s2', wsId: 'w1' }]);
    expect(e.closed).toEqual([{ id: 'struct:s1', wsId: 'w1' }]);
  });

  it('growth is expansion; origin change is relocation with the shift', () => {
    const a = snap([], [['w1', c(2, 2, 6, 5)]]);
    expect(lifecycleEvents(a, snap([], [['w1', c(2, 2, 7, 5)]])).expanded).toEqual(['w1']);
    const e = lifecycleEvents(a, snap([], [['w1', c(1, 2, 7, 5)]]));
    expect(e.expanded).toEqual(['w1']);
    expect(e.relocated).toEqual([{ wsId: 'w1', dx: -1, dy: 0 }]);
    expect(lifecycleEvents(a, snap([], [['w1', { ...c(2, 2, 6, 5), house: { x: 5, y: 5 } }]])).expanded).toEqual([]);
  });

  it('a workspace losing its compound or gaining its first is not an expansion', () => {
    const a = snap([], []);
    expect(lifecycleEvents(a, snap([], [['w1', c(2, 2, 6, 5)]])).expanded).toEqual([]);
  });
});
