import { Container, Sprite, Texture } from 'pixi.js';
import { NOON, type Daylight } from './daylight';

/**
 * Draws the time of day (see daylight.ts) over the village: a blue tint at night with lit houses
 * and fireflies, a warm tint and low sunlight at sunrise and sunset. It eases into each change;
 * nothing here takes clicks.
 *
 * Layers (the scene places them): `tint` and `sun` cover the screen, above the village; `glow`
 * (lights, fireflies) sits above the tint so they shine through the night, and follows the
 * camera like the village.
 */

/** Where a light glows: world px (a house's or the hall's middle) and its radius. */
export interface Light { x: number; y: number; r: number }

/** World px bounds the fireflies wander in. */
export interface Bounds { l: number; r: number; t: number; b: number }

/** How strongly each light tints (multiply blend: 1 - alpha * (1 - colour) per channel). */
const NIGHT = { color: [0.24, 0.3, 0.6], alpha: 0.68 };
const GOLDEN = { color: [1, 0.82, 0.6], alpha: 0.28 };

/** The screen tint for `night` and `golden` (each 0..1), as a colour and alpha. */
export function tintOf(night: number, golden: number): { color: number; alpha: number } {
  const wn = NIGHT.alpha * night, wg = GOLDEN.alpha * golden;
  const alpha = Math.min(1, wn + wg);
  if (alpha <= 0) return { color: 0xffffff, alpha: 0 };
  const ch = (i: number) => Math.round(255 * ((NIGHT.color[i] * wn + GOLDEN.color[i] * wg) / (wn + wg)));
  return { color: (ch(0) << 16) | (ch(1) << 8) | ch(2), alpha };
}

/** Seconds an eased change takes (turning it on or off; the clock itself moves slowly). */
const EASE_SECONDS = 3;
const FIREFLIES = 18;

const toward = (v: number, target: number, step: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));
/** Repeatable noise in [0, 1) for firefly placement. */
const rand = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}

function glowTexture(): HTMLCanvasElement {
  const N = 128, [c, g] = canvas(N, N);
  const gr = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, N, N);
  return c;
}

/** Low sunlight falling from a top corner. */
function sunTexture(): HTMLCanvasElement {
  const N = 256, [c, g] = canvas(N, N);
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, N);
  gr.addColorStop(0, 'rgba(255,214,140,1)');
  gr.addColorStop(0.5, 'rgba(255,190,110,0.35)');
  gr.addColorStop(1, 'rgba(255,190,110,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, N, N);
  return c;
}

export class DaylightFx {
  readonly tint: Sprite;
  readonly sun: Sprite;
  readonly glow = new Container();
  private readonly lightsLayer = new Container();
  private readonly fliesLayer = new Container();
  private readonly textures: Texture[];
  private readonly glowTex: Texture;
  private night = 0;
  private golden = 0;
  private target: Daylight = NOON;
  private lights: Array<{ sprite: Sprite; phase: number }> = [];
  private flies: Array<{ sprite: Sprite; hx: number; hy: number; phase: number }> = [];
  private time = 0;
  private bounds: Bounds | null = null;
  private screen = { w: 1, h: 1 };

  constructor() {
    this.glowTex = Texture.from(glowTexture());
    const sunTex = Texture.from(sunTexture());
    this.textures = [this.glowTex, sunTex];
    this.tint = new Sprite(Texture.WHITE);
    this.tint.blendMode = 'multiply';
    this.tint.alpha = 0;
    this.sun = new Sprite(sunTex);
    this.sun.blendMode = 'add';
    this.sun.alpha = 0;
    for (const c of [this.tint, this.sun, this.glow]) { c.eventMode = 'none'; c.interactiveChildren = false; }
    this.glow.addChild(this.lightsLayer, this.fliesLayer);
  }

  /** The light to show (`on` false: always midday). */
  set(d: Daylight, on = true): void {
    const was = this.target.morning;
    this.target = on ? d : NOON;
    if (was !== this.target.morning) this.placeSun();
  }

  /** The light it is heading for. */
  get heading(): Daylight { return this.target; }

