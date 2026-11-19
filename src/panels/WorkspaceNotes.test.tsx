import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { Workspace } from '../api/types';

const ipcMock = vi.hoisted(() => ({ setWorkspaceNotes: vi.fn(), addTodo: vi.fn() }));
vi.mock('../api/ipc', () => ({ ipc: ipcMock }));
import WorkspaceNotes, { NOTES_SAVE_MS, pickedText } from './WorkspaceNotes';
import { useApp } from '../state/store';

const ws = (notes = ''): Workspace => ({ id: 'w1', name: 'shop', path: '/w', createdAt: 0, missing: false, level: 1, xp: 0, compound: null, notes });

beforeEach(() => {
  ipcMock.setWorkspaceNotes.mockReset().mockImplementation(async (_id: string, notes: string) => ws(notes));
  ipcMock.addTodo.mockReset().mockImplementation(async (workspaceId: string, text: string) => ({ id: 't1', workspaceId, text, images: [], createdAt: 0 }));
  useApp.setState({ workspaces: [ws('- add export later\n- look at the flaky test')], todos: [], notices: [] });
});

test('the selection, else the cursor line without its list marker', () => {
  const v = '- add export\n- [ ] flaky test\nplain';
  expect(pickedText(v, 2, 12)).toEqual({ text: 'add export', from: 2, to: 12 });
  expect(pickedText(v, 16, 16)).toEqual({ text: 'flaky test', from: 13, to: 30 });
  expect(pickedText(v, v.length, v.length)).toEqual({ text: 'plain', from: 30, to: v.length });
  expect(pickedText('\n\n', 1, 1).text).toBe('');
});

test('typing saves once it rests, and leaving saves what is pending', async () => {
  vi.useFakeTimers();
  try {
    const { unmount } = render(<WorkspaceNotes workspaceId="w1" onStartSession={() => {}} />);
    const pad = screen.getByLabelText('Notes') as HTMLTextAreaElement;
    expect(pad.value).toBe('- add export later\n- look at the flaky test');
    fireEvent.change(pad, { target: { value: 'a' } });
    fireEvent.change(pad, { target: { value: 'ab' } });
    expect(ipcMock.setWorkspaceNotes).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(NOTES_SAVE_MS); });
    expect(ipcMock.setWorkspaceNotes).toHaveBeenCalledTimes(1);
    expect(ipcMock.setWorkspaceNotes).toHaveBeenCalledWith('w1', 'ab');
    fireEvent.change(pad, { target: { value: 'abc' } });
    unmount();
    expect(ipcMock.setWorkspaceNotes).toHaveBeenLastCalledWith('w1', 'abc');
  } finally {
    vi.useRealTimers();
  }
});

test('the cursor line moves to the To Do and leaves the pad', async () => {
  render(<WorkspaceNotes workspaceId="w1" onStartSession={() => {}} />);
  const pad = screen.getByLabelText('Notes') as HTMLTextAreaElement;
  expect((screen.getByText('Move to To Do') as HTMLButtonElement).disabled).toBe(true);
  pad.setSelectionRange(25, 25); // in "look at the flaky test"
  fireEvent.select(pad);
  await act(async () => { fireEvent.click(screen.getByText('Move to To Do')); });
  expect(ipcMock.addTodo).toHaveBeenCalledWith('w1', 'look at the flaky test');
  expect(useApp.getState().todos.map((t) => t.text)).toEqual(['look at the flaky test']);
  expect(pad.value).toBe('- add export later\n');
  expect(ipcMock.setWorkspaceNotes).toHaveBeenLastCalledWith('w1', '- add export later\n');
  expect(useApp.getState().notices.map((n) => n.text)).toContain('Moved to the To Do');
});

test('a selection starts a session with it as the task, staying in the pad', () => {
  const started: string[] = [];
  render(<WorkspaceNotes workspaceId="w1" onStartSession={(t) => started.push(t)} />);
  const pad = screen.getByLabelText('Notes') as HTMLTextAreaElement;
  pad.setSelectionRange(2, 18);
  fireEvent.select(pad);
  fireEvent.click(screen.getByText('Start a session'));
  expect(started).toEqual(['add export later']);
  expect(pad.value).toBe('- add export later\n- look at the flaky test');
});
