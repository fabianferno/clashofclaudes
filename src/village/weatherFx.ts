import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { Sky, Weather } from './weather';

/**
 * Draws the weather (see weather.ts) over the village: a tint for the time of day, sunlight,
 * lit houses and fireflies at night, and a storm cloud with rain and lightning over a compound
 * with a stuck session. Everything eases in and out; nothing here takes clicks.
 *
 * Layers (the scene places them): `tint` and `sun` cover the screen, above the village;
 * `glow` (lights, fireflies) sits above the tint so they shine through the night and follows the
 * camera like the village; `storms` goes in the village's overlay, over the buildings.
 */

/** Where a light glows: world px (a house's or the hall's middle) and its radius. */
export interface Light { x: number; y: number; r: number }

/** A compound under a storm: the ground point under the cloud (world px) and how wide it spreads. */
export interface StormSite { id: string; x: number; y: number; spread: number }

/** World px bounds the fireflies wander in. */
export interface Bounds { l: number; r: number; t: number; b: number }

/** How strongly each sky tints (multiply blend: 1 - alpha * (1 - colour) per channel). */
const NIGHT = { color: [0.24, 0.3, 0.6], alpha: 0.68 };
const SUNNY = { color: [1, 0.9, 0.72], alpha: 0.2 };

/** The screen tint for `night` and `sun` (each 0..1, partly through a change), as a colour and alpha. */
export function tintOf(night: number, sun: number): { color: number; alpha: number } {
  const wn = NIGHT.alpha * night, ws = SUNNY.alpha * sun;
  const alpha = Math.min(1, wn + ws);
  if (alpha <= 0) return { color: 0xffffff, alpha: 0 };
  const ch = (i: number) => Math.round(255 * ((NIGHT.color[i] * wn + SUNNY.color[i] * ws) / (wn + ws)));
  return { color: (ch(0) << 16) | (ch(1) << 8) | ch(2), alpha };
}

/** Seconds a change of sky takes (eased), and a storm to gather or clear. */
const SKY_SECONDS = 3;
const STORM_SECONDS = 1.5;
const FIREFLIES = 18;
const DROPS = 54;
/** The cloud floats this far over the compound's ground (clear of the tallest house). */
const CLOUD_LIFT = 250;
const CLOUD_BOTTOM = 20;
const CLOUD_TINT = 0x9aa2b4;
const FLASH_SECONDS = 0.16;

const toward = (v: number, target: number, step: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));
/** Repeatable noise in [0, 1) for drop and firefly placement. */
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

/** Sunlight falling from the top left corner. */
function sunTexture(): HTMLCanvasElement {
  const N = 256, [c, g] = canvas(N, N);
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, N);
  gr.addColorStop(0, 'rgba(255,232,160,1)');
  gr.addColorStop(0.5, 'rgba(255,214,130,0.35)');
  gr.addColorStop(1, 'rgba(255,214,130,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, N, N);
  return c;
}

