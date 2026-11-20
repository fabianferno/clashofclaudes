import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type RefObject } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { ipc } from '../api/ipc';
import { useApp } from '../state/store';

/** Most images one task can carry (the backend refuses more). */
export const MAX_IMAGES = 10;
const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;

/** Thumbnail URLs by attachment name: a pasted image keeps its own blob; others are read once. */
const urls = new Map<string, string>();

async function thumbUrl(name: string): Promise<string> {
  let u = urls.get(name);
  if (!u) {
    u = URL.createObjectURL(new Blob([await ipc.readAttachment(name)]));
    urls.set(name, u);
  }
  return u;
}

/** The images among pasted data (a screenshot, an image copied in a browser or Preview). */
export function pastedImages(dt: DataTransfer | null): File[] {
  return Array.from(dt?.files ?? []).filter((f) => f.type.startsWith('image/'));
}

function Thumb({ name, onRemove }: { name: string; onRemove?: () => void }) {
  const [url, setUrl] = useState(urls.get(name) ?? null);
  useEffect(() => {
    if (url) return;
    let live = true;
    thumbUrl(name).then((u) => { if (live) setUrl(u); }).catch(() => {});
    return () => { live = false; };
  }, [name, url]);
  return (
    <span className="att-thumb" data-testid="att-thumb">
      {url && <img src={url} alt="" />}
      {onRemove && <button type="button" aria-label="Remove image" onClick={onRemove}>✕</button>}
    </span>
  );
}

/** A task's images as thumbnails; with `onRemove`, each gets an ✕. */
export function AttachmentStrip({ names, onRemove }: { names: string[]; onRemove?: (name: string) => void }) {
  if (names.length === 0) return null;
  return (
    <div className="att-strip">
      {names.map((n) => <Thumb key={n} name={n} onRemove={onRemove && (() => onRemove(n))} />)}
    </div>
  );
}

/**
 * Images being attached to a task that is not added or started yet: pasted into its field, or
 * dropped from Finder on `zone`. Taken off (✕) or left behind when the form goes away, they are
 * discarded; `clear` hands them over (after a start or an add, the backend keeps them). `taken`:
 * images the task already carries, which count toward its most.
 */
export function useAttachments(zone: RefObject<HTMLElement | null>, taken = 0) {
  const [names, setNames] = useState<string[]>([]);
  const [saving, setSaving] = useState(0);
  const held = useRef<string[]>([]);
  held.current = names;
  const room = useRef(MAX_IMAGES);
  room.current = MAX_IMAGES - taken - names.length - saving;

  const addAll = useCallback(async (jobs: Array<() => Promise<string>>) => {
    const take = jobs.slice(0, Math.max(0, room.current));
    if (take.length < jobs.length) useApp.getState().setError(`A task can carry at most ${MAX_IMAGES} images`);
    if (take.length === 0) return;
    setSaving((n) => n + take.length);
    const got = await Promise.allSettled(take.map((j) => j()));
    setSaving((n) => n - take.length);
    setNames((prev) => [...prev, ...got.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))]);
    const bad = got.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (bad) useApp.getState().setError(String(bad.reason));
  }, []);

  const addFiles = useCallback((files: File[]) => addAll(files.map((f) => async () => {
    const name = await ipc.saveAttachment(new Uint8Array(await f.arrayBuffer()));
    urls.set(name, URL.createObjectURL(f));
    return name;
  })), [addAll]);

  useImageDrop(zone, useCallback((paths: string[]) => void addAll(paths.map((p) => () => ipc.importAttachment(p))), [addAll]));

  // left behind: the form closed without adding or starting
  useEffect(() => () => {
    if (held.current.length) ipc.discardAttachments(held.current).catch(() => {});
  }, []);

  return {
    names,
    /** Images are still being saved: starting now would leave them out. */
    saving: saving > 0,
    onPaste: (e: ClipboardEvent) => {
      const files = pastedImages(e.clipboardData);
      if (files.length === 0) return;
      // an image copied from a page may come with text: let that paste as usual
      if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
      void addFiles(files);
    },
    remove: (name: string) => {
      setNames((prev) => prev.filter((n) => n !== name));
      ipc.discardAttachments([name]).catch(() => {});
    },
    // let go now too: the form may go away (an edit saved) before it renders again
    clear: () => { held.current = []; setNames([]); },
  };
}

/**
 * Files dropped from Finder never reach the page as DOM events (the webview takes them), so one
 * listener finds the drop zone under the pointer and hands it the image paths.
 */
type Zone = { el: RefObject<HTMLElement | null>; drop: (paths: string[]) => void };
const zones = new Set<Zone>();
let listening = false;
let dragging: string[] = [];

/**
 * The drop position in CSS px. Tauri calls it physical, but on macOS wry hands over the WKWebView's
 * own point coordinates unscaled, so they are already CSS px there; dividing them by the Retina
 * ratio aimed at the wrong spot (half way to the top-left) and drops missed the field.
 */
export function dropPoint(p: { x: number; y: number }, mac = /Mac/.test(navigator.platform), ratio = window.devicePixelRatio || 1) {
  const r = mac ? 1 : ratio;
  return { x: p.x / r, y: p.y / r };
}

function zoneAt(p: { x: number; y: number }): Zone | undefined {
  const { x, y } = dropPoint(p);
  const hit = document.elementFromPoint(x, y);
  return hit ? [...zones].find((z) => z.el.current?.contains(hit)) : undefined;
}

function mark(z: Zone | undefined) {
  for (const o of zones) o.el.current?.classList.toggle('att-over', o === z);
}

function listen() {
  if (listening) return;
  listening = true;
  try {
    getCurrentWebview().onDragDropEvent(({ payload: p }) => {
      if (p.type === 'enter') dragging = p.paths.filter((x) => IMAGE_PATH.test(x));
      if (p.type === 'leave') return mark(undefined);
      const z = zoneAt(p.position);
      if (p.type !== 'drop') return mark(dragging.length ? z : undefined);
      mark(undefined);
      if (!z) return;
      const images = p.paths.filter((x) => IMAGE_PATH.test(x));
      if (images.length) z.drop(images);
      else useApp.getState().setError('Only PNG, JPEG, GIF or WebP images can be attached');
    }).catch(() => { listening = false; });
  } catch {
    listening = false; // not inside the app (tests)
  }
}

function useImageDrop(el: RefObject<HTMLElement | null>, drop: (paths: string[]) => void) {
  useEffect(() => {
    const z: Zone = { el, drop };
    zones.add(z);
    listen();
    return () => { zones.delete(z); };
  }, [el, drop]);
}
