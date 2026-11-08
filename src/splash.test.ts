import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { armSplash, resetSplash, splashReady } from './splash';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
  document.body.innerHTML = '<div id="splash"></div>';
  resetSplash();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const splash = () => document.getElementById('splash');

it('stays up until both the scene and the state are ready, then fades and goes', () => {
  splashReady('scene');
  vi.advanceTimersByTime(100);
  expect(splash()?.classList.contains('done')).toBe(false);
  splashReady('state');
  vi.advanceTimersByTime(40);
  expect(splash()?.classList.contains('done')).toBe(true);
  vi.advanceTimersByTime(500);
  expect(splash()).toBeNull();
});

it('lifts anyway after the fallback when startup never finishes', () => {
  armSplash();
  splashReady('state');
  vi.advanceTimersByTime(9_000);
  expect(splash()?.classList.contains('done')).toBe(false);
  vi.advanceTimersByTime(1_100);
  expect(splash()?.classList.contains('done')).toBe(true);
});

it('does nothing when there is no splash element', () => {
  document.body.innerHTML = '';
  expect(() => { splashReady('scene'); splashReady('state'); vi.runAllTimers(); }).not.toThrow();
});
