/**
 * The startup splash (#splash in index.html) stays up until the village scene has drawn its
 * first frame and the store has its state, so the HUD never shows over a half-built village.
 * A slow or failed start still lifts it after MAX_MS: the app's own error toasts take over.
 */
export type SplashPart = 'scene' | 'state';

const MAX_MS = 10_000;
const FADE_MS = 400;
const pending = new Set<SplashPart>(['scene', 'state']);
let timer: ReturnType<typeof setTimeout> | null = null;
let lifted = false;

function lift() {
  if (lifted) return;
  lifted = true;
  if (timer !== null) clearTimeout(timer);
  const el = document.getElementById('splash');
  if (!el) return;
  // two frames: the scene's first sync has been painted before the fade starts
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.classList.add('done');
    setTimeout(() => el.remove(), FADE_MS);
  }));
}

/** Marks one part of startup ready; the splash fades once every part is. */
export function splashReady(part: SplashPart) {
  pending.delete(part);
  if (pending.size === 0) lift();
}

/** Starts the fallback clock; called once at boot. */
export function armSplash() {
  if (timer === null && !lifted) timer = setTimeout(lift, MAX_MS);
}

/** Tests: start over. */
export function resetSplash() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  lifted = false;
  pending.clear();
  pending.add('scene').add('state');
}
