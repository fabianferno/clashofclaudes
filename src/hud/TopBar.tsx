import { useEffect, useMemo, useState } from 'react';
import { useApp, type Selection } from '../state/store';
import { badgeOf, idleOf, liveAgentSessions, msToNextMidnight, startOfToday, type BadgeState } from './hudState';
import { RES_MARGIN, panelInset } from './layout';
import ResourceBars from './ResourceBars';
import BuilderAvatar from './BuilderAvatar';
import './hud.css';

interface PillDef { id: string; badge: BadgeState; label: string; pulse?: boolean }
const PILLS: PillDef[] = [
  { id: 'building', badge: 'working', label: 'building' },
  { id: 'needs', badge: 'needs', label: 'needs you', pulse: true },
  { id: 'stuck', badge: 'stuck', label: 'stuck' },
  { id: 'finished', badge: 'finished', label: 'ready to review' },
  { id: 'idle', badge: 'idle', label: 'idle' },
];

/** Top-left village level + state pills; bottom-left Settings, top-right the agents' resource and resources. */
export default function TopBar() {
  const builders = useApp((s) => s.builders);
  const sessionMap = useApp((s) => s.sessions);
  const stats = useApp((s) => s.stats);
  const panelOpen = useApp((s) => s.panelOpen);
  const setSelection = useApp((s) => s.setSelection);
  // "Shipped today" must roll over at local midnight even if nothing else re-renders the bar.
  const [day, setDay] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setDay((d) => d + 1), msToNextMidnight() + 50);
    return () => clearTimeout(t);
  }, [day]);

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
      <div id="resources" className="hud-res" style={{ right: panelInset(panelOpen) + RES_MARGIN }}>
        <div className="hud-res-col">
          <ResourceBars />
        </div>
      </div>
      <div id="stats" className="hud-stats" style={{ right: panelInset(panelOpen) }}>
          <div className="hud-resource hud-stat">
            <span className="hud-resource-trough">
              <span className="hud-resource-sub">Builders busy</span>
              <b className="ol">{busy} / {builders.length}</b>
            </span>
            <span className="hud-drop hud-stat-ico hud-stat-builder" aria-hidden="true">
              <BuilderAvatar agent={builders[0]?.agent ?? 'claude'} model={builders[0]?.model ?? null} effort={builders[0]?.effort ?? null} size={34} />
            </span>
          </div>
          <div className="hud-resource hud-stat">
            <span className="hud-resource-trough">
              <span className="hud-resource-sub">Shipped today</span>
              <b className="ol" data-testid="shipped-today">{today}</b>
            </span>
            <img className="hud-drop hud-stat-ico" src="/assets/village/ui/ribbon.png" alt="" aria-hidden="true" />
          </div>
      </div>
      <button className="hud-btn grey hud-gear" aria-label="Settings" title="Settings (⌘,)" data-testid="settings-button"
        onClick={() => useApp.getState().setSettingsOpen(true)}>
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
          <path fill="#fff" stroke="#2b2018" strokeWidth="1.6" strokeLinejoin="round"
            d="M10.3 2h3.4l.5 2.6a7.8 7.8 0 0 1 1.9 1.1l2.5-.9 1.7 2.9-2 1.8a7.8 7.8 0 0 1 0 2.2l2 1.8-1.7 2.9-2.5-.9a7.8 7.8 0 0 1-1.9 1.1l-.5 2.6h-3.4l-.5-2.6a7.8 7.8 0 0 1-1.9-1.1l-2.5.9-1.7-2.9 2-1.8a7.8 7.8 0 0 1 0-2.2l-2-1.8 1.7-2.9 2.5.9a7.8 7.8 0 0 1 1.9-1.1z" />
          <circle cx="12" cy="12" r="3.2" fill="#b8ad97" stroke="#2b2018" strokeWidth="1.6" />
        </svg>
      </button>
    </>
  );
}
