import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { ipc } from '../api/ipc';
import type { Settings } from '../api/types';
import { useApp } from '../state/store';
import { DEFAULT_SETTINGS, PLAYER_NAME_MAX, cleanName, loadSettings, saveSettings, townHallTitle } from '../state/settings';
import { startTour } from '../onboarding/tour';
import AgentsStatus from './AgentsStatus';
import '../onboarding/onboarding.css';
import { openBugReport } from './BugReport';

export { DEFAULT_SETTINGS };

export const SHORTCUTS: Array<[keys: string, what: string]> = [
  ['⌘ ,', 'Open Settings'],
  ['Help menu', 'Report a bug or request a feature'],
  ['⌘ =', 'Zoom in'],
  ['⌘ −', 'Zoom out'],
  ['⌘ 0', 'Fit the whole village'],
  ['Esc', 'Close Settings, a Kanban or the side panel'],
];

type Check = 'checking' | 'none' | 'found' | 'off' | 'failed' | null;
const CHECK_TEXT: Record<Exclude<Check, null>, string> = {
  checking: 'Checking…',
  none: 'You have the latest version.',
  found: 'An update is ready: see the banner at the bottom.',
  off: 'This build does not check for updates.',
  failed: 'Could not check. Try again later.',
};

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="set-row">
      <input type="checkbox" className="set-switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="set-text">
        <span className="set-label">{label}</span>
        {hint && <span className="set-hint">{hint}</span>}
      </span>
    </label>
  );
}

/** The owner's name, saved on Enter or when the field loses focus; the Town Hall's plate follows it. */
function NameField({ saved, onSave }: { saved: string | null; onSave: (name: string | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null); // null: showing the saved name
  const value = draft ?? saved ?? '';
  const commit = () => {
    if (draft === null) return;
    const name = cleanName(draft);
    setDraft(null);
    if (name !== saved) onSave(name);
  };
  return (
    <label className="set-row set-name">
      <span className="set-text">
        <span className="set-label">Your name</span>
        <span className="set-hint">The plate over your hall reads <b>{townHallTitle(draft ?? saved)}</b>.</span>
      </span>
      <input type="text" aria-label="Your name" placeholder="Your name" maxLength={PLAYER_NAME_MAX} value={value} spellCheck={false}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }} />
    </label>
  );
}