  /** Where the houses stand (their lights) and the village's bounds (where fireflies wander). */
  setPlaces(lights: readonly Light[], bounds: Bounds | null): void {
    while (this.lights.length > lights.length) this.lights.pop()!.sprite.destroy();
    lights.forEach((l, i) => {
      let rec = this.lights[i];
      if (!rec) {
        const sprite = new Sprite(this.glowTex);
        sprite.anchor.set(0.5);
        sprite.blendMode = 'add';
        sprite.tint = 0xffb04a;
        this.lightsLayer.addChild(sprite);
        rec = { sprite, phase: rand(i + 1) * 10 };
        this.lights.push(rec);
      }
      rec.sprite.position.set(l.x, l.y);
      rec.sprite.scale.set((l.r * 2) / 128, l.r / 128);
    });
    if (bounds && (!this.bounds || bounds.l !== this.bounds.l || bounds.r !== this.bounds.r || bounds.t !== this.bounds.t || bounds.b !== this.bounds.b)) {
      this.bounds = bounds;
      this.placeFlies(bounds);
    }
  }

  private placeFlies(b: Bounds): void {
    if (!this.flies.length) {
      for (let i = 0; i < FIREFLIES; i++) {
        const sprite = new Sprite(this.glowTex);
        sprite.anchor.set(0.5);
        sprite.blendMode = 'add';
        sprite.tint = 0xd9ff6a;
        sprite.scale.set(0.14);
        this.fliesLayer.addChild(sprite);
        this.flies.push({ sprite, hx: 0, hy: 0, phase: rand(i * 7 + 3) * 100 });
      }
    }
    this.flies.forEach((f, i) => {
      f.hx = b.l + (b.r - b.l) * rand(i * 13 + 1);
      f.hy = b.t + 120 + (b.b - b.t - 120) * rand(i * 17 + 5);
    });
  }

  /** The screen's size: the tint covers it, the low sun lights a top corner. */
  resize(w: number, h: number): void {
    this.screen = { w, h };
    this.tint.width = w; this.tint.height = h;
    this.placeSun();
  }

  /** In the morning the sun is low on the left, in the evening on the right. */
  private placeSun(): void {
    const s = Math.max(this.screen.w, this.screen.h) * 0.9;
    this.sun.height = s;
    this.sun.width = s;
    if (!this.target.morning) { this.sun.scale.x = -Math.abs(this.sun.scale.x); this.sun.x = this.screen.w; } else { this.sun.scale.x = Math.abs(this.sun.scale.x); this.sun.x = 0; }
  }

  /** Whether anything is showing or changing (otherwise `update` has nothing to do). */
  get busy(): boolean {
    return this.night > 0 || this.golden > 0 || this.target.night > 0 || this.target.golden > 0;
  }

  update(dt: number): void {
    this.time += dt;
    const step = dt / EASE_SECONDS;
    this.night = toward(this.night, this.target.night, step);
    this.golden = toward(this.golden, this.target.golden, step);
    const n = this.night, g = this.golden;
    const tint = tintOf(n, g);
    this.tint.tint = tint.color;
    this.tint.alpha = tint.alpha;
    this.tint.visible = tint.alpha > 0.001;
    this.sun.alpha = 0.38 * g * (1 - n);
    this.sun.visible = this.sun.alpha > 0.001;

    this.glow.visible = n > 0.001;
    if (!this.glow.visible) return;
    for (const l of this.lights) l.sprite.alpha = n * (0.5 + 0.05 * Math.sin(this.time * 2.3 + l.phase) + 0.03 * Math.sin(this.time * 7.1 + l.phase * 3));
    for (const f of this.flies) {
      const p = f.phase, tt = this.time;
      f.sprite.position.set(f.hx + Math.sin(tt * 0.31 + p) * 46 + Math.sin(tt * 0.83 + p * 2) * 14, f.hy + Math.cos(tt * 0.27 + p) * 26 + Math.sin(tt * 1.1 + p) * 8);
      const blink = Math.max(0, Math.sin(tt * (0.9 + (p % 0.7)) + p));
      f.sprite.alpha = n * blink * blink;
    }
  }

  destroy(): void {
    for (const c of [this.tint, this.sun, this.glow]) c.destroy({ children: true });
    for (const t of this.textures) t.destroy(true);
  }
}
