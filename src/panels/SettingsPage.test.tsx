import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSettings: vi.fn(async (s: unknown) => s),
  dataFolder: vi.fn().mockResolvedValue('/Users/me/Library/Application Support/app'),
  showDataFolder: vi.fn().mockResolvedValue(undefined),
  checkForUpdate: vi.fn(),
  haptic: vi.fn().mockResolvedValue(undefined),
  systemSounds: vi.fn().mockResolvedValue(['Blow', 'Hero', 'Morse']),
  playSound: vi.fn().mockResolvedValue(undefined),
  importSound: vi.fn(),
  shortcutStatus: vi.fn().mockResolvedValue({ enabled: true, taken: false }),
}));
vi.mock('../api/ipc', () => ({ ipc }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn().mockResolvedValue('0.1.0') }));
vi.mock('./AgentsStatus', () => ({ default: () => null }));
import { useApp } from '../state/store';
import SettingsPage, { DEFAULT_SETTINGS } from './SettingsPage';

beforeEach(() => {
  ipc.getSettings.mockReset().mockResolvedValue({ updatesEnabled: false });
  ipc.setSettings.mockClear();
  ipc.checkForUpdate.mockReset();
  act(() => useApp.setState({ settingsOpen: true, updateAvailable: null, covers: 0 }));
});
afterEach(() => { cleanup(); act(() => useApp.setState({ settingsOpen: false })); });

const box = (label: string) => screen.getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement;

test('shows the saved settings, filling toggles saved before they existed with their defaults', async () => {
  render(<SettingsPage />);
  expect(await screen.findByText('Version 0.1.0')).toBeTruthy();
  expect(box('Check for updates automatically').checked).toBe(false);
  expect(box('When a builder needs you').checked).toBe(true);
  expect(box('Count on the Dock icon').checked).toBe(true);
  expect(screen.getByText('/Users/me/Library/Application Support/app')).toBeTruthy();
  expect(useApp.getState().covers).toBe(1); // the village stops drawing under it
});

test('a toggle saves the whole settings', async () => {
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  await act(async () => { fireEvent.click(box('When a builder finishes')); });
  expect(ipc.setSettings).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, updatesEnabled: false, notifyFinished: false });
  expect(box('When a builder finishes').checked).toBe(false);
});

test('usage sharing is off until turned on, and turning it on saves it', async () => {
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  expect(box('Share anonymous usage').checked).toBe(false);
  await act(async () => { fireEvent.click(box('Share anonymous usage')); });
  expect(ipc.setSettings).toHaveBeenCalledWith(expect.objectContaining({ shareUsage: true }));
  expect(box('Share anonymous usage').checked).toBe(true);
});

test('day and night is on and ambience off until changed; the ambience volume shows once it is on', async () => {
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  expect(box('Day and night').checked).toBe(true);
  expect(box('Village ambience').checked).toBe(false);
  expect(screen.queryByLabelText('Ambience volume')).toBeNull();
  await act(async () => { fireEvent.click(box('Day and night')); });
  expect(ipc.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ dayNight: false }));
  await act(async () => { fireEvent.click(box('Village ambience')); });
  expect(ipc.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ ambienceOn: true }));
  await act(async () => { fireEvent.change(screen.getByLabelText('Ambience volume'), { target: { value: '30' } }); });
  expect(ipc.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ ambienceVolume: 30 }));
});

test('a failed save puts the toggle back', async () => {
  ipc.setSettings.mockRejectedValueOnce('disk full');
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  await act(async () => { fireEvent.click(box('Count on the Dock icon')); });
  expect(box('Count on the Dock icon').checked).toBe(true);
  expect(useApp.getState().error).toBe('disk full');
  act(() => useApp.getState().setError(null));
});

test('Check now reports the result and hands a found update to the toast', async () => {
  ipc.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
  ipc.checkForUpdate.mockResolvedValueOnce({ available: false }).mockResolvedValueOnce({ available: true, version: '0.2.0' }).mockRejectedValueOnce('disabled');
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  const now = screen.getByRole('button', { name: 'Check now' });
  await act(async () => { fireEvent.click(now); });
  expect(screen.getByRole('status').textContent).toBe('You have the latest version.');
  await act(async () => { fireEvent.click(now); });
  expect(useApp.getState().updateAvailable).toEqual({ version: '0.2.0', notes: null });
  await act(async () => { fireEvent.click(now); });
  expect(screen.getByRole('status').textContent).toBe('This build does not check for updates.');
});

test('Esc and ✕ close it', async () => {
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  expect(useApp.getState().settingsOpen).toBe(false);
  expect(useApp.getState().covers).toBe(0);
  act(() => useApp.setState({ settingsOpen: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }));
  expect(useApp.getState().settingsOpen).toBe(false);
});

