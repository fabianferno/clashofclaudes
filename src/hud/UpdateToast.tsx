import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { ipc } from '../api/ipc';
import { useApp, type FoundUpdate } from '../state/store';

export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Where an update about to install leaves its version and notes, for the "Updated" note after the restart. */
export const INSTALLING_KEY = 'coc.installingUpdate';

const remember = (u: FoundUpdate) => {
  try { localStorage.setItem(INSTALLING_KEY, JSON.stringify(u)); } catch { /* no storage: no note after the restart */ }
};

/** The update installed before this launch, once: only when this app is now that version. */
async function justUpdated(): Promise<FoundUpdate | null> {
  let saved: FoundUpdate | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(INSTALLING_KEY) ?? 'null');
    localStorage.removeItem(INSTALLING_KEY);
  } catch {
    return null;
  }
  if (!saved?.version) return null;
  const now = await getVersion().catch(() => null);
  return now === saved.version ? saved : null;
}

/** Release notes, collapsed behind "What's new". */
function Notes({ notes }: { notes: string | null }) {
  const [open, setOpen] = useState(false);
  if (!notes?.trim()) return null;
  return (
    <>
      <button className="update-notes-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>What's new</button>
      {open && <div className="update-notes" data-testid="update-notes">{notes.trim()}</div>}
    </>
  );
}

/**
 * Schedules the update check (the backend gates it: debug build, placeholder key and the
 * settings toggle all refuse without a network call) and shows a non-blocking toast when one
 * exists, naming the version with its notes. After the restart it says once what was installed.
 * Every failure is silent here; the backend logs it.
 */
export default function UpdateToast() {
  const available = useApp((s) => s.updateAvailable);
  const [dismissed, setDismissed] = useState(false);
  const [updated, setUpdated] = useState<FoundUpdate | null>(null);
  // 'installing' while the download runs (with its percent once the size is known); 'installed'
  // once it is in place but the app was not restarted (the user cancelled the restart because
  // sessions run): the button then only restarts, through the same quit guard.
  const [phase, setPhase] = useState<'idle' | 'installing' | 'installed'>('idle');
  const [pct, setPct] = useState<number | null>(null);
  // Guards a second click landing before the disabled button re-renders.
  const busy = useRef(false);
  const install = () => {
    if (busy.current || !available) return;
    busy.current = true;
    setPct(null);
    setPhase('installing');
    remember(available); // the restart can come before installUpdate resolves
    ipc.installUpdate().then(() => setPhase('installed'), () => setPhase('idle')).finally(() => { busy.current = false; });
  };
  const restart = () => {
    if (busy.current) return;
    busy.current = true;
    ipc.restartForUpdate().catch(() => {}).finally(() => { busy.current = false; });
  };

  useEffect(() => {
    let live = true;
    void justUpdated().then((u) => { if (live && u) setUpdated(u); });
    const check = () => {
      ipc.checkForUpdate().then((s) => {
        if (s?.available) useApp.getState().setUpdateAvailable({ version: s.version ?? null, notes: s.notes ?? null });
      }).catch(() => {});
    };
    let every: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => { check(); every = setInterval(check, CHECK_EVERY_MS); }, FIRST_CHECK_MS);
    const progress = ipc.onUpdateProgress(setPct);
    return () => {
      live = false;
      clearTimeout(first);
      if (every) clearInterval(every);
      void progress.then((un) => un()).catch(() => {});
    };
  }, []);

  if (available && !dismissed) {
    const version = available.version ? `Version ${available.version}` : 'An update';
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
                <span className="ol">{version} is out — </span>
                <Notes notes={available.notes} />
                <button className="hud-btn sm blue" data-testid="update-restart" onClick={install}>Restart to update</button>
              </>
            )}
        <button className="update-x" aria-label="Dismiss update notice" onClick={() => setDismissed(true)}>×</button>
      </div>
    );
  }
  if (updated) {
    return (
      <div className="update-toast" data-testid="update-done" role="status">
        <span className="ol">Updated to {updated.version}</span>
        <Notes notes={updated.notes} />
        <button className="update-x" aria-label="Dismiss update notice" onClick={() => setUpdated(null)}>×</button>
      </div>
    );
  }
  return null;
}
