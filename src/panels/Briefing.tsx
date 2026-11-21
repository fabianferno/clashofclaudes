import { useEffect, useMemo, useRef, useState } from 'react';
import { ipc } from '../api/ipc';
import type { Review, SessionInfo } from '../api/types';
import { useApp } from '../state/store';
import { QUEUE_LABEL, ownerQueue, queueReason, waitedLabel, waitingSince, type QueueReason } from '../state/queue';
import { isDemoId } from '../onboarding/demo';
import Markdown, { docPath } from './Markdown';
import QuestionPicker from './QuestionPicker';
import { AttachmentStrip, useAttachments } from './Attachments';
import { plainText } from './markdownText';
import './briefing.css';

const enc = new TextEncoder();
const bytes = (s: string) => Array.from(enc.encode(s));

/**
 * Types `text` into the agent's prompt and submits it: pasted as one block (bracketed paste, as a
 * terminal pastes), then Enter a moment later, so a multi-line reply is not sent line by line.
 */
export async function sendPrompt(id: string, text: string): Promise<void> {
  const t = text.replace(/\r\n?/g, '\n').trim();
  if (!t) return;
  // the tour's sample session reads plain typing
  await ipc.writeSession(id, bytes(isDemoId(id) ? t : `\x1b[200~${t}\x1b[201~`));
  await new Promise((r) => setTimeout(r, 120));
  await ipc.writeSession(id, bytes('\r'));
}

/** A follow-up with its images named by path after it, the way a task's are, so any agent can open them. */
export function withImages(text: string, paths: string[]): string {
  const t = text.trim();
  if (paths.length === 0) return t;
  const head = paths.length === 1 ? 'Image attached to this message' : 'Images attached to this message';
  const body = `${head} (open with your file reading tool):\n${paths.join('\n')}`;
  return t ? `${t}\n\n${body}` : body;
}

/** What the one-click follow-up types: carry on, as planned or as it proposed. */
export const GO_AHEAD = 'Go ahead.';

/**
 * Whether its reply ends by asking whether to carry on ("Want me to proceed?", "Shall I start on
 * the tests?"), so going ahead is the likely answer. A question about something else does not count.
 */
export function asksToGoOn(md: string | null | undefined): boolean {
  if (!md) return false;
  const lines = plainText(md).split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (!last.endsWith('?')) return false;
  return /\b(proceed|go ahead|continue|carry on|move on|shall i|should i|want me to|would you like me to|do you want me to|ready (?:to|for)|ok(?:ay)? to|good to go|sound good|look good)\b/i.test(last);
}

const TAG_COLOR: Record<QueueReason, string> = {
  decide: 'var(--hud-needs)', answer: 'var(--hud-needs)', stuck: 'var(--hud-stuck)', review: 'var(--hud-finished)',
};

interface Props {
  session: SessionInfo;
  canApprove: boolean;
  answering: boolean;
  onAllow: () => void;
  onDeny: () => void;
  /** Accept (`discard` false: closes it, shipped when finished) or Discard (closes it, not shipped). */
  onClose: (discard: boolean) => void;
  /** The owner dealt with it (answered, followed up, parked): the queue may move on. */
  onDealt: () => void;
}

/**
 * What the owner needs to decide on a session that waits on them, on one card: the task, what it
 * asks, its last reply and what it changed; and the ways to close the loop. Only for a session
 * in the owner's queue (or one parked out of it).
 */
