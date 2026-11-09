import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Builder, SessionInfo, SessionState, Workspace } from '../api/types';

const ipc = vi.hoisted(() => ({
  startTerminal: vi.fn(),
  openInEditor: vi.fn().mockResolvedValue(undefined),
  openInFinder: vi.fn().mockResolvedValue(undefined),
  trackUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/ipc', () => ({ ipc }));
const folders = vi.hoisted(() => ({ createFolder: vi.fn().mockResolvedValue(true), openFolder: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../state/workspaceActions', () => folders);
vi.mock('./BugReport', () => ({ openBugReport: vi.fn() }));
import { KANBAN_ALL, useApp } from '../state/store';
import CommandPalette from './CommandPalette';
import { keyLabel, matchCommands, paletteCommands } from './commands';

const ws = (id: string, name: string): Workspace => ({ id, name, path: `/p/${name}`, createdAt: 0, missing: false, level: 1, xp: 0, compound: null });
const bld = (id: string, name: string): Builder => ({ id, name, agent: 'claude', model: null, effort: null, customCommand: null });
const sess = (id: string, state: SessionState, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, workspaceId: 'w1', kind: { kind: 'agent', builderId: 'b1' }, task: `Task ${id}`, state, steps: 0, startedAt: 0, lastOutputAt: 0,
  reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot: null, ...o,
});

beforeEach(() => {
  act(() => useApp.setState({
    workspaces: [ws('w1', 'shop'), ws('w2', 'blog')], builders: [bld('b1', 'Ada')], agents: [], quotas: {},
    sessions: {
      s1: sess('s1', { kind: 'working' }, { title: 'Checkout redesign', startedAt: 1 }),
      s2: sess('s2', { kind: 'needsYou', reason: 'Wants permission' }, { workspaceId: 'w2', startedAt: 2 }),
    },
    selection: null, panelOpen: false, kanban: null, settingsOpen: false, paletteOpen: false, error: null,
  }));
});
afterEach(cleanup);

const press = (key: string, o: KeyboardEventInit = {}) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o })); });
const search = () => screen.getByRole('combobox', { name: 'Search commands' }) as HTMLInputElement;

test('sessions that need you come first, named by their title', () => {
  const ids = paletteCommands(useApp.getState()).filter((c) => c.group === 'Sessions').map((c) => c.label);
  expect(ids).toEqual(['Task s2', 'Checkout redesign']);
});

test('matching wants every word, and ranks labels that start with the query first', () => {
  const all = paletteCommands(useApp.getState());
  expect(matchCommands(all, 'kanban blog').map((c) => c.label)).toEqual(['Kanban: blog']);
  expect(matchCommands(all, 'shop')[0].label).toBe('shop'); // the workspace itself before "New session in shop"
  expect(matchCommands(all, 'checkout').map((c) => c.id)).toEqual(['session:s1']);
  expect(matchCommands(all, 'zzz')).toEqual([]);
});

