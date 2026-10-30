import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import type { AgentInfo } from '../api/types';

vi.mock('../api/ipc', () => ({
  ipc: { createBuilder: vi.fn(), startSession: vi.fn() },
}));
import { ipc } from '../api/ipc';
import NewSessionForm, { commandPreview } from './NewSessionForm';

const claude: AgentInfo = {
  kind: 'claude', label: 'Claude Code', installed: true, version: '2', canApprove: true,
  models: ['haiku', 'sonnet', 'opus'], efforts: ['low', 'max'],
};
const codex: AgentInfo = { ...claude, kind: 'codex', label: 'Codex', installed: false };
const custom: AgentInfo = { ...claude, kind: 'custom', label: 'Custom command', models: [], efforts: [], canApprove: false };

test('commandPreview for claude', () => {
  expect(commandPreview(claude, 'opus', 'max', 'fix "bug"')).toBe('claude … --model opus --effort max "fix \\"bug\\""');
});
test('commandPreview omits unset model/effort', () => {
  expect(commandPreview(claude, undefined, undefined, undefined)).toBe('claude …');
});
test('recruit requires a name', async () => {
  render(<NewSessionForm workspaceId="w" agents={[claude, custom]} builders={[]} onStarted={() => {}} />);
  fireEvent.click(screen.getByText('Start'));
  expect(await screen.findByText('Name your builder')).toBeTruthy();
  expect(ipc.startSession).not.toHaveBeenCalled();
  expect(ipc.createBuilder).not.toHaveBeenCalled();
});
test('only installed agents are offered', () => {
  render(<NewSessionForm workspaceId="w" agents={[claude, codex, custom]} builders={[]} onStarted={() => {}} />);
  const opts = screen.getAllByRole('option').map((o) => o.textContent);
  expect(opts).toContain('Claude Code');
  expect(opts).toContain('Custom command');
  expect(opts).not.toContain('Codex');
});
