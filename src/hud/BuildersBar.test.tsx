import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import type { Builder, SessionInfo } from '../api/types';
import { useApp } from '../state/store';
import BuildersBar from './BuildersBar';

const claude: Builder = { id: 'b1', name: 'Ada', agent: 'claude', model: 'opus', effort: 'max', customCommand: null };
beforeEach(() => act(() => useApp.setState({ builders: [claude], sessions: {}, selection: null, panelOpen: false })));

test('builder_card_shows_class_and_stars', () => {
  render(<BuildersBar />);
  const card = screen.getByTestId('builder-card-b1');
  expect(card.textContent).toContain('Ada');
  expect(card.textContent).toContain('Master');
  expect(card.textContent).toContain('★★★★');
  expect(card.textContent).not.toContain('★★★★★');
  expect(screen.getByTestId('badge-b1').getAttribute('data-state')).toBe('idle');
});

test('badge follows live session state; click selects builder', () => {
  act(() => useApp.setState({ sessions: { s: { id: 's', workspaceId: 'w', kind: { kind: 'agent', builderId: 'b1' }, state: { kind: 'needsYou' }, rev: 1, startedAt: 0 } as unknown as SessionInfo } }));
  render(<BuildersBar />);
  expect(screen.getByTestId('badge-b1').getAttribute('data-state')).toBe('needs');
  fireEvent.click(screen.getByTestId('builder-card-b1'));
  expect(useApp.getState().selection).toEqual({ kind: 'builder', id: 'b1' });
});

test('builders_bar_collapses', () => {
  render(<BuildersBar />);
  const bar = screen.getByTestId('builders-bar');
  expect(bar.className).not.toContain('collapsed');
  fireEvent.click(screen.getByText(/Builders/));
  expect(bar.className).toContain('collapsed');
  fireEvent.click(screen.getByText(/Builders/));
  expect(bar.className).not.toContain('collapsed');
});

test('vertical wheel scrolls sideways', () => {
  render(<BuildersBar />);
  const list = screen.getByTestId('builders-list');
  fireEvent.wheel(list, { deltaY: 40 });
  expect(list.scrollLeft).toBe(40);
});
