import { describe, expect, it } from 'vitest';
import { HOUSE_COLORS, HOUSE_SWATCHES, classOf, gearOf, houseColors, stars, scaffoldHeight } from './look';

describe('look', () => {
  it('a chosen house colour wins; without one the id picks a stable automatic one', () => {
    const auto = houseColors({ id: 'w-123' });
    expect(HOUSE_COLORS).toContain(auto);
    expect(houseColors({ id: 'w-123', color: null })).toEqual(auto);
    expect(houseColors({ id: 'w-123', color: '#3fa34d' }).roof).toBe('#3fa34d');
    // an automatic colour chosen by hand keeps its own wall
    expect(houseColors({ id: 'x', color: HOUSE_COLORS[2].roof })).toEqual(HOUSE_COLORS[2]);
    // the automatic colours lead the swatches
    expect(HOUSE_SWATCHES.slice(0, HOUSE_COLORS.length).map((s) => s.roof)).toEqual(HOUSE_COLORS.map((c) => c.roof));
  });

  it('class_mapping', () => {
    expect(classOf('claude', 'haiku')).toBe(0);
    expect(classOf('claude', 'opus')).toBe(2);
    expect(classOf('claude', 'fable')).toBe(3); // Legend, above Opus
    expect(classOf('claude', null)).toBe(1);
    expect(classOf('opencode', 'anthropic/claude-opus-4')).toBe(1);
    expect(classOf('codex', 'anything')).toBe(1);
    expect(classOf('grok', 'grok-4.7')).toBe(1);
    expect(classOf('custom', null)).toBe(1);
  });

  it('gear_mapping', () => {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(efforts.map(gearOf)).toEqual([0, 1, 2, 3, 4]);
    expect(gearOf(null)).toBe(1);
    expect(([0, 1, 2, 3, 4] as const).map(stars)).toEqual([1, 2, 3, 4, 4]);
  });

  it('scaffold_never_full', () => {
    expect(scaffoldHeight(0)).toBe(0);
    expect(scaffoldHeight(1e6)).toBeLessThan(0.921);
    let prev = -1;
    for (let s = 0; s < 200; s++) {
      const v = scaffoldHeight(s);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

test('Antigravity model ids map to classes by family', () => {
  expect(classOf('antigravity', 'gemini-3.8-flash-medium')).toBe(0);
  expect(classOf('antigravity', 'claude-sonnet-5-5-high')).toBe(1);
  expect(classOf('antigravity', 'gemini-4-argon-high')).toBe(2);
  expect(classOf('antigravity', 'gemini-4-neon-xhigh')).toBe(2);
  expect(classOf('antigravity', 'claude-opus-5-5-high')).toBe(2);
  expect(classOf('antigravity', 'gpt-oss-120b-medium')).toBe(1);
});
