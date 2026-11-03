import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentInfo, Builder, SessionInfo } from '../api/types';

vi.mock('../api/ipc', () => ({ ipc: { createBuilder: vi.fn(), startSession: vi.fn(), saveAttachment: vi.fn(), discardAttachments: vi.fn() } }));
import { ipc } from '../api/ipc';
import { useApp } from '../state/store';
import NewSessionPicker, { commandPreview, RECRUIT_NAMES } from './NewSessionPicker';

const claude: AgentInfo = {
  kind: 'claude', label: 'Claude Code', installed: true, version: '2', canApprove: true,
  models: ['haiku', 'sonnet', 'opus'], efforts: ['low', 'max'],
};
const codex: AgentInfo = { ...claude, kind: 'codex', label: 'Codex', installed: false };
const custom: AgentInfo = { ...claude, kind: 'custom', label: 'Custom command', models: [], efforts: [], canApprove: false };
const bld = (id: string, name: string): Builder => ({ id, name, agent: 'claude', model: null, effort: null, customCommand: null });
const sess = (id: string, builderId: string, state: SessionInfo['state']): SessionInfo => ({
  id, workspaceId: 'w', kind: { kind: 'agent', builderId }, task: null, state, steps: 0, startedAt: 0, lastOutputAt: 0,
  reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot: null,
});
const ensureSpot = vi.fn().mockResolvedValue({ x: 0, y: 0 });

function setup(o: { builders?: Builder[]; sessions?: Record<string, SessionInfo>; agents?: AgentInfo[] } = {}) {
  act(() => useApp.setState({
    workspaces: [{ id: 'w', name: 'proj', path: '/p', createdAt: 0, missing: false, level: 1, xp: 0, compound: null }],
    builders: o.builders ?? [], sessions: o.sessions ?? {}, agents: o.agents ?? [claude, custom],
    selection: null, error: null, village: { ...useApp.getState().village, ensureSpot },
  }));
}
beforeEach(() => { vi.mocked(ipc.createBuilder).mockReset(); vi.mocked(ipc.startSession).mockReset(); ensureSpot.mockClear(); });
afterEach(cleanup);

