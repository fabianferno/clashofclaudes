import { useEffect } from 'react';
import TerminalView from '../components/TerminalView';

/** Full-window terminal. Esc or ✕ closes it; Esc is consumed here so the side panel stays open. */
export default function PopOutTerminal({ sessionId, readOnly, title, onClose }: {
  sessionId: string; readOnly?: boolean; title: string; onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
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
        <button className="hud-btn grey sm" aria-label="Close terminal" onClick={onClose}>✕</button>
      </header>
      <div className="popout-body">
        <TerminalView sessionId={sessionId} readOnly={readOnly} />
      </div>
    </div>
  );
}
