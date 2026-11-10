import { ipc } from '../api/ipc';
import type { Todo } from '../api/types';
import { autoStartable } from './queue';
import { useApp, type AppState } from './store';

/**
 * Starts the To Dos set to start on their own as soon as they can (their builder free, the
 * running-session limit leaving room), so the To Do drains without the owner. Each one becomes a
 * session (in its own worktree when asked) and leaves the To Do. A start that fails turns that
 * To Do's auto start off, so it is not retried in a loop. Returns an unsubscribe.
 */
export function autoStart(onError: (e: unknown) => void = () => {}): () => void {
  /** To Dos being started now, with their builder (not a session in the store yet). */
  const pending = new Map<string, string>();

  const start = async (t: Todo) => {
    const st = useApp.getState();
    try {
      const s = await ipc.startSession(t.workspaceId, t.builderId!, t.text, t.images ?? [], !!t.worktree);
      st.upsertSession(s);
      // the session holds the task now; a failure to cross it off only leaves a stale card
      try { await ipc.removeTodo(t.id); st.removeTodo(t.id); } catch (e) { onError(e); }
      const who = st.builders.find((b) => b.id === t.builderId)?.name ?? 'A builder';
      st.notify(`${who} picked up a task from the To Do`);
      try { await st.village.ensureSpot(s.id); } catch (e) { onError(e); }
    } catch (e) {
      onError(new Error(`Could not start a To Do on its own: ${String(e)}`));
      try { st.addTodo(await ipc.updateTodo(t.id, false, t.builderId ?? null, !!t.worktree)); } catch { /* it may be gone */ }
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
    for (const t of autoStartable({ ...st, builders, settings: settings ?? null })) {
      if (pending.has(t.id)) continue;
      pending.set(t.id, t.builderId!);
      void start(t);
    }
  };
  check(useApp.getState());
  return useApp.subscribe((st, prev) => {
    if (st.todos === prev.todos && st.sessions === prev.sessions && st.builders === prev.builders && st.settings === prev.settings && st.loaded === prev.loaded) return;
    check(st);
  });
}
