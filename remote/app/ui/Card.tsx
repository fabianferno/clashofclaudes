'use client';
import { useState } from 'react';
import type { Do } from '../../lib/crypto';
import type { Card as CardData, Working } from '../../lib/types';
import type { PhoneApi } from './phone-api';

const WAIT: Record<CardData['wait'], string> = { decide: 'Wants a decision', answer: 'Asking you', stuck: 'Stuck', review: 'Ready to review' };
const RESULT: Record<NonNullable<CardData['result']>, string> = { applied: 'Done', stale: 'Too late: it had moved on', refused: 'Your Mac refused it', failed: 'Your Mac could not do it' };

/** `**Wizard** (Claude Code): add a CSV export` as its parts. */
export function parts(title: string): { who: string; agent: string; task: string } {
  const m = /^\*\*(.+?)\*\*(?: \((.+?)\))?:?\s*(.*)$/.exec(title);
  return m ? { who: m[1], agent: m[2] ?? '', task: m[3] } : { who: 'A builder', agent: '', task: title };
}

export function waited(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ${min % 60} min` : `${Math.floor(h / 24)} d`;
}

const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Signs an action for the wait `prompt` names and posts it in the thread at `root`; the posted message's id. */
async function postAction(phone: PhoneApi, root: string, prompt: string, d: Do, extra: { pick?: number; text?: string } = {}): Promise<string> {
  const signable = { do: d, ...extra, nonce: nonce(), prompt };
  const action = { v: 1, ...signable, key: phone.key, sig: await phone.signAction(signable) };
  const res = await phone.api('/api/act', { method: 'POST', body: JSON.stringify({ root, action }) });
  const body = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `The remote answered ${res.status}`);
  return body?.id ?? '';
}

/** One waiting builder: what it wants, and the answers the Mac will take. */
export function Card({ card, phone, onSent }: { card: CardData; phone: PhoneApi; onSent?: () => void }) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [words, setWords] = useState('');
  const { who, agent, task } = parts(card.title);
  const can = (d: Do) => card.can.includes(d);

  const send = async (d: Do, extra: { pick?: number; text?: string } = {}) => {
    setBusy(true);
    setError(null);
    try {
      await postAction(phone, card.root, card.promptSha, d, extra);
      setSent(true);
      onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // refused or failed: nothing was done, so the same wait can be answered again
  const again = card.result === 'refused' || card.result === 'failed';
  const done = (sent || card.sent) && !again;
  const typed = words.trim();
  const picker = can('answer') && card.options !== null;
  const wordsFor: Do | null = can('followup') ? 'followup' : can('answer') ? 'answer' : null;
  const label = wordsFor === 'followup' ? 'Follow up' : picker ? 'Your own answer' : 'Your answer';

  return (
    <article className={`card wait-${card.wait}`}>
      <header className="card-head">
        <h2>{who}</h2>
        <p className="card-where">
          {WAIT[card.wait]} in {card.workspace}, {waited(Date.now() - card.waitedFrom)}
        </p>
      </header>
      {task && <p className="card-task">{agent ? `${agent}: ${task}` : task}</p>}
      {/* A decision shows only the command the signature covers. The words around the block are
          not signed, so a card never asks for an Allow on their strength. */}
      {card.wait === 'decide' ? (
        card.question ? <pre className="card-ask">{card.question}</pre> : <p className="card-prose">This village does not share what it wants to run. Look on your Mac, or turn on Share details there.</p>
      ) : (
        card.prose && <p className="card-prose">{picker && card.question ? card.question : card.prose}</p>
      )}

      {again && <p className={`card-result ${card.result}`} role="status">{RESULT[card.result!]}</p>}
      {done ? (
        <p className={`card-result ${card.result ?? 'sent'}`} role="status">
          {card.result ? RESULT[card.result] : 'Sent to your Mac'}
        </p>
      ) : card.can.length === 0 ? (
        <p className="card-result mac">Answer this one on your Mac</p>
      ) : (
        <div className="card-acts">
          {can('allow') && (
            <div className="pair-row">
              <button type="button" className="btn deny" disabled={busy} onClick={() => send('deny')}>Deny</button>
              <button type="button" className="btn allow" disabled={busy} onClick={() => send('allow')}>Allow</button>
            </div>
          )}
          {picker && card.options!.map((o, i) => (
            <button key={i} type="button" className="btn option" disabled={busy} onClick={() => send('answer', { pick: i })}>{o}</button>
          ))}
          {wordsFor && (
            <form className="words" onSubmit={(e) => { e.preventDefault(); if (typed) void send(wordsFor, { text: typed }); }}>
              <textarea aria-label={label} placeholder={label} rows={2} value={words} onChange={(e) => setWords(e.target.value)} />
              <button type="submit" className="btn send" disabled={busy || !typed}>Send</button>
            </form>
          )}
        </div>
      )}
      {error && <p className="card-error" role="alert">{error}</p>}
    </article>
  );
}

const MESSAGE_RESULT: Record<NonNullable<CardData['result']>, string> = {
  applied: 'Your Mac typed it in',
  stale: 'Too late: it had stopped working. Look in your queue.',
  refused: 'Your Mac refused it',
  failed: 'Your Mac could not type it in',
};

/** A builder at work, and a way to tell it something without waiting for it to stop. */
export function WorkingRow({ w, phone, onSent }: { w: Working; phone: PhoneApi; onSent?: () => void }) {
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the message this phone just posted, until the Mac's word on it shows
  const [sentId, setSentId] = useState<string | null>(null);
  const { who, task } = parts(w.title);
  const typed = words.trim();

  const send = async () => {
    if (!w.promptSha || !typed) return;
    setBusy(true);
    setError(null);
    try {
      setSentId(await postAction(phone, w.root, w.promptSha, 'followup', { text: typed }));
      setWords('');
      onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const mine = sentId !== null && w.last?.id === sentId ? w.last : null;
  const status = sentId === null ? null : mine?.result ? MESSAGE_RESULT[mine.result] : 'Sent to your Mac';
  return (
    <li>
      <b>{who}</b> <span>{task}</span> <i>{w.workspace}</i>
      {w.promptSha && !open && (
        <button type="button" className="btn quiet tell" onClick={() => setOpen(true)}>Message</button>
      )}
      {w.promptSha && open && (
        <form className="words tell-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea aria-label={`Message ${who}`} placeholder="Tell it something while it works" rows={2} autoFocus value={words}
            onChange={(e) => setWords(e.target.value)} />
          <button type="submit" className="btn send" disabled={busy || !typed}>Send</button>
        </form>
      )}
      {status && <p className={`tell-status ${mine?.result ?? 'sent'}`} role="status">{status}</p>}
      {error && <p className="card-error" role="alert">{error}</p>}
    </li>
  );
}
