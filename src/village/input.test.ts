import { describe, expect, it } from 'vitest';
import type { Compound } from '../api/types';
import { iso } from './iso';
import { compoundAt, dragTarget, hitTest } from './input';
import { canPlace } from './layout';
import type { Entity } from './scene';

const e = (id: string, kind: Entity['kind'], x: number, y: number): Entity =>
  ({ id, kind, x, y, depth: x + y, texKey: '' });

describe('hitTest', () => {
  it('hit_test_prefers_front_entity', () => {
    // two houses overlapping on screen; the one with the larger depth is in front
    const back = e('house:a', 'house', 10, 10);
    const front = e('house:b', 'house', 11, 11);
    const p = iso(10.5, 10.5);
    expect(hitTest([back, front], p.x, p.y - 20)?.id).toBe('house:b');
    expect(hitTest([front, back], p.x, p.y - 20)?.id).toBe('house:b');
  });

  it('builders_win_over_structures_behind_them', () => {
    const s = e('struct:s1', 'structure', 6, 6);
    const b = e('builder:b1', 'builder', 5, 5);
    const p = iso(5, 5);
    expect(hitTest([s, b], p.x, p.y - 20)?.id).toBe('builder:b1');
  });

  it('misses_open_ground_and_ignores_walls', () => {
    const w = e('wall:w:1:1', 'wall', 2, 2);
    const p = iso(1.5, 1.5);
    expect(hitTest([w], p.x, p.y)).toBeNull();
    expect(hitTest([e('hall', 'hall', 3, 3)], 5000, 5000)).toBeNull();
  });

  it('hits_the_hall_on_its_roof', () => {
    const hall = e('hall', 'hall', 3, 3);
    const p = iso(0.5, 0.5);
    expect(hitTest([hall], p.x, p.y - 60)?.id).toBe('hall');
  });
});

describe('compoundAt', () => {
  const c: Compound = { x0: 6, y0: 6, w: 8, h: 8, house: { x: 8, y: 8 } };
  const items = [{ id: 'w1', compound: c }, { id: 'w2', compound: null }];
  it('finds the compound containing a grid point', () => {
    expect(compoundAt(items, 10, 10)?.id).toBe('w1');
    expect(compoundAt(items, 40, 10)).toBeNull();
    expect(compoundAt(items, 0, 0)).toBeNull();
  });
});

describe('dragTarget', () => {
  it('drag_target_rounds', () => {
    // grabbed 0.3/0.6 into a structure at (4,5); pointer now at (7.4, 5.9) -> top-left (7.1, 5.3) -> (7, 5)
    expect(dragTarget({ x: 4, y: 5 }, { x: 0.3, y: 0.6 }, { x: 7.4, y: 5.9 })).toEqual({ x: 7, y: 5 });
    expect(dragTarget({ x: 4, y: 5 }, { x: 0, y: 0 }, { x: 7.5, y: 5.49 })).toEqual({ x: 8, y: 5 });
    expect(dragTarget({ x: 4, y: 5 }, { x: 1, y: 1 }, { x: 5, y: 6 })).toEqual({ x: 4, y: 5 });
  });
});

describe('house placement', () => {
  const c: Compound = { x0: 6, y0: 6, w: 8, h: 8, house: { x: 6, y: 6 } };
  // the house is checked against structures only: its own current tile must not block it
  const away = { ...c, house: { x: -1000, y: -1000 } };
  it('house_cannot_cover_structure', () => {
    const structs = [{ x: 10, y: 10 }];
    expect(canPlace(away, structs, { x: 9, y: 9 }, 3)).toBe(false); // overlaps the 2x2 at (10,10)
    expect(canPlace(away, structs, { x: 11, y: 11 }, 3)).toBe(false);
    expect(canPlace(away, structs, { x: 6, y: 6 }, 3)).toBe(true);
    expect(canPlace(away, structs, { x: 12, y: 6 }, 3)).toBe(false); // sticks out of the interior
  });
});
