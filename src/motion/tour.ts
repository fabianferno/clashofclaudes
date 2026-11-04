// Signature two: a camera over the real window. One variable (scroll progress through the pinned
// section) drives the camera, the active stop's text and its ring, so they always agree.
// Each stop holds the camera on a point of the screenshot; between stops it glides.
// Under reduced motion nothing pins: the whole window shows and every stop reads as a list.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ease, onPage, prefersReducedMotion } from '../engine';

/** Camera transform (percent of the view, scale) that centres point (x, y) at `zoom`, never showing past the edges. */
export function frame(x: number, y: number, zoom: number) {
  const clamp = (v: number) => Math.min(0, Math.max((1 - zoom) * 100, v));
  return { scale: zoom, xPercent: clamp((0.5 - x * zoom) * 100), yPercent: clamp((0.5 - y * zoom) * 100) };
}

export function startTour() {
  onPage(() => {
    const section = document.querySelector<HTMLElement>('[data-tour]');
    if (!section || prefersReducedMotion()) return;
    const cam = section.querySelector<HTMLElement>('[data-tour-cam]')!;
    const stops = [...section.querySelectorAll<HTMLElement>('[data-stop]')];
    const rings = [...section.querySelectorAll<HTMLElement>('[data-ring]')];
    const frames = stops.map((s) => frame(+s.dataset.x!, +s.dataset.y!, +s.dataset.zoom!));
    section.classList.add('is-live');

    let active = -1;
    const mark = (i: number) => {
      if (i === active) return;
      active = i;
      stops.forEach((s, j) => s.classList.toggle('is-active', j === i));
      rings.forEach((r, j) => r.classList.toggle('is-on', j === i));
    };
    mark(0);
    gsap.set(cam, frames[0]);

    // Hold on each stop for one unit, glide to the next over one unit.
    // Timeline time: stop i holds over [2i - 1, 2i], so the text switches halfway through each glide.
    const tl = gsap.timeline({ defaults: { ease: ease.inOut } });
    frames.slice(1).forEach((f) => tl.to(cam, { ...f, duration: 1 }, '+=1'));
    tl.to({}, { duration: 1 });
    const step = 2;
    ScrollTrigger.create({
      trigger: section,
      start: 'top top',
      end: () => `+=${window.innerHeight * stops.length * 0.9}`,
      pin: section.querySelector('.tour__pin'),
      scrub: 0.6,
      animation: tl,
      invalidateOnRefresh: true,
      onUpdate: (self) => mark(Math.min(stops.length - 1, Math.floor((self.progress * tl.duration() + 0.5) / step))),
    });
  });
}
