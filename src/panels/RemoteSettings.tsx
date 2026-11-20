import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { ipc } from '../api/ipc';
import type { RemoteStatus } from '../api/types';
import { waitedLabel } from '../state/queue';
import { DEFAULT_SETTINGS } from '../state/settings';
import { useApp } from '../state/store';

/** The address as a QR code, for the phone's camera. */
function Qr({ text }: { text: string }) {
  const { path, size } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + 2} ${y + 2}h1v1h-1z`;
    return { path: d, size: n + 4 };
  }, [text]);
  return (
    <svg className="set-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`QR code for ${text}`} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#1d130b" />
    </svg>
  );
}

const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
const used = (ms: number) => (ms ? `used ${waitedLabel(Date.now() - ms) === 'just now' ? 'just now' : `${waitedLabel(Date.now() - ms)} ago`}` : 'never used');

/**
 * Settings › Team › Phone remote: put the remote on the team's Vercel account (or use the one
 * that is there), pair phones with this Mac, and see who is paired. `enabled` is the one setting
 * the window owns; everything else is the app's and arrives as status.
 */
export default function RemoteSettings({ enabled, onEnabled }: { enabled: boolean; onEnabled: (on: boolean) => void }) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [found, setFound] = useState<string | null | undefined>(undefined);
  const [deployed, setDeployed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState('');

  useEffect(() => {
    let live = true;
    const off: (() => void)[] = [];
    ipc.remoteStatus().then((s) => { if (live) setStatus(s); }, () => {});
    void ipc.onRemoteChanged((s) => { if (live) setStatus(s); }).then((u) => (live ? off.push(u) : u()));
    // the app turns the switch on itself after a deploy: the window's copy must follow, or its next save would undo it
    void ipc.onSettingsChanged((s) => { if (live) useApp.getState().setSettings({ ...DEFAULT_SETTINGS, ...s }); }).then((u) => (live ? off.push(u) : u()));
    void ipc.onRemoteProgress((m) => { if (live) setProgress(m); }).then((u) => (live ? off.push(u) : u()));
    return () => { live = false; off.forEach((u) => u()); };
  }, []);

  const url = status?.url ?? null;
  // not set up: does the team already have one?
  useEffect(() => {
    if (!status || url) return;
    let live = true;
    ipc.remoteFind().then((u) => { if (live) setFound(u); }, () => { if (live) setFound(null); });
    return () => { live = false; };
  }, [status === null, url]);
  // set up: is the deployed one older than the one this app carries?
  useEffect(() => {
    if (!url) return;
    let live = true;
    ipc.remoteDeployedVersion().then((v) => { if (live) setDeployed(v); }, () => {});
    return () => { live = false; };
  }, [url]);

  const run = (what: string, f: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    setProgress(null);
    f().then(
      () => ipc.remoteStatus().then(setStatus, () => {}),
      (e) => setError(String(e)),
    ).finally(() => { setBusy(null); setProgress(null); });
  };

  if (!status) return <div className="set-note" role="status">Looking at the phone remote…</div>;

  const trouble = (
    <>
      {busy && <div className="set-note" role="status">{progress ?? `${busy}…`}</div>}
      {error && <div className="set-note set-bad" role="alert">{error}</div>}
      {status.keychainError && <div className="set-note set-bad" role="alert">{status.keychainError}</div>}
    </>
  );

  if (!url) {
    return (
      <>
        <div className="set-line">
          <span className="set-text">
            <span className="set-label">Phone remote</span>
            <span className="set-hint">Answer your builders from your phone.</span>
          </span>
        </div>
        {found === undefined && <div className="set-note" role="status">Looking for your team’s remote…</div>}
        {found && (
          <div className="set-line">
            <span className="set-note">Your team has a remote at {found}.</span>
            <button type="button" className="hud-btn green sm" disabled={!!busy} onClick={() => run('Connecting', () => ipc.remoteConnect(null))}>Use the team’s remote</button>
          </div>
        )}
        {found === null && (
          <div className="set-line">
            <span className="set-note">A small web app goes on your team’s Vercel account, deployed with your own CLI. Whoever can deploy to that project can act as your phone.</span>
            <button type="button" className="hud-btn green sm" disabled={!!busy} onClick={() => run('Deploying', () => ipc.remoteDeploy())}>Deploy the remote</button>
          </div>
        )}
        <label className="set-row set-name">
          <span className="set-text">
            <span className="set-label">Use an address I deployed myself</span>
          </span>
          <input type="text" aria-label="Use an address I deployed myself" placeholder="https://…" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} />
          <button type="button" className="hud-btn grey sm" disabled={!!busy || !address.trim()} onClick={() => run('Connecting', () => ipc.remoteConnect(address.trim()))}>Use this address</button>
        </label>
        {trouble}
      </>
    );
  }

  const p = status.pairing;
  return (
    <>
      <label className="set-row">
        <input type="checkbox" className="set-switch" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
        <span className="set-text">
          <span className="set-label">Phone remote</span>
          <span className="set-hint">{enabled ? 'This Mac takes answers from your paired phones.' : 'Off: phones stay paired, and nothing they send is taken.'}</span>
        </span>
      </label>
      <div className="set-line">
        <code className="set-cmd">{url}</code>
        <button type="button" className="hud-btn grey sm" onClick={() => void navigator.clipboard?.writeText(url)}>Copy</button>
      </div>
      {enabled && !status.listening && <div className="set-note">Not listening to the board right now. It is tried again by itself.</div>}
      {status.paused && (
        <div className="set-line">
          <span className="set-note set-bad" role="alert">{status.paused} Phones cannot act until you trust it.</span>
          <button type="button" className="hud-btn green sm" disabled={!!busy} onClick={() => run('Checking', () => ipc.remoteTrust())}>Trust it</button>
        </div>
      )}
      {status.lastRefusedAt != null && <div className="set-note">Something that is not a paired phone tried to act, {waitedLabel(Date.now() - status.lastRefusedAt)} ago. It was refused.</div>}

      {p.state === 'open' && p.code && (
        <div className="set-pair">
          <Qr text={url} />
          <div className="set-text">
            <span className="set-label">Open the remote on your phone and type this code</span>
            <span className="set-code">{spaced(p.code)}</span>
            <span className="set-hint">On an iPhone, add the page to the Home Screen first and pair from there. The code lasts 5 minutes.</span>
            <button type="button" className="hud-btn grey sm" onClick={() => void ipc.remotePairCancel()}>Cancel</button>
          </div>
        </div>
      )}
      {p.state === 'asking' && (
        <div className="set-line">
          <span className="set-label">{p.name} wants to pair. Does it show {p.check}?</span>
          <button type="button" className="hud-btn green sm" onClick={() => run('Pairing', () => ipc.remotePairConfirm())}>Confirm</button>
          <button type="button" className="hud-btn grey sm" onClick={() => void ipc.remotePairCancel()}>Cancel</button>
        </div>
      )}
      {p.state === 'cancelled' && p.why && <div className="set-note">{p.why}</div>}
      {(p.state === 'idle' || p.state === 'cancelled') && (
        <div className="set-line">
          <span className="set-note">{status.phones.length === 0 ? 'No phone is paired yet.' : 'Pair another phone.'}</span>
          <button type="button" className="hud-btn green sm" disabled={!!busy || !enabled} onClick={() => run('Opening', () => ipc.remotePairStart())}>Pair a phone</button>
        </div>
      )}

      {status.phones.map((ph) => (
        <div className="set-line" key={ph.key}>
          <span className="set-text">
            <span className="set-label">{ph.name}</span>
            <span className="set-hint">{used(ph.lastUsed)}</span>
          </span>
          <button type="button" className="hud-btn grey sm" aria-label={`Remove ${ph.name}`} onClick={() => run('Removing', () => ipc.remoteRemovePhone(ph.key))}>Remove</button>
        </div>
      ))}

      {deployed && deployed !== status.bundledVersion && (
        <div className="set-line">
          <span className="set-note">The deployed remote is version {deployed}; this app carries {status.bundledVersion}. Teammates will be asked to trust the new one.</span>
          <button type="button" className="hud-btn grey sm" disabled={!!busy} onClick={() => run('Deploying', () => ipc.remoteDeploy())}>Update the remote</button>
        </div>
      )}
      {trouble}
    </>
  );
}
