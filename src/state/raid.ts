import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { RaidReport } from '../api/types';
import { useApp } from './store';

/**
 * The raid report: what shipped today, the lines it changed, and how long builders waited on the
 * owner (the backend's `raid.rs` keeps the log). Shown as a card in the window; Export saves a PNG.
 */

/** The local day around `now`: its bounds (ms) and its date as YYYY-MM-DD. */
export function dayOf(now: Date): { from: number; to: number; day: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { from: start.getTime(), to: end.getTime(), day: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}` };
}

/** "1h 20m", "12m", "under a minute", "none". */
export function durationText(ms: number): string {
  if (ms <= 0) return 'none';
  const m = Math.floor(ms / 60_000);
  if (m === 0) return 'under a minute';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

/** From this hour the top bar offers the day's report (once it has something to show). */
export const NUDGE_HOUR = 18;
const SEEN_KEY = 'coc.raidSeen';

/** Whether the top bar offers today's report: evening, not yet seen or dismissed today, and something happened. */
export function wantsNudge(now: Date, seen: string | null, report: RaidReport | null): boolean {
  if (now.getHours() < NUDGE_HOUR || seen === dayOf(now).day || !report) return false;
  return report.ships.length > 0 || report.waitedMs >= 60_000;
}

export function seenToday(): string | null {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}

/** The owner opened or dismissed today's report: no more offers today. */
export function markSeen(now = new Date()): void {
  try { localStorage.setItem(SEEN_KEY, dayOf(now).day); } catch { /* the pill shows again; harmless */ }
  useApp.setState({ raidNudge: false });
}

/** Opens today's report (and counts it as seen). */
export function openRaidReport(): void {
  markSeen();
  useApp.getState().setRaidOpen(true);
}

/** Today's report from the backend. */
export function fetchToday(now = new Date()): Promise<RaidReport> {
  const { from, to } = dayOf(now);
  return ipc.raidReport(from, to);
}

/** How often, in the evening, the top bar checks whether to offer the report. */
const NUDGE_EVERY_MS = 60_000;

/** Keeps `raidNudge` in the store up to date. Returns a stop. */
export function watchRaidNudge(clock: () => Date = () => new Date()): () => void {
  let live = true;
  const check = async () => {
    const now = clock();
    if (now.getHours() < NUDGE_HOUR || seenToday() === dayOf(now).day) {
      if (useApp.getState().raidNudge) useApp.setState({ raidNudge: false });
      return;
    }
    try {
      const r = await fetchToday(now);
      if (live) useApp.setState({ raidNudge: wantsNudge(now, seenToday(), r) });
    } catch { /* no backend: no offer */ }
  };
  void check();
  const t = window.setInterval(() => void check(), NUDGE_EVERY_MS);
  return () => { live = false; window.clearInterval(t); };
}

/** Today's report while `open`, refreshed every half minute (waits keep counting). */
export function useTodayReport(open: boolean): { report: RaidReport | null; error: string | null; day: string } {
  const [report, setReport] = useState<RaidReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState(dayOf(new Date()).day);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => {
      const now = new Date();
      setDay(dayOf(now).day);
      fetchToday(now).then((r) => { if (live) { setReport(r); setError(null); } }, (e) => { if (live) setError(String(e)); });
    };
    load();
    const t = window.setInterval(load, 30_000);
    return () => { live = false; window.clearInterval(t); };
  }, [open]);
  return { report, error, day };
}
