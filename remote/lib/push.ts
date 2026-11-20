// Notifications: when the owner's Mac writes that a builder waits, every paired phone of that
// village is told. Addresses are replies the remote itself keeps under each phone's record.
import { blockIn } from './queue';
import { byOwner, type Records } from './records';
import type { BoardLike, Msg, PromptBlock } from './types';

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Notice {
  title: string;
  body: string;
}

/** The wait `m` announces, when it is the owner's Mac saying so in a session thread. */
export function waitIn(m: Msg): { owner: string; root: string; workspace: string; block: PromptBlock } | null {
  const parts = m.channel.split('/');
  if (parts[0] !== 'v' || parts[2] !== 'w' || !m.re) return null;
  const owner = parts[1];
  const json = byOwner(m, owner) ? blockIn(m.text) : null;
  if (!json) return null;
  try {
    const block = JSON.parse(json) as PromptBlock;
    if (block.v !== 1 || !['decide', 'answer', 'review', 'stuck'].includes(block.wait)) return null;
    return { owner, root: m.re, workspace: parts.slice(3).join('/'), block };
  } catch {
    return null;
  }
}

const WANTS: Record<PromptBlock['wait'], string> = { decide: 'wants a decision', answer: 'is asking you', review: 'finished', stuck: 'is stuck' };

/** What the notification says. `title`: the session root's first line (`**Wizard** (Claude Code): …`). */
export function notice(title: string, workspace: string, block: PromptBlock): Notice {
  const who = /^\*\*(.+?)\*\*/.exec(title)?.[1] ?? 'A builder';
  return { title: `${who} ${WANTS[block.wait]} · ${workspace}`, body: (block.question ?? '').slice(0, 300) };
}

/** The push addresses of a village's paired phones. `self`: this project's own principal, the only writer believed. */
export async function addresses(board: BoardLike, records: Records, owner: string, self: string): Promise<{ id: string; key: string; subscription: Subscription }[]> {
  const out: { id: string; key: string; subscription: Subscription }[] = [];
  for (const [key, phone] of await records.phones(owner)) {
    const { replies } = await board.thread(phone.root);
    for (const m of replies) {
      if (m.by.principal !== self || m.labels['coc.kind'] !== 'push') continue;
      try {
        const v = JSON.parse(m.text) as { key?: string; subscription?: Subscription; gone?: boolean };
        if (v.key === key && !v.gone && v.subscription?.endpoint?.startsWith('https://')) out.push({ id: m.id, key, subscription: v.subscription });
      } catch {
        // not an address
      }
    }
  }
  return out;
}

export interface Pusher {
  board: BoardLike;
  records: Records;
  self: string;
  /** Sends one push; throws with `statusCode` 404 or 410 when the address no longer exists. */
  send: (to: Subscription, n: Notice & { tag: string }) => Promise<void>;
}

/** Tells the village's phones about the wait in `m`. How many were told. */
export async function notify(m: Msg, p: Pusher): Promise<number> {
  const wait = waitIn(m);
  if (!wait) return 0;
  const { root } = await p.board.thread(wait.root);
  if (!byOwner(root, wait.owner)) return 0;
  const n = { ...notice(root.text.split('\n')[0], wait.workspace, wait.block), tag: wait.root };
  let told = 0;
  for (const a of await addresses(p.board, p.records, wait.owner, p.self)) {
    try {
      await p.send(a.subscription, n);
      told++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await p.board.edit(a.id, JSON.stringify({ key: a.key, gone: true }));
    }
  }
  return told;
}
