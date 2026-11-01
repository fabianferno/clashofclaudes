import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentQuota } from '../api/types';

vi.mock('../api/ipc', () => ({ ipc: { refreshQuotas: vi.fn() } }));
import { ipc } from '../api/ipc';
import { useApp } from '../state/store';
import QuotaPanel from './QuotaPanel';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const agy: AgentQuota = {
  agent: 'antigravity',
  updatedAt: NOW - 4 * 60_000,
  source: 'agy /usage',
  windows: [
    { id: 'g:weekly', label: 'Weekly limit', group: 'Gemini Models', leftPct: 90, resetsAt: NOW + 3 * 86_400_000, windowMins: 10_080 },
    { id: 'g:5h', label: '5-hour limit', group: 'Gemini Models', leftPct: 40, resetsAt: NOW + 2 * 3_600_000 + 10 * 60_000, windowMins: 300 },
    { id: 'c:5h', label: '5-hour limit', group: 'Claude and GPT models', leftPct: 8, resetsAt: NOW - 1000, windowMins: 300 },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  act(() => useApp.setState({ quotas: { antigravity: agy } }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

test('every window shows what is left and when it refills, grouped, shortest first', () => {
  render(<QuotaPanel agent="antigravity" />);
  expect(screen.getByText('Gemini Models')).toBeTruthy();
  const rows = screen.getAllByTestId(/^quota-g:/).map((r) => r.dataset.testid);
  expect(rows).toEqual(['quota-g:5h', 'quota-g:weekly']);
  const five = screen.getByTestId('quota-g:5h');
  expect(five.textContent).toContain('40% left');
  expect(five.textContent).toContain('Refills in 2h 10m');
  expect(five.textContent).not.toContain('tank');
  expect(screen.getByTestId('quota-g:weekly').textContent).toContain('tank'); // every tank follows the weekly window
  expect(screen.getByTestId('quota-c:5h').textContent).toContain('100% left');
  expect(screen.getByTestId('quota-c:5h').textContent).toContain('Refilled');
  expect(screen.getByTestId('quota-asof').textContent).toBe('Read 4m ago from agy /usage.');
});

test('no reading explains where it will come from; Refresh stores the new readings', async () => {
  act(() => useApp.setState({ quotas: {} }));
  vi.mocked(ipc.refreshQuotas).mockResolvedValue([{ ...agy, agent: 'claude' }]);
  render(<QuotaPanel agent="claude" />);
  expect(screen.getByTestId('quota-empty').textContent).toMatch(/sessions started from the village/);
  fireEvent.click(screen.getByText('Refresh'));
  await waitFor(() => expect(useApp.getState().quotas.claude?.windows).toHaveLength(3));
});
