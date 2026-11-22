import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { Builder, HistoryEntry } from '../api/types';
import { idleBuilders, useApp } from '../state/store';
import { sessionName, taskTooltip } from './sessionName';

/** How many past sessions show before "Show all". */
export const HISTORY_SHOWN = 5;

/** "just now", "5 min ago", "3 h ago", "2 d ago", else the date. */
export function ago(at: number, now: number = Date.now()): string {
  const m = Math.floor((now - at) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(at).toLocaleDateString();
}

/**
 * Who carries a past conversation on: its own builder when free, else another free builder of the
 * same agent (a conversation only continues on its own agent). Null when none is free.
 */
export function continuer(e: Pick<HistoryEntry, 'builderId' | 'agent'>, idle: Builder[]): Builder | null {
  return idle.find((b) => b.id === e.builderId) ?? idle.find((b) => b.agent === e.agent) ?? null;
}

/** The workspace's closed agent sessions, newest first, folded until opened; Continue opens one's conversation again. */
export default function HistoryList({ workspaceId, onError }: { workspaceId: string; onError: (e: string | null) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const builders = useApp((s) => s.builders);
  const sessions = useApp((s) => s.sessions);
  const idle = idleBuilders({ builders, sessions });

  useEffect(() => {
    let live = true;
    const load = () => ipc.listHistory().then((l) => { if (live) setEntries(l); }, () => { if (live) setEntries([]); });
    load();
    const off = ipc.onHistoryUpdated(load);
    return () => { live = false; void off.then((f) => f()); };
  }, []);

  const mine = (entries ?? []).filter((e) => e.workspaceId === workspaceId);
  if (mine.length === 0) return null;
  const shown = all ? mine : mine.slice(0, HISTORY_SHOWN);

  const resume = async (e: HistoryEntry, b: Builder) => {
    onError(null);
    setBusy(e.id);
    try {
      const s = await ipc.continueHistory(e.id, b.id);
      const st = useApp.getState();
      st.upsertSession(s);
      st.setSelection({ kind: 'session', id: s.id });
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(null);
    }
  };
  const forget = (e: HistoryEntry) => {
    onError(null);
    setEntries((l) => l && l.filter((x) => x.id !== e.id));
    ipc.forgetHistory(e.id).catch((err) => onError(String(err)));
  };

  return (
    <details className="sp-fold" data-testid="history">
      <summary className="sp-sec">History ({mine.length})</summary>
      {shown.map((e) => {
        const b = continuer(e, idle);
        const own = builders.find((x) => x.id === e.builderId);
        const why = b ? `Carry on this conversation with ${b.name}` : `No free ${e.agent} builder: close or finish one of their sessions first`;
        return (
          <div key={e.id} className="sp-browser-row" data-testid={`history-row-${e.id}`}>
            <div className="sp-row sp-history-row" title={e.lastMessage ?? taskTooltip(e)}>
              <span className="sp-rowtext">
                <span className="sp-t">{sessionName(e) ?? 'Session'}</span>
                <span className="sp-d">{own?.name ?? e.builderName} · {e.steps} steps · closed {ago(e.closedAt)}</span>
              </span>
            </div>
            <button className="hud-btn sm" disabled={!b || busy !== null} title={why}
              onClick={() => b && void resume(e, b)}>{busy === e.id ? '…' : 'Continue'}</button>
            <button className="hud-btn grey sm" aria-label={`Forget ${sessionName(e) ?? 'session'}`}
              title="Remove from the history (the agent's own record of the chat stays)" onClick={() => forget(e)}>✕</button>
          </div>
        );
      })}
      {mine.length > HISTORY_SHOWN && (
        <button className="hud-btn grey sm" onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `Show all ${mine.length}`}</button>
      )}
    </details>
  );
}
