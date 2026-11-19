import { vi } from 'vitest';
import type { Settings, SessionInfo } from '../api/types';
import { useApp } from './store';
import { DEFAULT_SETTINGS } from './settings';
import { levelFor, mixFor, watchAmbience, type Ambience, type AmbienceMix } from './ambience';
import { strike } from '../village/weather';

const on: Settings = { ...DEFAULT_SETTINGS, ambienceOn: true, soundVolume: 100, ambienceVolume: 100 };

test('the mix follows the weather', () => {
  expect(mixFor({ sky: 'night', storms: [] })).toMatchObject({ crickets: true, birds: 0, rain: 0 });
  const sunny = mixFor({ sky: 'sunny', storms: [] });
  expect(sunny.crickets).toBe(false);
  expect(sunny.birds).toBeGreaterThan(mixFor({ sky: 'day', storms: [] }).birds);
  expect(mixFor({ sky: 'day', storms: ['w1'] }).rain).toBeGreaterThan(0);
  expect(mixFor({ sky: 'day', storms: ['w1', 'w2'] }).rain).toBeGreaterThan(mixFor({ sky: 'day', storms: ['w1'] }).rain);
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

test('the engine is made only once it is turned on, follows the weather and thunders after lightning', () => {
  const sets: Array<{ mix: AmbienceMix; level: number }> = [];
  const last = () => sets[sets.length - 1];
  const thunder = vi.fn(), close = vi.fn();
  const make = vi.fn((): Ambience => ({ set: (mix, level) => sets.push({ mix, level }), thunder, unlock: () => {}, close }));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  useApp.setState({
    settings: DEFAULT_SETTINGS, sessions: {},
    workspaces: [{ id: 'w1', name: 'shop', path: '/w', createdAt: 0, missing: false, level: 1, xp: 0, compound: { x0: 0, y0: 0, w: 8, h: 8, house: { x: 1, y: 1 } } }],
  });
  const stop = watchAmbience(make);
  expect(make).not.toHaveBeenCalled();

  useApp.setState({ settings: on });
  expect(make).toHaveBeenCalledTimes(1);
  expect(last().level).toBeGreaterThan(0);
  expect(last().mix.crickets).toBe(true); // nothing runs: night

  strike('w1');
  expect(thunder).not.toHaveBeenCalled(); // no storm here

  const stuck = { id: 's', workspaceId: 'w1', kind: { kind: 'agent', builderId: 'b' }, state: { kind: 'stuck', reason: 'x' }, stateSince: 1 } as unknown as SessionInfo;
  useApp.setState({ sessions: { s: stuck } });
  expect(last().mix.rain).toBeGreaterThan(0);
  strike('w1');
  expect(thunder).toHaveBeenCalledTimes(1);

  useApp.setState({ settings: { ...on, ambienceOn: false } });
  expect(last().level).toBe(0);
  expect(make).toHaveBeenCalledTimes(1);
  stop();
  expect(close).toHaveBeenCalled();
});
