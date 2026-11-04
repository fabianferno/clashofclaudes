import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { ELIXIR } from '../village/look';
import { COLLECTOR_NAME, leftNow, primaryWindow, shownCollectors, untilText, windowShort, type CollectorAgent } from '../village/quota';

/** One agent's tank as a bar: how much of its main limit is left, and what the bar says. */
export function elixirBar(q: Parameters<typeof primaryWindow>[0] | undefined, now: number, agent: CollectorAgent): { pct: number | null; value: string; sub: string; title: string } {
  const w = q && primaryWindow(q, now);
  const name = COLLECTOR_NAME[agent];
  if (!w) return { pct: null, value: '—', sub: name, title: `${name}: no limits read yet` };
  const left = Math.round(leftNow(w, now));
  const short = windowShort(w.windowMins);
  const refill = w.resetsAt !== null && w.resetsAt > now ? `refills in ${untilText(w.resetsAt - now)}` : null;
  return {
    pct: left,
    value: left > 0 ? `${left}%` : 'Empty',
    sub: short ? `${name} · ${short}` : name,
    title: `${name}: ${left}% of ${w.label} left${refill ? `, ${refill}` : ''}`,
  };
}

/** An elixir drop in the agent's colours. */
function Drop({ agent }: { agent: CollectorAgent }) {
  const c = ELIXIR[agent];
  const id = `drop-${agent}`;
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
      <ellipse cx="13.5" cy="29" rx="3.2" ry="6.5" fill="#fff" opacity=".55" transform="rotate(18 13.5 29)" />
    </svg>
  );
}

/** Top right, Clash style: each rationed agent's limit as a resource bar; a click opens its collector. */
export default function ElixirBars() {
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
        const b = elixirBar(quotas[agent], now, agent);
        return (
          <button key={agent} type="button" className="hud-elixir" data-testid={`elixir-${agent}`} title={b.title} aria-label={b.title}
            onClick={() => setSelection({ kind: 'quota', agent })}>
            <span className="hud-elixir-trough">
              <i className="hud-elixir-fill" style={{ width: `${b.pct ?? 0}%`, background: `linear-gradient(${ELIXIR[agent].lit}, ${ELIXIR[agent].mid} 55%, ${ELIXIR[agent].deep})` }} />
              <span className="hud-elixir-sub">{b.sub}</span>
              <b className="ol">{b.value}</b>
            </span>
            <Drop agent={agent} />
          </button>
        );
      })}
    </>
  );
}
