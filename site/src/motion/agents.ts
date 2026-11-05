// The agents section: each agent reports to the village in turn. The agent's bubble opens with
// its state, a report travels its line to the village icon, the village takes it with a bump,
// then the next agent speaks. One looping timeline, paused while the section is off screen.
// Under reduced motion nothing plays: the graph stays still and the bubbles stay hidden.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ease, onPage, prefersReducedMotion } from '../engine';

export function startAgents() {
  onPage(() => {
    const net = document.querySelector<HTMLElement>('[data-net]');
    if (!net || prefersReducedMotion()) return;
    const hub = net.querySelector<HTMLElement>('[data-hub] .net__tile')!;
    const nodes = [...net.querySelectorAll<HTMLElement>('[data-node] .net__tile')];
    const trips = [...net.querySelectorAll<HTMLElement>('[data-trip]')];
    const says = [...net.querySelectorAll<HTMLElement>('[data-say]')];
    const lines = [...net.querySelectorAll<SVGLineElement>('[data-line]')];

    const tl = gsap.timeline({ repeat: -1, paused: true, defaults: { ease: ease.out } });
    nodes.forEach((node, i) => {
      const t = i * 3.4;
      // The agent speaks.
      tl.to(node, { scale: 1.12, duration: 0.18, ease: 'power2.out' }, t)
        .to(node, { scale: 1, duration: 0.5, ease: ease.settle }, t + 0.18)
        .fromTo(says[i], { autoAlpha: 0, scale: 0.85, y: 8 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.5, ease: ease.settle }, t + 0.05)
        .call(() => lines.forEach((l, j) => l.classList.toggle('is-on', j === i)), undefined, t + 0.2)
      // Its report travels the line (the trip layer is the graph's size, so percents are of the graph).
        .fromTo(trips[i], { xPercent: 0, yPercent: 0, autoAlpha: 1 },
          { xPercent: +trips[i].dataset.dx!, yPercent: +trips[i].dataset.dy!, duration: 1, ease: ease.inOut }, t + 0.35)
        .to(trips[i], { autoAlpha: 0, duration: 0.15 }, t + 1.35)
      // The village takes it.
        .to(hub, { scale: 1.1, duration: 0.15, ease: 'power2.out' }, t + 1.3)
        .to(hub, { scale: 1, duration: 0.55, ease: ease.settle }, t + 1.45)
        .to(says[i], { autoAlpha: 0, y: -6, duration: 0.3, ease: 'power2.in' }, t + 3.05);
    });
    tl.call(() => lines.forEach((l) => l.classList.remove('is-on')));

    const st = ScrollTrigger.create({
      trigger: net, start: 'top 85%', end: 'bottom 10%',
      onToggle: (self) => (self.isActive ? tl.play() : tl.pause()),
    });
    return () => { st.kill(); tl.kill(); lines.forEach((l) => l.classList.remove('is-on')); };
  });
}
