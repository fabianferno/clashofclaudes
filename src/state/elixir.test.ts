import type { AgentQuota, Builder, QuotaWindow } from '../api/types';
import { bindingForecast, burnRate, forecastText, forecastWindow, heldText, isLow, recordReading, standInFor, type QuotaHistory } from './elixir';

const H = 3_600_000;
const now = 1_800_000_000_000;
const win = (id: string, leftPct: number, windowMins: number | null, resetsAt: number | null, label = id): QuotaWindow =>
  ({ id, label, group: null, leftPct, resetsAt, windowMins });
const quota = (agent: AgentQuota['agent'], ...windows: QuotaWindow[]): AgentQuota => ({ agent, windows, updatedAt: now, source: 'test' });

test('without recent readings the rate is the average since the window opened', () => {
  // a 5-hour window, 2 hours in, 40 % used: 20 % an hour; 60 % left runs out in 3 h, right as it refills + 0
  const w = win('five_hour', 60, 300, now + 3 * H);
  expect(burnRate(w, now)! * H).toBeCloseTo(20);
  const f = forecastWindow(w, now);
  expect(f.emptyAt).toBe(now + 3 * H);
  expect(f.runsOut).toBe(false); // empties exactly as it refills
  const faster = forecastWindow(win('five_hour', 50, 300, now + 3 * H), now); // 25 %/h, 2 h left of elixir
  expect(faster.runsOut).toBe(true);
  expect(faster.emptyAt).toBe(now + 2 * H);
});

test('recent readings win over the average, and a quiet hour reads as not burning', () => {
  const w = win('seven_day', 70, 10_080, now + 3 * 24 * H);
  const burning = [{ at: now - 30 * 60_000, leftPct: 80, resetsAt: w.resetsAt }, { at: now, leftPct: 70, resetsAt: w.resetsAt }];
  expect(burnRate(w, now, burning)! * H).toBeCloseTo(20);
  const quiet = [{ at: now - 40 * 60_000, leftPct: 70, resetsAt: w.resetsAt }, { at: now, leftPct: 70, resetsAt: w.resetsAt }];
  expect(burnRate(w, now, quiet)).toBe(0);
  expect(forecastText(forecastWindow(w, now, quiet), now)).toBe('Not burning right now');
  // too short a span, or readings from the window's previous period, fall back to the average
  const short = [{ at: now - 2 * 60_000, leftPct: 75, resetsAt: w.resetsAt }, { at: now, leftPct: 70, resetsAt: w.resetsAt }];
  const old = [{ at: now - 30 * 60_000, leftPct: 99, resetsAt: now - 1 }, { at: now, leftPct: 70, resetsAt: w.resetsAt }];
  const avg = burnRate(w, now)!;
  expect(burnRate(w, now, short)).toBe(avg);
  expect(burnRate(w, now, old)).toBe(avg);
});

test('a refilled or empty window, and one with no length or reset, forecast plainly', () => {
  expect(forecastWindow(win('a', 5, 300, now - 1), now).left).toBe(100);
  expect(forecastWindow(win('a', 5, 300, now - 1), now).runsOut).toBe(false);
  expect(forecastWindow(win('a', 0, 300, now + H), now)).toMatchObject({ emptyAt: now, runsOut: true });
  expect(forecastWindow(win('a', 40, null, null), now).perHour).toBeNull();
  expect(forecastText(forecastWindow(win('a', 40, null, null), now), now)).toMatch(/Not enough readings/);
});

test('the binding window is the first to run out, else the emptiest', () => {
  const q = quota('claude', win('seven_day', 30, 10_080, now + 24 * H), win('five_hour', 50, 300, now + 3 * H));
  expect(bindingForecast(q, now)?.window.id).toBe('five_hour'); // 25 %/h: runs out in 2 h
  const calm = quota('claude', win('seven_day', 30, 10_080, now + 24 * H), win('five_hour', 90, 300, now + 3 * H));
  expect(bindingForecast(calm, now)?.window.id).toBe('seven_day');
  expect(bindingForecast(undefined, now)).toBeNull();
});

test('the history keeps readings of the current period, skips repeats and late ones', () => {
  let h: QuotaHistory = {};
  h = recordReading(h, { ...quota('codex', win('primary', 80, 300, now + H)), updatedAt: now - 20 * 60_000 });
  h = recordReading(h, { ...quota('codex', win('primary', 70, 300, now + H)), updatedAt: now });
  h = recordReading(h, { ...quota('codex', win('primary', 70, 300, now + H)), updatedAt: now }); // the same again
  h = recordReading(h, { ...quota('codex', win('primary', 90, 300, now + H)), updatedAt: now - 30 * 60_000 }); // late
  expect(h.codex?.primary.map((s) => s.leftPct)).toEqual([80, 70]);
  h = recordReading(h, { ...quota('codex', win('primary', 100, 300, now + 6 * H)), updatedAt: now + H }); // refilled: a new period
  expect(h.codex?.primary.map((s) => s.leftPct)).toEqual([100]);
});

const b = (id: string, agent: Builder['agent']): Builder => ({ id, name: id, agent, model: null, effort: null, customCommand: null });

test('an agent is low at or under the reserve on any window; unread and unrationed agents never are', () => {
  const quotas = { claude: quota('claude', win('seven_day', 60, 10_080, now + H), win('five_hour', 8, 300, now + H)) };
  expect(isLow('claude', quotas, now, null)).toBe(true); // default 10 %
  expect(isLow('claude', quotas, now, { elixirReserve: 5 })).toBe(false);
  expect(isLow('claude', quotas, now, { elixirReserve: 0 })).toBe(false);
  expect(isLow('codex', quotas, now, null)).toBe(false);
  expect(isLow('opencode', quotas, now, { elixirReserve: 50 })).toBe(false);
  expect(isLow('claude', { claude: quota('claude', win('five_hour', 2, 300, now - 1)) }, now, null)).toBe(false); // refilled
  expect(heldText('claude', quotas.claude, now)).toBe("Waiting for Claude's elixir (8% left, refills in 1h)");
});

test('a stand-in is a free builder whose agent was read above the reserve, the most left first', () => {
  const builders = [b('c', 'claude'), b('x1', 'codex'), b('g', 'antigravity'), b('o', 'opencode')];
  const quotas = {
    claude: quota('claude', win('five_hour', 3, 300, now + H)),
    codex: quota('codex', win('primary', 40, 300, now + H)),
    antigravity: quota('antigravity', win('w', 70, 10_080, now + H)),
  };
  expect(standInFor(builders, new Set(), quotas, now, null)?.id).toBe('g');
  expect(standInFor(builders, new Set(['g']), quotas, now, null)?.id).toBe('x1');
  expect(standInFor(builders, new Set(['g', 'x1']), quotas, now, null)).toBeNull(); // OpenCode: no reading
});
