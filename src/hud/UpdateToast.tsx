import { useEffect, useRef, useState } from 'react';
import { ipc } from '../api/ipc';

export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Schedules the update check (the backend gates it: debug build, placeholder key and the
 * settings toggle all refuse without a network call) and shows a non-blocking toast when one
 * exists. Every failure is silent here; the backend logs it.
 */
export default function UpdateToast() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // 'installing' while the download runs (with its percent once the size is known); 'installed'
  // once it is in place but the app was not restarted (the user cancelled the restart because
  // sessions run): the button then only restarts, through the same quit guard.
  const [phase, setPhase] = useState<'idle' | 'installing' | 'installed'>('idle');
  const [pct, setPct] = useState<number | null>(null);
  // Guards a second click landing before the disabled button re-renders.
  const busy = useRef(false);
  const install = () => {
    if (busy.current) return;
    busy.current = true;
    setPct(null);
    setPhase('installing');
    ipc.installUpdate().then(() => setPhase('installed'), () => setPhase('idle')).finally(() => { busy.current = false; });
  };
  const restart = () => {
    if (busy.current) return;
    busy.current = true;
    ipc.restartForUpdate().catch(() => {}).finally(() => { busy.current = false; });
  };

  useEffect(() => {
    const check = () => {
      ipc.checkForUpdate().then((s) => { if (s?.available) setAvailable(true); }).catch(() => {});
    };
    let every: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => { check(); every = setInterval(check, CHECK_EVERY_MS); }, FIRST_CHECK_MS);
    const progress = ipc.onUpdateProgress(setPct);
    return () => {
      clearTimeout(first);
      if (every) clearInterval(every);
      void progress.then((un) => un()).catch(() => {});
    };
  }, []);

  if (!available || dismissed) return null;
  return (
    <div className="update-toast" data-testid="update-toast" role="status">
      {phase === 'installed'
        ? (
          <>
            <span className="ol">Update installed — </span>
            <button className="hud-btn sm blue" data-testid="update-restart" onClick={restart}>Restart now</button>
          </>
        )
        : phase === 'installing'
          ? <span className="ol" data-testid="update-progress">{pct === null ? 'Downloading update…' : `Downloading update… ${pct}%`}</span>
          : (
            <>
              <span className="ol">Update available — </span>
              <button className="hud-btn sm blue" data-testid="update-restart" onClick={install}>Restart to update</button>
            </>
          )}
      <button className="update-x" aria-label="Dismiss update notice" onClick={() => setDismissed(true)}>×</button>
    </div>
  );
}
