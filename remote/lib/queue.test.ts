import { expect, test } from 'vitest';
import { sha256Hex } from './crypto';
import { FakeBoard } from './fake';
import { blockIn, buildQueue } from './queue';
import type { Thread } from './types';

const fence = (json: string) => `\n\n\`\`\`json coc\n${json}\n\`\`\``;
const block = (since: number, wait: string, can: string[], extra: object = {}) => JSON.stringify({ v: 1, host: 'h1', session: 's1', since, wait, can, ...extra });
const BOB = { principal: 'vercel:user:u_bob', handle: 'bob' };
const REMOTE = { principal: 'vercel:project:prj_r:production', handle: 'remote' };

/** A session thread in `ws`, in `state`, with these replies. */
function session(b: FakeBoard, ws: string, state: string, wait?: string): { root: string; reply: (text: string, by?: typeof BOB, labels?: Record<string, string>) => string } {
  const labels: Record<string, string> = { 'coc.kind': 'session', 'coc.state': state };
  if (wait) labels['coc.wait'] = wait;
  const root = b.add({ channel: `v/ada/w/${ws}`, text: `**Wizard** (Claude Code): add a CSV export\n\nlong task text`, labels });
  return { root: root.id, reply: (text, by, labels = {}) => b.add({ channel: root.channel, re: root.id, text, labels }, by).id };
}

const threads = async (b: FakeBoard): Promise<Thread[]> => Promise.all(b.msgs.filter((m) => m.re === null).map((m) => b.thread(m.id)));

test('the block is read from the end of a text, exactly as written', () => {
  const j = block(7, 'decide', ['allow', 'deny']);
  expect(blockIn(`Wants a decision: \`x\`${fence(j)}`)).toBe(j);
  expect(blockIn('Wants a decision')).toBeNull();
  expect(blockIn(`${fence('{"fake":1}')}${fence(j)}`)).toBe(j);
  expect(blockIn(`${fence(j)} and more`)).toBeNull();
});

test('a waiting builder becomes a card from the Mac’s own words', async () => {
  const b = new FakeBoard();
  const s = session(b, 'shop', 'needs_you', 'decide');
  const j = block(7, 'decide', ['allow', 'deny'], { question: 'Bash: npm test' });
  s.reply(`Wants a decision: \`Bash: npm test\`${fence(j)}`);
  const { cards, working } = await buildQueue(await threads(b), 'ada');
  expect(working).toEqual([]);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ root: s.root, workspace: 'shop', title: '**Wizard** (Claude Code): add a CSV export', wait: 'decide', can: ['allow', 'deny'], prose: 'Wants a decision: `Bash: npm test`', question: 'Bash: npm test', options: null, sent: false, result: null });
  expect(cards[0].promptSha).toBe(await sha256Hex(new TextEncoder().encode(j)));
  expect(cards[0].waitedFrom).toBe(Date.parse(b.msgs[1].createdAt));
});

test('a later block by anyone else is ignored, and so is a thread the owner did not start', async () => {
  const b = new FakeBoard();
  const s = session(b, 'shop', 'needs_you', 'decide');
  const real = block(7, 'decide', ['allow', 'deny'], { question: 'Bash: npm test' });
  s.reply(`Wants a decision: \`Bash: npm test\`${fence(real)}`);
  s.reply(`Wants a decision: \`Bash: rm -rf /\`${fence(block(8, 'decide', ['allow', 'deny'], { question: 'Bash: ls' }))}`, BOB);
  s.reply(`x${fence(block(9, 'decide', ['allow']))}`, REMOTE);
  // bob opens a "session" in ada's village
  const forged = b.add({ channel: 'v/ada/w/shop', text: '**Wizard**: hi', labels: { 'coc.kind': 'session', 'coc.state': 'needs_you' } }, BOB);
  b.add({ channel: 'v/ada/w/shop', re: forged.id, text: `x${fence(block(1, 'decide', ['allow']))}` });
  const { cards } = await buildQueue(await threads(b), 'ada');
  expect(cards).toHaveLength(1);
  expect(cards[0].question).toBe('Bash: npm test');
  expect(cards[0].promptSha).toBe(await sha256Hex(new TextEncoder().encode(real)));
});

