import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { Workspace } from './api/types';

let onWorkspaceUpdated: (w: Workspace) => void = () => {};
vi.mock('./api/ipc', () => ({
  ipc: {
    listState: vi.fn().mockResolvedValue({ workspaces: [{ id: 'w1', name: 'proj', path: '/p', createdAt: 0, missing: false }], builders: [], sessions: [] }),
    detectAgents: vi.fn().mockResolvedValue([]),
    onSessionUpdated: vi.fn().mockResolvedValue(() => {}),
    onSessionRemoved: vi.fn().mockResolvedValue(() => {}),
    onWorkspaceUpdated: vi.fn(async (cb: (w: Workspace) => void) => { onWorkspaceUpdated = cb; return () => {}; }),
    onStatsUpdated: vi.fn().mockResolvedValue(() => {}),
    setCompound: vi.fn(async (id: string, compound: unknown) => {
      const { useApp } = await import('./state/store');
      return { ...useApp.getState().workspaces.find((w) => w.id === id), compound };
    }),
    onConfirmQuit: vi.fn().mockResolvedValue(() => {}),
  },
}));
vi.mock('./components/TerminalView', () => ({ default: () => null }));
vi.mock('./village/VillageCanvas', () => ({ default: () => null }));
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