export default function Briefing({ session: s, canApprove, answering, onAllow, onDeny, onClose, onDealt }: Props) {
  const sessions = useApp((st) => st.sessions);
  const agent = useApp((st) => (s.kind.kind === 'agent' ? st.builders.find((b) => b.id === (s.kind as { builderId: string }).builderId)?.agent : undefined));
  const workspaces = useApp((st) => st.workspaces);
  const inQueue = useApp((st) => st.selection?.kind === 'session' && st.selection.id === s.id && !!st.selection.queue);
  const queue = useMemo(() => ownerQueue({ sessions, workspaces }), [sessions, workspaces]);
  const reason = queueReason(s) ?? queueReason({ ...s, parked: null });
  const [now, setNow] = useState(Date.now());
  const [review, setReview] = useState<{ key: string; r: Review | null; error?: string } | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [reply, setReply] = useState('');
  // images pasted into the follow-up or dropped on it from Finder
  const replyZone = useRef<HTMLFormElement>(null);
  const att = useAttachments(replyZone);
  const [sending, setSending] = useState(false);
  const [parking, setParking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a plan or spec it pointed to, open for reading in place of the briefing's sections
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const shownFor = useRef(s.id);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // a different session: start clean
  if (shownFor.current !== s.id) {
    shownFor.current = s.id;
    setReply(''); setParking(null); setError(null); setShowFiles(false); setTaskOpen(false); setDoc(null);
  }

  const openDoc = (path: string, from?: string) => {
    // a link inside a doc is relative to that doc's folder
    const want = from && !/^(?:\/|~\/|file:)/.test(path) ? `${from.slice(0, from.lastIndexOf('/') + 1)}${path}` : path;
    const sid = s.id;
    setDoc({ asked: want, back: doc });
    ipc.readSessionDoc(sid, want).then(
      (d) => setDoc((cur) => (cur?.asked === want && shownFor.current === sid ? { ...cur, path: d.path, text: d.text } : cur)),
      (e) => setDoc((cur) => (cur?.asked === want && shownFor.current === sid ? { ...cur, error: String(e) } : cur)),
    );
  };

  // what it changed, read once per wait (a new state may bring new changes)
  const reviewKey = `${s.id}:${s.stateSince ?? 0}:${s.state.kind}`;
  const wantsReview = reason === 'review' || reason === 'answer' || reason === 'decide' || reason === 'stuck';
  useEffect(() => {
    if (!wantsReview) return;
    let live = true;
    Promise.resolve()
      .then(() => ipc.reviewSession(s.id))
      .then((r) => { if (live) setReview({ key: reviewKey, r }); })
      .catch((e) => { if (live) setReview({ key: reviewKey, r: null, error: String(e) }); });
    return () => { live = false; };
  }, [reviewKey, wantsReview, s.id]);

  if (!reason) return null;
  const pos = queue.findIndex((q) => q.session.id === s.id);
  const others = queue.filter((q) => q.session.id !== s.id).length;
  const r = review?.key === reviewKey ? review.r : null;
  const added = r?.files.reduce((n, f) => n + f.added, 0) ?? 0;
  const removed = r?.files.reduce((n, f) => n + f.removed, 0) ?? 0;
  const changed = (r?.files.length ?? 0) + (r?.untracked.length ?? 0);
  const parked = s.parked != null;
  const state = s.state;
  const asked = state.kind === 'needsYou' || state.kind === 'stuck' ? state.reason : null;
  const live = !s.paused && s.state.kind !== 'ended';
  // its open picker, answered here with the same options as in the terminal
  const questions = live && reason !== 'stuck' && s.questions?.length ? s.questions : null;
  // the agent named only the question (its status report has no options): answered in its terminal
  const terminalOnly = !!questions?.every((q) => q.options.length === 0);

  const act = async (p: () => Promise<unknown>, dealt = true) => {
    setError(null);
    try {
      await p();
      if (dealt) onDealt();
    } catch (e) {
      setError(String(e));
    }
  };
  const send = async (text = reply) => {
    const images = att.names;
    if ((!text.trim() && images.length === 0) || sending || att.saving) return;
    setSending(true);
    await act(async () => {
      const paths = images.length && !isDemoId(s.id) ? await ipc.attachToSession(s.id, images) : [];
      att.clear();
      await sendPrompt(s.id, withImages(text, paths));
      setReply('');
    });
    setSending(false);
  };
  const hasReply = !!reply.trim() || att.names.length > 0;
  const park = () => act(async () => {
    useApp.getState().upsertSession(await ipc.parkSession(s.id, (parking ?? '').trim()));
    setParking(null);
  });
  const unpark = () => act(async () => { useApp.getState().upsertSession(await ipc.parkSession(s.id, null)); }, false);
  // typing would land in the picker or the Allow/Deny menu, not in the agent's prompt
  const canReply = live && !questions && !(reason === 'decide' && canApprove);
  // it asked whether to go on: Go ahead stands out, and Enter on the empty box sends it
  const goOn = canReply && !doc && asksToGoOn(s.lastMessage);

  return (
    <div className={`brief sp-box${parked ? ' brief-parked' : ''}${doc ? ' brief-reading' : ''}`} data-testid="briefing">
      <div className="brief-top">
        <span className="brief-tag ol" style={{ background: parked ? 'var(--hud-idle)' : TAG_COLOR[reason] }}>{parked ? 'Parked' : QUEUE_LABEL[reason]}</span>
        <span className="brief-wait">waiting {waitedLabel(now - waitingSince(s))}</span>
        {inQueue && pos >= 0 && <span className="brief-pos">{pos + 1} of {queue.length}</span>}
        {others > 0 && (
          <button type="button" className="sp-link brief-skip" title="Leave this one for now and take the next (⌘J)"
            onClick={() => useApp.getState().takeNext(s.id)}>
            Next ⌘J
          </button>
        )}
      </div>
      {parked && (
        <div className="brief-parknote">
          {s.parked ? <>“{s.parked}”</> : 'Put aside.'} It comes back to your queue when it changes.
          <button type="button" className="sp-link" onClick={() => void unpark()}>Back to queue</button>
        </div>
      )}

      {doc ? (
        <DocReader doc={doc} onBack={() => setDoc(doc.back)} onClose={() => setDoc(null)}
          onOpen={(p) => openDoc(p, doc.path ?? doc.asked)} />
      ) : (<>
      {s.task && (
        <div className="brief-sec">
          <div className="brief-h">Task</div>
          {taskOpen
            ? <>
                <Markdown className="brief-task open md" text={s.task} />
                <button type="button" className="brief-less" onClick={() => setTaskOpen(false)}>Show less</button>
              </>
            : <div className="brief-task" onClick={() => setTaskOpen(true)} title="Show all">{plainText(s.task) || s.task}</div>}
        </div>
      )}

      {questions ? (
        <div className="brief-sec">
          <div className="brief-h">{questions.length > 1 ? `It asks ${questions.length} questions` : 'It asks'}</div>
          {terminalOnly || !agent ? (
            <>
              {questions.map((q, i) => <div key={i} className="ask-text">{q.question}</div>)}
              <div className="sp-d brief-term">Answer it in the terminal below.</div>
            </>
          ) : <QuestionPicker key={`${s.id}:${s.stateSince ?? 0}:${JSON.stringify(questions)}`} sessionId={s.id} agent={agent} questions={questions}
            onAnswered={onDealt} onError={setError} />}
        </div>
      ) : (asked || s.asking) && (
        <div className="brief-sec">
          <div className="brief-h">{reason === 'stuck' ? 'What went wrong' : 'It asks'}</div>
          {asked && <div className="brief-ask">{asked}</div>}
          {s.asking && reason !== 'stuck' && <code className="brief-call">{s.asking}</code>}
        </div>
      )}

      {s.lastMessage && (
        <div className="brief-sec">
          <div className="brief-h">Its last reply</div>
          <Markdown className="brief-reply md" text={s.lastMessage} onDoc={(p) => openDoc(p)} />
        </div>
      )}

      {wantsReview && (
        <div className="brief-sec">
          <div className="brief-h">Changes</div>
          {!review || review.key !== reviewKey ? <div className="sp-d">Reading git…</div>
            : review.error ? <div className="sp-d">{review.error}</div>
            : !r?.isGit ? <div className="sp-d">No git history here; open the folder to look.</div>
            : changed === 0 ? <div className="sp-d">No changes since it started{r.branch ? ` (on ${r.branch})` : ''}.</div>
            : (
              <>
                <button type="button" className="brief-sum" onClick={() => setShowFiles((v) => !v)} aria-expanded={showFiles}>
                  <span className="brief-plus">+{added}</span> <span className="brief-minus">−{removed}</span>
                  {' '}in {changed} {changed === 1 ? 'file' : 'files'}
                  {r.branch && <span className="chip">{r.branch}</span>}
                  <span className="brief-caret">{showFiles ? '▾' : '▸'}</span>
                </button>
                {showFiles && (
                  <ul className="brief-files">
                    {r.files.map((f) => <li key={f.path}><FilePath path={f.path} onOpen={openDoc} /> <b className="brief-plus">+{f.added}</b> <b className="brief-minus">−{f.removed}</b></li>)}
                    {r.untracked.map((p) => <li key={p}><FilePath path={p} onOpen={openDoc} /> <b className="brief-new">new</b></li>)}
                  </ul>
                )}
                {r.otherSessionsActive && <div className="sp-d">Other sessions were working in this folder too.</div>}
              </>
            )}
        </div>
      )}

      </>)}

      {error && <div className="panel-warn">{error}</div>}

      <div className="brief-foot">
      {canReply && (
        <form ref={replyZone} className="brief-reply-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <div className="brief-reply-box">
            <textarea aria-label="Follow up" rows={3} value={reply} disabled={sending}
              placeholder={doc ? 'Follow up on the plan: approve it or ask for changes…' : goOn ? 'Enter to go ahead, or type a reply…' : reason === 'review' ? 'Follow up: ask for a change… (paste or drop images)' : 'Answer it…'}
              onChange={(e) => setReply(e.target.value)}
              onPaste={att.onPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(goOn && !hasReply ? GO_AHEAD : reply);
                }
              }} />
            <AttachmentStrip names={att.names} onRemove={att.remove} />
          </div>
          {hasReply
            ? <button type="submit" className="hud-btn blue sm" disabled={sending || att.saving}>Send</button>
            // the usual follow-up, one click: it stopped to check in, or to ask whether to go on
            : <button type="button" className={`hud-btn blue sm${goOn ? ' brief-goon' : ''}`} disabled={sending} title={`Tell it: "${GO_AHEAD}"`}
                onClick={() => void send(GO_AHEAD)}>Go ahead</button>}
        </form>
      )}

      <div className="brief-actions">
        {reason === 'decide' && canApprove && !questions && (
          <>
            <button className="hud-btn sm" data-tour="allow" disabled={answering} onClick={() => { onAllow(); }}>Allow</button>
            <button className="hud-btn red sm" disabled={answering} onClick={() => { onDeny(); }}>Deny</button>
          </>
        )}
        {reason === 'review' && (
          <button className="hud-btn sm" data-testid="accept" data-tour="close-session" title="Close it: the work is done" onClick={() => onClose(false)}>Accept</button>
        )}
        {!parked && parking === null && (
          <button className="hud-btn grey sm" title="Put it aside, out of your queue, until it changes" onClick={() => setParking('')}>Park</button>
        )}
        <button className="hud-btn grey sm" title={reason === 'review' ? "Close it without taking the work; its changes stay on disk" : 'Close it (not shipped)'}
          onClick={() => onClose(true)}>{reason === 'review' ? 'Discard' : 'Close'}</button>
      </div>
      {parking !== null && (
        <form className="brief-park" onSubmit={(e) => { e.preventDefault(); void park(); }}>
          <input aria-label="Why park it" autoFocus placeholder="A note for later (optional)" value={parking} maxLength={500}
            onChange={(e) => setParking(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setParking(null); } }} />
          <button type="submit" className="hud-btn sm">Park</button>
          <button type="button" className="hud-btn grey sm" onClick={() => setParking(null)}>Cancel</button>
        </form>
      )}
      </div>
    </div>
  );
}

