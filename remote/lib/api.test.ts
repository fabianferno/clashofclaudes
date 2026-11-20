import { expect, test } from 'vitest';
import * as api from './api';
import { b64, sha256Hex, verify, signedBytes } from './crypto';
import { FakeBoard, phone, record } from './fake';
import { Records } from './records';

const NOW = 1_800_000_000_000;
const fence = (json: string) => `\n\n\`\`\`json coc\n${json}\n\`\`\``;
const BLOCK = JSON.stringify({ v: 1, host: 'h1', session: 's1', since: 7, wait: 'decide', can: ['allow', 'deny'], question: 'Bash: npm test' });

async function setup() {
  const board = new FakeBoard();
  const p = await phone();
  record(board, 'ada', p.key, p.pub);
  board.add({ channel: 'v/ada/remote', text: JSON.stringify({ host: 'h1', version: '0.9.0', seen: NOW - 1000 }), labels: { 'coc.kind': 'village' } });
  const root = board.add({ channel: 'v/ada/w/shop', text: '**Wizard** (Claude Code): add a CSV export', labels: { 'coc.kind': 'session', 'coc.state': 'needs_you', 'coc.wait': 'decide' } });
  board.add({ channel: root.channel, re: root.id, text: `Wants a decision: \`Bash: npm test\`${fence(BLOCK)}` });
  const clock = { t: NOW };
  const deps: api.Deps = { board, records: new Records(board, () => clock.t), now: () => clock.t, setup: 'sekret', version: '0.1.0', lookups: new api.Limiter(20), cache: new Map() };
  const call = async (handler: (r: Request, d: api.Deps) => Promise<Response>, method: string, path: string, body?: unknown, signer: typeof p | null = p, owner = 'ada') => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = signer ? await signer.headers(owner, method, path, clock.t, text) : {};
    const res = await handler(new Request(`https://r.example${path}`, { method, headers, body: method === 'GET' ? undefined : text }), deps);
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const action = async (over: Record<string, unknown> = {}, signer = p) => {
    const a = { v: 1, do: 'allow', nonce: '000102030405060708090a0b0c0d0e0f', key: signer.key, prompt: await sha256Hex(new TextEncoder().encode(BLOCK)), ...over } as any;
    return { ...a, sig: await signer.signAction(a) };
  };
  return { board, p, root, deps, clock, call, action };
}

test('the queue answers a paired phone and nobody else', async () => {
  const { call, root } = await setup();
  const ok = await call(api.queue, 'GET', '/api/queue');
  expect(ok.status).toBe(200);
  expect(ok.json.cards).toHaveLength(1);
  expect(ok.json.cards[0]).toMatchObject({ root: root.id, workspace: 'shop', can: ['allow', 'deny'], question: 'Bash: npm test' });
  expect(ok.json).toMatchObject({ working: [], seen: NOW - 1000, now: NOW });
  expect((await call(api.queue, 'GET', '/api/queue', undefined, null)).status).toBe(401);
  expect((await call(api.queue, 'GET', '/api/queue', undefined, await phone())).status).toBe(401);
});

test('the queue is built once for requests that come together', async () => {
  const { call, board, clock } = await setup();
  await call(api.queue, 'GET', '/api/queue');
  const reads = board.reads;
  await call(api.queue, 'GET', '/api/queue');
  expect(board.reads).toBe(reads);
  clock.t += 3_000;
  await call(api.queue, 'GET', '/api/queue');
  expect(board.reads).toBeGreaterThan(reads);
});

test('an action is posted in the session’s thread, as the Mac expects it', async () => {
  const { call, action, board, root, p } = await setup();
  const a = await action();
  const res = await call(api.act, 'POST', '/api/act', { root: root.id, action: a });
  expect(res.status).toBe(200);
  const posted = board.msgs.at(-1)!;
  expect(posted).toMatchObject({ id: `coc-act-${a.nonce}`, re: root.id, labels: { 'coc.do': 'allow' } });
  const sent = JSON.parse(posted.text);
  expect(sent).toEqual(a);
  expect(await verify(p.pub, await signedBytes(sent), sent.sig)).toBe(true);
  // sent twice (a retry): one message
  await call(api.act, 'POST', '/api/act', { root: root.id, action: a });
  expect(board.msgs.filter((m) => m.labels['coc.do']).length).toBe(1);
});

