import { ipc } from '../api/ipc';
import { COLLECTOR_NAME, isCollectorAgent } from '../village/quota';
import { autoStartable, type StartPick } from './queue';
import { useApp, type AppState } from './store';

/**
 * Starts the To Dos set to start on their own as soon as they can (their builder free, the
 * running-session limit leaving room), so the To Do drains without the owner. Each one becomes a
 * session (in its own worktree when asked) and leaves the To Do. A start that fails turns that
 * To Do's auto start off, so it is not retried in a loop. A To Do whose agent is low on elixir
 * waits (or goes to a stand-in, see `autoStartable`); limits refill on the clock, so it also looks
 * again every minute. Returns an unsubscribe.
 */
export function autoStart(onError: (e: unknown) => void = () => {}): () => void {
  /** To Dos being started now, with their builder (not a session in the store yet). */
  const pending = new Map<string, string>();

  const start = async (t: StartPick) => {
    const st = useApp.getState();
    try {
      const s = await ipc.startSession(t.workspaceId, t.builderId, t.text, t.images ?? [], !!t.worktree);
      st.upsertSession(s);
      // the session holds the task now; a failure to cross it off only leaves a stale card
      try { await ipc.removeTodo(t.id); st.removeTodo(t.id); } catch (e) { onError(e); }
      const by = st.builders.find((b) => b.id === t.builderId);
      const who = by?.name ?? 'A builder';
      const meant = t.standInFor ? st.builders.find((b) => b.id === t.standInFor) : null;
      const low = meant && isCollectorAgent(meant.agent) ? `${COLLECTOR_NAME[meant.agent]} is low on elixir: ` : '';
      st.notify(meant ? `${low}${who} took ${meant.name}'s task from the To Do` : `${who} picked up a task from the To Do`);
      try { await st.village.ensureSpot(s.id); } catch (e) { onError(e); }
    } catch (e) {
      onError(new Error(`Could not start a To Do on its own: ${String(e)}`));
      try { st.addTodo(await ipc.updateTodo(t.id, false, t.standInFor ?? t.builderId, !!t.worktree)); } catch { /* it may be gone */ }
    } finally {
      pending.delete(t.id);
    }
  };

  const check = (st: AppState) => {
    if (!st.loaded) return;
    // the starts under way take their builder and a slot, as their sessions will once they show
    const limit = st.settings?.sessionLimit;
    const settings = limit ? { sessionLimit: Math.max(0, limit - pending.size) } : st.settings;
    if (limit && settings?.sessionLimit === 0) return;
    const builders = st.builders.filter((b) => ![...pending.values()].includes(b.id));
    for (const t of autoStartable({ ...st, builders, settings: settings ?? null, now: Date.now() })) {
      if (pending.has(t.id)) continue;
      pending.set(t.id, t.builderId);
      void start(t);
    }
  };
  check(useApp.getState());
  const unsub = useApp.subscribe((st, prev) => {
    if (st.todos === prev.todos && st.sessions === prev.sessions && st.builders === prev.builders && st.settings === prev.settings && st.loaded === prev.loaded && st.quotas === prev.quotas) return;
    check(st);
  });
  const tick = setInterval(() => check(useApp.getState()), 60_000); // a held To Do starts once its window refills
  return () => { unsub(); clearInterval(tick); };
}
