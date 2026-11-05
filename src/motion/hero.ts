// Small life around the edges, all on the GSAP clock:
// - the hero's floating village moves in three depth layers: parallax on scroll, and against the pointer on a desktop;
// - a click anywhere kicks up a puff of dust, the same puff a finished tent makes.
import { gsap } from 'gsap';
import { isTouch, onPage, prefersReducedMotion, scrollState } from '../engine';

export function startHero() {
  onPage(() => {
    if (prefersReducedMotion()) return;
    const cleanups: (() => void)[] = [];

    const field = document.querySelector<HTMLElement>('[data-hero-field]');
    if (field) {
      // Each depth layer moves by its depth, so the village has parallax: on scroll the far trees
      // lag behind the page and the builders run ahead of it; on a desktop pointer every layer
      // also slides against the pointer.
      const layers = [...field.querySelectorAll<HTMLElement>('[data-depth]')].map((el) => ({ el, depth: +el.dataset.depth! }));
      const pointer = !isTouch();
      const tilt = { x: 0, y: 0 };
      const target = { x: 0, y: 0 };
      const move = (e: PointerEvent) => {
        target.x = e.clientX / window.innerWidth - 0.5;
        target.y = e.clientY / window.innerHeight - 0.5;
      };
      const tick = () => {
        const y = scrollState().y;
        if (y > window.innerHeight * 1.2) return;
        tilt.x += (target.x - tilt.x) * 0.05;
        tilt.y += (target.y - tilt.y) * 0.05;
        for (const l of layers) {
          gsap.set(l.el, { x: -tilt.x * l.depth * 34, y: -tilt.y * l.depth * 22 + y * 0.55 * (1 - l.depth) });
        }
      };
      if (pointer) window.addEventListener('pointermove', move, { passive: true });
      gsap.ticker.add(tick);
      cleanups.push(() => { window.removeEventListener('pointermove', move); gsap.ticker.remove(tick); });
    }

    const puff = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('input, textarea, select')) return;
      const img = document.createElement('img');
      img.src = '/img/puff.webp';
      img.alt = '';
      img.className = 'click-puff';
      img.style.left = `${e.clientX}px`;
      img.style.top = `${e.clientY}px`;
      document.body.appendChild(img);
      gsap.fromTo(img, { scale: 0.3, autoAlpha: 0.9 }, { scale: 1.3, autoAlpha: 0, duration: 0.6, ease: 'power2.out', onComplete: () => img.remove() });
    };
    window.addEventListener('pointerdown', puff);
    cleanups.push(() => window.removeEventListener('pointerdown', puff));

    return () => cleanups.forEach((c) => c());
  });
}
