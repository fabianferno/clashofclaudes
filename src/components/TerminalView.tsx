import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { openUrl } from '@tauri-apps/plugin-opener';
import '@xterm/xterm/css/xterm.css';
import { ipc, trimSeen } from '../api/ipc';
import type { Frame } from '../api/types';
import { zoomKey } from '../village/zoomKey';
import { useTermFont } from './terminalFont';
import { useApp } from '../state/store';

// Serialize attach/detach per session id so the backend's per-session channel never gets reordered.
const chains = new Map<string, Promise<void>>();

/** Shift+Enter sent as the kitty keyboard protocol has it, for programs that asked for that protocol. */
export const SHIFT_ENTER_KITTY = '\x1b[13;2u';
/** Shift+Enter for an agent that did not: ESC then Enter (Alt+Enter), a new line in Claude Code and agy. */
export const SHIFT_ENTER_ALT = '\x1b\r';

/**
 * One xterm per host (the panel, or the pop-out), kept across session switches: a switch detaches
 * the old session, resets the terminal and replays the new session's snapshot. Building a new
 * xterm per switch costs a renderer, a WebGL context and a buffer each time, and in a hidden
 * webview xterm's frame queue never drains, which kept every old buffer alive
 * (docs/verification/plan-2-village.md, remount follow-up).
 *
 * `readOnly`: the session has ended, so there is no process to resize or type into.
 */
