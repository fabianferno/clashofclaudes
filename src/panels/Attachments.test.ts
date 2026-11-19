import { expect, test } from 'vitest';
import { dropPoint } from './Attachments';

test('a drop on macOS is already in CSS px, even on Retina', () => {
  expect(dropPoint({ x: 400, y: 300 }, true, 2)).toEqual({ x: 400, y: 300 });
});

test('elsewhere the drop is physical px and is scaled down', () => {
  expect(dropPoint({ x: 400, y: 300 }, false, 2)).toEqual({ x: 200, y: 150 });
});
