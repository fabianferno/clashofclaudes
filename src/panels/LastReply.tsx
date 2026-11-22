import { useLayoutEffect, useRef, useState } from 'react';
import Markdown from './Markdown';

/**
 * An agent's last reply, kept short so the briefing stays in view; a long one opens to its full
 * height with "Show all". `key` it by session so a new session starts folded.
 */
export default function LastReply({ text, onDoc }: { text: string; onDoc?: (path: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);

  // only offer "Show all" when the folded box actually cuts the reply off
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || open) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 2);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);

  return (
    <>
      <div ref={box} className={`brief-reply${open ? ' open' : ''}`}>
        <Markdown className="md" text={text} onDoc={onDoc} />
      </div>
      {(long || open) && (
        <button type="button" className="brief-less" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  );
}
