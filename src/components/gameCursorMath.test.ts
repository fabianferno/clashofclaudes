import { describe, expect, it } from 'vitest';
import { REST_HEADING, TURN_SPEED, headingFromVelocity, nearestDeg, settled, shadowOffset, springStep, wrapDeg } from './gameCursorMath';

describe('headingFromVelocity', () => {
  it('keeps its heading on slow moves and at rest', () => {
    expect(headingFromVelocity(0, 0)).toBeNull();
    expect(headingFromVelocity(TURN_SPEED * 0.9, 0)).toBeNull();
  });
  it('turns the tip toward where the mouse is going', () => {
    // the resting pose points up-left: moving that way needs no turn
    const r = (REST_HEADING * Math.PI) / 180;
    expect(headingFromVelocity(Math.cos(r) * 900, Math.sin(r) * 900)).toBeCloseTo(0);
    // tip direction after the turn = rest heading + turn = the direction of travel
    for (const [vx, vy, deg] of [[900, 0, 0], [0, 900, 90], [-900, 0, 180], [0, -900, -90], [600, 600, 45]]) {
      const turn = headingFromVelocity(vx, vy)!;
      expect(wrapDeg(REST_HEADING + turn)).toBeCloseTo(wrapDeg(deg));
    }
  });
});

describe('angles', () => {
  it('wrap into (-180, 180] and turn the short way round', () => {
    expect(wrapDeg(190)).toBeCloseTo(-170);
    expect(wrapDeg(-190)).toBeCloseTo(170);
    expect(wrapDeg(-180)).toBe(180);
    expect(nearestDeg(-170, 170)).toBeCloseTo(190); // 20° on, not 340° back
    expect(nearestDeg(0, 350)).toBeCloseTo(360);
  });
  it('the shadow stays down-right on screen whichever way the pointer points', () => {
    for (const a of [0, 45, 90, 180, -120]) {
      const o = shadowOffset(a);
      // rotating the offset back by the pointer's turn gives the screen offset
      const r = (a * Math.PI) / 180;
      expect(o.x * Math.cos(r) - o.y * Math.sin(r)).toBeCloseTo(1.4);
      expect(o.x * Math.sin(r) + o.y * Math.cos(r)).toBeCloseTo(2.8);
    }
  });
});

describe('springStep', () => {
  it('eases to the target and settles, with at most a faint overshoot', () => {
    let s = { angle: 0, vel: 0 };
    let max = 0;
    for (let i = 0; i < 60; i++) { s = springStep(s.angle, s.vel, 120, 1 / 60); max = Math.max(max, s.angle); }
    expect(s.angle).toBeCloseTo(120, 0);
    expect(max).toBeLessThan(120 * 1.05);
    for (let i = 0; i < 90; i++) s = springStep(s.angle, s.vel, 0, 1 / 60);
    expect(settled(s.angle, s.vel, 0, 0)).toBe(true);
  });
  it('is stable at a slow frame rate', () => {
    let s = { angle: 150, vel: 0 };
    for (let i = 0; i < 40; i++) s = springStep(s.angle, s.vel, 0, 1 / 20);
    expect(Math.abs(s.angle)).toBeLessThan(0.05);
  });
});
