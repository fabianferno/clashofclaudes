import { create } from 'zustand';

/** Terminal text size, shared by every terminal (panel and pop-out) and kept per browser. */
export const DEFAULT_TERM_FONT = 13;
export const MIN_TERM_FONT = 9;
export const MAX_TERM_FONT = 28;
const KEY = 'coc.termFont';

function saved(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= MIN_TERM_FONT && n <= MAX_TERM_FONT ? n : DEFAULT_TERM_FONT;
  } catch {
    return DEFAULT_TERM_FONT;
  }
}

export const useTermFont = create<{ size: number; zoom: (z: 'in' | 'out' | 'fit') => void }>((set, get) => ({
  size: saved(),
  zoom: (z) => {
    const now = get().size;
    const size = z === 'fit' ? DEFAULT_TERM_FONT : Math.max(MIN_TERM_FONT, Math.min(MAX_TERM_FONT, now + (z === 'in' ? 1 : -1)));
    try { localStorage.setItem(KEY, String(size)); } catch { /* not kept: still applies now */ }
    set({ size });
  },
}));
