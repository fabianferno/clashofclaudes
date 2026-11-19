import { useEffect, useMemo, useState } from 'react';
import { setCursorHint } from '../components/GameCursor';
import { ipc } from '../api/ipc';
import type { BugReportInfo, ReportKind } from '../api/types';
import { useApp, type AppState } from '../state/store';
import { captureWindow } from '../screenshot';
import { spritesReady } from '../village/art/sprites';

/** How long the screenshot may take before the dialog opens without one. */
export const CAPTURE_MS = 4000;

const capture = () => captureWindow(undefined, { maxWidth: 1600, type: 'image/jpeg', quality: 0.82 });

/**
 * Opens the report dialog, on a bug or a feature request, with a picture of the window as it is (Settings
 * closed first, so the picture shows what the owner was looking at). Without a picture after CAPTURE_MS it opens anyway.
 */
export async function openBugReport(kind: ReportKind = 'bug', shoot: () => Promise<string> = capture): Promise<void> {
  const st = useApp.getState();
  if (st.bugReport) return;
  st.setSettingsOpen(false);
  await new Promise((r) => setTimeout(r, 60)); // let the village show again under it
  document.body.style.cursor = 'progress';
  setCursorHint(document.documentElement, 'busy');
  let screenshot: string | null = null;
  try {
    screenshot = (await Promise.race([shoot(), new Promise<string>((r) => setTimeout(() => r(''), CAPTURE_MS))])) || null;
  } catch {
    screenshot = null;
  } finally {
    document.body.style.cursor = '';
    setCursorHint(document.documentElement, null);
  }
  useApp.getState().setBugReport({ screenshot, kind });
}

/** What the dialog says for each kind. */
const COPY: Record<ReportKind, { title: string; ask: string; placeholder: string }> = {
  bug: { title: 'Report a bug', ask: 'What happened?', placeholder: 'What you did, what you expected, and what happened instead.' },
  feature: { title: 'Request a feature', ask: 'What would you like?', placeholder: 'What you want to do, and how it would help you.' },
};

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

/** Help menu or Settings: what went wrong or what's wanted, sent to the developers' Discord. Esc or Cancel closes it. */
export default function BugReportDialog() {
  const open = useApp((s) => s.bugReport);
  const [kind, setKind] = useState<ReportKind>('bug');
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
    setKind(open.kind); setText(''); setContact(''); setAttach(false); setSent(false); setErr(null); setSending(false);
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
      await ipc.sendBugReport({ kind, text, contact: contact.trim() || null, details, screenshot: attach ? shot : null });
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
            <h3 id="bug-title" className="ol">{COPY[kind].title}</h3>
            <span className="sp-d">Thanks for trying the beta. It goes to the developers' Discord.</span>
          </div>
          <button type="button" className="agent-dialog-x" aria-label="Close" onClick={close}>×</button>
        </header>
        {sent ? (
          <div className="bug-done" role="status">
            <div className="bug-done-badge" aria-hidden="true">✓</div>
            <p className="bug-sent">Sent. Thank you!</p>
            <p className="sp-d">The developers will read it in Discord{contact.trim() ? ", and may reply to you there." : "."}</p>
            <div className="sp-btns bug-btns bug-btns-center"><button type="button" className="hud-btn blue sm" autoFocus onClick={close}>Close</button></div>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void send(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}>
            {info && !info.enabled && <div className="panel-warn">This build can't send reports.</div>}
            <div className="bug-kind" role="radiogroup" aria-label="Kind of report">
              {(['bug', 'feature'] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>
                  {k === 'bug' ? 'Bug' : 'Feature request'}
                </button>
              ))}
            </div>
            <label className="bug-field">
              <span className="sp-sec">{COPY[kind].ask} <b className="bug-req">required</b></span>
              <textarea autoFocus rows={5} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={COPY[kind].placeholder} />
            </label>
            <label className="bug-field">
              <span className="sp-sec">How can we reach you? <i className="bug-opt">optional</i></span>
              <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Discord name or email" />
            </label>
            {shot && (
              <label className="bug-shot">
                <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
                <img src={`data:image/jpeg;base64,${shot}`} alt="The window when you opened this" />
                <span className="bug-shot-text">
                  <span className="sp-t">Attach a screenshot</span>
                  <span className="sp-d">It shows your village, so check it holds nothing private.</span>
                </span>
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
              <span className="sp-d bug-hint">⌘↵ to send</span>
              <button type="submit" className="hud-btn blue sm" disabled={!text.trim() || sending || !info?.enabled}>{sending ? 'Sending…' : 'Send'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
