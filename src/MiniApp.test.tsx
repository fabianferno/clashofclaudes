import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  listState: vi.fn().mockResolvedValue({ workspaces: [{ id: 'w1', name: 'proj', path: '/p', createdAt: 0, missing: false }], builders: [], sessions: [] }),
  detectAgents: vi.fn().mockResolvedValue([]),
  getSettings: vi.fn().mockResolvedValue({ updatesEnabled: true, playerName: 'Ada' }),
  getQuotas: vi.fn().mockResolvedValue([]),
  getApps: vi.fn().mockResolvedValue([]),
  onSessionUpdated: vi.fn().mockResolvedValue(() => {}),
  onSessionRemoved: vi.fn().mockResolvedValue(() => {}),
  onWorkspaceUpdated: vi.fn().mockResolvedValue(() => {}),
  onStatsUpdated: vi.fn().mockResolvedValue(() => {}),
  onQuotaUpdated: vi.fn().mockResolvedValue(() => {}),
  onAppsUpdated: vi.fn().mockResolvedValue(() => {}),
  toggleMini: vi.fn().mockResolvedValue(undefined),
  focusSession: vi.fn().mockResolvedValue(undefined),
  // what only the main window does: the mini village must never call these
  startSession: vi.fn(),
  setCompound: vi.fn(),
  setSessionSpot: vi.fn(),
  setSettings: vi.fn(),
  snapshotApp: vi.fn(),
  playSound: vi.fn(),
}));
vi.mock('./api/ipc', () => ({ ipc }));
const jobs = vi.hoisted(() => ({ autoStart: vi.fn(() => () => {}), watchSounds: vi.fn(() => () => {}), watchElixir: vi.fn(() => () => {}), autoSnapshots: vi.fn(() => () => {}) }));
vi.mock('./state/autoStart', () => ({ autoStart: jobs.autoStart }));
vi.mock('./state/sounds', async (orig) => ({ ...(await orig<object>()), watchSounds: jobs.watchSounds }));
vi.mock('./state/elixirWatch', () => ({ watchElixir: jobs.watchElixir }));
vi.mock('./state/snapshots', async (orig) => ({ ...(await orig<object>()), autoSnapshots: jobs.autoSnapshots }));
const canvas = vi.hoisted(() => ({ props: [] as Array<{ mini?: boolean }> }));
vi.mock('./village/VillageCanvas', () => ({ default: (p: { mini?: boolean }) => { canvas.props.push(p); return null; } }));
import MiniApp from './MiniApp';
import { useApp } from './state/store';

afterEach(cleanup);

test('the mini village shows the village alone and runs none of the main window\'s jobs', async () => {
  render(<MiniApp />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(ipc.listState).toHaveBeenCalledTimes(1);
  expect(useApp.getState().workspaces.map((w) => w.name)).toEqual(['proj']);
  expect(canvas.props[canvas.props.length - 1]?.mini).toBe(true);
  for (const job of Object.values(jobs)) expect(job).not.toHaveBeenCalled();
  for (const call of [ipc.startSession, ipc.setCompound, ipc.setSessionSpot, ipc.setSettings, ipc.snapshotApp, ipc.playSound]) expect(call).not.toHaveBeenCalled();
});

test('the close button puts the mini village away', async () => {
  render(<MiniApp />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Close mini village' }));
  expect(ipc.toggleMini).toHaveBeenCalledTimes(1);
});

test('the top strip drags the window', async () => {
  const { container } = render(<MiniApp />);
  await act(async () => { await Promise.resolve(); });
  expect(container.querySelector('header')?.hasAttribute('data-tauri-drag-region')).toBe(true);
});
