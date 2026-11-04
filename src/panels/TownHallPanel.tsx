import { useState } from 'react';
import { useApp } from '../state/store';
import * as wsActions from '../state/workspaceActions';
import AgentsStatus from './AgentsStatus';
import FolderHint from './FolderHint';
import { CLASS_NAMES, PALETTE, classOf, gearOf, houseColors, stars } from '../village/look';
import BuilderAvatar from '../hud/BuilderAvatar';
import { BADGE_LABEL, badgeOf, builderTarget, liveSessionOf } from '../hud/hudState';

export default function TownHallPanel() {
  const workspaces = useApp((s) => s.workspaces);
  const sessions = useApp((s) => s.sessions);
  const builders = useApp((s) => s.builders);
  const setSelection = useApp((s) => s.setSelection);
  const [newName, setNewName] = useState<string | null>(null);
  // The name stays until the folder exists: a cancelled picker keeps it for another try.
  const create = async (pick = false) => { if (newName && await wsActions.createFolder(newName, pick)) setNewName(null); };
  const all = Object.values(sessions);
  const count = (id: string) => Object.values(sessions).filter((s) => s.workspaceId === id).length;

  return (
    <>
      <div className="sp-sec">Workspaces ({workspaces.length})</div>
      {workspaces.length === 0 && <div className="sp-note">No workspaces yet. Open one or start a new one.</div>}
      {workspaces.map((w) => (
        <button key={w.id} className="sp-row" data-testid={`hall-ws-${w.id}`} onClick={() => setSelection({ kind: 'workspace', id: w.id })}>
          <span className="sp-av" style={{ background: houseColors(w).roof }}><span className="ol">{w.level}</span></span>
          <span className="sp-rowtext">
            <span className="sp-t">{w.name}</span>
            <span className="sp-d" title={w.path}>{count(w.id)} {count(w.id) === 1 ? 'session' : 'sessions'} · {w.path}</span>
          </span>
          {w.missing && <span className="sp-tag ol" style={{ background: 'var(--hud-needs)' }}>missing</span>}
        </button>
      ))}
      <div className="sp-btns">
        <button className="hud-btn blue sm" onClick={() => void wsActions.openFolder()}>Open workspace</button>
        {newName === null
          ? <button className="hud-btn sm" onClick={() => setNewName('')}>New workspace</button>
          : (
            <span className="sp-inline">
              <input autoFocus aria-label="Workspace name" placeholder="Workspace name" value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setNewName(null); }} />
              <button className="hud-btn sm" disabled={!newName.trim()} onClick={() => void create()}>Create</button>
            </span>
          )}
      </div>
      {newName !== null && <FolderHint disabled={!newName.trim()} onChoose={() => void create(true)} />}
      <div className="sp-sec">Builders ({builders.length})</div>
      {builders.length === 0 && <div className="sp-note">No builders yet — recruit one from + New session.</div>}
      {builders.map((b) => {
        // as on the builder cards: the portrait, and a busy builder opens its session
        const live = liveSessionOf(b.id, all);
        const badge = badgeOf(live);
        return (
          <button key={b.id} className="sp-row" data-testid={`hall-builder-${b.id}`} onClick={() => setSelection(builderTarget(b.id, all))}>
            <span className="hud-av"><BuilderAvatar agent={b.agent} model={b.model} effort={b.effort} /></span>
            <span className="sp-rowtext">
              <span className="sp-t">{b.name} <span className="hud-stars">{'★'.repeat(stars(gearOf(b.effort)))}</span></span>
              <span className="sp-d">{CLASS_NAMES[classOf(b.agent, b.model)]} · {PALETTE[b.agent].label}</span>
            </span>
            <span className="hud-badge ol" data-state={badge} style={{ background: `var(--hud-${badge})` }}>{BADGE_LABEL[badge]}</span>
          </button>
        );
      })}
      <div className="sp-sec">Agents</div>
      <AgentsStatus />
      <div className="sp-sec">Settings</div>
      <div className="sp-note">Notifications, updates, shortcuts and where your data lives.</div>
      <div className="sp-btns">
        <button className="hud-btn grey sm" onClick={() => useApp.getState().setSettingsOpen(true)}>Open Settings</button>
      </div>
    </>
  );
}
