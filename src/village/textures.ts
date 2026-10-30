import { Texture } from 'pixi.js';
import '@fontsource/lilita-one/400.css';
import type { Art } from './art/draw';

const MAX = 256;

export interface Cached { texture: Texture; ax: number; ay: number }

const cache = new Map<string, Cached>();

const defaultToTexture = (canvas: HTMLCanvasElement): Texture => Texture.from(canvas);

/** Awaited once before the first bake so canvas text uses Lilita One, not the fallback. */
export async function prepareArt(): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (fonts?.load) await fonts.load('400 16px "Lilita One"');
}

/** LRU texture cache. `toTexture` is injectable so the cache logic runs without WebGL. */
export function getTexture(
  key: string,
  make: () => Art,
  toTexture: (canvas: HTMLCanvasElement) => Texture = defaultToTexture,
): Cached {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // most recently used goes last
    return hit;
  }
  const art = make();
  const entry: Cached = { texture: toTexture(art.canvas), ax: art.ax, ay: art.ay };
  cache.set(key, entry);
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value as string;
    cache.get(oldest)?.texture.destroy?.(true);
    cache.delete(oldest);
  }
  return entry;
}

export function clearTextures(): void {
  for (const e of cache.values()) e.texture.destroy?.(true);
  cache.clear();
}

export function textureCacheSize(): number {
  return cache.size;
}
