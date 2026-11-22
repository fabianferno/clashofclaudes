import { useEffect, useRef, useState } from 'react';
import { ipc } from '../api/ipc';
import { isDemoId } from '../onboarding/demo';
import { AttachmentStrip, useAttachments } from './Attachments';
import { sendPrompt, withImages } from './Briefing';

/**
 * A message for an agent while it works, without opening its terminal: typed into its prompt the
 * same way a follow-up is, so the agent takes it as it would a message typed there mid-turn (Claude
 * Code and Codex pick it up at their next step, without stopping).
 */
export default function SteerBox({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = useRef<HTMLFormElement>(null);
  const att = useAttachments(zone);
  const shownFor = useRef(sessionId);
  // a different session: start clean
  if (shownFor.current !== sessionId) {
    shownFor.current = sessionId;
    setText(''); setSent(false); setError(null);
  }
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), 4000);
    return () => clearTimeout(t);
  }, [sent]);

  const has = !!text.trim() || att.names.length > 0;
  const send = async () => {
    if (!has || sending || att.saving) return;
    const sid = sessionId;
    setSending(true);
    setError(null);
    try {
      const paths = att.names.length && !isDemoId(sid) ? await ipc.attachToSession(sid, att.names) : [];
      att.clear();
      await sendPrompt(sid, withImages(text, paths));
      if (shownFor.current === sid) { setText(''); setSent(true); }
    } catch (e) {
      if (shownFor.current === sid) setError(String(e));
    }
    setSending(false);
  };

  return (
    <div className="brief-foot steer" data-testid="steer-box">
      {error && <div className="panel-warn">{error}</div>}
      <form ref={zone} className="brief-reply-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea aria-label="Message it" rows={2} value={text} disabled={sending}
          placeholder="Tell it something while it works: a correction, a detail it missed… (paste or drop images)"
          onChange={(e) => { setText(e.target.value); setSent(false); }}
          onPaste={att.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }} />
        <button type="submit" className="hud-btn blue sm" disabled={!has || sending || att.saving}>Send</button>
        <AttachmentStrip names={att.names} onRemove={att.remove} />
      </form>
      {sent && <div className="sp-d steer-sent" role="status">Sent to its prompt.</div>}
    </div>
  );
}
