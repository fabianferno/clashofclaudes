import { expect, test } from 'vitest';
import { b64 } from './crypto';
import { FakeBoard, phone, record } from './fake';
import { byOwner, Records } from './records';

const NOW = 1_800_000_000_000;
const make = (board: FakeBoard, clock = { t: NOW }) => ({ records: new Records(board, () => clock.t), clock });

test('a message is the owner’s only when their own login wrote it', () => {
  const b = new FakeBoard();
  const ch = 'v/ada/remote';
  expect(byOwner(b.add({ channel: ch, text: 'x' }), 'ada')).toBe(true);
  expect(byOwner(b.add({ channel: ch, text: 'x' }, { principal: 'vercel:user:u_ada', handle: 'ada' }), 'ada')).toBe(true);
  expect(byOwner(b.add({ channel: ch, text: 'x' }, { principal: 'vercel:user:u_bob', handle: 'bob/village' }), 'ada')).toBe(false);
  // a project that happens to be named like the owner
  expect(byOwner(b.add({ channel: ch, text: 'x' }, { principal: 'vercel:project:prj_1:production', handle: 'ada' }), 'ada')).toBe(false);
  expect(byOwner(b.add({ channel: ch, text: 'x' }, { principal: 'vercel:user:u_x', handle: 'adam/village' }), 'ada')).toBe(false);
  expect(byOwner(b.add({ channel: ch, text: 'x' }, { principal: 'vercel:user:u_ada', handle: 'ada/village', verified: false }), 'ada')).toBe(false);
});

test('a paired record written by the owner counts; nothing else does', async () => {
  const b = new FakeBoard();
  const mine = await phone();
  record(b, 'ada', mine.key, mine.pub);
  const { records } = make(b);
  const phones = await records.phones('ada');
  expect([...phones.keys()]).toEqual([mine.key]);
  expect(b64(phones.get(mine.key)!.public)).toBe(b64(mine.pub));
  expect(phones.get(mine.key)!.root).toBe('msg_1');

  for (const forge of [
    // a teammate writes a record for their own key
    async (b: FakeBoard, p: Awaited<ReturnType<typeof phone>>) => void b.add({ channel: 'v/ada/remote', text: JSON.stringify({ key: p.key, public: b64(p.pub), name: 'x', state: 'paired' }), labels: { 'coc.kind': 'phone' } }, { principal: 'vercel:user:u_bob', handle: 'bob' }),
    // the remote project itself
    async (b: FakeBoard, p: Awaited<ReturnType<typeof phone>>) => void b.add({ channel: 'v/ada/remote', text: JSON.stringify({ key: p.key, public: b64(p.pub), name: 'x', state: 'paired' }), labels: { 'coc.kind': 'phone' } }, { principal: 'vercel:project:prj_r:production', handle: 'remote' }),
    // the owner removed it; a teammate put a "paired" label back
    async (b: FakeBoard, p: Awaited<ReturnType<typeof phone>>) => void (record(b, 'ada', p.key, p.pub, 'removed').labels['coc.state'] = 'paired'),
    // a reply, not a root
    async (b: FakeBoard, p: Awaited<ReturnType<typeof phone>>) => void b.add({ channel: 'v/ada/remote', re: 'msg_1', text: JSON.stringify({ key: p.key, public: b64(p.pub), name: 'x', state: 'paired' }), labels: { 'coc.kind': 'phone' } }),
    // a key id that is not its key's
    async (b: FakeBoard, p: Awaited<ReturnType<typeof phone>>) => void b.add({ channel: 'v/ada/remote', text: JSON.stringify({ key: 'deadbeefdeadbeef', public: b64(p.pub), name: 'x', state: 'paired' }), labels: { 'coc.kind': 'phone' } }),
    async (b: FakeBoard) => void b.add({ channel: 'v/ada/remote', text: 'not json', labels: { 'coc.kind': 'phone' } }),
  ]) {
    const board = new FakeBoard();
    const p = await phone();
    await forge(board, p);
    expect((await make(board).records.phones('ada')).size).toBe(0);
  }
});

