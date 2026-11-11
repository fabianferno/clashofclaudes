import { describe, expect, it } from 'vitest';
import { FADE_IN, FADE_OUT, FOREST_TILE, forestTile, grassFade, grassTile, hazeTexture } from './forest';
import { drawGround, groundBakeSize } from './entities';
import { groundOrigin } from './ground';
import type { Compound } from '../../api/types';

describe('forest', () => {
  it('the forest tile is the village trees packed on a 2x canvas, over a shaded floor', () => {
    const c = forestTile();
    expect(c.width).toBe(FOREST_TILE * 2);
    expect(c.height).toBe(FOREST_TILE * 2);
    const calls = c.getContext('2d')!.__getDrawCalls();
    expect(calls.length).toBeGreaterThan(200);
  });

  it('the grass tile is drawn once and reused', () => {
    expect(grassTile()).toBe(grassTile());
  });

  it('the fade mask matches the bake and steps from the edge inward', () => {
    const b = { x0: -20, y0: -20, w: 50, h: 50 };
    const o = groundOrigin(b), { w, h } = groundBakeSize(b);
    const m = grassFade(b, o, w, h);
    expect(m.width).toBe(256);
    expect(m.height / m.width).toBeCloseTo(h / w, 1);
    expect(FADE_IN).toBeGreaterThan(FADE_OUT);
    const fills = m.getContext('2d')!.__getDrawCalls().filter((d: { type: string }) => d.type === 'fill');
    expect(fills.length).toBe(17);
    expect(hazeTexture().width).toBe(256);
  });

  it('the ground bake paints its own grass and keeps it only inside the faded diamond', () => {
    const comp: Compound = { x0: 6, y0: 6, w: 7, h: 7, house: { x: 6, y: 6 } };
    const g = drawGround({ x0: -20, y0: -20, w: 50, h: 50 }, [comp], 5).getContext('2d')!;
    const events = g.__getEvents().map((e: { type: string; props: { value?: unknown } }) => [e.type, e.props?.value]);
    const comp_ = events.findIndex(([t, v]) => t === 'globalCompositeOperation' && v === 'destination-in');
    const fill = events.findIndex(([t]) => t === 'fillRect');
    expect(fill).toBeGreaterThanOrEqual(0);
    expect(comp_).toBeGreaterThan(fill);
  });
});
