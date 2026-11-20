import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { BoardSettings, BoardStatus, Workspace } from '../api/types';

const ipc = vi.hoisted(() => ({ boardStatus: vi.fn(), boardCheck: vi.fn(), setWorkspaceShared: vi.fn() }));
vi.mock('../api/ipc', () => ({ ipc }));
// the phone remote's block has its own tests (RemoteSettings.test.tsx)
vi.mock('./RemoteSettings', () => ({ default: () => null }));
import TeamSettings, { WorkspaceShare } from './TeamSettings';
import { useApp } from '../state/store';
import { DEFAULT_SETTINGS } from '../state/settings';

const OFF: BoardSettings = { enabled: false, team: null, name: 'village', shareDetails: true, sessionEnv: true, shareNew: false, hostId: null };
const ON: BoardSettings = { ...OFF, enabled: true, hostId: 'h1' };
const status = (s: Partial<BoardStatus>): BoardStatus => ({ state: 'ready', handle: 'ada', boardUrl: 'https://b', teams: ['acme', 'ada-personal'], lastError: null, lastWriteAt: null, ...s });

beforeEach(() => {
  ipc.boardStatus.mockReset().mockResolvedValue(status({}));
  ipc.boardCheck.mockReset().mockResolvedValue(status({}));
  ipc.setWorkspaceShared.mockReset();
});
afterEach(cleanup);

const show = async (board: BoardSettings, onChange = vi.fn()) => {
  await act(async () => { render(<TeamSettings board={board} onChange={onChange} />); });
  return onChange;
};
const box = (label: string) => screen.getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement;

test('off shows only the switch, and asks the CLI nothing', async () => {
  await show(OFF);
  expect(box('Connect this village to Vercel Board').checked).toBe(false);
  expect(screen.getByText("Shows your shared workspaces' builders to your Vercel team. Off until you turn it on.")).toBeTruthy();
  expect(screen.queryByLabelText('Board name')).toBeNull();
  expect(screen.queryByLabelText(/^Share details/)).toBeNull();
  expect(ipc.boardStatus).not.toHaveBeenCalled();
});

test('turning it on calls onChange with enabled true', async () => {
  const onChange = await show(OFF);
  fireEvent.click(box('Connect this village to Vercel Board'));
  expect(onChange).toHaveBeenCalledWith({ ...OFF, enabled: true });
});

test('ready: who is signed in, and the choices', async () => {
  await show(ON);
  expect(screen.getByText('Signed in as ada · board village')).toBeTruthy();
  expect(screen.queryByText('Check again')).toBeNull();
  expect((screen.getByLabelText('Team') as HTMLSelectElement).value).toBe('');
  expect(Array.from((screen.getByLabelText('Team') as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(['Default team', 'acme', 'ada-personal']);
  expect(box('Share details').checked).toBe(true);
  expect(screen.getByText(/tasks, tool calls, replies, file names/)).toBeTruthy();
  expect(box('Builders write under their own name').checked).toBe(true);
  expect(box('Share new workspaces').checked).toBe(false);
});

test.each([
  ['noCli', 'The Vercel CLI is not installed.', ['npm i -g vercel', 'vercel login']],
  ['oldCli', 'This Vercel CLI has no board command. Update it:', ['npm i -g vercel@latest']],
  ['signedOut', 'Not signed in to Vercel.', ['vercel login']],
] as const)('%s says what is missing, with the commands', async (state, text, commands) => {
  ipc.boardStatus.mockResolvedValue(status({ state, handle: null, boardUrl: null, teams: [] }));
  await show(ON);
  expect(screen.getByText(text)).toBeTruthy();
  expect(Array.from(document.querySelectorAll('code')).map((c) => c.textContent)).toEqual([...commands]);
  expect(screen.getByText('Check again')).toBeTruthy();
});

test('an error shows what the board said', async () => {
  ipc.boardStatus.mockResolvedValue(status({ state: 'error', handle: null, lastError: 'You have no access to this board.' }));
  await show(ON);
  expect(screen.getByText('You have no access to this board.')).toBeTruthy();
  expect(screen.getByText('Check again')).toBeTruthy();
});

test('Check again asks anew and shows the answer', async () => {
  ipc.boardStatus.mockResolvedValue(status({ state: 'signedOut', handle: null }));
  await show(ON);
  await act(async () => { fireEvent.click(screen.getByText('Check again')); });
  expect(ipc.boardCheck).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Signed in as ada · board village')).toBeTruthy();
});

test('the board name is saved when the field is left, and blank goes back to village', async () => {
  const onChange = await show(ON);
  const name = screen.getByLabelText('Board name') as HTMLInputElement;
  fireEvent.change(name, { target: { value: ' ops ' } });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.blur(name);
  expect(onChange).toHaveBeenCalledWith({ ...ON, name: 'ops' });
  fireEvent.change(name, { target: { value: '  ' } });
  fireEvent.blur(name);
  expect(onChange).toHaveBeenLastCalledWith({ ...ON, name: 'village' });
});

test('picking a team and flipping the switches call onChange', async () => {
  const onChange = await show(ON);
  fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'acme' } });
  expect(onChange).toHaveBeenLastCalledWith({ ...ON, team: 'acme' });
  fireEvent.click(box('Share details'));
  expect(onChange).toHaveBeenLastCalledWith({ ...ON, shareDetails: false });
  fireEvent.click(box('Builders write under their own name'));
  expect(onChange).toHaveBeenLastCalledWith({ ...ON, sessionEnv: false });
  fireEvent.click(box('Share new workspaces'));
  expect(onChange).toHaveBeenLastCalledWith({ ...ON, shareNew: true });
});

