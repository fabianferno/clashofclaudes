import { useEffect, useState } from 'react';
import { ipc } from './api/ipc';
import { autoLayout, useApp } from './state/store';
import VillageCanvas from './village/VillageCanvas';
import TopBar from './hud/TopBar';
import BuildersBar from './hud/BuildersBar';
import BuildButtons from './hud/BuildButtons';
import WelcomeCard from './panels/WelcomeCard';
import UpdateToast from './hud/UpdateToast';
import SidePanel from './panels/SidePanel';
import PopOutApp from './panels/PopOutApp';
import { preloadTerminal } from './components/LazyTerminalView';
import './App.css';

function App() {
  // Narrow selectors: App must not re-render on every session update (only these two fields matter here).
  const error = useApp((s) => s.error);
  const notices = useApp((s) => s.notices);
  const setError = useApp((s) => s.setError);
  const [quit, setQuit] = useState<{ live: number; restart: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      p.then((u) => (cancelled ? u() : unlisten.push(u)), (e) => useApp.getState().setError(String(e)));
    keep(ipc.onSessionUpdated((s) => useApp.getState().upsertSession(s)));
    keep(ipc.onSessionRemoved((id) => useApp.getState().removeSession(id)));
    keep(ipc.onWorkspaceUpdated((w) => useApp.getState().updateWorkspace(w)));
    keep(ipc.onStatsUpdated((s) => useApp.getState().setStats(s)));
    keep(ipc.onQuotaUpdated((q) => useApp.getState().setQuota(q)));
    keep(ipc.onAppsUpdated((a) => useApp.getState().setApps(a)));
    keep(ipc.onSelectSession((id) => {
      if (useApp.getState().sessions[id]) useApp.getState().setSelection({ kind: 'session', id });
    }));
    keep(ipc.onConfirmQuit((q) => setQuit({ live: q.live, restart: !!q.restart })));
    let stopLayout: (() => void) | null = null;
    ipc.listState()
      .then((s) => {
        if (cancelled) return;
        useApp.getState().hydrate(s);
        // Compounds for workspaces without one, spots for sessions without one.
        stopLayout = autoLayout((e) => useApp.getState().setError(String(e)));
      })
      .catch((e) => {
        if (cancelled) return;
        useApp.getState().markLoaded(); // the welcome card must not stay hidden forever
        useApp.getState().setError(String(e));
        // Workspaces added from here on still need compounds and spots.
        stopLayout = autoLayout((err) => useApp.getState().setError(String(err)));
      });
    ipc.getQuotas().then((q) => !cancelled && useApp.getState().setQuotas(q)).catch(() => {}); // collectors just stay unread
    ipc.getApps().then((a) => !cancelled && useApp.getState().setApps(a)).catch(() => {}); // boards come with the next scan
    ipc.detectAgents().then((a) => !cancelled && useApp.getState().setAgents(a)).catch((e) => useApp.getState().setError(String(e)));
    const preload = window.setTimeout(preloadTerminal, 2000); // after the village's first frames
    return () => { cancelled = true; window.clearTimeout(preload); stopLayout?.(); unlisten.forEach((u) => u()); };
  }, []);

  return (
    <>
    <VillageCanvas onError={(e) => useApp.getState().setError(String(e))} />
    <TopBar />
    <BuildersBar />
    <BuildButtons />
    <WelcomeCard />
    <SidePanel />
    <PopOutApp />
    <UpdateToast />
    <div className="toasts">
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
      {notices.map((n) => <div key={n.id} className={`notice notice-${n.kind}`}>{n.text}</div>)}
    </div>
      {quit !== null && (
        <div className="modal-bg">
          <div className="modal">
            <p>{quit.live} sessions are still running. {quit.restart ? 'Restart and end them?' : 'Quit and end them?'}</p>
            <button onClick={() => ipc.quitNow(quit.restart).catch((e) => useApp.getState().setError(String(e)))}>{quit.restart ? 'Restart' : 'Quit'}</button>{' '}
            <button onClick={() => setQuit(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
