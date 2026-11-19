import { create } from 'zustand';

/** The side panel's text size, as a scale over its normal size; kept per browser. */
export const MIN_PANEL_ZOOM = 0.8;
export const MAX_PANEL_ZOOM = 1.8;
const STEP = 0.1;
const KEY = 'coc.panelZoom';

const round = (z: number) => Math.round(z * 10) / 10;
const clamp = (z: number) => round(Math.min(MAX_PANEL_ZOOM, Math.max(MIN_PANEL_ZOOM, z)));

function saved(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? clamp(n) : 1;
  } catch {
    return 1;
  }
}

export const usePanelZoom = create<{ zoom: number; step: (z: 'in' | 'out' | 'fit') => void }>((set, get) => ({
  zoom: saved(),
  step: (z) => {
    const zoom = z === 'fit' ? 1 : clamp(get().zoom + (z === 'in' ? STEP : -STEP));
    try {
      if (zoom === 1) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(zoom));
    } catch { /* not kept: still applies now */ }
    set({ zoom });
  },
}));
