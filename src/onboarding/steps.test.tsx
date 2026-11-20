import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { Workspace } from '../api/types';
import { copyOf, type StepContext } from './steps';

const sample = (ships: number[]): Workspace => ({ id: 'demo-ws', name: 'sample-app', path: '', createdAt: 0, missing: false, compound: null, ships });
const ctx = (s: Workspace | undefined): StepContext => ({ hall: 'your Town Hall', name: null, builder: 'Ada', session: undefined, sample: s });

test('the shipped step: the sample house livens up once its work ships', () => {
  const c = copyOf('shipped', ctx(sample([Date.now()])));
  expect(c.title).toBe('Shipped');
  render(<>{c.body}</>);
  expect(document.body.textContent).toContain('livens up');
  expect(document.body.textContent).not.toMatch(/\bXP\b|level up/i);
});

test('the shipped step without a ship says so', () => {
  const c = copyOf('shipped', ctx(sample([])));
  expect(c.title).toBe('Not shipped this time');
  render(<>{c.body}</>);
  expect(screen.getByText(/Accept finished work/)).toBeTruthy();
});
