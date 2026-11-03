import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Builder } from '../api/types';
import BuilderAvatar from '../hud/BuilderAvatar';
import { CLASS_NAMES, PALETTE, classOf, gearOf, stars } from '../village/look';

const AV = 30;
const ROW = 40; // px per option, for placing the list above the button when there is no room below

function Who({ b }: { b: Builder }) {
  return (
    <>
      <span className="hud-av kb-pick-av"><BuilderAvatar agent={b.agent} model={b.model} effort={b.effort} size={AV} /></span>
      <span className="kb-pick-text">
        <span className="kb-pick-name">{b.name} <span className="hud-stars">{'★'.repeat(stars(gearOf(b.effort)))}</span></span>
        <span className="kb-pick-class">{CLASS_NAMES[classOf(b.agent, b.model)]} · {PALETTE[b.agent].label}</span>
      </span>
    </>
  );
}

/**
 * A builder dropdown that shows each builder's portrait, like the cards along the bottom. The list
 * floats over the page (a column's scroll would clip it) and closes on a pick, Esc, a click away or
 * a scroll.
 */
export default function BuilderPicker({ builders, value, onChange, disabled }: {
  builders: Builder[]; value: string; onChange: (id: string) => void; disabled?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState(0);
  const [at, setAt] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const chosen = builders.find((b) => b.id === value) ?? builders[0];

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const need = Math.min(builders.length * ROW + 12, 320); // the list scrolls past 320px
    setAt(below >= need || below >= r.top
      ? { left: r.left, width: r.width, top: r.bottom + 4 }
      : { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4 });
  }, [open, builders.length]);
  useEffect(() => {
    if (!open) return;
    const shut = () => setOpen(false);
    window.addEventListener('scroll', shut, true);
    window.addEventListener('resize', shut);
    return () => { window.removeEventListener('scroll', shut, true); window.removeEventListener('resize', shut); };
  }, [open]);

  const show = () => { setHot(Math.max(0, builders.findIndex((b) => b.id === chosen?.id))); setOpen(true); };
  const pick = (b: Builder) => { onChange(b.id); setOpen(false); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { show(); return; }
      setHot((h) => (h + (e.key === 'ArrowDown' ? 1 : builders.length - 1)) % builders.length);
    } else if ((e.key === 'Enter' || e.key === ' ') && open) {
      e.preventDefault();
      pick(builders[hot]);
    }
  };

  return (
    <div className="kb-pick">
      <button
        ref={button}
        type="button"
        className="kb-pick-btn"
        role="combobox"
        aria-label="Builder"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
        onBlur={() => setOpen(false)}
      >
        {chosen && <Who b={chosen} />}
        <span className="kb-pick-caret" aria-hidden="true">▾</span>
      </button>
      {open && at && (
        <ul className="kb-pick-list" role="listbox" aria-label="Builders" style={at}>
          {builders.map((b, i) => (
            <li
              key={b.id}
              role="option"
              aria-selected={b.id === chosen?.id}
              className={i === hot ? 'hot' : undefined}
              // keep the focus on the button, so its blur means a click away
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHot(i)}
              onClick={() => pick(b)}
            >
              <Who b={b} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
