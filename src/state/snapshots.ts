import { ipc } from '../api/ipc';
import { boardItems, useApp, type AppState } from './store';

/** A board's picture is retaken this often while the village is in view. */
export const SNAP_EVERY = 45_000;
/** A page that could not be pictured is tried again after this long. */
export const SNAP_RETRY = 60_000;
const TICK = 5_000;

/**
 * The next page to picture: a board's page with no picture first, then the stalest one past
 * SNAP_EVERY; never one that failed in the last SNAP_RETRY. Null when all are fresh.
 */
export function nextSnapshot(
  st: Pick<AppState, 'apps' | 'browsers' | 'boardSpots' | 'snapshots'>, failed: ReadonlyMap<string, number>, now: number,
): string | null {
  let best: string | null = null, bestAt = Infinity;
  for (const b of boardItems(st)) {
    if (!st.boardSpots[b.key]) continue; // not standing yet
    if ((failed.get(b.url) ?? -Infinity) > now - SNAP_RETRY) continue;
    const at = st.snapshots[b.url]?.at ?? -Infinity;
    if (at > now - SNAP_EVERY || at >= bestAt) continue;
    best = b.url;
    bestAt = at;
  }
  return best;
}

/**
 * Keeps the boards' pictures fresh, one at a time, only while the window is visible, focused and
 * not covered by a full-window view (pictures cost a few seconds of the app running). Returns a stop.
 */
export function autoSnapshots(): () => void {
  const failed = new Map<string, number>();
  let busy = false;
  const tick = () => {
    const st = useApp.getState();
    if (busy || document.visibilityState !== 'visible' || !document.hasFocus() || st.covers > 0) return;
    const url = nextSnapshot(st, failed, Date.now());
    if (!url) return;
    busy = true;
    ipc.snapshotApp(url)
      .then((data) => { failed.delete(url); useApp.getState().setSnapshot(url, data, Date.now()); })
      .catch(() => { failed.set(url, Date.now()); })
      .finally(() => { busy = false; });
  };
  const t = setInterval(tick, TICK);
  // a new board gets its picture without waiting for the next tick
  const unsub = useApp.subscribe((st, prev) => { if (st.boardSpots !== prev.boardSpots) tick(); });
  return () => { clearInterval(t); unsub(); };
}
