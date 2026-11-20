import type { AgentKind, AgentQuota, Compound, QuotaWindow, Tile } from '../api/types';
import { HALL, STRUCT, gapBetween, roadRects, villageRect, wallRect, type Rect } from './layout';
import type { StatusTone } from './status';

/**
 * Agents whose limits the app can read. OpenCode uses whatever provider key it is given; Grok Build
 * reports its plan's limit (`grok usage --json`) only on its background service, so it has none yet.
 */
export const COLLECTOR_AGENTS = ['claude', 'codex', 'antigravity'] as const satisfies readonly AgentKind[];
export type CollectorAgent = (typeof COLLECTOR_AGENTS)[number];

/**
 * Default collector top-left tiles (2x2): beside the town hall's left and right corners and in
 * front of it, inside the 4-tile gap every compound keeps from the hall. The owner can drag them.
 */
export const COLLECTOR_SLOT: Record<CollectorAgent, Tile> = {
  claude: { x: -5, y: 3 },
  codex: { x: 3, y: -5 },
  antigravity: { x: 4, y: 4 },
};

/** Short names for the collectors' labels. */
export const COLLECTOR_NAME: Record<CollectorAgent, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

export const isCollectorAgent = (a: string): a is CollectorAgent => (COLLECTOR_AGENTS as readonly string[]).includes(a);

/** Percent left now: a window whose reset time has passed has refilled. */
export function leftNow(w: QuotaWindow, now: number): number {
  if (w.resetsAt !== null && w.resetsAt <= now) return 100;
  return Math.max(0, Math.min(100, w.leftPct));
}

/** Every tank follows the same limit where an agent reports it, so the tanks compare: the weekly one. */
export const TANK_WINDOW_MINS = 10_080;

/** How far a window's length is from the tank's (as a ratio, so 5 hours and 30 days weigh fairly); unknown lengths last. */
const tankDistance = (w: QuotaWindow) => (w.windowMins ? Math.abs(Math.log(w.windowMins / TANK_WINDOW_MINS)) : Infinity);

/**
 * The tank's window: the weekly one, else the one closest to a week in length; among equals
 * (Antigravity reports a weekly limit per model group), the one with the least left.
 */
export function primaryWindow(q: AgentQuota, now: number): QuotaWindow | null {
  let best: QuotaWindow | null = null;
  for (const w of q.windows) {
    const d = tankDistance(w), bestD = best ? tankDistance(best) : Infinity;
    if (!best || d < bestD || (d === bestD && leftNow(w, now) < leftNow(best, now))) best = w;
  }
  return best;
}

/** Tank level in tenths (0-10); only a truly empty window shows 0, only a full one 10. */
export function tankTenths(left: number): number {
  if (left <= 0) return 0;
  if (left >= 100) return 10;
  return Math.min(9, Math.max(1, Math.round(left / 10)));
}

/** Label colour: the agent's resource while plenty is left, orange at 25 % or less, red at 10 % or less. */
export function quotaTone(left: number, agent: CollectorAgent): Exclude<StatusTone, 'app'> {
  return left > 25 ? `resource-${agent}` : left > 10 ? 'working' : 'needs';
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
export function collectorLook(q: AgentQuota | undefined, now: number, agent: CollectorAgent): { tenths: number | null; tone: StatusTone; label: string } | null {
  const w = q && primaryWindow(q, now);
  if (!w) return null;
  const left = leftNow(w, now);
  const short = windowShort(w.windowMins);
  const label = left > 0
    ? `${Math.round(left)}%${short ? ` · ${short}` : ''}`
    : w.resetsAt !== null ? `Empty · ${untilText(w.resetsAt - now)}` : 'Empty';
  return { tenths: tankTenths(left), tone: quotaTone(left, agent), label };
}

/** Collectors the village shows: every rationed agent with a reading or installed. */
export function shownCollectors(quotas: Partial<Record<AgentKind, AgentQuota>> | undefined, installed: readonly AgentKind[] | undefined): CollectorAgent[] {
  return COLLECTOR_AGENTS.filter((a) => quotas?.[a] || installed?.includes(a));
}

/** How far out from the village (hall and compound walls) a collector may be dragged, in tiles. */
export const COLLECTOR_REACH = 8;

const footprint = (t: Tile): Rect => ({ x0: t.x, y0: t.y, w: STRUCT, h: STRUCT });

/**
 * Whether a collector may stand with its top-left on `at`: a tile clear of the hall and of every
 * compound's walls (so gates and paths stay open), off the `others` collectors, and no further
 * than COLLECTOR_REACH tiles out from the village.
 */
export function collectorFits(at: Tile, compounds: Compound[], others: readonly Tile[]): boolean {
  const r = footprint(at);
  if (gapBetween(r, HALL) < 1) return false;
  if (compounds.some((c) => gapBetween(r, wallRect(c)) < 1)) return false;
  if (compounds.some((c) => roadRects(c).some((q) => gapBetween(r, q) < 0))) return false;
  if (others.some((o) => gapBetween(r, footprint(o)) < 0)) return false;
  const v = villageRect(compounds);
  const k = COLLECTOR_REACH;
  return r.x0 >= v.x0 - k && r.y0 >= v.y0 - k && r.x0 + r.w <= v.x0 + v.w + k && r.y0 + r.h <= v.y0 + v.h + k;
}

/** The free tile nearest `from` (ring by ring, in a fixed order), or `from` when none is within reach. */
function nearestFit(from: Tile, compounds: Compound[], others: readonly Tile[]): Tile {
  for (let r = 1; r <= 24; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const t = { x: from.x + dx, y: from.y + dy };
        if (collectorFits(t, compounds, others)) return t;
      }
  return from;
}

/**
 * Where each shown collector stands. Dragged tiles (`spots`) win; a collector without one, or whose
 * tile a compound has since grown over, takes its default slot, or the nearest free tile to it.
 */
export function collectorTiles(
  shown: readonly CollectorAgent[], spots: Partial<Record<AgentKind, Tile>> | undefined, compounds: Compound[],
): Partial<Record<CollectorAgent, Tile>> {
  const out: Partial<Record<CollectorAgent, Tile>> = {};
  const placed = () => Object.values(out);
  for (const a of shown) {
    const t = spots?.[a];
    if (t && collectorFits(t, compounds, placed())) out[a] = t;
  }
  for (const a of shown) {
    if (out[a]) continue;
    const slot = COLLECTOR_SLOT[a];
    out[a] = collectorFits(slot, compounds, placed()) ? slot : nearestFit(slot, compounds, placed());
  }
  return out;
}
