import { useEffect, useState } from 'react';
import { ipc } from './api/ipc';
import { autoLayout, useApp } from './state/store';
import VillageCanvas from './village/VillageCanvas';
import TopBar from './hud/TopBar';
import BuildersBar from './hud/BuildersBar';
import BuildButtons from './hud/BuildButtons';
import SidePanel from './panels/SidePanel';
import './App.css';

function App() {
  // Narrow selectors: App must not re-render on every session update (only these two fields matter here).
  const error = useApp((s) => s.error);
  const notices = useApp((s) => s.notices);
  const setError = useApp((s) => s.setError);
  const [quit, setQuit] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      p.then((u) => (cancelled ? u() : unlisten.push(u)), (e) => useApp.getState().setError(String(e)));
    keep(ipc.onSessionUpdated((s) => useApp.getState().upsertSession(s)));
    keep(ipc.onSessionRemoved((id) => useApp.getState().removeSession(id)));
    keep(ipc.onWorkspaceUpdated((w) => useApp.getState().updateWorkspace(w)));
    keep(ipc.onStatsUpdated((s) => useApp.getState().setStats(s)));
    keep(ipc.onSelectSession((id) => {
      if (useApp.getState().sessions[id]) useApp.getState().setSelection({ kind: 'session', id });
    }));
    keep(ipc.onConfirmQuit((q) => setQuit(q.live)));
    let stopLayout: (() => void) | null = null;
    ipc.listState()
      .then((s) => {
        if (cancelled) return;
        useApp.getState().hydrate(s);
        // Compounds for workspaces without one, spots for agent sessions without one (never terminals).
        stopLayout = autoLayout((e) => useApp.getState().setError(String(e)));
      })
      .catch((e) => useApp.getState().setError(String(e)));
    ipc.detectAgents().then((a) => !cancelled && useApp.getState().setAgents(a)).catch((e) => useApp.getState().setError(String(e)));
    return () => { cancelled = true; stopLayout?.(); unlisten.forEach((u) => u()); };
  }, []);

  return (
    <>
    <VillageCanvas onError={(e) => useApp.getState().setError(String(e))} />
    <TopBar />
    <BuildersBar />
    <BuildButtons />
    <SidePanel />
    <div className="toasts">
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
      {notices.map((n) => <div key={n.id} className={`notice notice-${n.kind}`}>{n.text}</div>)}
    </div>
      {quit !== null && (
        <div className="modal-bg">
          <div className="modal">
            <p>{quit} sessions are still running. Quit and end them?</p>
            <button onClick={() => ipc.quitNow().catch((e) => useApp.getState().setError(String(e)))}>Quit</button>{' '}
            <button onClick={() => setQuit(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
