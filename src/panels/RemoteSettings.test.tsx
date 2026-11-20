import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RemoteStatus, Settings } from '../api/types';

const ipc = vi.hoisted(() => ({
  remoteStatus: vi.fn(), remoteFind: vi.fn(), remoteConnect: vi.fn(), remoteDeploy: vi.fn(), remoteDeployedVersion: vi.fn(), remoteTrust: vi.fn(),
  remotePairStart: vi.fn(), remotePairConfirm: vi.fn(), remotePairCancel: vi.fn(), remoteRemovePhone: vi.fn(),
  onRemoteChanged: vi.fn(), onRemoteProgress: vi.fn(), onSettingsChanged: vi.fn(),
}));
vi.mock('../api/ipc', () => ({ ipc }));
import RemoteSettings from './RemoteSettings';

const IDLE = { state: 'idle', code: null, until: null, name: null, check: null, why: null } as const;
const status = (s: Partial<RemoteStatus> = {}): RemoteStatus => ({ phones: [], pairing: IDLE, listening: true, paused: null, lastRefusedAt: null, keychainError: null, url: 'https://village-remote.vercel.app', bundledVersion: '0.1.0', ...s });
let push: (s: RemoteStatus) => void = () => {};
let settingsChanged: (s: Settings) => void = () => {};

beforeEach(() => {
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.remoteStatus.mockResolvedValue(status());
  ipc.remoteFind.mockResolvedValue(null);
  ipc.remoteDeployedVersion.mockResolvedValue('0.1.0');
  ipc.onRemoteChanged.mockImplementation(async (cb: (s: RemoteStatus) => void) => { push = cb; return () => {}; });
  ipc.onRemoteProgress.mockResolvedValue(() => {});
  ipc.onSettingsChanged.mockImplementation(async (cb: (s: Settings) => void) => { settingsChanged = cb; return () => {}; });
  for (const f of [ipc.remoteConnect, ipc.remoteDeploy, ipc.remoteTrust, ipc.remotePairConfirm, ipc.remotePairCancel, ipc.remoteRemovePhone]) f.mockResolvedValue(undefined);
  ipc.remotePairStart.mockResolvedValue('482913');
});
afterEach(cleanup);

const show = async (enabled = true, onEnabled = vi.fn()) => {
  await act(async () => { render(<RemoteSettings enabled={enabled} onEnabled={onEnabled} />); });
  return onEnabled;
};
const press = async (name: string | RegExp) => act(async () => { fireEvent.click(screen.getByRole('button', { name })); });

test('not set up, and the team has no remote: it offers to deploy one', async () => {
  ipc.remoteStatus.mockResolvedValue(status({ url: null }));
  await show(false);
  expect(screen.getByText('Answer your builders from your phone.')).toBeTruthy();
  await press('Deploy the remote');
  expect(ipc.remoteDeploy).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Pair a phone' })).toBeNull();
});

test('not set up, and the team has one: it offers to use it', async () => {
  ipc.remoteStatus.mockResolvedValue(status({ url: null }));
  ipc.remoteFind.mockResolvedValue('https://village-remote.vercel.app');
  await show(false);
  expect(screen.getByText(/village-remote\.vercel\.app/)).toBeTruthy();
  await press('Use the team’s remote');
  expect(ipc.remoteConnect).toHaveBeenCalledWith(null);
  expect(screen.queryByRole('button', { name: 'Deploy the remote' })).toBeNull();
});

test('an address you deployed yourself can be typed', async () => {
  ipc.remoteStatus.mockResolvedValue(status({ url: null }));
  await show(false);
  fireEvent.change(screen.getByLabelText('Use an address I deployed myself'), { target: { value: 'https://mine.example' } });
  await press('Use this address');
  expect(ipc.remoteConnect).toHaveBeenCalledWith('https://mine.example');
});

test('a failed deploy says why', async () => {
  ipc.remoteStatus.mockResolvedValue(status({ url: null }));
  ipc.remoteDeploy.mockRejectedValue('Command "npm run build" exited with 1');
  await show(false);
  await press('Deploy the remote');
  expect(screen.getByRole('alert').textContent).toContain('npm run build');
});

