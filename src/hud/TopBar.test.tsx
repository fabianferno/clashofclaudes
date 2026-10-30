import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Builder, SessionInfo } from '../api/types';
import { useApp } from '../state/store';
import TopBar from './TopBar';

const B = (id: string): Builder => ({ id, name: id, agent: 'claude', model: 'opus', effort: 'max', customCommand: null });
const S = (id: string, builderId: string, kind: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, workspaceId: 'w', kind: { kind: 'agent', builderId }, state: { kind } as never, rev: 1, startedAt: 0, ...extra }) as SessionInfo;
const put = (builders: Builder[], sessions: SessionInfo[], stats = { shippedTotal: 0, recentShips: [] as number[] }) =>
  act(() => useApp.setState({ builders, sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), stats, selection: null }));

beforeEach(() => put([], []));
afterEach(() => vi.useRealTimers());

test('pills_count_states', () => {
  put(['a', 'b', 'c', 'd', 'e', 'f'].map(B), [
    S('1', 'a', 'working'), S('2', 'b', 'starting'), S('3', 'c', 'needsYou'), S('4', 'd', 'stuck'), S('5', 'e', 'finished'),
    { ...S('t', 'a', 'working'), kind: { kind: 'terminal' } } as SessionInfo,
  ]);
  render(<TopBar />);
  expect(screen.getByTestId('pill-building').textContent).toContain('2 building');
  expect(screen.getByTestId('pill-needs').textContent).toContain('1 needs you');
  expect(screen.getByTestId('pill-stuck').textContent).toContain('1 stuck');
  expect(screen.getByTestId('pill-finished').textContent).toContain('1 ready to review');
  expect(screen.getByTestId('pill-idle').textContent).toContain('1 idle');
  expect(screen.getByTestId('pill-needs').className).toContain('pulse');
  expect(screen.getByText(/Builders busy/).parentElement!.textContent).toContain('5 / 6');
});

test('zero_pills_hidden', () => {
  put([B('a')], []);
  render(<TopBar />);
  expect(screen.queryByTestId('pill-building')).toBeNull();
  expect(screen.queryByTestId('pill-needs')).toBeNull();
  expect(screen.queryByTestId('pill-stuck')).toBeNull();
  expect(screen.queryByTestId('pill-finished')).toBeNull();
  expect(screen.getByTestId('pill-idle').textContent).toContain('1 idle');
});

test('pill click selects first matching session / idle builder', () => {
  put([B('a'), B('b')], [S('1', 'a', 'needsYou')]);
  render(<TopBar />);
  fireEvent.click(screen.getByTestId('pill-needs'));
  expect(useApp.getState().selection).toEqual({ kind: 'session', id: '1' });
  fireEvent.click(screen.getByTestId('pill-idle'));
  expect(useApp.getState().selection).toEqual({ kind: 'builder', id: 'b' });
});

test('shipped_today_counts_since_midnight', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 31, 15, 0, 0));
  const midnight = new Date(2026, 9, 31).getTime();
  put([], [], { shippedTotal: 12, recentShips: [midnight - 1, midnight, midnight + 5000, Date.now()] });
  render(<TopBar />);
  expect(screen.getByTestId('shipped-today').textContent).toContain('3');
  expect(screen.getByTestId('village-level').textContent).toContain('12');
});

test('no_tokens_shown', () => {
  render(<TopBar />);
  expect(screen.queryByText(/token/i)).toBeNull();
});
