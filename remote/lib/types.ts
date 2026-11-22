import type { Do } from './crypto';

/** A board message, as far as the remote reads it. */
export interface Msg {
  id: string;
  channel: string;
  text: string;
  /** The root of its thread; null for a root. */
  re: string | null;
  labels: Record<string, string>;
  createdAt: string;
  /** Who wrote it, as the board verified it. */
  by: { principal: string; profile: string | null };
  author: { handle: string; verified: boolean };
}

export interface Thread {
  root: Msg;
  replies: Msg[];
}

/** The board, as the remote uses it (`board.ts` over `@vercel/board`, or a fake in tests). */
export interface BoardLike {
  /** The names of the channels under `prefix`. */
  channels(prefix: string): Promise<string[]>;
  /** The roots of a channel's threads carrying every label in `label`. Labels only find things. */
  roots(channel: string, label: Record<string, string>): Promise<Msg[]>;
  thread(root: string): Promise<Thread>;
  /** Replies as the remote's own profile. `id` makes it idempotent. */
  reply(to: string, m: { text: string; labels: Record<string, string>; id: string }): Promise<Msg>;
  /** Changes the text of a message the remote wrote. */
  edit(id: string, text: string): Promise<void>;
}

/** What the Mac says about one wait, at the end of its reply in the session's thread. */
export interface PromptBlock {
  v: number;
  host: string;
  session: string;
  since: number;
  wait: 'decide' | 'answer' | 'review' | 'stuck';
  can: Do[];
  question?: string | null;
  options?: string[] | null;
}

/** One waiting builder, as the phone shows it. */
export interface Card {
  /** The session thread's root: where an action is posted. */
  root: string;
  workspace: string;
  /** The root's first line: who, and on what. */
  title: string;
  wait: PromptBlock['wait'];
  can: Do[];
  /** The Mac's words for this wait, without the block. */
  prose: string;
  question: string | null;
  options: string[] | null;
  /** When this wait began (ms). */
  waitedFrom: number;
  /** `sha256Hex` of the block's exact bytes: what an action for this card signs. */
  promptSha: string;
  /** An action for this wait is on the board; the Mac's word on it, once it has answered. */
  sent: boolean;
  result: Result | null;
}

export type Result = 'applied' | 'stale' | 'refused' | 'failed';

export interface Working {
  root: string;
  workspace: string;
  title: string;
  state: string;
  /** What a message to it signs (`workingPrompt`); null while it is starting. */
  promptSha: string | null;
  /** The newest message the remote posted in its thread, and the Mac's word on it once it has answered. */
  last: { id: string; result: Result | null } | null;
}
