import { open } from '@tauri-apps/plugin-dialog';
import { ipc } from '../api/ipc';
import { useApp } from './store';

const fail = (e: unknown) => useApp.getState().setError(String(e));

/** Pick an existing folder and add it as a workspace. Errors go to the store's error slot. */
export async function openFolder(): Promise<void> {
  try {
    const dir = await open({ directory: true });
    if (typeof dir === 'string') useApp.getState().addWorkspace(await ipc.addWorkspace(dir));
  } catch (e) { fail(e); }
}

/**
 * Pick a parent folder and create `name` inside it as a new workspace. Resolves true once it
 * exists; false when cancelled or failed, so callers keep the typed name for another try.
 */
export async function createFolder(name: string): Promise<boolean> {
  const n = name.trim();
  if (!n) return false;
  try {
    const parent = await open({ directory: true });
    if (typeof parent !== 'string') return false;
    useApp.getState().addWorkspace(await ipc.createWorkspace(parent, n));
    return true;
  } catch (e) { fail(e); return false; }
}
