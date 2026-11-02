import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ipc } from '../api/ipc';
import NewSessionPicker from './NewSessionPicker';
import { boardItems, browserUrl, sessionsByWorkspace, useApp } from '../state/store';
import { xpNeed } from '../village/look';
import { StateTag } from './tags';

export default function WorkspacePanel({ workspaceId }: { workspaceId: string }) {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId));
  const sessionMap = useApp((s) => s.sessions);
  const builders = useApp((s) => s.builders);
  const apps = useApp((s) => s.apps);
  const browsers = useApp((s) => s.browsers);
  const [form, setForm] = useState(false);
  // the + Browser address, while it is being typed
  const [addr, setAddr] = useState<string | null>(null);
  // a builder dropped on this workspace opens the form with them picked
  const preset = useApp((s) => (s.selection?.kind === 'workspace' && s.selection.id === workspaceId ? s.selection.builder : undefined));
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!ws) return null;

  const all = sessionsByWorkspace({ sessions: sessionMap }, workspaceId);
  const agentSessions = all.filter((s) => s.kind.kind === 'agent');
  const terminals = all.filter((s) => s.kind.kind === 'terminal');
  const boards = boardItems({ apps, browsers }).filter((b) => b.workspaceId === workspaceId);
  const need = xpNeed(ws.level);
  const pct = Math.max(0, Math.min(100, Math.round((ws.xp / need) * 100)));
  const why = ws.missing ? `Folder not found: ${ws.path}` : undefined;
  const st = useApp.getState();
  const guard = async (f: () => Promise<void>) => {
    setErr(null);
    try { await f(); } catch (e) { setErr(String(e)); }
  };

  if (form || preset) {
    const back = () => {
      setForm(false);
      if (preset) useApp.getState().setSelection({ kind: 'workspace', id: workspaceId });
    };
    return (
      <>
        <button className="hud-btn grey sm" onClick={back}>‹ Back</button>
        <NewSessionPicker key={`${workspaceId}:${preset ?? ''}`} workspaceId={workspaceId} builderId={preset} />
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

  const openBrowser = () => {
    const url = browserUrl(addr ?? '');
    if (!url) { setErr('Type a web address, like localhost:3000 or https://example.com'); return; }
    setErr(null);
    setAddr(null);
    const b = st.openBrowser(workspaceId, url);
    const item = boardItems(useApp.getState()).find((x) => x.browserId === b.id)!;
    st.setAppPopout({ url, title: item.label, browserId: b.id });
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
        <button className="hud-btn blue sm" disabled={ws.missing} title={why}
          onClick={() => { setErr(null); setAddr((a) => (a === null ? 'http://localhost:3000' : null)); }}>+ Browser</button>
        <button className="hud-btn sm" onClick={() => st.setKanban(workspaceId)}>Kanban</button>
        <button className="hud-btn grey sm" disabled={ws.missing} title={why} onClick={() => guard(() => ipc.openInEditor(ws.path))}>Open in editor</button>
        <button className="hud-btn blue sm" disabled={ws.missing || !ws.compound} title={why} onClick={() => useApp.getState().requestZoom(workspaceId)}>Zoom in</button>
      </div>
      {addr !== null && (
        <form className="sp-browser-form" onSubmit={(e) => { e.preventDefault(); openBrowser(); }}>
          <input aria-label="Web address" autoFocus value={addr} spellCheck={false}
            onFocus={(e) => e.target.select()} onChange={(e) => setAddr(e.target.value)} />
          <button type="submit" className="hud-btn sm">Open</button>
          <button type="button" className="hud-btn grey sm" onClick={() => { setAddr(null); setErr(null); }}>Cancel</button>
        </form>
      )}
      <div className="sp-sec">Sessions ({agentSessions.length})</div>
      {agentSessions.length === 0 && <div className="sp-note">No sessions running. Plots are empty.</div>}
      {agentSessions.map((s) => row(s, false))}
      {terminals.length > 0 && <div className="sp-sec">Terminals ({terminals.length})</div>}
      {terminals.map((s) => row(s, true))}
      {boards.length > 0 && <div className="sp-sec">Browsers ({boards.length})</div>}
      {boards.map((b) => (
        <div key={b.key} className="sp-browser-row">
          <button className="sp-row" data-testid={`browser-row-${b.key}`}
            onClick={() => (b.frameable
              ? st.setAppPopout({ url: b.url, title: b.label, browserId: b.browserId })
              : guard(() => openUrl(b.url)))}>
            <span className="sp-rowtext">
              <span className="sp-t">{b.label}</span>
              <span className="sp-d">{b.url}{b.browserId ? '' : ' · running here'}</span>
            </span>
          </button>
          {b.browserId && (
            <button className="hud-btn grey sm" aria-label={`Close ${b.label}`} onClick={() => st.closeBrowser(b.browserId!)}>✕</button>
          )}
        </div>
      ))}
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
