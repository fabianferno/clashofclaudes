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
  // the builder's portrait, not the initial of its name
  expect(card.querySelector('.hud-av canvas')).toBeTruthy();
  expect(card.querySelector('.hud-av')!.textContent).toBe('');
});

test('badge follows live session state; click on a busy builder opens its session', () => {
  act(() => useApp.setState({ sessions: { s: { id: 's', workspaceId: 'w', kind: { kind: 'agent', builderId: 'b1' }, state: { kind: 'needsYou' }, rev: 1, startedAt: 0 } as unknown as SessionInfo } }));
  render(<BuildersBar />);
  expect(screen.getByTestId('badge-b1').getAttribute('data-state')).toBe('needs');
  fireEvent.click(screen.getByTestId('builder-card-b1'));
  expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's' });
  expect(screen.getByTestId('builder-card-b1').className).toContain('selected');
});

test('click on an idle builder (only ended sessions) selects the builder', () => {
  act(() => useApp.setState({ sessions: { s: { id: 's', workspaceId: 'w', kind: { kind: 'agent', builderId: 'b1' }, state: { kind: 'ended', exitCode: 0 }, rev: 1, startedAt: 0 } as unknown as SessionInfo } }));
  render(<BuildersBar />);
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

test('no empty card container with zero builders', () => {
  act(() => useApp.setState({ builders: [] }));
  render(<BuildersBar />);
  expect(screen.queryByTestId('builders-list')).toBeNull();
  expect(screen.getByRole('button', { name: /Builders/ })).toBeTruthy();
});

test('cards sort by status: needs you, stuck, ready, working, idle; recruitment order within a status', () => {
  const b = (id: string): Builder => ({ ...claude, id, name: id });
  const s = (id: string, kind: string) => ({ id: `s-${id}`, workspaceId: 'w', kind: { kind: 'agent', builderId: id }, state: { kind }, rev: 1, startedAt: 0 } as unknown as SessionInfo);
  act(() => useApp.setState({
    builders: ['idle1', 'work', 'ready', 'idle2', 'stuck', 'needs'].map(b),
    sessions: Object.fromEntries([s('work', 'working'), s('ready', 'finished'), s('stuck', 'stuck'), s('needs', 'needsYou')].map((x) => [x.id, x])),
  }));
  render(<BuildersBar />);
  const order = [...screen.getByTestId('builders-list').querySelectorAll('[data-testid^="builder-card-"]')].map((e) => e.getAttribute('data-testid')!.slice('builder-card-'.length));
  expect(order).toEqual(['needs', 'stuck', 'ready', 'work', 'idle1', 'idle2']);
});