test('with no team list, the team is typed', async () => {
  ipc.boardStatus.mockResolvedValue(status({ teams: [] }));
  const onChange = await show({ ...ON, team: 'acme' });
  const team = screen.getByLabelText('Team') as HTMLInputElement;
  expect(team.tagName).toBe('INPUT');
  expect(team.value).toBe('acme');
  fireEvent.change(team, { target: { value: '' } });
  fireEvent.blur(team);
  expect(onChange).toHaveBeenLastCalledWith({ ...ON, team: null });
});

test('the footer says when it last wrote and what last went wrong', async () => {
  ipc.boardStatus.mockResolvedValue(status({ lastWriteAt: Date.now() - 5 * 60_000, lastError: 'timed out' }));
  await show(ON);
  expect(screen.getByText('Last written 5m ago')).toBeTruthy();
  expect(screen.getByText('Last problem: timed out')).toBeTruthy();
});

test('the status is asked again when the board or team changes', async () => {
  const { rerender } = render(<TeamSettings board={ON} onChange={() => {}} />);
  await act(async () => {});
  expect(ipc.boardStatus).toHaveBeenCalledTimes(1);
  await act(async () => { rerender(<TeamSettings board={{ ...ON, shareDetails: false }} onChange={() => {}} />); });
  expect(ipc.boardStatus).toHaveBeenCalledTimes(1);
  await act(async () => { rerender(<TeamSettings board={{ ...ON, name: 'ops' }} onChange={() => {}} />); });
  expect(ipc.boardStatus).toHaveBeenCalledTimes(2);
});

// The workspace panel's switch.
const ws = (boardShared = false): Workspace => ({ id: 'w1', name: 'shop', path: '/w', createdAt: 0, missing: false, level: 1, xp: 0, compound: null, boardShared });

test('the share switch is hidden while the feature is off', () => {
  useApp.setState({ workspaces: [ws()], settings: { ...DEFAULT_SETTINGS, board: OFF } });
  render(<WorkspaceShare workspaceId="w1" onError={() => {}} />);
  expect(screen.queryByLabelText(/^Share on the team board/)).toBeNull();
});

test('the share switch calls setWorkspaceShared and keeps what comes back', async () => {
  useApp.setState({ workspaces: [ws()], settings: { ...DEFAULT_SETTINGS, board: ON } });
  ipc.setWorkspaceShared.mockResolvedValue(ws(true));
  render(<WorkspaceShare workspaceId="w1" onError={() => {}} />);
  expect(box('Share on the team board').checked).toBe(false);
  await act(async () => { fireEvent.click(box('Share on the team board')); });
  expect(ipc.setWorkspaceShared).toHaveBeenCalledWith('w1', true);
  expect(useApp.getState().workspaces[0].boardShared).toBe(true);
  expect(box('Share on the team board').checked).toBe(true);
});

test('a failed share puts the switch back and says why', async () => {
  useApp.setState({ workspaces: [ws()], settings: { ...DEFAULT_SETTINGS, board: ON } });
  ipc.setWorkspaceShared.mockRejectedValue('unknown workspace');
  const onError = vi.fn();
  render(<WorkspaceShare workspaceId="w1" onError={onError} />);
  await act(async () => { fireEvent.click(box('Share on the team board')); });
  expect(onError).toHaveBeenLastCalledWith('unknown workspace');
  expect(box('Share on the team board').checked).toBe(false);
});
