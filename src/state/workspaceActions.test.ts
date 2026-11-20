import { beforeEach, expect, test, vi } from 'vitest';

const open = vi.hoisted(() => vi.fn());
const createWorkspace = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }));
vi.mock('../api/ipc', () => ({ ipc: { createWorkspace } }));
import { createFolder } from './workspaceActions';
import { useApp } from './store';

const ws = { id: 'w', name: 'app', path: '/x/app', createdAt: 0, missing: false, compound: null };
beforeEach(() => {
  open.mockReset();
  createWorkspace.mockReset().mockResolvedValue(ws);
  useApp.setState({ workspaces: [], error: null });
});

test('a new folder goes in the default projects folder without a picker', async () => {
  expect(await createFolder(' app ')).toBe(true);
  expect(open).not.toHaveBeenCalled();
  expect(createWorkspace).toHaveBeenCalledWith(null, 'app');
  expect(useApp.getState().workspaces).toEqual([ws]);
});

test('choosing a location uses the picked parent; cancelling creates nothing', async () => {
  open.mockResolvedValueOnce('/picked');
  expect(await createFolder('app', true)).toBe(true);
  expect(createWorkspace).toHaveBeenCalledWith('/picked', 'app');
  open.mockResolvedValueOnce(null);
  expect(await createFolder('other', true)).toBe(false);
  expect(createWorkspace).toHaveBeenCalledTimes(1);
});
