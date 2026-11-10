import { useState } from 'react';
import { BUILD_MARGIN, BUILD_W, usePanelInset } from './layout';
import { createFolder, openFolder } from '../state/workspaceActions';
import FolderHint from '../panels/FolderHint';
import './hud.css';

/** Bottom right: Build (a new workspace) and Open (an existing one). */
export default function BuildButtons() {
  const inset = usePanelInset();
  const [naming, setNaming] = useState<string | null>(null);

  const pick = async (choose = false) => {
    if (naming && await createFolder(naming, choose)) setNaming(null);
  };

  return (
    <div className="hud-build" style={{ right: inset + BUILD_MARGIN, width: BUILD_W, justifyContent: 'flex-end' }} data-testid="build-buttons">
      {naming !== null && (
        <div className="hud-pop">
          <input
            autoFocus
            placeholder="Workspace name"
            aria-label="Workspace name"
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void pick(); if (e.key === 'Escape') setNaming(null); }}
          />
          <button className="hud-btn green sm" onClick={() => void pick()} disabled={!naming.trim()}>Create</button>
          <FolderHint disabled={!naming.trim()} onChoose={() => void pick(true)} />
        </div>
      )}
      <button className="hud-btn green" title="New workspace" onClick={() => setNaming(naming === null ? '' : null)}>Build</button>
      <button className="hud-btn blue" title="Open workspace" onClick={() => void openFolder()}>Open</button>
    </div>
  );
}
