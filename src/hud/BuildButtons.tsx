import { useState } from 'react';
import { useApp } from '../state/store';
import { BUILD_MARGIN, BUILD_W, panelInset } from './layout';
import { createFolder, openFolder } from '../state/workspaceActions';
import FolderHint from '../panels/FolderHint';
import './hud.css';

/** Bottom right: Build (new empty folder) and Open (existing folder). */
export default function BuildButtons() {
  const panelOpen = useApp((s) => s.panelOpen);
  const [naming, setNaming] = useState<string | null>(null);

  const pick = async (choose = false) => {
    if (naming && await createFolder(naming, choose)) setNaming(null);
  };

  return (
    <div className="hud-build" style={{ right: panelInset(panelOpen) + BUILD_MARGIN, width: BUILD_W, justifyContent: 'flex-end' }} data-testid="build-buttons">
      {naming !== null && (
        <div className="hud-pop">
          <input
            autoFocus
            placeholder="Folder name"
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void pick(); if (e.key === 'Escape') setNaming(null); }}
          />
          <button className="hud-btn green sm" onClick={() => void pick()} disabled={!naming.trim()}>Create</button>
          <FolderHint disabled={!naming.trim()} onChoose={() => void pick(true)} />
        </div>
      )}
      <button className="hud-btn green" onClick={() => setNaming(naming === null ? '' : null)}>Build</button>
      <button className="hud-btn blue" onClick={() => void openFolder()}>Open</button>
    </div>
  );
}
