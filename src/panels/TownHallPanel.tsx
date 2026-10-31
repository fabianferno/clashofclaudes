import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import { idleBuilders, useApp } from '../state/store';
import * as wsActions from '../state/workspaceActions';
import AgentsStatus from './AgentsStatus';
import { CLASS_NAMES, PALETTE, classOf, houseColors } from '../village/look';

export default function TownHallPanel() {
  const workspaces = useApp((s) => s.workspaces);
  const sessions = useApp((s) => s.sessions);
  const builders = useApp((s) => s.builders);
  const setSelection = useApp((s) => s.setSelection);
  const [newName, setNewName] = useState<string | null>(null);
  const [updatesEnabled, setUpdatesEnabled] = useState(true);
  useEffect(() => {
    let live = true;
    ipc.getSettings().then((s) => live && setUpdatesEnabled(s.updatesEnabled)).catch(() => {});
    return () => { live = false; };
  }, []);
  const toggleUpdates = (on: boolean) => {
    setUpdatesEnabled(on);
    ipc.setSettings({ updatesEnabled: on }).catch((e) => { setUpdatesEnabled(!on); useApp.getState().setError(String(e)); });
  };
  const idle = idleBuilders({ builders, sessions });
  const count = (id: string) => Object.values(sessions).filter((s) => s.workspaceId === id).length;

  return (
    <>
      <div className="sp-sec">Workspaces ({workspaces.length})</div>
      {workspaces.length === 0 && <div className="sp-note">No workspaces yet. Open a folder or start a new one.</div>}
      {workspaces.map((w) => (
        <button key={w.id} className="sp-row" data-testid={`hall-ws-${w.id}`} onClick={() => setSelection({ kind: 'workspace', id: w.id })}>
          <span className="sp-av" style={{ background: houseColors(w.id).roof }}><span className="ol">{w.level}</span></span>
          <span className="sp-rowtext">
            <span className="sp-t">{w.name}</span>
            <span className="sp-d" title={w.path}>{count(w.id)} {count(w.id) === 1 ? 'session' : 'sessions'} · {w.path}</span>
          </span>
          {w.missing && <span className="sp-tag ol" style={{ background: 'var(--hud-needs)' }}>missing</span>}
        </button>
      ))}
      <div className="sp-btns">
        <button className="hud-btn blue sm" onClick={() => void wsActions.openFolder()}>Open folder</button>
        {newName === null
          ? <button className="hud-btn sm" onClick={() => setNewName('')}>New folder</button>
          : (
            <span className="sp-inline">
              <input autoFocus aria-label="Folder name" placeholder="Folder name" value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void wsActions.createFolder(newName).then(() => setNewName(null)); }} />
              <button className="hud-btn sm" disabled={!newName.trim()} onClick={() => void wsActions.createFolder(newName).then(() => setNewName(null))}>Pick parent</button>
            </span>
          )}
      </div>
      <div className="sp-sec">Idle builders ({idle.length})</div>
      {idle.length === 0 && (
        <div className="sp-note">{builders.length === 0 ? 'No builders yet — recruit one from + New session.' : 'Every builder is in a session.'}</div>
      )}
      {idle.map((b) => (
        <button key={b.id} className="sp-row" data-testid={`idle-builder-${b.id}`} onClick={() => setSelection({ kind: 'builder', id: b.id })}>
          <span className="sp-av" style={{ background: PALETTE[b.agent].body }}><span className="ol">{b.name.charAt(0).toUpperCase()}</span></span>
          <span className="sp-rowtext">
            <span className="sp-t">{b.name}</span>
            <span className="sp-d">{CLASS_NAMES[classOf(b.agent, b.model)]} · {PALETTE[b.agent].label}</span>
          </span>
        </button>
      ))}
      <div className="sp-sec">Agents</div>
      <AgentsStatus />
      <div className="sp-sec">Settings</div>
      <label className="sp-note" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={updatesEnabled} onChange={(e) => toggleUpdates(e.target.checked)} />
        Check for updates automatically
      </label>
      <div className="sp-note">This is the only time the app uses the network: it fetches a signed update manifest from GitHub.</div>
    </>
  );
}
