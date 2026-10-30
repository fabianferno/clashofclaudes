import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { ipc, trimSeen } from '../api/ipc';
import type { Frame } from '../api/types';

// Serialize attach/detach per session id so the backend's per-session channel never gets reordered.
const chains = new Map<string, Promise<void>>();

export default function TerminalView({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, scrollback: 5000, cursorBlink: true });
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
      report(ipc.resizeSession(sessionId, term.cols, term.rows));
    };
    doFit();

    // Frames that arrive before the snapshot is written are queued.
    let writtenUntil: number | null = null;
    const queue: Frame[] = [];
    const apply = (f: Frame) => {
      const r = trimSeen(f, writtenUntil ?? 0);
      writtenUntil = r.writtenUntil;
      if (r.data.length) term.write(r.data);
    };
    const onFrame = (f: Frame) => disposed ? undefined : (writtenUntil === null ? queue.push(f) : apply(f));

    const prev = chains.get(sessionId) ?? Promise.resolve();
    const attachP = prev.then(() => (disposed ? undefined : ipc.attachSession(sessionId, onFrame))).then(
      (snap) => {
        if (disposed || !snap) return;
        term.write(snap.data);
        writtenUntil = snap.offset + snap.data.length;
        queue.splice(0).forEach(apply);
      },
      (e) => { if (!disposed) setError(String(e)); },
    );
    chains.set(sessionId, attachP);

    const enc = new TextEncoder();
    const sub = term.onData((d) => report(ipc.writeSession(sessionId, Array.from(enc.encode(d)))));
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
