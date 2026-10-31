import { useRef, useState, type WheelEvent } from 'react';
import { useApp } from '../state/store';
import { CLASS_NAMES, PALETTE, classOf, gearOf, stars } from '../village/look';
import { panelInset, rosterReserve } from './layout';
import { BADGE_LABEL, badgeOf, builderTarget, liveSessionOf } from './hudState';
import './hud.css';

/** Bottom, collapsible, sideways-scrolling roster of builder cards. */
export default function BuildersBar() {
  const builders = useApp((s) => s.builders);
  const sessions = useApp((s) => s.sessions);
  const selection = useApp((s) => s.selection);
  const panelOpen = useApp((s) => s.panelOpen);
  const setSelection = useApp((s) => s.setSelection);
  const [collapsed, setCollapsed] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const all = Object.values(sessions);

  // vertical wheel scrolls the roster sideways
  const onWheel = (e: WheelEvent) => {
    if (list.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) list.current.scrollLeft += e.deltaY;
  };

  return (
    <div className="hud-roster-zone" style={{ right: panelInset(panelOpen), paddingRight: rosterReserve(panelOpen) }}>
      <div data-testid="builders-bar" className={`hud-roster${collapsed ? ' collapsed' : ''}`}>
        <button className="hud-btn grey sm hud-tab" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '▴' : '▾'} Builders
        </button>
        <div ref={list} data-testid="builders-list" className="hud-cards" onWheel={onWheel}>
          {builders.map((b) => {
            const pal = PALETTE[b.agent];
            const tier = classOf(b.agent, b.model);
            const live = liveSessionOf(b.id, all);
            const badge = badgeOf(live);
            const sel = (selection?.kind === 'builder' && selection.id === b.id)
              || (!!live && selection?.kind === 'session' && selection.id === live.id);
            return (
              <button
                key={b.id}
                data-testid={`builder-card-${b.id}`}
                className={`hud-card${sel ? ' selected' : ''}`}
                onClick={() => setSelection(builderTarget(b.id, all))}
                title={live ? `Open ${b.name}'s session` : undefined}
              >
                <span className="hud-av ol-lg" style={{ background: pal.body }}>{b.name.charAt(0).toUpperCase()}</span>
                <span className="hud-cname ol">{b.name}</span>
                <span className="hud-class">{CLASS_NAMES[tier]}</span>
                <span className="hud-stars">{'★'.repeat(stars(gearOf(b.effort)))}</span>
                <span
                  className="hud-badge ol"
                  data-testid={`badge-${b.id}`}
                  data-state={badge}
                  style={{ background: `var(--hud-${badge})` }}
                >
                  {BADGE_LABEL[badge]}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
