import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { ipc } from '../api/ipc';
import type { Settings } from '../api/types';
import { useApp } from '../state/store';
import AgentsStatus from './AgentsStatus';

export const DEFAULT_SETTINGS: Settings = { updatesEnabled: true, notifyNeedsYou: true, notifyFinished: true, dockBadge: true };

export const SHORTCUTS: Array<[keys: string, what: string]> = [
  ['⌘ ,', 'Open Settings'],
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

/** App preferences, full page over the village. The gear, Cmd+, or the Town Hall opens it; ✕ or Esc closes it. */
export default function SettingsPage() {
  const open = useApp((s) => s.settingsOpen);
  const close = () => useApp.getState().setSettingsOpen(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [version, setVersion] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [check, setCheck] = useState<Check>(null);

  useEffect(() => (open ? useApp.getState().cover() : undefined), [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setCheck(null);
    ipc.getSettings().then((s) => live && setSettings({ ...DEFAULT_SETTINGS, ...s })).catch(() => {});
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

  // the whole struct goes back: the backend replaces it
  const change = (patch: Partial<Settings>) => {
    const before = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    ipc.setSettings(next).catch((e) => { setSettings(before); useApp.getState().setError(String(e)); });
  };
  const checkNow = () => {
    setCheck('checking');
    ipc.checkForUpdate().then(
      (s) => {
        if (s?.available) useApp.getState().setUpdateAvailable(true);
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
                hint="The only time the app uses the network: it checks GitHub for signed updates, and installs one only if its signature matches."
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
