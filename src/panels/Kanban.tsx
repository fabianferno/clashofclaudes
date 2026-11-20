import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ipc } from '../api/ipc';
import type { Builder, SessionInfo, Todo, Workspace } from '../api/types';
import { KANBAN_ALL, finishedBuilders, idleBuilders, sessionsByWorkspace, useApp } from '../state/store';
import { elapsedLabel } from '../village/status';
import AgentLogo from './AgentLogo';
import { AttachmentStrip, useAttachments } from './Attachments';
import BuilderPicker from './BuilderPicker';
import { StateTag } from './tags';
import { isDemoId } from '../onboarding/demo';
import { sessionName, taskTooltip } from './sessionName';
import { plainText } from './markdownText';
import { houseColors } from '../village/look';
import './briefing.css';
import { heldText, isLow } from '../state/elixir';

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
      const a = document.activeElement;
      if (a instanceof HTMLElement && a.closest('.kb-edit')) return; // a task being edited: its Esc cancels the edit
      e.preventDefault();
      e.stopPropagation();
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
  const done = finishedBuilders({ builders, sessions: sessionMap });

  const card = (s: SessionInfo) => {
    const b = builderOf(s);
    const agent = b && agents.find((a) => a.kind === b.agent);
    const reason = s.state.kind === 'needsYou' || s.state.kind === 'stuck' ? s.state.reason : null;
    // popped out, full window; closing it comes back to this board (a paused one has no terminal: the panel)
    const open = () => {
      const st = useApp.getState();
      st.setKanban(null);
      st.setSelection(s.paused ? { kind: 'session', id: s.id } : { kind: 'session', id: s.id, popout: true, back: wsId });
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
        {s.parked != null && <div className="kb-parked">Parked{s.parked ? `: ${s.parked}` : ''}</div>}
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
                    <TodoCard key={t.id} todo={t} idle={idle} done={done} all={builders.filter((b) => isDemoId(b.id) === isDemoId(t.workspaceId))} disabled={!!wsOf(t.workspaceId)?.missing}
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

/**
 * A planned task: hand it to an idle builder (it becomes a session and moves to Active) or cross it
 * off. Set to start on its own, it waits for its builder (busy or not now) and starts once that
 * builder is free; in its own worktree, its changes wait apart on a new branch. A builder held only
 * by a Finished session (`done`: builder id → that session) is offered too: Start closes that
 * session first, as its Close button would, so a finished builder never blocks the next task.
 */
function TodoCard({ todo, idle, done, all, disabled, tag }: {
  todo: Todo; idle: Builder[]; done: Map<string, string>; all: Builder[]; disabled: boolean; tag?: ReactNode;
}) {
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const auto = !!todo.auto;
  // its own builder when it has one; else the one picked, else the first idle
  const remembered = todo.builderId && all.some((b) => b.id === todo.builderId) ? todo.builderId : '';
  const takeable = (id: string) => idle.some((b) => b.id === id) || done.has(id);
  const offered = auto ? all : [...idle, ...all.filter((b) => done.has(b.id))];
  const builderId = remembered && (auto || takeable(remembered)) ? remembered
    : offered.some((b) => b.id === pick) ? pick : idle[0]?.id ?? (auto ? all[0]?.id : offered[0]?.id) ?? '';
  const free = idle.some((b) => b.id === builderId);
  // its builder is done with a Finished session: Start closes that one first
  const wrapUp = free ? undefined : done.get(builderId);
  const sessions = useApp((s) => s.sessions);
  const notes = Object.fromEntries([...done].map(([b, sid]) => {
    const name = sessions[sid] && sessionName(sessions[sid]);
    return [b, `Finished${name ? `: ${name}` : ''}`];
  }));
  const quotas = useApp((s) => s.quotas);
  const settings = useApp((s) => s.settings);
  const agentOf = all.find((b) => b.id === builderId)?.agent;
  // its agent at or under the reserve: it waits for elixir (or a stand-in takes it, when that is on)
  const held = auto && !!agentOf && isLow(agentOf, quotas, Date.now(), settings);
  const save = async (next: { auto?: boolean; builderId?: string | null; worktree?: boolean }) => {
    const st = useApp.getState();
    try {
      st.addTodo(await ipc.updateTodo(todo.id, next.auto ?? auto, next.builderId !== undefined ? next.builderId : (todo.builderId ?? (auto || next.auto ? builderId || null : null)), next.worktree ?? !!todo.worktree));
    } catch (e) {
      st.setError(String(e));
    }
  };
  const choose = (id: string) => {
    setPick(id);
    if (auto || todo.builderId) void save({ builderId: id });
  };
  const start = async () => {
    const st = useApp.getState();
    setBusy(true);
    try {
      if (wrapUp) st.onClosed(await ipc.closeSession(wrapUp), wrapUp);
      const s = await ipc.startSession(todo.workspaceId, builderId, todo.text, todo.images ?? [], !!todo.worktree);
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
      {editing ? <TodoEditor todo={todo} onDone={() => setEditing(false)} /> : <>
        {todo.text && <div className="kb-title" title={todo.text} onDoubleClick={() => { if (!busy) setEditing(true); }}>{plainText(todo.text) || todo.text}</div>}
        <AttachmentStrip names={todo.images ?? []} />
      </>}
      {auto && (
        <div className="kb-reason" style={{ color: 'var(--sp-ink-soft)' }}>
          <span className="kb-auto-tag ol">Auto</span>{' '}
          {held ? `${heldText(agentOf!, quotas[agentOf!], Date.now())}${settings?.elixirStandIn ? ', or a builder with elixir takes it' : ''}`
            : free ? 'Starting…' : `Starts when ${all.find((b) => b.id === builderId)?.name ?? 'its builder'} is free`}
        </div>
      )}
      <div className="kb-start">
        {offered.length > 0 ? (
          <BuilderPicker builders={offered} value={builderId} onChange={choose} disabled={busy} notes={notes} />
        ) : <span className="kb-reason">{all.length ? 'All builders are at work: tick Start on its own to queue it' : 'No builders yet'}</span>}
        <button className="hud-btn sm" disabled={disabled || busy || !builderId || (!free && !wrapUp)}
          title={wrapUp ? `Closes ${all.find((b) => b.id === builderId)?.name ?? 'the builder'}'s finished session, then starts this` : undefined}
          onClick={() => void start()}>{wrapUp ? 'Close & start' : 'Start'}</button>
        <button className="hud-btn grey sm" aria-label={`Edit ${todo.text || 'image task'}`} title="Edit" disabled={busy || editing}
          onClick={() => setEditing(true)}>✎</button>
        <button className="hud-btn grey sm" aria-label={`Delete ${todo.text || 'image task'}`} disabled={busy} onClick={() => void remove()}>✕</button>
      </div>
      <div className="kb-opts">
        <label title="Starts by itself as soon as its builder is free (and your limit on sessions at work allows)">
          <input type="checkbox" checked={auto} disabled={busy || !builderId}
            onChange={(e) => void save({ auto: e.target.checked, builderId: builderId || null })} /> Start on its own
        </label>
        {!isDemoId(todo.workspaceId) && (
          <label title="A new branch in its own folder, from your last commit: its changes wait apart from yours for review">
            <input type="checkbox" checked={!!todo.worktree} disabled={busy}
              onChange={(e) => void save({ worktree: e.target.checked })} /> Own worktree
          </label>
        )}
      </div>
    </article>
  );
}

/**
 * A To Do's text and images, rewritten in place. Enter saves (Shift+Enter for a new line), Esc
 * puts it back as it was. Images taken off are only deleted once it saves; ones pasted or dropped
 * in and then left behind (cancelled) are discarded.
 */
function TodoEditor({ todo, onDone }: { todo: Todo; onDone: () => void }) {
  const [text, setText] = useState(todo.text);
  const [kept, setKept] = useState(todo.images ?? []);
  const [saving, setSaving] = useState(false);
  const zone = useRef<HTMLDivElement>(null);
  const att = useAttachments(zone, kept.length);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const f = field.current;
    if (!f) return;
    f.focus();
    f.setSelectionRange(f.value.length, f.value.length);
  }, []);
  const empty = !text.trim() && kept.length === 0 && att.names.length === 0;
  const save = async () => {
    if (empty || att.saving || saving) return;
    const images = [...kept, ...att.names];
    if (text.trim() === todo.text && images.join('\n') === (todo.images ?? []).join('\n')) return onDone();
    setSaving(true);
    const st = useApp.getState();
    try {
      st.addTodo(await ipc.editTodo(todo.id, text, images));
      att.clear(); // the To Do keeps them now
      onDone();
    } catch (e) {
      st.setError(String(e));
      setSaving(false);
    }
  };
  return (
    <div ref={zone} className="kb-edit">
      <textarea ref={field} aria-label="Edit task" rows={Math.min(6, Math.max(2, text.split('\n').length))} value={text} disabled={saving}
        placeholder="The task, or paste an image…" onChange={(e) => setText(e.target.value)} onPaste={att.onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(); }
          else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
        }} />
      <AttachmentStrip names={[...kept, ...att.names]}
        onRemove={(n) => (kept.includes(n) ? setKept((k) => k.filter((x) => x !== n)) : att.remove(n))} />
      <div className="kb-actions">
        <button type="button" className="hud-btn blue sm" disabled={empty || att.saving || saving} onClick={() => void save()}>Save</button>
        <button type="button" className="hud-btn grey sm" disabled={saving} onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