test('set up: the address, the switch and the phones', async () => {
  ipc.remoteStatus.mockResolvedValue(status({ phones: [{ key: 'k1', name: 'Ada’s iPhone', pairedAt: 1, lastUsed: Date.now() - 5 * 60_000 }, { key: 'k2', name: 'Pixel', pairedAt: 1, lastUsed: 0 }] }));
  const onEnabled = await show(true);
  expect(screen.getByText('https://village-remote.vercel.app')).toBeTruthy();
  expect((screen.getByLabelText(/^Phone remote/) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('Ada’s iPhone')).toBeTruthy();
  expect(screen.getByText(/used 5m ago/)).toBeTruthy();
  expect(screen.getByText(/never used/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/^Phone remote/));
  expect(onEnabled).toHaveBeenCalledWith(false);
  await press('Remove Pixel');
  expect(ipc.remoteRemovePhone).toHaveBeenCalledWith('k2');
  expect(screen.queryByRole('button', { name: 'Update the remote' })).toBeNull();
});

test('pairing shows the code and the address as a QR, then asks about the phone that answers', async () => {
  await show();
  await press('Pair a phone');
  expect(ipc.remotePairStart).toHaveBeenCalledTimes(1);
  await act(async () => push(status({ pairing: { ...IDLE, state: 'open', code: '482913', until: Date.now() + 300_000 } })));
  expect(screen.getByText('482 913')).toBeTruthy();
  expect(document.querySelector('svg.set-qr')).toBeTruthy();
  const asking = status({ pairing: { ...IDLE, state: 'asking', name: 'Ada’s iPhone', check: '792 693' } });
  ipc.remoteStatus.mockResolvedValue(asking);
  await act(async () => push(asking));
  expect(screen.getByText('Ada’s iPhone wants to pair. Does it show 792 693?')).toBeTruthy();
  await press('Confirm');
  expect(ipc.remotePairConfirm).toHaveBeenCalledTimes(1);
  await press('Cancel');
  expect(ipc.remotePairCancel).toHaveBeenCalledTimes(1);
});

test('a pairing that ended says why', async () => {
  ipc.remoteStatus.mockResolvedValue(status({ pairing: { ...IDLE, state: 'cancelled', why: 'Another device answered this pairing code. Start again.' } }));
  await show();
  expect(screen.getByText('Another device answered this pairing code. Start again.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pair a phone' })).toBeTruthy();
});

test('a remote someone else redeployed asks to be trusted', async () => {
  ipc.remoteStatus.mockResolvedValue(status({ paused: 'The remote was redeployed by bob.' }));
  await show();
  expect(screen.getByText(/The remote was redeployed by bob\. Phones cannot act until you trust it\./)).toBeTruthy();
  await press('Trust it');
  expect(ipc.remoteTrust).toHaveBeenCalledTimes(1);
});

test('trouble is said in place', async () => {
  ipc.remoteStatus.mockResolvedValue(status({ keychainError: 'the Keychain is locked', lastRefusedAt: Date.now() - 60_000, listening: false }));
  await show();
  expect(screen.getByText('the Keychain is locked')).toBeTruthy();
  expect(screen.getByText(/Something that is not a paired phone tried to act/)).toBeTruthy();
  expect(screen.getByText(/Not listening/)).toBeTruthy();
});

test('settings the app changed itself reach the window’s copy', async () => {
  const { useApp } = await import('../state/store');
  const { DEFAULT_SETTINGS } = await import('../state/settings');
  await show();
  const changed = { ...DEFAULT_SETTINGS, board: { ...DEFAULT_SETTINGS.board!, remote: { enabled: true, url: 'https://village-remote.vercel.app', trusted: ['d1'], paused: null } } };
  act(() => settingsChanged(changed));
  expect(useApp.getState().settings?.board?.remote?.enabled).toBe(true);
});

test('a newer bundled remote offers an update', async () => {
  ipc.remoteStatus.mockResolvedValue(status({ bundledVersion: '0.2.0' }));
  await show();
  await press('Update the remote');
  expect(ipc.remoteDeploy).toHaveBeenCalledTimes(1);
});
