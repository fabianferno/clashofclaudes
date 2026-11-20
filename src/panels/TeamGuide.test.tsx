import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import TeamGuide from './TeamGuide';

afterEach(cleanup);

test('folded at first, it opens to the steps in setup order', () => {
  render(<TeamGuide />);
  const guide = screen.getByText('How teams work, step by step').closest('details')!;
  expect(guide.open).toBe(false);
  fireEvent.click(screen.getByText('How teams work, step by step'));
  const titles = Array.from(guide.querySelectorAll('.team-guide-title')).map((e) => e.textContent);
  expect(titles).toEqual(['Connect', 'Share a workspace', 'Invite people', 'Pair their Mac', 'Visit', 'Lend and borrow builders', 'Answer from your phone']);
});

test('it warns what lending a builder means', () => {
  render(<TeamGuide />);
  expect(screen.getByText(/running an agent on your Mac with your logins/)).toBeTruthy();
});
