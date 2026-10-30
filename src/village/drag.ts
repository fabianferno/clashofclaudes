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
    move(x: number, y: number): void {
      if (!st) return;
      if (!st.moved) {
        if (Math.hypot(x - st.x, y - st.y) <= DRAG_PX) return;
        // Auto-fit may have moved the camera since the press: rebase here so the first pan applies no jump.
        st = { x, y, base: { ...d.getCam() }, moved: true };
        d.onAutoFitOff();
        return;
      }
      d.setCam(dragCam(st.base, x - st.x, y - st.y));
    },
    up(): 'click' | 'drag' | null {
      if (!st) return null;
      const r = st.moved ? 'drag' : 'click';
      st = null;
      return r;
    },
    cancel(): void { st = null; },
    get active(): boolean { return st !== null; },
  };
}
