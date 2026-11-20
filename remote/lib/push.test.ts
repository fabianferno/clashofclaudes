import { expect, test, vi } from 'vitest';
import { FakeBoard, phone, record } from './fake';
import { addresses, notice, notify, waitIn } from './push';
import { Records } from './records';
import type { Msg } from './types';

const fence = (json: string) => `\n\n\`\`\`json coc\n${json}\n\`\`\``;
const block = (wait: string, can: string[], extra: object = {}) => JSON.stringify({ v: 1, host: 'h1', session: 's1', since: 7, wait, can, ...extra });
const BOB = { principal: 'vercel:user:u_bob', handle: 'bob' };
const REMOTE = { principal: 'vercel:project:prj_r:production', handle: 'remote' };

function village() {
  const b = new FakeBoard();
  const root = b.add({ channel: 'v/ada/w/shop', text: '**Wizard** (Claude Code): add a CSV export', labels: { 'coc.kind': 'session' } });
  const wait = (text: string, by?: typeof BOB): Msg => b.add({ channel: root.channel, re: root.id, text }, by);
  return { b, root, wait };
}

test('a wait the owner’s Mac wrote is worth a notification; nothing else is', () => {
  const { b, root, wait } = village();
  expect(waitIn(wait(`Wants a decision: \`npm test\`${fence(block('decide', ['allow', 'deny'], { question: 'Bash: npm test' }))}`))).toMatchObject({ owner: 'ada', root: root.id, block: { wait: 'decide' } });
  expect(waitIn(wait(`Finished.${fence(block('review', ['followup']))}`))).not.toBeNull();
  expect(waitIn(wait(`Stuck: x${fence(block('stuck', []))}`))).not.toBeNull();
  // a prompt the phone can do nothing about still deserves a look
  expect(waitIn(wait(`Asking you${fence(block('answer', []))}`))).not.toBeNull();
  expect(waitIn(wait(`x${fence(block('decide', ['allow']))}`, BOB))).toBeNull();
  expect(waitIn(wait('Wants a decision'))).toBeNull();
  expect(waitIn(root)).toBeNull();
  expect(waitIn(b.add({ channel: 'v/ada/remote', re: 'x', text: `x${fence(block('decide', ['allow']))}` }))).toBeNull();
});

test('the notice names the builder, what it wants and where', () => {
  const title = '**Wizard** (Claude Code): add a CSV export';
  expect(notice(title, 'shop', { v: 1, host: 'h', session: 's', since: 1, wait: 'decide', can: ['allow', 'deny'], question: 'Bash: npm test' })).toEqual({ title: 'Wizard wants a decision · shop', body: 'Bash: npm test' });
  expect(notice(title, 'shop', { v: 1, host: 'h', session: 's', since: 1, wait: 'decide', can: [] })).toEqual({ title: 'Wizard wants a decision · shop', body: '' });
  expect(notice(title, 'api', { v: 1, host: 'h', session: 's', since: 1, wait: 'answer', can: ['answer'], question: 'Which database?' }).title).toBe('Wizard is asking you · api');
  expect(notice(title, 'api', { v: 1, host: 'h', session: 's', since: 1, wait: 'review', can: ['followup'] }).title).toBe('Wizard finished · api');
  expect(notice('no stars here', 'api', { v: 1, host: 'h', session: 's', since: 1, wait: 'stuck', can: [] }).title).toBe('A builder is stuck · api');
});

async function withPhone() {
  const { b, root, wait } = village();
  const p = await phone();
  const rec = record(b, 'ada', p.key, p.pub);
  const sub = { endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } };
  const addr = b.add({ channel: rec.channel, re: rec.id, text: JSON.stringify({ key: p.key, subscription: sub }), labels: { 'coc.kind': 'push' } }, REMOTE);
  return { b, root, wait, p, rec, sub, addr };
}

test('addresses are the ones the remote kept under paired phones', async () => {
  const { b, rec, sub, p, addr } = await withPhone();
  // someone else replies with an address of their own; and one for another key
  b.add({ channel: rec.channel, re: rec.id, text: JSON.stringify({ key: p.key, subscription: { ...sub, endpoint: 'https://evil.example' } }), labels: { 'coc.kind': 'push' } }, BOB);
  b.add({ channel: rec.channel, re: rec.id, text: JSON.stringify({ key: 'ffffffffffffffff', subscription: sub }), labels: { 'coc.kind': 'push' } }, REMOTE);
  b.add({ channel: rec.channel, re: rec.id, text: JSON.stringify({ key: p.key, gone: true }), labels: { 'coc.kind': 'push' } }, REMOTE);
  expect(await addresses(b, new Records(b), 'ada', 'vercel:project:prj_r:production')).toEqual([{ id: addr.id, key: p.key, subscription: sub }]);
});

test('a wait is pushed to every address, and an address that is gone is forgotten', async () => {
  const { b, wait, sub, addr } = await withPhone();
  const m = wait(`Wants a decision: \`npm test\`${fence(block('decide', ['allow', 'deny'], { question: 'Bash: npm test' }))}`);
  const send = vi.fn(async () => {});
  expect(await notify(m, { board: b, records: new Records(b), self: 'vercel:project:prj_r:production', send })).toBe(1);
  expect(send).toHaveBeenCalledWith(sub, { title: 'Wizard wants a decision · shop', body: 'Bash: npm test', tag: m.re });
  const gone = vi.fn(async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); });
  await notify(m, { board: b, records: new Records(b), self: 'vercel:project:prj_r:production', send: gone });
  expect(JSON.parse(b.msgs.find((x) => x.id === addr.id)!.text)).toMatchObject({ gone: true });
  // any other failure leaves it for the next time
  const { b: b2, wait: wait2, addr: addr2 } = await withPhone();
  const m2 = wait2(`x${fence(block('stuck', []))}`);
  await notify(m2, { board: b2, records: new Records(b2), self: 'vercel:project:prj_r:production', send: vi.fn(async () => { throw new Error('offline'); }) });
  expect(JSON.parse(b2.msgs.find((x) => x.id === addr2.id)!.text).gone).toBeUndefined();
  // not a wait: nobody is asked anything
  expect(await notify(wait('hello'), { board: b, records: new Records(b), self: 'x', send })).toBe(0);
});
