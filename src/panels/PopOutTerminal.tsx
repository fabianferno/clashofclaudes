import { useEffect, useRef } from 'react';
import TerminalView from '../components/LazyTerminalView';
import { useApp } from '../state/store';

/** Full-window terminal. ✕ always closes it; Esc closes it only when focus is outside the terminal (inside, Esc belongs to the program). */
export default function PopOutTerminal({ sessionId, readOnly, title, onClose }: {
  sessionId: string; readOnly?: boolean; title: string; onClose: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => useApp.getState().cover(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (body.current?.contains(document.activeElement)) return; // Esc goes to the terminal untouched
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="popout" role="dialog" aria-label="Terminal">
      <header className="popout-head">
        <h2 className="ol">{title}</h2>
        <span className="popout-hint">⌘+ / ⌘− text size · ✕ to return</span>
        <button className="hud-btn grey sm" aria-label="Close terminal" onClick={onClose}>✕</button>
      </header>
      <div className="popout-body" ref={body}>
        <TerminalView sessionId={sessionId} readOnly={readOnly} />
      </div>
    </div>
  );
}
