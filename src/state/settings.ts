import { ipc } from '../api/ipc';
import type { Settings } from '../api/types';
import { useApp } from './store';

export const DEFAULT_SETTINGS: Settings = {
  updatesEnabled: true, notifyNeedsYou: true, notifyFinished: true, dockBadge: true, playerName: null, onboarded: false,
};

export { PLAYER_NAME_MAX, cleanName, townHallTitle } from './names';

/** What the store holds, or the defaults before the first read. */
export const currentSettings = (): Settings => useApp.getState().settings ?? DEFAULT_SETTINGS;

/** Reads the saved settings into the store (fields saved before they existed get their defaults). */
export async function loadSettings(): Promise<Settings> {
  const s = { ...DEFAULT_SETTINGS, ...(await ipc.getSettings()) };
  useApp.getState().setSettings(s);
  return s;
}

/**
 * Saves `patch` over the current settings. The store shows it at once; the backend replaces the
 * whole struct, so everything goes back, and its answer (normalized: a trimmed name) is kept.
 * A failed save puts the store back and rethrows.
 */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const before = currentSettings();
  const next = { ...before, ...patch };
  useApp.getState().setSettings(next);
  try {
    const saved = { ...DEFAULT_SETTINGS, ...((await ipc.setSettings(next)) ?? next) };
    useApp.getState().setSettings(saved);
    return saved;
  } catch (e) {
    // only undo our own change: a later save may have landed meanwhile
    if (useApp.getState().settings === next) useApp.getState().setSettings(before);
    throw e;
  }
}
