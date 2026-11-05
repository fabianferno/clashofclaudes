// The feature reel: the beat under a line just below mid-screen picks the frame's clip, which plays
// from the start. It is read from live positions on every scroll, so a late font or layout change
// can't leave it stale. Only the shown clip plays, and only while the section is on screen.
// Reduced motion: the frame still follows the beats, showing each clip's poster.
import { onPage, onScroll, prefersReducedMotion } from '../engine';

export function startReel() {
  onPage(() => {
    const root = document.querySelector<HTMLElement>('[data-reel]');
    if (!root) return;
    const beats = [...root.querySelectorAll<HTMLElement>('[data-beat]')];
    const slides = [...root.querySelectorAll<HTMLElement>('[data-slide]')];
    const pips = [...root.querySelectorAll<HTMLElement>('[data-pip]')];
    const still = prefersReducedMotion();
    let on = -1;
    let seen = false;

    const clip = (i: number) => slides[i]?.querySelector('video');
    const play = (i: number) => {
      const v = clip(i);
      if (v && seen && !still) v.play().catch(() => {});
    };
    const show = (i: number) => {
      if (i === on) return;
      clip(on)?.pause();
      on = i;
      beats.forEach((b, k) => b.classList.toggle('is-active', k === i));
      slides.forEach((s, k) => s.classList.toggle('is-on', k === i));
      pips.forEach((p, k) => p.classList.toggle('is-on', k === i));
      const v = clip(i);
      if (v) v.currentTime = 0;
      play(i);
    };

    root.classList.add('is-live');
    show(0);
    // Up to 860px the frame pins over the beats (site.css), so the line sits a third of the way into
    // what is left below it.
    const stick = root.querySelector<HTMLElement>('.reel__stick')!;
    const stacked = matchMedia('(max-width: 860px)');
    const pick = () => {
      const top = stacked.matches ? stick.getBoundingClientRect().bottom : 0;
      const line = top + (innerHeight - top) * (top ? 0.35 : 0.55);
      // Stacked, a beat's box runs on below its text: go by where the text ends.
      const end = (b: HTMLElement) => (top ? b.lastElementChild! : b).getBoundingClientRect().bottom;
      const i = beats.findIndex((b) => end(b) > line);
      show(i === -1 ? beats.length - 1 : i);
    };
    const off = onScroll(pick);
    addEventListener('resize', pick);
    pick();
    const io = new IntersectionObserver(([e]) => {
      seen = e.isIntersecting;
      if (seen) play(on); else clip(on)?.pause();
    });
    io.observe(root);
    return () => { off(); removeEventListener('resize', pick); io.disconnect(); slides.forEach((_, i) => clip(i)?.pause()); };
  });
}
