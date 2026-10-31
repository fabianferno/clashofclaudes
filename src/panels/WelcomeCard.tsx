import { useState } from 'react';
import { useApp } from '../state/store';
import * as wsActions from '../state/workspaceActions';
import { panelInset } from '../hud/layout';

/**
 * Gentle first-run start, shown only while there are no workspaces. Not modal: no backdrop, no focus
 * trap, and the layer around the card ignores pointer events so the village and HUD stay usable.
 */
export default function WelcomeCard() {
  const show = useApp((s) => s.loaded && s.workspaces.length === 0);
  const panelOpen = useApp((s) => s.panelOpen);
  const [naming, setNaming] = useState<string | null>(null);
  if (!show) return null;

  const create = async () => { if (naming && await wsActions.createFolder(naming)) setNaming(null); };

  return (
    <div className="welcome-layer" style={{ right: panelInset(panelOpen), pointerEvents: 'none' }}>
      <div className="welcome-card" data-testid="welcome-card" style={{ pointerEvents: 'auto' }}>
        <h2 className="ol">Open a folder to start</h2>
        <p>Pick a project folder and your builders will get to work in it.</p>
        <div className="sp-btns">
          <button className="hud-btn green" onClick={() => void wsActions.openFolder()}>Open folder</button>
          {naming === null
            ? <button className="hud-btn" onClick={() => setNaming('')}>New folder</button>
            : (
              <span className="sp-inline">
                <input autoFocus aria-label="Folder name" placeholder="Folder name" value={naming} onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setNaming(null); }} />
                <button className="hud-btn sm" disabled={!naming.trim()} onClick={() => void create()}>Pick parent</button>
              </span>
            )}
        </div>
      </div>
    </div>
  );
}
