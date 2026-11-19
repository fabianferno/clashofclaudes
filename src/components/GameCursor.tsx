import { cloneElement, useEffect, useRef } from 'react';
import { settled, smoothing, springStep, tiltFromVelocity } from './gameCursorMath';
import './gameCursor.css';

/**
 * The game's pointer: a chunky golden spearhead, outlined and bevelled like the HUD.
 * Mounted once at the app root. It replaces the OS arrow everywhere except where the OS cursor is
 * the better tool: text fields and the terminal (I-beam), resize handles, and embedded pages.
 *
 * It follows the mouse in one requestAnimationFrame loop that writes a transform (no React render
 * per move) and stops when the pointer is at rest. It tilts toward the direction of travel and
 * springs back upright (gameCursorMath.ts); with reduced motion it only follows.
 *
 * Other code can ask for the OS cursor everywhere for a while (a resize drag) with the
 * `gc-suspend` class on <html>.
 *
 * It has a shape per job (CursorMode): the spearhead, a pointing gauntlet over clickable things,
 * an open one over what can be picked up and a fist while carrying it, and the spearhead with a
 * badge when something is busy or a button is disabled. Code that knows better than the DOM (the
 * village canvas knows what is under the pointer) says so with `data-gc="<mode>"` on an element,
 * or on <html> for everywhere (setCursorHint).
 */

/** Where the OS cursor stays: text entry, the terminal, resize handles (`.gc-native`), embedded pages. */
const NATIVE = [
  'input:not([type=range],[type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=color],[type=file],[type=image])',
  'textarea', '[contenteditable]:not([contenteditable=false])', '.xterm', '.gc-native', 'iframe',
].join(',');
/** What reads as clickable: the cursor brightens and grows a little over it. */
const CLICKABLE = [
  'button:not(:disabled)', 'a[href]', '[role=button]', '[role=tab]', '[role=option]', '[role=radio]', '[role=menuitem]',
  '[role=switch]', '[role=checkbox]', 'summary', 'select:not(:disabled)', 'label[for]', 'input[type=range]:not(:disabled)',
  'input[type=checkbox]:not(:disabled)', 'input[type=radio]:not(:disabled)', 'input[type=submit]:not(:disabled)',
  'input[type=button]:not(:disabled)', 'input[type=color]:not(:disabled)', '.hud-card', '.sp-row',
].join(',');
/** What reads as switched off: the spearhead with a no-entry badge. */
const BLOCKED = 'button:disabled, [aria-disabled=true], select:disabled';

export type CursorMode = 'native' | 'normal' | 'pointer' | 'grab' | 'grabbing' | 'busy' | 'blocked';
const HINTS: readonly string[] = ['normal', 'pointer', 'grab', 'grabbing', 'busy', 'blocked'];
const hintOf = (el: Element | null | undefined): CursorMode | null => {
  const v = el?.getAttribute?.('data-gc');
  return v && HINTS.includes(v) ? (v as CursorMode) : null;
};

/**
 * Ask for a cursor shape over `el` (or, on document.documentElement, everywhere), or drop the ask
 * with null. The game cursor picks it up straight away, without waiting for the pointer to move.
 */
export function setCursorHint(el: Element, mode: Exclude<CursorMode, 'native'> | null) {
  if (mode) el.setAttribute('data-gc', mode);
  else el.removeAttribute('data-gc');
}

/** Which cursor `el` (the element under the pointer) gets; `down` while a button is held. */
export function cursorModeOf(el: Element | null, down = false): CursorMode {
  const global = typeof document !== 'undefined' ? hintOf(document.documentElement) : null;
  if (global) return global;
  if (!el || typeof el.closest !== 'function') return 'normal';
  if (el.closest(NATIVE)) return 'native';
  const hint = hintOf(el.closest('[data-gc]'));
  if (hint) return hint === 'grab' && down ? 'grabbing' : hint;
  if (el.closest(BLOCKED)) return 'blocked';
  if (el.closest(CLICKABLE)) return 'pointer';
  return 'normal';
}