interface OpenDoc {
  /** The path as the agent wrote it (or as a link in another doc resolved it). */
  asked: string;
  /** Read: its absolute path and text. */
  path?: string;
  text?: string;
  error?: string;
  /** The doc it was opened from, for Back. */
  back: OpenDoc | null;
}

/** A changed file's path; a markdown one opens in the reader. */
function FilePath({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  if (!docPath(path)) return <span>{path}</span>;
  return (
    <span><a className="brief-doclink" href="#" title={`Read ${path} here`} onClick={(e) => { e.preventDefault(); onOpen(path); }}>{path}</a></span>
  );
}

/** A plan or spec the agent pointed to, rendered, with the way back to the briefing. */
function DocReader({ doc, onBack, onClose, onOpen }: { doc: OpenDoc; onBack: () => void; onClose: () => void; onOpen: (path: string) => void }) {
  const shown = doc.path ?? doc.asked;
  const name = shown.slice(shown.lastIndexOf('/') + 1);
  return (
    <div className="brief-sec brief-doc" data-testid="doc-reader">
      <div className="brief-doc-bar">
        <button type="button" className="sp-link" onClick={doc.back ? onBack : onClose}>← {doc.back ? 'Back' : 'Briefing'}</button>
        <span className="brief-doc-name" title={shown}>{name}</span>
        {doc.path && (
          <button type="button" className="sp-link" title="Open it in your editor" onClick={() => { void ipc.openInEditor(doc.path!).catch(() => {}); }}>
            Open in editor
          </button>
        )}
      </div>
      {doc.error ? <div className="sp-d">{doc.error}</div>
        : doc.text === undefined ? <div className="sp-d">Reading {name}…</div>
        : <Markdown className="brief-doc-body md" text={doc.text} onDoc={onOpen} />}
    </div>
  );
}