test('an action that is not the caller’s own, or not for their village, is not posted', async () => {
  const { call, action, board, root } = await setup();
  const count = () => board.msgs.length;
  const before = count();
  const other = await phone();
  expect((await call(api.act, 'POST', '/api/act', { root: root.id, action: await action() }, null)).status).toBe(401);
  // signed by another key than the request's
  expect((await call(api.act, 'POST', '/api/act', { root: root.id, action: await action({}, other) })).status).toBe(400);
  // changed after it was signed
  expect((await call(api.act, 'POST', '/api/act', { root: root.id, action: { ...(await action()), do: 'deny' } })).status).toBe(400);
  expect((await call(api.act, 'POST', '/api/act', { root: root.id, action: await action({ do: 'launch' }) })).status).toBe(400);
  expect((await call(api.act, 'POST', '/api/act', { root: root.id, action: await action({ nonce: 'short' }) })).status).toBe(400);
  expect((await call(api.act, 'POST', '/api/act', { root: root.id, action: await action({ do: 'followup', text: 'x'.repeat(9000) }) })).status).toBe(400);
  // a thread in someone else's village, and one that is no session thread
  const bobs = board.add({ channel: 'v/bob/w/x', text: 'x', labels: { 'coc.kind': 'session' } }, { principal: 'vercel:user:u_bob', handle: 'bob/village' });
  const added = 1;
  expect((await call(api.act, 'POST', '/api/act', { root: bobs.id, action: await action() })).status).toBe(404);
  expect((await call(api.act, 'POST', '/api/act', { root: 'msg_1', action: await action() })).status).toBe(404);
  expect((await call(api.act, 'POST', '/api/act', { root: 'msg_nope', action: await action() })).status).toBe(404);
  expect((await call(api.act, 'POST', '/api/act', 'junk')).status).toBe(400);
  expect(count()).toBe(before + added);
});

const ticket = (board: FakeBoard, code = '482913') => board.add({ channel: 'v/ada/remote', text: JSON.stringify({ host: 'h1', code, until: NOW + 60_000, state: 'open' }), labels: { 'coc.kind': 'pair-open', 'coc.code': code } });

test('pairing with an open code posts the request and names the check number', async () => {
  const { call, board } = await setup();
  const t = ticket(board);
  const fresh = await phone();
  const res = await call(api.pair, 'POST', '/api/pair', { code: '482913', public: b64(fresh.pub), name: 'Pixel' }, null);
  expect(res.status).toBe(200);
  expect(res.json).toMatchObject({ owner: 'ada', ticket: t.id, key: fresh.key });
  expect(res.json.check).toMatch(/^\d{3} \d{3}$/);
  const posted = board.msgs.at(-1)!;
  expect(posted).toMatchObject({ re: t.id, labels: { 'coc.kind': 'pair' } });
  expect(JSON.parse(posted.text)).toEqual({ public: b64(fresh.pub), name: 'Pixel' });
});

test('pairing with a wrong code, a bad key or too often writes nothing', async () => {
  const { call, board, deps } = await setup();
  ticket(board);
  const fresh = await phone();
  const before = board.msgs.length;
  expect((await call(api.pair, 'POST', '/api/pair', { code: '000000', public: b64(fresh.pub), name: 'x' }, null)).status).toBe(403);
  expect((await call(api.pair, 'POST', '/api/pair', { code: '48291', public: b64(fresh.pub), name: 'x' }, null)).status).toBe(400);
  expect((await call(api.pair, 'POST', '/api/pair', { code: '482913', public: 'AAAA', name: 'x' }, null)).status).toBe(400);
  expect((await call(api.pair, 'POST', '/api/pair', { code: '482913', public: b64(fresh.pub), name: 'x'.repeat(200) }, null)).status).toBe(400);
  expect(board.msgs.length).toBe(before);
  // a stranger trying codes: after the allowance, not even a lookup
  deps.lookups = new api.Limiter(3);
  for (let i = 0; i < 3; i++) await call(api.pair, 'POST', '/api/pair', { code: `10000${i}`, public: b64(fresh.pub), name: 'x' }, null);
  const reads = board.reads;
  expect((await call(api.pair, 'POST', '/api/pair', { code: '100009', public: b64(fresh.pub), name: 'x' }, null)).status).toBe(429);
  expect(board.reads).toBe(reads);
  expect(board.msgs.length).toBe(before);
});

test('a push address is kept under the phone’s record', async () => {
  const { call, board, p } = await setup();
  const subscription = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } };
  expect((await call(api.push, 'POST', '/api/push', { subscription })).status).toBe(200);
  const posted = board.msgs.at(-1)!;
  expect(posted).toMatchObject({ re: 'msg_1', labels: { 'coc.kind': 'push' } });
  expect(JSON.parse(posted.text)).toEqual({ key: p.key, subscription });
  expect((await call(api.push, 'POST', '/api/push', { subscription }, null)).status).toBe(401);
  expect((await call(api.push, 'POST', '/api/push', { subscription: { endpoint: 'http://insecure', keys: {} } })).status).toBe(400);
});

test('the version is public, and registering watchers needs the setup secret', async () => {
  const { deps } = await setup();
  expect(await api.version(deps).json()).toEqual({ version: '0.1.0' });
  const ask = (h: Record<string, string>) => api.mayRegister(new Request('https://r.example/api/board/watchers', { method: 'POST', headers: h }), deps);
  expect(ask({})).toBe(false);
  expect(ask({ 'x-coc-setup': 'wrong' })).toBe(false);
  expect(ask({ 'x-coc-setup': 'sekret' })).toBe(true);
  expect(api.mayRegister(new Request('https://r.example/api/board/watchers', { method: 'POST', headers: { 'x-coc-setup': '' } }), { ...deps, setup: undefined })).toBe(false);
});
