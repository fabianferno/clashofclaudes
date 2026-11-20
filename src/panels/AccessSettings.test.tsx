import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AccessStatus, Workspace } from '../api/types';

const ipc = vi.hoisted(() => ({ accessStatus: vi.fn(), accessSetPrivate: vi.fn(), accessPutBack: vi.fn(), invitePut: vi.fn(), inviteRemove: vi.fn() }));
vi.mock('../api/ipc', () => ({ ipc }));
import AccessSettings from './AccessSettings';
import { useApp } from '../state/store';

const status = (s: Partial<AccessStatus> = {}): AccessStatus => ({ state: 'closed', canClose: true, refused: null, command: null, who: ['You'], drift: null, invites: [], ...s });
const ws = (id: string, name: string, boardShared: boolean): Workspace => ({ id, name, path: '/w', createdAt: 0, missing: false, level: 1, xp: 0, compound: null, boardShared });

beforeEach(() => {
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.accessStatus.mockResolvedValue(status());
  useApp.setState({ workspaces: [ws('w1', 'shop', true), ws('w2', 'api', true), ws('w3', 'private', false)] });
});
afterEach(cleanup);

const show = async () => act(async () => { render(<AccessSettings />); });
const press = async (name: string | RegExp) => act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
const box = () => screen.getByLabelText(/^Private village/) as HTMLInputElement;

test('the switch shows what the board says, and who can see the village', async () => {
  ipc.accessStatus.mockResolvedValue(status({ who: ['You', 'bob@acme.com', 'The phone remote, and whoever can deploy it'] }));
  await show();
  expect(box().checked).toBe(true);
  const who = screen.getByRole('list', { name: 'Who can see this village now' });
  expect(within(who).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['You', 'bob@acme.com', 'The phone remote, and whoever can deploy it']);
});

test('turning it off asks the board, and the switch follows the answer, not the click', async () => {
  await show();
  // the board could not open it: still closed
  ipc.accessSetPrivate.mockResolvedValue(status({ state: 'closed' }));
  await act(async () => { fireEvent.click(box()); });
  expect(ipc.accessSetPrivate).toHaveBeenCalledWith(false);
  expect(box().checked).toBe(true);
  ipc.accessSetPrivate.mockResolvedValue(status({ state: 'open', who: ['Everyone on your Vercel team, and every project\'s deployments'] }));
  await act(async () => { fireEvent.click(box()); });
  expect(box().checked).toBe(false);
  expect(screen.getByText(/Everyone on your Vercel team/)).toBeTruthy();
});

test('not a team owner: the switch is read-only, with the command for an owner', async () => {
  ipc.accessStatus.mockResolvedValue(status({ state: 'open', canClose: false, refused: 'Only a team owner can close a channel to everyone.', command: 'vercel board grants create --everyone', who: ['Everyone on your Vercel team, and every project\'s deployments'] }));
  await show();
  expect(box().disabled).toBe(true);
  expect(screen.getByText(/Only an owner of your Vercel team can close a village\. Until one does, everyone on the team can see yours\./)).toBeTruthy();
  expect(screen.getByText('vercel board grants create --everyone')).toBeTruthy();
  expect(screen.getByText(/The board said: Only a team owner can close a channel to everyone\./)).toBeTruthy();
  ipc.accessSetPrivate.mockResolvedValue(status());
  await press('Check again');
  expect(ipc.accessSetPrivate).toHaveBeenCalledWith(true);
});

test('once an owner has closed it for you, it says closed and not that everyone can see it', async () => {
  ipc.accessStatus.mockResolvedValue(status({ state: 'closed', canClose: false, refused: 'x', command: 'cmd' }));
  await show();
  expect(box().checked).toBe(true);
  expect(screen.queryByText(/everyone on the team can see yours/)).toBeNull();
  expect(screen.getByText(/Only an owner of your Vercel team can open it again/)).toBeTruthy();
});

