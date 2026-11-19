import type { SessionInfo, Workspace } from '../api/types';
import { queueReason } from '../state/queue';

/**
 * The village's weather, read from what its builders are doing:
 * - `sunny`: builders at work and nothing waits on the owner
 * - `day`: builders at work while something waits on the owner
 * - `night`: nothing has run for a little while (the village sleeps)
 * and a storm over every compound with a stuck session.
 */
export type Sky = 'night' | 'day' | 'sunny';

export interface Weather {
  sky: Sky;
  /** Workspaces with a stuck session, sorted. */
  storms: string[];
}

/** Night falls only after nothing has run this long, so a pause between tasks keeps the day. */
export const NIGHT_AFTER_MS = 20_000;

export const CLEAR: Weather = { sky: 'day', storms: [] };

const running = (s: SessionInfo) =>
  !s.paused && (s.kind.kind === 'agent' ? s.state.kind === 'working' || s.state.kind === 'starting' : s.busy && s.state.kind !== 'ended');

/** The weather over `workspaces` (those with a compound) at `now`. */
export function weatherOf(sessions: readonly SessionInfo[], workspaces: readonly Pick<Workspace, 'id' | 'compound'>[], now: number): Weather {
  const shown = new Set(workspaces.filter((w) => w.compound).map((w) => w.id));
  const here = sessions.filter((s) => shown.has(s.workspaceId));
  const waiting = here.some((s) => queueReason(s) !== null);
  const storms = [...new Set(here.filter((s) => queueReason(s) === 'stuck').map((s) => s.workspaceId))].sort();
  if (here.some(running)) return { sky: waiting ? 'day' : 'sunny', storms };
  // the latest moment an agent stopped working: the day lasts a little past it
  const stopped = Math.max(0, ...here.filter((s) => s.kind.kind === 'agent' && !s.paused).map((s) => s.stateSince ?? 0));
  return { sky: stopped && now - stopped < NIGHT_AFTER_MS ? 'day' : 'night', storms };
}

export const sameWeather = (a: Weather, b: Weather) => a.sky === b.sky && a.storms.join() === b.storms.join();

/**
 * Lightning strikes: the scene tells, the ambience answers with thunder. One window's listeners
 * only (the mini village's strikes stay in its own window).
 */
const strikes = new Set<(workspaceId: string) => void>();
export function onLightning(f: (workspaceId: string) => void): () => void {
  strikes.add(f);
  return () => { strikes.delete(f); };
}
export function strike(workspaceId: string): void {
  for (const f of strikes) {
    try { f(workspaceId); } catch { /* a listener's failure is its own */ }
  }
}
