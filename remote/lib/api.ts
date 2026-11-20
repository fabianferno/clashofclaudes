// The remote's API, with the board and the clock handed in (the routes in `app/api` pass the real
// ones). Everything but pairing and the version needs a request signed by a paired phone.
import { signedBy, type Caller } from './auth';
import { checkNumber, isPublicKey, keyId, sha256Hex, signedBytes, unb64, verify, type Do } from './crypto';
import { buildQueue } from './queue';
import { byOwner, type Records } from './records';
import type { BoardLike, Card, Thread, Working } from './types';

/** At most `max` uses a minute (on this instance): what a stranger trying pairing codes can cost. */
export class Limiter {
  private at: number[] = [];
  constructor(private max: number) {}
  take(now: number): boolean {
    this.at = this.at.filter((t) => now - t < 60_000);
    if (this.at.length >= this.max) return false;
    this.at.push(now);
    return true;
  }
}

interface Queue {
  cards: Card[];
  working: Working[];
  seen: number | null;
}

export interface Deps {
  board: BoardLike;
  records: Records;
  now: () => number;
  /** What `POST /api/board/watchers` must carry (set when the remote was first deployed). */
  setup: string | undefined;
  version: string;
  /** The public half of the push keys, for the page to subscribe with. */
  pushKey?: string;
  lookups: Limiter;
  /** A village's queue, kept for two seconds: several phones, one read of the board. */
  cache: Map<string, { at: number; queue: Queue }>;
}

const QUEUE_MS = 2_000;
const TEXT_MAX = 8_000;
const NAME_MAX = 40;
const WAITING = ['needs_you', 'stuck', 'finished'];
const DOS: Do[] = ['allow', 'deny', 'answer', 'followup'];

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const no = (status: number, error: string) => json({ error }, status);

async function read(req: Request): Promise<{ body: Uint8Array; path: string }> {
  const url = new URL(req.url);
  return { body: new Uint8Array(await req.arrayBuffer()), path: url.pathname + url.search };
}

