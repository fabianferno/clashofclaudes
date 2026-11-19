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
import { HAPTICS, playHaptic } from '../state/haptics';
import type { HapticKind, SoundMoment } from '../api/types';
import { open as openFile } from '@tauri-apps/plugin-dialog';
import { DEFAULT_SOUNDS, SOUND_MOMENTS, previewSound } from '../state/sounds';
import { DEFAULT_RESERVE } from '../state/elixir';

/** The system-wide shortcut's keys (src-tauri/src/shortcut.rs). */
const GLOBAL_KEYS = '⌃⌥⌘J';
const SYSTEM_SOUNDS_DIR = '/System/Library/Sounds/';
const CHOOSE = '__choose';
const fileName = (p: string) => p.split('/').pop() ?? p;
const systemPath = (name: string) => `${SYSTEM_SOUNDS_DIR}${name}.aiff`;

export { DEFAULT_SETTINGS };

export const SHORTCUTS: Array<[keys: string, what: string]> = [
  ['⌃ ⌥ ⌘ J', 'Open your queue, from any app'],
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

/** One moment's haptic: pick a feel (it plays as you pick it), then run the pointer over its pad to feel it again. */
function HapticRow({ label, value, onChange }: { label: string; value: HapticKind; onChange: (k: HapticKind) => void }) {
  const hint = HAPTICS.find((h) => h.kind === value)?.hint;
  return (
    <div className="set-line" title={hint}>
      <span className="set-label">{label}</span>
      <span className="set-haptic">
        <select aria-label={label} value={value} onChange={(e) => { const k = e.target.value as HapticKind; onChange(k); playHaptic(k); }}>
          {HAPTICS.map((h) => <option key={h.kind} value={h.kind}>{h.label}</option>)}
        </select>
        <span className={`set-feel${value === 'off' ? ' off' : ''}`} aria-hidden="true"
          onPointerEnter={() => playHaptic(value)}>{value === 'off' ? 'Off' : 'Hover to feel'}</span>
      </span>
    </div>
  );
}

/**
 * One moment's sound: off, a macOS system sound, or a file of the owner's own (copied into the
 * data folder). It plays as it is picked; ▶ plays it again.
 */
function SoundRow({ label, hint, value, system, volume, onChange }: {
  label: string; hint: string; value: string; system: string[]; volume: number; onChange: (path: string) => void;
}) {
  const own = value && !value.startsWith(SYSTEM_SOUNDS_DIR) ? value : null;
  const pick = async (v: string) => {
    if (v !== CHOOSE) { onChange(v); previewSound(v, volume); return; }
    try {
      const chosen = await openFile({ multiple: false, directory: false, filters: [{ name: 'Sounds', extensions: ['aiff', 'aif', 'mp3', 'wav', 'm4a', 'caf', 'aac', 'flac'] }] });
      if (typeof chosen !== 'string') return;
      const copy = await ipc.importSound(chosen);
      onChange(copy);
      previewSound(copy, volume);
    } catch (e) {
      useApp.getState().setError(String(e));
    }
  };
  return (
    <div className="set-line" title={hint}>
      <span className="set-text">
        <span className="set-label">{label}</span>
        <span className="set-hint">{hint}</span>
      </span>
      <span className="set-haptic">
        <select aria-label={`Sound: ${label}`} value={value} onChange={(e) => void pick(e.target.value)}>
          <option value="">Off</option>
          {own && <option value={own}>{fileName(own)}</option>}
          {system.map((n) => <option key={n} value={systemPath(n)}>{n}</option>)}
          <option value={CHOOSE}>Your own file…</option>
        </select>
        <button type="button" className="hud-btn grey sm set-play" aria-label={`Play ${label}`} disabled={!value} onClick={() => previewSound(value, volume)}>▶</button>
      </span>
    </div>
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
  const [systemSounds, setSystemSounds] = useState<string[]>([]);
  const [keysTaken, setKeysTaken] = useState(false);

  useEffect(() => (open ? useApp.getState().cover() : undefined), [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setCheck(null);
    loadSettings().catch(() => {});
    getVersion().then((v) => live && setVersion(v)).catch(() => {});
    ipc.dataFolder().then((f) => live && setFolder(f)).catch(() => {});
    ipc.systemSounds().then((n) => live && setSystemSounds(n)).catch(() => {});
    ipc.shortcutStatus().then((k) => live && setKeysTaken(k.taken)).catch(() => {});
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
  // the keys are taken or let go as the setting is saved: ask again whether another app holds them
  const setShortcut = (on: boolean) => {
    saveSettings({ globalShortcut: on })
      .then(() => ipc.shortcutStatus())
      .then((k) => setKeysTaken(k.taken))
      .catch((e) => useApp.getState().setError(String(e)));
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

          <section className="set-card" aria-label="Focus">
            <h3 className="kb-head ol" style={{ background: '#7a5a2f' }}>Focus</h3>
            <div className="set-body">
              <div className="set-note">Fewer threads at once. With a limit, To Dos set to start on their own wait for a free slot, and + New session suggests the To Do once you reach it.</div>
              <label className="set-line">
                <span className="set-label">Sessions at work at once</span>
                <select aria-label="Sessions at work at once" value={settings.sessionLimit ?? 0}
                  onChange={(e) => change({ sessionLimit: Number(e.target.value) || null })}>
                  <option value={0}>No limit</option>
                  {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
          </section>

          <section className="set-card" aria-label="Elixir">
            <h3 className="kb-head ol" style={{ background: '#b0479b' }}>Elixir</h3>
            <div className="set-body">
              <div className="set-note">Keep a reserve of each agent's limits. To Dos set to start on their own wait while their agent is at or under it, and start once it refills.</div>
              <label className="set-line">
                <span className="set-label">Hold To Dos at</span>
                <select aria-label="Hold To Dos at" value={settings.elixirReserve ?? DEFAULT_RESERVE}
                  onChange={(e) => change({ elixirReserve: Number(e.target.value) })}>
                  <option value={0}>Never: use it all</option>
                  {[5, 10, 15, 20, 25, 30].map((n) => <option key={n} value={n}>{n}% left or less</option>)}
                </select>
              </label>
              <Toggle label="Hand held To Dos to another agent"
                hint="A free builder whose agent has elixir takes the task instead of waiting (the one with the most left)."
                checked={!!settings.elixirStandIn} onChange={(on) => change({ elixirStandIn: on })} />
            </div>
          </section>

          <section className="set-card" aria-label="Sounds">
            <h3 className="kb-head ol" style={{ background: '#2f9e7a' }}>Sounds</h3>
            <div className="set-body">
              <div className="set-note">Played by this app for every agent, whether the window is in front or not. Pick a macOS sound or one of your own files (a copy is kept in the data folder).</div>
              <Toggle label="Play sounds" checked={settings.soundsOn !== false} onChange={(on) => change({ soundsOn: on })} />
              <label className="set-line">
                <span className="set-label">Volume</span>
                <input type="range" min={5} max={100} step={5} aria-label="Sound volume" value={settings.soundVolume ?? 70}
                  onChange={(e) => change({ soundVolume: Number(e.target.value) })}
                  onPointerUp={(e) => previewSound((settings.sounds ?? DEFAULT_SOUNDS).finished || DEFAULT_SOUNDS.finished, Number((e.target as HTMLInputElement).value))} />
              </label>
              {settings.soundsOn !== false && SOUND_MOMENTS.map(({ moment, label, hint }) => (
                <SoundRow key={moment} label={label} hint={hint} system={systemSounds} volume={settings.soundVolume ?? 70}
                  value={(settings.sounds ?? DEFAULT_SOUNDS)[moment] ?? DEFAULT_SOUNDS[moment]}
                  onChange={(path) => change({ sounds: { ...DEFAULT_SOUNDS, ...settings.sounds, [moment as SoundMoment]: path } })} />
              ))}
            </div>
          </section>

          <section className="set-card" aria-label="Haptics">
            <h3 className="kb-head ol" style={{ background: '#8a5ab8' }}>Haptics</h3>
            <div className="set-body">
              <div className="set-note">Felt on a Force Touch trackpad while a finger rests on it. Run the pointer over a pad to feel it: macOS offers three, from a faint tick to a firm click.</div>
              <HapticRow label="Over a house or the Town Hall" value={settings.hapticHover ?? 'alignment'} onChange={(hapticHover) => change({ hapticHover })} />
              <HapticRow label="A builder over a workspace" value={settings.hapticDrop ?? 'levelChange'} onChange={(hapticDrop) => change({ hapticDrop })} />
            </div>
          </section>

          <section className="set-card" aria-label="Notifications">
            <h3 className="kb-head ol" style={{ background: 'var(--hud-needs)' }}>Notifications</h3>
            <div className="set-body">
              <div className="set-note">Shown only while the app is in the background, once each time.</div>
              <Toggle label="When a builder needs you" hint="A question, a permission to approve, or a sign-in." checked={settings.notifyNeedsYou} onChange={(on) => change({ notifyNeedsYou: on })} />
              <Toggle label="When a builder finishes" checked={settings.notifyFinished} onChange={(on) => change({ notifyFinished: on })} />
              <Toggle label="Count on the Dock icon" hint="Builders waiting on you: the same count as the menu bar." checked={settings.dockBadge} onChange={(on) => change({ dockBadge: on })} />
              <Toggle label={`${GLOBAL_KEYS} opens your queue from any app`} hint="The first builder waiting on you, or the village when none is." checked={settings.globalShortcut !== false} onChange={setShortcut} />
              {keysTaken && settings.globalShortcut !== false && <div className="set-note">{GLOBAL_KEYS} is taken by another app</div>}
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
