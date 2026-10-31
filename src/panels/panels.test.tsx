import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentInfo, Builder, SessionInfo, Workspace } from '../api/types';

const ipc = vi.hoisted(() => ({
  updateBuilder: vi.fn().mockResolvedValue(undefined),
  deleteBuilder: vi.fn().mockResolvedValue(undefined),
  startTerminal: vi.fn(),
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  openInEditor: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/ipc', () => ({ ipc }));
vi.mock('./SessionPanel', () => ({ default: () => null }));
vi.mock('./NewSessionPicker', () => ({ default: () => null }));
import { useApp } from '../state/store';
import SidePanel from './SidePanel';
import WorkspacePanel from './WorkspacePanel';
import TownHallPanel from './TownHallPanel';
import BuilderPanel from './BuilderPanel';

const ws = (o: Partial<Workspace> = {}): Workspace => ({
  id: 'w1', name: 'proj', path: '/p/proj', createdAt: 0, missing: false, level: 2, xp: 70, compound: null, ...o,
});
const builder = (o: Partial<Builder> = {}): Builder => ({
  id: 'b1', name: 'Ada', agent: 'claude', model: 'opus', effort: 'max', customCommand: null, ...o,
});
const sess = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's1', workspaceId: 'w1', kind: { kind: 'agent', builderId: 'b1' }, task: 'Do it', state: { kind: 'working' },
  steps: 3, startedAt: 1, lastOutputAt: 1, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false,
  rev: 1, spot: null, ...o,
});
const agents: AgentInfo[] = [
  { kind: 'claude', label: 'Claude Code', installed: true, version: null, models: ['haiku', 'sonnet', 'opus'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], canApprove: true },
  { kind: 'codex', label: 'Codex', installed: true, version: null, models: [], efforts: [], canApprove: false },
];

beforeEach(() => {
  Object.values(ipc).forEach((f) => f.mockClear());
  act(() => useApp.setState({ workspaces: [ws()], builders: [builder()], sessions: {}, agents, selection: null, panelOpen: false }));
});
afterEach(cleanup);

test('missing_workspace_buttons_explain', () => {
  act(() => useApp.setState({ workspaces: [ws({ missing: true })] }));
  render(<WorkspacePanel workspaceId="w1" />);
  for (const name of ['+ New session', '+ Terminal', 'Open in editor', 'Zoom in']) {
    const b = screen.getByRole('button', { name }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('Folder not found: /p/proj');
  }
  expect(screen.getByText(/Folder not found: \/p\/proj/, { selector: '.panel-warn' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Remove workspace' }) as HTMLButtonElement).disabled).toBe(false);
});

test('workspace_xp_bar_uses_need_curve', () => {
  render(<WorkspacePanel workspaceId="w1" />);
  expect(screen.getByText('Level 2')).toBeTruthy();
  expect(screen.getByText('70 / 140 XP')).toBeTruthy();
  expect(screen.getByTestId('xp-fill').style.width).toBe('50%');
});

test('terminals_listed_not_as_structures', () => {
  act(() => useApp.setState({
    sessions: { s1: sess(), t1: sess({ id: 't1', kind: { kind: 'terminal' }, task: null }) },
  }));
  render(<WorkspacePanel workspaceId="w1" />);
  expect(screen.getByText('Sessions (1)')).toBeTruthy();
  expect(screen.getByText('Terminals (1)')).toBeTruthy();
  expect(screen.getByTestId('terminal-row-t1')).toBeTruthy();
  expect(screen.queryByTestId('session-row-t1')).toBeNull();
  expect(screen.getByTestId('session-row-s1').textContent).toContain('Working');
});

test('remove_workspace_confirms_inline', async () => {
  render(<WorkspacePanel workspaceId="w1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove workspace' }));
  expect(ipc.removeWorkspace).not.toHaveBeenCalled();
  expect(screen.getByText(/never deletes any files/i)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm remove?' })); });
  expect(ipc.removeWorkspace).toHaveBeenCalledWith('w1');
  expect(useApp.getState().workspaces).toHaveLength(0);
  expect(useApp.getState().selection).toBeNull();
});

test('builder_rename_calls_update', async () => {
  render(<BuilderPanel builderId="b1" />);
  const input = screen.getByLabelText('Name') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Grace' } });
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
  expect(ipc.updateBuilder).toHaveBeenCalledWith({ ...builder(), name: 'Grace' });
  expect(useApp.getState().builders[0].name).toBe('Grace');
});

test('builder_shows_class_and_gear_in_words', () => {
  render(<BuilderPanel builderId="b1" />);
  expect(screen.getByText(/Master/)).toBeTruthy();
  expect(screen.getByText(/Enchanted hammer/)).toBeTruthy();
});

test('builder_effort_change_updates', async () => {
  render(<BuilderPanel builderId="b1" />);
  await act(async () => { fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'low' } }); });
  expect(ipc.updateBuilder).toHaveBeenCalledWith({ ...builder(), effort: 'low' });
});

test('builder_model_and_effort_reset_to_default', async () => {
  act(() => useApp.setState({ builders: [builder({ model: null, effort: 'high' })] }));
  render(<BuilderPanel builderId="b1" />);
  const model = screen.getByLabelText('Model') as HTMLSelectElement;
  expect(model.value).toBe(''); // null shows as Default, not as the first model
  expect(model.selectedOptions[0].textContent).toBe('Default');
  await act(async () => { fireEvent.change(screen.getByLabelText('Effort'), { target: { value: '' } }); });
  expect(ipc.updateBuilder).toHaveBeenCalledWith({ ...builder({ model: null, effort: 'high' }), effort: null });
});

test('agent_model_effort_locked_while_busy', () => {
  act(() => useApp.setState({ sessions: { s1: sess() } }));
  render(<BuilderPanel builderId="b1" />);
  for (const l of ['Agent', 'Model', 'Effort']) expect((screen.getByLabelText(l) as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(false);
  expect(screen.getByTestId('builder-busy-note').textContent).toMatch(/locked until it ends/);
  fireEvent.click(screen.getByText('Open session'));
  expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's1' });
  act(() => useApp.setState({ sessions: { s1: sess({ state: { kind: 'ended', exitCode: 0 } }) } }));
  for (const l of ['Agent', 'Model', 'Effort']) expect((screen.getByLabelText(l) as HTMLSelectElement).disabled).toBe(false);
});

test('dismiss_disabled_while_busy', async () => {
  act(() => useApp.setState({ sessions: { s1: sess() } }));
  render(<BuilderPanel builderId="b1" />);
  const d = screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement;
  expect(d.disabled).toBe(true);
  expect(d.title).toMatch(/in a session/i);
  act(() => useApp.setState({ sessions: {} }));
  expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
  expect(ipc.deleteBuilder).toHaveBeenCalledWith('b1');
  expect(useApp.getState().builders).toHaveLength(0);
});

test('town_hall_lists_idle_builders', () => {
  act(() => useApp.setState({
    builders: [builder(), builder({ id: 'b2', name: 'Bo', agent: 'codex', model: null, effort: null })],
    sessions: { s1: sess() },
    workspaces: [ws(), ws({ id: 'w2', name: 'gone', path: '/g', missing: true })],
  }));
  render(<TownHallPanel />);
  expect(screen.getByText('Bo')).toBeTruthy();
  expect(screen.queryByTestId('idle-builder-b1')).toBeNull(); // Ada is in a session
  expect(screen.getByTestId('idle-builder-b2')).toBeTruthy();
  expect(screen.getByText('proj')).toBeTruthy();
  expect(screen.getByText('missing')).toBeTruthy();
  expect(screen.getByText(/1 session/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open folder' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy();
});

test('side_panel_maps_selection_closes_on_x_and_esc', () => {
  render(<SidePanel />);
  expect(document.querySelector('.side-panel')).toBeNull();
  act(() => useApp.getState().setSelection({ kind: 'workspace', id: 'w1' }));
  expect(document.querySelector('.side-panel h2')!.textContent).toBe('proj');
  fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
  expect(useApp.getState().selection).toBeNull();
  act(() => useApp.getState().setSelection({ kind: 'hall' }));
  expect(document.querySelector('.side-panel h2')!.textContent).toBe('Town Hall');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(useApp.getState().selection).toBeNull();
  expect(useApp.getState().panelOpen).toBe(false);
  act(() => useApp.getState().setSelection({ kind: 'builder', id: 'b1' }));
  expect(document.querySelector('.side-panel h2')!.textContent).toBe('Ada');
});
