import { zoomKey } from './VillageCanvas';

const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = { metaKey: true }) =>
  zoomKey({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });

test('cmd plus and minus zoom, cmd 0 fits the village', () => {
  expect(k('=')).toBe('in');
  expect(k('+')).toBe('in');
  expect(k('-')).toBe('out');
  expect(k('0')).toBe('fit');
  expect(k('-', { ctrlKey: true })).toBe('out');
});

test('plain or option keys are left alone', () => {
  expect(k('-', {})).toBeNull();
  expect(k('=', { metaKey: true, altKey: true })).toBeNull();
  expect(k('a')).toBeNull();
});
