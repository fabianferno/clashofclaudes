import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentInfo, SessionInfo } from '../api/types';

const ipc = vi.hoisted(() => ({
  bugReportInfo: vi.fn(),
  sendBugReport: vi.fn(),
}));
vi.mock('../api/ipc', () => ({ ipc }));
import { useApp } from '../state/store';
import BugReportDialog, { CAPTURE_MS, openBugReport, reportDetails } from './BugReport';

const sess = (o: Partial<SessionInfo>): SessionInfo => ({
  id: 's1', workspaceId: 'w1', kind: { kind: 'agent', builderId: 'b1' }, task: 'secret task', state: { kind: 'working' },
  steps: 3, startedAt: 1, lastOutputAt: 1, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false,
  rev: 1, spot: null, ...o,
});
const agents: AgentInfo[] = [
  { kind: 'claude', label: 'Claude Code', installed: true, version: '2.1.0 (Claude Code)', models: [], efforts: [], canApprove: true },
  { kind: 'codex', label: 'Codex', installed: false, version: null, models: [], efforts: [], canApprove: false },
  { kind: 'custom', label: 'Custom', installed: true, version: null, models: [], efforts: [], canApprove: false },
];

beforeEach(() => {
  ipc.bugReportInfo.mockReset().mockResolvedValue({ enabled: true, system: [['App', '0.1.0'], ['macOS', '27.2']] });
  ipc.sendBugReport.mockReset().mockResolvedValue(undefined);
  act(() => useApp.setState({ bugReport: null, settingsOpen: false, error: null, agents, workspaces: [], builders: [], sessions: {} }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

test('details name versions and counts, never tasks or names', () => {
  const d = reportDetails(
    { agents, workspaces: [{ id: 'w1', name: 'my-secret-repo' } as never], builders: [], sessions: { a: sess({ id: 'a' }), b: sess({ id: 'b', paused: true }), c: sess({ id: 'c', kind: { kind: 'terminal' } }) }, error: 'Folder not found' },
    true, { w: 1280, h: 768, dpr: 2 },
  );
  expect(Object.fromEntries(d)).toEqual({
    Agents: 'Claude Code 2.1.0',
    Village: '1 workspace · 0 builders',
    Sessions: '1 working, 1 paused, 1 terminal',
    Window: '1280×768 @2x',
    Art: 'painted',
    'Last error': 'Folder not found',
  });
  expect(JSON.stringify(d)).not.toMatch(/secret/);
});

test('opening closes Settings, takes a picture, and opens without one when it fails or hangs', async () => {
  vi.useFakeTimers();
  act(() => useApp.setState({ settingsOpen: true }));
  const p = openBugReport(async () => 'JPEG');
  expect(useApp.getState().settingsOpen).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); await p; });
  expect(useApp.getState().bugReport).toEqual({ screenshot: 'JPEG' });

  act(() => useApp.setState({ bugReport: null }));
  const hang = openBugReport(() => new Promise(() => {}));
  await act(async () => { await vi.advanceTimersByTimeAsync(CAPTURE_MS + 100); await hang; });
  expect(useApp.getState().bugReport).toEqual({ screenshot: null });

  act(() => useApp.setState({ bugReport: null }));
  const broken = openBugReport(() => Promise.reject(new Error('no')));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); await broken; });
  expect(useApp.getState().bugReport).toEqual({ screenshot: null });
});

test('sends the text, contact and details; the screenshot only when ticked', async () => {
  act(() => useApp.setState({ bugReport: { screenshot: 'JPEG' } }));
  render(<BugReportDialog />);
  const send = await screen.findByRole('button', { name: 'Send report' });
  expect((send as HTMLButtonElement).disabled).toBe(true); // nothing written yet
  fireEvent.change(screen.getByPlaceholderText(/What you did/), { target: { value: 'The house vanished' } });
  fireEvent.change(screen.getByPlaceholderText('Discord name or email'), { target: { value: '  ada  ' } });
  expect(screen.getByText('App')).toBeTruthy(); // the backend's details are shown too
  await act(async () => { fireEvent.click(send); });
  expect(ipc.sendBugReport).toHaveBeenCalledWith(expect.objectContaining({ text: 'The house vanished', contact: 'ada', screenshot: null }));
  expect(ipc.sendBugReport.mock.calls[0][0].details.map((d: [string, string]) => d[0])).toContain('Agents');
  expect(screen.getByText('Sent. Thank you!')).toBeTruthy();
});

test('a ticked screenshot goes along; a failure keeps the report and says why', async () => {
  ipc.sendBugReport.mockRejectedValueOnce('Could not send the report: timed out');
  act(() => useApp.setState({ bugReport: { screenshot: 'JPEG' } }));
  render(<BugReportDialog />);
  fireEvent.change(await screen.findByPlaceholderText(/What you did/), { target: { value: 'It froze' } });
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send report' })); });
  expect(ipc.sendBugReport.mock.calls[0][0].screenshot).toBe('JPEG');
  expect(screen.getByText('Could not send the report: timed out')).toBeTruthy();
  expect((screen.getByPlaceholderText(/What you did/) as HTMLTextAreaElement).value).toBe('It froze');
});

test('a build without a webhook says so and cannot send; Esc closes', async () => {
  ipc.bugReportInfo.mockResolvedValue({ enabled: false, system: [] });
  act(() => useApp.setState({ bugReport: { screenshot: null } }));
  render(<BugReportDialog />);
  expect(await screen.findByText("This build can't send bug reports.")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText(/What you did/), { target: { value: 'x' } });
  expect((screen.getByRole('button', { name: 'Send report' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('checkbox')).toBeNull(); // no picture, no tick box
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  expect(useApp.getState().bugReport).toBeNull();
});
