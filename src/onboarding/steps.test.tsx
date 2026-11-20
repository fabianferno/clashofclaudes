import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { Workspace } from '../api/types';
import { copyOf, type StepContext } from './steps';

const sample = (ships: number[]): Workspace => ({ id: 'demo-ws', name: 'sample-app', path: '', createdAt: 0, missing: false, compound: null, ships });
const ctx = (s: Workspace | undefined): StepContext => ({ hall: 'your Town Hall', name: null, builder: 'Ada', session: undefined, sample: s });

test('the review step says accepting ships the work and livens the house', () => {
  const session = { reachedFinished: true, state: { kind: 'finished' } } as unknown as StepContext['session'];
  const c = copyOf('review', { ...ctx(sample([])), session });
  expect(c.title).toBe('Ready to review');
  render(<>{c.body}</>);
  expect(document.body.textContent).toContain('livens up');
  expect(document.body.textContent).not.toMatch(/\bXP\b|level up/i);
});

test('a review of an unfinished session says closing it does not ship', () => {
  const session = { reachedFinished: false, state: { kind: 'ended' } } as unknown as StepContext['session'];
  const c = copyOf('review', { ...ctx(sample([])), session });
  expect(c.title).toBe('Close it');
  render(<>{c.body}</>);
  expect(screen.getByText(/doesn't count as shipped/)).toBeTruthy();
});
