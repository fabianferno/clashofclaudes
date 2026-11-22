import { useEffect, useRef, useState } from 'react';
import { ipc } from '../api/ipc';
import { stateLabel, useApp } from '../state/store';
import type { CloseOutcome } from '../api/types';
import TerminalView from '../components/LazyTerminalView';
import { CLASS_NAMES, GEAR_NAMES, classOf, gearOf } from '../village/look';
import PopOutTerminal from './PopOutTerminal';
import { isDemoId } from '../onboarding/demo';
import { sessionName } from './sessionName';
import Briefing from './Briefing';
import { queueReason } from '../state/queue';
import { useTermShown } from '../components/terminalShown';
import Markdown from './Markdown';
import LastReply from './LastReply';
import { plainText } from './markdownText';

function elapsed(from: number, now: number): string {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

export default function SessionPanel({ sessionId, onClosed }: { sessionId: string; onClosed?: (o: CloseOutcome, sessionId: string) => void }) {
  const session = useApp((s) => s.sessions[sessionId]);
  const builders = useApp((s) => s.builders);
  const agents = useApp((s) => s.agents);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const [popped, setPopped] = useState(false);
  const termShown = useTermShown((s) => s.shown);
  const setTermShown = useTermShown((s) => s.set);
  // opened popped out (a Kanban card): pop out at once
  const askPop = useApp((s) => (s.selection?.kind === 'session' && s.selection.id === sessionId && s.selection.popout ? s.selection : null));
  useEffect(() => { if (askPop) setPopped(true); }, [askPop]);
  const closePop = () => {
    setPopped(false);
    const st = useApp.getState();
    const sel = st.selection;
    if (sel?.kind !== 'session' || sel.id !== sessionId) return;
    if (sel.back) {
      // back to the board it was opened from
      st.setSelection(null);
      st.setKanban(sel.back);
    } else if (sel.popout) {
      st.setSelection({ kind: 'session', id: sessionId });
    }
  };

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // The panel stays mounted across session switches (so its terminal does): per-session state is
  // reset during render, before anything of the previous session can show.
  const [shownFor, setShownFor] = useState(sessionId);
  // The session on screen, read after every await: a result for a session the user has switched
  // away from must not land on the one now shown.
  const current = useRef(sessionId);
  current.current = sessionId;
  if (shownFor !== sessionId) {
    setShownFor(sessionId);
    setError(null);
    setPopped(false);
    setAnswering(false);
  }

  if (!session) return null;
  const builder = session.kind.kind === 'agent' ? builders.find((b) => b.id === (session.kind as { builderId: string }).builderId) : undefined;
  const agent = builder ? agents.find((a) => a.kind === builder.agent) : undefined;
  // the tour's sample sessions take Allow and Deny whatever their agent
  const canApprove = !!agent?.canApprove || isDemoId(sessionId);
  const stillShown = (sid: string) => current.current === sid;
  const run = async (p: Promise<unknown>) => {
    const sid = sessionId;
    setError(null);
    try { await p; } catch (e) { if (stillShown(sid)) setError(String(e)); }
  };
  const st = session.state.kind;
  // taken from the owner's queue: once dealt with, the next one comes up
  const fromQueue = () => {
    const sel = useApp.getState().selection;
    return sel?.kind === 'session' && sel.id === sessionId && !!sel.queue;
  };
  const dealt = (sid: string) => { if (fromQueue() && stillShown(sid)) useApp.getState().takeNext(sid); };
  const answer = async (p: () => Promise<unknown>) => {
    if (answering) return;
    const sid = sessionId;
    const queued = fromQueue();
    setAnswering(true);
    let ok = false;
    try { await p(); ok = true; } catch (e) { if (stillShown(sid)) setError(String(e)); } finally { if (stillShown(sid)) setAnswering(false); }
    if (ok && queued && stillShown(sid)) useApp.getState().takeNext(sid);
  };

  async function close(discard = false) {
    const sid = sessionId;
    const queued = fromQueue();
    setError(null);
    try {
      const o = await ipc.closeSession(sid, discard);
      onClosed?.(o, sid);
      if (queued) useApp.getState().takeNext(sid);
    } catch (e) {
      // the session may be gone already (the panel unmounts with it): report where it survives
      useApp.getState().setError(`Close failed: ${String(e)}`);
      if (stillShown(sid)) setError(String(e));
    }
  }

  const title = builder ? `${builder.name} · ${sessionName(session) ?? 'session'}` : 'Terminal';
  const tier = builder
    ? `${builder.model ? `${builder.model} · ` : ''}${builder.effort ? `${builder.effort} ` : ''}→ ${CLASS_NAMES[classOf(builder.agent, builder.model)]} with ${GEAR_NAMES[gearOf(builder.effort)].toLowerCase()}`
    : null;
  const readOnly = st === 'ended';
  // a session waiting on the owner (or parked out of their queue) gets its briefing
  const briefed = session.kind.kind === 'agent' && !session.paused && queueReason({ ...session, parked: null }) !== null;
  const paused = !!session.paused;
  const resume = () => run(ipc.resumeSession(sessionId).then((s) => useApp.getState().upsertSession(s)));
  // An agent's terminal is behind a toggle; a shell session is nothing but its terminal.
  const isAgent = session.kind.kind === 'agent';
  const showTerm = !isAgent || termShown;

  return (
    <section className="panel session-panel">
      <header className="panel-head">
        <strong>{builder?.name ?? 'Terminal'}</strong>
        {builder && <span>{agent?.label ?? builder.agent}</span>}
        <span className={`state state-${paused ? 'paused' : st}`}>{stateLabel(session.state, paused)}</span>
        {session.kind.kind === 'agent' && <span>{session.steps} steps</span>}
        <span>{elapsed(session.startedAt, now)}</span>
        {session.worktree?.branch && <span className="chip">{session.worktree.branch}</span>}
        {builder && (
          <button type="button" className="sp-link" onClick={() => useApp.getState().setSelection({ kind: 'builder', id: builder.id })}>
            Edit builder
          </button>
        )}
        {tier && <div className="sp-d session-tier">{tier}</div>}
      </header>
      <div className="session-actions">
        {!briefed && session.state.kind === 'needsYou' && (canApprove && session.awaitingDecision
          ? <>
              <button className="hud-btn sm" data-tour="allow" disabled={answering} onClick={() => answer(() => ipc.approve(sessionId))}>Allow</button>
              <button className="hud-btn red sm" disabled={answering} onClick={() => answer(() => ipc.deny(sessionId))}>Deny</button>
            </>
          : <><em>Answer in the terminal</em>{canApprove && session.state.reason && <span className="sp-d">{session.state.reason}</span>}</>)}
        {paused && <button className="hud-btn sm" onClick={() => void resume()}>Resume</button>}
        {!paused && <button className="hud-btn grey sm" onClick={() => run(ipc.stopSession(sessionId))}>Stop</button>}
        <button className="hud-btn grey sm" data-tour={briefed ? undefined : 'close-session'} onClick={() => void close()}>Close</button>
        {!paused && <button className="hud-btn blue sm" onClick={() => setPopped(true)}>Pop out</button>}
        {isAgent && !paused && !popped && (
          <button type="button" className="hud-btn grey sm term-toggle" aria-pressed={termShown} onClick={() => setTermShown(!termShown)}>
            {termShown ? 'Hide terminal' : 'Show terminal'}
          </button>
        )}
      </div>
      {error && <div className="panel-warn">{error}</div>}
      {briefed && (
        <Briefing session={session} canApprove={canApprove} answering={answering}
          onAllow={() => void answer(() => ipc.approve(sessionId))}
          onDeny={() => void answer(() => ipc.deny(sessionId))}
          onClose={(discard) => void close(discard)}
          onDealt={() => dealt(sessionId)} />
      )}
      {paused ? (
        <div className="terminal-placeholder">
          {builder
            ? `Paused: it was not running when the app closed, or could not start again. Resume to pick ${builder.name}'s conversation back up.`
            : 'Paused: it was not running when the app closed, or could not start again. Resume to open a new shell here.'}
        </div>
      ) : popped ? (
        <>
          <div className="terminal-placeholder">Terminal popped out — ✕ to return</div>
          <PopOutTerminal sessionId={sessionId} readOnly={readOnly} title={title} onClose={closePop} />
        </>
      ) : showTerm ? (
        <TerminalView sessionId={sessionId} readOnly={readOnly} />
      ) : !briefed ? (
        <SessionGlance task={session.task} asking={session.asking ?? null} lastMessage={session.lastMessage ?? null} ended={readOnly} />
      ) : null}
    </section>
  );
}

/** What an agent session is up to, in place of its terminal: the task, what it is about to run, its last reply. */
function SessionGlance({ task, asking, lastMessage, ended }: { task: string | null; asking: string | null; lastMessage: string | null; ended: boolean }) {
  const [taskOpen, setTaskOpen] = useState(false);
  return (
    <div className="brief sp-box session-glance" data-testid="session-glance">
      {task && (
        <div className="brief-sec">
          <div className="brief-h">Task</div>
          {taskOpen
            ? <Markdown className="brief-task open md" text={task} />
            : <div className="brief-task" onClick={() => setTaskOpen(true)} title="Show all">{plainText(task) || task}</div>}
        </div>
      )}
      {asking && (
        <div className="brief-sec">
          <div className="brief-h">Running</div>
          <code className="brief-call">{asking}</code>
        </div>
      )}
      {lastMessage
        ? (
          <div className="brief-sec">
            <div className="brief-h">Its last reply</div>
            <LastReply text={lastMessage} />
          </div>
        )
        : <div className="sp-d">{ended ? 'It has ended. Show terminal to read its output.' : 'Working on it. Show terminal to watch it live.'}</div>}
    </div>
  );
}
