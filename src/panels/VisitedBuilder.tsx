import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { VisitedBuilder as Visited } from '../api/types';
import { useApp } from '../state/store';
import { useMyLevel } from '../state/myLevel';

const WAIT: Record<string, string> = { decide: 'Wants a decision', answer: 'Asking its owner', stuck: 'Stuck', review: 'Ready to review' };
type Do = 'allow' | 'deny' | 'answer' | 'followup';
/** What each level may do; the owner's Mac holds the same table and is the one that counts. */
const MAY: Record<string, Do[]> = { visitor: [], helper: ['answer', 'followup'], trusted: ['allow', 'deny', 'answer', 'followup'] };

/** `**Wizard** (Claude Code): add a CSV export` as its parts. */
function parts(title: string): { who: string; rest: string } {
  const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(title);
  return m ? { who: m[1], rest: m[2].replace(/^:\s*/, '') } : { who: 'A builder', rest: title };
}

/**
 * A builder in the village you are visiting: what it works on and what it waits for, read from
 * its thread on the board, and, as far as your level there allows, the answers you can send.
 * Each is signed by this Mac and judged by its owner's.
 */
export default function VisitedBuilder() {
  const visiting = useApp((s) => s.visiting);
  const id = useApp((s) => s.visitedSession);
  const [data, setData] = useState<Visited | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'closed' | 'none'>('loading');
  const [busy, setBusy] = useState(false);
  // the wait an action was sent for: a newer wait is not "sent"
  const [sentFor, setSentFor] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [words, setWords] = useState('');
  const session = visiting?.map.sessions.find((s) => s.i === id);
  const root = session?.r ?? null;
  const owner = visiting?.owner;
  const level = useMyLevel(visiting?.map);

  const read = useCallback(async () => {
    if (!owner || !root) return;
    const d = await ipc.visitBuilder(owner, root);
    setData(d);
    setState(d ? 'ready' : 'closed');
  }, [owner, root]);

  useEffect(() => {
    if (!owner || !id) return;
    setData(null);
    setSentFor(null);
    setPolls(0);
    setError(null);
    setWords('');
    if (!root) { setState('none'); return; }
    let live = true;
    setState('loading');
    read().catch(() => { if (live) setState('closed'); });
    return () => { live = false; };
  }, [owner, id, root, read]);

  // once something was sent, look again until the owner's Mac has answered
  const sent = sentFor !== null && sentFor === data?.prompt;
  // for two minutes; after that the panel shows what it last read (the owner's Mac may be asleep)
  const waitingForAnswer = (sent || data?.sent === true) && !data?.result && polls < 40;
  useEffect(() => {
    if (!waitingForAnswer) return;
    const t = setInterval(() => { setPolls((n) => n + 1); void read().catch(() => {}); }, 3000);
    return () => clearInterval(t);
  }, [waitingForAnswer, read]);

  if (!visiting || !id || !session || !owner) return null;
  const builder = visiting.map.builders.find((b) => b.p === session.b);
  const title = data ? parts(data.title) : { who: builder?.n ?? 'A builder', rest: '' };
  const can = (d: Do) => !!data?.can.includes(d) && MAY[level].includes(d);
  const again = data?.result === 'refused' || data?.result === 'failed';
  const done = (sent || data?.sent === true) && !again;
  const RESULT: Record<string, string> = { applied: 'Done', stale: 'Too late: it had moved on', refused: `${owner}’s Mac refused it`, failed: `${owner}’s Mac could not do it` };

  const send = (d: Do, extra: { pick?: number; text?: string } = {}) => {
    if (!data?.prompt || !root || busy) return;
    setBusy(true);
    setError(null);
    ipc.visitAct(owner, root, { do: d, ...extra, prompt: data.prompt })
      .then(() => { setSentFor(data.prompt); setPolls(0); return read().catch(() => {}); }, (e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  const wordsFor: Do | null = can('followup') ? 'followup' : can('answer') ? 'answer' : null;
  const typed = words.trim();
  const offered = (['allow', 'deny', 'answer', 'followup'] as Do[]).some(can);
  const heldBack = !!data && data.can.length > 0 && !offered && level === 'helper';

  return (
    <aside className="visited-builder" aria-label="A builder in this village">
      <header>
        <h3>{title.who}</h3>
        <button type="button" className="hud-btn grey sm" onClick={() => useApp.getState().setVisitedSession(null)}>Close</button>
      </header>
      {title.rest && <p className="visited-task">{title.rest}</p>}
      {state === 'loading' && <p className="set-note" role="status">Reading its thread…</p>}
      {state === 'none' && <p className="set-note">Its thread is not on the board yet.</p>}
      {state === 'closed' && <p className="set-note">You were not invited to this workspace, so its builders' work stays with its owner.</p>}
      {data?.wait && <p className="visited-wait">{WAIT[data.wait] ?? data.wait}</p>}
      {/* A decision shows only the command its signature covers, as on the phone. */}
      {data?.question ? <p className="visited-ask">{data.question}</p> : data?.wait !== 'decide' && data?.words && <p className="visited-words">{data.words}</p>}
      {data?.options && !can('answer') && <ul className="visited-options">{data.options.map((o) => <li key={o}>{o}</li>)}</ul>}

      {again && data?.result && <p className="visited-result" role="status">{RESULT[data.result]}</p>}
      {done ? (
        <p className="visited-result" role="status">{data?.result ? RESULT[data.result] ?? data.result : `Sent to ${owner}’s Mac`}</p>
      ) : (
        <div className="visited-acts">
          {can('allow') && can('deny') && (
            <div className="visited-pair">
              <button type="button" className="hud-btn grey" disabled={busy} onClick={() => send('deny')}>Deny</button>
              <button type="button" className="hud-btn green" disabled={busy} onClick={() => send('allow')}>Allow</button>
            </div>
          )}
          {can('answer') && data?.options?.map((o, i) => (
            <button key={o} type="button" className="hud-btn grey" disabled={busy} onClick={() => send('answer', { pick: i })}>{o}</button>
          ))}
          {wordsFor && (
            <form className="visited-words-form" onSubmit={(e) => { e.preventDefault(); if (typed) send(wordsFor, { text: typed }); }}>
              <textarea aria-label={wordsFor === 'followup' ? 'Follow up' : 'Your answer'} placeholder={wordsFor === 'followup' ? 'Follow up' : 'Your answer'} rows={2} value={words} onChange={(e) => setWords(e.target.value)} />
              <button type="submit" className="hud-btn green sm" disabled={busy || !typed}>Send</button>
            </form>
          )}
          {heldBack && <p className="set-note">Only a Trusted person can allow or deny here.</p>}
        </div>
      )}
      {error && <p className="visited-error" role="alert">{error}</p>}
    </aside>
  );
}
