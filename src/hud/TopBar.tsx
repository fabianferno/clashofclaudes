import { useMemo } from 'react';
import { useApp, type Selection } from '../state/store';
import { badgeOf, idleOf, liveAgentSessions, startOfToday, type BadgeState } from './hudState';
import './hud.css';

interface PillDef { id: string; badge: BadgeState; label: string; pulse?: boolean }
const PILLS: PillDef[] = [
  { id: 'building', badge: 'working', label: 'building' },
  { id: 'needs', badge: 'needs', label: 'needs you', pulse: true },
  { id: 'stuck', badge: 'stuck', label: 'stuck' },
  { id: 'finished', badge: 'finished', label: 'ready to review' },
  { id: 'idle', badge: 'idle', label: 'idle' },
];

/** Top-left village level + state pills; top-right resources. */
export default function TopBar() {
  const builders = useApp((s) => s.builders);
  const sessionMap = useApp((s) => s.sessions);
  const stats = useApp((s) => s.stats);
  const setSelection = useApp((s) => s.setSelection);

  const { live, byState } = useMemo(() => {
    const live = liveAgentSessions(Object.values(sessionMap)).sort((a, b) => a.startedAt - b.startedAt);
    const idle = idleOf(builders, Object.values(sessionMap));
    const byState: Record<BadgeState, Selection[]> = { working: [], needs: [], stuck: [], finished: [], idle: [] };
    for (const s of live) byState[badgeOf(s)].push({ kind: 'session', id: s.id });
    for (const b of idle) byState.idle.push({ kind: 'builder', id: b.id });
    return { live, byState };
  }, [builders, sessionMap]);

  const midnight = startOfToday();
  const today = stats.recentShips.filter((t) => t >= midnight).length;
  const busy = new Set(live.map((s) => (s.kind as { builderId: string }).builderId)).size;

  return (
    <>
      <div id="topbar" className="hud-topbar">
        <div className="hud-player">
          <div className="hud-shield" data-testid="village-level" title="Village level: sessions shipped">
            <span className="ol-lg">{stats.shippedTotal}</span>
          </div>
          <div className="hud-pbar ol">Village level</div>
        </div>
        <div className="hud-pills">
          {PILLS.map((p) => {
            const items = byState[p.badge];
            if (items.length === 0) return null;
            return (
              <button
                key={p.id}
                data-testid={`pill-${p.id}`}
                className={`hud-pill ol${p.pulse ? ' pulse' : ''}`}
                onClick={() => setSelection(items[0])}
              >
                <i className="hud-dot" style={{ background: `var(--hud-${p.badge})` }} />
                {items.length} {p.label}
              </button>
            );
          })}
        </div>
      </div>
      <div id="resources" className="hud-res">
        <div className="hud-rbar ol">
          <span>Builders busy</span>
          <b>{busy} / {builders.length}</b>
        </div>
        <div className="hud-rbar ol">
          <span>Shipped today</span>
          <b data-testid="shipped-today">{today}</b>
        </div>
      </div>
    </>
  );
}
