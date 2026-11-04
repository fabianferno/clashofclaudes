// Astro adapter (ClientRouter). The leave animation runs in parallel with fetching the next page.
import { boot, cleanup, enter, leave, syncFlags } from './index';

let navigating = false;
let backForward = false;

export function start(setup?: () => void) {
  document.addEventListener('astro:before-preparation', (e) => {
    navigating = true;
    backForward = e.navigationType === 'traverse';
    const load = e.loader;
    e.loader = async () => { await Promise.all([backForward ? Promise.resolve() : leave(), load()]); };
  });
  document.addEventListener('astro:before-swap', () => cleanup());
  document.addEventListener('astro:after-swap', () => syncFlags());
  document.addEventListener('astro:page-load', () => {
    if (!navigating) return void boot(setup);
    navigating = false;
    enter(backForward ? { transition: false, scrollTop: false } : undefined);
  });
  boot(setup);
}
