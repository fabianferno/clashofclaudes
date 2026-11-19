import { ipc } from '../api/ipc';
import { useApp } from './store';

/**
 * Keeps the store in step with the backend: listens for its updates, then loads what it holds.
 * Both windows use it (the village's and the mini village's), each for its own store; anything
 * that *acts* on the state (auto-started To Dos, layout, sounds) belongs to the main window alone.
 *
 * `loaded` settles once the saved state is in the store (rejects when it could not be read; the
 * store is then marked loaded and `onError` told). After `stop()` nothing more reaches the store.
 */
export function subscribeState(onError: (e: unknown) => void): { stop: () => void; loaded: Promise<void> } {
  let stopped = false;
  const unlisten: Array<() => void> = [];
  const keep = (p: Promise<() => void>) => p.then((u) => (stopped ? u() : unlisten.push(u)), onError);
  keep(ipc.onSessionUpdated((s) => useApp.getState().upsertSession(s)));
  keep(ipc.onSessionRemoved((id) => useApp.getState().removeSession(id)));
  keep(ipc.onWorkspaceUpdated((w) => useApp.getState().updateWorkspace(w)));
  keep(ipc.onStatsUpdated((s) => useApp.getState().setStats(s)));
  keep(ipc.onQuotaUpdated((q) => useApp.getState().setQuota(q)));
  keep(ipc.onAppsUpdated((a) => useApp.getState().setApps(a)));
  const loaded = ipc.listState().then(
    (s) => { if (!stopped) useApp.getState().hydrate(s); },
    (e) => {
      if (!stopped) {
        useApp.getState().markLoaded(); // the welcome card must not stay hidden forever
        onError(e);
      }
      throw e;
    },
  );
  ipc.getQuotas().then((q) => !stopped && useApp.getState().setQuotas(q)).catch(() => {}); // collectors just stay unread
  ipc.getApps().then((a) => !stopped && useApp.getState().setApps(a)).catch(() => {}); // boards come with the next scan
  ipc.detectAgents().then((a) => !stopped && useApp.getState().setAgents(a)).catch(onError);
  return { stop: () => { stopped = true; unlisten.forEach((u) => u()); }, loaded };
}
