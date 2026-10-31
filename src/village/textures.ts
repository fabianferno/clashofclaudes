import { Sprite, Texture, type Container } from 'pixi.js';
import '@fontsource/lilita-one/400.css';
import type { Art } from './art/draw';

const MAX = 256;

export interface Cached { texture: Texture; ax: number; ay: number }

const cache = new Map<string, Cached>();
/**
 * Evicted entries, not destroyed yet: a live sprite may still point at the texture (a sprite only
 * re-fetches its texture when it changes), and rendering a destroyed texture throws inside Pixi's
 * ticker, which then never reschedules. `releaseRetired` destroys the ones nothing holds any more.
 */
const retired = new Map<string, Cached>();
/** Who may hold cached textures (each live scene registers one); consulted by `releaseRetired`. */
const holders = new Set<() => Iterable<Texture>>();

const defaultToTexture = (canvas: HTMLCanvasElement): Texture => Texture.from(canvas);

/** Awaited once before the first bake so canvas text uses Lilita One, not the fallback. */
export async function prepareArt(): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (fonts?.load) await fonts.load('400 16px "Lilita One"');
}

/**
 * LRU texture cache. `toTexture` is injectable so the cache logic runs without WebGL.
 * Eviction never destroys: the entry is retired, and comes back as is if its key is asked for again.
 */
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
  let entry = retired.get(key);
  if (entry) retired.delete(key);
  else {
    const art = make();
    entry = { texture: toTexture(art.canvas), ax: art.ax, ay: art.ay };
  }
  cache.set(key, entry);
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value as string;
    retired.set(oldest, cache.get(oldest)!);
    cache.delete(oldest);
  }
  return entry;
}

/** Register a source of the textures a scene's sprites currently show; returns the unregister. */
export function holdTextures(fn: () => Iterable<Texture>): () => void {
  holders.add(fn);
  return () => { holders.delete(fn); };
}

/** The textures of every sprite under `root`, visible or not. */
export function* spriteTextures(root: Container): Iterable<Texture> {
  const stack: Container[] = [root];
  while (stack.length) {
    const c = stack.pop()!;
    if (c instanceof Sprite) yield c.texture;
    for (const ch of c.children) stack.push(ch);
  }
}

/** Destroy retired textures that no registered holder still shows; the rest stay retired. Returns how many were destroyed. */
export function releaseRetired(): number {
  if (!retired.size) return 0;
  const held = new Set<Texture>();
  for (const h of holders) for (const t of h()) held.add(t);
  let n = 0;
  for (const [key, e] of retired) {
    if (held.has(e.texture)) continue;
    retired.delete(key);
    e.texture.destroy?.(true);
    n++;
  }
  return n;
}

/** Destroys everything, retired or not. Only for when no scene is alive (tests). */
export function clearTextures(): void {
  for (const e of cache.values()) e.texture.destroy?.(true);
  for (const e of retired.values()) e.texture.destroy?.(true);
  cache.clear();
  retired.clear();
}

export function textureCacheSize(): number {
  return cache.size;
}

export function retiredCount(): number {
  return retired.size;
}
