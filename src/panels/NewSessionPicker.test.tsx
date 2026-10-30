import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentInfo, Builder, SessionInfo } from '../api/types';

vi.mock('../api/ipc', () => ({ ipc: { createBuilder: vi.fn(), startSession: vi.fn() } }));
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
  reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, rev: 1, spot: null,
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
  expect(commandPreview(claude, 'opus', 'max', 'fix "bug"')).toBe('claude … --model opus --effort max "fix \\"bug\\""');
});
test('commandPreview omits unset model/effort', () => {
  expect(commandPreview(claude, undefined, undefined, undefined)).toBe('claude …');
});
test('only installed agents are offered', () => {
  setup({ agents: [claude, codex, custom] });
  render(<NewSessionPicker workspaceId="w" />);
  const opts = screen.getAllByRole('option').map((o) => o.textContent);
  expect(opts).toContain('Claude Code');
  expect(opts).toContain('Custom command');
  expect(opts).not.toContain('Codex');
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
  fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'custom' } });
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
  expect(ipc.startSession).toHaveBeenCalledWith('w', 'b1', '');
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
  expect(ipc.startSession).toHaveBeenLastCalledWith('w', 'b1', '');
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
