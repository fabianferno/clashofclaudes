import { useState } from 'react';
import { ipc } from '../api/ipc';
import NewSessionPicker from './NewSessionPicker';
import { sessionsByWorkspace, useApp } from '../state/store';
import { xpNeed } from '../village/look';
import { StateTag } from './tags';

export default function WorkspacePanel({ workspaceId }: { workspaceId: string }) {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId));
  const sessionMap = useApp((s) => s.sessions);
  const builders = useApp((s) => s.builders);
  const [form, setForm] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!ws) return null;

  const all = sessionsByWorkspace({ sessions: sessionMap }, workspaceId);
  const agentSessions = all.filter((s) => s.kind.kind === 'agent');
  const terminals = all.filter((s) => s.kind.kind === 'terminal');
  const need = xpNeed(ws.level);
  const pct = Math.max(0, Math.min(100, Math.round((ws.xp / need) * 100)));
  const why = ws.missing ? `Folder not found: ${ws.path}` : undefined;
  const st = useApp.getState();
  const guard = async (f: () => Promise<void>) => {
    setErr(null);
    try { await f(); } catch (e) { setErr(String(e)); }
  };

  if (form) {
    return (
      <>
        <button className="hud-btn grey sm" onClick={() => setForm(false)}>‹ Back</button>
        <NewSessionPicker key={workspaceId} workspaceId={workspaceId} />
      </>
    );
  }

  const row = (s: (typeof all)[number], terminal: boolean) => {
    const b = s.kind.kind === 'agent' ? builders.find((x) => x.id === (s.kind as { builderId: string }).builderId) : undefined;
    return (
      <button key={s.id} className="sp-row" data-testid={`${terminal ? 'terminal' : 'session'}-row-${s.id}`}
        onClick={() => useApp.getState().setSelection({ kind: 'session', id: s.id })}>
        <span className="sp-rowtext">
          <span className="sp-t">{terminal ? 'Terminal' : (s.task ?? 'Session')}</span>
          <span className="sp-d">{terminal ? 'plain shell' : `${b?.name ?? 'Builder'} · ${s.steps} steps`}</span>
        </span>
        <StateTag state={s.state} />
      </button>
    );
  };

  return (
    <>
      <div className="sp-box">
        <b>Level {ws.level}</b> · <span>{ws.xp} / {need} XP</span>
        <div className="sp-xp"><i data-testid="xp-fill" style={{ width: `${pct}%` }} /></div>
        <div className="sp-d sp-gap">Closing a finished session adds XP here. Higher levels make this house grander.</div>
      </div>
      {ws.missing && (
        <div className="panel-warn">Folder not found: {ws.path}. Restore it (or move it back) to start work here, or remove this workspace from the village.</div>
      )}
      {err && <div className="panel-warn">{err}</div>}
      <div className="sp-btns sp-btns-top">
        <button className="hud-btn sm" disabled={ws.missing} title={why} onClick={() => setForm(true)}>+ New session</button>
        <button className="hud-btn blue sm" disabled={ws.missing} title={why}
          onClick={() => guard(async () => {
            const s = await ipc.startTerminal(workspaceId);
            st.upsertSession(s);
            st.setSelection({ kind: 'session', id: s.id });
          })}>+ Terminal</button>
        <button className="hud-btn grey sm" disabled={ws.missing} title={why} onClick={() => guard(() => ipc.openInEditor(ws.path))}>Open in editor</button>
        <button className="hud-btn blue sm" disabled={ws.missing || !ws.compound} title={why} onClick={() => useApp.getState().requestZoom(workspaceId)}>Zoom in</button>
      </div>
      <div className="sp-sec">Sessions ({agentSessions.length})</div>
      {agentSessions.length === 0 && <div className="sp-note">No sessions running. Plots are empty.</div>}
      {agentSessions.map((s) => row(s, false))}
      {terminals.length > 0 && <div className="sp-sec">Terminals ({terminals.length})</div>}
      {terminals.map((s) => row(s, true))}
      <div className="sp-sec">Danger zone</div>
      {confirm && (
        <div className="panel-warn">This only forgets the folder in Clash of Claudes. It never deletes any files on disk.</div>
      )}
      <div className="sp-btns">
        {!confirm
          ? <button className="hud-btn red sm" onClick={() => setConfirm(true)}>Remove workspace</button>
          : (
            <>
              <button className="hud-btn red sm" onClick={() => guard(async () => {
                await ipc.removeWorkspace(workspaceId);
                st.removeWorkspace(workspaceId);
                st.setSelection(null);
              })}>Confirm remove?</button>
              <button className="hud-btn grey sm" onClick={() => setConfirm(false)}>Cancel</button>
            </>
          )}
      </div>
    </>
  );
}