export default function TerminalView({ sessionId, readOnly = false }: { sessionId: string; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<{ sid: string; msg: string } | null>(null);
  // Read live by the handlers below; the session can end while it is on screen.
  const readOnlyRef = useRef(readOnly);
  useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);
  const sessionRef = useRef(sessionId);
  // Agents take Shift+Enter as a new line in their prompt; a shell keeps it as Enter.
  const isAgent = useApp((s) => s.sessions[sessionId]?.kind.kind === 'agent');
  const agentRef = useRef(isAgent);
  useEffect(() => { agentRef.current = isAgent; }, [isAgent]);
  // The program on screen turned on the kitty keyboard protocol (CSI > flags u; CSI < u pops it).
  const kittyRef = useRef(false);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  // The terminal has shown a session, so the next one starts with a reset.
  const shownIn = useRef<Terminal | null>(null);

  const fail = (sid: string) => (e: unknown) => setError({ sid, msg: String(e) });
  const fitTo = (sid: string, report: (e: unknown) => void) => {
    const t = termRef.current;
    if (!t) return;
    try { t.fit.fit(); } catch { return; }
    if (!readOnlyRef.current) ipc.resizeSession(sid, t.term.cols, t.term.rows).catch(report);
  };

  // The terminal itself: lives as long as the host.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // 2000 lines: what a full buffer costs (about 1.9 MB). xterm keeps the last 2000 lines; the
    // backend keeps the last 2 MiB of raw output and replays it on attach, so older output beyond
    // those limits is not shown.
    // OSC 8 links (Claude Code prints these): xterm's default handler asks with confirm() and then
    // calls window.open, which the Tauri webview ignores, so hand them to the system browser.
    const term = new Terminal({
      fontFamily: 'Menlo, monospace', fontSize: useTermFont.getState().size, scrollback: 2000, cursorBlink: true,
      linkHandler: { activate: (_e, uri) => { openUrl(uri).catch(fail(sessionRef.current)); } },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch { /* fall back to the default renderer */ }
    termRef.current = { term, fit };

    const csi = [
      term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, () => { kittyRef.current = true; return false; }),
      term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, () => { kittyRef.current = false; return false; }),
      term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, (p) => { kittyRef.current = Number(p[0]) > 0; return false; }),
    ];
    // Shift+Enter: xterm sends a plain Enter, which submits an agent's prompt. A terminal app
    // sends the protocol's Shift+Enter (or Alt+Enter), a new line, so do the same.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.key !== 'Enter' || !ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return true;
      const seq = kittyRef.current ? SHIFT_ENTER_KITTY : agentRef.current ? SHIFT_ENTER_ALT : null;
      if (!seq) return true;
      if (ev.type === 'keydown' && !readOnlyRef.current) {
        const sid = sessionRef.current;
        ipc.writeSession(sid, Array.from(new TextEncoder().encode(seq))).catch(fail(sid));
      }
      ev.preventDefault();
      return false; // not xterm's own Enter (keydown nor keypress)
    });

    const enc = new TextEncoder();
    const sub = term.onData((d) => {
      const sid = sessionRef.current;
      if (!readOnlyRef.current) ipc.writeSession(sid, Array.from(enc.encode(d))).catch(fail(sid));
    });
    const ro = new ResizeObserver(() => fitTo(sessionRef.current, fail(sessionRef.current)));
    ro.observe(el);

    // ⌘+ / ⌘- / ⌘0 size the text, like any terminal app: in a pop-out (it covers the village), or
    // while typing here. Otherwise they are the village's zoom.
    const onKey = (e: KeyboardEvent) => {
      const z = zoomKey(e);
      if (!z || !(el.closest('.popout') || el.contains(document.activeElement))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      useTermFont.getState().zoom(z);
    };
    window.addEventListener('keydown', onKey, true);
    const unFont = useTermFont.subscribe((f) => {
      if (term.options.fontSize === f.size) return;
      term.options.fontSize = f.size;
      fitTo(sessionRef.current, fail(sessionRef.current));
    });

    return () => {
      window.removeEventListener('keydown', onKey, true);
      csi.forEach((d) => d.dispose());
      unFont();
      ro.disconnect();
      sub.dispose();
      termRef.current = null;
      term.dispose();
    };
  }, []);

  // The session on screen: attach, replay its snapshot, stream its frames; detach when it changes.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    const { term } = t;
    setError(null); // an error from an earlier visit to this session is stale now
    let disposed = false;
    const report = (e: unknown) => { if (!disposed) fail(sessionId)(e); };

    if (shownIn.current === term) {
      // Output still queued for the previous session is parsed first, and xterm's automatic
      // replies to it (cursor reports, device attributes) still go to that session. Only then
      // does input switch to this session, and screen and scrollback are cleared. Everything
      // for this session is written after. (A later switch queues its own callback after this.)
      term.write('', () => {
        if (!disposed) sessionRef.current = sessionId;
        term.reset();
        kittyRef.current = false;
      });
    } else {
      sessionRef.current = sessionId;
    }
    shownIn.current = term;
    fitTo(sessionId, report);

    // Flow control: the backend sends the next frame only after we ack this one's end offset,
    // once xterm has actually written it.
    const ack = (end: number) => { if (!disposed) ipc.ackOutput(sessionId, end).catch(() => {}); };

    // Frames that arrive before the snapshot is written are queued.
    let writtenUntil: number | null = null;
    const queue: Frame[] = [];
    const apply = (f: Frame) => {
      if (f.marker) { term.write(f.data); return; } // display-only; not in the stream, not acked
      const end = f.offset + f.data.length;
      const r = trimSeen(f, writtenUntil ?? 0);
      writtenUntil = r.writtenUntil;
      if (r.data.length) term.write(r.data, () => ack(end));
      else ack(end);
    };
    const onFrame = (f: Frame) => disposed ? undefined : (writtenUntil === null ? queue.push(f) : apply(f));

    const prev = chains.get(sessionId) ?? Promise.resolve();
    const attachP = prev.then(() => (disposed ? undefined : ipc.attachSession(sessionId, onFrame))).then(
      (snap) => {
        if (disposed || !snap) return;
        const end = snap.offset + snap.data.length;
        term.write(snap.data, () => ack(end));
        writtenUntil = end;
        queue.splice(0).forEach(apply);
      },
      report,
    );
    chains.set(sessionId, attachP);

    return () => {
      disposed = true;
      const detachP = attachP.then(() => ipc.detachSession(sessionId)).catch(() => {});
      chains.set(sessionId, detachP);
    };
  }, [sessionId]);

  return (
    <div className="terminal-wrap">
      {error?.sid === sessionId && <div className="error">{error.msg}</div>}
      <div className="terminal" ref={host} />
    </div>
  );
}
