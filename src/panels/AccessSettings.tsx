import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { AccessStatus, Level } from '../api/types';
import { useApp } from '../state/store';

const LEVELS: { value: Level; label: string; can: string }[] = [
  { value: 'visitor', label: 'Visitor', can: 'sees builders and what they wait for' },
  { value: 'helper', label: 'Helper', can: 'also answers questions and sends follow-ups' },
  { value: 'trusted', label: 'Trusted', can: 'also allows and denies tool calls' },
];

function LevelSelect({ label, value, disabled, onChange }: { label: string; value: Level; disabled?: boolean; onChange: (l: Level) => void }) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Level)}>
      {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
    </select>
  );
}

/**
 * Settings › Team: Private village and People. Everything shown is what the board says now; a
 * click asks the board to change, and the answer is what is drawn.
 */
export default function AccessSettings() {
  const shared = useApp((s) => s.workspaces).filter((w) => w.boardShared);
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [level, setLevel] = useState<Level>('visitor');
  const [some, setSome] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    ipc.accessStatus().then((s) => { if (live) setStatus(s); }, (e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, []);

  const run = (f: () => Promise<AccessStatus>, then?: () => void) => {
    setBusy(true);
    setError(null);
    f().then((s) => { setStatus(s); then?.(); }, (e) => setError(String(e))).finally(() => setBusy(false));
  };

  if (!status) return <div className="set-note" role={error ? 'alert' : 'status'}>{error ?? 'Asking the board who can see your village…'}</div>;

  const closed = status.state === 'closed';
  const nameOf = (id: string) => shared.find((w) => w.id === id)?.name ?? 'a workspace no longer shared';
  const invite = () => run(() => ipc.invitePut(email.trim(), level, some ? picked : null), () => { setEmail(''); setPicked([]); setSome(false); setLevel('visitor'); });

  return (
    <>
      <label className="set-row">
        <input type="checkbox" className="set-switch" checked={closed} disabled={busy || !status.canClose} onChange={(e) => run(() => ipc.accessSetPrivate(e.target.checked))} />
        <span className="set-text">
          <span className="set-label">Private village</span>
          <span className="set-hint">{closed ? 'Only the people you invite can see your village on the board.' : 'Closes your village to everyone on the team you did not invite.'}</span>
        </span>
      </label>
      {!status.canClose && (
        <>
          <div className="set-note">
            {closed
              ? 'An owner of your Vercel team closed your village for you. Only an owner of your Vercel team can open it again.'
              : 'Only an owner of your Vercel team can close a village. Until one does, everyone on the team can see yours. An owner can run this for you:'}
            {status.refused && ` The board said: ${status.refused}`}
          </div>
          {status.command && !closed && (
            <div className="set-line">
              <code className="set-cmd">{status.command}</code>
              <button type="button" className="hud-btn grey sm" onClick={() => void navigator.clipboard?.writeText(status.command ?? '')}>Copy</button>
            </div>
          )}
          <div className="set-line">
            <span className="set-note">Done? Look again.</span>
            <button type="button" className="hud-btn green sm" disabled={busy} onClick={() => run(() => ipc.accessSetPrivate(true))}>Check again</button>
          </div>
        </>
      )}
      {status.state === 'unknown' && <div className="set-note">The board's access rules could not be read just now.</div>}
      {status.drift && (
        <div className="set-line">
          <span className="set-note set-bad" role="alert">{status.drift} Someone changed the board's access rules; your own agents can, since they use your Vercel login.</span>
          <button type="button" className="hud-btn green sm" disabled={busy} onClick={() => run(() => ipc.accessPutBack())}>Put it back</button>
        </div>
      )}
      {status.who.length > 0 && (
        <div className="set-note">
          Who can see this village now:
          <ul className="set-who" aria-label="Who can see this village now">
            {status.who.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}

      <div className="set-line"><span className="set-label">People</span></div>
      {status.invites.map((i) => (
        <div className="set-line" key={i.email}>
          <span className="set-text">
            <span className="set-label">{i.email}</span>
            <span className="set-hint">
              {i.workspaces ? `${i.workspaces.map(nameOf).join(', ')} only` : 'All shared workspaces'}
              {i.level !== 'visitor' && '. A Visitor until their Mac is paired'}
              {!i.onBoard && '. Not on the board: press Put it back'}
            </span>
          </span>
          <LevelSelect label={`Level for ${i.email}`} value={i.level} disabled={busy} onChange={(l) => run(() => ipc.invitePut(i.email, l, i.workspaces))} />
          <button type="button" className="hud-btn grey sm" aria-label={`Remove ${i.email}`} disabled={busy} onClick={() => run(() => ipc.inviteRemove(i.email))}>Remove</button>
        </div>
      ))}
      <div className="set-line set-invite">
        <input type="email" aria-label="Their Vercel email" placeholder="teammate@company.com" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
        <LevelSelect label="Level for a new invite" value={level} onChange={setLevel} />
        <button type="button" className="hud-btn green sm" disabled={busy || !email.trim() || (some && picked.length === 0)} onClick={invite}>Invite</button>
      </div>
      <div className="set-note">{LEVELS.find((l) => l.value === level)?.label}: {LEVELS.find((l) => l.value === level)?.can}.</div>
      {shared.length > 1 && (
        <>
          <label className="set-row">
            <input type="checkbox" checked={some} onChange={(e) => setSome(e.target.checked)} />
            <span className="set-text"><span className="set-label">Only some workspaces</span></span>
          </label>
          {some && (
            <div className="set-line set-picks">
              {shared.map((w) => (
                <label key={w.id}>
                  <input type="checkbox" aria-label={w.name} checked={picked.includes(w.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, w.id] : picked.filter((id) => id !== w.id))} />
                  {w.name}
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {error && <div className="set-note set-bad" role="alert">{error}</div>}
    </>
  );
}