/** The SVG's box in user units: the hotspot, the outline's outermost point at the tip, is (0, 0). */
const VB: Box = { x: -4, y: -3, w: 27, h: 30 };
/**
 * The art is drawn around the gold vertex of the tip; its 2.3-unit round outline sticks out past it
 * along the pointing direction (up-left, 32 degrees off vertical). Shifting by that much puts the
 * outermost dark point, what the eye reads as the tip, exactly on the hotspot.
 */
const TIP_SHIFT = { x: 2.3 * Math.sin((32 * Math.PI) / 180), y: 2.3 * Math.cos((32 * Math.PI) / 180) };
const SCALE = 1.3;
/** A drawing's box in user units, and its px per unit (SCALE unless given). */
type Box = { x: number; y: number; w: number; h: number; s?: number };
/** The pointing gauntlet: the hotspot is the fingertip's outline. */
const HAND_VB: Box = { x: -12, y: -3, w: 28, h: 32, s: 1.15 };
/** The open hand and the fist: the hotspot is the middle of the palm. */
const GRAB_VB: Box = { x: -15, y: -17, w: 27, h: 32, s: 1.15 };
/** The busy and no-entry badges, centred on BADGE_AT (px from the hotspot), under the spearhead's tail. */
const BADGE_VB: Box = { x: -7, y: -7, w: 14, h: 14 };
const BADGE_AT = { x: 19, y: 25 };
/** Time constant of the velocity smoothing, seconds: averages out the jitter of single events. */
const VEL_TAU = 0.06;