test('commandPreview for claude', () => {
  expect(commandPreview(claude, 'opus', 'max', 'fix "bug"')).toBe('claude … --model opus --effort max -- "fix \\"bug\\""');
});
const opencode: AgentInfo = { ...claude, kind: 'opencode', label: 'OpenCode', models: [], canApprove: false };
const antigravity: AgentInfo = { ...claude, kind: 'antigravity', label: 'Antigravity CLI', models: ['gemini-3.8-flash-medium'], efforts: [], canApprove: false };
test('commandPreview shows attached images', () => {
  expect(commandPreview(claude, undefined, undefined, 'fix it', undefined, 2)).toBe('claude … --add-dir=… -- "fix it [2 images]"');
  expect(commandPreview(codex, undefined, undefined, undefined, undefined, 1)).toBe('codex … --image=… -- "[1 image]"');
  expect(commandPreview(antigravity, undefined, undefined, 'x', undefined, 1)).toBe('agy --add-dir=… --prompt-interactive="x [1 image]"');
});
test('commandPreview mirrors the Codex adapter', () => {
  expect(commandPreview(codex, 'gpt-6', 'high', 'fix it')).toBe('codex -m gpt-6 -c model_reasoning_effort="high" … -- "fix it"');
  expect(commandPreview(codex)).toBe('codex …');
});
test('commandPreview mirrors the OpenCode adapter (effort only via config, for provider/model)', () => {
  expect(commandPreview(opencode, 'anthropic/claude-x', 'high', 'fix it'))
    .toBe('OPENCODE_CONFIG_CONTENT=… opencode … --model=anthropic/claude-x --prompt="fix it"');
  expect(commandPreview(opencode, 'gpt-5', 'high')).toBe('opencode … --model=gpt-5');
  expect(commandPreview(opencode, undefined, 'high')).toBe('opencode …');
});
test('commandPreview mirrors the Antigravity adapter (effort is part of the model id)', () => {
  expect(commandPreview(antigravity, 'gemini-3.8-flash-medium', 'high', 'fix it')).toBe('agy --model=gemini-3.8-flash-medium --prompt-interactive="fix it"');
  expect(commandPreview(antigravity)).toBe('agy');
});
test('agents without a model list get a free-text model; empty means default', async () => {
  const codexOn = { ...codex, installed: true, models: [] };
  const opencodeOn = { ...opencode, installed: true };
  setup({ agents: [codexOn, opencodeOn, custom] });
  vi.mocked(ipc.createBuilder).mockResolvedValue({ ...bld('b9', 'Ivy'), agent: 'codex' });
  vi.mocked(ipc.startSession).mockResolvedValue(sess('s9', 'b9', { kind: 'working' }));
  render(<NewSessionPicker workspaceId="w" />);
  const model = () => screen.getByPlaceholderText(/model id|provider\/model/) as HTMLInputElement;
  expect(model().placeholder).toBe('model id');
  fireEvent.click(screen.getByRole('radio', { name: 'OpenCode' }));
  expect(model().placeholder).toBe('provider/model');
  fireEvent.change(model(), { target: { value: ' openai/gpt-5 ' } });
  expect(screen.getByText(/^opencode … --model=openai\/gpt-5$/)).toBeTruthy();
  fireEvent.click(screen.getByText('Start'));
  await vi.waitFor(() => expect(ipc.createBuilder).toHaveBeenCalledWith('Ivy', 'opencode', 'openai/gpt-5', null, null));
  // Back to Codex: the field resets, and an empty model is sent as null.
  cleanup();
  vi.mocked(ipc.createBuilder).mockClear();
  setup({ agents: [codexOn, custom] });
  render(<NewSessionPicker workspaceId="w" />);
  fireEvent.change(model(), { target: { value: '   ' } });
  fireEvent.click(screen.getByText('Start'));
  await vi.waitFor(() => expect(ipc.createBuilder).toHaveBeenCalledWith('Ivy', 'codex', null, null, null));
});
test('commandPreview omits unset model/effort', () => {
  expect(commandPreview(claude, undefined, undefined, undefined)).toBe('claude …');
});
test('picker_disables_uninstalled', () => {
  setup({ agents: [claude, codex, custom] });
  render(<NewSessionPicker workspaceId="w" />);
  const opt = (name: RegExp) => screen.getByRole('radio', { name }) as HTMLButtonElement;
  expect(opt(/^Claude Code$/).disabled).toBe(false);
  expect(opt(/^Custom command$/).disabled).toBe(false);
  expect(opt(/^Codex/).disabled).toBe(true);
  expect(opt(/^Codex/).getAttribute('aria-label')).toBe('Codex — Not installed — see Town Hall');
  expect(screen.getByTestId('agent-logo-codex')).toBeTruthy(); // app-icon buttons, as in the Town Hall
  // The agents list (install commands, Re-check) lives in the Town Hall only.
  expect(screen.queryByTestId('agents-status')).toBeNull();
  // the default never lands on an uninstalled agent
  expect(screen.getByRole('radio', { checked: true }).getAttribute('aria-label')).toBe('Claude Code');
});

test('agent default follows agents detected after mount until the user picks', () => {
  setup({ agents: [] });
  render(<NewSessionPicker workspaceId="w" />);
  act(() => useApp.setState({ agents: [claude, custom] }));
  const checked = () => screen.getByRole('radio', { checked: true }).getAttribute('aria-label');
  expect(checked()).toBe('Claude Code');
  expect(screen.getByText(/^claude …/)).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'Custom command' }));
  act(() => useApp.setState({ agents: [claude, custom, { ...codex, installed: true }] }));
  expect(checked()).toBe('Custom command');
});

