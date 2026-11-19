import { dayOf, durationText, wantsNudge } from './raid';

const empty = { ships: [], waitedMs: 0, waitingNow: 0 };
const ship = { at: 0, workspaceId: 'w1', builderName: 'Pete', agent: 'claude' as const, title: 'Dark mode', added: 40, removed: 3 };

test('the local day runs midnight to midnight', () => {
  const d = dayOf(new Date(2026, 10, 20, 15, 30));
  expect(d.day).toBe('2026-11-20');
  expect(d.from).toBe(new Date(2026, 10, 20).getTime());
  expect(d.to).toBe(new Date(2026, 10, 21).getTime());
  expect(dayOf(new Date(2026, 11, 31, 23, 59)).day).toBe('2026-12-31');
});

test('durations read as hours and minutes', () => {
  expect(durationText(0)).toBe('none');
  expect(durationText(30_000)).toBe('under a minute');
  expect(durationText(12 * 60_000)).toBe('12m');
  expect(durationText(80 * 60_000 + 59_000)).toBe('1h 20m');
});

test('offered in the evening, once a day, when something happened', () => {
  const evening = new Date(2026, 10, 20, 18, 5);
  const busy = { ...empty, ships: [ship] };
  expect(wantsNudge(evening, null, busy)).toBe(true);
  expect(wantsNudge(new Date(2026, 10, 20, 17, 59), null, busy)).toBe(false);
  expect(wantsNudge(evening, '2026-11-20', busy)).toBe(false); // seen today
  expect(wantsNudge(evening, '2026-11-19', busy)).toBe(true);
  expect(wantsNudge(evening, null, empty)).toBe(false);
  expect(wantsNudge(evening, null, { ...empty, waitedMs: 5 * 60_000 })).toBe(true);
  expect(wantsNudge(evening, null, null)).toBe(false);
});
