import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { SessionInfo, SessionState } from '../api/types';

const approve = vi.fn();
vi.mock('../api/ipc', () => ({ ipc: { approve: (id: string) => approve(id), deny: vi.fn() } }));
vi.mock('./TerminalView', () => ({ default: () => null }));
import SessionPanel from './SessionPanel';
import { useApp } from '../state/store';

const sess = (state: SessionState, awaitingDecision: boolean): SessionInfo => ({
  id: 's1', workspaceId: 'w1', kind: { kind: 'agent', builderId: 'b1' }, task: null, state, steps: 0,
  startedAt: 0, lastOutputAt: 0, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision,
});

beforeEach(() => {
  approve.mockReset();
  useApp.setState({
    workspaces: [], sessions: {}, selectedSessionId: null,
    builders: [{ id: 'b1', name: 'Ada', agent: 'claude', model: null, effort: null, customCommand: null }],
    agents: [{ kind: 'claude', label: 'Claude Code', installed: true, version: null, models: [], efforts: [], canApprove: true }],
  });
});

test('Allow/Deny only while a decision is awaited; disabled while answering', async () => {
  useApp.getState().upsertSession(sess({ kind: 'needsYou', reason: 'Claude needs your permission' }, true));
  render(<SessionPanel sessionId="s1" />);
  let resolve: () => void = () => {};
  approve.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
  fireEvent.click(screen.getByText('Allow'));
  expect((screen.getByText('Allow') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('Allow'));
  expect(approve).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
});

test('after a deny the reason shows instead of live buttons', () => {
  useApp.getState().upsertSession(sess({ kind: 'needsYou', reason: 'Denied — tell Claude what to do in the terminal' }, false));
  render(<SessionPanel sessionId="s1" />);
  expect(screen.queryByText('Allow')).toBeNull();
  expect(screen.queryByText('Deny')).toBeNull();
  expect(screen.getByText('Denied — tell Claude what to do in the terminal')).toBeTruthy();
});