test('an invite cannot be changed twice at once', async () => {
  const one = status({ invites: [{ email: 'bob@acme.com', level: 'visitor', workspaces: null, onBoard: true }] });
  ipc.accessStatus.mockResolvedValue(one);
  await show();
  ipc.invitePut.mockReturnValue(new Promise(() => {}));
  fireEvent.change(screen.getByLabelText('Level for bob@acme.com'), { target: { value: 'helper' } });
  await act(async () => {});
  expect((screen.getByLabelText('Level for bob@acme.com') as HTMLSelectElement).disabled).toBe(true);
});

test('what is not as you set it is said, with a way to put it back', async () => {
  ipc.accessStatus.mockResolvedValue(status({ state: 'open', drift: 'Your village is open to the team again.' }));
  await show();
  expect(screen.getByRole('alert').textContent).toContain('Your village is open to the team again.');
  ipc.accessPutBack.mockResolvedValue(status());
  await press('Put it back');
  expect(ipc.accessPutBack).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('inviting someone by email, with a level and all or some workspaces', async () => {
  await show();
  const add = screen.getByRole('button', { name: 'Invite' }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Their Vercel email'), { target: { value: 'bob@acme.com' } });
  fireEvent.change(screen.getByLabelText('Level for a new invite'), { target: { value: 'helper' } });
  ipc.invitePut.mockResolvedValue(status({ invites: [{ email: 'bob@acme.com', level: 'helper', workspaces: null, onBoard: true }] }));
  await press('Invite');
  expect(ipc.invitePut).toHaveBeenCalledWith('bob@acme.com', 'helper', null);
  expect(screen.getByText('bob@acme.com')).toBeTruthy();
  // only shared workspaces can be chosen
  fireEvent.change(screen.getByLabelText('Their Vercel email'), { target: { value: 'carol@acme.com' } });
  fireEvent.click(screen.getByLabelText('Only some workspaces'));
  expect(screen.queryByLabelText('private')).toBeNull();
  fireEvent.click(screen.getByLabelText('api'));
  ipc.invitePut.mockResolvedValue(status());
  await press('Invite');
  expect(ipc.invitePut).toHaveBeenLastCalledWith('carol@acme.com', 'visitor', ['w2']);
});

test('an invite can be changed and removed, and says what it is until their Mac is paired', async () => {
  const two = status({ invites: [{ email: 'bob@acme.com', level: 'trusted', workspaces: ['w1'], onBoard: true }, { email: 'eve@acme.com', level: 'visitor', workspaces: null, onBoard: false }] });
  ipc.accessStatus.mockResolvedValue(two);
  await show();
  expect(screen.getByText(/shop only/)).toBeTruthy();
  expect(screen.getByText(/A Visitor until their Mac is paired/)).toBeTruthy();
  expect(screen.getByText(/Not on the board/)).toBeTruthy();
  ipc.invitePut.mockResolvedValue(two);
  fireEvent.change(screen.getByLabelText('Level for bob@acme.com'), { target: { value: 'visitor' } });
  await act(async () => {});
  expect(ipc.invitePut).toHaveBeenCalledWith('bob@acme.com', 'visitor', ['w1']);
  ipc.inviteRemove.mockResolvedValue(status());
  await press('Remove eve@acme.com');
  expect(ipc.inviteRemove).toHaveBeenCalledWith('eve@acme.com');
});

test('what the board answers to an invite is shown', async () => {
  await show();
  fireEvent.change(screen.getByLabelText('Their Vercel email'), { target: { value: 'nobody@elsewhere.com' } });
  ipc.invitePut.mockRejectedValue('nobody@elsewhere.com is not on this team.');
  await press('Invite');
  expect(screen.getByRole('alert').textContent).toContain('is not on this team');
});

test('grants that could not be read say so', async () => {
  ipc.accessStatus.mockResolvedValue(status({ state: 'unknown', who: [] }));
  await show();
  expect(screen.getByText(/could not be read/)).toBeTruthy();
});
