import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { ipc, trimSeen } from '../api/ipc';
import type { Frame } from '../api/types';

// Serialize attach/detach per session id so the backend's per-session channel never gets reordered.
const chains = new Map<string, Promise<void>>();

/** `readOnly`: the session has ended, so there is no process to resize or type into. */
export default function TerminalView({ sessionId, readOnly = false }: { sessionId: string; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Read live by the handlers below; the session can end while it is on screen.
  const readOnlyRef = useRef(readOnly);
  useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    // 2000 lines: every mount builds a fresh buffer, which JSC frees only at a full GC. xterm keeps
    // the last 2000 lines; the backend keeps the last 2 MiB of raw output and replays it on attach,
    // so older output beyond those limits is not shown.
    const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, scrollback: 2000, cursorBlink: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch { /* fall back to the default renderer */ }
    const report = (p: Promise<unknown>) => p.catch((e) => !disposed && setError(String(e)));
    const doFit = () => {
      try { fit.fit(); } catch { return; }
      if (!readOnlyRef.current) report(ipc.resizeSession(sessionId, term.cols, term.rows));
    };
    doFit();

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
      (e) => { if (!disposed) setError(String(e)); },
    );
    chains.set(sessionId, attachP);

    const enc = new TextEncoder();
    const sub = term.onData((d) => {
      if (!readOnlyRef.current) report(ipc.writeSession(sessionId, Array.from(enc.encode(d))));
    });
    const ro = new ResizeObserver(doFit);
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      sub.dispose();
      const detachP = attachP.then(() => ipc.detachSession(sessionId)).catch(() => {});
      chains.set(sessionId, detachP);
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="terminal-wrap">
      {error && <div className="error">{error}</div>}
      <div className="terminal" ref={host} />
    </div>
  );
}
