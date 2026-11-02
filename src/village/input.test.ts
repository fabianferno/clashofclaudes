import { describe, expect, it } from 'vitest';
import type { Compound, SessionInfo, SessionState } from '../api/types';
import { iso } from './iso';
import { compoundAt, dragTarget, hitTest, selectionOf } from './input';
import { canPlace } from './layout';
import type { Entity } from './scene';

const e = (id: string, kind: Entity['kind'], x: number, y: number): Entity =>
  ({ id, kind, x, y, depth: x + y, texKey: '' });

describe('hitTest', () => {
  it('an_app_board_is_clickable', () => {
    const board = e('board:w1:3000', 'board', 10, 10);
    const p = iso(9, 9);
    expect(hitTest([board], p.x, p.y - 40)?.id).toBe('board:w1:3000');
    expect(selectionOf(board, [])).toBeNull(); // a board opens its app; it selects nothing
  });

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

describe('collector hits', () => {
  it('a collector is clickable like a structure', () => {
    const c = e('collector:claude', 'collector', 2, 2);
    expect(hitTest([c], 0, 20)?.id).toBe('collector:claude');
  });
});

describe('selectionOf', () => {
  const agent = (id: string, builderId: string, state: SessionState, startedAt = 0) =>
    ({ id, workspaceId: 'w', kind: { kind: 'agent', builderId }, state, startedAt }) as SessionInfo;
  const builder = e('builder:b1', 'builder', 0, 0);

  it('a busy builder on the map opens its live session; an idle one its panel', () => {
    expect(selectionOf(builder, [])).toEqual({ kind: 'builder', id: 'b1' });
    expect(selectionOf(builder, [agent('old', 'b1', { kind: 'ended', exitCode: 0 })])).toEqual({ kind: 'builder', id: 'b1' });
    const live = [agent('old', 'b1', { kind: 'ended', exitCode: 0 }, 5), agent('s1', 'b1', { kind: 'needsYou', reason: 'x' }, 1)];
    expect(selectionOf(builder, live)).toEqual({ kind: 'session', id: 's1' });
    expect(selectionOf(builder, [agent('s2', 'other', { kind: 'working' })])).toEqual({ kind: 'builder', id: 'b1' });
  });

  it('other entities', () => {
    expect(selectionOf(e('hall', 'hall', 0, 0), [])).toEqual({ kind: 'hall' });
    expect(selectionOf(e('house:w1', 'house', 0, 0), [])).toEqual({ kind: 'workspace', id: 'w1' });
    expect(selectionOf(e('struct:s9', 'structure', 0, 0), [])).toEqual({ kind: 'session', id: 's9' });
    expect(selectionOf(e('collector:codex', 'collector', 0, 0), [])).toEqual({ kind: 'quota', agent: 'codex' });
    expect(selectionOf(e('status:s9', 'status', 0, 0), [])).toBeNull();
    expect(selectionOf(null, [])).toBeNull();
  });
});