test('the name saves on Enter, trimmed, and the plate preview follows it', async () => {
  ipc.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, playerName: 'Ada', onboarded: true });
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  const name = screen.getByLabelText('Your name') as HTMLInputElement;
  expect(name.value).toBe('Ada');
  expect(screen.getByText("Ada's Town Hall")).toBeTruthy();
  act(() => name.focus());
  fireEvent.change(name, { target: { value: '  Fabian ' } });
  expect(screen.getByText("Fabian's Town Hall")).toBeTruthy();
  await act(async () => { fireEvent.keyDown(name, { key: 'Enter' }); }); // Enter leaves the field, which saves
  expect(ipc.setSettings).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, playerName: 'Fabian', onboarded: true });
  expect(useApp.getState().settings?.playerName).toBe('Fabian');
});

test('clearing the name goes back to a plain Town Hall; an unchanged name is not saved', async () => {
  ipc.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, playerName: 'Ada' });
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  const name = screen.getByLabelText('Your name') as HTMLInputElement;
  fireEvent.change(name, { target: { value: 'Ada ' } });
  await act(async () => { fireEvent.blur(name); });
  expect(ipc.setSettings).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: '   ' } });
  await act(async () => { fireEvent.blur(name); });
  expect(ipc.setSettings).toHaveBeenCalledWith(expect.objectContaining({ playerName: null }));
  expect(screen.getByText('Town Hall')).toBeTruthy();
});

test('Replay the tour closes Settings and opens the welcome', async () => {
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  fireEvent.click(screen.getByRole('button', { name: 'Replay the tour' }));
  expect(useApp.getState().settingsOpen).toBe(false);
  const { useTour, endTour } = await import('../onboarding/tour');
  expect(useTour.getState().step).toBe('welcome');
  await act(async () => { await endTour(); });
});

test('running the pointer over a haptic pad plays the chosen feel; an Off pad plays nothing', async () => {
  ipc.getSettings.mockResolvedValue({ updatesEnabled: false, hapticHover: 'levelChange', hapticDrop: 'off' });
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  ipc.haptic.mockClear();
  const [hover, drop] = screen.getAllByText(/^(Hover to feel|Off)$/, { selector: '.set-feel' });
  fireEvent.pointerEnter(hover);
  expect(ipc.haptic).toHaveBeenCalledWith('levelChange');
  ipc.haptic.mockClear();
  fireEvent.pointerEnter(drop);
  expect(ipc.haptic).not.toHaveBeenCalled();
});

test('picking a sound saves it for that moment and plays it; ▶ plays it again; the reserve saves', async () => {
  ipc.getSettings.mockResolvedValue({ updatesEnabled: false });
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  const finished = await screen.findByLabelText('Sound: Finished') as HTMLSelectElement;
  expect(finished.value).toBe('/System/Library/Sounds/Hero.aiff'); // the default
  await screen.findAllByRole('option', { name: 'Morse' });
  ipc.playSound.mockClear();
  await act(async () => { fireEvent.change(finished, { target: { value: '/System/Library/Sounds/Blow.aiff' } }); });
  expect(ipc.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ sounds: expect.objectContaining({ finished: '/System/Library/Sounds/Blow.aiff', decide: '/System/Library/Sounds/Morse.aiff' }) }));
  expect(ipc.playSound).toHaveBeenCalledWith('/System/Library/Sounds/Blow.aiff', 70, true);
  ipc.playSound.mockClear();
  fireEvent.click(screen.getByLabelText('Play Finished'));
  expect(ipc.playSound).toHaveBeenCalledWith('/System/Library/Sounds/Blow.aiff', 70, true);
  await act(async () => { fireEvent.change(screen.getByLabelText('Hold To Dos at'), { target: { value: '20' } }); });
  expect(ipc.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ elixirReserve: 20 }));
});

test('the global shortcut has a toggle, and a note when another app holds its keys', async () => {
  ipc.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
  ipc.shortcutStatus.mockResolvedValue({ enabled: true, taken: true });
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  expect(box('⌃⌥⌘J opens your queue from any app').checked).toBe(true);
  expect(await screen.findByText('⌃⌥⌘J is taken by another app')).toBeTruthy();
  ipc.shortcutStatus.mockResolvedValue({ enabled: false, taken: false });
  await act(async () => { fireEvent.click(box('⌃⌥⌘J opens your queue from any app')); });
  expect(ipc.setSettings).toHaveBeenCalledWith(expect.objectContaining({ globalShortcut: false }));
  expect(box('⌃⌥⌘J opens your queue from any app').checked).toBe(false);
  expect(screen.queryByText('⌃⌥⌘J is taken by another app')).toBeNull();
});

test('no note about the shortcut when its keys are free', async () => {
  render(<SettingsPage />);
  await screen.findByText('Version 0.1.0');
  expect(box('⌃⌥⌘J opens your queue from any app').checked).toBe(true); // on until turned off, also for saves from before it existed
  expect(screen.queryByText('⌃⌥⌘J is taken by another app')).toBeNull();
});
