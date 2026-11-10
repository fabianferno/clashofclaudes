import { useEffect, useRef } from 'react';
import { HOLD_MS, headingFromVelocity, nearestDeg, settled, shadowOffset, smoothing, springStep, wrapDeg } from './gameCursorMath';
import './gameCursor.css';

/**
 * The game's pointer: a chunky golden spearhead, outlined and bevelled like the HUD.
 * Mounted once at the app root. It replaces the OS arrow everywhere except where the OS cursor is
 * the better tool: text fields and the terminal (I-beam), resize handles, and embedded pages.
 *
 * It follows the mouse in one requestAnimationFrame loop that writes a transform (no React render
 * per move) and stops when the pointer is at rest. It turns on its tip to point where the mouse
 * is going, and swings back to its resting angle a moment after the mouse stops
 * (gameCursorMath.ts); with reduced motion it only follows.
 *
 * Other code can ask for the OS cursor everywhere for a while (a resize drag) with the
 * `gc-suspend` class on <html>.
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

export type CursorMode = 'native' | 'hover' | 'normal';

/** Which cursor `el` (the element under the pointer) gets. */
export function cursorModeOf(el: Element | null): CursorMode {
  if (!el || typeof el.closest !== 'function') return 'normal';
  if (el.closest(NATIVE)) return 'native';
  if (el.closest(CLICKABLE)) return 'hover';
  return 'normal';
}

/** The SVG's box in user units: the hotspot, the outline's outermost point at the tip, is (0, 0). */
const VB = { x: -4, y: -3, w: 27, h: 30 };
/**
 * The art is drawn around the gold vertex of the tip; its 2.3-unit round outline sticks out past it
 * along the pointing direction (up-left, 32 degrees off vertical). Shifting by that much puts the
 * outermost dark point, what the eye reads as the tip, exactly on the hotspot.
 */
const TIP_SHIFT = { x: 2.3 * Math.sin((32 * Math.PI) / 180), y: 2.3 * Math.cos((32 * Math.PI) / 180) };
const SCALE = 1.3;
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
    let aim = 0; // the angle it is turning toward
    let movedAt = 0; // when the mouse last moved fast enough to point somewhere (ms)
    let written = '', shadowFor = NaN; // what the DOM holds, so it is written only on change
    let shown = false;
    let raf = 0, last = 0;
    let state = ''; // classes last written, so the DOM is touched only on change

    const setState = (visible: boolean, mode: CursorMode, down: boolean) => {
      const next = `${visible ? 'on' : 'off'} ${mode}${down ? ' down' : ''}`;
      if (next === state) return;
      state = next;
      el.classList.toggle('gc-visible', visible);
      el.classList.toggle('gc-hover', mode === 'hover');
      el.classList.toggle('gc-down', down);
    };
    let mode: CursorMode = 'normal';
    let lastTarget: EventTarget | null = null;
    let down = false;
    const visible = () => shown && mode !== 'native' && !root.classList.contains('gc-suspend');
    const render = () => setState(visible(), mode, down);

    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      const k = smoothing(dt, VEL_TAU);
      vx += (dx / dt - vx) * k;
      vy += (dy / dt - vy) * k;
      dx = dy = 0;
      let holding = false;
      if (still) {
        angle = angVel = aim = 0;
      } else {
        const heading = headingFromVelocity(vx, vy);
        if (heading !== null) { aim = nearestDeg(heading, angle); movedAt = now; }
        else if (now - movedAt >= HOLD_MS) aim = nearestDeg(0, angle); // still a while: back to rest, the short way
        else holding = true; // keeps pointing the way it went
        ({ angle, vel: angVel } = springStep(angle, angVel, aim, dt));
      }
      const rest = still || (!holding && Math.abs(wrapDeg(aim)) < 0.05 && settled(angle, angVel, vx, vy));
      if (rest) { angle = angVel = aim = 0; vx = vy = 0; }
      const dpr = window.devicePixelRatio || 1;
      const px = Math.round(x * dpr) / dpr, py = Math.round(y * dpr) / dpr;
      const deg = Math.round(wrapDeg(angle) * 10) / 10;
      const t = `translate3d(${px}px, ${py}px, 0) rotate(${deg}deg)`;
      if (t !== written) { written = t; el.style.transform = t; }
      if (deg !== shadowFor) {
        // the shadow falls down-right on screen whichever way the pointer points
        shadowFor = deg;
        const o = shadowOffset(deg);
        el.style.setProperty('--gc-sx', `${o.x.toFixed(2)}px`);
        el.style.setProperty('--gc-sy', `${o.y.toFixed(2)}px`);
      }
      // while holding a heading the loop idles cheaply (nothing changes, nothing is written)
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
      // classify only when the element under the pointer changes (pointerover always re-checks)
      if (e.target !== lastTarget || e.type === 'pointerover') { lastTarget = e.target; mode = cursorModeOf(e.target as Element | null); }
      render();
      kick();
    };
    const onDown = (e: PointerEvent) => {
      down = true;
      // a <select> opens a native menu that the page gets no moves over: the OS cursor takes it
      if ((e.target as Element | null)?.closest?.('select')) shown = false;
      render();
    };
    const onUp = () => { down = false; render(); };
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
        <svg
          className="gc-svg"
          width={VB.w * SCALE}
          height={VB.h * SCALE}
          viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`}
          style={{ left: VB.x * SCALE, top: VB.y * SCALE }}
        >
          <g transform={`translate(${TIP_SHIFT.x.toFixed(2)} ${TIP_SHIFT.y.toFixed(2)})`}><CursorArt /></g>
        </svg>
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
        {/* lights up over something clickable */}
        <path className="gc-shine" d={head} fill="#fff" />
      </g>
    </>
  );
}
