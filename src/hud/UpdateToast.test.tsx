import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  restartForUpdate: vi.fn(),
  onUpdateProgress: vi.fn(),
}));
let progress: (pct: number | null) => void = () => {};
vi.mock('../api/ipc', () => ({ ipc }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn().mockResolvedValue('1.2.0') }));
import UpdateToast, { FIRST_CHECK_MS, CHECK_EVERY_MS, INSTALLING_KEY } from './UpdateToast';
import { useApp } from '../state/store';

beforeEach(() => {
  vi.useFakeTimers();
  ipc.checkForUpdate.mockReset().mockResolvedValue({ available: false });
  ipc.installUpdate.mockReset().mockResolvedValue(undefined);
  ipc.restartForUpdate.mockReset().mockResolvedValue(undefined);
  ipc.onUpdateProgress.mockReset().mockImplementation((cb: (pct: number | null) => void) => { progress = cb; return Promise.resolve(() => {}); });
  act(() => { useApp.getState().setError(null); useApp.getState().setUpdateAvailable(null); });
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

test('checks 10 s after start, then every 6 h', async () => {
  render(<UpdateToast />);
  await act(async () => { vi.advanceTimersByTime(FIRST_CHECK_MS - 1); });
  expect(ipc.checkForUpdate).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(CHECK_EVERY_MS); });
  expect(ipc.checkForUpdate).toHaveBeenCalledTimes(2);
});

test('update_check_failure_is_silent_in_ui', async () => {
  ipc.checkForUpdate.mockRejectedValue('disabled');
  render(<UpdateToast />);
  await act(async () => { vi.advanceTimersByTime(FIRST_CHECK_MS); });
  await flush();
  expect(screen.queryByTestId('update-toast')).toBeNull();
  expect(useApp.getState().error).toBeNull();
});

test('toast_restart_runs_quit_guard: click installs via the backend (which asks before restarting)', async () => {
  ipc.checkForUpdate.mockResolvedValue({ available: true, version: '1.2.0' });
  render(<UpdateToast />);
  await act(async () => { vi.advanceTimersByTime(FIRST_CHECK_MS); });
  await flush();
  expect(screen.getByTestId('update-toast').textContent).toContain('Version 1.2.0 is out — Restart to update');
  fireEvent.click(screen.getByTestId('update-restart'));
  expect(ipc.installUpdate).toHaveBeenCalledTimes(1);
});

test('toast is dismissible and install failure is silent', async () => {
  ipc.checkForUpdate.mockResolvedValue({ available: true, version: '1.2.0' });
  ipc.installUpdate.mockRejectedValue('update failed');
  render(<UpdateToast />);
  await act(async () => { vi.advanceTimersByTime(FIRST_CHECK_MS); });
  await flush();
  fireEvent.click(screen.getByTestId('update-restart'));
  await flush();
  expect(useApp.getState().error).toBeNull();
  fireEvent.click(screen.getByLabelText('Dismiss update notice'));
  expect(screen.queryByTestId('update-toast')).toBeNull();
});

test('installing shows progress, guards double clicks, then offers a restart (restart cancelled)', async () => {
  ipc.checkForUpdate.mockResolvedValue({ available: true, version: '1.2.0' });
  let done: () => void = () => {};
  ipc.installUpdate.mockReturnValue(new Promise<void>((r) => { done = r; }));
  render(<UpdateToast />);
  await act(async () => { vi.advanceTimersByTime(FIRST_CHECK_MS); });
  await flush();
  const btn = screen.getByTestId('update-restart');
  fireEvent.click(btn);
  fireEvent.click(btn);
  expect(ipc.installUpdate).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('update-progress').textContent).toBe('Downloading update…');
  act(() => progress(42));
  expect(screen.getByTestId('update-progress').textContent).toBe('Downloading update… 42%');
  await act(async () => { done(); });
  await flush();
  expect(screen.getByTestId('update-toast').textContent).toContain('Update installed — Restart now');
  fireEvent.click(screen.getByTestId('update-restart'));
  expect(ipc.restartForUpdate).toHaveBeenCalledTimes(1);
  expect(ipc.installUpdate).toHaveBeenCalledTimes(1);
  // A later check that still sees the update keeps the restart button (no second download).
  await act(async () => { vi.advanceTimersByTime(CHECK_EVERY_MS); });
  await flush();
  expect(screen.getByTestId('update-toast').textContent).toContain('Restart now');
});

test('a failed install re-enables the button', async () => {
  ipc.checkForUpdate.mockResolvedValue({ available: true, version: '1.2.0' });
  ipc.installUpdate.mockRejectedValue('update failed');
  render(<UpdateToast />);
  await act(async () => { vi.advanceTimersByTime(FIRST_CHECK_MS); });
  await flush();
  fireEvent.click(screen.getByTestId('update-restart'));
  await flush();
  expect(screen.getByTestId('update-toast').textContent).toContain('Restart to update');
  fireEvent.click(screen.getByTestId('update-restart'));
  expect(ipc.installUpdate).toHaveBeenCalledTimes(2);
});

test('the toast names the version and folds out its notes; installing leaves a note for after the restart', async () => {
  ipc.checkForUpdate.mockResolvedValue({ available: true, version: '1.2.0', notes: '- Feature requests\n- Faster boards' });
  ipc.installUpdate.mockReturnValue(new Promise<void>(() => {}));
  render(<UpdateToast />);
  await act(async () => { vi.advanceTimersByTime(FIRST_CHECK_MS); });
  await flush();
  expect(screen.queryByTestId('update-notes')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: "What's new" }));
  expect(screen.getByTestId('update-notes').textContent).toBe('- Feature requests\n- Faster boards');
  fireEvent.click(screen.getByTestId('update-restart'));
  expect(JSON.parse(localStorage.getItem(INSTALLING_KEY)!)).toEqual({ version: '1.2.0', notes: '- Feature requests\n- Faster boards' });
});

test('after the restart it says once what was installed, and nothing when the install never landed', async () => {
  localStorage.setItem(INSTALLING_KEY, JSON.stringify({ version: '1.2.0', notes: '- Feature requests' }));
  render(<UpdateToast />);
  await flush();
  expect(screen.getByTestId('update-done').textContent).toContain('Updated to 1.2.0');
  expect(localStorage.getItem(INSTALLING_KEY)).toBeNull();
  fireEvent.click(screen.getByLabelText('Dismiss update notice'));
  expect(screen.queryByTestId('update-done')).toBeNull();

  cleanup();
  localStorage.setItem(INSTALLING_KEY, JSON.stringify({ version: '9.9.9', notes: null }));
  render(<UpdateToast />);
  await flush();
  expect(screen.queryByTestId('update-done')).toBeNull();
  expect(localStorage.getItem(INSTALLING_KEY)).toBeNull();
});
