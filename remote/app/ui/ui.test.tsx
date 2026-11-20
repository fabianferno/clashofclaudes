// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { sha256Hex, signedBytes, verify } from '../../lib/crypto';
import { phone as makePhone } from '../../lib/fake';
import type { Card as CardData } from '../../lib/types';
import { Card } from './Card';
import { Pair } from './Pair';
import { Queue } from './Queue';
import type { PhoneApi } from './phone-api';

afterEach(cleanup);

const card = (over: Partial<CardData> = {}): CardData => ({
  root: 'msg_1', workspace: 'shop', title: '**Wizard** (Claude Code): add a CSV export', wait: 'decide', can: ['allow', 'deny'], prose: 'Wants a decision: `Bash: npm test`',
  question: 'Bash: npm test', options: null, waitedFrom: Date.now() - 5 * 60_000, promptSha: 'ab'.repeat(32), sent: false, result: null, ...over,
});

async function api(): Promise<{ phone: PhoneApi; posts: { path: string; body: any }[]; pub: Uint8Array }> {
  const p = await makePhone();
  const posts: { path: string; body: any }[] = [];
  const phone: PhoneApi = {
    owner: 'ada',
    key: p.key,
    signAction: p.signAction,
    api: vi.fn(async (path: string, init?: RequestInit) => {
      posts.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ id: 'x' });
    }),
  };
  return { phone, posts, pub: p.pub };
}

const press = async (name: string | RegExp) => act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

