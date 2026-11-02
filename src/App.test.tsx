import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { Workspace } from './api/types';

let onSelectSession: (id: string) => void = () => {};
let onWorkspaceUpdated: (w: Workspace) => void = () => {};
vi.mock('./api/ipc', () => ({
  ipc: {
    listState: vi.fn().mockResolvedValue({ workspaces: [{ id: 'w1', name: 'proj', path: '/p', createdAt: 0, missing: false }], builders: [], sessions: [] }),
    detectAgents: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({ updatesEnabled: true }),
    checkForUpdate: vi.fn().mockResolvedValue({ available: false }),
    onSessionUpdated: vi.fn().mockResolvedValue(() => {}),
    onSessionRemoved: vi.fn().mockResolvedValue(() => {}),
    onWorkspaceUpdated: vi.fn(async (cb: (w: Workspace) => void) => { onWorkspaceUpdated = cb; return () => {}; }),
    onStatsUpdated: vi.fn().mockResolvedValue(() => {}),
    getQuotas: vi.fn().mockResolvedValue([]),
    onQuotaUpdated: vi.fn().mockResolvedValue(() => {}),
    getApps: vi.fn().mockResolvedValue([]),
    onAppsUpdated: vi.fn().mockResolvedValue(() => {}),
    setCompound: vi.fn(async (id: string, compound: unknown) => {
      const { useApp } = await import('./state/store');
      return { ...useApp.getState().workspaces.find((w) => w.id === id), compound };
    }),
    onConfirmQuit: vi.fn().mockResolvedValue(() => {}),
    onUpdateProgress: vi.fn().mockResolvedValue(() => {}),
    onSelectSession: vi.fn(async (cb: (id: string) => void) => { onSelectSession = cb; return () => {}; }),
  },
}));
vi.mock('./components/TerminalView', () => ({ default: () => null }));
let appRenders = 0; // VillageCanvas is not memoized: it renders exactly when App does
vi.mock('./village/VillageCanvas', () => ({ default: () => { appRenders++; return null; } }));
import App from './App';
import { useApp } from './state/store';
import { act } from 'react';

test('town hall panel lists workspaces; workspace-updated event shows the missing badge', async () => {
  render(<App />);
  await act(async () => { await Promise.resolve(); });
  act(() => useApp.getState().setSelection({ kind: 'hall' }));
  expect(await screen.findByText('proj')).toBeTruthy();
  expect(screen.queryByText('missing')).toBeNull();
  act(() => onWorkspaceUpdated({ id: 'w1', name: 'proj', path: '/p', createdAt: 0, missing: true, level: 1, xp: 0, compound: null }));
  expect(await screen.findByText('missing')).toBeTruthy();
});

test('App does not re-render on session updates; error and notices still show', async () => {
  render(<App />);
  await act(async () => { await Promise.resolve(); });
  const before = appRenders;
  act(() => useApp.getState().upsertSession({
    id: 's1', workspaceId: 'w1', kind: { kind: 'terminal' }, task: null, state: { kind: 'working' }, steps: 0, startedAt: 0,
    lastOutputAt: 0, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot: null,
  }));
  act(() => useApp.getState().upsertSession({ ...useApp.getState().sessions.s1, steps: 1, rev: 2 }));
  expect(appRenders).toBe(before);
  act(() => useApp.getState().setError('boom'));
  expect(screen.getByText('boom')).toBeTruthy();
  act(() => screen.getByText('boom').click());
  expect(screen.queryByText('boom')).toBeNull();
});

test('select-session selects that session and opens the panel; unknown ids are ignored', async () => {
  render(<App />);
  await act(async () => { await Promise.resolve(); });
  act(() => useApp.getState().upsertSession({ id: 's9', workspaceId: 'w1', kind: { kind: 'terminal' }, task: null, state: { kind: 'working' }, steps: 0, startedAt: 0, lastOutputAt: 0, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot: null }));
  act(() => onSelectSession('nope'));
  expect(useApp.getState().selection).not.toEqual({ kind: 'session', id: 'nope' });
  act(() => onSelectSession('s9'));
  expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's9' });
  expect(useApp.getState().panelOpen).toBe(true);
});
