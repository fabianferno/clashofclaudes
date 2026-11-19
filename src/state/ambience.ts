import type { Settings } from '../api/types';
import { daylightAt, type Daylight } from '../village/daylight';
import { useApp } from './store';

/**
 * The village's ambience: a quiet bed under the event sounds that follows the time of day (see
 * village/daylight.ts). Wind all day, birds by day with a chorus at dawn, crickets at night.
 * It is synthesized in the window (Web Audio), so there are no
 * sound files, and it plays only while the window is open: softer while another app is in front,
 * silent while the window is hidden. Off until turned on in Settings › Sounds.
 */

/** How loud the wind is (0..1 of the master level), how often birds call, and whether crickets sing. */
export interface AmbienceMix {
  wind: number;
  /** Bird calls a minute; 0 for none. */
  birds: number;
  crickets: boolean;
}

/** Birds a minute by day, and at the height of the dawn chorus. */
const BIRDS_DAY = 5;
const BIRDS_DAWN = 16;

export function mixFor(d: Daylight): AmbienceMix {
  const day = 1 - d.night;
  const chorus = d.morning ? d.golden : 0;
  const birds = day < 0.15 ? 0 : day * (BIRDS_DAY + (BIRDS_DAWN - BIRDS_DAY) * chorus);
  return { wind: 0.6 - 0.25 * d.night, birds: Math.round(birds * 10) / 10, crickets: d.night > 0.5 };
}

/** Whether the window is in front, behind another app, or hidden (minimized, or the mini village shown). */
export type Presence = 'front' | 'back' | 'hidden';

/** Kept low: a bed, not a soundtrack. */
const BASE = 0.35;
/** Behind another app it keeps going, softer. */
const BACK = 0.4;

/** The bed's master level, 0..1. */
export function levelFor(s: Settings | null, presence: Presence): number {
  if (!s?.ambienceOn || s.soundsOn === false || presence === 'hidden') return 0;
  const k = ((s.soundVolume ?? 70) / 100) * ((s.ambienceVolume ?? 50) / 100) * BASE;
  return presence === 'back' ? k * BACK : k;
}

export function presenceNow(): Presence {
  if (document.hidden) return 'hidden';
  return document.hasFocus() ? 'front' : 'back';
}

/** What plays the bed (the Web Audio engine below; tests give a fake). */
export interface Ambience {
  set(mix: AmbienceMix, level: number): void;
  /** A user gesture: audio may start now (browsers keep it suspended until one). */
  unlock(): void;
  close(): void;
}

/** How often the clock is read again. */
const RECHECK_MS = 10_000;

/**
 * Plays the ambience as settings, the window's presence and the time of day change.
 * The engine is made only once the ambience is first on. Returns a stop.
 */
export function watchAmbience(make: () => Ambience = () => new WebAmbience(), now: () => Date = () => new Date()): () => void {
  let engine: Ambience | null = null;
  const apply = () => {
    const level = levelFor(useApp.getState().settings, presenceNow());
    if (level > 0 && !engine) {
      try { engine = make(); } catch { return; } // no audio here
    }
    engine?.set(mixFor(daylightAt(now())), level);
  };
  const unsub = useApp.subscribe((st, prev) => { if (st.settings !== prev.settings) apply(); });
  const timer = window.setInterval(apply, RECHECK_MS);
  const unlock = () => engine?.unlock();
  window.addEventListener('focus', apply);
  window.addEventListener('blur', apply);
  document.addEventListener('visibilitychange', apply);
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  apply();
  return () => {
    unsub();
    window.clearInterval(timer);
    window.removeEventListener('focus', apply);
    window.removeEventListener('blur', apply);
    document.removeEventListener('visibilitychange', apply);
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    engine?.close();
    engine = null;
  };
}

// ---------------------------------------------------------------- the Web Audio engine

/** Seconds a level change takes to settle (setTargetAtTime's time constant). */
const GLIDE = 1.2;
/** Stopped for this long at level 0, the audio context is suspended (no CPU while silent). */
const SUSPEND_AFTER_MS = 3_000;
const CRICKETS = [{ f: 4400, every: 0.95 }, { f: 4950, every: 1.25 }];

/** Pink noise (Paul Kellet's economy filter), `seconds` long: the wind's grain. */
function pinkNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  // fade the loop's seam
  const f = Math.min(2048, n >> 2);
  for (let i = 0; i < f; i++) { const k = i / f; d[i] = d[i] * k + d[n - f + i] * (1 - k); }
  return buf;
}

