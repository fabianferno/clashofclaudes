import { create } from 'zustand';

/**
 * Whether an agent session's panel shows its terminal. Hidden by default (the panel shows the
 * session's state and last reply instead); the owner's choice is kept per browser. A plain shell
 * session always shows its terminal: it has nothing else to show.
 */
const KEY = 'coc.termShown';

function saved(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export const useTermShown = create<{ shown: boolean; set: (shown: boolean) => void }>((set) => ({
  shown: saved(),
  set: (shown) => {
    try { localStorage.setItem(KEY, shown ? '1' : '0'); } catch { /* not kept: still applies now */ }
    set({ shown });
  },
}));
