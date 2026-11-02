import { useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { browserUrl, useApp } from '../state/store';

/**
 * Full-window app preview, opened from a board or a workspace's + Browser. The address can be
 * edited (Enter goes there; a browser the owner opened takes its board along). ✕ or Esc closes it;
 * Esc in the address puts it back instead.
 */
export default function PopOutApp() {
  const app = useApp((s) => s.appPopout);
  const close = useApp((s) => s.setAppPopout);
  const frame = useRef<HTMLIFrameElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [addr, setAddr] = useState('');
  const [bad, setBad] = useState(false);
  useEffect(() => { setAddr(app?.url ?? ''); setBad(false); }, [app?.url]);
  const open = !!app;
  useEffect(() => (open ? useApp.getState().cover() : undefined), [open]);
  useEffect(() => {
    if (!app) return;
    // keys typed inside the page stay in the page; this only sees them with focus outside it
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (document.activeElement === field.current) {
        setAddr(app.url);
        setBad(false);
        field.current?.blur();
        return;
      }
      close(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [app, close]);
  if (!app) return null;

  const go = () => {
    const url = browserUrl(addr);
    if (!url) { setBad(true); return; }
    setBad(false);
    if (app.browserId) useApp.getState().setBrowserUrl(app.browserId, url);
    if (url === app.url && frame.current) frame.current.src = url; // same address: load it again
    // an opened browser is named by its host, so it follows the address
    else close({ ...app, url, title: app.browserId ? new URL(url).hostname : app.title });
    field.current?.blur();
  };

  return (
    <div className="popout" role="dialog" aria-label="App">
      <header className="popout-head">
        <h2 className="ol">{app.title}</h2>
        <form className="popout-addr" onSubmit={(e) => { e.preventDefault(); go(); }}>
          <input
            ref={field}
            aria-label="Address"
            aria-invalid={bad}
            value={addr}
            spellCheck={false}
            onChange={(e) => { setAddr(e.target.value); setBad(false); }}
            onFocus={(e) => e.target.select()}
          />
        </form>
        <button className="hud-btn grey sm" onClick={() => { if (frame.current) frame.current.src = app.url; }}>Reload</button>
        <button
          className="hud-btn blue sm"
          onClick={() => { openUrl(app.url).catch((e) => useApp.getState().setError(`Could not open ${app.url}: ${String(e)}`)); }}
        >
          Open in browser
        </button>
        {app.key && (
          <button className="hud-btn red sm" title={app.browserId ? 'Close this browser' : 'Hide this board until the app stops'}
            onClick={() => useApp.getState().removeBoard({ key: app.key!, browserId: app.browserId })}>Remove board</button>
        )}
        <button className="hud-btn grey sm" aria-label="Close app" onClick={() => close(null)}>✕</button>
      </header>
      <div className="popout-body">
        {/* no navigating the village away from inside the page */}
        <iframe
          ref={frame}
          className="popout-app"
          title={app.title}
          src={app.url}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
        />
      </div>
    </div>
  );
}
