import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { Builder, SessionInfo, Todo } from '../api/types';
import { idleBuilders, sessionsByWorkspace, useApp } from '../state/store';
import { elapsedLabel } from '../village/status';
import AgentLogo from './AgentLogo';
import { StateTag } from './tags';

export type KanbanColumn = 'active' | 'needs' | 'finished';

/** Where an agent session stands on the Kanban: it moves on its own as the builder works. */
export function kanbanColumn(s: SessionInfo): KanbanColumn {
  switch (s.state.kind) {
    case 'starting':
    case 'working': return 'active';
    case 'needsYou':
    case 'stuck': return 'needs';
    case 'finished':
    case 'ended': return 'finished';
  }
}

const COLUMNS: Array<{ id: 'todo' | KanbanColumn; title: string; color: string; empty: string }> = [
  { id: 'todo', title: 'To Do', color: 'var(--hud-idle)', empty: 'Nothing planned. Write a task above.' },
  { id: 'active', title: 'Active', color: 'var(--hud-working)', empty: 'No builder at work here.' },
  { id: 'needs', title: 'Needs You', color: 'var(--hud-needs)', empty: 'Nobody needs you.' },
  { id: 'finished', title: 'Finished', color: 'var(--hud-finished)', empty: 'Nothing finished yet.' },
];

