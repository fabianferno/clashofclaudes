import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { VisitedBuilder as Visited } from '../api/types';
import { useApp } from '../state/store';

const WAIT: Record<string, string> = { decide: 'Wants a decision', answer: 'Asking its owner', stuck: 'Stuck', review: 'Ready to review' };

/** `**Wizard** (Claude Code): add a CSV export` as its parts. */
function parts(title: string): { who: string; rest: string } {
  const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(title);
  return m ? { who: m[1], rest: m[2].replace(/^:\s*/, '') } : { who: 'A builder', rest: title };
}

/**
 * A builder in the village you are visiting: what it works on and what it waits for, read from
 * its thread on the board. To look at, not to act on.
 */
export default function VisitedBuilder() {
  const visiting = useApp((s) => s.visiting);
  const id = useApp((s) => s.visitedSession);
  const [data, setData] = useState<Visited | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'closed' | 'none'>('loading');
  const session = visiting?.map.sessions.find((s) => s.i === id);
  const root = session?.r ?? null;
  const owner = visiting?.owner;

  useEffect(() => {
    if (!owner || !id) return;
    setData(null);
    if (!root) { setState('none'); return; }
    let live = true;
    setState('loading');
    ipc.visitBuilder(owner, root).then(
      (d) => { if (live) { setData(d); setState(d ? 'ready' : 'closed'); } },
      () => { if (live) setState('closed'); },
    );
    return () => { live = false; };
  }, [owner, id, root]);

  if (!visiting || !id || !session) return null;
  const builder = visiting.map.builders.find((b) => b.p === session.b);
  const title = data ? parts(data.title) : { who: builder?.n ?? 'A builder', rest: '' };
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
      {data?.question ? <p className="visited-ask">{data.question}</p> : data?.words && <p className="visited-words">{data.words}</p>}
      {data?.options && <ul className="visited-options">{data.options.map((o) => <li key={o}>{o}</li>)}</ul>}
    </aside>
  );
}
