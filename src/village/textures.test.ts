import { afterEach, describe, expect, it } from 'vitest';
import { Container, Sprite, Texture } from 'pixi.js';
import { clearTextures, getTexture, holdTextures, releaseRetired, retiredCount, spriteTextures, textureCacheSize } from './textures';

/** A stand-in for a Pixi texture: rendering one after destroy() is what froze the ticker. */
interface FakeTex { destroyed: boolean; destroy(): void }
const fakeTexture = (): Texture => {
  const t: FakeTex = { destroyed: false, destroy() { this.destroyed = true; } };
  return t as unknown as Texture;
};
const art = () => ({ canvas: document.createElement('canvas'), ax: 0, ay: 0 });
const get = (key: string) => getTexture(key, art, fakeTexture);
/** What Pixi's batcher does with a sprite's texture each frame. */
const render = (sprite: { texture: Texture }) => {
  if ((sprite.texture as unknown as FakeTex).destroyed) throw new Error('null _source');
};
const evictEverything = () => { for (let i = 0; i < 300; i++) get(`filler${i}`); };

let unhold: (() => void) | null = null;
afterEach(() => { unhold?.(); unhold = null; clearTextures(); });

describe('texture cache eviction', () => {
  it('never destroys a texture a live sprite still shows', () => {
    // a ring sprite gets its texture once, then is only toggled visible
    const ring = { texture: get('ring').texture };
    unhold = holdTextures(() => [ring.texture]);
    evictEverything();
    expect(textureCacheSize()).toBeLessThanOrEqual(256);
    expect(retiredCount()).toBeGreaterThan(0);
    releaseRetired(); // the scene's sync-time flush
    expect(() => render(ring)).not.toThrow();
    // asking for the key again brings back the very same texture, no re-bake
    let made = 0;
    const again = getTexture('ring', () => { made++; return art(); }, fakeTexture);
    expect(again.texture).toBe(ring.texture);
    expect(made).toBe(0);
  });

  it('destroys a retired texture once nothing holds it', () => {
    const sprite = { texture: get('puff').texture };
    const held = new Set([sprite.texture]);
    unhold = holdTextures(() => held);
    evictEverything();
    releaseRetired();
    expect((sprite.texture as unknown as FakeTex).destroyed).toBe(false);
    held.clear(); // the sprite moved on to another texture (or was destroyed)
    const n = releaseRetired();
    expect(n).toBeGreaterThan(0);
    expect((sprite.texture as unknown as FakeTex).destroyed).toBe(true);
    expect(retiredCount()).toBe(0);
  });

  it('with no holders, released retirees are all destroyed', () => {
    const t = get('a').texture as unknown as FakeTex;
    evictEverything();
    releaseRetired();
    expect(t.destroyed).toBe(true);
  });
});

describe('spriteTextures', () => {
  it('walks nested containers, hidden sprites included', () => {
    const root = new Container(), layer = new Container(), hidden = new Sprite(Texture.WHITE);
    hidden.visible = false;
    layer.addChild(hidden);
    root.addChild(new Sprite(Texture.EMPTY), layer);
    expect(new Set(spriteTextures(root))).toEqual(new Set([Texture.EMPTY, Texture.WHITE]));
  });
});
