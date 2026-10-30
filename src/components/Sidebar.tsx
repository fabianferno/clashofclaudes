import { useState } from 'react';
import { ipc } from '../api/ipc';
import { sessionsByWorkspace, useApp } from '../state/store';
import * as wsActions from '../state/workspaceActions';

const DOT: Record<string, string> = {
  starting: 'var(--c-working)', working: 'var(--c-working)', needsYou: 'var(--c-needs)',
  finished: 'var(--c-finished)', stuck: 'var(--c-stuck)', ended: 'var(--c-ended)',
};

export default function Sidebar({ onNewSession }: { onNewSession: (workspaceId: string) => void }) {
  const st = useApp();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);

  const guard = async (f: () => Promise<void>) => {
    setError(null);
    try { await f(); } catch (e) { setError(String(e)); }
  };
  const openFolder = () => wsActions.openFolder();
  const createFolder = async () => {
    if (!newName?.trim()) return;
    await wsActions.createFolder(newName);
    setNewName(null);
  };
  const terminal = (wsId: string) => guard(async () => {
    const s = await ipc.startTerminal(wsId);
    st.upsertSession(s);
    st.select(s.id);
  });

  return (
    <aside className="sidebar">
      <div className="side-actions">
        <button onClick={openFolder}>Open folder</button>
        {newName === null
          ? <button onClick={() => setNewName('')}>New folder</button>
          : (
            <span className="newfolder">
              <input autoFocus placeholder="Folder name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <button onClick={createFolder}>Pick parent</button>
            </span>
          )}
      </div>
      {error && <div className="error">{error}</div>}
      {st.workspaces.map((w) => (
        <div key={w.id} className="ws">
          <div className="ws-head">
            <strong title={w.path}>{w.name}</strong>
            {w.missing && <span className="badge">missing</span>}
          </div>
          <div className="ws-actions">
            <button onClick={() => onNewSession(w.id)} disabled={w.missing}>+ Session</button>
            <button onClick={() => terminal(w.id)} disabled={w.missing}>+ Terminal</button>
          </div>
          {sessionsByWorkspace(st, w.id).map((s) => {
            const b = s.kind.kind === 'agent' ? st.builders.find((x) => x.id === (s.kind as { builderId: string }).builderId) : undefined;
            return (
              <button key={s.id} className={`sess${st.selectedSessionId === s.id ? ' selected' : ''}`} onClick={() => st.select(s.id)}>
                <span className="dot" style={{ background: DOT[s.state.kind] }} />
                {b?.name ?? 'Terminal'}
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
