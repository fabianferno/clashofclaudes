import { useEffect, useRef } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useApp } from '../state/store';

/** Full-window app preview, opened from an app board. ✕ or Esc (with focus outside the page) closes it. */
export default function PopOutApp() {
  const app = useApp((s) => s.appPopout);
  const close = useApp((s) => s.setAppPopout);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!app) return;
    // keys typed inside the page stay in the page; this only sees them with focus outside it
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      close(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [app, close]);
  if (!app) return null;

  return (
    <div className="popout" role="dialog" aria-label="App">
      <header className="popout-head">
        <h2 className="ol">{app.title}</h2>
        <span className="popout-hint">{app.url}</span>
        <button className="hud-btn grey sm" onClick={() => { if (frame.current) frame.current.src = app.url; }}>Reload</button>
        <button
          className="hud-btn blue sm"
          onClick={() => { openUrl(app.url).catch((e) => useApp.getState().setError(`Could not open ${app.url}: ${String(e)}`)); }}
        >
          Open in browser
        </button>
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
