import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSettings: vi.fn(async (s: unknown) => s),
  dataFolder: vi.fn().mockResolvedValue('/Users/me/Library/Application Support/app'),
  showDataFolder: vi.fn().mockResolvedValue(undefined),
  checkForUpdate: vi.fn(),
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
  act(() => useApp.setState({ settingsOpen: true, updateAvailable: false, covers: 0 }));
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
  expect(useApp.getState().updateAvailable).toBe(true);
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
