import { daylightAt, daylightAtHour } from './daylight';

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
