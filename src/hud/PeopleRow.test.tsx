import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { VillageMap, VisitView } from '../api/types';

const ipc = vi.hoisted(() => ({ visits: vi.fn(), visit: vi.fn(), visitsRefresh: vi.fn(), visitBuilder: vi.fn(), onVisitsChanged: vi.fn() }));
vi.mock('../api/ipc', () => ({ ipc }));
import PeopleRow from './PeopleRow';
import VisitedBuilder from '../panels/VisitedBuilder';
import { useApp } from '../state/store';

const view = (owner: string, over: Partial<VisitView> = {}): VisitView => ({ owner, name: owner[0].toUpperCase() + owner.slice(1), waiting: 0, away: false, seen: 1, ...over });
const mapOf = (owner: string): VillageMap => ({ v: 1, host: 'h', owner, name: 'Ada', seen: 1, workspaces: [], builders: [], sessions: [{ i: 's1', r: 'msg_1', w: 'api', b: 'wizard', s: 'needs_you', t: 'answer', n: 1, a: 1, k: 0 }] });
let push: (v: VisitView[]) => void = () => {};

beforeEach(() => {
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.visits.mockResolvedValue([]);
  ipc.visit.mockImplementation(async (owner: string) => mapOf(owner));
  ipc.onVisitsChanged.mockImplementation(async (cb: (v: VisitView[]) => void) => { push = cb; return () => {}; });
  useApp.setState({ visits: [], visiting: null, visitedSession: null, error: null });
});
afterEach(cleanup);

const show = async () => act(async () => { render(<PeopleRow />); });

test('with no village to visit there is no row', async () => {
  await show();
  expect(screen.queryByRole('navigation', { name: 'Villages' })).toBeNull();
});

test('a chip per village, with how many wait there and whether its Mac is away', async () => {
  ipc.visits.mockResolvedValue([view('ada', { waiting: 2 }), view('bob', { away: true })]);
  await show();
  expect(screen.getByRole('button', { name: 'ada, 2 waiting' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'bob, away' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Home' }).getAttribute('aria-pressed')).toBe('true');
});

test('a village is named by its owner’s Vercel handle, whatever they call themselves', async () => {
  // anyone can call themselves Ada in their own village; the handle is what the board verified
  ipc.visits.mockResolvedValue([view('mallory', { name: 'Ada' })]);
  await show();
  expect(screen.getByRole('button', { name: 'mallory' })).toBeTruthy();
  expect(screen.queryByText('Ada')).toBeNull();
});

test('visiting draws that village, says whose it is, and Home comes back', async () => {
  ipc.visits.mockResolvedValue([view('ada', { waiting: 1 })]);
  await show();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ada, 1 waiting' })); });
  expect(ipc.visit).toHaveBeenCalledWith('ada');
  expect(useApp.getState().visiting?.owner).toBe('ada');
  expect(screen.getByText('Visiting ada’s village · you are a Visitor here')).toBeTruthy();
  expect(useApp.getState().selection).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Home' })); });
  expect(useApp.getState().visiting).toBeNull();
  expect(screen.queryByText(/Visiting/)).toBeNull();
});

test('a visited village is redrawn when its map changes, and says when its Mac is away', async () => {
  ipc.visits.mockResolvedValue([view('ada')]);
  await show();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ada' })); });
  ipc.visit.mockClear();
  await act(async () => push([view('ada', { waiting: 3, away: true, seen: 2 })]));
  expect(ipc.visit).toHaveBeenCalledWith('ada');
  expect(screen.getByText('ada’s Mac may be asleep or offline.')).toBeTruthy();
});

test('a village you can no longer see sends you Home and says why', async () => {
  ipc.visits.mockResolvedValue([view('ada')]);
  await show();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ada' })); });
  await act(async () => push([]));
  expect(useApp.getState().visiting).toBeNull();
  expect(useApp.getState().error).toBe('You can no longer see ada’s village.');
});

test('a visited builder shows what it does and waits for, and nothing to press', async () => {
  useApp.setState({ visiting: { owner: 'ada', map: mapOf('ada') }, visitedSession: 's1' });
  ipc.visitBuilder.mockResolvedValue({ title: '**Wizard** (Claude Code): add a CSV export', wait: 'answer', words: 'Asking you: Which database?', question: 'Which database?', options: ['sqlite', 'postgres'] });
  await act(async () => { render(<VisitedBuilder />); });
  expect(ipc.visitBuilder).toHaveBeenCalledWith('ada', 'msg_1');
  expect(screen.getByText('Wizard')).toBeTruthy();
  expect(screen.getByText(/add a CSV export/)).toBeTruthy();
  expect(screen.getByText('Which database?')).toBeTruthy();
  expect(screen.getByText('sqlite')).toBeTruthy();
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })); });
  expect(useApp.getState().visitedSession).toBeNull();
});

test('a visited builder you were not invited to see says so', async () => {
  useApp.setState({ visiting: { owner: 'ada', map: mapOf('ada') }, visitedSession: 's1' });
  ipc.visitBuilder.mockRejectedValue('no access');
  await act(async () => { render(<VisitedBuilder />); });
  expect(screen.getByText(/You were not invited to this workspace/)).toBeTruthy();
});
