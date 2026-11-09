import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ipc } from '../api/ipc';
import type { Builder, SessionInfo, Todo, Workspace } from '../api/types';
import { KANBAN_ALL, idleBuilders, sessionsByWorkspace, useApp } from '../state/store';
import { elapsedLabel } from '../village/status';
import AgentLogo from './AgentLogo';
import { AttachmentStrip, useAttachments } from './Attachments';
import BuilderPicker from './BuilderPicker';
import { StateTag } from './tags';
import { isDemoId } from '../onboarding/demo';
import { sessionName, taskTooltip } from './sessionName';
import { houseColors } from '../village/look';

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

/**
 * A workspace's sessions as a full-page Kanban, with its To Do; with KANBAN_ALL (the Town Hall's),
 * every workspace's, each card naming its workspace. ✕ or Esc closes it.
 */
export default function Kanban() {
  const wsId = useApp((s) => s.kanban);
  const workspaces = useApp((s) => s.workspaces);
  const all = wsId === KANBAN_ALL;
  const ws = workspaces.find((w) => w.id === wsId);
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
      if (e.key !== 'Escape' || useApp.getState().settingsOpen) return; // Settings stands over it
      e.preventDefault();
      e.stopPropagation();
      const a = document.activeElement;
      // the builder picker closes when it loses focus
      if (a instanceof HTMLInputElement || a instanceof HTMLSelectElement || (a instanceof HTMLElement && a.closest('.kb-pick'))) a.blur();
      else useApp.getState().setKanban(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { clearInterval(t); window.removeEventListener('keydown', onKey, true); };
  }, [wsId]);
  if (!wsId || (!ws && !all)) return null;

  const wsOf = (id: string) => workspaces.find((w) => w.id === id);
  const sessions = (all
    ? Object.values(sessionMap).filter((s) => wsOf(s.workspaceId)).sort((a, b) => a.startedAt - b.startedAt)
    : sessionsByWorkspace({ sessions: sessionMap }, wsId)
  ).filter((s) => s.kind.kind === 'agent');
  const builderOf = (s: SessionInfo) => builders.find((b) => s.kind.kind === 'agent' && b.id === s.kind.builderId);
  const inCol = (c: KanbanColumn) => {
    const v = sessions.filter((s) => kanbanColumn(s) === c);
    // the latest finished on top; the rest in the order they started
    return c === 'finished' ? v.reverse() : v;
  };
  const mine = todos.filter((t) => (all ? !!wsOf(t.workspaceId) : t.workspaceId === wsId));
  const usable = workspaces.filter((w) => !w.missing);
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
        {all && <WorkspaceTag ws={wsOf(s.workspaceId)} />}
        <div className="kb-title" title={taskTooltip(s)}>{sessionName(s) ?? 'Session'}</div>
        <div className="kb-who">
          {b && <AgentLogo kind={b.agent} size={18} />}
          <span>{b?.name ?? 'Builder'}{agent ? ` · ${agent.label}` : ''}</span>
        </div>
        {reason && <div className="kb-reason">{reason}</div>}
        <div className="kb-foot">
          <StateTag state={s.state} paused={s.paused} />
          <span>{s.steps} steps · {elapsedLabel(now - s.startedAt)}</span>
        </div>
        {s.state.kind === 'needsYou' && (agent?.canApprove || isDemoId(s.id)) && s.awaitingDecision && (
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
        <h2 className="ol">{ws?.name ?? 'All workspaces'}</h2>
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
                {c.id === 'todo' && (ws
                  ? <AddTodo workspaces={[ws]} disabled={ws.missing} />
                  : <AddTodo workspaces={usable} disabled={usable.length === 0} />)}
                {items.length === 0 && <div className="kb-empty">{all && c.id !== 'todo' ? c.empty.replace(' here', '') : c.empty}</div>}
                {c.id === 'todo'
                  ? mine.map((t) => (
                    <TodoCard key={t.id} todo={t} idle={idle} disabled={!!wsOf(t.workspaceId)?.missing}
                      tag={all ? <WorkspaceTag ws={wsOf(t.workspaceId)} /> : null} />
                  ))
                  : (items as SessionInfo[]).map(card)}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** On the Town Hall's board, which workspace a card belongs to, in its house colour. */
function WorkspaceTag({ ws }: { ws: Workspace | undefined }) {
  if (!ws) return null;
  return <span className="kb-ws ol" style={{ background: houseColors(ws).roof }}>{ws.name}</span>;
}

/** `workspaces`: where the task may go; with more than one (the Town Hall's board) the owner picks. */
function AddTodo({ workspaces, disabled }: { workspaces: Workspace[]; disabled: boolean }) {
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState('');
  const workspaceId = workspaces.some((w) => w.id === chosen) ? chosen : workspaces[0]?.id ?? '';
  const zone = useRef<HTMLDivElement>(null);
  const att = useAttachments(zone);
  const empty = !text.trim() && att.names.length === 0;
  const add = async () => {
    if (empty || att.saving || !workspaceId) return;
    try {
      useApp.getState().addTodo(await ipc.addTodo(workspaceId, text, att.names));
      att.clear(); // the To Do keeps them now
      setText('');
    } catch (e) {
      useApp.getState().setError(String(e));
    }
  };
  return (
    <div ref={zone}>
      <form className="kb-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        {workspaces.length > 1 && (
          <select aria-label="Workspace" value={workspaceId} disabled={disabled} onChange={(e) => setChosen(e.target.value)}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        <input aria-label="New task" placeholder="Add a task or paste an image…" value={text} disabled={disabled}
          onChange={(e) => setText(e.target.value)} onPaste={att.onPaste} />
        <button type="submit" className="hud-btn blue sm" disabled={disabled || empty || att.saving}>Add</button>
      </form>
      <AttachmentStrip names={att.names} onRemove={att.remove} />
    </div>
  );
}

/** A planned task: hand it to an idle builder (it becomes a session and moves to Active) or cross it off. */
function TodoCard({ todo, idle, disabled, tag }: { todo: Todo; idle: Builder[]; disabled: boolean; tag?: ReactNode }) {
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const builderId = idle.some((b) => b.id === pick) ? pick : idle[0]?.id ?? '';
  const start = async () => {
    const st = useApp.getState();
    setBusy(true);
    try {
      const s = await ipc.startSession(todo.workspaceId, builderId, todo.text, todo.images ?? []);
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
      {tag}
      {todo.text && <div className="kb-title">{todo.text}</div>}
      <AttachmentStrip names={todo.images ?? []} />
      <div className="kb-start">
        {idle.length > 0 ? (
          <BuilderPicker builders={idle} value={builderId} onChange={setPick} disabled={busy} />
        ) : <span className="kb-reason">All builders are busy</span>}
        <button className="hud-btn sm" disabled={disabled || busy || !builderId} onClick={() => void start()}>Start</button>
        <button className="hud-btn grey sm" aria-label={`Delete ${todo.text || 'image task'}`} disabled={busy} onClick={() => void remove()}>✕</button>
      </div>
    </article>
  );
}
