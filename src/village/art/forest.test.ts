import { describe, expect, it } from 'vitest';
import {
  FOREST_FULL, FOREST_START, FOREST_TILE, PATCH_PX, forestField, forestMasks, forestTile, grassTile, patchTile, valueNoise, vignetteTexture,
} from './forest';
import { drawGround, groundBakeSize } from './entities';
import { groundOrigin, groundTrees } from './ground';
import { HALL, wallRect } from '../layout';
import type { Compound } from '../../api/types';

const comp: Compound = { x0: 6, y0: 6, w: 7, h: 7, house: { x: 6, y: 6 } };
const b = { x0: -30, y0: -30, w: 70, h: 70 };

describe('forest field', () => {
  const field = forestField(b, [comp], [], 5);

  it('is open at the hall and inside a compound, deep far from both and at the bake edge', () => {
    expect(field(HALL.x0 + 1, HALL.y0 + 1)).toBe(0);
    const r = wallRect(comp);
    expect(field(r.x0 + 2, r.y0 + 2)).toBe(0);
    expect(field(b.x0 + 0.5, b.y0 + 35)).toBe(1); // the bake's edge
    expect(field(-24, -24)).toBeGreaterThan(0.9); // far out in the corner
  });

  it('is open everywhere between the hall and the compounds, however far apart they sit', () => {
    const far: Compound = { x0: 24, y0: -20, w: 7, h: 7, house: { x: 24, y: -20 } };
    const f = forestField(b, [comp, far], [], 5);
    // a spot well inside the village's extent, many tiles from the hall and from both walls
    expect(f(18, 2)).toBe(0);
  });

  it('has a ragged edge: spots the same distance from the hall are not all equally deep', () => {
    const cx = HALL.x0 + HALL.w / 2, cy = HALL.y0 + HALL.h / 2;
    const d = HALL.w / 2 + (FOREST_START + FOREST_FULL) / 2;
    const ring = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2;
      return forestField(b, [], [], 5)(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
    });
    expect(Math.max(...ring) - Math.min(...ring)).toBeGreaterThan(0.25);
  });

  it('a clearing opens the forest around it', () => {
    const patch = { x0: -22, y0: 20, w: 2, h: 2 };
    expect(field(-21, 21)).toBeGreaterThan(0.5);
    expect(forestField(b, [comp], [patch], 5)(-21, 21)).toBe(0);
  });

  it('the trees follow it: none deep in the open, many in the forest', () => {
    const trees = groundTrees(b, [comp], 5, []);
    const deep = trees.filter((t) => field(t.x, t.y) > 0.9).length;
    const open = trees.filter((t) => field(t.x, t.y) === 0).length;
    expect(deep).toBeGreaterThan(open * 5);
  });

  it('value noise stays in range and repeats with its period', () => {
    for (let i = 0; i < 50; i++) {
      const v = valueNoise(i * 0.37, i * 0.71, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(valueNoise(1.3, 2.6, 7, 5)).toBeCloseTo(valueNoise(6.3, 7.6, 7, 5));
  });
});

describe('forest art', () => {
  it('the forest tile is the village trees packed on a 2x canvas, over a shaded floor', () => {
    const c = forestTile();
    expect(c.width).toBe(FOREST_TILE * 2);
    expect(c.height).toBe(FOREST_TILE * 2);
    expect(c.getContext('2d')!.__getDrawCalls().length).toBeGreaterThan(200);
  });

  it('the grass tile is drawn once and reused', () => {
    expect(grassTile()).toBe(grassTile());
  });

  it('the masks cover the bake at its aspect; patches and the vignette draw', () => {
    const o = groundOrigin(b), { w, h } = groundBakeSize(b);
    const m = forestMasks(forestField(b, [comp], [], 5), o, w, h);
    expect(m.grass.width).toBe(m.shade.width);
    expect(m.grass.height / m.grass.width).toBeCloseTo(h / w, 1);
    expect(patchTile(3).width).toBe(PATCH_PX);
    expect(vignetteTexture().width).toBe(256);
  });

  it('the ground bake keeps its grass where the field is open, then shades its trees', () => {
    const g = drawGround({ x0: -20, y0: -20, w: 50, h: 50 }, [comp], 5).getContext('2d')!;
    const ops = g.__getEvents()
      .filter((e) => e.type === 'globalCompositeOperation')
      .map((e) => String(e.props.value));
    expect(ops).toContain('destination-in');
    expect(ops).toContain('source-atop');
    expect(ops.indexOf('destination-in')).toBeLessThan(ops.indexOf('source-atop'));
  });
});
