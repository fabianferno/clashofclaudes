// The owner's queue, as the phone shows it, built from a village's session threads. What a card
// says and what its buttons sign come from the Mac's own replies (written by the owner's login),
// never from a label or from anyone else's message. The thread's `coc.state` label only decides
// whether a builder is listed as waiting or working; the Mac checks every action anyway.
import { sha256Hex } from './crypto';
import { byOwner } from './records';
import type { Card, Msg, PromptBlock, Thread, Working } from './types';

const FENCE_OPEN = '\n\n```json coc\n';
const FENCE_CLOSE = '\n```';

/** The prompt block that ends `text`, exactly as written (its bytes are what gets hashed). */
export function blockIn(text: string): string | null {
  if (!text.endsWith(FENCE_CLOSE)) return null;
  const body = text.slice(0, -FENCE_CLOSE.length);
  const at = body.lastIndexOf(FENCE_OPEN);
  if (at < 0) return null;
  const json = body.slice(at + FENCE_OPEN.length);
  return json.includes('\n') ? null : json;
}

const WAITS = ['decide', 'answer', 'stuck', 'review'] as const;
const DOS = ['allow', 'deny', 'answer', 'followup'];

function parseBlock(json: string): PromptBlock | null {
  try {
    const v = JSON.parse(json) as PromptBlock;
    if (v?.v !== 1 || !WAITS.includes(v.wait) || !Array.isArray(v.can) || typeof v.since !== 'number') return null;
    return { ...v, can: v.can.filter((d) => DOS.includes(d)) };
  } catch {
    return null;
  }
}

const WAITING: Record<string, PromptBlock['wait']> = { needs_you: 'decide', stuck: 'stuck', finished: 'review' };
const firstLine = (text: string) => text.split('\n')[0].slice(0, 200);
const workspaceOf = (channel: string) => channel.split('/').slice(3).join('/');

function result(text: string): { re: string; result: string } | null {
  try {
    const v = JSON.parse(text) as { re?: unknown; result?: unknown };
    return typeof v.re === 'string' && typeof v.result === 'string' ? { re: v.re, result: v.result } : null;
  } catch {
    return null;
  }
}

async function card(root: Msg, replies: Msg[], owner: string): Promise<Card> {
  const state = root.labels['coc.state'];
  const base: Card = {
    root: root.id,
    workspace: workspaceOf(root.channel),
    title: firstLine(root.text),
    wait: (WAITS as readonly string[]).includes(root.labels['coc.wait']) ? (root.labels['coc.wait'] as PromptBlock['wait']) : WAITING[state],
    can: [],
    prose: '',
    question: null,
    options: null,
    waitedFrom: Date.parse(root.createdAt),
    promptSha: '',
    sent: false,
    result: null,
  };
  // the newest block the owner's Mac wrote
  let at = -1;
  let json: string | null = null;
  replies.forEach((m, i) => {
    const j = byOwner(m, owner) ? blockIn(m.text) : null;
    if (j && parseBlock(j)) {
      at = i;
      json = j;
    }
  });
  if (json === null) return base;
  const block = parseBlock(json)!;
  const reply = replies[at];
  const after = replies.slice(at + 1);
  // an action is a reply the remote posted (a project's identity); anyone can put the label on anything
  const actions = after.filter((m) => 'coc.do' in m.labels && m.by.principal.startsWith('vercel:project:')).map((m) => m.id);
  const results = after.flatMap((m) => (byOwner(m, owner) ? [result(m.text)] : [])).filter((r) => r !== null && actions.includes(r.re));
  const last = results.at(-1)?.result;
  return {
    ...base,
    wait: block.wait,
    can: block.can,
    prose: reply.text.slice(0, reply.text.lastIndexOf(FENCE_OPEN)),
    question: block.question ?? null,
    options: block.options ?? null,
    waitedFrom: Date.parse(reply.createdAt),
    promptSha: await sha256Hex(new TextEncoder().encode(json)),
    sent: actions.length > 0,
    result: last === 'applied' || last === 'stale' || last === 'refused' || last === 'failed' ? last : null,
  };
}

/** Cards for the builders that wait, in the Mac's queue order, and a list of the ones at work. */
export async function buildQueue(threads: Thread[], owner: string): Promise<{ cards: Card[]; working: Working[] }> {
  const cards: Card[] = [];
  const working: Working[] = [];
  for (const { root, replies } of threads) {
    if (root.labels['coc.kind'] !== 'session' || !byOwner(root, owner) || !root.channel.startsWith(`v/${owner}/w/`)) continue;
    const state = root.labels['coc.state'];
    if (state in WAITING) cards.push(await card(root, replies, owner));
    else if (state === 'working' || state === 'starting') working.push({ root: root.id, workspace: workspaceOf(root.channel), title: firstLine(root.text), state });
  }
  cards.sort((a, b) => WAITS.indexOf(a.wait) - WAITS.indexOf(b.wait) || a.waitedFrom - b.waitedFrom || a.root.localeCompare(b.root));
  return { cards, working };
}