export default function GameCursor() {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = layer.current;
    if (!el || typeof window === 'undefined') return;
    const root = document.documentElement;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let still = !!reduced?.matches;
    const onMotionPref = (e: MediaQueryListEvent) => { still = e.matches; kick(); };
    reduced?.addEventListener?.('change', onMotionPref);

    let x = 0, y = 0; // pointer position (client px)
    let dx = 0, dy = 0; // movement since the last frame
    let vx = 0, vy = 0; // smoothed velocity, px/s
    let angle = 0, angVel = 0;
    let shown = false;
    let raf = 0, last = 0;
    let state = ''; // classes last written, so the DOM is touched only on change

    const setState = (visible: boolean, mode: CursorMode, down: boolean) => {
      const next = `${visible ? 'on' : 'off'} ${mode}${down ? ' down' : ''}`;
      if (next === state) return;
      state = next;
      el.classList.toggle('gc-visible', visible);
      for (const m of HINTS) el.classList.toggle(`gc-m-${m}`, m === mode);
      el.classList.toggle('gc-down', down);
    };
    let mode: CursorMode = 'normal';
    let lastTarget: EventTarget | null = null;
    let down = false;
    const visible = () => shown && mode !== 'native' && !root.classList.contains('gc-suspend');
    const classify = () => { mode = cursorModeOf(lastTarget as Element | null, down); };
    const render = () => setState(visible(), mode, down);
    // a hint changed under a still pointer (a drag ended, the canvas found a builder): re-read it
    const hints = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => { classify(); render(); })
      : null;
    hints?.observe(root, { attributes: true, attributeFilter: ['data-gc'], subtree: true });

    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      const k = smoothing(dt, VEL_TAU);
      vx += (dx / dt - vx) * k;
      vy += (dy / dt - vy) * k;
      dx = dy = 0;
      if (still) { angle = 0; angVel = 0; } else ({ angle, vel: angVel } = springStep(angle, angVel, tiltFromVelocity(vx, vy), dt));
      const rest = still || settled(angle, angVel, vx, vy);
      if (rest) { angle = 0; angVel = 0; vx = vy = 0; }
      const dpr = window.devicePixelRatio || 1;
      const px = Math.round(x * dpr) / dpr, py = Math.round(y * dpr) / dpr;
      el.style.transform = `translate3d(${px}px, ${py}px, 0) rotate(${angle.toFixed(2)}deg)`;
      if (!rest) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (raf) return;
      last = performance.now() - 16;
      raf = requestAnimationFrame(frame);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') { shown = false; render(); return; }
      if (shown) { dx += e.clientX - x; dy += e.clientY - y; } // a reappearance is not a fling
      x = e.clientX; y = e.clientY;
      if (!shown) { shown = true; root.classList.add('gc-on'); }
      // classify only when the element under the pointer changes (pointerover always re-checks;
      // hints changing in place are caught by the observer)
      if (e.target !== lastTarget || e.type === 'pointerover') { lastTarget = e.target; classify(); }
      render();
      kick();
    };
    const onDown = (e: PointerEvent) => {
      down = true;
      // a <select> opens a native menu that the page gets no moves over: the OS cursor takes it
      if ((e.target as Element | null)?.closest?.('select')) shown = false;
      classify(); // a press on something that can be picked up closes the hand
      render();
    };
    const onUp = () => { down = false; classify(); render(); };
    const hide = () => { shown = false; down = false; render(); };
    // leaving the window (or into an embedded page, which keeps its own cursor)
    const onOut = (e: PointerEvent) => { if (!e.relatedTarget) hide(); };
    // an unfocused window may stop getting moves: hand back the OS cursor until the next one
    const onBlur = () => { hide(); root.classList.remove('gc-on'); };
    const onDragStart = () => hide(); // a native drag shows the OS cursor and sends no moves

    const opts = { capture: true, passive: true } as const;
    window.addEventListener('pointermove', onMove, opts);
    window.addEventListener('pointerover', onMove, opts); // a new element under a still pointer (or an iframe)
    window.addEventListener('pointerdown', onDown, opts);
    window.addEventListener('pointerup', onUp, opts);
    window.addEventListener('pointercancel', onUp, opts);
    document.addEventListener('pointerout', onOut, opts);
    root.addEventListener('mouseleave', hide);
    window.addEventListener('blur', onBlur);
    window.addEventListener('dragstart', onDragStart, opts);
    return () => {
      cancelAnimationFrame(raf);
      hints?.disconnect();
      reduced?.removeEventListener?.('change', onMotionPref);
      window.removeEventListener('pointermove', onMove, opts);
      window.removeEventListener('pointerover', onMove, opts);
      window.removeEventListener('pointerdown', onDown, opts);
      window.removeEventListener('pointerup', onUp, opts);
      window.removeEventListener('pointercancel', onUp, opts);
      document.removeEventListener('pointerout', onOut, opts);
      root.removeEventListener('mouseleave', hide);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('dragstart', onDragStart, opts);
      root.classList.remove('gc-on');
    };
  }, []);

  return (
    <div ref={layer} className="game-cursor" aria-hidden="true" data-testid="game-cursor">
      <div className="gc-inner">
        <svg width="0" height="0" style={{ position: 'absolute' }}><Gradients /></svg>
        <Art cls="gc-arrow" box={VB}>
          <g transform={`translate(${TIP_SHIFT.x.toFixed(2)} ${TIP_SHIFT.y.toFixed(2)})`}><CursorArt /></g>
        </Art>
        <Art cls="gc-pointer" box={HAND_VB}><PointerArt /></Art>
        <Art cls="gc-grab" box={GRAB_VB}><GrabArt /></Art>
        <Art cls="gc-grabbing" box={GRAB_VB}><GrabbingArt /></Art>
        <Art cls="gc-badge gc-busy" box={BADGE_VB} at={BADGE_AT}><BusyBadge /></Art>
        <Art cls="gc-badge gc-blocked" box={BADGE_VB} at={BADGE_AT}><BlockedBadge /></Art>
      </div>
    </div>
  );
}

/**
 * Drawn with the tip at (0, 0) pointing straight up, then turned 32 degrees anticlockwise so it
 * points up-left like an arrow cursor. Layers: the drop lip (a solid offset shadow, like the HUD's
 * buttons), the thick dark outline, then the two-tone spearhead (lit
 * facet on the left, as the light comes from the top-left) with a bevel highlight.
 */
