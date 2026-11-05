// Global motion for this site: runs once on the client before the first page initializes.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ease, onPage, onScroll, setTransition } from '../engine';
import { startHero } from './hero';
import { startAgents } from './agents';
import { startTrailer } from './trailer';
import { startReel } from './reel';
import { site } from '../data/site';

export function setupMotion() {
  // The forest closes in: a tree-lined panel rises over the page, then lifts off the next one.
  setTransition({
    leave: (c) => gsap.timeline()
      .set(c, { autoAlpha: 1 })
      .fromTo(c.querySelector('.curtain__panel'), { yPercent: 115 }, { yPercent: 0, duration: 0.75, ease: ease.inOut })
      .fromTo(c.querySelector('.curtain__mark'), { scale: 0.6, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.45, ease: ease.settle }, '-=0.3'),
    enter: (c) => gsap.timeline()
      .to(c.querySelector('.curtain__mark'), { scale: 0.8, autoAlpha: 0, duration: 0.2 })
      .to(c.querySelector('.curtain__panel'), { yPercent: -115, duration: 0.85, ease: ease.inOut }, 0.05)
      .set(c, { autoAlpha: 0 }),
  });

  // The HUD steps aside while reading down, and comes back on any scroll up.
  let last = 0;
  onScroll(({ y }) => {
    document.documentElement.classList.toggle('hud-solid', y > 40);
    if (Math.abs(y - last) < 6) return;
    document.documentElement.classList.toggle('hud-away', y > 240 && y > last && !document.documentElement.classList.contains('menu-open'));
    last = y;
  });

  startHero();
  startAgents();
  startTrailer();
  startReel();
  toc();
  menu();
  version();
}

// "You are here" for the doc pages' table of contents.
function toc() {
  onPage(() => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('.doc__toc a[href^="#"]')];
    if (!links.length) return;
    const mark = (id: string) => links.forEach((a) => {
      const on = a.hash === `#${id}`;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
    });
    links.forEach((a) => {
      const section = document.getElementById(a.hash.slice(1));
      if (!section) return;
      ScrollTrigger.create({ trigger: section, start: 'top 45%', end: 'bottom 45%', onToggle: (self) => { if (self.isActive) mark(section.id); } });
    });
  });
}

function menu() {
  onPage(() => {
    const btn = document.querySelector<HTMLButtonElement>('[data-menu-toggle]');
    const panel = document.querySelector<HTMLElement>('[data-menu]');
    if (!btn || !panel) return;
    const label = btn.querySelector('.hud__menu-label')!;
    const html = document.documentElement;
    const focusables = () => [btn, ...panel.querySelectorAll<HTMLElement>('a')];
    const set = (open: boolean) => {
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      label.textContent = open ? 'Close' : 'Menu';
      html.classList.toggle('menu-open', open);
      html.classList.remove('hud-away');
      if (open) panel.querySelector<HTMLElement>('a')?.focus();
    };
    const toggle = () => set(panel.hidden);
    const key = (e: KeyboardEvent) => {
      if (panel.hidden) return;
      if (e.key === 'Escape') { set(false); btn.focus(); }
      if (e.key === 'Tab') {
        const f = focusables();
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    const click = (e: Event) => { if ((e.target as HTMLElement).closest('a')) set(false); };
    btn.addEventListener('click', toggle);
    panel.addEventListener('click', click);
    document.addEventListener('keydown', key);
    return () => {
      btn.removeEventListener('click', toggle);
      panel.removeEventListener('click', click);
      document.removeEventListener('keydown', key);
      html.classList.remove('menu-open');
    };
  });
}

// Latest version from the public releases repo. Silent on any failure (the repo may not exist yet).
let latest: string | null | undefined;
function version() {
  const paint = () => {
    if (!latest) return;
    document.querySelectorAll<HTMLElement>('[data-version]').forEach((el) => {
      el.textContent = `Latest: ${latest}`;
      el.hidden = false;
    });
  };
  const KEY = 'coc-latest';
  const read = () => {
    try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); return c && Date.now() - c.at < 36e5 ? c : null; } catch { return null; }
  };
  const save = (tag: string | null) => { try { localStorage.setItem(KEY, JSON.stringify({ tag, at: Date.now() })); } catch {} };
  onPage(({ path }) => {
    if (latest !== undefined) return paint();
    // The build bakes the version in; only the home page checks for a newer one.
    if (path !== '/') return;
    const cached = read(); // one GitHub API call per visitor per hour at most (its limit is 60/h per IP)
    if (cached) { latest = cached.tag; return paint(); }
    latest = null;
    fetch(site.latestApi, { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const tag = j && typeof j.tag_name === 'string' ? j.tag_name.trim() : '';
        if (/^v?\d+(\.\d+){0,3}([-.+][\w.]+)?$/.test(tag)) { latest = tag.startsWith('v') ? tag : `v${tag}`; paint(); }
        save(latest);
      })
      .catch(() => {});
  });
}
