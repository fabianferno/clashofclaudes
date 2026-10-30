import { dragCam, type Cam } from './camera';

export const DRAG_PX = 4;

export interface DragDeps {
  getCam: () => Cam;
  /** Set the camera directly (no easing). */
  setCam: (c: Cam) => void;
  setTarget: (t: Cam | null) => void;
  /** Called once per drag, when the threshold is crossed (a real user pan). */
  onAutoFitOff: () => void;
}

/** Pixi-free press/move/release logic for panning. Coordinates are canvas-local px. */
export function createDragController(d: DragDeps) {
  let st: { x: number; y: number; base: Cam; moved: boolean } | null = null;
  return {
    /** A press takes over from any ease in flight; the drag is based on the camera as it is now. */
    down(x: number, y: number): void {
      d.setTarget(null);
      st = { x, y, base: { ...d.getCam() }, moved: false };
    },
    /** Returns true once the gesture is a drag (the camera was moved). */
    move(x: number, y: number): boolean {
      if (!st) return false;
      const dx = x - st.x, dy = y - st.y;
      if (!st.moved && Math.hypot(dx, dy) > DRAG_PX) {
        st.moved = true;
        d.onAutoFitOff();
      }
      if (st.moved) d.setCam(dragCam(st.base, dx, dy));
      return st.moved;
    },
    up(): 'click' | 'drag' | null {
      if (!st) return null;
      const r = st.moved ? 'drag' : 'click';
      st = null;
      return r;
    },
    cancel(): void { st = null; },
    get active(): boolean { return st !== null; },
    get dragging(): boolean { return st?.moved ?? false; },
  };
}
