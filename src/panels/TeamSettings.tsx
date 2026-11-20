import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { BoardSettings, BoardStatus } from '../api/types';
import { useApp } from '../state/store';
import { waitedLabel } from '../state/queue';
import RemoteSettings from './RemoteSettings';
import AccessSettings from './AccessSettings';
import TeamGuide from './TeamGuide';

const DEFAULT_BOARD = 'village';

/** What is missing, by status, and the commands that fix it. */
const MISSING: Partial<Record<BoardStatus['state'], { text: string; commands: string[] }>> = {
  noCli: { text: 'The Vercel CLI is not installed.', commands: ['npm i -g vercel', 'vercel login'] },
  oldCli: { text: 'This Vercel CLI has no board command. Update it:', commands: ['npm i -g vercel@latest'] },
  signedOut: { text: 'Not signed in to Vercel.', commands: ['vercel login'] },
};

function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void }) {
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

/** A command to run in a terminal, with a Copy button. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="set-line">
      <code className="set-cmd">{text}</code>
      <button type="button" className="hud-btn grey sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

/** A text field that saves when it is left (or on Enter). */
function Field({ label, hint, value, placeholder, onSave }: { label: string; hint: string; value: string; placeholder?: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = draft.trim();
    setDraft(null);
    onSave(v);
  };
  return (
    <label className="set-row set-name">
      <span className="set-text">
        <span className="set-label">{label}</span>
        <span className="set-hint">{hint}</span>
      </span>
      <input type="text" aria-label={label} placeholder={placeholder} value={draft ?? value} spellCheck={false} maxLength={64}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

/**
 * Settings › Team (Vercel Board): the switch that publishes shared workspaces' sessions to the
 * team's board through the owner's own `vercel` CLI, where the connection stands, and what is shared.
 */
export default function TeamSettings({ board, onChange }: { board: BoardSettings; onChange: (board: BoardSettings) => void }) {
  const [status, setStatus] = useState<BoardStatus | null>(null);
  // asked when the feature comes on, and again when the board it points at changes
  useEffect(() => {
    if (!board.enabled) {
      setStatus(null);
      return;
    }
    let live = true;
    ipc.boardStatus().then((s) => { if (live) setStatus(s); }, () => {});
    return () => { live = false; };
  }, [board.enabled, board.team, board.name]);

  const set = (patch: Partial<BoardSettings>) => onChange({ ...board, ...patch });
  const again = () => {
    ipc.boardCheck().then(setStatus, (e) => useApp.getState().setError(String(e)));
  };
  const missing = status ? MISSING[status.state] : undefined;
  const ready = status?.state === 'ready';

  return (
    <>
      <TeamGuide />
      <Switch label="Connect this village to Vercel Board"
        hint={board.enabled ? "Shared workspaces' builders show on your Vercel team's board." : "Shows your shared workspaces' builders to your Vercel team. Off until you turn it on."}
        checked={board.enabled} onChange={(enabled) => set({ enabled })} />
      {board.enabled && (
        <>
          {!status && <div className="set-note" role="status">Asking the Vercel CLI…</div>}
          {ready && <div className="set-note" role="status">Signed in as {status.handle} · board {board.name}</div>}
          {missing && (
            <>
              <div className="set-note" role="status">{missing.text}</div>
              {missing.commands.map((c) => <Command key={c} text={c} />)}
            </>
          )}
          {status?.state === 'error' && <div className="set-note" role="status">{status.lastError ?? 'The board could not be reached.'}</div>}
          {status && !ready && (
            <div className="set-line">
              <span className="set-note">Done? Look again.</span>
              <button type="button" className="hud-btn green sm" onClick={again}>Check again</button>
            </div>
          )}
          {status && status.teams.length > 0 ? (
            <label className="set-row set-name">
              <span className="set-text">
                <span className="set-label">Team</span>
                <span className="set-hint">The Vercel team whose board this village is on.</span>
              </span>
              <select aria-label="Team" value={board.team ?? ''} onChange={(e) => set({ team: e.target.value || null })}>
                <option value="">Default team</option>
                {status.teams.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          ) : (
            <Field label="Team" hint="A Vercel team's slug. Empty: your default team." value={board.team ?? ''} placeholder="Default team"
              onSave={(v) => set({ team: v || null })} />
          )}
          <Field label="Board name" hint="The board on that team. It is made the first time it is used." value={board.name}
            onSave={(v) => set({ name: v || DEFAULT_BOARD })} />
          <Switch label="Share details" hint="Also what builders work on: tasks, tool calls, replies, file names. Off: only who is working, waiting or done."
            checked={board.shareDetails} onChange={(shareDetails) => set({ shareDetails })} />
          <Switch label="Builders write under their own name" hint="A builder that posts to the board itself shows as “wizard via you”."
            checked={board.sessionEnv} onChange={(sessionEnv) => set({ sessionEnv })} />
          <Switch label="Share new workspaces" hint="A workspace you add later starts shared. Each workspace has its own switch in its panel."
            checked={board.shareNew} onChange={(shareNew) => set({ shareNew })} />
          {status?.lastWriteAt != null && <div className="set-note">Last written {ago(Date.now() - status.lastWriteAt)}</div>}
          {ready && status.lastError && <div className="set-note">Last problem: {status.lastError}</div>}
          {ready && <AccessSettings />}
          {ready && (
            <RemoteSettings
              enabled={board.remote?.enabled === true}
              onEnabled={(on) => set({ remote: { url: null, trusted: [], paused: null, ...board.remote, enabled: on } })}
            />
          )}
        </>
      )}
    </>
  );
}

function ago(ms: number): string {
  const w = waitedLabel(ms);
  return w === 'just now' ? w : `${w} ago`;
}

/** The workspace panel's switch: whether this workspace's builders show on the team's board. Nothing while the feature is off. */
export function WorkspaceShare({ workspaceId, onError }: { workspaceId: string; onError: (e: string | null) => void }) {
  const on = useApp((s) => s.settings?.board?.enabled === true);
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId));
  if (!on || !ws) return null;
  const share = (shared: boolean) => {
    const before = ws;
    onError(null);
    useApp.getState().updateWorkspace({ ...before, boardShared: shared }); // the switch moves at once
    ipc.setWorkspaceShared(workspaceId, shared).then(
      (w) => useApp.getState().updateWorkspace(w),
      (e) => { useApp.getState().updateWorkspace(before); onError(String(e)); },
    );
  };
  return (
    <Switch label="Share on the team board" hint="Its builders, and what they wait for, show on your Vercel team's board."
      checked={ws.boardShared === true} onChange={share} />
  );
}
