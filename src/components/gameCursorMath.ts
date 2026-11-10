/**
 * The game cursor's motion, as pure functions (GameCursor.tsx runs them once per frame).
 *
 * The pointer hangs from its tip like a pendulum: moving it sideways to its body swings the body
 * back, so the tip leans into the direction of travel. Only the part of the velocity across the
 * body tilts it (moving along the body does not), slow drifts are ignored, and the angle saturates
 * smoothly (tanh) instead of clipping.
 */

/** Unit vector from the tip down the body of the pointer (about 32 degrees right of straight down). */
export const BODY_DIR = { x: Math.sin((32 * Math.PI) / 180), y: Math.cos((32 * Math.PI) / 180) } as const;
/** Largest tilt, in degrees, however fast the mouse moves. */
export const MAX_TILT = 14;
/** Speeds across the body below this (px/s) do not tilt the pointer: no wobble on small moves. */
export const DEAD_ZONE = 120;
/** Speed above the dead zone (px/s) that gives about 76% of MAX_TILT (tanh(1)). */
export const TILT_SCALE = 1100;

/**
 * Target tilt in degrees (positive = clockwise on screen, CSS `rotate`) for a pointer moving at
 * (vx, vy) px/s. Moving right (or up) tilts clockwise; left (or down) anticlockwise.
 */
export function tiltFromVelocity(vx: number, vy: number): number {
  // 2D cross product: velocity across the body (positive when moving right of it)
  const across = vx * BODY_DIR.y - vy * BODY_DIR.x;
  const excess = Math.abs(across) - DEAD_ZONE;
  if (!(excess > 0)) return 0;
  return Math.sign(across) * MAX_TILT * Math.tanh(excess / TILT_SCALE);
}

/** Spring constants: slightly under-damped, so it settles with the faintest overshoot. */
export const STIFFNESS = 170;
export const DAMPING = 2 * Math.sqrt(STIFFNESS) * 0.78;

/** One semi-implicit Euler step of the damped spring pulling `angle` toward `target`. */
export function springStep(angle: number, vel: number, target: number, dt: number): { angle: number; vel: number } {
  const acc = STIFFNESS * (target - angle) - DAMPING * vel;
  const v = vel + acc * dt;
  return { angle: angle + v * dt, vel: v };
}

/** Exponential smoothing factor for a step of `dt` seconds with time constant `tau`. */
export const smoothing = (dt: number, tau: number) => 1 - Math.exp(-Math.max(0, dt) / tau);

/** At rest: no tilt left to undo and nothing moving (the loop may stop). */
export const settled = (angle: number, vel: number, vx: number, vy: number) =>
  Math.abs(angle) < 0.05 && Math.abs(vel) < 0.05 && Math.hypot(vx, vy) < DEAD_ZONE / 4;
