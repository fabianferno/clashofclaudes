import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ visit: vi.fn(), borrowRequests: vi.fn(), borrowAccept: vi.fn(), borrowDecline: vi.fn(), lentSessions: vi.fn(), lentPush: vi.fn(), onBorrowChanged: vi.fn(), onBorrowKept: vi.fn(), borrowed: vi.fn(), borrowSent: vi.fn(), onVisitsChanged: vi.fn() }));
vi.mock('../api/ipc', () => ({ ipc }));
import BorrowDesk from './BorrowDesk';
import { useApp } from '../state/store';

let changed: () => void = () => {};
let kept: (n: string) => void = () => {};
const request = { id: 'msg_q1', who: 'bob', builder: 'Wizard', workspace: 'shop', task: 'Add a CSV export\nwith a header row', until: Date.now() + 20 * 60_000 };

beforeEach(() => {
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.borrowRequests.mockResolvedValue([]);
  ipc.lentSessions.mockResolvedValue([]);
  ipc.borrowed.mockResolvedValue([]);
  ipc.borrowSent.mockResolvedValue([]);
  ipc.onBorrowChanged.mockImplementation(async (cb: () => void) => { changed = cb; return () => {}; });
  ipc.onBorrowKept.mockImplementation(async (cb: (n: string) => void) => { kept = cb; return () => {}; });
  ipc.onVisitsChanged.mockResolvedValue(() => {});
  ipc.visit.mockResolvedValue(null);
  useApp.setState({ error: null, visiting: null, visitedSession: null });
});
afterEach(cleanup);

const show = async () => act(async () => { render(<BorrowDesk />); });

test('with nothing borrowed or asked there is nothing to show', async () => {
  await show();
  expect(screen.queryByRole('region')).toBeNull();
});

test('a request waiting for the lender shows who, what, where, the whole task, Accept and Decline', async () => {
  ipc.borrowRequests.mockResolvedValue([request]);
  await show();
  expect(screen.getByText('bob asks to borrow Wizard in shop')).toBeTruthy();
  expect(screen.getByText(/Add a CSV export\s+with a header row/)).toBeTruthy();
  ipc.borrowAccept.mockResolvedValue([]);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Accept' })); });
  expect(ipc.borrowAccept).toHaveBeenCalledWith('msg_q1');
  expect(screen.queryByText('bob asks to borrow Wizard in shop')).toBeNull();
});

test('decline, and the list follows what the app says', async () => {
  ipc.borrowRequests.mockResolvedValue([request]);
  await show();
  ipc.borrowDecline.mockResolvedValue([]);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Decline' })); });
  expect(ipc.borrowDecline).toHaveBeenCalledWith('msg_q1');
  ipc.borrowRequests.mockResolvedValue([request]);
  await act(async () => changed());
  expect(screen.getByText('bob asks to borrow Wizard in shop')).toBeTruthy();
});

test('a lent session says who it works for, and an unpushed branch can be pushed again', async () => {
  ipc.lentSessions.mockResolvedValue([{ session: 's1', key: 'k', handle: 'bob', branch: 'borrow/bob/x-ab12', request: 'msg_q1', pushed: false, pushError: 'origin could not be reached', worktree: '/wt', repo: '/r' }]);
  await show();
  expect(screen.getByText(/Working for bob on borrow\/bob\/x-ab12/)).toBeTruthy();
  expect(screen.getByText(/Not pushed yet: origin could not be reached/)).toBeTruthy();
  ipc.lentPush.mockResolvedValue([]);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Push again' })); });
  expect(ipc.lentPush).toHaveBeenCalledWith('s1');
});

test('a worktree kept after a close is said', async () => {
  await show();
  await act(async () => kept('Its worktree was kept, with work that is not on origin: /wt/x'));
  expect(useApp.getState().error).toBe('Its worktree was kept, with work that is not on origin: /wt/x');
});

test('the borrower sees their borrowed builders and their requests, and opens one', async () => {
  ipc.borrowed.mockResolvedValue([{ owner: 'ada', session: 's1', root: 'msg_1', builder: 'Wizard', workspace: 'shop', state: 'needs_you', wait: 'answer' }, { owner: 'ada', session: 's2', root: 'msg_2', builder: 'Archer', workspace: 'api', state: 'finished', wait: 'review' }]);
  ipc.borrowSent.mockResolvedValue([{ owner: 'ada', request: 'msg_q', builder: 'Giant', workspace: 'shop', task: 'Fix the login', at: 1, result: 'waiting', why: null }, { owner: 'ada', request: 'msg_r', builder: 'Giant', workspace: 'shop', task: 'Fix', at: 2, result: 'refused', why: 'that builder is not lent to you' }]);
  await show();
  expect(screen.getByText(/Wizard · ada’s · shop/)).toBeTruthy();
  expect(screen.getByText('Asking you')).toBeTruthy();
  expect(screen.getByText('Finished: press Done when you have the branch')).toBeTruthy();
  expect(screen.getByText(/Giant · ada’s · Waiting for ada to accept/)).toBeTruthy();
  expect(screen.getByText(/ada’s Mac refused it: that builder is not lent to you/)).toBeTruthy();
  ipc.borrowed.mockResolvedValue([]);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Wizard · ada’s · shop/ })); });
  expect(useApp.getState().visitedSession).toBe('s1');
  expect(useApp.getState().borrowedFrom).toBe('ada');
});
