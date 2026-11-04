import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentInfo, Builder, SessionInfo, Workspace } from '../api/types';

const ipc = vi.hoisted(() => ({
  updateBuilder: vi.fn().mockResolvedValue(undefined),
  deleteBuilder: vi.fn().mockResolvedValue(undefined),
  startTerminal: vi.fn(),
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  openInEditor: vi.fn().mockResolvedValue(undefined),
  openInFinder: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn().mockResolvedValue({ updatesEnabled: true }),
  setSettings: vi.fn(async (s: unknown) => s),
  setWorkspaceColor: vi.fn(async (id: string, color: string | null) => ({ ...ws(), id, color })),
}));
vi.mock('../api/ipc', () => ({ ipc }));
const sessionPanel = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('./SessionPanel', async () => {
  const { useEffect } = await import('react');
  return { default: () => { useEffect(() => { sessionPanel.mounts++; }, []); return null; } };
});
vi.mock('./NewSessionPicker', () => ({ default: () => null }));
import { useApp } from '../state/store';
import SidePanel from './SidePanel';
import WorkspacePanel, { CUSTOM_COLOR_MS } from './WorkspacePanel';
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
  steps: 3, startedAt: 1, lastOutputAt: 1, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false,
  rev: 1, spot: null, ...o,
});
const agents: AgentInfo[] = [
  { kind: 'claude', label: 'Claude Code', installed: true, version: null, models: ['haiku', 'sonnet', 'opus'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], canApprove: true },
  { kind: 'codex', label: 'Codex', installed: true, version: null, models: [], efforts: [], canApprove: false },
];

beforeEach(() => {
  Object.values(ipc).forEach((f) => f.mockClear());
  act(() => useApp.setState({ workspaces: [ws()], builders: [builder()], sessions: {}, agents, selection: null, panelOpen: false, apps: [], browsers: [], appPopout: null, hiddenApps: [] }));
});
afterEach(cleanup);

const openColors = () => fireEvent.click(screen.getByRole('button', { name: 'House colour' }));

test('the house colour opens in a dialog; Esc closes it and leaves the panel open', () => {
  act(() => useApp.getState().setSelection({ kind: 'workspace', id: 'w1' }));
  render(<SidePanel />);
  expect(screen.queryByRole('dialog', { name: 'House colour' })).toBeNull();
  openColors();
  expect(screen.getByRole('dialog', { name: 'House colour' })).toBeTruthy();
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  expect(screen.queryByRole('dialog', { name: 'House colour' })).toBeNull();
  expect(useApp.getState().selection).not.toBeNull();
  openColors();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('dialog', { name: 'House colour' })).toBeNull();
});

test('a swatch paints the house at once and saves; Auto goes back', async () => {
  render(<WorkspacePanel workspaceId="w1" />);
  openColors();
  expect(screen.getByRole('radio', { name: 'Auto' }).getAttribute('aria-checked')).toBe('true');
  await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Green' })); });
  expect(ipc.setWorkspaceColor).toHaveBeenCalledWith('w1', '#3fa34d');
  expect(useApp.getState().workspaces[0].color).toBe('#3fa34d');
  expect(screen.getByRole('radio', { name: 'Green' }).getAttribute('aria-checked')).toBe('true');
  await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Auto' })); });
  expect(ipc.setWorkspaceColor).toHaveBeenLastCalledWith('w1', null);
  expect(useApp.getState().workspaces[0].color).toBeNull();
});

test('a failed colour save puts the old one back and says why', async () => {
  act(() => useApp.setState({ workspaces: [ws({ color: '#8a4fd0' })] }));
  ipc.setWorkspaceColor.mockRejectedValueOnce('disk full');
  render(<WorkspacePanel workspaceId="w1" />);
  openColors();
  await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Gold' })); });
  expect(useApp.getState().workspaces[0].color).toBe('#8a4fd0');
  expect(screen.getByText('disk full')).toBeTruthy();
});

test('any colour waits for the colour panel to rest before saving', async () => {
  vi.useFakeTimers();
  try {
    render(<WorkspacePanel workspaceId="w1" />);
    openColors();
    const any = screen.getByLabelText('Any colour');
    fireEvent.change(any, { target: { value: '#112233' } });
    fireEvent.change(any, { target: { value: '#123456' } });
    expect(ipc.setWorkspaceColor).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(CUSTOM_COLOR_MS); });
    expect(ipc.setWorkspaceColor).toHaveBeenCalledTimes(1);
    expect(ipc.setWorkspaceColor).toHaveBeenCalledWith('w1', '#123456');
  } finally {
    vi.useRealTimers();
  }
});

