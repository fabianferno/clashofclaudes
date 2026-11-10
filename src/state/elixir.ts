import type { AgentKind, AgentQuota, Builder, QuotaWindow } from '../api/types';
import { COLLECTOR_NAME, isCollectorAgent, leftNow, untilText } from '../village/quota';

/**
 * Elixir that drives decisions: how fast each agent's limits are burning, when they run out, and
 * whether a To Do should wait (or go to another agent's builder) instead of draining the last of one.
 *
 * Pure: the history of readings is passed in (see `quotaHistory`).
 */

/** One reading of one window, kept to see how fast it burns. */
export interface Sample { at: number; leftPct: number; resetsAt: number | null }

/** Recent readings per agent and window id, oldest first. */
export type QuotaHistory = Partial<Record<AgentKind, Record<string, Sample[]>>>;

/** How far back readings count toward the recent burn rate. */
export const RECENT_MS = 60 * 60_000;
/** The shortest span of readings a recent rate is read from (shorter spans are noise). */
export const MIN_SPAN_MS = 10 * 60_000;
/** A window must have been open this long before its average burn says anything. */
const MIN_ELAPSED_MS = 5 * 60_000;
/** Readings kept per window (polls come every few minutes; this is well over the recent hour). */
const MAX_SAMPLES = 60;

/** Adds a reading to the history (a new copy); readings past the recent hour and a refilled window's old period drop out. */
export function recordReading(h: QuotaHistory, q: AgentQuota, at: number = q.updatedAt): QuotaHistory {
  const per = { ...(h[q.agent] ?? {}) };
  for (const w of q.windows) {
    const had = per[w.id] ?? [];
    if (had.some((s) => s.at >= at)) continue; // the same reading again, or an older one arriving late
    const keep = had.filter((s) => s.at >= at - RECENT_MS * 2 && s.resetsAt === w.resetsAt);
    per[w.id] = [...keep, { at, leftPct: w.leftPct, resetsAt: w.resetsAt }].slice(-MAX_SAMPLES);
  }
  return { ...h, [q.agent]: per };
}

/**
 * Percent per ms the window burns "at this rate": from the readings of the last hour when they
 * span at least 10 minutes of the same period (0 when nothing was used), else the average since
 * the window opened. Null when neither can be told.
 */
export function burnRate(w: QuotaWindow, now: number, samples: readonly Sample[] = []): number | null {
  const recent = samples.filter((s) => s.at >= now - RECENT_MS && s.resetsAt === w.resetsAt);
  if (recent.length >= 2) {
    const first = recent[0], last = recent[recent.length - 1];
    const span = last.at - first.at;
    if (span >= MIN_SPAN_MS) return Math.max(0, first.leftPct - last.leftPct) / span;
  }
  if (w.resetsAt === null || !w.windowMins || w.resetsAt <= now) return null;
  const elapsed = now - (w.resetsAt - w.windowMins * 60_000);
  if (elapsed < MIN_ELAPSED_MS) return null;
  return Math.max(0, 100 - w.leftPct) / elapsed;
}

export interface WindowForecast {
  window: QuotaWindow;
  left: number;
  /** Percent per hour; null when it cannot be told. */
  perHour: number | null;
  /** When it empties at this rate; null when it is not burning or the rate is unknown. */
  emptyAt: number | null;
  /** It empties before it refills (or, with no reset time, within a day). */
  runsOut: boolean;
}

export function forecastWindow(w: QuotaWindow, now: number, samples: readonly Sample[] = []): WindowForecast {
  const left = leftNow(w, now);
  const refilled = w.resetsAt !== null && w.resetsAt <= now;
  const rate = refilled ? null : burnRate(w, now, samples);
  const emptyAt = left <= 0 ? now : rate && rate > 0 ? now + left / rate : null;
  const horizon = w.resetsAt ?? now + 24 * 3_600_000;
  return { window: w, left, perHour: rate === null ? null : rate * 3_600_000, emptyAt, runsOut: emptyAt !== null && emptyAt < horizon };
}

