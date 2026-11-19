import { useState } from 'react';
import { ipc } from '../api/ipc';
import type { AskQuestion } from '../api/types';
import { answerKeys, isAnswered, type AskAnswer } from './askKeys';

const enc = new TextEncoder();
/** Between keystrokes: the picker reads keys sent together as one input. */
const KEY_GAP_MS = 120;

/** Presses `keys` in the session's terminal, one write each. */
async function press(id: string, keys: string[]): Promise<void> {
  for (const [i, k] of keys.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, KEY_GAP_MS));
    await ipc.writeSession(id, Array.from(enc.encode(k)));
  }
}

interface Props {
  sessionId: string;
  questions: AskQuestion[];
  /** Sent: the queue may move on. */
  onAnswered: () => void;
  onError: (e: string) => void;
}

/**
 * The agent's open picker (Claude's AskUserQuestion) as buttons: the same options the terminal
 * offers, plus a line for the owner's own words. One single-choice question goes with one click;
 * several questions, or a multiple-choice one, go together with "Send answers".
 */
export default function QuestionPicker({ sessionId, questions, onAnswered, onError }: Props) {
  const [answers, setAnswers] = useState<AskAnswer[]>(() => questions.map(() => ({ picked: [], text: '' })));
  const [sending, setSending] = useState(false);
  const oneClick = questions.length === 1 && !questions[0].multiSelect;
  const ready = questions.every((q, i) => isAnswered(q, answers[i]));

  const send = async (final: AskAnswer[]) => {
    if (sending) return;
    setSending(true);
    try {
      await press(sessionId, answerKeys(questions, final));
      onAnswered();
    } catch (e) {
      onError(String(e));
      setSending(false);
    }
  };
  const update = (qi: number, f: (a: AskAnswer) => AskAnswer) => setAnswers((all) => all.map((x, i) => (i === qi ? f(x) : x)));
  const pick = (qi: number, oi: number) => {
    if (!questions[qi].multiSelect) {
      const next = { picked: [oi], text: '' }; // one option, or own words: not both
      if (oneClick) void send([next]);
      else update(qi, () => next);
      return;
    }
    update(qi, (a) => ({ ...a, picked: a.picked.includes(oi) ? a.picked.filter((p) => p !== oi) : [...a.picked, oi] }));
  };
  const type = (qi: number, text: string) => update(qi, (a) => ({ picked: questions[qi].multiSelect ? a.picked : [], text }));

  return (
    <div className="ask" data-testid="question-picker">
      {questions.map((q, qi) => {
        const a = answers[qi];
        const many = questions.length > 1;
        return (
          <div key={qi} className={`ask-q${sending ? ' sending' : ''}`} role="group" aria-label={q.question}>
            <div className="ask-legend">
              {q.header && <span className="ask-chip">{q.header}</span>}
              <span className="ask-text">{q.question}</span>
              {q.multiSelect && <span className="ask-hint">pick any</span>}
            </div>
            <div className="ask-opts" role={q.multiSelect ? undefined : 'radiogroup'} aria-label={q.multiSelect ? undefined : q.question}>
              {q.options.map((o, oi) => {
                const on = a.picked.includes(oi);
                return (
                  <button key={oi} type="button" className={`ask-opt${on ? ' on' : ''}`}
                    role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on} disabled={sending}
                    title={oneClick ? 'Answer with this' : undefined} onClick={() => pick(qi, oi)}>
                    <span className="ask-mark" aria-hidden>{q.multiSelect ? (on ? '✓' : '') : oi + 1}</span>
                    <span className="ask-body">
                      <span className="ask-label">{o.label}</span>
                      {o.description && <span className="ask-desc">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            <form className="ask-own" onSubmit={(e) => {
              e.preventDefault();
              if (oneClick && a.text.trim()) void send([a]);
              else if (!oneClick && ready) void send(answers);
            }}>
              <input disabled={sending} aria-label={many ? `Your own answer: ${q.question}` : 'Your own answer'} value={a.text} maxLength={500}
                className={a.text.trim() ? 'on' : undefined}
                placeholder={q.multiSelect ? 'Add your own…' : 'Or type your own answer…'}
                onChange={(e) => type(qi, e.target.value)} />
              {oneClick && <button type="submit" className="hud-btn blue sm" disabled={sending || !a.text.trim()}>Send</button>}
            </form>
          </div>
        );
      })}
      {!oneClick && (
        <button type="button" className="hud-btn blue sm ask-send" disabled={sending || !ready}
          title={ready ? undefined : 'Answer every question first'} onClick={() => void send(answers)}>
          {sending ? 'Sending…' : questions.length > 1 ? 'Send answers' : 'Send answer'}
        </button>
      )}
    </div>
  );
}