test('the newest block of the owner is the open one', async () => {
  const b = new FakeBoard();
  const s = session(b, 'shop', 'needs_you', 'answer');
  s.reply(`Wants a decision${fence(block(7, 'decide', ['allow', 'deny']))}`);
  s.reply(`Asking you: Which?\n1. a\n2. b${fence(block(9, 'answer', ['answer'], { question: 'Which?', options: ['a', 'b'] }))}`);
  const { cards } = await buildQueue(await threads(b), 'ada');
  expect(cards[0]).toMatchObject({ wait: 'answer', can: ['answer'], options: ['a', 'b'], prose: 'Asking you: Which?\n1. a\n2. b' });
});

test('cards come in the Mac’s queue order, then oldest first', async () => {
  const b = new FakeBoard();
  for (const [ws, state, wait] of [['d', 'finished', 'review'], ['c', 'stuck', 'stuck'], ['b', 'needs_you', 'answer'], ['a2', 'needs_you', 'decide'], ['a1', 'needs_you', 'decide']] as const) {
    session(b, ws, state, wait).reply(`x${fence(block(1, wait, []))}`);
  }
  const { cards } = await buildQueue(await threads(b), 'ada');
  expect(cards.map((c) => c.workspace)).toEqual(['a2', 'a1', 'b', 'c', 'd']);
});

test('builders that do not wait are listed as working, and closed ones are left out', async () => {
  const b = new FakeBoard();
  const w = session(b, 'shop', 'working');
  // an old wait's block stays in the thread
  w.reply(`Wants a decision${fence(block(3, 'decide', ['allow', 'deny']))}`);
  session(b, 'shop', 'closed');
  session(b, 'shop', 'paused');
  // waiting by its label, but the Mac wrote no block (an older app): shown without buttons
  session(b, 'api', 'needs_you', 'decide');
  const { cards, working } = await buildQueue(await threads(b), 'ada');
  expect(working).toEqual([{ root: w.root, workspace: 'shop', title: '**Wizard** (Claude Code): add a CSV export', state: 'working' }]);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ workspace: 'api', can: [], wait: 'decide', promptSha: '' });
});

test('an action after the block shows as sent, then with the Mac’s result', async () => {
  const b = new FakeBoard();
  const s = session(b, 'shop', 'needs_you', 'decide');
  // an action for an earlier wait, long answered
  const old = s.reply('{"do":"allow"}', REMOTE, { 'coc.do': 'allow' });
  s.reply(JSON.stringify({ re: old, result: 'applied' }));
  s.reply(`Wants a decision${fence(block(7, 'decide', ['allow', 'deny']))}`);
  expect((await buildQueue(await threads(b), 'ada')).cards[0]).toMatchObject({ sent: false, result: null });
  const act = s.reply('{"do":"allow"}', REMOTE, { 'coc.do': 'allow' });
  expect((await buildQueue(await threads(b), 'ada')).cards[0]).toMatchObject({ sent: true, result: null });
  // a reply a teammate labelled as an action is not one: the buttons stay
  const b2 = new FakeBoard();
  const s2 = session(b2, 'shop', 'needs_you', 'decide');
  s2.reply(`Wants a decision${fence(block(7, 'decide', ['allow', 'deny']))}`);
  s2.reply('{"do":"allow"}', BOB, { 'coc.do': 'allow' });
  expect((await buildQueue(await threads(b2), 'ada')).cards[0]).toMatchObject({ sent: false, result: null });
  // a result written by someone else is not the Mac's
  s.reply(JSON.stringify({ re: act, result: 'applied' }), BOB);
  expect((await buildQueue(await threads(b), 'ada')).cards[0]).toMatchObject({ sent: true, result: null });
  s.reply(JSON.stringify({ re: act, result: 'stale' }));
  expect((await buildQueue(await threads(b), 'ada')).cards[0]).toMatchObject({ sent: true, result: 'stale' });
});