/** App preferences, full page over the village. The gear, Cmd+, or the Town Hall opens it; ✕ or Esc closes it. */
export default function SettingsPage() {
  const open = useApp((s) => s.settingsOpen);
  const close = () => useApp.getState().setSettingsOpen(false);
  const settings = useApp((s) => s.settings) ?? DEFAULT_SETTINGS;
  const [version, setVersion] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [check, setCheck] = useState<Check>(null);

  useEffect(() => (open ? useApp.getState().cover() : undefined), [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setCheck(null);
    loadSettings().catch(() => {});
    getVersion().then((v) => live && setVersion(v)).catch(() => {});
    ipc.dataFolder().then((f) => live && setFolder(f)).catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      useApp.getState().setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { live = false; window.removeEventListener('keydown', onKey, true); };
  }, [open]);
  if (!open) return null;

  // the whole struct goes back (the backend replaces it); a failed save puts the toggle back
  const change = (patch: Partial<Settings>) => {
    saveSettings(patch).catch((e) => useApp.getState().setError(String(e)));
  };
  const checkNow = () => {
    setCheck('checking');
    ipc.checkForUpdate().then(
      (s) => {
        if (s?.available) useApp.getState().setUpdateAvailable({ version: s.version ?? null, notes: s.notes ?? null });
        setCheck(s?.available ? 'found' : 'none');
      },
      (e) => setCheck(String(e).includes('disabled') ? 'off' : 'failed'),
    );
  };

  return (
    <div className="settings" role="dialog" aria-label="Settings" data-testid="settings-page">
      <header className="popout-head">
        <h2 className="ol">Settings</h2>
        <span className="popout-hint">Esc to return</span>
        <button className="hud-btn grey sm" aria-label="Close Settings" onClick={close}>✕</button>
      </header>
      <div className="set-scroll">
        <div className="set-col">
          <section className="set-card" aria-label="Your village">
            <h3 className="kb-head ol" style={{ background: '#c8860d' }}>Your village</h3>
            <div className="set-body">
              <NameField saved={settings.playerName ?? null} onSave={(playerName) => change({ playerName })} />
              <div className="set-line">
                <span className="set-note">New here, or want a refresher? Walk through a sample compound again.</span>
                <button className="hud-btn green sm" onClick={() => { close(); startTour(); }}>Replay the tour</button>
              </div>
            </div>
          </section>

          <section className="set-card" aria-label="Beta feedback">
            <h3 className="kb-head ol" style={{ background: '#2f95db' }}>Beta feedback</h3>
            <div className="set-body">
              <div className="set-line">
                <span className="set-note">Something broken or odd? Tell the developers; it goes straight to their Discord.</span>
                <button className="hud-btn blue sm" onClick={() => void openBugReport('bug')}>Report a bug</button>
              </div>
              <div className="set-line">
                <span className="set-note">Missing something? Ask for it the same way.</span>
                <button className="hud-btn blue sm" onClick={() => void openBugReport('feature')}>Request a feature</button>
              </div>
            </div>
          </section>

          <section className="set-card" aria-label="Notifications">
            <h3 className="kb-head ol" style={{ background: 'var(--hud-needs)' }}>Notifications</h3>
            <div className="set-body">
              <div className="set-note">Shown only while the app is in the background, once each time.</div>
              <Toggle label="When a builder needs you" hint="A question, a permission to approve, or a sign-in." checked={settings.notifyNeedsYou} onChange={(on) => change({ notifyNeedsYou: on })} />
              <Toggle label="When a builder finishes" checked={settings.notifyFinished} onChange={(on) => change({ notifyFinished: on })} />
              <Toggle label="Count on the Dock icon" hint="Builders that need you or have finished." checked={settings.dockBadge} onChange={(on) => change({ dockBadge: on })} />
            </div>
          </section>

          <section className="set-card" aria-label="Agents">
            <h3 className="kb-head ol" style={{ background: 'var(--hud-working)' }}>Agents</h3>
            <div className="set-body">
              <div className="set-note">Click an agent to see its setup steps or its version.</div>
              <AgentsStatus />
            </div>
          </section>

          <section className="set-card" aria-label="Updates">
            <h3 className="kb-head ol" style={{ background: 'var(--hud-finished)' }}>Updates</h3>
            <div className="set-body">
              <Toggle label="Check for updates automatically"
                hint="It checks GitHub for signed updates, and installs one only if its signature matches. Apart from bug reports you send, this is the only time the app uses the network."
                checked={settings.updatesEnabled} onChange={(on) => change({ updatesEnabled: on })} />
              <div className="set-line">
                <span className="set-label">Version {version ?? '…'}</span>
                <button className="hud-btn blue sm" disabled={check === 'checking' || !settings.updatesEnabled} onClick={checkNow}>Check now</button>
              </div>
              {check && <div className="set-note" role="status">{CHECK_TEXT[check]}</div>}
            </div>
          </section>

          <section className="set-card" aria-label="Keyboard shortcuts">
            <h3 className="kb-head ol" style={{ background: 'var(--hud-idle)' }}>Keyboard shortcuts</h3>
            <div className="set-body">
              <dl className="set-keys">
                {SHORTCUTS.map(([k, what]) => (
                  <div key={k}><dt><kbd>{k}</kbd></dt><dd>{what}</dd></div>
                ))}
              </dl>
            </div>
          </section>

          <section className="set-card" aria-label="Data and privacy">
            <h3 className="kb-head ol" style={{ background: '#8a6a48' }}>Data &amp; privacy</h3>
            <div className="set-body">
              <div className="set-note">
                Your workspaces, builders, tasks and paused sessions are kept on this Mac only. The app never changes your agents' own settings.
              </div>
              <Toggle label="Share anonymous usage"
                hint="Counts only: app opens, which agents you start, prompts answered and Kanban opens, with the app and macOS version. Never names, paths, tasks or code."
                checked={!!settings.shareUsage} onChange={(on) => change({ shareUsage: on })} />
              <div className="set-line">
                <code className="set-path" title={folder ?? ''}>{folder ?? '…'}</code>
                <button className="hud-btn grey sm" onClick={() => ipc.showDataFolder().catch((e) => useApp.getState().setError(String(e)))}>Show in Finder</button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
