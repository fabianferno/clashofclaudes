import { COLLECTOR_AGENTS, COLLECTOR_NAME } from '../village/quota';
import { bindingForecast, clockText } from './elixir';
import { useApp } from './store';

/**
 * Tells the owner once when an agent's elixir will run out before it refills at the rate it is
 * burning (once per window and period: a refill, or a new forecast after it recovered, tells again).
 * Returns an unsubscribe.
 */
export function watchElixir(): () => void {
  const told = new Set<string>();
  const check = () => {
    const st = useApp.getState();
    const now = Date.now();
    for (const agent of COLLECTOR_AGENTS) {
      const f = bindingForecast(st.quotas[agent], now, st.quotaHistory);
      if (!f || f.left <= 0) continue;
      const key = `${agent}:${f.window.id}:${f.window.resetsAt ?? ''}`;
      if (!f.runsOut || f.emptyAt === null) { told.delete(key); continue; }
      if (told.has(key)) continue;
      told.add(key);
      st.notify(`At this rate ${COLLECTOR_NAME[agent]}'s elixir runs out around ${clockText(f.emptyAt, now)}, before its ${f.window.label.toLowerCase()} refills`);
    }
  };
  const unsub = useApp.subscribe((st, prev) => { if (st.quotas !== prev.quotas) check(); });
  return unsub;
}