class WebAmbience implements Ambience {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly wind: GainNode;
  private readonly calls: GainNode;
  private readonly noise: AudioBuffer;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private mix: AmbienceMix = { wind: 0, birds: 0, crickets: false };
  private level = 0;
  private timer: number | null = null;
  private silentSince: number | null = null;
  private nextBird = 0;
  private nextCricket = CRICKETS.map(() => 0);

  constructor() {
    this.ctx = new AudioContext();
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = 0;
    this.master.connect(c.destination);
    this.noise = pinkNoise(c, 4);

    // wind: low noise whose brightness and swell drift slowly
    const windSrc = this.loop(0);
    const windLp = c.createBiquadFilter();
    windLp.type = 'lowpass';
    windLp.frequency.value = 420;
    windLp.Q.value = 0.4;
    const swell = c.createGain();
    swell.gain.value = 0.75;
    this.wind = c.createGain();
    this.wind.gain.value = 0;
    windSrc.connect(windLp).connect(swell).connect(this.wind).connect(this.master);
    this.lfo(0.07, 220, windLp.frequency);
    this.lfo(0.113, 0.25, swell.gain);

    // birds and crickets
    this.calls = c.createGain();
    this.calls.gain.value = 1;
    this.calls.connect(this.master);
  }

  private loop(offset: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(0, offset);
    this.sources.push(s);
    return s;
  }

  private lfo(hz: number, depth: number, param: AudioParam): void {
    const o = this.ctx.createOscillator();
    o.frequency.value = hz;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(param);
    o.start();
    this.sources.push(o);
  }

  set(mix: AmbienceMix, level: number): void {
    this.mix = mix;
    this.level = level;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(level, t, GLIDE);
    this.wind.gain.setTargetAtTime(mix.wind, t, GLIDE * 2);
    if (level > 0) {
      this.silentSince = null;
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this.timer ??= window.setInterval(() => this.tick(), 200);
    } else {
      this.silentSince ??= Date.now();
    }
  }

  unlock(): void {
    if (this.level > 0 && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /** Schedules the calls due soon; suspends the context after a while at level 0. */
  private tick(): void {
    if (this.silentSince !== null && Date.now() - this.silentSince > SUSPEND_AFTER_MS) {
      if (this.timer !== null) window.clearInterval(this.timer);
      this.timer = null;
      this.ctx.suspend().catch(() => {});
      return;
    }
    const now = this.ctx.currentTime, ahead = now + 0.3;
    if (this.mix.birds > 0) {
      if (this.nextBird < now) this.nextBird = now + Math.random() * 3;
      if (this.nextBird < ahead) {
        this.bird(this.nextBird);
        const mean = 60 / this.mix.birds;
        this.nextBird += mean * (0.4 + Math.random() * 1.2);
      }
    }
    if (this.mix.crickets) {
      CRICKETS.forEach((k, i) => {
        if (this.nextCricket[i] < now) this.nextCricket[i] = now + Math.random();
        if (this.nextCricket[i] < ahead) {
          this.chirp(this.nextCricket[i], k.f, i ? 0.35 : -0.3);
          this.nextCricket[i] += k.every * (0.9 + Math.random() * 0.2);
        }
      });
    }
  }

  private voice(at: number, pan: number): { osc: OscillatorNode; env: GainNode } {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    env.gain.value = 0;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    osc.connect(env).connect(p).connect(this.calls);
    osc.start(at);
    return { osc, env };
  }

  /** A short call of two to five rising notes, somewhere left or right. */
  private bird(at: number): void {
    const notes = 2 + Math.floor(Math.random() * 4);
    const f0 = 2300 + Math.random() * 1400;
    const { osc, env } = this.voice(at, (Math.random() - 0.5) * 1.3);
    let t = at;
    for (let i = 0; i < notes; i++) {
      const f = f0 * (1 + (Math.random() - 0.3) * 0.25);
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 1.4, t + 0.06);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.05, t + 0.012);
      env.gain.linearRampToValueAtTime(0, t + 0.085);
      t += 0.11 + Math.random() * 0.06;
    }
    osc.stop(t + 0.05);
  }

  /** A cricket's chirp: three quick pulses. */
  private chirp(at: number, f: number, pan: number): void {
    const { osc, env } = this.voice(at, pan);
    osc.frequency.value = f;
    for (let i = 0; i < 3; i++) {
      const t = at + i * 0.055;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.022, t + 0.008);
      env.gain.linearRampToValueAtTime(0, t + 0.035);
    }
    osc.stop(at + 0.2);
  }

  close(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.ctx.close().catch(() => {});
  }
}
