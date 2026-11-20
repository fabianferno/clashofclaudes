import { expect, test } from 'vitest';
import { activityOf, stageFromLevel } from './activity';

// The same table is in src-tauri/src/activity.rs: keep the two in step.
const D = 86_400_000, now = 100 * D;
const cases: Array<[number[], number]> = [
  [[], 0],
  [[now], 1], // one today
  [[now - 4 * D], 0], // 0.397 < 0.5
  [[now - 2 * D, now - 3 * D], 1], // ~1.13
  [[now, now - D, now - 2 * D], 2], // ~2.42
  [Array.from({ length: 8 }, (_, i) => now - i * D), 3], // daily for 8 days, ~4.09
  [Array.from({ length: 14 }, (_, i) => now - (i / 2) * D), 4], // 2/day for a week, ~7.35
  [[now + 5 * D], 1], // a future time (clock skew) counts as now
];

test.each(cases)('activityOf(%j).stage = %i', (ships, stage) => {
  expect(activityOf(ships, now).stage).toBe(stage);
});

test('names the stage and counts the last 7 days', () => {
  expect(activityOf([now, now - 6 * D, now - 7 * D], now)).toEqual({ stage: 1, name: 'Stirring', shippedThisWeek: 2 });
});

test('stageFromLevel matches the old houseStage', () => {
  expect([1, 2, 3, 4, 6, 8, 20].map(stageFromLevel)).toEqual([0, 1, 1, 2, 3, 4, 4]);
});
