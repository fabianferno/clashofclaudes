import { describe, expect, it } from 'vitest';
import { DEAD_ZONE, MAX_TILT, settled, springStep, tiltFromVelocity } from './gameCursorMath';

describe('tiltFromVelocity', () => {
  it('is upright at rest and on small, slow moves', () => {
    expect(tiltFromVelocity(0, 0)).toBe(0);
    expect(tiltFromVelocity(DEAD_ZONE * 0.9, 0)).toBe(0);
    expect(tiltFromVelocity(-60, 40)).toBe(0);
  });
  it('leans into the direction of travel: right or up clockwise, left or down anticlockwise', () => {
    expect(tiltFromVelocity(800, 0)).toBeGreaterThan(0);
    expect(tiltFromVelocity(-800, 0)).toBeLessThan(0);
    expect(tiltFromVelocity(0, -800)).toBeGreaterThan(0);
    expect(tiltFromVelocity(0, 800)).toBeLessThan(0);
    expect(tiltFromVelocity(-800, 0)).toBeCloseTo(-tiltFromVelocity(800, 0));
  });
  it('does not tilt when moving along its own body', () => {
    const along = { x: Math.sin((32 * Math.PI) / 180) * 2000, y: Math.cos((32 * Math.PI) / 180) * 2000 };
    expect(Math.abs(tiltFromVelocity(along.x, along.y))).toBe(0);
  });
  it('never passes the cap, however fast, and grows smoothly with speed', () => {
    expect(tiltFromVelocity(1e6, 0)).toBeLessThanOrEqual(MAX_TILT);
    expect(tiltFromVelocity(-1e6, 0)).toBeGreaterThanOrEqual(-MAX_TILT);
    let prev = 0;
    for (let v = 0; v <= 5000; v += 100) {
      const a = tiltFromVelocity(v, 0);
      expect(a).toBeGreaterThanOrEqual(prev);
      expect(a - prev).toBeLessThan(1.5); // no jumps
      prev = a;
    }
  });
});

describe('springStep', () => {
  it('eases to the target and settles, with at most a faint overshoot', () => {
    let s = { angle: 0, vel: 0 };
    let max = 0;
    for (let i = 0; i < 60; i++) { s = springStep(s.angle, s.vel, 10, 1 / 60); max = Math.max(max, s.angle); }
    expect(s.angle).toBeCloseTo(10, 0);
    expect(max).toBeLessThan(10 * 1.05);
    // back to upright when the mouse stops
    for (let i = 0; i < 90; i++) s = springStep(s.angle, s.vel, 0, 1 / 60);
    expect(settled(s.angle, s.vel, 0, 0)).toBe(true);
  });
  it('is stable at a slow frame rate', () => {
    let s = { angle: 14, vel: 0 };
    for (let i = 0; i < 40; i++) s = springStep(s.angle, s.vel, 0, 1 / 20);
    expect(Math.abs(s.angle)).toBeLessThan(0.05);
  });
});
