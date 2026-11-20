// Test helpers: a board held in memory, and a phone that signs.
import { b64, keyId, lowS, requestBytes, signedBytes, type Signable } from './crypto';
import type { BoardLike, Msg, Thread } from './types';

export const OWNER = { principal: 'vercel:user:u_ada', handle: 'ada' };

export class FakeBoard implements BoardLike {
  msgs: Msg[] = [];
  reads = 0;
  private n = 0;

  /** Adds a message; `by` defaults to the owner's Mac (`ada/village`). */
  add(m: Partial<Msg> & { channel: string; text: string }, by: { principal: string; handle: string; verified?: boolean } = { principal: OWNER.principal, handle: 'ada/village' }): Msg {
    const msg: Msg = {
      id: m.id ?? `msg_${++this.n}`,
      channel: m.channel,
      text: m.text,
      re: m.re ?? null,
      labels: m.labels ?? {},
      createdAt: m.createdAt ?? new Date(1_700_000_000_000 + this.msgs.length * 1000).toISOString(),
      by: { principal: by.principal, profile: by.handle.includes('/') ? by.handle.split('/')[1] : null },
      author: { handle: by.handle, verified: by.verified ?? true },
    };
    this.msgs.push(msg);
    return msg;
  }

  async channels(prefix: string): Promise<string[]> {
    this.reads++;
    return [...new Set(this.msgs.map((m) => m.channel))].filter((c) => c.startsWith(prefix)).sort();
  }

  async roots(channel: string, label: Record<string, string>): Promise<Msg[]> {
    this.reads++;
    return this.msgs.filter((m) => m.channel === channel && m.re === null && Object.entries(label).every(([k, v]) => m.labels[k] === v));
  }

  async thread(root: string): Promise<Thread> {
    this.reads++;
    const r = this.msgs.find((m) => m.id === root && m.re === null);
    if (!r) throw new Error('not found');
    return { root: r, replies: this.msgs.filter((m) => m.re === root) };
  }

  async reply(to: string, m: { text: string; labels: Record<string, string>; id: string }): Promise<Msg> {
    const root = this.msgs.find((x) => x.id === to);
    if (!root) throw new Error('not found');
    const had = this.msgs.find((x) => x.id === m.id);
    if (had) return had;
    return this.add({ id: m.id, channel: root.channel, text: m.text, re: root.re ?? root.id, labels: m.labels }, { principal: 'vercel:project:prj_r:production', handle: 'remote' });
  }
}

/** A phone: a P-256 key made as a browser makes it. */
export async function phone() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const key = await keyId(pub);
  const sign = async (bytes: Uint8Array): Promise<string> => {
    for (;;) {
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(bytes)));
      if (lowS(sig)) return b64(sig);
    }
  };
  return {
    pub,
    key,
    sign,
    signAction: async (a: Signable) => sign(await signedBytes(a)),
    /** The four headers of a signed request. */
    headers: async (owner: string, method: string, path: string, ts: number, body = '') => ({
      'x-coc-owner': owner,
      'x-coc-key': key,
      'x-coc-ts': String(ts),
      'x-coc-sig': await sign(await requestBytes(method, path, ts, new TextEncoder().encode(body))),
    }),
  };
}

/** A paired phone's record in `v/<owner>/remote`, as the Mac writes it. */
export function record(board: FakeBoard, owner: string, key: string, pub: Uint8Array, state = 'paired'): Msg {
  return board.add({ channel: `v/${owner}/remote`, text: JSON.stringify({ key, public: b64(pub), name: 'iPhone', state, host: 'h1' }), labels: { 'coc.kind': 'phone', 'coc.key': key } }, { principal: `vercel:user:u_${owner}`, handle: `${owner}/village` });
}
