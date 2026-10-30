import { useEffect, useState } from 'react';
import { ipc } from './api/ipc';
import { idleBuilders, useApp } from './state/store';
import Sidebar from './components/Sidebar';
import SessionPanel from './components/SessionPanel';
import NewSessionForm from './components/NewSessionForm';
import './App.css';

function App() {
  const st = useApp();
  const [formFor, setFormFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [xp, setXp] = useState(false);
  const [quit, setQuit] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      p.then((u) => (cancelled ? u() : unlisten.push(u)), (e) => setError(String(e)));
    keep(ipc.onSessionUpdated((s) => useApp.getState().upsertSession(s)));
    keep(ipc.onSessionRemoved((id) => useApp.getState().removeSession(id)));
    keep(ipc.onConfirmQuit((q) => setQuit(q.live)));
    ipc.listState().then((s) => !cancelled && useApp.getState().hydrate(s)).catch((e) => setError(String(e)));
    ipc.detectAgents().then((a) => !cancelled && useApp.getState().setAgents(a)).catch((e) => setError(String(e)));
    return () => { cancelled = true; unlisten.forEach((u) => u()); };
  }, []);

  useEffect(() => {
    if (!xp) return;
    const t = setTimeout(() => setXp(false), 3000);
    return () => clearTimeout(t);
  }, [xp]);

  const selected = st.selectedSessionId;
  return (
    <div className="layout">
      <Sidebar onNewSession={(id) => { setFormFor(id); st.select(null); }} />
      <main className="main">
        {error && <div className="error">{error}</div>}
        {xp && <div className="notice">+XP earned</div>}
        {selected && st.sessions[selected] ? (
          <SessionPanel sessionId={selected} onClosed={(o) => { if (o.earnedXp) setXp(true); }} />
        ) : formFor ? (
          <NewSessionForm
            key={formFor}
            workspaceId={formFor}
            agents={st.agents}
            builders={idleBuilders(st)}
            onStarted={(s) => { st.upsertSession(s); st.select(s.id); setFormFor(null); }}
          />
        ) : (
          <div className="empty"><h1>Clash of Claudes</h1><p>Open a folder to begin.</p></div>
        )}
      </main>
      {quit !== null && (
        <div className="modal-bg">
          <div className="modal">
            <p>{quit} sessions are still running. Quit and end them?</p>
            <button onClick={() => ipc.quitNow().catch((e) => setError(String(e)))}>Quit</button>{' '}
            <button onClick={() => setQuit(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