test('recruit_default_when_all_busy', () => {
  setup({ builders: [bld('b1', 'Ada')], sessions: { s1: sess('s1', 'b1', { kind: 'working' }) } });
  render(<NewSessionPicker workspaceId="w" />);
  expect(screen.getByLabelText('Name')).toBeTruthy();
  expect(screen.queryByTestId('idle-list')).toBeNull();
});

test('idle builder list is the default when one is idle; an ended session does not make a builder busy', () => {
  setup({ builders: [bld('b1', 'Ada'), bld('b2', 'Bo')], sessions: { s1: sess('s1', 'b1', { kind: 'ended', exitCode: 0 }) } });
  render(<NewSessionPicker workspaceId="w" />);
  expect(screen.getByTestId('idle-list')).toBeTruthy();
  expect(screen.getByText('Ada')).toBeTruthy();
  expect(screen.queryByLabelText('Name')).toBeNull();
});

test('recruit_name_defaults_to_unused', () => {
  setup({ builders: [bld('b1', 'Ivy'), bld('b2', 'Jax')], sessions: { s1: sess('s1', 'b1', { kind: 'working' }), s2: sess('s2', 'b2', { kind: 'working' }) } });
  render(<NewSessionPicker workspaceId="w" />);
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Kai');
  expect(RECRUIT_NAMES[0]).toBe('Ivy');
});

test('recruit requires a command for custom', async () => {
  setup();
  render(<NewSessionPicker workspaceId="w" />);
  fireEvent.click(screen.getByRole('radio', { name: 'Custom command' }));
  fireEvent.click(screen.getByText('Start'));
  expect(await screen.findByText('Enter the custom command')).toBeTruthy();
  expect(ipc.createBuilder).not.toHaveBeenCalled();
});

test('start: startSession, upsert, ensureSpot, select; empty task allowed', async () => {
  setup({ builders: [bld('b1', 'Ada')] });
  vi.mocked(ipc.startSession).mockResolvedValue(sess('s9', 'b1', { kind: 'working' }));
  render(<NewSessionPicker workspaceId="w" />);
  fireEvent.click(screen.getByText('Start'));
  await vi.waitFor(() => expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's9' }));
  expect(ipc.startSession).toHaveBeenCalledWith('w', 'b1', '', []);
  expect(ensureSpot).toHaveBeenCalledWith('s9');
  expect(useApp.getState().sessions.s9).toBeTruthy();
});

test('recruit adds builder to store; a failed start keeps it, shows the error, and does not recreate it', async () => {
  setup();
  const b = bld('b1', 'Kai');
  vi.mocked(ipc.createBuilder).mockResolvedValue(b);
  vi.mocked(ipc.startSession).mockRejectedValueOnce('boom').mockResolvedValueOnce(sess('s', 'b1', { kind: 'working' }));
  render(<NewSessionPicker workspaceId="w" />);
  fireEvent.click(screen.getByText('Start'));
  await vi.waitFor(() => expect(useApp.getState().error).toBe('boom'));
  expect(useApp.getState().builders).toContainEqual(b);
  fireEvent.click(screen.getByText('Start'));
  await vi.waitFor(() => expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's' }));
  expect(ipc.createBuilder).toHaveBeenCalledTimes(1);
  expect(ipc.startSession).toHaveBeenLastCalledWith('w', 'b1', '', []);
});

test('the preview timer stops on unmount', () => {
  vi.useFakeTimers();
  const clear = vi.spyOn(globalThis, 'clearInterval');
  setup();
  const { unmount } = render(<NewSessionPicker workspaceId="w" />);
  unmount();
  expect(clear).toHaveBeenCalled();
  vi.useRealTimers();
});

test('ensureSpot failure is non-fatal: session selected, error reported, started once', async () => {
  setup({ builders: [bld('b1', 'Ada')] });
  vi.mocked(ipc.startSession).mockResolvedValue(sess('s7', 'b1', { kind: 'working' }));
  ensureSpot.mockRejectedValueOnce('no room');
  render(<NewSessionPicker workspaceId="w" />);
  fireEvent.click(screen.getByText('Start'));
  await vi.waitFor(() => expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's7' }));
  expect(useApp.getState().error).toBe('no room');
  expect(ipc.startSession).toHaveBeenCalledTimes(1);
});

