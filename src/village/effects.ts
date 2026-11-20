import { Container, Sprite, Text, Texture } from 'pixi.js';
import type { Compound } from '../api/types';

export const MAX_PARTICLES = 400;
export const POP_SECONDS = 0.45;
export const RELOCATE_SECONDS = 0.8;
export const ORB_SECONDS = 1.2;
export const TEXT_SECONDS = 1.4;
export const TEXT_RISE = 40;

export type ParticleKind = 'dust' | 'smoke' | 'spark' | 'orb' | 'text';
type DotKind = Exclude<ParticleKind, 'text'>;
export interface Pt { x: number; y: number }

export interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds lived, counting any start delay. */
  age: number;
  /** Total life in seconds, including the delay. */
  max: number;
  delay: number;
  scale: number;
  alpha: number;
  from: Pt;
  to: Pt;
  text?: string;
  color?: string;
  /** A smoke puff's strongest alpha; set for chimney smoke, which also fades in. */
  peak?: number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * A capped pool of short-lived particles. Pure data and timing; `FxRenderer` draws them.
 * At the cap a new dust or smoke puff or spark replaces the oldest of those; anything else is dropped.
 */
export class Particles {
  list: Particle[] = [];
  /** Called once when a particle expires or is evicted. */
  onRemove: ((p: Particle) => void) | null = null;
  private timers: Array<{ at: number; fn: () => void }> = [];
  private clock = 0;

  get count(): number { return this.list.length; }
  /** Nothing is alive and nothing is scheduled: the per-frame update can be skipped. */
  get idle(): boolean { return this.list.length === 0 && this.timers.length === 0; }

  private add(p: Partial<Particle> & { kind: ParticleKind; x: number; y: number; max: number }): Particle | null {
    if (this.list.length >= MAX_PARTICLES) {
      const i = this.list.findIndex((q) => q.kind === 'dust' || q.kind === 'smoke' || q.kind === 'spark');
      if (i < 0) return null;
      const [gone] = this.list.splice(i, 1);
      this.onRemove?.(gone);
    }
    const full: Particle = {
      vx: 0, vy: 0, age: 0, delay: 0, scale: 1, alpha: 1, from: { x: p.x, y: p.y }, to: { x: p.x, y: p.y }, ...p,
    };
    this.list.push(full);
    return full;
  }