test('missing_workspace_buttons_explain', () => {
  act(() => useApp.setState({ workspaces: [ws({ missing: true })] }));
  render(<WorkspacePanel workspaceId="w1" />);
  for (const name of ['+ New session', '+ Terminal', '+ Browser', 'Open in editor', 'Open in Finder', 'Focus']) {
    const b = screen.getByRole('button', { name }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('Folder not found: /p/proj');
  }
  expect(screen.getByText(/Folder not found: \/p\/proj/, { selector: '.panel-warn' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Remove workspace' }) as HTMLButtonElement).disabled).toBe(false);
});

test('plus_browser_opens_a_browser_board_and_pops_it_out', () => {
  render(<WorkspacePanel workspaceId="w1" />);
  fireEvent.click(screen.getByRole('button', { name: '+ Browser' }));
  const field = screen.getByRole('textbox', { name: 'Web address' }) as HTMLInputElement;
  expect(field.value).toBe('http://localhost:3000');
  fireEvent.change(field, { target: { value: 'ftp://nope' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(screen.getByText(/Type a web address/)).toBeTruthy();
  expect(useApp.getState().browsers).toEqual([]);
  fireEvent.change(field, { target: { value: 'localhost:5173' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  const [b] = useApp.getState().browsers;
  expect(b).toMatchObject({ workspaceId: 'w1', url: 'http://localhost:5173/' });
  expect(useApp.getState().appPopout).toEqual({ url: 'http://localhost:5173/', title: 'localhost', key: `w1:web-${b.id}`, browserId: b.id });
  // listed with the apps running here; both can be taken down
  act(() => useApp.setState({ apps: [{ workspaceId: 'w1', port: 3000, url: 'http://localhost:3000/', title: 'Shop', frameable: true, command: 'node' }] }));
  expect(screen.getByText('Browsers (2)')).toBeTruthy();
  expect(screen.getByText('http://localhost:3000/ · running here')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove localhost' }));
  expect(useApp.getState().browsers).toEqual([]);
  expect(useApp.getState().appPopout).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Remove Shop' }));
  expect(useApp.getState().hiddenApps).toEqual(['w1:3000']);
  expect(screen.queryByText('Browsers (1)')).toBeNull();
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

test('a_builder_dropped_on_the_workspace_opens_the_new_session_form_until_back', () => {
  act(() => useApp.setState({ selection: { kind: 'workspace', id: 'w1', builder: 'b1' } }));
  render(<WorkspacePanel workspaceId="w1" />);
  expect(screen.queryByRole('button', { name: '+ New session' })).toBeNull(); // the form, not the overview
  fireEvent.click(screen.getByRole('button', { name: '‹ Back' }));
  expect(useApp.getState().selection).toEqual({ kind: 'workspace', id: 'w1' });
  expect(screen.getByRole('button', { name: '+ New session' })).toBeTruthy();
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
  const slider = screen.getByLabelText('Effort') as HTMLInputElement;
  expect(slider.type).toBe('range');
  expect(slider.getAttribute('aria-valuetext')).toBe('Max'); // steps: Default, Low, Medium, High, X-High, Max
  await act(async () => { fireEvent.change(slider, { target: { value: '1' } }); });
  expect(ipc.updateBuilder).toHaveBeenCalledWith({ ...builder(), effort: 'low' });
});

test('builder_model_is_a_slider', async () => {
  render(<BuilderPanel builderId="b1" />);
  const slider = screen.getByLabelText('Model') as HTMLInputElement;
  expect(slider.type).toBe('range');
  expect([slider.max, slider.value, slider.getAttribute('aria-valuetext')]).toEqual(['3', '3', 'opus']); // Default, haiku, sonnet, opus
  await act(async () => { fireEvent.change(slider, { target: { value: '2' } }); });
  expect(ipc.updateBuilder).toHaveBeenCalledWith({ ...builder(), model: 'sonnet' });
});

test('builder_model_and_effort_reset_to_default', async () => {
  act(() => useApp.setState({ builders: [builder({ model: null, effort: 'high' })] }));
  render(<BuilderPanel builderId="b1" />);
  // null shows as Default, not as the first model
  expect(screen.getByLabelText('Model').getAttribute('aria-valuetext')).toBe('Default');
  await act(async () => { fireEvent.change(screen.getByLabelText('Effort'), { target: { value: '0' } }); });
  expect(ipc.updateBuilder).toHaveBeenCalledWith({ ...builder({ model: null, effort: 'high' }), effort: null });
});

test('builder_free_text_model_for_agents_without_a_list', async () => {
  act(() => useApp.setState({ builders: [builder({ agent: 'codex', model: null, effort: null })] }));
  render(<BuilderPanel builderId="b1" />);
  const input = screen.getByLabelText('Model') as HTMLInputElement;
  expect(input.tagName).toBe('INPUT');
  expect(input.placeholder).toBe('model id');
  fireEvent.change(input, { target: { value: ' gpt-6 ' } });
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
  expect(ipc.updateBuilder).toHaveBeenLastCalledWith(builder({ agent: 'codex', model: 'gpt-6', effort: null }));
  // Clearing it goes back to the default model (null).
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } });
  await act(async () => { fireEvent.blur(screen.getByLabelText('Model')); });
  expect(ipc.updateBuilder).toHaveBeenLastCalledWith(builder({ agent: 'codex', model: null, effort: null }));
});

test('builder_free_text_model_placeholder_for_opencode; none for custom', () => {
  act(() => useApp.setState({
    agents: [...agents, { kind: 'opencode', label: 'OpenCode', installed: true, version: null, models: [], efforts: [], canApprove: false },
      { kind: 'custom', label: 'Custom command', installed: true, version: null, models: [], efforts: [], canApprove: false }],
    builders: [builder({ agent: 'opencode', model: null, effort: null }), builder({ id: 'b2', agent: 'custom', model: null, effort: null, customCommand: 'x' })],
  }));
  const { unmount } = render(<BuilderPanel builderId="b1" />);
  expect((screen.getByLabelText('Model') as HTMLInputElement).placeholder).toBe('provider/model');
  unmount();
  render(<BuilderPanel builderId="b2" />);
  expect(screen.queryByLabelText('Model')).toBeNull();
});

test('agent_model_effort_locked_while_busy', () => {
  act(() => useApp.setState({ sessions: { s1: sess() } }));
  render(<BuilderPanel builderId="b1" />);
  for (const l of ['Agent', 'Model', 'Effort']) expect((screen.getByLabelText(l) as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole('radio', { name: 'Codex' }) as HTMLButtonElement).matches(':disabled')).toBe(true);
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

test('town_hall_lists_every_builder_with_its_status', () => {
  act(() => useApp.setState({
    builders: [builder(), builder({ id: 'b2', name: 'Bo', agent: 'codex', model: null, effort: null })],
    sessions: { s1: sess() },
    workspaces: [ws(), ws({ id: 'w2', name: 'gone', path: '/g', missing: true })],
  }));
  render(<TownHallPanel />);
  expect(screen.getByText('Bo')).toBeTruthy();
  expect(screen.getByTestId('hall-builder-b1').textContent).toMatch(/Ada.*Working/); // in a session
  expect(screen.getByTestId('hall-builder-b2').textContent).toMatch(/Bo.*Idle/);
  fireEvent.click(screen.getByTestId('hall-builder-b1'));
  expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's1' }); // a busy builder opens its session
  expect(screen.getByText('proj')).toBeTruthy();
  expect(screen.getByText('missing')).toBeTruthy();
  expect(screen.getByText(/1 session/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open workspace' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'New workspace' })).toBeTruthy();
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

test('switching between sessions keeps one session panel mounted', () => {
  act(() => useApp.setState({ sessions: { s1: sess(), s2: sess({ id: 's2' }) } }));
  render(<SidePanel />);
  const before = sessionPanel.mounts;
  act(() => useApp.getState().setSelection({ kind: 'session', id: 's1' }));
  act(() => useApp.getState().setSelection({ kind: 'session', id: 's2' }));
  act(() => useApp.getState().setSelection({ kind: 'session', id: 's1' }));
  expect(sessionPanel.mounts - before).toBe(1); // its terminal survives the switch
});

test('town hall: no-builders copy', () => {
  act(() => useApp.setState({ builders: [], sessions: {} }));
  render(<TownHallPanel />);
  expect(screen.getByText('No builders yet — recruit one from + New session.')).toBeTruthy();
});

test('town hall opens the Settings page', () => {
  render(<TownHallPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
  expect(useApp.getState().settingsOpen).toBe(true);
  act(() => useApp.getState().setSettingsOpen(false));
});

test('builder_agent_is_icon_buttons; switching resets model and effort to the new agent', async () => {
  render(<BuilderPanel builderId="b1" />);
  expect(screen.getByRole('radio', { checked: true }).getAttribute('aria-label')).toBe('Claude Code');
  expect(screen.getByTestId('agent-logo-codex')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Codex' })); });
  expect(ipc.updateBuilder).toHaveBeenCalledWith({ ...builder(), agent: 'codex', model: null, effort: null });
});

test('open_in_finder_opens_the_workspace_folder', () => {
  render(<WorkspacePanel workspaceId="w1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open in Finder' }));
  expect(ipc.openInFinder).toHaveBeenCalledWith('/p/proj');
});
