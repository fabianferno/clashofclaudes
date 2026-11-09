import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentInfo, Builder, SessionInfo, SessionState, Workspace } from '../api/types';

const ipc = vi.hoisted(() => ({
  addTodo: vi.fn(),
  removeTodo: vi.fn().mockResolvedValue(undefined),
  startSession: vi.fn(),
  setSessionSpot: vi.fn(),
  setCompound: vi.fn(),
  approve: vi.fn().mockResolvedValue(undefined),
  deny: vi.fn().mockResolvedValue(undefined),
  saveAttachment: vi.fn(),
  readAttachment: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
  discardAttachments: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/ipc', () => ({ ipc }));
import { KANBAN_ALL, useApp } from '../state/store';
import Kanban, { kanbanColumn } from './Kanban';

const ws: Workspace = { id: 'w1', name: 'shop', path: '/p/shop', createdAt: 0, missing: false, level: 1, xp: 0, compound: null };
const bld = (id: string, name: string): Builder => ({ id, name, agent: 'claude', model: null, effort: null, customCommand: null });
const agents: AgentInfo[] = [{ kind: 'claude', label: 'Claude Code', installed: true, version: null, models: [], efforts: [], canApprove: true }];
const sess = (id: string, builderId: string, state: SessionState, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, workspaceId: 'w1', kind: { kind: 'agent', builderId }, task: `Task ${id}`, state, steps: 2, startedAt: 0, lastOutputAt: 0,
  reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot: null, ...o,
});

beforeEach(() => {
  Object.values(ipc).forEach((f) => f.mockClear());
  act(() => useApp.setState({
    workspaces: [ws], builders: [bld('b1', 'Ada'), bld('b2', 'Bo'), bld('b3', 'Cy')], agents, sessions: {}, todos: [],
    kanban: 'w1', selection: null, panelOpen: false, error: null,
  }));
});
afterEach(cleanup);

const column = (name: string) => screen.getByRole('region', { name });

test('each session state has its column', () => {
  expect(kanbanColumn(sess('a', 'b1', { kind: 'starting' }))).toBe('active');
  expect(kanbanColumn(sess('a', 'b1', { kind: 'working' }))).toBe('active');
  expect(kanbanColumn(sess('a', 'b1', { kind: 'needsYou', reason: 'Bash' }))).toBe('needs');
  expect(kanbanColumn(sess('a', 'b1', { kind: 'stuck', reason: 'quiet' }))).toBe('needs');
  expect(kanbanColumn(sess('a', 'b1', { kind: 'finished' }))).toBe('finished');
  expect(kanbanColumn(sess('a', 'b1', { kind: 'ended', exitCode: 0 }))).toBe('finished');
});

test('cards move between columns as the builders work; terminals stay off the board', () => {
  act(() => useApp.setState({
    sessions: {
      s1: sess('s1', 'b1', { kind: 'working' }),
      s2: sess('s2', 'b2', { kind: 'needsYou', reason: 'Wants to run Bash' }),
      t1: { ...sess('t1', 'b3', { kind: 'working' }), kind: { kind: 'terminal' } },
    },
  }));
  render(<Kanban />);
  expect(within(column('Active')).getByText('Task s1')).toBeTruthy();
  expect(within(column('Needs You')).getByText('Wants to run Bash')).toBeTruthy();
  expect(screen.queryByText('Task t1')).toBeNull();
  act(() => useApp.getState().upsertSession({ ...sess('s1', 'b1', { kind: 'finished' }), rev: 2 }));
  expect(within(column('Finished')).getByText('Task s1')).toBeTruthy();
  expect(within(column('Active')).queryByText('Task s1')).toBeNull();
});

test('a permission prompt can be answered from the card', () => {
  act(() => useApp.setState({ sessions: { s2: sess('s2', 'b2', { kind: 'needsYou', reason: 'Bash' }, { awaitingDecision: true }) } }));
  render(<Kanban />);
  fireEvent.click(within(column('Needs You')).getByRole('button', { name: 'Allow' }));
  expect(ipc.approve).toHaveBeenCalledWith('s2');
  expect(useApp.getState().kanban).toBe('w1'); // answering does not leave the board
});

test("a card is named by the agent's title once it has one, the task as its tooltip", () => {
  const long = 'Create a reel from the following content dump: '.repeat(20);
  act(() => useApp.getState().upsertSession(sess('s1', 'b1', { kind: 'working' }, { task: long, title: 'Reel from content dump' })));
  act(() => useApp.getState().upsertSession(sess('s2', 'b2', { kind: 'working' })));
  render(<Kanban />);
  const named = screen.getByText('Reel from content dump');
  expect(named.getAttribute('title')).toBe(long);
  expect(screen.queryByText(long)).toBeNull();
  expect(screen.getByText('Task s2')).toBeTruthy(); // no title yet: the task
});

test('clicking a card opens its session', () => {
  act(() => useApp.setState({ sessions: { s1: sess('s1', 'b1', { kind: 'working' }) } }));
  render(<Kanban />);
  fireEvent.click(screen.getByTestId('kb-card-s1'));
  expect(useApp.getState().kanban).toBeNull();
  expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's1' });
});

