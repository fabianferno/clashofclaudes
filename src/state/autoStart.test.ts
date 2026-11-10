import { act, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import type { SessionInfo, Todo } from '../api/types';

const ipc = vi.hoisted(() => ({ startSession: vi.fn(), removeTodo: vi.fn(), updateTodo: vi.fn(), setSessionSpot: vi.fn(), setCompound: vi.fn() }));
vi.mock('../api/ipc', () => ({ ipc }));
import { useApp } from './store';
import { autoStart } from './autoStart';

const todo = (id: string, extra: Partial<Todo> = {}): Todo => ({ id, workspaceId: 'w1', text: `do ${id}`, createdAt: 1, auto: true, builderId: 'b1', ...extra });
const started = (id: string, builderId: string): SessionInfo => ({
  id, workspaceId: 'w1', kind: { kind: 'agent', builderId }, task: null, state: { kind: 'starting' }, steps: 0, startedAt: 0, lastOutputAt: 0,
  reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot: { x: 0, y: 0 },
});
let stop = () => {};

beforeEach(() => {
  Object.values(ipc).forEach((f) => f.mockReset());
  ipc.removeTodo.mockResolvedValue(undefined);
  useApp.setState({
    loaded: true, notices: [], error: null, sessions: {}, settings: null,
    workspaces: [{ id: 'w1', name: 'shop', path: '/w', createdAt: 0, missing: false, level: 1, xp: 0, compound: null }],
    builders: [{ id: 'b1', name: 'Ada', agent: 'claude', model: null, effort: null, customCommand: null }],
    todos: [],
  });
});
afterEach(() => stop());

test('a To Do set to start on its own starts once its builder is free, in its worktree when asked', async () => {
  ipc.startSession.mockResolvedValue(started('s1', 'b1'));
  // busy first: nothing starts
  act(() => useApp.setState({ sessions: { s0: { ...started('s0', 'b1'), state: { kind: 'working' } } }, todos: [todo('t1', { worktree: true })] }));
  stop = autoStart();
  expect(ipc.startSession).not.toHaveBeenCalled();
  // its builder's session closes: it starts
  act(() => useApp.setState({ sessions: {} }));
  await waitFor(() => expect(ipc.startSession).toHaveBeenCalledWith('w1', 'b1', 'do t1', [], true));
  await waitFor(() => expect(useApp.getState().todos).toEqual([]));
  expect(ipc.startSession).toHaveBeenCalledTimes(1);
  expect(useApp.getState().sessions.s1).toBeTruthy();
  expect(useApp.getState().notices.map((n) => n.text)).toContain('Ada picked up a task from the To Do');
});

test('a start that fails turns the auto start off instead of retrying in a loop', async () => {
  ipc.startSession.mockRejectedValue('Claude Code is not installed');
  ipc.updateTodo.mockResolvedValue(todo('t1', { auto: false }));
  const errors: unknown[] = [];
  act(() => useApp.setState({ todos: [todo('t1')] }));
  stop = autoStart((e) => errors.push(e));
  await waitFor(() => expect(ipc.updateTodo).toHaveBeenCalledWith('t1', false, 'b1', false));
  await waitFor(() => expect(useApp.getState().todos[0].auto).toBe(false));
  expect(ipc.startSession).toHaveBeenCalledTimes(1);
  expect(String(errors[0])).toContain('Claude Code is not installed');
});

test('nothing starts before the village has loaded, or with the limit reached', () => {
  act(() => useApp.setState({ loaded: false, todos: [todo('t1')] }));
  stop = autoStart();
  expect(ipc.startSession).not.toHaveBeenCalled();
  stop();
  act(() => useApp.setState({
    loaded: true, settings: { updatesEnabled: false, notifyNeedsYou: true, notifyFinished: true, dockBadge: true, sessionLimit: 1 },
    builders: [...useApp.getState().builders, { id: 'b2', name: 'Bo', agent: 'claude', model: null, effort: null, customCommand: null }],
    sessions: { s9: { ...started('s9', 'b2'), state: { kind: 'working' } } },
  }));
  stop = autoStart();
  expect(ipc.startSession).not.toHaveBeenCalled();
});
