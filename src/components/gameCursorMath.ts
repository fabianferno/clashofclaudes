/**
 * The game cursor's motion, as pure functions (GameCursor.tsx runs them once per frame).
 *
 * The pointer turns on its tip to point where the mouse is going, like an arrow following its
 * flight, then, once the mouse has been still for a moment, swings back to its resting up-left
 * angle. Slow drifts and jitter do not turn it (a speed threshold on a smoothed velocity), and it
 * always turns the short way round.
 */

/** Unit vector from the tip down the body of the pointer at rest (about 32 degrees right of straight down). */
export const BODY_DIR = { x: Math.sin((32 * Math.PI) / 180), y: Math.cos((32 * Math.PI) / 180) } as const;
/** The way the tip points at rest, in screen degrees (0 = right, 90 = down, clockwise as CSS `rotate`). */
export const REST_HEADING = (Math.atan2(-BODY_DIR.y, -BODY_DIR.x) * 180) / Math.PI;
/** Below this speed (px/s) the pointer keeps the heading it has: no turning on small or slow moves. */
export const TURN_SPEED = 160;
/** How long (ms) it keeps pointing the last way it went after the mouse stops, before swinging back. */
export const HOLD_MS = 450;

/** `a` wrapped into (-180, 180]. */
export function wrapDeg(a: number): number {
  const w = ((((a + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
}

/** The angle equal to `target` (mod 360) that is nearest to `current`: turning there is the short way round. */
export const nearestDeg = (target: number, current: number): number => current + wrapDeg(target - current);

/**
 * The rotation (CSS degrees, from the resting pose) that points the tip along (vx, vy) px/s, or null
 * when the mouse moves too slowly to say where it is going.
 */
export function headingFromVelocity(vx: number, vy: number): number | null {
  if (!(Math.hypot(vx, vy) >= TURN_SPEED)) return null;
  return wrapDeg((Math.atan2(vy, vx) * 180) / Math.PI - REST_HEADING);
}

/** Spring constants: snappy enough to keep up with a turn, slightly under-damped (a faint overshoot). */
export const STIFFNESS = 260;
export const DAMPING = 2 * Math.sqrt(STIFFNESS) * 0.8;

/** One semi-implicit Euler step of the damped spring pulling `angle` toward `target`. */
export function springStep(angle: number, vel: number, target: number, dt: number): { angle: number; vel: number } {
  const acc = STIFFNESS * (target - angle) - DAMPING * vel;
  const v = vel + acc * dt;
  return { angle: angle + v * dt, vel: v };
}

/** Exponential smoothing factor for a step of `dt` seconds with time constant `tau`. */
export const smoothing = (dt: number, tau: number) => 1 - Math.exp(-Math.max(0, dt) / tau);

/** At rest: back in its resting pose, not turning, and the mouse not moving (the loop may stop). */
export const settled = (angle: number, vel: number, vx: number, vy: number) =>
  Math.abs(wrapDeg(angle)) < 0.05 && Math.abs(vel) < 0.05 && Math.hypot(vx, vy) < TURN_SPEED / 4;

/** The drop shadow's offset in the pointer's own (rotated) frame, so on screen it always falls down-right. */
export function shadowOffset(angle: number, sx = 1.4, sy = 2.8): { x: number; y: number } {
  const r = (-angle * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: sx * c - sy * s, y: sx * s + sy * c };
}
