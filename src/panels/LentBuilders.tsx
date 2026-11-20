import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { Lend, Lending } from '../api/types';

const MEANS = 'Lending means a teammate’s words run on this Mac, with your logins, without anyone here looking first. Their builder works in a worktree of its own, and only its branch is pushed.';
const ASK = 'Shows you the first task only; follow-ups go straight to the builder.';

/**
 * Settings › Team › Lent builders: which builders teammates may borrow, to whom, where, down to
 * how much elixir, and whether the first task waits for you. Kept in the Keychain on this Mac.
 */
export default function LentBuilders() {
  const [data, setData] = useState<Lending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [floors, setFloors] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    ipc.lending().then((d) => { if (live) setData(d); }, (e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, []);

  const save = (builder: string, lend: Lend | null) => {
    setBusy(true);
    setError(null);
    ipc.lendSet(builder, lend).then(setData, (e) => setError(String(e))).finally(() => setBusy(false));
  };

  if (!data) return <div className="set-note" role={error ? 'alert' : 'status'}>{error ?? 'Looking at your builders…'}</div>;
  const lendable = data.workspaces.filter((w) => w.lendable).map((w) => w.id);
  const toggle = (list: string[] | null, all: string[], id: string): string[] => {
    const now = list ?? all;
    return now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
  };

  return (
    <>
      <div className="set-line"><span className="set-label">Lent builders</span></div>
      {data.mates.length === 0 && <div className="set-note">Pair a teammate’s Mac in People first: only paired Macs can borrow.</div>}
      {data.builders.map(({ builder, name, lend }) => (
        <div key={builder} className="set-lend">
          <label className="set-row">
            <input type="checkbox" className="set-switch" aria-label={`Lend ${name}`} checked={lend !== null} disabled={busy}
              onChange={(e) => save(builder, e.target.checked ? { builder, keys: null, workspaces: null, floor: data.reserve, ask: false } : null)} />
            <span className="set-text">
              <span className="set-label">{name}</span>
              <span className="set-hint">{lend ? 'Lent. A borrow starts on its own and tells you.' : MEANS}</span>
            </span>
          </label>
          {lend && (
            <div className="set-lend-body">
              <div className="set-hint">{MEANS}</div>
              <div className="set-picks">
                <label>
                  <input type="checkbox" aria-label={`${name}: lent to everyone whose Mac is paired`} checked={lend.keys === null} disabled={busy}
                    onChange={(e) => save(builder, { ...lend, keys: e.target.checked ? null : [] })} />
                  Everyone whose Mac is paired
                </label>
                {data.mates.map((m) => (
                  <label key={m.key}>
                    <input type="checkbox" aria-label={`${name}: lent to ${m.handle}`} checked={lend.keys === null || lend.keys.includes(m.key)} disabled={busy || lend.keys === null}
                      onChange={() => save(builder, { ...lend, keys: toggle(lend.keys, data.mates.map((x) => x.key), m.key) })} />
                    {m.handle}
                  </label>
                ))}
              </div>
              <div className="set-picks">
                <label>
                  <input type="checkbox" aria-label={`${name}: works in every shared workspace`} checked={lend.workspaces === null} disabled={busy}
                    onChange={(e) => save(builder, { ...lend, workspaces: e.target.checked ? null : [] })} />
                  Every shared workspace that can be lent
                </label>
                {data.workspaces.map((w) => (
                  <label key={w.id} title={w.why ?? undefined}>
                    <input type="checkbox" aria-label={`${name}: works in ${w.name}`} disabled={busy || !w.lendable || lend.workspaces === null}
                      checked={w.lendable && (lend.workspaces === null || lend.workspaces.includes(w.id))}
                      onChange={() => save(builder, { ...lend, workspaces: toggle(lend.workspaces, lendable, w.id) })} />
                    {w.name}{w.why && <span className="set-hint"> ({w.why})</span>}
                  </label>
                ))}
              </div>
              <label className="set-row set-name">
                <span className="set-text">
                  <span className="set-label">Elixir floor</span>
                  <span className="set-hint">At or under this much left, requests are refused. 0: no floor.</span>
                </span>
                <input type="number" min={0} max={90} aria-label={`${name}: elixir floor`} value={floors[builder] ?? String(lend.floor)} disabled={busy}
                  onChange={(e) => setFloors({ ...floors, [builder]: e.target.value })}
                  onBlur={() => {
                    const v = Math.max(0, Math.min(90, Math.round(Number(floors[builder] ?? lend.floor)) || 0));
                    setFloors(({ [builder]: _, ...rest }) => rest);
                    if (v !== lend.floor) save(builder, { ...lend, floor: v });
                  }} />
              </label>
              <label className="set-row">
                <input type="checkbox" className="set-switch" aria-label={`${name}: ask me first`} checked={lend.ask} disabled={busy}
                  onChange={(e) => save(builder, { ...lend, ask: e.target.checked })} />
                <span className="set-text">
                  <span className="set-label">Ask me first</span>
                  <span className="set-hint">{ASK}</span>
                </span>
              </label>
            </div>
          )}
        </div>
      ))}
      {error && <div className="set-note set-bad" role="alert">{error}</div>}
    </>
  );
}
