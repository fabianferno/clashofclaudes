// The team's board, reached as this project (the deployment's own identity; no token is stored).
import { board } from '@vercel/board';
import { Limiter, type Deps } from './api';
import { Records } from './records';
import type { BoardLike, Msg, Thread } from './types';
import pkg from '../package.json';
import webpush from 'web-push';
import { notify, type Pusher } from './push';

/** The board's name on the team: the one named in the Mac app's Settings › Team. */
export const team = board({
  name: process.env.COC_BOARD?.trim() || 'village',
  watch: {
    // A builder started waiting: the village's paired phones are told. The Mac's own wait reply
    // is what counts (written by the owner's login, ending in a prompt block); see `push.ts`.
    notify: {
      tail: 'v/',
      run: async ({ event }) => {
        if (event.type !== 'message.posted' || !event.message?.re) return;
        await notify(msg(event.message as unknown as Raw), await pusher());
      },
    },
  },
});

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
  async edit(id, text) {
    await remote.edit(id, text);
  },
};

/** What the API handlers work with. One per instance: its caches live as long as the instance. */
export const deps: Deps = {
  board: live,
  records: new Records(live),
  now: Date.now,
  setup: process.env.COC_SETUP?.trim() || undefined,
  version: pkg.version,
  pushKey: process.env.VAPID_PUBLIC?.trim() || undefined,
  lookups: new Limiter(20),
  cache: new Map(),
};

/** The push keys' public half, for the page to subscribe with; undefined when the remote has none. */
export const pushKey = process.env.VAPID_PUBLIC?.trim() || undefined;

let self: Promise<string> | null = null;

/** What `notify` sends with: this project's identity, and web push signed with the deploy's keys. */
async function pusher(): Promise<Pusher> {
  self ??= team.me().then((me) => me.principal);
  const pub = pushKey;
  const priv = process.env.VAPID_PRIVATE?.trim();
  const site = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? 'village-remote.vercel.app'}`;
  return {
    board: live,
    records: deps.records,
    self: await self,
    send: async (to, n) => {
      if (!pub || !priv) return;
      await webpush.sendNotification(to, JSON.stringify(n), { vapidDetails: { subject: site, publicKey: pub, privateKey: priv }, TTL: 3600, urgency: 'high' });
    },
  };
}
