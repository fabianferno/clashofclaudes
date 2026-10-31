import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentInfo } from '../api/types';

vi.mock('../api/ipc', () => ({ ipc: { detectAgents: vi.fn() } }));
import { ipc } from '../api/ipc';
import { useApp } from '../state/store';
import AgentsStatus, { COPIED_MS } from './AgentsStatus';

const base: AgentInfo = { kind: 'claude', label: 'Claude Code', installed: true, version: '2.1.0', models: [], efforts: [], canApprove: true };
const agents: AgentInfo[] = [
  base,
  { ...base, kind: 'codex', label: 'Codex', installed: false, version: null },
  { ...base, kind: 'opencode', label: 'OpenCode', installed: false, version: null },
  { ...base, kind: 'antigravity', label: 'Antigravity CLI', installed: false, version: null },
  { ...base, kind: 'custom', label: 'Custom command', version: null },
];
const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.mocked(ipc.detectAgents).mockReset();
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  act(() => useApp.setState({ agents }));
});
afterEach(cleanup);

const tile = (k: string) => screen.getByTestId(`agent-tile-${k}`);

test('agents show as app icons only, marked ready or not set up', () => {
  render(<AgentsStatus />);
  for (const k of ['claude', 'codex', 'opencode', 'antigravity', 'custom']) expect(screen.getByTestId(`agent-logo-${k}`)).toBeTruthy();
  expect(tile('claude').getAttribute('aria-label')).toBe('Claude Code: ready');
  expect(tile('codex').getAttribute('aria-label')).toBe('Codex: not set up');
  expect(tile('custom').getAttribute('aria-label')).toBe('Custom: ready');
  expect(tile('antigravity').textContent).toBe('+Antigravity CLI');
  // No commands or versions until a tile is clicked.
  expect(screen.queryByText(/npm i -g/)).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('clicking an agent that is not set up opens its setup steps; Copy writes the command', () => {
  render(<AgentsStatus />);
  fireEvent.click(tile('codex'));
  const dialog = screen.getByRole('dialog', { name: 'Codex' });
  expect(dialog.textContent).toContain('Not installed');
  expect(screen.getByText('npm i -g @openai/codex')).toBeTruthy();
  expect(screen.getByText('codex login')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
  expect(writeText).toHaveBeenCalledWith('npm i -g @openai/codex');
});

test('Check again re-detects (bypassing the cache) and the dialog turns ready', async () => {
  const fresh = agents.map((a) => (a.kind === 'codex' ? { ...a, installed: true, version: '0.9.0' } : a));
  vi.mocked(ipc.detectAgents).mockResolvedValue(fresh);
  render(<AgentsStatus />);
  fireEvent.click(tile('codex'));
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(ipc.detectAgents).toHaveBeenCalledWith(true);
  await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Installed · 0.9.0'));
  expect(tile('codex').getAttribute('aria-label')).toBe('Codex: ready');
});

test('a check that still finds nothing says so', async () => {
  vi.mocked(ipc.detectAgents).mockResolvedValue(agents);
  render(<AgentsStatus />);
  fireEvent.click(tile('opencode'));
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByText(/Still not found/)).toBeTruthy();
});

test('Esc, Done and the backdrop close the dialog', () => {
  render(<AgentsStatus />);
  fireEvent.click(tile('codex'));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(tile('codex'));
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(tile('codex'));
  fireEvent.click(document.querySelector('.modal-bg')!);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('an installed agent shows its version without repeating the name', () => {
  act(() => useApp.setState({ agents: [{ ...base, version: '2.1.314 (Claude Code)' }] }));
  render(<AgentsStatus />);
  fireEvent.click(tile('claude'));
  expect(screen.getByText('Installed · 2.1.314')).toBeTruthy();
  expect(screen.queryByText('npm i -g @anthropic-ai/claude-code')).toBeNull();
});

test('Copied reads back to Copy after a moment', async () => {
  vi.useFakeTimers();
  try {
    render(<AgentsStatus />);
    fireEvent.click(tile('codex'));
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(COPIED_MS); });
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  } finally { vi.useRealTimers(); }
});

test('Antigravity setup points to its docs and the agy sign-in', () => {
  render(<AgentsStatus />);
  fireEvent.click(tile('antigravity'));
  expect(screen.getByRole('dialog', { name: 'Antigravity CLI' }).textContent).toContain('antigravity.google/docs/cli');
  expect(screen.getByText('agy')).toBeTruthy();
  expect(screen.queryByText(/npm i -g/)).toBeNull();
});
