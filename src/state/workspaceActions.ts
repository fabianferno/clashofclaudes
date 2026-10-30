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

/** Pick a parent folder and create `name` inside it as a new workspace. */
export async function createFolder(name: string): Promise<void> {
  const n = name.trim();
  if (!n) return;
  try {
    const parent = await open({ directory: true });
    if (typeof parent === 'string') useApp.getState().addWorkspace(await ipc.createWorkspace(parent, n));
  } catch (e) { fail(e); }
}
