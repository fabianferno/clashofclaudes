import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp, type Selection } from '../state/store';
import { badgeOf, idleOf, liveAgentSessions, msToNextMidnight, startOfToday, type BadgeState } from './hudState';
import { RES_MARGIN, STATS_GAP, panelInset, statsPlacement, type StatsPlacement } from './layout';
import ResourceBars from './ResourceBars';
import BuilderAvatar from './BuilderAvatar';
import './hud.css';
import { ownerQueue } from '../state/queue';
import { usePanelWidth } from '../state/panelWidth';
import { keyLabel } from '../panels/commands';
import '../panels/briefing.css';

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
  const panelW = usePanelWidth((s) => s.width); // the panel's edge may be dragged
  const workspaces = useApp((s) => s.workspaces);
  const queued = useMemo(() => ownerQueue({ sessions: sessionMap, workspaces }).length, [sessionMap, workspaces]);
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

  // The stats sit centred between the Village level block and the resource column, or under the
  // resource bars when the window (less the panel) leaves no room for them in between.
  const player = useRef<HTMLDivElement>(null);
  const res = useRef<HTMLDivElement>(null);
  const statsBox = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<StatsPlacement>({ mode: 'center', left: 0, right: panelInset(panelOpen) });
  useLayoutEffect(() => {
    const measure = () => {
      const p = player.current, r = res.current, s = statsBox.current;
      if (!p || !r || !s) return;
      // wherever the stats are now (the band or the column), so a placement never undoes itself
      const stats = [...s.querySelectorAll<HTMLElement>('.hud-stat'), ...r.querySelectorAll<HTMLElement>('.hud-stat')];
      const rowWidth = stats.reduce((w, el) => w + el.offsetWidth, 0) + STATS_GAP * Math.max(0, stats.length - 1);
      // the column as its resource bars make it, without the stats it may hold
      const bars = Array.from(r.querySelectorAll<HTMLElement>('.hud-resource:not(.hud-stat)'));
      const resWidth = bars.length ? Math.max(...bars.map((b) => b.offsetWidth)) : 0;
      // the column's right offset as set (not as measured mid-transition)
      const next = statsPlacement(window.innerWidth, p.getBoundingClientRect().right, panelInset(panelOpen) + RES_MARGIN, resWidth, rowWidth);
      setPlace((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const el of [player.current, res.current]) if (el && ro) ro.observe(el);
    return () => { window.removeEventListener('resize', measure); ro?.disconnect(); };
  }, [panelOpen, panelW]);

  const midnight = startOfToday();
  const today = stats.recentShips.filter((t) => t >= midnight).length;
  const busy = new Set(live.map((s) => (s.kind as { builderId: string }).builderId)).size;
  const statsEls = (
    <>
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
    </>
  );

  return (
    <>
      <div id="topbar" className="hud-topbar">
        <div className="hud-player" ref={player}>
          <div className="hud-shield" data-testid="village-level" title="Village level: sessions shipped">
            <span className="ol-lg">{stats.shippedTotal}</span>
          </div>
          <div className="hud-pbar ol">Village level</div>
        </div>
        <div className="hud-pills">
          {queued > 0 && (
            <button data-testid="pill-queue" className="hud-pill hud-queue ol" title="Take what waits on you, one at a time"
              onClick={() => useApp.getState().takeNext(null)}>
              ▶ {queued} waiting on you<kbd>{keyLabel({ key: 'j' })}</kbd>
            </button>
          )}
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
      <div id="resources" ref={res} className="hud-res" style={{ right: panelInset(panelOpen) + RES_MARGIN }}>
        <div className="hud-res-col">
          <ResourceBars />
          {place.mode === 'column' && statsEls}
        </div>
      </div>
      <div id="stats" ref={statsBox} className={`hud-stats${place.mode === 'column' ? ' hud-stats-off' : ''}`} data-placement={place.mode}
        style={place.mode === 'center' ? { left: place.left, right: place.right } : undefined}>
        {place.mode === 'center' && statsEls}
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
