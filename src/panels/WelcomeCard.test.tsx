import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../state/workspaceActions', () => ({ openFolder: vi.fn(), createFolder: vi.fn() }));
import * as wsActions from '../state/workspaceActions';
import { useApp } from '../state/store';
import WelcomeCard from './WelcomeCard';
import BuildersBar from '../hud/BuildersBar';

const ws = { id: 'w', name: 'proj', path: '/p', createdAt: 0, missing: false, level: 1, xp: 0, compound: null };
beforeEach(() => { vi.mocked(wsActions.openFolder).mockReset(); act(() => useApp.setState({ workspaces: [], builders: [], sessions: {} })); });
afterEach(cleanup);

test('welcome_shows_only_without_workspaces', () => {
  const { container } = render(<WelcomeCard />);
  expect(screen.getByText('Open a folder to start')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));
  expect(wsActions.openFolder).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy();
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
