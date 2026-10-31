import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import { stateLabel, useApp } from '../state/store';
import type { CloseOutcome, Review } from '../api/types';
import TerminalView from '../components/TerminalView';
import { CLASS_NAMES, GEAR_NAMES, classOf, gearOf } from '../village/look';
import PopOutTerminal from './PopOutTerminal';

function elapsed(from: number, now: number): string {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

export default function SessionPanel({ sessionId, onClosed }: { sessionId: string; onClosed?: (o: CloseOutcome) => void }) {
  const session = useApp((s) => s.sessions[sessionId]);
  const builders = useApp((s) => s.builders);
  const agents = useApp((s) => s.agents);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [answering, setAnswering] = useState(false);
  const [popped, setPopped] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // The panel stays mounted across session switches (so its terminal does): per-session state is
  // reset during render, before anything of the previous session can show.
  const [shownFor, setShownFor] = useState(sessionId);
  if (shownFor !== sessionId) {
    setShownFor(sessionId);
    setReview(null);
    setError(null);
    setPopped(false);
    setAnswering(false);
  }

  if (!session) return null;
  const builder = session.kind.kind === 'agent' ? builders.find((b) => b.id === (session.kind as { builderId: string }).builderId) : undefined;
  const agent = builder ? agents.find((a) => a.kind === builder.agent) : undefined;
  const run = async (p: Promise<unknown>) => {
    setError(null);
    try { await p; } catch (e) { setError(String(e)); }
  };
  const st = session.state.kind;
  const answer = async (p: () => Promise<unknown>) => {
    if (answering) return;
    setAnswering(true);
    try { await run(p()); } finally { setAnswering(false); }
  };

  async function close() {
    setError(null);
    try {
      const o = await ipc.closeSession(sessionId);
      onClosed?.(o);
    } catch (e) {
      // the session may be gone already (the panel unmounts with it): report where it survives
      useApp.getState().setError(`Close failed: ${String(e)}`);
      setError(String(e));
    }
  }

  const title = builder ? `${builder.name} · ${session.task ?? 'session'}` : 'Terminal';
  const tier = builder
    ? `${builder.model ? `${builder.model} · ` : ''}${builder.effort ? `${builder.effort} ` : ''}→ ${CLASS_NAMES[classOf(builder.agent, builder.model)]} with ${GEAR_NAMES[gearOf(builder.effort)].toLowerCase()}`
    : null;
  const readOnly = st === 'ended';

  return (
    <section className="panel session-panel">
      <header className="panel-head">
        <strong>{builder?.name ?? 'Terminal'}</strong>
        {builder && <span>{agent?.label ?? builder.agent}</span>}
        <span className={`state state-${st}`}>{stateLabel(session.state)}</span>
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
        {session.state.kind === 'needsYou' && (agent?.canApprove && session.awaitingDecision
          ? <>
              <button className="hud-btn sm" disabled={answering} onClick={() => answer(() => ipc.approve(sessionId))}>Allow</button>
              <button className="hud-btn red sm" disabled={answering} onClick={() => answer(() => ipc.deny(sessionId))}>Deny</button>
            </>
          : <><em>Answer in the terminal</em>{agent?.canApprove && session.state.reason && <span className="sp-d">{session.state.reason}</span>}</>)}
        {st === 'finished' && (
          <button className="hud-btn sm" onClick={async () => { setError(null); try { setReview(await ipc.reviewSession(sessionId)); } catch (e) { setError(String(e)); } }}>Review</button>
        )}
        <button className="hud-btn grey sm" onClick={() => run(ipc.stopSession(sessionId))}>Stop</button>
        <button className="hud-btn grey sm" onClick={close}>Close</button>
        <button className="hud-btn blue sm" onClick={() => setPopped(true)}>Pop out</button>
      </div>
      {error && <div className="panel-warn">{error}</div>}
      {review && (
        <div className="review sp-box">
          {!review.isGit ? <div>No git history; open the folder to review</div> : (
            <>
              {review.branch && <div>Branch: {review.branch}</div>}
              {review.files.length === 0 && review.untracked.length === 0 && <div>No changes since this session started</div>}
              <ul>{review.files.map((f) => <li key={f.path}>{f.path} +{f.added} −{f.removed}</li>)}</ul>
              {review.untracked.length > 0 && (
                <div>Untracked:<ul>{review.untracked.map((p) => <li key={p}>{p}</li>)}</ul></div>
              )}
              {review.otherSessionsActive && <div>Other sessions were active in this folder.</div>}
            </>
          )}
        </div>
      )}
      {popped ? (
        <>
          <div className="terminal-placeholder">Terminal popped out — ✕ to return</div>
          <PopOutTerminal sessionId={sessionId} readOnly={readOnly} title={title} onClose={() => setPopped(false)} />
        </>
      ) : (
        <TerminalView sessionId={sessionId} readOnly={readOnly} />
      )}
    </section>
  );
}
