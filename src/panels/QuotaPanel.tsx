import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { AgentAccount, AgentKind, QuotaWindow } from '../api/types';
import { useApp } from '../state/store';
import { RESOURCE } from '../village/look';
import { isCollectorAgent, leftNow, primaryWindow, quotaTone, untilText } from '../village/quota';
import { forecastText, forecastWindow, isLow, reserveOf } from '../state/elixir';

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
  claude: 'Claude Code is asked for its limits every few minutes (Pro and Max plans only; an API key has none). Press Refresh to ask now.',
  codex: 'Codex records its limits with each turn. Run a Codex session and they show here.',
  antigravity: 'Antigravity is asked for its limits every few minutes. Press Refresh to ask now.',
};

/** The signed-in account at the top of the panel: undefined while asking, null when there is none to show. */
function AccountBox({ account }: { account: AgentAccount | null | undefined }) {
  if (account === null) return null;
  const who = account?.email ?? account?.detail;
  const extra = [account?.plan, account?.email ? account.detail : null].filter(Boolean).join(' · ');
  return (
    <div className="sp-box quota-account" data-testid="quota-account">
      <div className="sp-d">{account === undefined ? 'Checking account…' : account.signedIn ? 'Signed in as' : 'Not signed in'}</div>
      {account?.signedIn && who && <div className="sp-t quota-email" title={who}>{who}</div>}
      {account?.signedIn && extra && <div className="sp-d">{extra}</div>}
    </div>
  );
}

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** Every limit an agent reports, shortest window first, grouped by model group. */
export default function QuotaPanel({ agent }: { agent: AgentKind }) {
  const q = useApp((s) => s.quotas[agent]);
  const history = useApp((s) => s.quotaHistory[agent]);
  const settings = useApp((s) => s.settings);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<AgentAccount | null | undefined>(undefined);
  const readAccount = () => ipc.getAccount(agent).then(setAccount, () => setAccount(null)); // no account line beats an error toast
  useEffect(() => {
    setAccount(undefined);
    void readAccount();
  }, [agent]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const refresh = async () => {
    setBusy(true);
    try {
      const [quotas] = await Promise.all([ipc.refreshQuotas(), readAccount()]);
      useApp.getState().setQuotas(quotas);
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
      <AccountBox account={account} />
      {!q && <div className="sp-note" data-testid="quota-empty">{NO_READING[agent] ?? 'This agent reports no limits.'}</div>}
      {[...groups].map(([group, ws]) => (
        <div key={group || 'all'}>
          {group && <div className="sp-sec">{group}</div>}
          {ws.map((w) => {
            const left = leftNow(w, now);
            const refilled = w.resetsAt !== null && w.resetsAt <= now;
            const f = forecastWindow(w, now, history?.[w.id]);
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
                {!refilled && (
                  <div className={`sp-d quota-forecast${f.runsOut ? ' warn' : ''}`} data-testid={`quota-forecast-${w.id}`}>
                    {forecastText(f, now)}{f.perHour ? ` · ${f.perHour < 1 ? f.perHour.toFixed(1) : Math.round(f.perHour)}% an hour` : ''}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {q && isLow(agent, { [agent]: q }, now, settings) && (
        <div className="sp-note quota-held" data-testid="quota-held">
          At or under your {reserveOf(settings)}% reserve: To Dos set to start on their own wait{settings?.elixirStandIn ? ', or go to a builder whose agent has elixir' : ''}. Change it in Settings › Elixir.
        </div>
      )}
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