test('records are cached for a minute, and a miss for five seconds', async () => {
  const b = new FakeBoard();
  const { records, clock } = make(b);
  expect((await records.phones('ada')).size).toBe(0);
  const p = await phone();
  record(b, 'ada', p.key, p.pub);
  clock.t += 4_000;
  expect(await records.phone('ada', p.key)).toBeNull();
  clock.t += 2_000;
  expect(await records.phone('ada', p.key)).not.toBeNull();
  const reads = b.reads;
  clock.t += 59_000;
  await records.phone('ada', p.key);
  expect(b.reads).toBe(reads);
  clock.t += 2_000;
  await records.phone('ada', p.key);
  expect(b.reads).toBeGreaterThan(reads);
});

const ticket = (b: FakeBoard, owner: string, id: string, until: number, state = 'open', by = { principal: `vercel:user:u_${owner}`, handle: `${owner}/village` }) =>
  b.add({ channel: `v/${owner}/remote`, text: JSON.stringify({ host: 'h1', id, until, state }), labels: { 'coc.kind': 'pair-open', 'coc.code': id } }, by);
const T1 = '24a36f2920d1e732';
const T0 = '0000000000000000';

test('an open ticket is found by its code, with its village', async () => {
  const b = new FakeBoard();
  b.add({ channel: 'v/bob/remote', text: '{}' }, { principal: 'vercel:user:u_bob', handle: 'bob' });
  const t = ticket(b, 'ada', T1, NOW + 60_000);
  expect(await make(b).records.openTicket(T1)).toEqual({ owner: 'ada', id: t.id, host: 'h1' });
  expect(await make(b).records.openTicket(T0)).toBeNull();
});

test('a ticket that is expired, closed, forged or only labelled is not open', async () => {
  for (const put of [
    (b: FakeBoard) => ticket(b, 'ada', T1, NOW - 1),
    (b: FakeBoard) => ticket(b, 'ada', T1, NOW + 60_000, 'closed'),
    // written in ada's village by bob
    (b: FakeBoard) => ticket(b, 'ada', T1, NOW + 60_000, 'open', { principal: 'vercel:user:u_bob', handle: 'bob' }),
    // the text names another ticket than the label
    (b: FakeBoard) => (ticket(b, 'ada', '1111111111111111', NOW + 60_000).labels['coc.code'] = T1),
    (b: FakeBoard) => b.add({ channel: 'v/ada/remote', text: 'open', labels: { 'coc.kind': 'pair-open', 'coc.code': T1 } }),
  ]) {
    const b = new FakeBoard();
    put(b);
    expect(await make(b).records.openTicket(T1)).toBeNull();
  }
});

test('a wrong code asked again does not read the board again', async () => {
  const b = new FakeBoard();
  ticket(b, 'ada', T1, NOW + 60_000);
  const { records } = make(b);
  await records.openTicket(T0);
  const reads = b.reads;
  await records.openTicket(T0);
  expect(b.reads).toBe(reads);
  expect(await records.openTicket('not a ticket')).toBeNull();
  expect(b.reads).toBe(reads);
});

test('a village is one that has its own channel on the board', async () => {
  const b = new FakeBoard();
  b.add({ channel: 'v/ada/remote', text: '{}' });
  const { records, clock } = make(b);
  expect(await records.hasVillage('ada')).toBe(true);
  const reads = b.reads;
  // a stranger naming owners that do not exist costs no read each
  for (const o of ['bob', 'carol', 'dave']) expect(await records.hasVillage(o)).toBe(false);
  expect(b.reads).toBe(reads);
  b.add({ channel: 'v/bob/remote', text: '{}' }, { principal: 'vercel:user:u_bob', handle: 'bob' });
  clock.t += 16_000;
  expect(await records.hasVillage('bob')).toBe(true);
});

test('the village says when its Mac was last seen', async () => {
  const b = new FakeBoard();
  b.add({ channel: 'v/ada/remote', text: JSON.stringify({ host: 'h1', version: '0.9.0', seen: 5 }), labels: { 'coc.kind': 'village' } });
  b.add({ channel: 'v/ada/remote', text: JSON.stringify({ host: 'h2', version: '0.9.0', seen: 9 }), labels: { 'coc.kind': 'village' } });
  b.add({ channel: 'v/ada/remote', text: JSON.stringify({ host: 'hx', seen: 99 }), labels: { 'coc.kind': 'village' } }, { principal: 'vercel:user:u_bob', handle: 'bob' });
  expect(await make(b).records.seen('ada')).toBe(9);
  expect(await make(new FakeBoard()).records.seen('ada')).toBeNull();
});
