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

/** Where new folders go unless the user picks a parent (shown in the UI). */
export const DEFAULT_PARENT_LABEL = 'Documents/.clashofclaudes';

/**
 * Create folder `name` as a new workspace: in the default projects folder, or (`pick`) inside a
 * parent the user picks. Resolves true once it exists; false when cancelled or failed, so callers
 * keep the typed name for another try.
 */
export async function createFolder(name: string, pick = false): Promise<boolean> {
  const n = name.trim();
  if (!n) return false;
  try {
    let parent: string | null = null;
    if (pick) {
      const p = await open({ directory: true });
      if (typeof p !== 'string') return false;
      parent = p;
    }
    useApp.getState().addWorkspace(await ipc.createWorkspace(parent, n));
    return true;
  } catch (e) { fail(e); return false; }
}
