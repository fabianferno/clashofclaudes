import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentInfo } from '../api/types';

vi.mock('../api/ipc', () => ({ ipc: { detectAgents: vi.fn() } }));
import { ipc } from '../api/ipc';
import { useApp } from '../state/store';
import AgentsStatus from './AgentsStatus';

const base: AgentInfo = { kind: 'claude', label: 'Claude Code', installed: true, version: '2.1.0', models: [], efforts: [], canApprove: true };
const agents: AgentInfo[] = [
  base,
  { ...base, kind: 'codex', label: 'Codex', installed: false, version: null },
  { ...base, kind: 'opencode', label: 'OpenCode', installed: false, version: null },
  { ...base, kind: 'gemini', label: 'Gemini CLI (API key)', installed: false, version: null },
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

test('agents_status_lists_install_commands', () => {
  render(<AgentsStatus />);
  expect(screen.getByText(/2\.1\.0/)).toBeTruthy();
  expect(screen.getAllByText('Not installed')).toHaveLength(3);
  for (const c of ['npm i -g @openai/codex', 'npm i -g opencode-ai', 'npm i -g @google/gemini-cli']) {
    expect(screen.getByText(c)).toBeTruthy();
  }
  expect(screen.queryByText('npm i -g @anthropic-ai/claude-code')).toBeNull(); // installed: no command
  expect(screen.getByText(/always available/i)).toBeTruthy();
  expect(screen.getByText(/Antigravity CLI/)).toBeTruthy();
});

test('missing claude shows its install command and Copy writes it to the clipboard', () => {
  act(() => useApp.setState({ agents: [{ ...base, installed: false, version: null }] }));
  render(<AgentsStatus />);
  expect(screen.getByText('npm i -g @anthropic-ai/claude-code')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  expect(writeText).toHaveBeenCalledWith('npm i -g @anthropic-ai/claude-code');
});

test('recheck_bypasses_cache', async () => {
  const fresh = agents.map((a) => (a.kind === 'codex' ? { ...a, installed: true, version: '0.9.0' } : a));
  vi.mocked(ipc.detectAgents).mockResolvedValue(fresh);
  render(<AgentsStatus />);
  fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
  expect(ipc.detectAgents).toHaveBeenCalledWith(true);
  await waitFor(() => expect(useApp.getState().agents.find((a) => a.kind === 'codex')?.installed).toBe(true));
});
