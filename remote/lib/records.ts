// What the remote believes about a village: who its paired phones are, whether a pairing is open,
// when its Mac was last there. All of it is read from the TEXT of messages written by the village
// owner's own login. Labels only find the messages: anyone who can label can change a label, so a
// label is never believed.
import { isPublicKey, keyId, unb64 } from './crypto';
import type { BoardLike, Msg } from './types';

const HIT_MS = 60_000;
const MISS_MS = 5_000;
const TICKET_MS = 15_000;
const MAX_CACHED = 500;

export const remoteChannel = (owner: string) => `v/${owner}/remote`;

/** A Vercel username, as it may appear in a channel path. */
export const isOwner = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/i.test(s);

/** Whether `m` was written with `owner`'s own login: by them, or by one of their profiles (their Mac). */
export function byOwner(m: Msg, owner: string): boolean {
  if (!m.author.verified || !m.by.principal.startsWith('vercel:user:')) return false;
  return m.author.handle === owner || m.author.handle.startsWith(`${owner}/`);
}

function json(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface PhoneRecord {
  public: Uint8Array;
  name: string;
  /** The record's message: push addresses are replies to it. */
  root: string;
}

export class Records {
  private phoneLists = new Map<string, { at: number; phones: Map<string, PhoneRecord> }>();
  private tickets = new Map<string, { at: number; ticket: { owner: string; id: string; host: string } | null }>();
  private channelList: { at: number; names: string[] } | null = null;

  constructor(
    private board: BoardLike,
    private now: () => number = Date.now,
  ) {}

  private async readPhones(owner: string): Promise<Map<string, PhoneRecord>> {
    const out = new Map<string, PhoneRecord>();
    for (const m of await this.board.roots(remoteChannel(owner), { 'coc.kind': 'phone' })) {
      const v = m.re === null && byOwner(m, owner) ? json(m.text) : null;
      if (!v || v.state !== 'paired' || typeof v.key !== 'string' || typeof v.public !== 'string') continue;
      try {
        const pub = unb64(v.public);
        if (isPublicKey(pub) && (await keyId(pub)) === v.key) out.set(v.key, { public: pub, name: typeof v.name === 'string' ? v.name : 'Phone', root: m.id });
      } catch {
        // not a key: not a phone
      }
    }
    return out;
  }

  /** The village's paired phones, by key id. Cached for a minute. */
  async phones(owner: string): Promise<Map<string, PhoneRecord>> {
    const had = this.phoneLists.get(owner);
    if (had && this.now() - had.at < HIT_MS) return had.phones;
    const phones = await this.readPhones(owner);
    if (this.phoneLists.size >= MAX_CACHED) this.phoneLists.clear();
    this.phoneLists.set(owner, { at: this.now(), phones });
    return phones;
  }

  /** One paired phone. A key that is not there is looked for again after five seconds: a phone just confirmed on the Mac. */
  async phone(owner: string, key: string): Promise<PhoneRecord | null> {
    const had = this.phoneLists.get(owner);
    if (had && !had.phones.has(key) && this.now() - had.at >= MISS_MS) this.phoneLists.delete(owner);
    return (await this.phones(owner)).get(key) ?? null;
  }

  private async remoteChannels(): Promise<string[]> {
    if (this.channelList && this.now() - this.channelList.at < TICKET_MS) return this.channelList.names;
    const names = (await this.board.channels('v/')).filter((c) => /^v\/[^/]+\/remote$/.test(c));
    this.channelList = { at: this.now(), names };
    return names;
  }

  /** Whether `owner` has a village on this board. Asked of a list read at most every 15 seconds, so naming owners that do not exist costs nothing. */
  async hasVillage(owner: string): Promise<boolean> {
    return (await this.remoteChannels()).includes(remoteChannel(owner));
  }

  /**
   * The open pairing ticket named `code` (the name a phone derives from the code it was given), on
   * any village of the board. A name is asked about at most every 15 seconds.
   */
  async openTicket(code: string): Promise<{ owner: string; id: string; host: string } | null> {
    if (!/^[0-9a-f]{16}$/.test(code)) return null;
    const had = this.tickets.get(code);
    if (had && this.now() - had.at < TICKET_MS) return had.ticket;
    let ticket: { owner: string; id: string; host: string } | null = null;
    for (const channel of await this.remoteChannels()) {
      const owner = channel.split('/')[1];
      for (const m of await this.board.roots(channel, { 'coc.kind': 'pair-open', 'coc.code': code })) {
        const v = byOwner(m, owner) ? json(m.text) : null;
        if (v && v.state === 'open' && v.id === code && typeof v.until === 'number' && v.until > this.now()) {
          ticket = { owner, id: m.id, host: typeof v.host === 'string' ? v.host : '' };
        }
      }
    }
    if (this.tickets.size >= MAX_CACHED) this.tickets.clear();
    this.tickets.set(code, { at: this.now(), ticket });
    return ticket;
  }

  /** When one of the owner's Macs last said it was there (ms), or null when none ever did. */
  async seen(owner: string): Promise<number | null> {
    let last: number | null = null;
    for (const m of await this.board.roots(remoteChannel(owner), { 'coc.kind': 'village' })) {
      const v = byOwner(m, owner) ? json(m.text) : null;
      if (v && typeof v.seen === 'number' && (last === null || v.seen > last)) last = v.seen;
    }
    return last;
  }
}