async function caller(req: Request, d: Deps): Promise<{ who: Caller | null; data: unknown }> {
  const { body, path } = await read(req);
  const who = await signedBy({ method: req.method, path, headers: req.headers, body }, d.records, d.now);
  let data: unknown = null;
  try {
    data = body.length ? JSON.parse(new TextDecoder().decode(body)) : null;
  } catch {
    data = undefined;
  }
  return { who, data };
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

async function villageQueue(owner: string, d: Deps): Promise<Queue> {
  const had = d.cache.get(owner);
  if (had && d.now() - had.at < QUEUE_MS) return had.queue;
  const threads: Thread[] = [];
  for (const channel of await d.board.channels(`v/${owner}/w/`)) {
    for (const root of await d.board.roots(channel, { 'coc.kind': 'session' })) {
      // only a waiting builder's replies are worth a read
      threads.push(WAITING.includes(root.labels['coc.state']) ? await d.board.thread(root.id) : { root, replies: [] });
    }
  }
  const queue = { ...(await buildQueue(threads, owner)), seen: await d.records.seen(owner) };
  if (d.cache.size > 200) d.cache.clear();
  d.cache.set(owner, { at: d.now(), queue });
  return queue;
}

/** `GET /api/queue`: the caller's village. */
export async function queue(req: Request, d: Deps): Promise<Response> {
  const { who } = await caller(req, d);
  if (!who) return no(401, 'pair this phone first');
  return json({ ...(await villageQueue(who.owner, d)), now: d.now() });
}

/** `POST /api/act` `{ root, action }`: posts the phone's signed action in the session's thread. */
export async function act(req: Request, d: Deps): Promise<Response> {
  const { who, data } = await caller(req, d);
  if (!who) return no(401, 'pair this phone first');
  const body = obj(data);
  const a = obj(body?.action);
  if (!body || !a || typeof body.root !== 'string') return no(400, 'not an action');
  const pick = a.pick == null ? undefined : a.pick;
  const text = a.text == null ? undefined : a.text;
  if (
    a.v !== 1 ||
    !DOS.includes(a.do as Do) ||
    typeof a.nonce !== 'string' ||
    !/^[0-9a-f]{32}$/.test(a.nonce) ||
    a.key !== who.key ||
    typeof a.prompt !== 'string' ||
    !/^[0-9a-f]{64}$/.test(a.prompt) ||
    typeof a.sig !== 'string' ||
    (pick !== undefined && !(Number.isInteger(pick) && (pick as number) >= 0 && (pick as number) < 100)) ||
    (text !== undefined && (typeof text !== 'string' || text.length > TEXT_MAX))
  ) {
    return no(400, 'not an action');
  }
  const action = { v: 1 as const, do: a.do as Do, ...(pick !== undefined ? { pick: pick as number } : {}), ...(text !== undefined ? { text: text as string } : {}), nonce: a.nonce, key: who.key, prompt: a.prompt, sig: a.sig };
  // The Mac checks this again; here it keeps junk off the board.
  const phone = await d.records.phone(who.owner, who.key);
  if (!phone || !(await verify(phone.public, await signedBytes(action), action.sig))) return no(400, 'the action is not signed by this phone');
  let thread: Thread;
  try {
    thread = await d.board.thread(body.root);
  } catch {
    return no(404, 'no such builder');
  }
  const { root } = thread;
  if (root.labels['coc.kind'] !== 'session' || !root.channel.startsWith(`v/${who.owner}/w/`) || !byOwner(root, who.owner)) return no(404, 'no such builder');
  const posted = await d.board.reply(root.id, { text: JSON.stringify(action), labels: { 'coc.do': action.do }, id: `coc-act-${action.nonce}` });
  d.cache.delete(who.owner);
  return json({ id: posted.id });
}

/** `POST /api/push` `{ subscription }`: where this phone's notifications go. */
export async function push(req: Request, d: Deps): Promise<Response> {
  const { who, data } = await caller(req, d);
  if (!who) return no(401, 'pair this phone first');
  const s = obj(obj(data)?.subscription);
  const keys = obj(s?.keys);
  if (!s || !keys || typeof s.endpoint !== 'string' || s.endpoint.length > 2000 || !s.endpoint.startsWith('https://') || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    return no(400, 'not a push subscription');
  }
  const subscription = { endpoint: s.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  const id = `coc-push-${who.key}-${(await sha256Hex(new TextEncoder().encode(s.endpoint))).slice(0, 16)}`;
  await d.board.reply(who.record, { text: JSON.stringify({ key: who.key, subscription }), labels: { 'coc.kind': 'push' }, id });
  return json({ ok: true });
}

/**
 * `POST /api/pair` `{ ticket, public, name, mac }`, unsigned: asks the Mac whose pairing ticket
 * is named `ticket` to pair this phone. The name and the proof `mac` are made from the code the
 * Mac shows; the code itself never reaches the remote or the board, and only the Mac can check `mac`.
 */
export async function pair(req: Request, d: Deps): Promise<Response> {
  const { body } = await read(req);
  let data: Record<string, unknown> | null = null;
  try {
    data = obj(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    // below
  }
  if (
    !data ||
    typeof data.ticket !== 'string' ||
    !/^[0-9a-f]{16}$/.test(data.ticket) ||
    typeof data.public !== 'string' ||
    typeof data.name !== 'string' ||
    data.name.length > NAME_MAX ||
    typeof data.mac !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.mac)
  ) {
    return no(400, 'not a pairing request');
  }
  let pub: Uint8Array;
  try {
    pub = unb64(data.public);
  } catch {
    return no(400, 'not a pairing request');
  }
  if (!isPublicKey(pub)) return no(400, 'not a pairing request');
  if (!d.lookups.take(d.now())) return no(429, 'too many tries; wait a minute');
  const ticket = await d.records.openTicket(data.ticket);
  if (!ticket) return no(403, 'that code is not open; look at the Mac for the current one');
  const key = await keyId(pub);
  await d.board.reply(ticket.id, { text: JSON.stringify({ public: data.public, name: data.name, mac: data.mac }), labels: { 'coc.kind': 'pair' }, id: `coc-pairreq-${key}-${ticket.id}` });
  return json({ owner: ticket.owner, ticket: ticket.id, host: ticket.host, key, check: await checkNumber(pub, ticket.id) });
}

/** `GET /api/version`, unsigned: so the Mac can offer an update. */
export function version(d: Deps): Response {
  return json({ version: d.version, ...(d.pushKey ? { push: d.pushKey } : {}) });
}

/** Whether a request may reach the board handle's own routes (watcher registration): it carries the setup secret. */
export function mayRegister(req: Request, d: Deps): boolean {
  const got = req.headers.get('x-coc-setup');
  return !!d.setup && !!got && got.length === d.setup.length && got === d.setup;
}
