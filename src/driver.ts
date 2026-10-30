// Debug-only test driver: lets an automated controller evaluate JS in this webview.
// Imported from main.tsx only under import.meta.env.DEV; the Rust side (src-tauri/src/driver.rs)
// evaluates `__cocDriver.run(id, code)` and receives the result through `driver_result`.
import { invoke } from '@tauri-apps/api/core';
import { useApp } from './state/store';

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
};

declare global {
  interface Window {
    __cocDriver?: typeof driver;
  }
}

window.__cocDriver = driver;