/** Every window's forecast, the soonest to run out first (then the least left). */
export function forecastAgent(q: AgentQuota | undefined, now: number, h: QuotaHistory = {}): WindowForecast[] {
  if (!q) return [];
  const per = h[q.agent] ?? {};
  return q.windows
    .map((w) => forecastWindow(w, now, per[w.id]))
    .sort((a, b) => Number(b.runsOut) - Number(a.runsOut) || (a.emptyAt ?? Infinity) - (b.emptyAt ?? Infinity) || a.left - b.left);
}

/** The window that will stop the agent first: the first to run out at this rate, else the emptiest. */
export function bindingForecast(q: AgentQuota | undefined, now: number, h: QuotaHistory = {}): WindowForecast | null {
  const all = forecastAgent(q, now, h);
  return all.find((f) => f.runsOut) ?? [...all].sort((a, b) => a.left - b.left)[0] ?? null;
}

/** The least left across an agent's windows (null without a reading). */
export function leastLeft(q: AgentQuota | undefined, now: number): number | null {
  if (!q || q.windows.length === 0) return null;
  return Math.min(...q.windows.map((w) => leftNow(w, now)));
}

export interface ElixirRules {
  /** Auto-started To Dos wait while an agent has this percent or less left; 0 turns it off. */
  elixirReserve?: number | null;
  /** A held To Do goes to a free builder whose agent has elixir. */
  elixirStandIn?: boolean;
}

export const DEFAULT_RESERVE = 10;

export const reserveOf = (r: ElixirRules | null | undefined): number => r?.elixirReserve ?? DEFAULT_RESERVE;

/** Whether the agent is at or under the reserve. Agents without a reading (or without limits) never are. */
export function isLow(agent: AgentKind, quotas: Partial<Record<AgentKind, AgentQuota>>, now: number, rules: ElixirRules | null | undefined): boolean {
  const reserve = reserveOf(rules);
  if (reserve <= 0 || !isCollectorAgent(agent)) return false;
  const left = leastLeft(quotas[agent], now);
  return left !== null && left <= reserve;
}

/**
 * A builder to take a held To Do instead: free, not `taken`, its agent read and above the reserve.
 * The one with the most left wins (then the roster order).
 */
export function standInFor(
  builders: readonly Builder[], busy: ReadonlySet<string>, quotas: Partial<Record<AgentKind, AgentQuota>>, now: number, rules: ElixirRules | null | undefined,
): Builder | null {
  let best: { b: Builder; left: number } | null = null;
  for (const b of builders) {
    if (busy.has(b.id) || !isCollectorAgent(b.agent) || isLow(b.agent, quotas, now, rules)) continue;
    const left = leastLeft(quotas[b.agent], now);
    if (left === null) continue;
    if (!best || left > best.left) best = { b, left };
  }
  return best?.b ?? null;
}

/** "3:40 PM" today, "Thu 3:40 PM" on another day. */
export function clockText(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/** What a window's forecast says, in a line: "Runs out around 3:40 PM, 1h 20m before it refills". */
export function forecastText(f: WindowForecast, now: number): string {
  if (f.left <= 0) return f.window.resetsAt !== null && f.window.resetsAt > now ? `Empty until it refills in ${untilText(f.window.resetsAt - now)}` : 'Empty';
  if (f.perHour === null) return 'Not enough readings yet to tell how fast it burns';
  if (f.perHour === 0 || f.emptyAt === null) return 'Not burning right now';
  if (f.runsOut) {
    const before = f.window.resetsAt !== null ? `, ${untilText(f.window.resetsAt - f.emptyAt)} before it refills` : '';
    return `At this rate it runs out around ${clockText(f.emptyAt, now)}${before}`;
  }
  return 'At this rate it lasts until it refills';
}

/** Why an auto To Do for `agent` waits: "Waiting for Claude's elixir (6% left, refills in 2h)". */
export function heldText(agent: AgentKind, q: AgentQuota | undefined, now: number): string {
  const name = isCollectorAgent(agent) ? COLLECTOR_NAME[agent] : agent;
  const left = leastLeft(q, now);
  const low = q?.windows.filter((w) => leftNow(w, now) === left).map((w) => w.resetsAt).filter((r): r is number => r !== null && r > now) ?? [];
  const refill = low.length ? `, refills in ${untilText(Math.min(...low) - now)}` : '';
  return `Waiting for ${name}'s elixir (${Math.round(left ?? 0)}% left${refill})`;
}
