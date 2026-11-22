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

test('a decision shows only what its signature covers', async () => {
  const { phone } = await api();
  // the words around the block are not signed: someone could have written kinder ones
  render(<Card card={card({ question: null, prose: 'Wants a decision: `Bash: ls`' })} phone={phone} />);
  expect(screen.queryByText(/Bash: ls/)).toBeNull();
  expect(screen.getByText(/does not share what it wants to run/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
});

test('after the Mac refused or failed, the buttons come back for another try', async () => {
  const { phone } = await api();
  render(<Card card={card({ sent: true, result: 'failed' })} phone={phone} />);
  expect(screen.getByText('Your Mac could not do it')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  cleanup();
  render(<Card card={card({ sent: true, result: 'stale' })} phone={phone} />);
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
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

const working = (over: object = {}) => ({ root: 'msg_2', workspace: 'api', title: '**Archer** (Codex): fix login', state: 'working', promptSha: 'cd'.repeat(32), last: null, ...over });
const queue = (over: object = {}) => ({ cards: [card()], working: [working()], seen: Date.now() - 60_000, now: Date.now(), ...over });

test('a builder at work takes a message signed for its stretch of work, then shows the Mac’s word on it', async () => {
  const { phone, posts, pub } = await api();
  let data = queue({ cards: [] });
  render(<Queue phone={phone} load={async () => data} every={20} />);
  await settle();
  await press('Message');
  const box = screen.getByRole('textbox', { name: 'Message Archer' });
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(box, { target: { value: 'use the v2 endpoint' } });
  await press('Send');
  await settle();
  expect(posts).toHaveLength(1);
  const { root, action } = posts[0].body;
  expect(root).toBe('msg_2');
  expect(action).toMatchObject({ v: 1, do: 'followup', text: 'use the v2 endpoint', prompt: 'cd'.repeat(32), key: phone.key });
  expect(await verify(pub, await signedBytes(action), action.sig)).toBe(true);
  expect((box as HTMLTextAreaElement).value).toBe('');
  expect(screen.getByRole('status').textContent).toBe('Sent to your Mac');
  // the remote posted it as `x`; the Mac answers, read on the next poll
  data = queue({ cards: [], working: [working({ last: { id: 'x', result: 'applied' } })] });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  expect(screen.getByRole('status').textContent).toBe('Your Mac typed it in');
  data = queue({ cards: [], working: [working({ last: { id: 'x', result: 'stale' } })] });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  expect(screen.getByRole('status').textContent).toMatch(/^Too late/);
});

test('a builder still starting cannot be messaged yet', async () => {
  const { phone } = await api();
  render(<Queue phone={phone} load={async () => queue({ cards: [], working: [working({ state: 'starting', promptSha: null })] })} every={0} />);
  await settle();
  expect(screen.getByText('Archer')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
});

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
  fireEvent.change(screen.getByRole('textbox', { name: 'Code from your Mac' }), { target: { value: '0000-0000-eqk' } });
  expect(send.disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Code from your Mac' }), { target: { value: '0000-0000-eqk1' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name for this phone' }), { target: { value: 'Ada’s iPhone' } });
  await press('Pair this phone');
  await settle();
  expect(submit).toHaveBeenCalledWith('00000000EQK1', 'Ada’s iPhone');
  expect(screen.getByText('482 913')).toBeTruthy();
  expect(screen.getByText(/press Confirm/)).toBeTruthy();
  expect(onPaired).not.toHaveBeenCalled();
  confirmed = true;
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  expect(onPaired).toHaveBeenCalled();
});

test('a code carried in the address is filled in', () => {
  render(<Pair ios={false} standalone={false} code="00000000EQK1" submit={vi.fn()} paired={async () => false} onPaired={() => {}} />);
  expect((screen.getByRole('textbox', { name: 'Code from your Mac' }) as HTMLInputElement).value).toBe('0000-0000-EQK1');
  expect((screen.getByRole('button', { name: 'Pair this phone' }) as HTMLButtonElement).disabled).toBe(false);
});

test('a wrong code says so and lets you try again', async () => {
  render(<Pair ios={false} standalone={false} submit={async () => ({ error: 'that code is not open; look at the Mac for the current one' })} paired={async () => false} onPaired={() => {}} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Code from your Mac' }), { target: { value: '000000000000' } });
  await press('Pair this phone');
  await settle();
  expect(screen.getByText('that code is not open; look at the Mac for the current one')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Code from your Mac' })).toBeTruthy();
  // unused import guard
  expect(typeof sha256Hex).toBe('function');
});
