import { daylightAt, daylightAtHour } from './daylight';
import { tintOf } from './daylightFx';

test('night from 9 PM to 5 AM, day from 7 AM to 7 PM, fading between', () => {
  expect(daylightAtHour(0).night).toBe(1);
  expect(daylightAtHour(4.9).night).toBe(1);
  expect(daylightAtHour(22).night).toBe(1);
  expect(daylightAtHour(12).night).toBe(0);
  expect(daylightAtHour(7).night).toBe(0);
  expect(daylightAtHour(18.9).night).toBe(0);
  const dawn = daylightAtHour(6).night, dusk = daylightAtHour(20).night;
  expect(dawn).toBeGreaterThan(0); expect(dawn).toBeLessThan(1);
  expect(dusk).toBeGreaterThan(0); expect(dusk).toBeLessThan(1);
  expect(daylightAtHour(20.5).night).toBeGreaterThan(daylightAtHour(19.5).night);
});

test('golden at sunrise and sunset only', () => {
  expect(daylightAtHour(6.5).golden).toBe(1);
  expect(daylightAtHour(18.5).golden).toBe(1);
  expect(daylightAtHour(12).golden).toBe(0);
  expect(daylightAtHour(1).golden).toBe(0);
  expect(daylightAtHour(17.8).golden).toBeGreaterThan(0);
  expect(daylightAtHour(6.5).morning).toBe(true);
  expect(daylightAtHour(18.5).morning).toBe(false);
});

test('reads the local clock', () => {
  expect(daylightAt(new Date(2026, 10, 20, 23, 30))).toEqual(daylightAtHour(23.5));
  expect(daylightAt(new Date(2026, 10, 20, 12, 0)).night).toBe(0);
});

test('the tint is clear at midday, blue at night and warm at sunset', () => {
  expect(tintOf(0, 0).alpha).toBe(0);
  const night = tintOf(1, 0);
  expect(night.alpha).toBeGreaterThan(0.5);
  expect(night.color & 0xff).toBeGreaterThan((night.color >> 16) & 0xff); // more blue than red
  const golden = tintOf(0, 1);
  expect(golden.alpha).toBeLessThan(0.35);
  expect((golden.color >> 16) & 0xff).toBeGreaterThan(golden.color & 0xff); // more red than blue
});
