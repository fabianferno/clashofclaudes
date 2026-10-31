import { useEffect, useState } from 'react';
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

  useEffect(() => {
    const check = () => {
      ipc.checkForUpdate().then((s) => { if (s?.available) setAvailable(true); }).catch(() => {});
    };
    let every: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => { check(); every = setInterval(check, CHECK_EVERY_MS); }, FIRST_CHECK_MS);
    return () => { clearTimeout(first); if (every) clearInterval(every); };
  }, []);

  if (!available || dismissed) return null;
  return (
    <div className="update-toast" data-testid="update-toast" role="status">
      <span className="ol">Update available — </span>
      <button className="hud-btn sm blue" data-testid="update-restart" onClick={() => { ipc.installUpdate().catch(() => {}); }}>Restart to update</button>
      <button className="update-x" aria-label="Dismiss update notice" onClick={() => setDismissed(true)}>×</button>
    </div>
  );
}