test('⌘K opens it, typing filters, Enter opens the session, and it closes', () => {
  render(<CommandPalette />);
  expect(screen.queryByRole('dialog')).toBeNull();
  press('k', { metaKey: true });
  fireEvent.change(search(), { target: { value: 'checkout' } });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  fireEvent.keyDown(search(), { key: 'Enter' });
  expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's1' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('arrows move the choice; ⌘K again or Esc closes', () => {
  render(<CommandPalette />);
  press('k', { metaKey: true });
  const selected = () => screen.getAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true');
  expect(selected()).toBe(0);
  fireEvent.keyDown(search(), { key: 'ArrowDown' });
  expect(selected()).toBe(1);
  fireEvent.keyDown(search(), { key: 'ArrowUp' });
  fireEvent.keyDown(search(), { key: 'ArrowUp' });
  expect(selected()).toBe(screen.getAllByRole('option').length - 1); // wraps
  press('k', { metaKey: true });
  expect(screen.queryByRole('dialog')).toBeNull();
  press('k', { ctrlKey: true });
  press('Escape');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('Esc closes the palette, not the Kanban under it; opening a session leaves the Kanban', () => {
  const kanbanEsc = vi.fn();
  act(() => useApp.setState({ kanban: KANBAN_ALL }));
  render(<CommandPalette />);
  // as the Kanban does when it opens: its own capture listener, added after the palette's
  window.addEventListener('keydown', kanbanEsc, true);
  press('k', { metaKey: true });
  press('Escape');
  expect(kanbanEsc).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
  window.removeEventListener('keydown', kanbanEsc, true);
  press('k', { metaKey: true });
  fireEvent.change(search(), { target: { value: 'checkout' } });
  fireEvent.keyDown(search(), { key: 'Enter' });
  expect(useApp.getState().kanban).toBeNull();
});

test('"New session in" opens that workspace\'s form; "New workspace…" asks for a name first', async () => {
  render(<CommandPalette />);
  press('k', { metaKey: true });
  fireEvent.change(search(), { target: { value: 'new session blog' } });
  fireEvent.keyDown(search(), { key: 'Enter' });
  expect(useApp.getState().selection).toEqual({ kind: 'workspace', id: 'w2', newSession: true });

  press('k', { metaKey: true });
  fireEvent.change(search(), { target: { value: 'new workspace' } });
  fireEvent.keyDown(search(), { key: 'Enter' });
  const name = screen.getByRole('textbox', { name: 'Workspace name' });
  press('Escape'); // back to the list, still open
  expect(screen.getByRole('combobox', { name: 'Search commands' })).toBeTruthy();
  fireEvent.keyDown(search(), { key: 'Enter' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Workspace name' }), { target: { value: 'notes' } });
  fireEvent.submit(screen.getByRole('textbox', { name: 'Workspace name' }).closest('form')!);
  expect(folders.createFolder).toHaveBeenCalledWith('notes');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(name).toBeTruthy();
});

test('a terminal starts from the palette and is opened', async () => {
  ipc.startTerminal.mockResolvedValue(sess('t1', { kind: 'working' }, { kind: { kind: 'terminal' }, task: null }));
  render(<CommandPalette />);
  press('k', { metaKey: true });
  fireEvent.change(search(), { target: { value: 'terminal shop' } });
  fireEvent.keyDown(search(), { key: 'Enter' });
  await vi.waitFor(() => expect(useApp.getState().selection).toEqual({ kind: 'session', id: 't1' }));
  expect(ipc.startTerminal).toHaveBeenCalledWith('w1');
});

test('⌘N starts a session in the workspace open now; with none clear, the palette asks which', () => {
  render(<CommandPalette />);
  act(() => useApp.getState().setSelection({ kind: 'session', id: 's2' }));
  press('n', { metaKey: true });
  expect(useApp.getState().selection).toEqual({ kind: 'workspace', id: 'w2', newSession: true });
  act(() => useApp.getState().setSelection(null));
  press('n', { metaKey: true });
  expect(search().value).toBe('New session in ');
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('New session in shop'), expect.stringContaining('New session in blog')]));
});

test('⌘J opens the next session that needs you; ⌘B the Kanban; ⌘⇧N asks for a workspace name', () => {
  render(<CommandPalette />);
  press('j', { metaKey: true });
  expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's2' });
  act(() => useApp.getState().setSelection(null));
  press('b', { metaKey: true });
  expect(useApp.getState().kanban).toBe(KANBAN_ALL); // no workspace open: every workspace's
  act(() => useApp.setState({ kanban: null }));
  act(() => useApp.getState().setSelection({ kind: 'workspace', id: 'w1' }));
  press('b', { metaKey: true });
  expect(useApp.getState().kanban).toBe('w1');
  press('n', { metaKey: true, shiftKey: true });
  expect(screen.getByRole('textbox', { name: 'Workspace name' })).toBeTruthy();
});

test('the shortcuts lead the palette, each with its keys', () => {
  act(() => useApp.getState().setSelection({ kind: 'workspace', id: 'w1' }));
  render(<CommandPalette />);
  press('k', { metaKey: true });
  const first = screen.getAllByRole('option').slice(0, 3).map((o) => o.textContent);
  expect(first[0]).toContain('New session in shop');
  expect(first[0]).toContain(keyLabel({ key: 'n' }));
  expect(first[1]).toContain('New terminal in shop');
  expect(screen.getByText('Common')).toBeTruthy();
});

test('a key that is no shortcut, or ⌘J with nobody waiting, is left alone', () => {
  act(() => useApp.setState({ sessions: {} }));
  render(<CommandPalette />);
  const seen = vi.fn();
  window.addEventListener('keydown', seen);
  press('j', { metaKey: true });
  press('x', { metaKey: true });
  expect(seen).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('dialog')).toBeNull();
  window.removeEventListener('keydown', seen);
});
