// The team's board, reached as this project (the deployment's own identity; no token is stored).
import { board } from '@vercel/board';
import { Limiter, type Deps } from './api';
import { Records } from './records';
import type { BoardLike, Msg, Thread } from './types';
import pkg from '../package.json';

/** The board's name on the team: the one named in the Mac app's Settings › Team. */
export const team = board({ name: process.env.COC_BOARD?.trim() || 'village' });

/** The profile the remote writes under: `remote via village-remote`. */
const remote = team.as('remote');

// The SDK's message, as far as this file reads it.
interface Raw {
  id: string;
  channel: string;
  text: string;
  re: string | null;
  labels?: Record<string, string>;
  createdAt: string;
  by?: { principal?: string; profile?: string | null };
  author?: { handle?: string; verified?: boolean };
}

const msg = (m: Raw): Msg => ({
  id: m.id,
  channel: m.channel,
  text: m.text ?? '',
  re: m.re ?? null,
  labels: m.labels ?? {},
  createdAt: m.createdAt,
  by: { principal: m.by?.principal ?? '', profile: m.by?.profile ?? null },
  author: { handle: m.author?.handle ?? '', verified: m.author?.verified === true },
});

const live: BoardLike = {
  async channels(prefix) {
    const names: string[] = [];
    let after: string | undefined;
    // a page at a time; a village has a handful of channels
    for (let page = 0; page < 20; page++) {
      const res = await team.channels({ prefix, limit: 200, after });
      names.push(...res.channels.map((c) => c.path));
      if (!res.next) break;
      after = res.next;
    }
    return names;
  },
  async roots(channel, label) {
    const res = await team.threads({ channel, label, limit: 200 });
    return res.threads.map((t) => msg(t.message as unknown as Raw));
  },
  async thread(root): Promise<Thread> {
    const res = await team.thread(root, { limit: 40 });
    return { root: msg(res.message as unknown as Raw), replies: res.replies.map((m) => msg(m as unknown as Raw)) };
  },
  async reply(to, m) {
    return msg((await remote.reply(to, { text: m.text, labels: m.labels, id: m.id })) as unknown as Raw);
  },
};

/** What the API handlers work with. One per instance: its caches live as long as the instance. */
export const deps: Deps = {
  board: live,
  records: new Records(live),
  now: Date.now,
  setup: process.env.COC_SETUP?.trim() || undefined,
  version: pkg.version,
  lookups: new Limiter(20),
  cache: new Map(),
};
