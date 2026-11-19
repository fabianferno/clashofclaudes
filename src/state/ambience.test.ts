import { vi } from 'vitest';
import type { Settings } from '../api/types';
import { useApp } from './store';
import { DEFAULT_SETTINGS } from './settings';
import { levelFor, mixFor, watchAmbience, type Ambience, type AmbienceMix } from './ambience';
import { daylightAtHour } from '../village/daylight';

const on: Settings = { ...DEFAULT_SETTINGS, ambienceOn: true, soundVolume: 100, ambienceVolume: 100 };

test('the mix follows the time of day: a dawn chorus, birds by day, crickets at night', () => {
  const night = mixFor(daylightAtHour(1));
  expect(night).toMatchObject({ crickets: true, birds: 0 });
  const noon = mixFor(daylightAtHour(13));
  expect(noon.crickets).toBe(false);
  expect(noon.birds).toBeGreaterThan(0);
  expect(mixFor(daylightAtHour(6.8)).birds).toBeGreaterThan(noon.birds); // dawn chorus
  expect(mixFor(daylightAtHour(18.5)).birds).toBeLessThanOrEqual(noon.birds); // no chorus at sunset
  expect(noon.wind).toBeGreaterThan(night.wind);
});

test('silent unless on, with sounds on and the window shown; softer behind another app', () => {
  expect(levelFor(DEFAULT_SETTINGS, 'front')).toBe(0); // off until turned on
  expect(levelFor(null, 'front')).toBe(0);
  expect(levelFor({ ...on, soundsOn: false }, 'front')).toBe(0);
  expect(levelFor(on, 'hidden')).toBe(0);
  const front = levelFor(on, 'front');
  expect(front).toBeGreaterThan(0);
  expect(front).toBeLessThanOrEqual(0.5);
  expect(levelFor(on, 'back')).toBeLessThan(front);
  expect(levelFor({ ...on, ambienceVolume: 50 }, 'front')).toBeCloseTo(front / 2);
});

test('the engine is made only once it is turned on, and follows the clock', () => {
  const sets: Array<{ mix: AmbienceMix; level: number }> = [];
  const last = () => sets[sets.length - 1];
  const close = vi.fn();
  const make = vi.fn((): Ambience => ({ set: (mix, level) => sets.push({ mix, level }), unlock: () => {}, close }));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  useApp.setState({ settings: DEFAULT_SETTINGS });
  let clock = new Date(2026, 10, 20, 23, 0);
  const stop = watchAmbience(make, () => clock);
  expect(make).not.toHaveBeenCalled();

  useApp.setState({ settings: on });
  expect(make).toHaveBeenCalledTimes(1);
  expect(last().level).toBeGreaterThan(0);
  expect(last().mix.crickets).toBe(true); // 11 PM

  clock = new Date(2026, 10, 21, 13, 0);
  useApp.setState({ settings: { ...on, ambienceVolume: 90 } });
  expect(last().mix.crickets).toBe(false);
  expect(last().mix.birds).toBeGreaterThan(0);

  useApp.setState({ settings: { ...on, ambienceOn: false } });
  expect(last().level).toBe(0);
  expect(make).toHaveBeenCalledTimes(1);
  stop();
  expect(close).toHaveBeenCalled();
});