test('a task is written down, then handed to an idle builder and becomes a session', async () => {
  act(() => useApp.setState({ sessions: { s1: sess('s1', 'b1', { kind: 'working' }) } })); // Ada is busy
  ipc.addTodo.mockResolvedValue({ id: 't1', workspaceId: 'w1', text: 'Fix login', createdAt: 1 });
  render(<Kanban />);
  fireEvent.change(screen.getByRole('textbox', { name: 'New task' }), { target: { value: 'Fix login' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(within(column('To Do')).getByText('Fix login')).toBeTruthy());
  expect(ipc.addTodo).toHaveBeenCalledWith('w1', 'Fix login', []);
  const picker = screen.getByRole('combobox', { name: 'Builder' });
  expect(picker.textContent).toContain('Bo');
  expect(picker.querySelector('.hud-av canvas')).toBeTruthy(); // the builder's portrait, as on the bottom cards
  fireEvent.click(picker);
  const options = screen.getAllByRole('option');
  expect(options.map((o) => o.querySelector('.kb-pick-name')!.firstChild!.textContent!.trim())).toEqual(['Bo', 'Cy']);
  expect(options.every((o) => o.querySelector('.hud-av canvas'))).toBe(true);
  fireEvent.click(options[1]);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(picker.textContent).toContain('Cy');
  ipc.startSession.mockResolvedValue(sess('s9', 'b3', { kind: 'starting' }, { task: 'Fix login' }));
  ipc.setCompound.mockImplementation(async (_id, c) => ({ ...ws, compound: c }));
  ipc.setSessionSpot.mockImplementation(async (id, spot) => ({ ...useApp.getState().sessions[id], spot }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await waitFor(() => expect(within(column('Active')).getByText('Fix login')).toBeTruthy());
  expect(ipc.startSession).toHaveBeenCalledWith('w1', 'b3', 'Fix login', []);
  expect(ipc.removeTodo).toHaveBeenCalledWith('t1');
  expect(within(column('To Do')).queryByText('Fix login')).toBeNull();
});

test('esc closes an open builder list before the board', () => {
  act(() => useApp.setState({ todos: [{ id: 't1', workspaceId: 'w1', text: 'Fix login', createdAt: 1 }] }));
  render(<Kanban />);
  const picker = screen.getByRole('combobox', { name: 'Builder' });
  picker.focus();
  fireEvent.click(picker);
  expect(screen.getByRole('listbox')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(useApp.getState().kanban).toBe('w1');
});

test('the builder list is walked with the arrow keys', () => {
  act(() => useApp.setState({ todos: [{ id: 't1', workspaceId: 'w1', text: 'Fix login', createdAt: 1 }] }));
  render(<Kanban />);
  const picker = screen.getByRole('combobox', { name: 'Builder' });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.keyDown(picker, { key: 'Enter' });
  expect(picker.textContent).toContain('Bo');
  expect(screen.queryByRole('listbox')).toBeNull();
});

test('esc closes the board', () => {
  render(<Kanban />);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(useApp.getState().kanban).toBeNull();
});

test('images pasted into a new task go with it, show on its card and are handed to the session', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:img');
  const img = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';
  ipc.saveAttachment.mockResolvedValue(img);
  ipc.addTodo.mockImplementation(async (_w, text, images) => ({ id: 't1', workspaceId: 'w1', text, images, createdAt: 1 }));
  render(<Kanban />);
  const input = screen.getByRole('textbox', { name: 'New task' });
  const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
  fireEvent.paste(input, { clipboardData: { files: [file], types: ['Files'] } });
  await waitFor(() => expect(screen.getAllByTestId('att-thumb')).toHaveLength(1));
  expect(ipc.saveAttachment).toHaveBeenCalledWith(new Uint8Array([137, 80, 78, 71]));
  expect(add.disabled).toBe(false); // an image alone is a task
  fireEvent.click(add);
  await waitFor(() => expect(within(column('To Do')).getAllByTestId('att-thumb')).toHaveLength(1));
  expect(ipc.addTodo).toHaveBeenCalledWith('w1', '', [img]);
  expect(screen.getAllByTestId('att-thumb')).toHaveLength(1); // the form let go of it
  ipc.startSession.mockResolvedValue(sess('s9', 'b1', { kind: 'starting' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await waitFor(() => expect(ipc.startSession).toHaveBeenCalledWith('w1', 'b1', '', [img]));
});

test("the Town Hall's board holds every workspace's sessions and To Do, each tagged with its workspace", async () => {
  const ws2: Workspace = { ...ws, id: 'w2', name: 'blog', path: '/p/blog' };
  act(() => useApp.setState({
    workspaces: [ws, ws2], kanban: KANBAN_ALL,
    todos: [{ id: 't9', workspaceId: 'w2', text: 'Write post', createdAt: 1 }],
  }));
  act(() => useApp.getState().upsertSession(sess('s1', 'b1', { kind: 'working' })));
  act(() => useApp.getState().upsertSession(sess('s2', 'b2', { kind: 'needsYou', reason: 'Wants permission' }, { workspaceId: 'w2' })));
  render(<Kanban />);
  expect(screen.getByRole('heading', { name: 'All workspaces' })).toBeTruthy();
  expect(within(column('Active')).getByText('shop')).toBeTruthy();
  expect(within(column('Needs You')).getByText('blog')).toBeTruthy();
  expect(within(screen.getByTestId('kb-todo-t9')).getByText('blog')).toBeTruthy();
  // a new task goes to the workspace picked for it
  ipc.addTodo.mockResolvedValue({ id: 't1', workspaceId: 'w2', text: 'Fix footer', createdAt: 2 });
  fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), { target: { value: 'w2' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'New task' }), { target: { value: 'Fix footer' } });
  fireEvent.click(screen.getByText('Add'));
  await waitFor(() => expect(ipc.addTodo).toHaveBeenCalledWith('w2', 'Fix footer', []));
});

test('a workspace board has no workspace picker or tags', () => {
  act(() => useApp.getState().upsertSession(sess('s1', 'b1', { kind: 'working' })));
  render(<Kanban />);
  expect(screen.queryByRole('combobox', { name: 'Workspace' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'shop' })).toBeTruthy();
  expect(screen.queryAllByText('shop')).toHaveLength(1); // the heading only
});
