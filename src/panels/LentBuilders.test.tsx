import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Lending } from '../api/types';

const ipc = vi.hoisted(() => ({ lending: vi.fn(), lendSet: vi.fn() }));
vi.mock('../api/ipc', () => ({ ipc }));
import LentBuilders from './LentBuilders';

const lending = (over: Partial<Lending> = {}): Lending => ({
  builders: [{ builder: 'b1', name: 'Wizard', lend: null }, { builder: 'b2', name: 'Archer', lend: { builder: 'b2', keys: ['k_bob'], workspaces: ['w1'], floor: 15, ask: true } }],
  workspaces: [{ id: 'w1', name: 'shop', lendable: true, why: null }, { id: 'w2', name: 'notes', lendable: false, why: 'no origin to push to' }],
  mates: [{ key: 'k_bob', email: 'bob@acme.com', handle: 'bob' }, { key: 'k_eve', email: 'eve@acme.com', handle: 'eve' }],
  reserve: 10,
  ...over,
});

beforeEach(() => {
  ipc.lending.mockReset().mockResolvedValue(lending());
  ipc.lendSet.mockReset().mockImplementation(async () => lending());
});
afterEach(cleanup);

const show = async () => act(async () => { render(<LentBuilders />); });

test('each builder has a Lend switch that says what lending means', async () => {
  await show();
  const wizard = screen.getByLabelText(/^Lend Wizard/) as HTMLInputElement;
  expect(wizard.checked).toBe(false);
  expect(screen.getAllByText(/a teammate’s words run on this Mac, with your logins, without anyone here looking first/).length).toBeGreaterThan(0);
  await act(async () => { fireEvent.click(wizard); });
  expect(ipc.lendSet).toHaveBeenCalledWith('b1', { builder: 'b1', keys: null, workspaces: null, floor: 10, ask: false });
});

test('a lent builder shows to whom, where, its floor and ask-first, and each saves', async () => {
  await show();
  expect((screen.getByLabelText(/^Lend Archer/) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Archer: lent to bob') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Archer: lent to eve') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('Archer: works in shop') as HTMLInputElement).checked).toBe(true);
  // a workspace that cannot be lent says why, and cannot be chosen
  expect((screen.getByLabelText('Archer: works in notes') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/no origin to push to/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByLabelText('Archer: lent to eve')); });
  expect(ipc.lendSet).toHaveBeenLastCalledWith('b2', { builder: 'b2', keys: ['k_bob', 'k_eve'], workspaces: ['w1'], floor: 15, ask: true });
  await act(async () => { fireEvent.click(screen.getByLabelText(/^Archer: ask me first/)); });
  expect(ipc.lendSet).toHaveBeenLastCalledWith('b2', { builder: 'b2', keys: ['k_bob'], workspaces: ['w1'], floor: 15, ask: false });
  expect(screen.getAllByText(/shows you the first task only; follow-ups go straight to the builder/i).length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText('Archer: elixir floor'), { target: { value: '25' } });
  await act(async () => { fireEvent.blur(screen.getByLabelText('Archer: elixir floor')); });
  expect(ipc.lendSet).toHaveBeenLastCalledWith('b2', { builder: 'b2', keys: ['k_bob'], workspaces: ['w1'], floor: 25, ask: true });
  await act(async () => { fireEvent.click(screen.getByLabelText(/^Lend Archer/)); });
  expect(ipc.lendSet).toHaveBeenLastCalledWith('b2', null);
});

test('everyone and every workspace are the defaults, and can be narrowed', async () => {
  ipc.lending.mockResolvedValue(lending({ builders: [{ builder: 'b1', name: 'Wizard', lend: { builder: 'b1', keys: null, workspaces: null, floor: 10, ask: false } }] }));
  await show();
  expect((screen.getByLabelText('Wizard: lent to everyone whose Mac is paired') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Wizard: works in every shared workspace') as HTMLInputElement).checked).toBe(true);
  await act(async () => { fireEvent.click(screen.getByLabelText('Wizard: lent to everyone whose Mac is paired')); });
  expect(ipc.lendSet).toHaveBeenLastCalledWith('b1', { builder: 'b1', keys: [], workspaces: null, floor: 10, ask: false });
});

test('with no paired teammate it says so', async () => {
  ipc.lending.mockResolvedValue(lending({ mates: [] }));
  await show();
  expect(screen.getByText(/Pair a teammate’s Mac in People first/)).toBeTruthy();
});

test('a refusal is shown', async () => {
  await show();
  ipc.lendSet.mockRejectedValue('the Keychain is locked');
  await act(async () => { fireEvent.click(screen.getByLabelText(/^Lend Wizard/)); });
  expect(screen.getByRole('alert').textContent).toContain('the Keychain is locked');
});
