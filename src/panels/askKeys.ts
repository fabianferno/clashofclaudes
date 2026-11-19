import type { AgentKind, AskQuestion } from '../api/types';

/** The owner's answer to one question: the picked options (indexes) and/or their own words. */
export interface AskAnswer {
  picked: number[];
  /** Typed in place of (single-select) or beside (multi-select) the options; empty for none. */
  text: string;
}

const DOWN = '\x1b[B';
const ENTER = '\r';

/** Whether `a` answers `q`: an option or typed words (one option only for a single-select). */
export function isAnswered(q: AskQuestion, a: AskAnswer | undefined): boolean {
  if (!a) return false;
  const typed = a.text.trim() !== '';
  return q.multiSelect ? a.picked.length > 0 || typed : typed || a.picked.length === 1;
}

/** Typed words go into the picker's one-line text row: Enter there submits, so no newlines. */
const oneLine = (t: string) => t.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/**
 * The keystrokes that answer the agent's picker, one write each (keys sent in one write may be
 * read as a single input). Each question starts with the cursor on its first row.
 *
 * Codex's `request_user_input` (single-choice only; protocol in `src-tauri/src/adapters/codex.rs`):
 * the option's digit answers and moves on, the last one submits all; typed words go Down to its
 * "None of the above" row (n+1), Tab to add a note, the words, Enter.
 *
 * Claude Code's AskUserQuestion (protocol in `src-tauri/src/adapters/claude.rs`):
 *   - single-select: the option's digit; typed words: the "Type something" digit (n+1), the
 *     words, Enter.
 *   - multi-select: a digit per picked option (toggles; the cursor stays on row 1); typed words:
 *     Down to "Type something" (row n+1), the words; then Down to its Submit/Next row and Enter.
 *   - several questions, or a multi-select one: `1` ("Submit answers") on the review screen.
 */
export function answerKeys(questions: AskQuestion[], answers: AskAnswer[], agent: AgentKind = 'claude'): string[] {
  if (agent === 'codex') return codexKeys(questions, answers);
  const keys: string[] = [];
  questions.forEach((q, i) => {
    const a = answers[i] ?? { picked: [], text: '' };
    const n = q.options.length;
    const text = oneLine(a.text);
    if (!q.multiSelect) {
      if (text) keys.push(String(n + 1), text, ENTER);
      else keys.push(String(a.picked[0] + 1));
      return;
    }
    for (const p of [...new Set(a.picked)].sort((x, y) => x - y)) keys.push(String(p + 1));
    if (text) {
      for (let r = 0; r < n; r++) keys.push(DOWN);
      keys.push(text, DOWN);
    } else {
      for (let r = 0; r <= n; r++) keys.push(DOWN);
    }
    keys.push(ENTER);
  });
  if (questions.length > 1 || questions.some((q) => q.multiSelect)) keys.push('1');
  return keys;
}

function codexKeys(questions: AskQuestion[], answers: AskAnswer[]): string[] {
  const keys: string[] = [];
  questions.forEach((q, i) => {
    const a = answers[i] ?? { picked: [], text: '' };
    const text = oneLine(a.text);
    if (!text) {
      keys.push(String(a.picked[0] + 1));
      return;
    }
    for (let r = 0; r < q.options.length; r++) keys.push(DOWN);
    keys.push('\t', text, ENTER);
  });
  return keys;
}
