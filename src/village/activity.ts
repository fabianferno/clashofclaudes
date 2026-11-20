/**
 * How busy a workspace is: its house's look follows the sessions accepted there lately, not a
 * lifetime total. Mirrors src-tauri/src/activity.rs (same table in both tests).
 */
export type Stage = 0 | 1 | 2 | 3 | 4;

export const STAGE_NAMES = ['Quiet', 'Stirring', 'Active', 'Busy', 'Booming'] as const;

export const DAY_MS = 24 * 3600 * 1000;
export const WEEK_MS = 7 * DAY_MS;
/** A ship counts half as much after this long. */
const HALF_LIFE_MS = 3 * DAY_MS;
/** The score each stage needs: Stirring, Active, Busy, Booming (below the first is Quiet). */
const THRESHOLDS = [0.5, 2, 4, 7];

/** Stage, its name, and the ships of the last 7 days. A time in the future (clock skew) counts as now. */
export function activityOf(ships: readonly number[], now: number): { stage: Stage; name: string; shippedThisWeek: number } {
  let score = 0;
  for (const at of ships) score += Math.pow(0.5, Math.max(0, now - at) / HALF_LIFE_MS);
  const stage = THRESHOLDS.filter((t) => score >= t).length as Stage;
  return { stage, name: STAGE_NAMES[stage], shippedThisWeek: ships.filter((at) => now - at < WEEK_MS).length };
}

/** The stage an app before activity houses drew for `level` (its old `houseStage`): visitors' old maps. */
export function stageFromLevel(level: number): Stage {
  if (level >= 8) return 4;
  if (level >= 6) return 3;
  if (level >= 4) return 2;
  if (level >= 2) return 1;
  return 0;
}