  /** A burst of dust puffs spreading out from `at`. */
  dust(at: Pt, n: number, big: boolean): void {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2), sp = rnd(10, big ? 70 : 40);
      this.add({
        kind: 'dust', x: at.x + rnd(-6, 6), y: at.y + rnd(-3, 3), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.5 - rnd(4, 18),
        max: rnd(0.5, big ? 1.0 : 0.7), scale: big ? rnd(0.7, 1.3) : rnd(0.4, 0.8),
      });
    }
  }

  /** One slow grey puff rising from `at`. */
  smoke(at: Pt): void {
    this.add({ kind: 'smoke', x: at.x + rnd(-5, 5), y: at.y, vx: rnd(-6, 6), vy: -rnd(18, 30), max: rnd(1.0, 1.5), scale: rnd(0.5, 0.8) });
  }

  /** One puff of chimney smoke from `at`: slower and longer-lived than `smoke`, drifting a little downwind. */
  chimney(at: Pt, thin = false): void {
    this.add({
      kind: 'smoke', x: at.x + rnd(-2, 2), y: at.y, vx: rnd(2, 9), vy: -rnd(12, 20), max: rnd(2.0, 2.8),
      scale: thin ? rnd(0.3, 0.45) : rnd(0.45, 0.65), peak: thin ? 0.3 : 0.5,
    });
  }

  /** `n` sparks thrown up from `at`; they arc and fall back as they fade. */
  sparks(at: Pt, n: number): void {
    for (let i = 0; i < n; i++)
      this.add({ kind: 'spark', x: at.x + rnd(-6, 6), y: at.y + rnd(-2, 2), vx: rnd(-18, 18), vy: -rnd(40, 75), max: rnd(0.5, 0.9), scale: rnd(0.22, 0.36) });
  }

  /** `n` gold orbs flying from `from` to `to` on an arc over 1.2 s (staggered a little). */
  orbs(from: Pt, to: Pt, n: number): void {
    for (let i = 0; i < n; i++) {
      const delay = i * 0.05;
      this.add({
        kind: 'orb', x: from.x, y: from.y, from: { ...from }, to: { ...to }, delay, max: delay + ORB_SECONDS, scale: rnd(0.8, 1.1),
        vx: rnd(-1, 1), // arc height jitter factor
      });
    }
  }

  /** Text that rises 40 px over 1.4 s and fades. */
  floatText(at: Pt, text: string, color: string): void {
    this.add({ kind: 'text', x: at.x, y: at.y, from: { ...at }, to: { x: at.x, y: at.y - TEXT_RISE }, max: TEXT_SECONDS, text, color });
  }

  /** Run `fn` once after `seconds` of simulated time. */
  later(seconds: number, fn: () => void): void {
    this.timers.push({ at: this.clock + seconds, fn });
  }

  update(dt: number): void {
    if (this.idle) return;
    this.clock += dt;
    if (this.timers.length) {
      const due = this.timers.filter((t) => t.at <= this.clock);
      this.timers = this.timers.filter((t) => t.at > this.clock);
      for (const t of due) t.fn();
    }
    let w = 0;
    for (const p of this.list) {
      p.age += dt;
      if (p.age >= p.max) { this.onRemove?.(p); continue; }
      this.list[w++] = p;
      if (p.age < p.delay) continue;
      const life = (p.age - p.delay) / (p.max - p.delay); // 0..1
      switch (p.kind) {
        case 'dust':
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.vx *= 0.94; p.vy = p.vy * 0.94 + 10 * dt;
          p.alpha = 0.8 * (1 - life); p.scale += dt * 0.8;
          break;
        case 'smoke':
          p.x += p.vx * dt; p.y += p.vy * dt;
          // chimney smoke (a `peak`) fades in from the flue; a burst's puff starts at full strength
          p.alpha = (p.peak ?? 0.55) * (1 - life) * (p.peak === undefined ? 1 : Math.min(1, life * 6));
          p.scale += dt * 0.5;
          break;
        case 'spark':
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.vy += 90 * dt;
          p.alpha = (1 - life) * (0.75 + 0.25 * Math.sin(p.age * 40));
          break;
        case 'orb': {
          const e = life * life * (3 - 2 * life); // smoothstep
          p.x = p.from.x + (p.to.x - p.from.x) * e;
          p.y = p.from.y + (p.to.y - p.from.y) * e - Math.sin(Math.PI * life) * (70 + p.vx * 15);
          p.alpha = life > 0.9 ? (1 - life) * 10 : 1;
          break;
        }
        case 'text':
          p.y = p.from.y - TEXT_RISE * life;
          p.alpha = life < 0.6 ? 1 : 1 - (life - 0.6) / 0.4;
          break;
      }
    }
    this.list.length = w;
  }
}

// ---------------------------------------------------------------- drawing

