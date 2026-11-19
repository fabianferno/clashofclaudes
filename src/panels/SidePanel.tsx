import { useEffect } from 'react';
import { useApp, type Selection } from '../state/store';
import { CLASS_NAMES, PALETTE, classOf } from '../village/look';
import { usePanelWidth } from '../state/panelWidth';
import { usePanelZoom } from '../state/panelZoom';
import { zoomKey } from '../village/zoomKey';
import PanelResizer from './PanelResizer';
import SessionPanel from './SessionPanel';
import BuilderPanel from './BuilderPanel';
import TownHallPanel from './TownHallPanel';
import WorkspacePanel from './WorkspacePanel';
import QuotaPanel from './QuotaPanel';
import '../hud/hud.css';
import './panels.css';
import { sessionName, taskTooltip } from './sessionName';

/** The right-hand panel over the village; the selection decides what it shows. */
export default function SidePanel() {
  const selection = useApp((s) => s.selection);
  const workspaces = useApp((s) => s.workspaces);
  const builders = useApp((s) => s.builders);
  const sessions = useApp((s) => s.sessions);
  const setSelection = useApp((s) => s.setSelection);
  const onClosed = useApp((s) => s.onClosed);
  const width = usePanelWidth((s) => s.width);
  const zoom = usePanelZoom((s) => s.zoom);
  const open = selection !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc belongs to the terminal (and to text areas) while one has focus
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.xterm, textarea')) return;
      useApp.getState().setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // ⌘+ / ⌘- / ⌘0 (and a trackpad pinch) size the panel's text while the pointer is over it or
  // something in it has focus. The terminal keeps its own text size (its handler runs first).
  useEffect(() => {
    if (!open) return;
    const panel = () => document.querySelector<HTMLElement>('[data-testid="side-panel"]');
    const onKey = (e: KeyboardEvent) => {
      const z = zoomKey(e);
      const el = panel();
      if (!z || !el || useApp.getState().covers > 0) return;
      const focused = el.contains(document.activeElement) && document.activeElement !== document.body;
      if (!focused && !el.matches(':hover')) return;
      if ((document.activeElement as HTMLElement | null)?.closest?.('.xterm')) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // not the village's zoom too
      usePanelZoom.getState().step(z);
    };
    // A pinch arrives as a ctrl-wheel; step once per notch's worth of travel.
    let pinch = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || useApp.getState().covers > 0) return;
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('[data-testid="side-panel"]') || t.closest('.xterm')) return;
      e.preventDefault();
      pinch += e.deltaY;
      while (Math.abs(pinch) >= 40) {
        usePanelZoom.getState().step(pinch < 0 ? 'in' : 'out');
        pinch -= Math.sign(pinch) * 40;
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onWheel);
    };
  }, [open]);

  if (!selection) return null;
  const head = headOf(selection, { workspaces, builders, sessions });
  if (!head) return null;

  return (
    <aside className="side-panel" style={{ width, ['--sp-zoom' as string]: zoom }} data-testid="side-panel">
      <PanelResizer />
      <header className="sp-head">
        <div className="sp-titles">
          <h2 className="ol" title={head.full}>{head.title}</h2>
          <div className="sp-sub" title={head.sub}>{head.sub}</div>
        </div>
        <button className="hud-btn grey sm sp-close" aria-label="Close panel" onClick={() => setSelection(null)}>✕</button>
      </header>
      <div className={`sp-body${selection.kind === 'session' ? ' sp-body-session' : ''}`}>
        {selection.kind === 'hall' && <TownHallPanel />}
        {selection.kind === 'workspace' && <WorkspacePanel key={selection.id} workspaceId={selection.id} />}
        {selection.kind === 'builder' && <BuilderPanel key={selection.id} builderId={selection.id} />}
        {selection.kind === 'quota' && <QuotaPanel key={selection.agent} agent={selection.agent} />}
        {selection.kind === 'session' && sessions[selection.id] && (
          // Unkeyed: the panel and its terminal stay mounted across session switches.
          <SessionPanel sessionId={selection.id} onClosed={(o, id) => {
            onClosed(o, id);
            // Only deselect the closed session: the user may have switched to another meanwhile.
            const sel = useApp.getState().selection;
            if (sel?.kind === 'session' && sel.id === id) setSelection(null);
          }} />
        )}
      </div>
    </aside>
  );
}

function headOf(
  sel: Selection,
  st: Pick<ReturnType<typeof useApp.getState>, 'workspaces' | 'builders' | 'sessions'>,
): { title: string; sub: string; full?: string } | null {
  switch (sel.kind) {
    case 'hall': return { title: 'Town Hall', sub: 'all workspaces' };
    case 'workspace': {
      const w = st.workspaces.find((x) => x.id === sel.id);
      return w ? { title: w.name, sub: w.path } : null;
    }
    case 'builder': {
      const b = st.builders.find((x) => x.id === sel.id);
      return b ? { title: b.name, sub: `${CLASS_NAMES[classOf(b.agent, b.model)]} · ${b.agent}` } : null;
    }
    case 'session': {
      const s = st.sessions[sel.id];
      if (!s) return null;
      const w = st.workspaces.find((x) => x.id === s.workspaceId);
      const b = s.kind.kind === 'agent' ? st.builders.find((x) => x.id === (s.kind as { builderId: string }).builderId) : undefined;
      return { title: sessionName(s) ?? (b ? b.name : 'Terminal'), sub: `${w?.name ?? ''} · ${b?.name ?? 'Terminal'}`, full: taskTooltip(s) };
    }
    case 'quota': return { title: 'Resources', sub: `${PALETTE[sel.agent].label} limits` };
  }
}