function CursorArt() {
  const head = 'M0 0 L-9 20 L-3.2 16.5 L3.2 16.5 L9 20 Z';
  const silhouette = (
    <>
      <path d={head} />
    </>
  );
  return (
    <>
      <g className="gc-shadow" fill="#1d130b" stroke="#1d130b" strokeWidth={4.6} strokeLinejoin="round">
        <g transform="rotate(-32)">{silhouette}</g>
      </g>
      <g transform="rotate(-32)" strokeLinejoin="round" strokeLinecap="round">
        <g fill="#1d130b" stroke="#1d130b" strokeWidth={4.6}>{silhouette}</g>
        {/* spearhead: lit and shaded facets meeting on a ridge */}
        <path d="M0 0 L-9 20 L-3.2 16.5 L0 14 Z" fill="url(#gc-lit)" />
        <path d="M0 0 L0 14 L3.2 16.5 L9 20 Z" fill="url(#gc-shade)" />
        <path d={head} fill="none" stroke="#1d130b" strokeWidth={1} />
        <path d="M0 1.5 L0 13.2" stroke="#b87400" strokeWidth={0.8} opacity={0.7} />
        <path d="M-1 3.4 L-6.6 16.6" stroke="#fff" strokeWidth={1.2} opacity={0.85} />
        <path d="M1 3.4 L7 17.2" stroke="#8a5200" strokeWidth={0.8} opacity={0.45} />
      </g>
    </>
  );
}

/** One drawing in the cursor layer, placed so its (0, 0) sits on the hotspot (plus `at`, px). */
function Art({ cls, box, at, children }: { cls: string; box: Box; at?: { x: number; y: number }; children: React.ReactNode }) {
  const k = box.s ?? SCALE;
  const left = (at?.x ?? 0) + box.x * k, top = (at?.y ?? 0) + box.y * k;
  return (
    <svg
      className={`gc-svg ${cls}`}
      width={box.w * k}
      height={box.h * k}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      style={{ left, top, transformOrigin: `${-left}px ${-top}px` }}
    >
      {children}
    </svg>
  );
}

/** Shared by every drawing (ids are document-wide). */
function Gradients() {
  return (
    <defs>
      <linearGradient id="gc-lit" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff6c2" />
        <stop offset="0.55" stopColor="#ffd84a" />
        <stop offset="1" stopColor="#ffc61a" />
      </linearGradient>
      <linearGradient id="gc-shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#f5b100" />
        <stop offset="1" stopColor="#c27a00" />
      </linearGradient>
    </defs>
  );
}

const INK = '#1d130b';
type Part = { el: React.ReactElement<React.SVGProps<SVGElement>>; shade?: boolean };

/**
 * A gauntlet drawn like the spearhead: the drop lip, one thick outline around every part (so they
 * read as one shape), then each part filled in order with a thin seam where it overlaps the last.
 */
function Gauntlet({ parts, shine }: { parts: Part[]; shine?: React.ReactNode }) {
  const each = (p: Part, i: number, props: React.SVGProps<SVGElement>) => cloneElement(p.el, { key: i, ...props });
  return (
    <g strokeLinejoin="round" strokeLinecap="round">
      <g className="gc-shadow" fill={INK} stroke={INK} strokeWidth={4.2}>{parts.map((p, i) => each(p, i, {}))}</g>
      <g fill={INK} stroke={INK} strokeWidth={4.2}>{parts.map((p, i) => each(p, i, {}))}</g>
      {parts.map((p, i) => each(p, i, { fill: `url(#${p.shade ? 'gc-shade' : 'gc-lit'})`, stroke: INK, strokeWidth: 0.9 }))}
      {shine}
    </g>
  );
}

