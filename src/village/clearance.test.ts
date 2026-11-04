import { describe, expect, it } from 'vitest';
import { HALL } from './layout';
import { HALL_C, RING_MAX, RING_MIN } from './walkers';
import { indexTrees, keepClearOfTrees, treeOver, underTree } from './clearance';

const front = { x: HALL.x0 + HALL.w, y: HALL.y0 + HALL.h }; // the hall's front corner

describe('clearance', () => {
  const keep = keepClearOfTrees([{ x0: 8, y0: -6, w: 2, h: 2 }]);

  it('clears trees in front of or beside the hall and the collectors, not those far behind them', () => {
    expect(treeOver({ x: front.x + 1, y: front.y + 1, s: 1 }, keep)).toBe(true); // just in front of the hall
    expect(treeOver({ x: 10.5, y: -3.5, s: 1 }, keep)).toBe(true); // just in front of the collector
    expect(treeOver({ x: HALL.x0 - 6, y: HALL.y0 - 6, s: 1 }, keep)).toBe(false); // well behind the hall
    expect(treeOver({ x: 25, y: 25, s: 1 }, keep)).toBe(false); // out in the forest
  });

  it('keeps the idle builders\' ring free of canopies', () => {
    for (let a = 0; a < Math.PI * 2; a += 0.37) {
      const r = (RING_MIN + RING_MAX) / 2;
      const p = { x: HALL_C.x + Math.cos(a) * r, y: HALL_C.y + Math.sin(a) * r };
      // a tree a little in front of a ring point would cover a builder there
      expect(treeOver({ x: p.x + 1, y: p.y + 1, s: 1.2 }, keep)).toBe(true);
    }
  });

  it('a builder may not stand in a trunk or under a canopy in front, but may stand in front of a tree', () => {
    const trees = indexTrees([{ x: 20.5, y: 20.5, s: 1 }]);
    expect(underTree(trees, { x: 20.4, y: 20.4 })).toBe(true); // in the trunk
    expect(underTree(trees, { x: 19, y: 19 })).toBe(true); // behind it, under the canopy
    expect(underTree(trees, { x: 22, y: 22 })).toBe(false); // in front of it
    expect(underTree(trees, { x: 20.5 + 4, y: 20.5 - 4 })).toBe(false); // well to the side
    expect(underTree(trees, { x: 12, y: 12 })).toBe(false); // far behind: the canopy ends below its head
  });
});