/** A workspace's sessions as a full-page Kanban, with its To Do. ✕ or Esc closes it. */
export default function Kanban() {
  const wsId = useApp((s) => s.kanban);
  const ws = useApp((s) => s.workspaces.find((w) => w.id === s.kanban));
  const sessionMap = useApp((s) => s.sessions);
  const builders = useApp((s) => s.builders);
  const agents = useApp((s) => s.agents);
  const todos = useApp((s) => s.todos);
  const close = () => useApp.getState().setKanban(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => (wsId ? useApp.getState().cover() : undefined), [wsId]);
  useEffect(() => {
    if (!wsId) return;
    const t = setInterval(() => setNow(Date.now()), 30_000); // elapsed times are shown in minutes
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      const a = document.activeElement;
      if (a instanceof HTMLInputElement || a instanceof HTMLSelectElement) a.blur();
      else useApp.getState().setKanban(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { clearInterval(t); window.removeEventListener('keydown', onKey, true); };
  }, [wsId]);
  if (!wsId || !ws) return null;

  const sessions = sessionsByWorkspace({ sessions: sessionMap }, wsId).filter((s) => s.kind.kind === 'agent');
  const builderOf = (s: SessionInfo) => builders.find((b) => s.kind.kind === 'agent' && b.id === s.kind.builderId);
  const inCol = (c: KanbanColumn) => {
    const v = sessions.filter((s) => kanbanColumn(s) === c);
    // the latest finished on top; the rest in the order they started
    return c === 'finished' ? v.reverse() : v;
  };
  const mine = todos.filter((t) => t.workspaceId === wsId);
  const idle = idleBuilders({ builders, sessions: sessionMap });

  const card = (s: SessionInfo) => {
    const b = builderOf(s);
    const agent = b && agents.find((a) => a.kind === b.agent);
    const reason = s.state.kind === 'needsYou' || s.state.kind === 'stuck' ? s.state.reason : null;
    const open = () => {
      const st = useApp.getState();
      st.setKanban(null);
      st.setSelection({ kind: 'session', id: s.id });
    };
    return (
      <article key={s.id} className="kb-card" data-testid={`kb-card-${s.id}`} role="button" tabIndex={0}
        onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>
        <div className="kb-title">{s.task ?? 'Session'}</div>
        <div className="kb-who">
          {b && <AgentLogo kind={b.agent} size={18} />}
          <span>{b?.name ?? 'Builder'}{agent ? ` · ${agent.label}` : ''}</span>
        </div>
        {reason && <div className="kb-reason">{reason}</div>}
        <div className="kb-foot">
          <StateTag state={s.state} />
          <span>{s.steps} steps · {elapsedLabel(now - s.startedAt)}</span>
        </div>
        {s.state.kind === 'needsYou' && agent?.canApprove && s.awaitingDecision && (
          <div className="kb-actions" onClick={(e) => e.stopPropagation()}>
            <button className="hud-btn sm" onClick={() => ipc.approve(s.id).catch((e) => useApp.getState().setError(String(e)))}>Allow</button>
            <button className="hud-btn red sm" onClick={() => ipc.deny(s.id).catch((e) => useApp.getState().setError(String(e)))}>Deny</button>
          </div>
        )}
      </article>
    );
  };

  return (
    <div className="kanban" role="dialog" aria-label="Kanban">
      <header className="popout-head">
        <h2 className="ol">{ws.name}</h2>
        <span className="popout-hint">Kanban · Esc to return</span>
        <button className="hud-btn grey sm" aria-label="Close Kanban" onClick={close}>✕</button>
      </header>
      <div className="kb-cols">
        {COLUMNS.map((c) => {
          const items = c.id === 'todo' ? mine : inCol(c.id);
          return (
            <section key={c.id} className="kb-col" aria-label={c.title}>
              <h3 className="kb-head ol" style={{ background: c.color }}>{c.title}<span className="kb-n">{items.length}</span></h3>
              <div className="kb-list">
                {c.id === 'todo' && <AddTodo workspaceId={wsId} disabled={ws.missing} />}
                {items.length === 0 && <div className="kb-empty">{c.empty}</div>}
                {c.id === 'todo'
                  ? mine.map((t) => <TodoCard key={t.id} todo={t} idle={idle} disabled={ws.missing} />)
                  : (items as SessionInfo[]).map(card)}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function AddTodo({ workspaceId, disabled }: { workspaceId: string; disabled: boolean }) {
  const [text, setText] = useState('');
  const add = async () => {
    if (!text.trim()) return;
    try {
      useApp.getState().addTodo(await ipc.addTodo(workspaceId, text));
      setText('');
    } catch (e) {
      useApp.getState().setError(String(e));
    }
  };
  return (
    <form className="kb-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <input aria-label="New task" placeholder="Add a task…" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} />
      <button type="submit" className="hud-btn blue sm" disabled={disabled || !text.trim()}>Add</button>
    </form>
  );
}

/** A planned task: hand it to an idle builder (it becomes a session and moves to Active) or cross it off. */
function TodoCard({ todo, idle, disabled }: { todo: Todo; idle: Builder[]; disabled: boolean }) {
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const builderId = idle.some((b) => b.id === pick) ? pick : idle[0]?.id ?? '';
  const start = async () => {
    const st = useApp.getState();
    setBusy(true);
    try {
      const s = await ipc.startSession(todo.workspaceId, builderId, todo.text);
      st.upsertSession(s);
      // the session holds the task now; a failure to cross it off only leaves a stale card
      try { await ipc.removeTodo(todo.id); st.removeTodo(todo.id); } catch (e) { st.setError(String(e)); }
      try { await st.village.ensureSpot(s.id); } catch (e) { st.setError(String(e)); }
    } catch (e) {
      st.setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try { await ipc.removeTodo(todo.id); useApp.getState().removeTodo(todo.id); } catch (e) { useApp.getState().setError(String(e)); }
  };
  return (
    <article className="kb-card kb-todo" data-testid={`kb-todo-${todo.id}`}>
      <div className="kb-title">{todo.text}</div>
      <div className="kb-start">
        {idle.length > 0 ? (
          <select aria-label="Builder" value={builderId} onChange={(e) => setPick(e.target.value)} disabled={busy}>
            {idle.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        ) : <span className="kb-reason">All builders are busy</span>}
        <button className="hud-btn sm" disabled={disabled || busy || !builderId} onClick={() => void start()}>Start</button>
        <button className="hud-btn grey sm" aria-label={`Delete ${todo.text}`} disabled={busy} onClick={() => void remove()}>✕</button>
      </div>
    </article>
  );
}
