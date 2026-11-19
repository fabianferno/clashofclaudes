import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Builder, HistoryEntry, SessionInfo } from '../api/types';

const ipc = vi.hoisted(() => ({
  listHistory: vi.fn(),
  onHistoryUpdated: vi.fn().mockResolvedValue(() => {}),
  continueHistory: vi.fn(),
  forgetHistory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/ipc', () => ({ ipc }));
import { useApp } from '../state/store';
import HistoryList, { ago, continuer, HISTORY_SHOWN } from './HistoryList';

const builder = (o: Partial<Builder> = {}): Builder => ({ id: 'b1', name: 'Ada', agent: 'claude', model: null, effort: null, customCommand: null, ...o });
const entry = (o: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: 'h1', workspaceId: 'w1', builderId: 'b1', agent: 'claude', builderName: 'Ada', task: 'Fix the login', title: null,
  lastMessage: 'Done.', conversation: 'c1', startedAt: 0, closedAt: Date.now() - 5 * 60_000, steps: 4, reachedFinished: true, worktree: null, ...o,
});
const sess = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's9', workspaceId: 'w1', kind: { kind: 'agent', builderId: 'b1' }, task: 'Fix the login', state: { kind: 'finished' },
  steps: 4, startedAt: 1, lastOutputAt: 1, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false,
  rev: 1, spot: null, ...o,
} as SessionInfo);

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ builders: [builder()], sessions: {}, selection: null });
});
afterEach(cleanup);

test('ago reads like a clock', () => {
  const now = 10 * 86_400_000;
  expect(ago(now, now)).toBe('just now');
  expect(ago(now - 5 * 60_000, now)).toBe('5 min ago');
  expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago');
  expect(ago(now - 2 * 86_400_000, now)).toBe('2 d ago');
});

test('a conversation continues on its own builder, else a free one of the same agent', () => {
  const ada = builder(), bo = builder({ id: 'b2', name: 'Bo' }), cy = builder({ id: 'b3', agent: 'codex' });
  expect(continuer(entry(), [cy, bo, ada])?.id).toBe('b1');
  expect(continuer(entry(), [cy, bo])?.id).toBe('b2');
  expect(continuer(entry(), [cy])).toBeNull();
});

test('lists this workspace\'s past sessions and continues one', async () => {
  ipc.listHistory.mockResolvedValue([entry(), entry({ id: 'h2', workspaceId: 'w2', conversation: 'c2', task: 'Elsewhere' })]);
  ipc.continueHistory.mockResolvedValue(sess());
  render(<HistoryList workspaceId="w1" onError={() => {}} />);
  expect(await screen.findByText('Fix the login')).toBeTruthy();
  expect(screen.queryByText('Elsewhere')).toBeNull();
  expect(screen.getByText(/Ada · 4 steps · closed 5 min ago/)).toBeTruthy();
  fireEvent.click(screen.getByText('Continue'));
  await vi.waitFor(() => expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's9' }));
  expect(ipc.continueHistory).toHaveBeenCalledWith('h1', 'b1');
});

test('Continue waits for a free builder of the agent; ✕ forgets', async () => {
  ipc.listHistory.mockResolvedValue([entry()]);
  useApp.setState({ sessions: { s1: sess({ id: 's1', state: { kind: 'working' } }) } });
  render(<HistoryList workspaceId="w1" onError={() => {}} />);
  const btn = await screen.findByText('Continue');
  expect((btn as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Forget Fix the login'));
  expect(ipc.forgetHistory).toHaveBeenCalledWith('h1');
  expect(screen.queryByText('Fix the login')).toBeNull();
});

test('shows the newest few until asked for all', async () => {
  ipc.listHistory.mockResolvedValue(Array.from({ length: HISTORY_SHOWN + 2 }, (_, i) => entry({ id: `h${i}`, conversation: `c${i}`, task: `Task ${i}` })));
  render(<HistoryList workspaceId="w1" onError={() => {}} />);
  await screen.findByText('Task 0');
  expect(screen.queryByText(`Task ${HISTORY_SHOWN}`)).toBeNull();
  fireEvent.click(screen.getByText(`Show all ${HISTORY_SHOWN + 2}`));
  expect(screen.getByText(`Task ${HISTORY_SHOWN + 1}`)).toBeTruthy();
});
