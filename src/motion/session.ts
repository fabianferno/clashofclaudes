// The signature driver: the chapter in view sets the session state on the stage.
// One variable (state) feeds every visual: the builder's pose, the bubble, the tent, the HUD.
// Idle input: while the builder works, the tool step counter ticks on the GSAP clock.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { isMobile, onPage, prefersReducedMotion } from '../engine';

type State = 'working' | 'needs' | 'allowed' | 'finished';
const captions: Record<State, string> = {
  working: 'The builder hammers and the tent starts going up: the agent is working.',
  needs: 'A red “!” over the builder and the tent stops half raised: the agent is waiting on a permission prompt.',
  allowed: 'Allowed from the village. The builder picks the hammer back up.',
  finished: 'The tent stands and the builder cheers: the session finished.',
};
const statusText: Record<State, string> = { working: 'Working', needs: 'Needs you', allowed: 'Working', finished: 'Finished' };
const stepsAt: Record<State, number> = { working: 3, needs: 11, allowed: 12, finished: 23 };

export function startSession() {
  onPage(() => {
    const stage = document.querySelector<HTMLElement>('[data-stage]');
    if (!stage) return;
    const status = stage.querySelector<HTMLElement>('[data-stage-status]')!;
    const stepsEl = stage.querySelector<HTMLElement>('[data-stage-steps]')!;
    const shipped = stage.querySelector<HTMLElement>('[data-stage-shipped]')!;
    const caption = stage.querySelector<HTMLElement>('[data-stage-caption]')!;
    const chapters = [...document.querySelectorAll<HTMLElement>('[data-chapter]')];
    const reduced = prefersReducedMotion();
    let state: State | null = null;
    let steps = 0;

    const apply = (next: State) => {
      if (next === state) return;
      const prev = state;
      state = next;
      stage.dataset.state = next;
      status.textContent = statusText[next];
      caption.textContent = captions[next];
      chapters.forEach((c) => c.classList.toggle('is-active', c.dataset.chapter === next));
      const order: State[] = ['working', 'needs', 'allowed', 'finished'];
      const forward = prev !== null && order.indexOf(next) > order.indexOf(prev);
      steps = forward ? Math.max(steps, stepsAt[next]) : stepsAt[next];
      stepsEl.textContent = String(steps);
      const done = next === 'finished';
      if (shipped.textContent !== (done ? '1' : '0')) {
        shipped.textContent = done ? '1' : '0';
        if (done && !reduced) gsap.fromTo(shipped, { scale: 1.9 }, { scale: 1, duration: 0.6, ease: 'back.out(3)' });
      }
      if (done && !reduced) { stage.classList.remove('is-puff'); void stage.offsetWidth; stage.classList.add('is-puff'); }
    };

    apply('working');
    // Phones have no room to pin the stage beside the text, so it plays the session on its own
    // clock while on screen (see the tick below) and the chapter list follows it.
    const auto = isMobile();
    if (!auto) chapters.forEach((c) => {
      ScrollTrigger.create({
        trigger: c,
        start: 'top 60%',
        end: 'bottom 60%',
        onToggle: (self) => { if (self.isActive) apply(c.dataset.chapter as State); },
      });
    });

    // Idle: tool steps tick while the builder works and the stage is on screen.
    let visible = false;
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    io.observe(stage);
    let acc = 0;
    let held = 0;
    const order: State[] = ['working', 'needs', 'allowed', 'finished'];
    const tick = (_t: number, dt: number) => {
      if (auto && visible && !reduced) {
        held += dt;
        if (held > (state === 'finished' ? 4200 : 3000)) { held = 0; apply(order[(order.indexOf(state!) + 1) % order.length]); }
      }
      if (!visible || reduced || (state !== 'working' && state !== 'allowed')) return;
      acc += dt;
      if (acc > 1400) {
        acc = 0;
        const cap = state === 'working' ? stepsAt.needs - 1 : stepsAt.finished - 1;
        if (steps < cap) { steps++; stepsEl.textContent = String(steps); }
      }
    };
    gsap.ticker.add(tick);
    return () => { gsap.ticker.remove(tick); io.disconnect(); };
  });
}