test('a card offers only what the Mac will take', async () => {
  const { phone } = await api();
  render(<Card card={card()} phone={phone} />);
  expect(screen.getByText('Wizard')).toBeTruthy();
  expect(screen.getByText('Bash: npm test')).toBeTruthy();
  expect(screen.getByText(/shop/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  cleanup();
  render(<Card card={card({ wait: 'review', can: ['followup'], prose: 'Finished.\n\nExport added.', question: null })} phone={phone} />);
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Follow up' })).toBeTruthy();
  expect(screen.getByText(/Export added\./)).toBeTruthy();
});

test('Allow posts an action signed for exactly this card, then says so', async () => {
  const { phone, posts, pub } = await api();
  render(<Card card={card()} phone={phone} />);
  await press('Allow');
  await settle();
  expect(posts).toHaveLength(1);
  const { root, action } = posts[0].body;
  expect([posts[0].path, root]).toEqual(['/api/act', 'msg_1']);
  expect(action).toMatchObject({ v: 1, do: 'allow', key: phone.key, prompt: 'ab'.repeat(32) });
  expect(action.nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(await verify(pub, await signedBytes(action), action.sig)).toBe(true);
  expect(screen.getByText('Sent to your Mac')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
});

test('the Mac’s answer shows on the card', async () => {
  const { phone } = await api();
  for (const [result, text] of [['applied', 'Done'], ['stale', 'Too late: it had moved on'], ['refused', 'Your Mac refused it'], ['failed', 'Your Mac could not do it']] as const) {
    render(<Card card={card({ sent: true, result })} phone={phone} />);
    expect(screen.getByText(text)).toBeTruthy();
    cleanup();
  }
  render(<Card card={card({ sent: true })} phone={phone} />);
  expect(screen.getByText('Sent to your Mac')).toBeTruthy();
});

test('a picker shows its options and a line for your own words', async () => {
  const { phone, posts, pub } = await api();
  const c = card({ wait: 'answer', can: ['answer'], prose: 'Asking you: Which database?', question: 'Which database?', options: ['sqlite', 'postgres'] });
  render(<Card card={c} phone={phone} />);
  await press('postgres');
  await settle();
  expect(posts[0].body.action).toMatchObject({ do: 'answer', pick: 1 });
  expect(posts[0].body.action.text).toBeUndefined();
  expect(await verify(pub, await signedBytes(posts[0].body.action), posts[0].body.action.sig)).toBe(true);
  cleanup();
  render(<Card card={c} phone={phone} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Your own answer' }), { target: { value: ' mysql ' } });
  await press('Send');
  await settle();
  expect(posts[1].body.action).toMatchObject({ do: 'answer', text: 'mysql' });
  expect(posts[1].body.action.pick).toBeUndefined();
});

test('a follow-up needs words, and a prompt the phone cannot answer says where to', async () => {
  const { phone, posts } = await api();
  render(<Card card={card({ wait: 'stuck', can: ['followup'], prose: 'Stuck: no output', question: null })} phone={phone} />);
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Follow up' }), { target: { value: 'try again' } });
  await press('Send');
  await settle();
  expect(posts[0].body.action).toMatchObject({ do: 'followup', text: 'try again' });
  cleanup();
  render(<Card card={card({ wait: 'answer', can: [], question: null, prose: 'Asking you' })} phone={phone} />);
  expect(screen.getByText('Answer this one on your Mac')).toBeTruthy();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('a failed send puts the buttons back and says why', async () => {
  const { phone } = await api();
  phone.api = vi.fn(async () => Response.json({ error: 'no such builder' }, { status: 404 }));
  render(<Card card={card()} phone={phone} />);
  await press('Deny');
  await settle();
  expect(screen.getByText('no such builder')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
});

const queue = (over: object = {}) => ({ cards: [card()], working: [{ root: 'msg_2', workspace: 'api', title: '**Archer** (Codex): fix login', state: 'working' }], seen: Date.now() - 60_000, now: Date.now(), ...over });

test('the queue shows who waits, who works, and when the Mac is away', async () => {
  const { phone } = await api();
  const { unmount } = render(<Queue phone={phone} load={async () => queue()} every={0} />);
  await settle();
  expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  expect(screen.getByText('Archer')).toBeTruthy();
  expect(screen.queryByText(/asleep or offline/)).toBeNull();
  unmount();
  render(<Queue phone={phone} load={async () => queue({ seen: Date.now() - 13 * 60_000 })} every={0} />);
  await settle();
  expect(screen.getByText('Your Mac may be asleep or offline. What you send waits for it.')).toBeTruthy();
});

test('an empty queue says so, and a village that never wrote says what to check', async () => {
  const { phone } = await api();
  const { unmount } = render(<Queue phone={phone} load={async () => queue({ cards: [], working: [] })} every={0} />);
  await settle();
  expect(screen.getByText('Nobody is waiting on you.')).toBeTruthy();
  unmount();
  render(<Queue phone={phone} load={async () => queue({ cards: [], working: [], seen: null })} every={0} />);
  await settle();
  expect(screen.getByText(/has not been heard from yet/)).toBeTruthy();
});

test('on an iPhone in Safari, pairing first asks to add it to the Home Screen', () => {
  render(<Pair ios standalone={false} submit={vi.fn()} paired={async () => false} onPaired={() => {}} />);
  expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('the code is sent with a name, then the check number is shown until the Mac confirms', async () => {
  const submit = vi.fn(async () => ({ check: '482 913' }));
  let confirmed = false;
  const onPaired = vi.fn();
  render(<Pair ios standalone submit={submit} paired={async () => confirmed} onPaired={onPaired} every={10} />);
  const send = screen.getByRole('button', { name: 'Pair this phone' }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Code from your Mac' }), { target: { value: '482 913' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name for this phone' }), { target: { value: 'Ada’s iPhone' } });
  await press('Pair this phone');
  await settle();
  expect(submit).toHaveBeenCalledWith('482913', 'Ada’s iPhone');
  expect(screen.getByText('482 913')).toBeTruthy();
  expect(screen.getByText(/press Confirm/)).toBeTruthy();
  expect(onPaired).not.toHaveBeenCalled();
  confirmed = true;
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  expect(onPaired).toHaveBeenCalled();
});

test('a wrong code says so and lets you try again', async () => {
  render(<Pair ios={false} standalone={false} submit={async () => ({ error: 'that code is not open; look at the Mac for the current one' })} paired={async () => false} onPaired={() => {}} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Code from your Mac' }), { target: { value: '000000' } });
  await press('Pair this phone');
  await settle();
  expect(screen.getByText('that code is not open; look at the Mac for the current one')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Code from your Mac' })).toBeTruthy();
  // unused import guard
  expect(typeof sha256Hex).toBe('function');
});
