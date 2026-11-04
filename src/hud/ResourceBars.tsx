import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { RESOURCE } from '../village/look';
import { MARK_FILL_RULE, MARK_PATHS } from '../agentMarks';
import { COLLECTOR_NAME, leftNow, primaryWindow, shownCollectors, untilText, windowShort, type CollectorAgent } from '../village/quota';

/** One agent's tank as a bar: how much of its main limit is left, and what the bar says. */
export function resourceBar(q: Parameters<typeof primaryWindow>[0] | undefined, now: number, agent: CollectorAgent): { pct: number | null; value: string; sub: string; title: string } {
  const w = q && primaryWindow(q, now);
  const name = COLLECTOR_NAME[agent];
  // the drop wears the agent's logo, so the bar names only the window; the name stays in the title
  if (!w) return { pct: null, value: '—', sub: '', title: `${name}: no limits read yet` };
  const left = Math.round(leftNow(w, now));
  const short = windowShort(w.windowMins);
  const refill = w.resetsAt !== null && w.resetsAt > now ? `refills in ${untilText(w.resetsAt - now)}` : null;
  return {
    pct: left,
    value: left > 0 ? `${left}%` : 'Empty',
    sub: short ?? '',
    title: `${name}: ${left}% of ${w.label} left${refill ? `, ${refill}` : ''}`,
  };
}

/** The logo's colour on each drop: white on the coloured ones, dark on Codex's pale one. */
const MARK_ON_DROP: Record<CollectorAgent, string> = { claude: '#fff', codex: '#1d130b', antigravity: '#fff' };

/** A resource drop in the agent's colours, with the agent's logo in its bulb. */
function Drop({ agent }: { agent: CollectorAgent }) {
  const c = RESOURCE[agent];
  const id = `drop-${agent}`;
  const mark = MARK_PATHS[agent];
  return (
    <svg className="hud-drop" viewBox="0 0 40 48" aria-hidden="true">
      <defs>
        <radialGradient id={id} cx="38%" cy="58%" r="70%">
          <stop offset="0" stopColor={c.lit} />
          <stop offset=".55" stopColor={c.mid} />
          <stop offset="1" stopColor={c.deep} />
        </radialGradient>
      </defs>
      <path d="M20 3 C20 3 5 20 5 31 a15 15 0 0 0 30 0 C35 20 20 3 20 3z" fill={`url(#${id})`} stroke="#2b2018" strokeWidth="3" strokeLinejoin="round" />
      <ellipse cx="11" cy="24" rx="2.2" ry="4.4" fill="#fff" opacity=".5" transform="rotate(22 11 24)" />
      {mark && (
        // the 24px mark, 17.3px wide, centred on the bulb (centre 20,31)
        <path d={mark} fill={MARK_ON_DROP[agent]} fillRule={MARK_FILL_RULE[agent]} transform="translate(11.36 22.36) scale(.72)"
          data-testid={`drop-mark-${agent}`} />
      )}
    </svg>
  );
}

/** Top right: each rationed agent's limit as a resource bar; a click opens its collector. */
export default function ResourceBars() {
  const quotas = useApp((s) => s.quotas);
  const agents = useApp((s) => s.agents);
  const setSelection = useApp((s) => s.setSelection);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000); // limits refill while nothing changes
    return () => window.clearInterval(t);
  }, []);
  const shown = useMemo(() => shownCollectors(quotas, agents.filter((a) => a.installed).map((a) => a.kind)), [quotas, agents]);

  return (
    <>
      {shown.map((agent) => {
        const b = resourceBar(quotas[agent], now, agent);
        return (
          <button key={agent} type="button" className="hud-resource" data-testid={`resource-${agent}`} title={b.title} aria-label={b.title}
            onClick={() => setSelection({ kind: 'quota', agent })}>
            <span className="hud-resource-trough">
              <i className="hud-resource-fill" style={{ width: `${b.pct ?? 0}%`, background: `linear-gradient(${RESOURCE[agent].lit}, ${RESOURCE[agent].mid} 55%, ${RESOURCE[agent].deep})` }} />
              {b.sub && <span className="hud-resource-sub">{b.sub}</span>}
              <b className="ol">{b.value}</b>
            </span>
            <Drop agent={agent} />
          </button>
        );
      })}
    </>
  );
}
