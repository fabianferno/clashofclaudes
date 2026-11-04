import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../api/ipc';
import type { BugReportInfo } from '../api/types';
import { useApp, type AppState } from '../state/store';
import { captureWindow } from '../screenshot';
import { spritesReady } from '../village/art/sprites';

/** How long the screenshot may take before the dialog opens without one. */
export const CAPTURE_MS = 4000;

const capture = () => captureWindow(undefined, { maxWidth: 1600, type: 'image/jpeg', quality: 0.82 });

/**
 * Opens the bug report dialog with a picture of the window as it is (Settings closed first, so
 * the picture shows what the owner was looking at). Without a picture after CAPTURE_MS it opens anyway.
 */
export async function openBugReport(shoot: () => Promise<string> = capture): Promise<void> {
  const st = useApp.getState();
  if (st.bugReport) return;
  st.setSettingsOpen(false);
  await new Promise((r) => setTimeout(r, 60)); // let the village show again under it
  document.body.style.cursor = 'progress';
  let screenshot: string | null = null;
  try {
    screenshot = (await Promise.race([shoot(), new Promise<string>((r) => setTimeout(() => r(''), CAPTURE_MS))])) || null;
  } catch {
    screenshot = null;
  } finally {
    document.body.style.cursor = '';
  }
  useApp.getState().setBugReport({ screenshot });
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What the frontend adds to a report: nothing the owner typed into tasks, no paths or names. */
export function reportDetails(st: Pick<AppState, 'agents' | 'workspaces' | 'builders' | 'sessions' | 'error'>, art: boolean, win: { w: number; h: number; dpr: number }): Array<[string, string]> {
  const agents = st.agents.filter((a) => a.kind !== 'custom' && a.installed).map((a) => (a.version ? `${a.label} ${a.version.replace(` (${a.label})`, '')}` : a.label));
  const counts = new Map<string, number>();
  for (const s of Object.values(st.sessions)) {
    const k = s.paused ? 'paused' : s.kind.kind === 'terminal' ? 'terminal' : s.state.kind;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out: Array<[string, string]> = [
    ['Agents', agents.join(', ') || 'none installed'],
    ['Village', `${plural(st.workspaces.length, 'workspace')} · ${plural(st.builders.length, 'builder')}`],
    ['Sessions', [...counts].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'],
    ['Window', `${win.w}×${win.h} @${win.dpr}x`],
    ['Art', art ? 'painted' : 'fallback'],
  ];
  if (st.error) out.push(['Last error', st.error.slice(0, 300)]);
  return out;
}

/** Help › Report a Bug… or Settings: what went wrong, sent to the developers' Discord. Esc or Cancel closes it. */
export default function BugReportDialog() {
  const open = useApp((s) => s.bugReport);
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [attach, setAttach] = useState(false);
  const [info, setInfo] = useState<BugReportInfo | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const close = () => useApp.getState().setBugReport(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setText(''); setContact(''); setAttach(false); setSent(false); setErr(null); setSending(false);
    ipc.bugReportInfo().then((i) => live && setInfo(i)).catch(() => live && setInfo({ enabled: false, system: [] }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      useApp.getState().setBugReport(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { live = false; window.removeEventListener('keydown', onKey, true); };
  }, [open]);
  const details = useMemo(
    () => (open ? reportDetails(useApp.getState(), spritesReady(), { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }) : []),
    [open],
  );
  if (!open) return null;

  const shot = open.screenshot;
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setErr(null);
    try {
      await ipc.sendBugReport({ text, contact: contact.trim() || null, details, screenshot: attach ? shot : null });
      setSent(true);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-bg" onClick={close}>
      <div className="agent-dialog bug-dialog" role="dialog" aria-modal="true" aria-labelledby="bug-title" onClick={(e) => e.stopPropagation()}>
        <header className="agent-dialog-head">
          <div>
            <h3 id="bug-title" className="ol">Report a bug</h3>
            <span className="sp-d">Thanks for trying the beta. Reports go to the developers' Discord.</span>
          </div>
          <button type="button" className="agent-dialog-x" aria-label="Close" onClick={close}>×</button>
        </header>
        {sent ? (
          <>
            <p className="bug-sent">Sent. Thank you!</p>
            <div className="sp-btns bug-btns"><button type="button" className="hud-btn blue sm" onClick={close}>Close</button></div>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
            {info && !info.enabled && <div className="panel-warn">This build can't send bug reports.</div>}
            <label className="bug-field">
              <span className="sp-sec">What happened?</span>
              <textarea autoFocus rows={5} value={text} onChange={(e) => setText(e.target.value)}
                placeholder="What you did, what you expected, and what happened instead." />
            </label>
            <label className="bug-field">
              <span className="sp-sec">How can we reach you? (optional)</span>
              <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Discord name or email" />
            </label>
            {shot && (
              <label className="bug-shot">
                <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
                <img src={`data:image/jpeg;base64,${shot}`} alt="The window when you opened this" />
                <span className="sp-d">Attach this screenshot. It shows your village, so check it holds nothing private.</span>
              </label>
            )}
            <details className="bug-details">
              <summary className="sp-d">Also sent: app and system details</summary>
              <dl>
                {[...(info?.system ?? []), ...details].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
            </details>
            {err && <div className="panel-warn">{err}</div>}
            <div className="sp-btns bug-btns">
              <button type="button" className="hud-btn grey sm" onClick={close}>Cancel</button>
              <button type="submit" className="hud-btn blue sm" disabled={!text.trim() || sending || !info?.enabled}>{sending ? 'Sending…' : 'Send report'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
