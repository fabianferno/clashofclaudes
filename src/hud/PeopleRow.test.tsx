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
  ipc.visitBuilder.mockResolvedValue({ title: '**Wizard** (Claude Code): add a CSV export', wait: 'answer', words: 'Asking you: Which database?', question: 'Which database?', options: ['sqlite', 'postgres'], can: ['answer'], prompt: 'p', sent: false, result: null });
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

// Part 2: acting in a village you visit.
const act2 = vi.hoisted(() => ({ mateKey: vi.fn(), matePair: vi.fn(), visitAct: vi.fn() }));
Object.assign(ipc, act2);
beforeEach(() => {
  act2.mateKey.mockResolvedValue(null);
  act2.visitAct.mockResolvedValue(undefined);
});

const withMate = (level: 'helper' | 'trusted'): VillageMap => ({ ...mapOf('ada'), mates: [{ key: 'k_me', handle: 'me', level }] });
const waiting = (over: object = {}) => ({ title: '**Wizard** (Claude Code): add a CSV export', wait: 'decide', words: 'Wants a decision: `Bash: npm test`', question: 'Bash: npm test', options: null, can: ['allow', 'deny'], prompt: 'ab'.repeat(32), sent: false, result: null, ...over });

test('the ribbon says your level there once the village has paired this Mac', async () => {
  ipc.visits.mockResolvedValue([view('ada')]);
  act2.mateKey.mockResolvedValue('k_me');
  ipc.visit.mockResolvedValue(withMate('trusted'));
  await show();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ada' })); });
  expect(screen.getByText('Visiting ada’s village · you are Trusted here')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Enter pairing code' })).toBeNull();
});

test('a village that has not paired this Mac takes a pairing code, and shows the number to read back', async () => {
  ipc.visits.mockResolvedValue([view('ada')]);
  await show();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ada' })); });
  expect(screen.getByText('Visiting ada’s village · you are a Visitor here')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enter pairing code' })); });
  fireEvent.change(screen.getByLabelText('Pairing code from ada'), { target: { value: '0000-0000-eqk1' } });
  act2.matePair.mockResolvedValue('482 913');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pair this Mac' })); });
  expect(act2.matePair).toHaveBeenCalledWith('ada', '0000-0000-eqk1');
  expect(screen.getByText(/Tell ada this number: 482 913/)).toBeTruthy();
  // a refusal is said in place
  act2.matePair.mockRejectedValue('That code is not open.');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pair this Mac' })); });
  expect(screen.getByRole('alert').textContent).toContain('That code is not open.');
});

test('a Trusted visitor can allow and deny; the click is sent once and its result shown', async () => {
  act2.mateKey.mockResolvedValue('k_me');
  useApp.setState({ visiting: { owner: 'ada', map: withMate('trusted') }, visitedSession: 's1' });
  ipc.visitBuilder.mockResolvedValue(waiting());
  await act(async () => { render(<VisitedBuilder />); });
  expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  ipc.visitBuilder.mockResolvedValue(waiting({ sent: true }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Allow' })); });
  expect(act2.visitAct).toHaveBeenCalledWith('ada', 'msg_1', { do: 'allow', prompt: 'ab'.repeat(32) });
  expect(act2.visitAct).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Sent to ada’s Mac')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
});

test.each([['applied', 'Done'], ['stale', 'Too late: it had moved on'], ['refused', 'ada’s Mac refused it'], ['failed', 'ada’s Mac could not do it']])('the owner’s answer %s shows', async (result, text) => {
  act2.mateKey.mockResolvedValue('k_me');
  useApp.setState({ visiting: { owner: 'ada', map: withMate('trusted') }, visitedSession: 's1' });
  ipc.visitBuilder.mockResolvedValue(waiting({ sent: true, result }));
  await act(async () => { render(<VisitedBuilder />); });
  expect(screen.getByText(text)).toBeTruthy();
});

test('a Helper answers and follows up, and is not offered Allow', async () => {
  act2.mateKey.mockResolvedValue('k_me');
  useApp.setState({ visiting: { owner: 'ada', map: withMate('helper') }, visitedSession: 's1' });
  ipc.visitBuilder.mockResolvedValue(waiting());
  const { unmount } = await act(async () => render(<VisitedBuilder />));
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  expect(screen.getByText(/Only a Trusted person can allow or deny here/)).toBeTruthy();
  unmount();
  ipc.visitBuilder.mockResolvedValue(waiting({ wait: 'answer', can: ['answer'], question: 'Which database?', options: ['sqlite', 'postgres'] }));
  await act(async () => { render(<VisitedBuilder />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'postgres' })); });
  expect(act2.visitAct).toHaveBeenLastCalledWith('ada', 'msg_1', { do: 'answer', pick: 1, prompt: 'ab'.repeat(32) });
  cleanup();
  ipc.visitBuilder.mockResolvedValue(waiting({ wait: 'review', can: ['followup'], question: null, words: 'Finished.' }));
  await act(async () => { render(<VisitedBuilder />); });
  fireEvent.change(screen.getByLabelText('Follow up'), { target: { value: ' also add tests ' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  expect(act2.visitAct).toHaveBeenLastCalledWith('ada', 'msg_1', { do: 'followup', text: 'also add tests', prompt: 'ab'.repeat(32) });
});

test('a Visitor is offered nothing, whatever the builder would take', async () => {
  useApp.setState({ visiting: { owner: 'ada', map: mapOf('ada') }, visitedSession: 's1' });
  ipc.visitBuilder.mockResolvedValue(waiting());
  await act(async () => { render(<VisitedBuilder />); });
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
});

test('a failed send says why and gives the buttons back', async () => {
  act2.mateKey.mockResolvedValue('k_me');
  useApp.setState({ visiting: { owner: 'ada', map: withMate('trusted') }, visitedSession: 's1' });
  ipc.visitBuilder.mockResolvedValue(waiting());
  act2.visitAct.mockRejectedValue('Too late: it had moved on.');
  await act(async () => { render(<VisitedBuilder />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Deny' })); });
  expect(screen.getByRole('alert').textContent).toContain('Too late: it had moved on.');
  expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
});

test('after an answer was applied and the builder asks again, the new wait can be answered', async () => {
  act2.mateKey.mockResolvedValue('k_me');
  useApp.setState({ visiting: { owner: 'ada', map: withMate('trusted') }, visitedSession: 's1' });
  ipc.visitBuilder.mockResolvedValue(waiting());
  await act(async () => { render(<VisitedBuilder />); });
  // by the time the panel reads again, the Allow was applied and a new prompt is open
  ipc.visitBuilder.mockResolvedValue(waiting({ prompt: 'cd'.repeat(32), question: 'Bash: npm run build' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Allow' })); });
  expect(screen.getByText('Bash: npm run build')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  expect(screen.queryByText(/Sent to/)).toBeNull();
});

// Borrowing (shared builders).
const borrow = vi.hoisted(() => ({ borrowLent: vi.fn(), borrowSend: vi.fn() }));
Object.assign(ipc, borrow);

test('clicking a house in a visited village offers the builders lent to you there, and sends a request', async () => {
  const BorrowHere = (await import('../panels/BorrowHere')).default;
  useApp.setState({ visiting: { owner: 'ada', map: mapOf('ada') }, borrowHere: 'shop' });
  borrow.borrowLent.mockResolvedValue([{ profile: 'wizard', name: 'Wizard' }, { profile: 'archer', name: 'Archer' }]);
  await act(async () => { render(<BorrowHere />); });
  expect(borrow.borrowLent).toHaveBeenCalledWith('ada', 'shop');
  expect(screen.getByText('Borrow a builder in ada’s shop')).toBeTruthy();
  const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Archer'));
  fireEvent.change(screen.getByLabelText('What should it do?'), { target: { value: 'Add a CSV export' } });
  borrow.borrowSend.mockResolvedValue({ owner: 'ada', request: 'msg_q', builder: 'Archer', workspace: 'shop', task: 'Add a CSV export', at: 1, result: null, why: null });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  expect(borrow.borrowSend).toHaveBeenCalledWith('ada', 'shop', 'archer', 'Add a CSV export');
  expect(screen.getByText(/Sent\. ada’s Mac will answer/)).toBeTruthy();
});

test('a workspace with nothing lent to you says so', async () => {
  const BorrowHere = (await import('../panels/BorrowHere')).default;
  useApp.setState({ visiting: { owner: 'ada', map: mapOf('ada') }, borrowHere: 'shop' });
  borrow.borrowLent.mockResolvedValue([]);
  await act(async () => { render(<BorrowHere />); });
  expect(screen.getByText(/ada lends you no builder here/)).toBeTruthy();
});

test('a borrowed builder opened from home shows its panel, and Done when it is finished', async () => {
  act2.mateKey.mockResolvedValue('k_me');
  useApp.setState({ visiting: null, borrowedFrom: 'ada', borrowedMap: withMate('helper'), visitedSession: 's1' });
  ipc.visitBuilder.mockResolvedValue(waiting({ wait: 'review', can: ['followup', 'close'], question: null, words: 'Finished.\n\nPushed to origin as `borrow/me/x-ab12`.' }));
  await act(async () => { render(<VisitedBuilder />); });
  expect(screen.getByText(/Pushed to origin as/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
  expect(act2.visitAct).toHaveBeenLastCalledWith('ada', 'msg_1', { do: 'close', prompt: 'ab'.repeat(32) });
});