/** A puffy storm cloud in the painted style (2x density): outlined balls, each lit from the top left, darker underneath. */
function cloudTexture(): HTMLCanvasElement {
  const W = 460, H = 230, [c, g] = canvas(W, H);
  // back to front: the underside's small puffs first, the big top ones last (their highlights show)
  const puffs: Array<[number, number, number]> = [
    [96, 160, 34], [146, 172, 36], [202, 176, 38], [262, 176, 38], [320, 170, 36], [372, 158, 34],
    [118, 128, 52], [352, 126, 50], [176, 104, 66], [292, 100, 70], [236, 78, 78],
  ];
  g.fillStyle = '#262a35';
  for (const [x, y, r] of puffs) { g.beginPath(); g.arc(x, y, r + 5, 0, Math.PI * 2); g.fill(); }
  for (const [x, y, r] of puffs) {
    const lit = g.createRadialGradient(x - r * 0.35, y - r * 0.45, r * 0.1, x, y, r);
    lit.addColorStop(0, '#f6f8fc');
    lit.addColorStop(0.6, '#c3cad8');
    lit.addColorStop(1, '#8b94a8');
    g.fillStyle = lit;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // its belly in shadow
  g.globalCompositeOperation = 'source-atop';
  const belly = g.createLinearGradient(0, 110, 0, 215);
  belly.addColorStop(0, 'rgba(38,44,60,0)');
  belly.addColorStop(1, 'rgba(38,44,60,0.55)');
  g.fillStyle = belly;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  return c;
}

interface Storm {
  site: StormSite;
  cloud: Sprite;
  /** 0 gathering .. 1 full .. back to 0 clearing. */
  k: number;
  wanted: boolean;
  phase: number;
  /** Seconds to the next strike, and what is left of the current flash. */
  nextStrike: number;
  flash: number;
  bolt: number[];
}

export class WeatherFx {
  readonly tint: Sprite;
  readonly sun: Sprite;
  readonly glow = new Container();
  readonly storms = new Container();
  private readonly lightsLayer = new Container();
  private readonly fliesLayer = new Container();
  private readonly rain = new Graphics();
  private readonly bolts = new Graphics();
  private readonly textures: Texture[];
  private readonly glowTex: Texture;
  private readonly cloudTex: Texture;
  private night = 0;
  private sunK = 0;
  private target: Weather = { sky: 'day', storms: [] };
  private lights: Array<{ sprite: Sprite; phase: number }> = [];
  private flies: Array<{ sprite: Sprite; hx: number; hy: number; phase: number }> = [];
  private stormMap = new Map<string, Storm>();
  private sites = new Map<string, StormSite>();
  private time = 0;
  private bounds: Bounds | null = null;

  /** `onStrike`: lightning just struck over that workspace (the ambience's thunder). */
  constructor(private readonly onStrike: (workspaceId: string) => void = () => {}) {
    this.glowTex = Texture.from(glowTexture());
    this.cloudTex = Texture.from(cloudTexture());
    const sunTex = Texture.from(sunTexture());
    this.textures = [this.glowTex, this.cloudTex, sunTex];
    this.tint = new Sprite(Texture.WHITE);
    this.tint.blendMode = 'multiply';
    this.tint.alpha = 0;
    this.sun = new Sprite(sunTex);
    this.sun.blendMode = 'add';
    this.sun.alpha = 0;
    for (const c of [this.tint, this.sun, this.glow, this.storms]) { c.eventMode = 'none'; c.interactiveChildren = false; }
    this.glow.addChild(this.lightsLayer, this.fliesLayer);
    this.storms.addChild(this.rain, this.bolts);
    this.bolts.blendMode = 'add';
  }

  /** What the weather should become (`on` false: always a clear day). */
  setWeather(w: Weather, on = true): void {
    this.target = on ? w : { sky: 'day', storms: [] };
  }

  /** Where the houses stand (their lights), the compounds' storm sites and the village's bounds. */
  setPlaces(lights: readonly Light[], sites: readonly StormSite[], bounds: Bounds | null): void {
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
    this.sites = new Map(sites.map((s) => [s.id, s]));
    for (const st of this.stormMap.values()) {
      const s = this.sites.get(st.site.id);
      if (s) st.site = s;
    }
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

  /** The weather it is heading for. */
  get heading(): Weather { return this.target; }

  /** The screen's size: the tint covers it, the sunlight its top left. */
  resize(w: number, h: number): void {
    this.tint.width = w; this.tint.height = h;
    const s = Math.max(w, h) * 0.9;
    this.sun.width = s; this.sun.height = s;
  }

  /** Whether anything is showing or changing (otherwise `update` has nothing to do). */
  get busy(): boolean {
    const t = this.target;
    return this.night > 0 || this.sunK > 0 || t.sky !== 'day' || this.stormMap.size > 0 || t.storms.length > 0;
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.target;
    const sky = (s: Sky) => (t.sky === s ? 1 : 0);
    this.night = toward(this.night, sky('night'), dt / SKY_SECONDS);
    this.sunK = toward(this.sunK, sky('sunny'), dt / SKY_SECONDS);
    const smooth = (k: number) => k * k * (3 - 2 * k);
    const n = smooth(this.night), s = smooth(this.sunK);
    const tint = tintOf(n, s);
    this.tint.tint = tint.color;
    this.tint.alpha = tint.alpha;
    this.tint.visible = tint.alpha > 0.001;
    this.sun.alpha = 0.32 * s;
    this.sun.visible = s > 0.001;

    this.glow.visible = n > 0.001;
    if (this.glow.visible) {
      for (const l of this.lights) l.sprite.alpha = n * (0.5 + 0.05 * Math.sin(this.time * 2.3 + l.phase) + 0.03 * Math.sin(this.time * 7.1 + l.phase * 3));
      for (const f of this.flies) {
        const p = f.phase, tt = this.time;
        f.sprite.position.set(f.hx + Math.sin(tt * 0.31 + p) * 46 + Math.sin(tt * 0.83 + p * 2) * 14, f.hy + Math.cos(tt * 0.27 + p) * 26 + Math.sin(tt * 1.1 + p) * 8);
        const blink = Math.max(0, Math.sin(tt * (0.9 + (p % 0.7)) + p));
        f.sprite.alpha = n * blink * blink;
      }
    }
    this.updateStorms(dt);
  }

  private updateStorms(dt: number): void {
    const want = new Set(this.target.storms.filter((id) => this.sites.has(id)));
    for (const id of want) {
      if (this.stormMap.has(id)) continue;
      const cloud = new Sprite(this.cloudTex);
      cloud.anchor.set(0.5, 0.88);
      cloud.scale.set(0.5);
      cloud.alpha = 0;
      this.storms.addChildAt(cloud, 0);
      this.stormMap.set(id, { site: this.sites.get(id)!, cloud, k: 0, wanted: true, phase: rand(this.stormMap.size + 9) * 10, nextStrike: 2 + rand(this.time) * 4, flash: 0, bolt: [] });
    }
    this.rain.clear();
    this.bolts.clear();
    for (const [id, st] of this.stormMap) {
      st.wanted = want.has(id);
      st.k = toward(st.k, st.wanted ? 1 : 0, dt / STORM_SECONDS);
      if (!st.wanted && st.k <= 0) { st.cloud.destroy(); this.stormMap.delete(id); continue; }
      const k = st.k * st.k * (3 - 2 * st.k);
      const { x, y, spread } = st.site;
      const cy = y - CLOUD_LIFT + Math.sin(this.time * 0.6 + st.phase) * 4;
      st.cloud.position.set(x + Math.sin(this.time * 0.25 + st.phase) * 6, cy - (1 - k) * 30);
      st.cloud.scale.set(0.5 * Math.max(0.7, spread / 130));
      st.cloud.alpha = k;
      // rain from under the cloud to the ground
      const top = cy - CLOUD_BOTTOM * 0.5, w = spread * 0.85;
      for (let i = 0; i < DROPS; i++) {
        const dx = (rand(i * 3.1 + st.phase) - 0.5) * 2 * w;
        const ground = y + (rand(i * 5.7 + st.phase) - 0.5) * 60;
        const f = (this.time * (1.5 + rand(i) * 0.6) + rand(i * 9.3)) % 1;
        const py = top + (ground - top) * f;
        this.rain.moveTo(x + dx - 4, py).lineTo(x + dx, py + 18);
      }
      this.rain.stroke({ width: 2, color: 0xcfdcf5, alpha: 0.75 * k });
      // lightning, now and then
      if (st.wanted && k > 0.8) {
        st.nextStrike -= dt;
        if (st.nextStrike <= 0) {
          st.nextStrike = 4 + rand(this.time * 1.7 + st.phase) * 6;
          st.flash = FLASH_SECONDS;
          st.bolt = boltPoints(x + (rand(this.time) - 0.5) * w, top, y + 6, this.time);
          this.onStrike(id);
        }
      }
      if (st.flash > 0) {
        st.flash = Math.max(0, st.flash - dt);
        const a = st.flash / FLASH_SECONDS;
        this.bolts.poly(st.bolt, false).stroke({ width: 7, color: 0xfff6c0, alpha: 0.35 * a });
        this.bolts.poly(st.bolt, false).stroke({ width: 2.5, color: 0xffffff, alpha: a });
        st.cloud.tint = mix(CLOUD_TINT, 0xfff8dc, a);
      } else {
        st.cloud.tint = CLOUD_TINT;
      }
    }
  }

  destroy(): void {
    for (const c of [this.tint, this.sun, this.glow, this.storms]) c.destroy({ children: true });
    for (const t of this.textures) t.destroy(true);
  }
}

/** A jagged bolt from (x, top) down to `bottom`, as flat [x, y, ...] points. */
export function boltPoints(x: number, top: number, bottom: number, seed: number): number[] {
  const out = [x, top];
  const steps = 7;
  let cx = x;
  for (let i = 1; i <= steps; i++) {
    cx += (rand(seed * 3 + i) - 0.5) * 34;
    out.push(cx, top + ((bottom - top) * i) / steps);
  }
  return out;
}

function mix(a: number, b: number, k: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
