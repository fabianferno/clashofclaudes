import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../state/workspaceActions', () => ({ openFolder: vi.fn(), createFolder: vi.fn(), DEFAULT_PARENT_LABEL: 'Documents/.clashofclaudes' }));
import * as wsActions from '../state/workspaceActions';
import { useApp } from '../state/store';
import WelcomeCard from './WelcomeCard';
import BuildersBar from '../hud/BuildersBar';

const ws = { id: 'w', name: 'proj', path: '/p', createdAt: 0, missing: false, compound: null };
beforeEach(() => { vi.mocked(wsActions.openFolder).mockReset(); act(() => useApp.setState({ loaded: true, workspaces: [], builders: [], sessions: {} })); });
afterEach(cleanup);

test('welcome_shows_only_without_workspaces', () => {
  const { container } = render(<WelcomeCard />);
  expect(screen.getByText('Open a workspace to start')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }));
  expect(wsActions.openFolder).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'New workspace' })).toBeTruthy();
  act(() => useApp.setState({ workspaces: [ws] }));
  expect(container.textContent).toBe('');
});

test('welcome_is_not_modal', () => {
  const { container } = render(<><WelcomeCard /><BuildersBar /></>);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(container.querySelector('[aria-modal], .modal-bg, .backdrop')).toBeNull();
  const tab = screen.getByRole('button', { name: /Builders/ });
  fireEvent.click(tab);
  expect(screen.getByTestId('builders-bar').className).toContain('collapsed');
  // the layer around the card lets pointer events through to the village
  expect((container.querySelector('[data-testid="welcome-card"]')!.parentElement as HTMLElement).style.pointerEvents).toBe('none');
});

test('welcome_waits_for_hydrate', () => {
  act(() => useApp.setState({ loaded: false, workspaces: [] }));
  const { container } = render(<WelcomeCard />);
  expect(container.textContent).toBe('');
  act(() => useApp.getState().hydrate({ workspaces: [], builders: [], sessions: [], stats: { shippedTotal: 0, recentShips: [] } }));
  expect(screen.getByText('Open a workspace to start')).toBeTruthy();
  act(() => useApp.getState().hydrate({ workspaces: [ws], builders: [], sessions: [], stats: { shippedTotal: 0, recentShips: [] } }));
  expect(container.textContent).toBe('');
});

test('a failed first load still shows the welcome card', () => {
  act(() => useApp.setState({ loaded: false, workspaces: [] }));
  render(<WelcomeCard />);
  act(() => useApp.getState().markLoaded());
  expect(screen.getByText('Open a workspace to start')).toBeTruthy();
});

test('the typed folder name survives a cancelled picker and clears once created', async () => {
  const created = vi.mocked(wsActions.createFolder);
  created.mockResolvedValueOnce(false);
  render(<WelcomeCard />);
  fireEvent.click(screen.getByRole('button', { name: 'New workspace' }));
  fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'app' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose location…' })); });
  expect(created).toHaveBeenLastCalledWith('app', true);
  expect((screen.getByLabelText('Workspace name') as HTMLInputElement).value).toBe('app');
  created.mockResolvedValueOnce(true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
  expect(screen.queryByLabelText('Workspace name')).toBeNull();
  expect(created).toHaveBeenLastCalledWith('app', false);
});

test('welcome_card_steps_aside_while_the_tour_runs', async () => {
  const { useTour } = await import('../onboarding/tour');
  act(() => useTour.setState({ step: 'welcome' }));
  const { container } = render(<WelcomeCard />);
  expect(container.textContent).toBe('');
  act(() => useTour.setState({ step: null }));
  expect(screen.getByText('Open a workspace to start')).toBeTruthy();
});
