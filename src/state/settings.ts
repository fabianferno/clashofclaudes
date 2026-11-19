import { ipc } from '../api/ipc';
import type { Settings } from '../api/types';
import { useApp } from './store';
import { DEFAULT_SOUNDS } from './soundDefaults';

export const DEFAULT_SETTINGS: Settings = {
  updatesEnabled: true, notifyNeedsYou: true, notifyFinished: true, dockBadge: true, globalShortcut: true, playerName: null, onboarded: false, spotsTidied: false, spotsTidy: 0, shareUsage: false, installId: null,
  hapticHover: 'alignment', hapticDrop: 'levelChange',
  elixirReserve: 10, elixirStandIn: false,
  soundsOn: true, soundVolume: 70, sounds: DEFAULT_SOUNDS,
  weather: true, ambienceOn: false, ambienceVolume: 50,
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

/**
 * The spacing rules villages are tidied to: 1 kept padding, 2 also keeps every structure clear on
 * screen (`looksClear`), 3 stands each house in the middle of its yard, clear of the walls.
 */
export const SPOTS_TIDY = 3;

/** A village laid out under older spacing rules is spaced out once, on the first launch with the newer ones. */
export async function tidyOnce(s: Settings): Promise<void> {
  if ((s.spotsTidy ?? 0) >= SPOTS_TIDY) return;
  const st = useApp.getState();
  for (const w of st.workspaces) if (w.compound) await st.village.tidy(w.id);
  await saveSettings({ spotsTidied: true, spotsTidy: SPOTS_TIDY });
}