test('recruiting picks the model and the effort with sliders', async () => {
  setup();
  vi.mocked(ipc.createBuilder).mockResolvedValue(bld('b1', 'Kai'));
  vi.mocked(ipc.startSession).mockResolvedValue(sess('s', 'b1', { kind: 'working' }));
  render(<NewSessionPicker workspaceId="w" />);
  const model = screen.getByLabelText('Model') as HTMLInputElement;
  expect(model.max).toBe('3'); // Default, haiku, sonnet, opus
  fireEvent.change(model, { target: { value: '3' } });
  expect(model.getAttribute('aria-valuetext')).toBe('opus');
  const slider = screen.getByLabelText('Effort') as HTMLInputElement;
  fireEvent.change(slider, { target: { value: '2' } }); // Default, Low, Max
  expect(slider.getAttribute('aria-valuetext')).toBe('Max');
  fireEvent.click(screen.getByText('Start'));
  await vi.waitFor(() => expect(ipc.createBuilder).toHaveBeenCalledWith(expect.any(String), 'claude', 'opus', 'max', null));
});

test('an agent without efforts shows no effort slider', () => {
  setup({ agents: [{ ...claude, efforts: [] }, custom] });
  render(<NewSessionPicker workspaceId="w" />);
  expect(screen.queryByLabelText('Effort')).toBeNull();
});

test('a long model list hides the tick labels and names only the chosen model', () => {
  const many = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  setup({ agents: [{ ...claude, models: many }, custom] });
  const { container } = render(<NewSessionPicker workspaceId="w" />);
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: '4' } });
  expect(screen.getByLabelText('Model').getAttribute('aria-valuetext')).toBe('m4');
  expect(container.querySelectorAll('.slider-ticks')).toHaveLength(1); // the effort slider's only
});

test('a builder dropped on the workspace starts out picked', async () => {
  setup({ builders: [bld('b1', 'Ada'), bld('b2', 'Bo')] });
  vi.mocked(ipc.startSession).mockResolvedValue(sess('s1', 'b2', { kind: 'working' }));
  render(<NewSessionPicker workspaceId="w" builderId="b2" />);
  expect(screen.getByRole('button', { name: /Bo/ }).className).toContain('picked');
  expect(screen.getByRole('button', { name: /Ada/ }).className).not.toContain('picked');
});

test('pasted images show as thumbnails, can be taken off, and go to the session', async () => {
  setup({ builders: [bld('b1', 'Ada')] });
  URL.createObjectURL = vi.fn(() => 'blob:img');
  vi.mocked(ipc.saveAttachment).mockResolvedValueOnce('a.png').mockResolvedValueOnce('b.png');
  vi.mocked(ipc.discardAttachments).mockResolvedValue(undefined);
  vi.mocked(ipc.startSession).mockResolvedValue(sess('s9', 'b1', { kind: 'working' }));
  render(<NewSessionPicker workspaceId="w" />);
  const task = screen.getByRole('textbox', { name: /Task/ });
  const png = (n: string) => new File([new Uint8Array([1])], n, { type: 'image/png' });
  fireEvent.paste(task, { clipboardData: { files: [png('1.png'), png('2.png')], types: ['Files'] } });
  await vi.waitFor(() => expect(screen.getAllByTestId('att-thumb')).toHaveLength(2));
  expect(screen.getByText(/\[2 images\]/)).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove image' })[0]);
  expect(ipc.discardAttachments).toHaveBeenCalledWith(['a.png']);
  fireEvent.paste(task, { clipboardData: { files: [], types: ['text/plain'] } }); // plain text: nothing to save
  expect(ipc.saveAttachment).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByText('Start'));
  await vi.waitFor(() => expect(ipc.startSession).toHaveBeenCalledWith('w', 'b1', '', ['b.png']));
  expect(screen.queryAllByTestId('att-thumb')).toHaveLength(0);
});
