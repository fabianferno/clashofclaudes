import { create } from 'zustand';
import { PANEL_W } from '../village/camera';

/** The side panel's width: the owner drags its inner edge; kept per browser. */
export const PANEL_DEFAULT = PANEL_W;
export const PANEL_MIN = 340;
/** At most this share of the window, so the village always keeps some room. */
export const PANEL_MAX_FRAC = 0.7;
const KEY = 'coc.panelWidth';

const viewportW = () => (typeof window === 'undefined' ? 1280 : window.innerWidth);

/** `w` within [PANEL_MIN, 70% of a `vw`-wide window] (never below the min, even in a tiny window). */
export function clampPanelWidth(w: number, vw: number): number {
  const max = Math.max(PANEL_MIN, Math.round(vw * PANEL_MAX_FRAC));
  if (!Number.isFinite(w)) return PANEL_DEFAULT;
  return Math.round(Math.min(max, Math.max(PANEL_MIN, w)));
}

function saved(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

interface PanelWidthState {
  /** What the owner chose (or the default); the window may be too narrow to show all of it. */
  pref: number;
  /** The width the panel has now: `pref` within the window's limits. */
  width: number;
  /** Live, while dragging; `keep` also remembers it for next time (on release). */
  setWidth: (w: number, keep?: boolean) => void;
  reset: () => void;
}

export const usePanelWidth = create<PanelWidthState>((set) => {
  const pref = saved();
  return {
    pref,
    width: clampPanelWidth(pref, viewportW()),
    setWidth: (w, keep = false) => {
      const width = clampPanelWidth(w, viewportW());
      if (keep) {
        try { localStorage.setItem(KEY, String(width)); } catch { /* not kept: still applies now */ }
      }
      set({ pref: width, width });
    },
    reset: () => {
      try { localStorage.removeItem(KEY); } catch { /* nothing kept to forget */ }
      set({ pref: PANEL_DEFAULT, width: clampPanelWidth(PANEL_DEFAULT, viewportW()) });
    },
  };
});

/** The panel's current width, for code outside React (the village camera, the HUD's offsets). */
export const getPanelWidth = () => usePanelWidth.getState().width;

// A narrower window squeezes the panel; a wider one gives the chosen width back.
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const { pref, width } = usePanelWidth.getState();
    const next = clampPanelWidth(pref, viewportW());
    if (next !== width) usePanelWidth.setState({ width: next });
  });
}
