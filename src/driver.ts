// Debug-only test driver: lets an automated controller evaluate JS in this webview.
// Imported from main.tsx only under import.meta.env.DEV; the Rust side (src-tauri/src/driver.rs)
// evaluates `__cocDriver.run(id, code)` and receives the result through `driver_result`.
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ipc as rawIpc } from './api/ipc';
import { useApp } from './state/store';
import { captureWindow } from './screenshot';

/**
 * The ipc module for scripted setup, with the store updates the UI would make after each call
 * (the backend emits no event for these), so the village reflects them without clicks.
 */
const ipc = {
  ...rawIpc,
  addWorkspace: async (path: string) => {
    const w = await rawIpc.addWorkspace(path);
    useApp.getState().addWorkspace(w);
    return w;
  },
  createWorkspace: async (parent: string, name: string) => {
    const w = await rawIpc.createWorkspace(parent, name);
    useApp.getState().addWorkspace(w);
    return w;
  },
  removeWorkspace: async (id: string) => {
    await rawIpc.removeWorkspace(id);
    useApp.getState().removeWorkspace(id);
  },
  createBuilder: async (...a: Parameters<typeof rawIpc.createBuilder>) => {
    const b = await rawIpc.createBuilder(...a);
    useApp.getState().addBuilder(b);
    return b;
  },
  startSession: async (...a: Parameters<typeof rawIpc.startSession>) => {
    const s = await rawIpc.startSession(...a);
    useApp.getState().upsertSession(s);
    return s;
  },
  closeSession: async (id: string) => {
    const o = await rawIpc.closeSession(id);
    useApp.getState().onClosed(o, id);
    return o;
  },
  startTerminal: async (workspaceId: string) => {
    const s = await rawIpc.startTerminal(workspaceId);
    useApp.getState().upsertSession(s);
    return s;
  },
};

let snapshotFn: () => Promise<string> = async () => '';
let sceneFn: () => unknown = () => null;

/** The village canvas registers how to capture itself as a base64 PNG. */
export function registerSnapshot(fn: () => Promise<string>): void {
  snapshotFn = fn;
}

/** The village canvas registers how to describe its scene graph. */
export function registerScene(fn: () => unknown): void {
  sceneFn = fn;
}

/** An expression, or (when that does not parse, e.g. `throw ...`) a statement body. */
function compile(code: string): () => Promise<unknown> {
  try {
    return new Function('return (async()=>(' + code + '\n))()') as () => Promise<unknown>;
  } catch {
    return new Function('return (async()=>{' + code + '\n})()') as () => Promise<unknown>;
  }
}

const domSnapshot = (): Promise<string> => captureWindow(snapshotFn);

const driver = {
  run(id: number, code: string): void {
    const report = (ok: boolean, value: unknown) => {
      void invoke('driver_result', { id, ok, value });
    };
    Promise.resolve()
      .then(() => compile(code)())
      .then((result) => report(true, JSON.parse(JSON.stringify(result ?? null))))
      .catch((e) => report(false, String(e)));
  },
  click(selector: string): boolean {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return false;
    el.click();
    return true;
  },
  text(selector: string): string | null {
    return document.querySelector(selector)?.textContent ?? null;
  },
  state: (): unknown => useApp.getState(),
  snapshot: (): Promise<string> => snapshotFn(),
  scene: (): unknown => sceneFn(),
  domSnapshot,
  /** Raise the window above others so the webview is visible (not occluded) during live checks. */
  async front(): Promise<boolean> {
    const win = getCurrentWindow();
    await win.setAlwaysOnTop(true);
    await win.setFocus();
    return !document.hidden;
  },
  async unfront(): Promise<boolean> {
    await getCurrentWindow().setAlwaysOnTop(false);
    return true;
  },
  ipc,
};

declare global {
  interface Window {
    __cocDriver?: typeof driver;
  }
}

window.__cocDriver = driver;
