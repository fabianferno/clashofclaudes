/**
 * The time of day the ambience follows (state/ambience.ts), from the owner's clock: night from
 * 9 PM to 5 AM, fading out by 7 AM and back in from 7 PM, with sunrise (6:30) and sunset (6:30 PM).
 * Fixed hours, not the real sun: the app never asks where you are. The village itself is always midday.
 */
export interface Daylight {
  /** 0 by day .. 1 in the dead of night. */
  night: number;
  /** 0 .. 1 at sunrise or sunset. */
  golden: number;
  /** Before noon: the low sun is on the left (east), after it on the right. */
  morning: boolean;
}

export const NOON: Daylight = { night: 0, golden: 0, morning: false };

const SUNRISE = 6.5;
const SUNSET = 18.5;
/** Hours either side of sunrise or sunset that the light is golden. */
const GOLDEN = 1.25;

const smooth = (k: number) => { const t = Math.min(1, Math.max(0, k)); return t * t * (3 - 2 * t); };

/** The light at `hour` (0-24, fractional). */
export function daylightAtHour(hour: number): Daylight {
  const h = ((hour % 24) + 24) % 24;
  const night = h < 5 || h >= 21 ? 1 : h < 7 ? 1 - smooth((h - 5) / 2) : h >= 19 ? smooth((h - 19) / 2) : 0;
  const peak = (c: number) => smooth(1 - Math.abs(h - c) / GOLDEN);
  return { night, golden: Math.max(peak(SUNRISE), peak(SUNSET)), morning: h < 12 };
}

export function daylightAt(d: Date): Daylight {
  return daylightAtHour(d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600);
}
