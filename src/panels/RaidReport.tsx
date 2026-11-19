import { useEffect, useRef, useState } from 'react';
import { ipc } from '../api/ipc';
import type { RaidReport as Report } from '../api/types';
import { useApp } from '../state/store';
import { durationText, useTodayReport } from '../state/raid';
import { PALETTE } from '../village/look';
import { withTimerFrames } from '../screenshot';
import './raid.css';

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const longDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
};

/** The totals the card leads with. */
export function totals(r: Report): { shipped: number; added: number; removed: number } {
  return { shipped: r.ships.length, added: r.ships.reduce((n, s) => n + s.added, 0), removed: r.ships.reduce((n, s) => n + s.removed, 0) };
}

/** The day's raid report, as a card over the village. Export saves it as a PNG in Downloads; Esc closes it. */
export default function RaidReport() {
  const open = useApp((s) => s.raidOpen);
  const workspaces = useApp((s) => s.workspaces);
  const { report, error, day } = useTodayReport(open);
  const card = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const close = () => { setSaveError(null); useApp.getState().setRaidOpen(false); };

  useEffect(() => {
    if (!open) return;
    const release = useApp.getState().cover(); // the village stops drawing under it
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); release(); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const t = report ? totals(report) : null;
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? 'a removed workspace';

  const exportPng = async () => {
    if (!card.current) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { toPng } = await import('html-to-image');
      const node = card.current;
      const url = await withTimerFrames(() => toPng(node, { pixelRatio: 2 }));
      const path = await ipc.saveRaidCard(url.slice(url.indexOf(',') + 1), day);
      useApp.getState().notify(`Saved to Downloads: ${path.slice(path.lastIndexOf('/') + 1)}`);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-bg raid-bg" onClick={close}>
      <div className="raid-wrap" onClick={(e) => e.stopPropagation()}>
        <div className="raid-card" ref={card} role="dialog" aria-modal="true" aria-labelledby="raid-title" data-testid="raid-card">
          <header className="raid-head">
            <h2 id="raid-title" className="ol-lg">Raid report</h2>
            <span className="raid-day">{longDay(day)}</span>
          </header>
          {error ? <div className="panel-warn">{error}</div> : !report || !t ? <div className="raid-empty">Counting the loot…</div> : (
            <>
              <div className="raid-stats">
                <div className="raid-stat raid-shipped">
                  <span className="raid-num ol-lg">{t.shipped}</span>
                  <span className="raid-label">{t.shipped === 1 ? 'task shipped' : 'tasks shipped'}</span>
                </div>
                <div className="raid-stat raid-lines">
                  <span className="raid-num ol-lg"><b className="raid-plus">+{t.added}</b> <b className="raid-minus">−{t.removed}</b></span>
                  <span className="raid-label">lines changed</span>
                </div>
                <div className="raid-stat raid-waited">
                  <span className="raid-num ol-lg">{durationText(report.waitedMs)}</span>
                  <span className="raid-label">builders waited on you{report.waitingNow ? ` · ${report.waitingNow} still waiting` : ''}</span>
                </div>
              </div>
              <div className="raid-sec">What shipped</div>
              {report.ships.length === 0
                ? <div className="raid-empty">Nothing accepted yet today. Accept a finished session to ship it.</div>
                : (
                  <ul className="raid-list">
                    {report.ships.map((s, i) => (
                      <li key={i}>
                        <i className="raid-dot" style={{ background: PALETTE[s.agent]?.body ?? '#888' }} />
                        <span className="raid-what">
                          <span className="raid-title">{s.title ?? 'Untitled task'}</span>
                          <span className="raid-meta">{s.builderName} · {wsName(s.workspaceId)} · {time(s.at)}</span>
                        </span>
                        <span className="raid-diff"><b className="raid-plus">+{s.added}</b> <b className="raid-minus">−{s.removed}</b></span>
                      </li>
                    ))}
                  </ul>
                )}
            </>
          )}
          <footer className="raid-brand">Clash of Claudes</footer>
        </div>
        {saveError && <div className="panel-warn">{saveError}</div>}
        <div className="raid-actions">
          <button className="hud-btn blue sm" disabled={!report || saving} onClick={() => void exportPng()}>{saving ? 'Saving…' : 'Export PNG'}</button>
          <button className="hud-btn grey sm" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
