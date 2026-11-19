import { useEffect, useRef, useState } from 'react';
import { ipc } from '../api/ipc';
import { useApp } from '../state/store';

/** Typing rests this long before the pad is saved. */
export const NOTES_SAVE_MS = 600;

/** A line's list marker or checkbox ("- ", "1. ", "[ ] "), dropped when it becomes a task. */
const MARKER = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s+)?/;

/** What a button takes from the pad: the selection, else the line the cursor is on; and the range to remove for a move. */
export function pickedText(value: string, start: number, end: number): { text: string; from: number; to: number } {
  if (start !== end) {
    const a = Math.min(start, end), b = Math.max(start, end);
    return { text: value.slice(a, b).trim(), from: a, to: b };
  }
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const nl = value.indexOf('\n', start);
  const to = nl < 0 ? value.length : nl + 1; // the line and its newline
  return { text: value.slice(from, nl < 0 ? value.length : nl).replace(MARKER, '').trim(), from, to };
}

/**
 * A workspace's notepad: ideas and reminders kept on the workspace itself, apart from the To Do
 * (tasks ready for a builder). Saved as it is typed, in the app's data only. The selection (or
 * the line the cursor is on) can move to the To Do or start a session.
 */
export default function WorkspaceNotes({ workspaceId, onStartSession }: { workspaceId: string; onStartSession: (task: string) => void }) {
  const saved = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.notes ?? '');
  const [text, setText] = useState(saved);
  // what the buttons would take: its text, and whether it is a selection (else the cursor's line)
  const [picked, setPicked] = useState({ text: '', selection: false });
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(text);
  latest.current = text;

  const save = (t: string) => {
    setError(null);
    return ipc.setWorkspaceNotes(workspaceId, t).then(
      (w) => useApp.getState().updateWorkspace(w),
      (e) => setError(String(e)),
    );
  };
  // saved elsewhere (a To Do moved out of it, another window): taken when nothing waits to be saved
  useEffect(() => {
    if (!timer.current && saved !== latest.current) setText(saved);
  }, [saved]);
  // leaving with typing not yet saved: save it now
  useEffect(() => () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; void save(latest.current); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (t: string) => {
    setText(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void save(t); }, NOTES_SAVE_MS);
  };
  const readPick = () => {
    const el = area.current;
    setPicked(el ? { text: pickedText(el.value, el.selectionStart, el.selectionEnd).text, selection: el.selectionStart !== el.selectionEnd } : { text: '', selection: false });
  };
  const pick = () => {
    const el = area.current;
    return el ? pickedText(el.value, el.selectionStart, el.selectionEnd) : null;
  };

  const toTodo = async () => {
    const p = pick();
    if (!p?.text) return;
    setError(null);
    try {
      const st = useApp.getState();
      st.addTodo(await ipc.addTodo(workspaceId, p.text));
      // moved, not copied: it leaves the pad
      const rest = text.slice(0, p.from) + text.slice(p.to);
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      setText(rest);
      setPicked({ text: '', selection: false });
      await save(rest);
      st.notify('Moved to the To Do');
    } catch (e) {
      setError(String(e));
    }
  };
  const toSession = () => {
    const p = pick();
    if (p?.text) onStartSession(p.text);
  };
  const what = picked.selection ? 'the selection' : 'this line';

  return (
    <div className="sp-notes">
      <div className="sp-sec">Notes</div>
      <textarea ref={area} aria-label="Notes" value={text} spellCheck rows={Math.min(12, Math.max(3, text.split('\n').length + 1))}
        placeholder="Ideas and reminders for later: “add export”, “look at the flaky test”. Kept on this computer only."
        onChange={(e) => { change(e.target.value); readPick(); }}
        onSelect={readPick} onKeyUp={readPick} onClick={readPick} />
      {error && <div className="panel-warn">{error}</div>}
      <div className="sp-btns sp-notes-btns">
        {/* mousedown kept from the buttons, so the pad keeps its selection */}
        <button className="hud-btn sm" disabled={!picked.text} title={`Move ${what} to the To Do`}
          onMouseDown={(e) => e.preventDefault()} onClick={() => void toTodo()}>Move to To Do</button>
        <button className="hud-btn blue sm" disabled={!picked.text} title={`Start a session with ${what} as its task`}
          onMouseDown={(e) => e.preventDefault()} onClick={toSession}>Start a session</button>
        {!picked.text && <span className="sp-d">Select text, or put the cursor on a line.</span>}
      </div>
    </div>
  );
}
