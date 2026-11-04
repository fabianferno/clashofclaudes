import { beforeEach, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ getSettings: vi.fn(), setSettings: vi.fn() }));
vi.mock('../api/ipc', () => ({ ipc }));
import { useApp } from './store';
import { DEFAULT_SETTINGS, PLAYER_NAME_MAX, cleanName, loadSettings, saveSettings, townHallTitle } from './settings';

beforeEach(() => {
  ipc.getSettings.mockReset();
  ipc.setSettings.mockReset().mockImplementation(async (s: unknown) => s);
  useApp.setState({ settings: null });
});

test('names are trimmed, capped by code point and blank is no name', () => {
  expect(cleanName('  Fabian  ')).toBe('Fabian');
  expect(cleanName('   ')).toBeNull();
  expect(cleanName(null)).toBeNull();
  expect(Array.from(cleanName('🏰'.repeat(40))!)).toHaveLength(PLAYER_NAME_MAX); // never half an emoji
});

test("the hall is the owner's, or just the Town Hall", () => {
  expect(townHallTitle('Fabian')).toBe("Fabian's Town Hall");
  expect(townHallTitle(' Ada ')).toBe("Ada's Town Hall");
  expect(townHallTitle('')).toBe('Town Hall');
  expect(townHallTitle(null)).toBe('Town Hall');
});

test('loading fills fields saved before they existed with their defaults', async () => {
  ipc.getSettings.mockResolvedValue({ updatesEnabled: false });
  const s = await loadSettings();
  expect(s).toEqual({ ...DEFAULT_SETTINGS, updatesEnabled: false });
  expect(s.onboarded).toBe(false);
  expect(useApp.getState().settings).toEqual(s);
});

test('saving shows at once, sends the whole struct and keeps what the backend made of it', async () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, dockBadge: false } });
  let resolve: (s: unknown) => void = () => {};
  ipc.setSettings.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const p = saveSettings({ playerName: ' Fabian ' });
  expect(useApp.getState().settings?.playerName).toBe(' Fabian '); // the hall's plate follows at once
  expect(ipc.setSettings).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, dockBadge: false, playerName: ' Fabian ' });
  resolve({ ...DEFAULT_SETTINGS, dockBadge: false, playerName: 'Fabian' });
  await p;
  expect(useApp.getState().settings).toEqual({ ...DEFAULT_SETTINGS, dockBadge: false, playerName: 'Fabian' });
});

test('a failed save puts the store back and rethrows', async () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, playerName: 'Ada' } });
  ipc.setSettings.mockRejectedValueOnce('disk full');
  await expect(saveSettings({ playerName: 'Bob' })).rejects.toBe('disk full');
  expect(useApp.getState().settings?.playerName).toBe('Ada');
});

test('two saves in a row keep both changes', async () => {
  useApp.setState({ settings: DEFAULT_SETTINGS });
  await Promise.all([saveSettings({ playerName: 'Ada' }), saveSettings({ onboarded: true })]);
  expect(ipc.setSettings).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, playerName: 'Ada', onboarded: true });
  expect(useApp.getState().settings).toMatchObject({ playerName: 'Ada', onboarded: true });
});
