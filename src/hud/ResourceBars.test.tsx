import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { AgentInfo, AgentQuota } from '../api/types';
import { useApp } from '../state/store';
import ResourceBars, { resourceBar } from './ResourceBars';

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;
const quota = (agent: AgentQuota['agent'], leftPct: number, resetsAt: number | null = NOW + 2 * DAY): AgentQuota => ({
  agent, updatedAt: NOW, source: 'test',
  windows: [{ id: 'w', label: 'Weekly limit', group: null, leftPct, resetsAt, windowMins: 10_080 }],
});
const agent = (kind: AgentInfo['kind'], installed: boolean): AgentInfo => ({ kind, label: kind, installed, version: null, models: [], efforts: [], canApprove: false });

beforeEach(() => {
  act(() => useApp.setState({
    quotas: { claude: quota('claude', 42) },
    agents: [agent('claude', true), agent('codex', true), agent('antigravity', false), agent('opencode', true)],
    selection: null,
  }));
});
afterEach(cleanup);

test('a bar shows how much of the main limit is left, and when it refills', () => {
  expect(resourceBar(quota('claude', 41.6), NOW, 'claude')).toEqual({
    pct: 42, value: '42%', sub: 'Claude · week', title: 'Claude: 42% of Weekly limit left, refills in 2d',
  });
  expect(resourceBar(quota('codex', 0), NOW, 'codex').value).toBe('Empty');
  expect(resourceBar(undefined, NOW, 'antigravity')).toEqual({ pct: null, value: '—', sub: 'Antigravity', title: 'Antigravity: no limits read yet' });
});

test('one bar per rationed agent with a reading or installed; a click opens its collector', () => {
  render(<ResourceBars />);
  expect(screen.getByTestId('resource-claude')).toBeTruthy();
  expect(screen.getByTestId('resource-codex').textContent).toContain('—'); // installed, nothing read yet
  expect(screen.queryByTestId('resource-antigravity')).toBeNull(); // not installed, no reading
  expect(screen.queryByTestId('resource-opencode')).toBeNull(); // not rationed
  fireEvent.click(screen.getByTestId('resource-claude'));
  expect(useApp.getState().selection).toEqual({ kind: 'quota', agent: 'claude' });
});
