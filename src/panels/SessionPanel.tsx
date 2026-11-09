import { useEffect, useRef, useState } from 'react';
import { ipc } from '../api/ipc';
import { stateLabel, useApp } from '../state/store';
import type { CloseOutcome, Review } from '../api/types';
import TerminalView from '../components/LazyTerminalView';
import { CLASS_NAMES, GEAR_NAMES, classOf, gearOf } from '../village/look';
import PopOutTerminal from './PopOutTerminal';
import { isDemoId } from '../onboarding/demo';
import { sessionName } from './sessionName';

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
  // The session on screen, read after every await: a result for a session the user has switched
  // away from must not land on the one now shown.
  const current = useRef(sessionId);
  current.current = sessionId;
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
  // the tour's sample sessions take Allow and Deny whatever their agent
  const canApprove = !!agent?.canApprove || isDemoId(sessionId);
  const stillShown = (sid: string) => current.current === sid;
  const run = async (p: Promise<unknown>) => {
    const sid = sessionId;
    setError(null);
    try { await p; } catch (e) { if (stillShown(sid)) setError(String(e)); }
  };
  const st = session.state.kind;
  // A review describes one Finished moment; once the agent works again it is stale.
  if (review && st !== 'finished') setReview(null);
  const answer = async (p: () => Promise<unknown>) => {
    if (answering) return;
    const sid = sessionId;
    setAnswering(true);
    try { await run(p()); } finally { if (stillShown(sid)) setAnswering(false); }
  };
  const showReview = async () => {
    const sid = sessionId;
    setError(null);
    try {
      const r = await ipc.reviewSession(sid);
      if (stillShown(sid)) setReview(r);
    } catch (e) { if (stillShown(sid)) setError(String(e)); }
  };

  async function close() {
    const sid = sessionId;
    setError(null);
    try {
      const o = await ipc.closeSession(sid);
      onClosed?.(o, sid);
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
  const paused = !!session.paused;
  const resume = () => run(ipc.resumeSession(sessionId).then((s) => useApp.getState().upsertSession(s)));

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
        {session.state.kind === 'needsYou' && (canApprove && session.awaitingDecision
          ? <>
              <button className="hud-btn sm" data-tour="allow" disabled={answering} onClick={() => answer(() => ipc.approve(sessionId))}>Allow</button>
              <button className="hud-btn red sm" disabled={answering} onClick={() => answer(() => ipc.deny(sessionId))}>Deny</button>
            </>
          : <><em>Answer in the terminal</em>{canApprove && session.state.reason && <span className="sp-d">{session.state.reason}</span>}</>)}
        {st === 'finished' && (
          <button className="hud-btn sm" onClick={() => void showReview()}>Review</button>
        )}
        {paused && <button className="hud-btn sm" onClick={() => void resume()}>Resume</button>}
        {!paused && <button className="hud-btn grey sm" onClick={() => run(ipc.stopSession(sessionId))}>Stop</button>}
        <button className="hud-btn grey sm" data-tour="close-session" onClick={close}>Close</button>
        {!paused && <button className="hud-btn blue sm" onClick={() => setPopped(true)}>Pop out</button>}
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
      {paused ? (
        <div className="terminal-placeholder">
          {builder
            ? `Paused: it was not running when the app closed, or could not start again. Resume to pick ${builder.name}'s conversation back up.`
            : 'Paused: it was not running when the app closed, or could not start again. Resume to open a new shell here.'}
        </div>
      ) : popped ? (
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
