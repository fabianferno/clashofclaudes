import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { BorrowRequest, BorrowedSession, LentSession, SentBorrow } from '../api/types';
import { useApp } from '../state/store';

const WAIT: Record<string, string> = { decide: 'Wants a decision', answer: 'Asking you', stuck: 'Stuck', review: 'Finished: press Done when you have the branch' };

function sentLine(r: SentBorrow): string | null {
  switch (r.result) {
    case null:
      return `Waiting for ${r.owner}’s Mac`;
    case 'waiting':
      return `Waiting for ${r.owner} to accept`;
    case 'declined':
      return `${r.owner} declined`;
    case 'expired':
      return 'The request expired';
    case 'busy':
      return `${r.builder} is busy`;
    case 'low':
      return `${r.owner}’s elixir is low`;
    case 'refused':
      return `${r.owner}’s Mac refused it${r.why ? `: ${r.why}` : ''}`;
    case 'failed':
      return `It could not start${r.why ? `: ${r.why}` : ''}`;
    default:
      return null; // started: it is in the borrowed list
  }
}

/**
 * Borrowing, at a glance, under the top bar. For the lender: requests waiting for Accept, and the
 * sessions working for a teammate. For the borrower: builders working for you in other villages,
 * and what came back for the requests you sent. Nothing shown when there is nothing.
 */
export default function BorrowDesk() {
  const [requests, setRequests] = useState<BorrowRequest[]>([]);
  const [lent, setLent] = useState<LentSession[]>([]);
  const [borrowed, setBorrowed] = useState<BorrowedSession[]>([]);
  const [sent, setSent] = useState<SentBorrow[]>([]);

  const read = useCallback(() => {
    ipc.borrowRequests().then(setRequests, () => {});
    ipc.lentSessions().then(setLent, () => {});
    ipc.borrowed().then((b) => { setBorrowed(b); useApp.getState().setBorrowedSessions(b); }, () => {});
    ipc.borrowSent().then(setSent, () => {});
  }, []);

  useEffect(() => {
    let live = true;
    const off: (() => void)[] = [];
    read();
    const hold = (p: Promise<() => void>) => void p.then((u) => (live ? off.push(u) : u()));
    hold(ipc.onBorrowChanged(() => { if (live) read(); }));
    hold(ipc.onVisitsChanged(() => { if (live) read(); }));
    hold(ipc.onBorrowKept((note) => { if (live) useApp.getState().setError(note); }));
    // the borrower's requests are answered on someone else's Mac: look again now and then
    const t = setInterval(() => { if (document.visibilityState === 'visible') ipc.borrowSent().then(setSent, () => {}); }, 15_000);
    return () => { live = false; off.forEach((u) => u()); clearInterval(t); };
  }, [read]);

  const answered = sent.filter((r) => sentLine(r) !== null).slice(-3);
  if (requests.length === 0 && lent.length === 0 && borrowed.length === 0 && answered.length === 0) return null;

  const open = (b: BorrowedSession) => {
    void ipc.visit(b.owner).then((map) => {
      const st = useApp.getState();
      st.setBorrowedFrom(b.owner, map ?? null);
      st.setVisitedSession(b.session);
    }, () => {});
  };

  return (
    <section className="borrow-desk" aria-label="Borrowing">
      {requests.map((r) => (
        <div key={r.id} className="borrow-item ask">
          <b>{r.who} asks to borrow {r.builder} in {r.workspace}</b>
          <pre className="borrow-task">{r.task}</pre>
          <div className="borrow-acts">
            <button type="button" className="hud-btn grey sm" onClick={() => ipc.borrowDecline(r.id).then(setRequests, (e) => useApp.getState().setError(String(e)))}>Decline</button>
            <button type="button" className="hud-btn green sm" onClick={() => ipc.borrowAccept(r.id).then(setRequests, (e) => useApp.getState().setError(String(e)))}>Accept</button>
          </div>
        </div>
      ))}
      {lent.map((l) => (
        <div key={l.session} className="borrow-item">
          <span>Working for {l.handle} on {l.branch}</span>
          {!l.pushed && l.pushError && (
            <>
              <span className="borrow-note">Not pushed yet: {l.pushError}</span>
              <button type="button" className="hud-btn grey sm" onClick={() => ipc.lentPush(l.session).then(setLent, (e) => useApp.getState().setError(String(e)))}>Push again</button>
            </>
          )}
        </div>
      ))}
      {borrowed.map((b) => (
        <button key={`${b.owner}-${b.session}`} type="button" className="borrow-item borrowed" onClick={() => open(b)}>
          <span>{b.builder} · {b.owner}’s · {b.workspace}</span>
          <span className="borrow-note">{b.wait ? WAIT[b.wait] ?? b.wait : 'Working'}</span>
        </button>
      ))}
      {answered.map((r) => (
        <div key={r.request} className="borrow-item">
          <span>{r.builder} · {r.owner}’s · {sentLine(r)}</span>
        </div>
      ))}
    </section>
  );
}
