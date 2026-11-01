import type { AgentKind, AgentQuota, QuotaWindow, Tile } from '../api/types';
import type { StatusTone } from './status';

/** Agents that ration usage; OpenCode uses whatever provider key it is given. */
export const COLLECTOR_AGENTS = ['claude', 'codex', 'antigravity'] as const satisfies readonly AgentKind[];
export type CollectorAgent = (typeof COLLECTOR_AGENTS)[number];

/**
 * Collector top-left tiles (2x2): beside the town hall's left and right corners and in front of
 * it, inside the 4-tile gap every compound keeps from the hall, so nothing else can stand there.
 */
export const COLLECTOR_SLOT: Record<CollectorAgent, Tile> = {
  claude: { x: -5, y: 3 },
  codex: { x: 3, y: -5 },
  antigravity: { x: 4, y: 4 },
};

export const isCollectorAgent = (a: string): a is CollectorAgent => (COLLECTOR_AGENTS as readonly string[]).includes(a);

/** Percent left now: a window whose reset time has passed has refilled. */
export function leftNow(w: QuotaWindow, now: number): number {
  if (w.resetsAt !== null && w.resetsAt <= now) return 100;
  return Math.max(0, Math.min(100, w.leftPct));
}

/** The tank's window: the shortest one; among equal lengths, the one with the least left. */
export function primaryWindow(q: AgentQuota, now: number): QuotaWindow | null {
  let best: QuotaWindow | null = null;
  for (const w of q.windows) {
    const len = w.windowMins ?? Infinity, bestLen = best?.windowMins ?? Infinity;
    if (!best || len < bestLen || (len === bestLen && leftNow(w, now) < leftNow(best, now))) best = w;
  }
  return best;
}

/** Tank level in tenths (0-10); only a truly empty window shows 0, only a full one 10. */
export function tankTenths(left: number): number {
  if (left <= 0) return 0;
  if (left >= 100) return 10;
  return Math.min(9, Math.max(1, Math.round(left / 10)));
}

/** Label colour: elixir pink while plenty is left, orange at 25 % or less, red at 10 % or less. */
export function quotaTone(left: number): StatusTone {
  return left > 25 ? 'elixir' : left > 10 ? 'working' : 'needs';
}

/** "3d 4h", "2h 10m", "12m", "<1m". */
export function untilText(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return mm ? `${h}h ${mm}m` : `${h}h`;
  return `${mm}m`;
}

/** Short window name for labels. */
export function windowShort(mins: number | null): string {
  if (mins === null) return '';
  if (mins === 10_080) return 'week';
  if (mins >= 40_000) return 'month';
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

/** What the collector shows; null level means no reading yet. Labels change at most once a minute. */
export function collectorLook(q: AgentQuota | undefined, now: number): { tenths: number | null; tone: StatusTone; label: string } | null {
  const w = q && primaryWindow(q, now);
  if (!w) return null;
  const left = leftNow(w, now);
  const short = windowShort(w.windowMins);
  const label = left > 0
    ? `${Math.round(left)}%${short ? ` · ${short}` : ''}`
    : w.resetsAt !== null ? `Empty · ${untilText(w.resetsAt - now)}` : 'Empty';
  return { tenths: tankTenths(left), tone: quotaTone(left), label };
}
