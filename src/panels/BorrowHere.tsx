import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { LentBuilder } from '../api/types';
import { useApp } from '../state/store';

/**
 * In a village you visit, a click on a workspace's house: the builders its owner lends you
 * there, and a task to hand one. It runs on their Mac, in a worktree of its own.
 */
export default function BorrowHere() {
  const visiting = useApp((s) => s.visiting);
  const slug = useApp((s) => s.borrowHere);
  const [lent, setLent] = useState<LentBuilder[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = visiting?.owner;

  useEffect(() => {
    if (!owner || !slug) return;
    let live = true;
    setLent(null);
    setPick(null);
    setSent(false);
    setError(null);
    ipc.borrowLent(owner, slug).then((l) => { if (live) setLent(l); }, () => { if (live) setLent([]); });
    return () => { live = false; };
  }, [owner, slug]);

  if (!owner || !slug) return null;
  const name = visiting.map.workspaces.find((w) => w.s === slug)?.n ?? slug;
  const close = () => useApp.getState().setBorrowHere(null);
  const send = () => {
    if (!pick || !task.trim()) return;
    setBusy(true);
    setError(null);
    ipc.borrowSend(owner, slug, pick, task.trim()).then(() => { setSent(true); setTask(''); }, (e) => setError(String(e))).finally(() => setBusy(false));
  };

  return (
    <aside className="visited-builder" aria-label="Borrow a builder">
      <header>
        <h3>Borrow a builder in {owner}’s {name}</h3>
        <button type="button" className="hud-btn grey sm" onClick={close}>Close</button>
      </header>
      {lent === null && <p className="set-note" role="status">Looking at what {owner} lends you…</p>}
      {lent?.length === 0 && <p className="set-note">{owner} lends you no builder here.</p>}
      {lent && lent.length > 0 && !sent && (
        <form className="borrow-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <div className="borrow-picks" role="radiogroup" aria-label="Builder">
            {lent.map((b) => (
              <label key={b.profile}>
                <input type="radio" name="borrow-builder" aria-label={b.name} checked={pick === b.profile} onChange={() => setPick(b.profile)} />
                {b.name}
              </label>
            ))}
          </div>
          <textarea aria-label="What should it do?" placeholder="What should it do?" rows={4} value={task} onChange={(e) => setTask(e.target.value)} />
          <p className="set-note">It runs on {owner}’s Mac, in a worktree of its own, and its branch is pushed to their repository’s origin when it finishes.</p>
          <button type="submit" className="hud-btn green sm" disabled={busy || !pick || !task.trim()}>Send</button>
        </form>
      )}
      {sent && <p className="visited-result" role="status">Sent. {owner}’s Mac will answer; you will see it in Borrowing at the top right.</p>}
      {error && <p className="visited-error" role="alert">{error}</p>}
    </aside>
  );
}