/** A gauntlet with the index finger up (tilted a little left), the others curled: "click me". */
function PointerArt() {
  const parts: Part[] = [
    { el: <rect x={-2.7} y={0} width={5.4} height={14} rx={2.7} /> },
    { el: <rect x={2.2} y={8.2} width={3.6} height={7} rx={1.8} /> },
    { el: <rect x={5.4} y={9} width={3.6} height={7} rx={1.8} /> },
    { el: <rect x={8.4} y={10.2} width={3.2} height={6.4} rx={1.6} /> },
    { el: <rect x={-2.7} y={11.5} width={14.3} height={10} rx={3.5} /> },
    { el: <rect x={-8} y={11} width={8} height={4.6} rx={2.3} transform="rotate(28 0 13)" /> },
    { el: <rect x={-3.4} y={20.5} width={15.6} height={5} rx={1.8} />, shade: true },
  ];
  return (
    <g transform="translate(0.56 2.23) rotate(-14)">
      <Gauntlet parts={parts} shine={<path d="M-1.3 2.6 L-1.3 10.5" stroke="#fff" strokeWidth={1.2} opacity={0.85} />} />
    </g>
  );
}

/** An open gauntlet, fingers spread: "you can pick this up". */
function GrabArt() {
  const parts: Part[] = [
    { el: <rect x={-6.2} y={-12} width={3.4} height={13} rx={1.7} /> },
    { el: <rect x={-2.7} y={-13.5} width={3.4} height={14} rx={1.7} /> },
    { el: <rect x={0.8} y={-12.5} width={3.4} height={13} rx={1.7} /> },
    { el: <rect x={4.2} y={-9.5} width={3} height={10} rx={1.5} /> },
    { el: <rect x={-6.2} y={-3} width={13.4} height={11} rx={3.8} /> },
    { el: <rect x={-12} y={-1} width={8} height={4.4} rx={2.2} transform="rotate(30 -5 1)" /> },
    { el: <rect x={-6.8} y={7} width={14.6} height={4.8} rx={1.8} />, shade: true },
  ];
  return <Gauntlet parts={parts} shine={<path d="M-4.9 -10 L-4.9 -3.5" stroke="#fff" strokeWidth={1.1} opacity={0.85} />} />;
}

/** The gauntlet closed: carrying something. */
function GrabbingArt() {
  const parts: Part[] = [
    { el: <rect x={-6.2} y={-6.5} width={3.5} height={6} rx={1.75} /> },
    { el: <rect x={-2.8} y={-7} width={3.5} height={6} rx={1.75} /> },
    { el: <rect x={0.6} y={-6.6} width={3.5} height={6} rx={1.75} /> },
    { el: <rect x={3.9} y={-5.6} width={3.2} height={5.4} rx={1.6} /> },
    { el: <rect x={-6.2} y={-3.5} width={13.4} height={10.5} rx={3.8} /> },
    { el: <rect x={-7.6} y={-0.2} width={8.5} height={3.8} rx={1.9} transform="rotate(-8 -3 2)" /> },
    { el: <rect x={-6.8} y={6} width={14.6} height={4.8} rx={1.8} />, shade: true },
  ];
  return <Gauntlet parts={parts} />;
}

/** A spinning ring: something is working. */
function BusyBadge() {
  return (
    <g>
      <circle r={5.2} fill="#fff8e8" stroke={INK} strokeWidth={1.8} />
      <g className="gc-spin">
        <circle r={3} fill="none" stroke="#e6d5b0" strokeWidth={1.6} />
        <path d="M0 -3 A3 3 0 0 1 3 0" fill="none" stroke="#e08a12" strokeWidth={1.9} strokeLinecap="round" />
      </g>
    </g>
  );
}

/** A no-entry sign: this is switched off. */
function BlockedBadge() {
  return (
    <g strokeLinecap="round">
      <circle r={5.2} fill="#fff8e8" stroke={INK} strokeWidth={1.8} />
      <circle r={3.2} fill="none" stroke="#e5402f" strokeWidth={1.7} />
      <path d="M-2.2 -2.2 L2.2 2.2" stroke="#e5402f" strokeWidth={1.7} />
    </g>
  );
}
