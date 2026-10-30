import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import { stateLabel, useApp } from '../state/store';
import type { CloseOutcome, Review } from '../api/types';
import TerminalView from './TerminalView';

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

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { setReview(null); setError(null); }, [sessionId]);

  if (!session) return null;
  const builder = session.kind.kind === 'agent' ? builders.find((b) => b.id === (session.kind as { builderId: string }).builderId) : undefined;
  const agent = builder ? agents.find((a) => a.kind === builder.agent) : undefined;
  const run = async (p: Promise<unknown>) => {
    setError(null);
    try { await p; } catch (e) { setError(String(e)); }
  };
  const st = session.state.kind;

  async function close() {
    setError(null);
    try {
      const o = await ipc.closeSession(sessionId);
      onClosed?.(o);
    } catch (e) { setError(String(e)); }
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <strong>{builder?.name ?? 'Terminal'}</strong>
        {builder && <span>{agent?.label ?? builder.agent}{builder.model ? ` · ${builder.model}` : ''}{builder.effort ? ` · ${builder.effort}` : ''}</span>}
        <span className={`state state-${st}`}>{stateLabel(session.state)}</span>
        {session.kind.kind === 'agent' && <span>{session.steps} steps</span>}
        <span>{elapsed(session.startedAt, now)}</span>
        <span className="spacer" />
        {st === 'needsYou' && (agent?.canApprove
          ? <><button onClick={() => run(ipc.approve(sessionId))}>Allow</button><button onClick={() => run(ipc.deny(sessionId))}>Deny</button></>
          : <em>Answer in the terminal below</em>)}
        {st === 'finished' && (
          <button onClick={async () => { setError(null); try { setReview(await ipc.reviewSession(sessionId)); } catch (e) { setError(String(e)); } }}>Review</button>
        )}
        <button onClick={() => run(ipc.stopSession(sessionId))}>Stop</button>
        <button onClick={close}>Close</button>
      </header>
      {error && <div className="error">{error}</div>}
      {review && (
        <div className="review">
          {!review.isGit ? <div>not a git folder</div> : (
            <>
              {review.branch && <div>Branch: {review.branch}</div>}
              <ul>{review.files.map((f) => <li key={f.path}>{f.path} +{f.added} −{f.removed}</li>)}</ul>
              {review.untracked.length > 0 && (
                <div>Untracked:<ul>{review.untracked.map((p) => <li key={p}>{p}</li>)}</ul></div>
              )}
              {review.otherSessionsActive && <div>Other sessions were active in this folder.</div>}
            </>
          )}
        </div>
      )}
      <TerminalView key={sessionId} sessionId={sessionId} />
    </section>
  );
}
