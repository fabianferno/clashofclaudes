import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { PANEL_MIN, PANEL_MAX_FRAC, usePanelWidth } from '../state/panelWidth';

/** Arrow keys move the edge this far (Shift: further). */
const KEY_STEP = 16;
/** <html> classes while dragging: no text selection, no transitions, the OS col-resize cursor everywhere. */
const DRAG_CLASSES = ['coc-panel-resizing', 'gc-suspend'];

/**
 * The side panel's inner (left) edge: drag it to make the panel wider or narrower, double-click
 * to put the default back. The width is applied live (the HUD, the village and the terminal
 * follow) and kept for next time on release.
 */
export default function PanelResizer() {
  const width = usePanelWidth((s) => s.width);
  const drag = useRef<{ id: number; x0: number; w0: number; x: number; raf: number } | null>(null);
  const handle = useRef<HTMLDivElement>(null);

  const widthAt = (x: number) => {
    const d = drag.current!;
    return d.w0 + (d.x0 - x); // the edge is on the left: moving left widens
  };
  const finish = (x?: number) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.raf);
    document.documentElement.classList.remove(...DRAG_CLASSES);
    const h = handle.current;
    try { if (h?.hasPointerCapture?.(d.id)) h.releasePointerCapture(d.id); } catch { /* already released */ }
    usePanelWidth.getState().setWidth(d.w0 + (d.x0 - (x ?? d.x)), true);
  };
  // released outside the window, or the app lost focus mid-drag: never stay stuck dragging
  useEffect(() => {
    const onBlur = () => finish();
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('blur', onBlur); finish(); };
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection, no focus jump
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported: window events below still end it */ }
    drag.current = { id: e.pointerId, x0: e.clientX, w0: usePanelWidth.getState().width, x: e.clientX, raf: 0 };
    document.documentElement.classList.add(...DRAG_CLASSES);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    // the button came up where we did not hear it (outside the window, without capture)
    if (e.buttons === 0 && e.pointerType === 'mouse') { finish(e.clientX); return; }
    d.x = e.clientX;
    // one width update per frame, however fast the events come
    if (!d.raf) d.raf = requestAnimationFrame(() => {
      const cur = drag.current;
      if (!cur) return;
      cur.raf = 0;
      usePanelWidth.getState().setWidth(widthAt(cur.x));
    });
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current && e.pointerId === drag.current.id) finish(e.clientX);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const st = usePanelWidth.getState();
    if (e.key === 'ArrowLeft') st.setWidth(st.width + step, true);
    else if (e.key === 'ArrowRight') st.setWidth(st.width - step, true);
    else if (e.key === 'Home' || e.key === 'Enter') st.reset();
    else return;
    e.preventDefault();
  };

  const max = typeof window === 'undefined' ? width : Math.max(PANEL_MIN, Math.round(window.innerWidth * PANEL_MAX_FRAC));
  return (
    <div
      ref={handle}
      className="sp-resize gc-native"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuemin={PANEL_MIN}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click for the default size"
      data-testid="panel-resizer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onDoubleClick={() => usePanelWidth.getState().reset()}
      onKeyDown={onKeyDown}
    >
      <span className="sp-resize-grip" />
    </div>
  );
}
