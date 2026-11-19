import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

const ipcMock = vi.hoisted(() => ({ raidReport: vi.fn(), saveRaidCard: vi.fn() }));
vi.mock('../api/ipc', () => ({ ipc: ipcMock }));
vi.mock('html-to-image', () => ({ toPng: vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=') }));
import RaidReport from './RaidReport';
import { useApp } from '../state/store';
import { openRaidReport } from '../state/raid';

const report = {
  ships: [
    { at: new Date(2026, 10, 20, 10, 5).getTime(), workspaceId: 'w1', builderName: 'Pete', agent: 'claude', title: 'Add a dark mode toggle', added: 120, removed: 8 },
    { at: new Date(2026, 10, 20, 14, 40).getTime(), workspaceId: 'gone', builderName: 'Ivy', agent: 'codex', title: null, added: 5, removed: 30 },
  ],
  waitedMs: 83 * 60_000,
  waitingNow: 1,
};

beforeEach(() => {
  ipcMock.raidReport.mockReset().mockResolvedValue(report);
  ipcMock.saveRaidCard.mockReset().mockResolvedValue('/Users/me/Downloads/Raid report 2026-11-20.png');
  localStorage.clear();
  useApp.setState({ raidOpen: false, raidNudge: true, covers: 0, notices: [],
    workspaces: [{ id: 'w1', name: 'shop', path: '/w', createdAt: 0, missing: false, level: 1, xp: 0, compound: null }] });
});

test('opens on today: totals, waits and what shipped; covers the village', async () => {
  render(<RaidReport />);
  expect(screen.queryByTestId('raid-card')).toBeNull();
  await act(async () => { openRaidReport(); });
  expect(useApp.getState().raidNudge).toBe(false); // seen: no more offers today
  const [from, to] = ipcMock.raidReport.mock.calls[0];
  expect(to - from).toBeGreaterThanOrEqual(23 * 3600_000); // a whole local day
  expect(await screen.findByText('2')).toBeTruthy();
  expect(screen.getByText('tasks shipped')).toBeTruthy();
  expect(screen.getByText('+125')).toBeTruthy();
  expect(screen.getByText('−38')).toBeTruthy();
  expect(screen.getByText('1h 23m')).toBeTruthy();
  expect(screen.getByText(/1 still waiting/)).toBeTruthy();
  expect(screen.getByText('Add a dark mode toggle')).toBeTruthy();
  expect(screen.getByText('Untitled task')).toBeTruthy();
  expect(screen.getByText(/Ivy · a removed workspace/)).toBeTruthy();
  expect(useApp.getState().covers).toBe(1);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(useApp.getState().raidOpen).toBe(false);
  expect(useApp.getState().covers).toBe(0);
});

test('Export saves the card as a PNG in Downloads', async () => {
  render(<RaidReport />);
  await act(async () => { openRaidReport(); });
  await screen.findByText('tasks shipped');
  await act(async () => { fireEvent.click(screen.getByText('Export PNG')); });
  expect(ipcMock.saveRaidCard).toHaveBeenCalledWith('iVBORw0KGgo=', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  expect(useApp.getState().notices.map((n) => n.text)).toContain('Saved to Downloads: Raid report 2026-11-20.png');
});

test('a quiet day says so', async () => {
  ipcMock.raidReport.mockResolvedValue({ ships: [], waitedMs: 0, waitingNow: 0 });
  render(<RaidReport />);
  await act(async () => { openRaidReport(); });
  expect(await screen.findByText(/Nothing accepted yet today/)).toBeTruthy();
  expect(screen.getByText('none')).toBeTruthy();
});
