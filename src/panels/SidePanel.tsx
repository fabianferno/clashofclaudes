import { useEffect } from 'react';
import { useApp, type Selection } from '../state/store';
import { CLASS_NAMES, classOf } from '../village/look';
import { PANEL_W } from '../village/camera';
import SessionPanel from '../components/SessionPanel';
import BuilderPanel from './BuilderPanel';
import TownHallPanel from './TownHallPanel';
import WorkspacePanel from './WorkspacePanel';
import '../hud/hud.css';
import './panels.css';

/** The right-hand panel over the village; the selection decides what it shows. */
export default function SidePanel() {
  const selection = useApp((s) => s.selection);
  const workspaces = useApp((s) => s.workspaces);
  const builders = useApp((s) => s.builders);
  const sessions = useApp((s) => s.sessions);
  const setSelection = useApp((s) => s.setSelection);
  const onClosed = useApp((s) => s.onClosed);
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

  if (!selection) return null;
  const head = headOf(selection, { workspaces, builders, sessions });
  if (!head) return null;

  return (
    <aside className="side-panel" style={{ width: PANEL_W }} data-testid="side-panel">
      <header className="sp-head">
        <div className="sp-titles">
          <h2 className="ol">{head.title}</h2>
          <div className="sp-sub" title={head.sub}>{head.sub}</div>
        </div>
        <button className="hud-btn grey sm sp-close" aria-label="Close panel" onClick={() => setSelection(null)}>✕</button>
      </header>
      <div className={`sp-body${selection.kind === 'session' ? ' sp-body-session' : ''}`}>
        {selection.kind === 'hall' && <TownHallPanel />}
        {selection.kind === 'workspace' && <WorkspacePanel key={selection.id} workspaceId={selection.id} />}
        {selection.kind === 'builder' && <BuilderPanel key={selection.id} builderId={selection.id} />}
        {selection.kind === 'session' && sessions[selection.id] && (
          <SessionPanel key={selection.id} sessionId={selection.id} onClosed={(o) => { onClosed(o, selection.id); setSelection(null); }} />
        )}
      </div>
    </aside>
  );
}

function headOf(
  sel: Selection,
  st: Pick<ReturnType<typeof useApp.getState>, 'workspaces' | 'builders' | 'sessions'>,
): { title: string; sub: string } | null {
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
      return { title: s.task ?? (b ? b.name : 'Terminal'), sub: `${w?.name ?? ''} · ${b?.name ?? 'Terminal'}` };
    }
  }
}