const dotCache = new Map<string, Texture>();
/** One cached soft dot per kind/colour; particles are sprites of these, never redrawn. */
function dotTexture(kind: DotKind): Texture {
  let t = dotCache.get(kind);
  if (t && !t.destroyed) return t;
  const size = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
  const stops: Record<string, [string, string]> = {
    dust: ['rgba(214,190,150,1)', 'rgba(190,160,115,0)'],
    smoke: ['rgba(150,150,150,1)', 'rgba(110,110,110,0)'],
    spark: ['rgba(255,250,215,1)', 'rgba(255,110,20,0)'],
    orb: ['rgba(255,244,170,1)', 'rgba(255,190,40,0.0)'],
  };
  grad.addColorStop(0, stops[kind][0]);
  if (kind === 'orb') grad.addColorStop(0.55, 'rgba(255,207,51,0.95)');
  if (kind === 'spark') grad.addColorStop(0.35, 'rgba(255,170,50,0.95)');
  grad.addColorStop(1, stops[kind][1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  t = Texture.from(cv);
  dotCache.set(kind, t);
  return t;
}

/** Draws a `Particles` pool into `layer`: pooled sprites for dots, a `Text` per float text (destroyed when it ends). */
export class FxRenderer {
  private visuals = new Map<Particle, Sprite | Text>();
  private spare: Record<DotKind, Sprite[]> = { dust: [], smoke: [], spark: [], orb: [] };
  /** Floating text's size (see `labelScale`): it stays readable zoomed out. */
  textScale = 1;

  constructor(private layer: Container, private particles: Particles) {
    particles.onRemove = (p) => this.release(p);
  }

  private release(p: Particle): void {
    const v = this.visuals.get(p);
    if (!v) return;
    this.visuals.delete(p);
    if (p.kind === 'text') { v.destroy(); return; }
    v.visible = false;
    this.spare[p.kind].push(v as Sprite);
  }

  /** Move every live visual to its particle. Call after `Particles.update`. */
  draw(): void {
    for (const p of this.particles.list) {
      let v = this.visuals.get(p);
      if (!v) {
        if (p.kind === 'text') {
          v = new Text({
            text: p.text ?? '',
            style: { fontFamily: 'Lilita One', fontSize: 26, fill: p.color ?? '#ffffff', stroke: { color: '#1d130b', width: 6 } },
            resolution: 2,
          });
          v.anchor.set(0.5);
        } else {
          v = this.spare[p.kind].pop() ?? new Sprite(dotTexture(p.kind));
          v.anchor.set(0.5);
          v.scale.set(0.5);
        }
        v.zIndex = 1e6;
        if (!v.parent) this.layer.addChild(v);
        this.visuals.set(p, v);
      }
      const live = p.age >= p.delay;
      v.visible = live;
      if (!live) continue;
      v.position.set(p.x, p.y);
      v.alpha = p.alpha;
      if (p.kind === 'text') { v.scale.set(this.textScale); continue; }
      v.scale.set(p.scale * (p.kind === 'orb' ? 0.55 : 0.6));
    }
  }

  destroy(): void {
    this.particles.onRemove = null;
    this.visuals.clear();
  }
}

// ---------------------------------------------------------------- lifecycle diff

/** What the scene needs to see lifecycle changes: structure ids with their workspace, and the compounds. */
export interface Snap {
  structs: Map<string, string>;
  compounds: Map<string, Compound>;
}

export interface LifecycleEvents {
  spawned: Array<{ id: string; wsId: string }>;
  closed: Array<{ id: string; wsId: string }>;
  expanded: string[];
  /** A compound whose origin moved: the whole compound travelled by (dx, dy) tiles. */
  relocated: Array<{ wsId: string; dx: number; dy: number }>;
}

/** Events between two snapshots. The first snapshot (prev null) raises none: nothing animates on load. */
export function lifecycleEvents(prev: Snap | null, next: Snap): LifecycleEvents {
  const out: LifecycleEvents = { spawned: [], closed: [], expanded: [], relocated: [] };
  if (!prev) return out;
  for (const [id, wsId] of next.structs) if (!prev.structs.has(id)) out.spawned.push({ id, wsId });
  for (const [id, wsId] of prev.structs) if (!next.structs.has(id)) out.closed.push({ id, wsId });
  for (const [wsId, c] of next.compounds) {
    const o = prev.compounds.get(wsId);
    if (!o) continue;
    if (c.w > o.w || c.h > o.h) out.expanded.push(wsId);
    if (c.x0 !== o.x0 || c.y0 !== o.y0) out.relocated.push({ wsId, dx: c.x0 - o.x0, dy: c.y0 - o.y0 });
  }
  return out;
}
