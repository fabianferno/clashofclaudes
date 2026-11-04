import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { AgentKind, QuotaWindow } from '../api/types';
import { useApp } from '../state/store';
import { RESOURCE } from '../village/look';
import { isCollectorAgent, leftNow, primaryWindow, quotaTone, untilText } from '../village/quota';

const resourceBar = (a: keyof typeof RESOURCE) => `linear-gradient(${RESOURCE[a].lit}, ${RESOURCE[a].label})`;
const BAR: Record<ReturnType<typeof quotaTone>, string> = {
  'resource-claude': resourceBar('claude'),
  'resource-codex': resourceBar('codex'),
  'resource-antigravity': resourceBar('antigravity'),
  working: 'linear-gradient(#ffd27a, #f5a623)',
  needs: 'linear-gradient(#ff8a7e, #ff4b3e)',
  stuck: 'linear-gradient(#cfcfcf, #8e8e8e)',
};

/** Where a collector's numbers come from when it has none yet. */
const NO_READING: Partial<Record<AgentKind, string>> = {
  claude: 'Claude reports its limits to sessions started from the village (Pro and Max plans only). Start one and the tank fills in.',
  codex: 'Codex records its limits with each turn. Run a Codex session and they show here.',
  antigravity: 'Antigravity is asked for its limits every few minutes. Press Refresh to ask now.',
};

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** Every limit an agent reports, shortest window first, grouped by model group. */
export default function QuotaPanel({ agent }: { agent: AgentKind }) {
  const q = useApp((s) => s.quotas[agent]);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const refresh = async () => {
    setBusy(true);
    try {
      useApp.getState().setQuotas(await ipc.refreshQuotas());
      setNow(Date.now());
    } catch (e) {
      useApp.getState().setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const primary = q ? primaryWindow(q, now) : null;
  const groups = new Map<string, QuotaWindow[]>();
  for (const w of [...(q?.windows ?? [])].sort((a, b) => (a.windowMins ?? Infinity) - (b.windowMins ?? Infinity))) {
    const k = w.group ?? '';
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }

  return (
    <>
      {!q && <div className="sp-note" data-testid="quota-empty">{NO_READING[agent] ?? 'This agent reports no limits.'}</div>}
      {[...groups].map(([group, ws]) => (
        <div key={group || 'all'}>
          {group && <div className="sp-sec">{group}</div>}
          {ws.map((w) => {
            const left = leftNow(w, now);
            const refilled = w.resetsAt !== null && w.resetsAt <= now;
            return (
              <div key={w.id} className="sp-box quota-row" data-testid={`quota-${w.id}`}>
                <div className="quota-head">
                  <span className="sp-t">{w.label}{w.id === primary?.id && <span className="quota-tank"> · tank</span>}</span>
                  <span className="sp-t">{Math.round(left)}% left</span>
                </div>
                <div className="sp-xp"><i style={{ width: `${left}%`, background: BAR[isCollectorAgent(agent) ? quotaTone(left, agent) : 'stuck'] }} /></div>
                <div className="sp-d quota-reset">
                  {refilled ? 'Refilled' : w.resetsAt !== null ? `Refills in ${untilText(w.resetsAt - now)} · ${fmtTime(w.resetsAt)}` : 'No reset time reported'}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {q && (
        <div className="sp-note" data-testid="quota-asof">
          Read {untilText(now - q.updatedAt)} ago from {q.source}.
        </div>
      )}
      <div className="sp-btns">
        <button className="hud-btn sm" disabled={busy} onClick={() => void refresh()}>{busy ? 'Reading…' : 'Refresh'}</button>
      </div>
    </>
  );
}
