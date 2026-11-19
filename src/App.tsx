import { useEffect, useState } from 'react';
import { ipc } from './api/ipc';
import { autoLayout, useApp } from './state/store';
import { autoSnapshots } from './state/snapshots';
import { autoStart } from './state/autoStart';
import { subscribeState } from './state/hydrate';
import { watchSounds } from './state/sounds';
import { watchElixir } from './state/elixirWatch';
import { queueReason } from './state/queue';
import VillageCanvas from './village/VillageCanvas';
import TopBar from './hud/TopBar';
import BuildersBar from './hud/BuildersBar';
import BuildButtons from './hud/BuildButtons';
import WelcomeCard from './panels/WelcomeCard';
import UpdateToast from './hud/UpdateToast';
import SidePanel from './panels/SidePanel';
import PopOutApp from './panels/PopOutApp';
import Kanban from './panels/Kanban';
import SettingsPage from './panels/SettingsPage';
import BugReportDialog, { openBugReport } from './panels/BugReport';
import CommandPalette from './panels/CommandPalette';
import { preloadTerminal } from './components/LazyTerminalView';
import GameCursor from './components/GameCursor';
import TourOverlay from './onboarding/TourOverlay';
import { startTour } from './onboarding/tour';
import { loadSettings, tidyOnce } from './state/settings';
import { splashReady } from './splash';
import './App.css';

function App() {
  // Narrow selectors: App must not re-render on every session update (only these two fields matter here).
  const error = useApp((s) => s.error);
  const notices = useApp((s) => s.notices);
  const setError = useApp((s) => s.setError);
  const [quit, setQuit] = useState<{ live: number; restart: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const onError = (e: unknown) => useApp.getState().setError(String(e));
    const unlisten: Array<() => void> = [];
    const keep = (p: Promise<() => void>) => p.then((u) => (cancelled ? u() : unlisten.push(u)), onError);
    // the backend's updates into the store, then what it holds (shared with the mini village)
    const sub = subscribeState(onError);
    keep(ipc.onSelectSession((id) => {
      // a notification of something waiting on the owner opens it as their queue's item: dealt with, the next comes up
      const s = useApp.getState().sessions[id];
      if (s) useApp.getState().setSelection({ kind: 'session', id, ...(queueReason(s) ? { queue: true } : {}) });
    }));
    keep(ipc.onConfirmQuit((q) => setQuit({ live: q.live, restart: !!q.restart })));
    keep(ipc.onOpenSettings(() => useApp.getState().setSettingsOpen(true)));
    keep(ipc.onOpenBugReport((kind) => void openBugReport(kind)));
    let stopLayout: (() => void) | null = null;
    // To Dos set to start on their own start once their builder is free (waits for the first state)
    const stopAuto = autoStart(onError);
    // the village's sounds, and a heads-up when an agent's elixir won't last until it refills
    const stopSounds = watchSounds();
    const stopElixir = watchElixir();
    const settings = loadSettings();
    sub.loaded.then(
      () => {
        if (cancelled) return;
        splashReady('state');
        // Compounds for workspaces without one, spots for sessions without one.
        stopLayout = autoLayout(onError);
        settings.then((st) => { if (!cancelled) return tidyOnce(st).catch(onError); }, () => {});
      },
      () => {
        if (cancelled) return;
        splashReady('state');
        // Workspaces added from here on still need compounds and spots.
        stopLayout = autoLayout(onError);
      },
    );
    // the welcome (and its tour) until the owner has been through it once; Settings can replay it
    settings.then((s) => { if (!cancelled && !s.onboarded) startTour(); }).catch(() => {});
    const preload = window.setTimeout(preloadTerminal, 2000); // after the village's first frames
    const stopSnapshots = autoSnapshots();
    return () => { cancelled = true; window.clearTimeout(preload); stopLayout?.(); stopAuto(); stopSounds(); stopElixir(); stopSnapshots(); unlisten.forEach((u) => u()); sub.stop(); };
  }, []);

  return (
    <>
    <VillageCanvas onError={(e) => useApp.getState().setError(String(e))} />
    <TopBar />
    <BuildersBar />
    <BuildButtons />
    <WelcomeCard />
    <SidePanel />
    <Kanban />
    <PopOutApp />
    <SettingsPage />
    <BugReportDialog />
    <TourOverlay />
    <UpdateToast />
    <CommandPalette />
    <div className="toasts">
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
      {notices.map((n) => <div key={n.id} className={`notice notice-${n.kind}`}>{n.text}</div>)}
    </div>
      {quit !== null && (
        <div className="modal-bg">
          <div className="modal">
            <p>{quit.live} sessions are still running. {quit.restart ? 'Restart now?' : 'Quit now?'} They stop, and pick up again next time the app opens.</p>
            <button onClick={() => ipc.quitNow(quit.restart).catch((e) => useApp.getState().setError(String(e)))}>{quit.restart ? 'Restart' : 'Quit'}</button>{' '}
            <button onClick={() => setQuit(null)}>Cancel</button>
          </div>
        </div>
      )}
    {/* last, above every overlay (Kanban, Settings, the palette, pop-outs) */}
    <GameCursor />
    </>
  );
}

export default App;
