import { useState } from 'react';
import { useApp } from '../state/store';
import * as wsActions from '../state/workspaceActions';
import { panelInset } from '../hud/layout';
import FolderHint from './FolderHint';
import { useTour } from '../onboarding/tour';

/**
 * Gentle first-run start, shown only while there are no workspaces. Not modal: no backdrop, no focus
 * trap, and the layer around the card ignores pointer events so the village and HUD stay usable.
 */
export default function WelcomeCard() {
  const touring = useTour((s) => s.step !== null);
  const show = useApp((s) => s.loaded && s.workspaces.length === 0) && !touring;
  const panelOpen = useApp((s) => s.panelOpen);
  const [naming, setNaming] = useState<string | null>(null);
  if (!show) return null;

  const create = async (pick = false) => { if (naming && await wsActions.createFolder(naming, pick)) setNaming(null); };

  return (
    <div className="welcome-layer" style={{ right: panelInset(panelOpen), pointerEvents: 'none' }}>
      <div className="welcome-card" data-testid="welcome-card" style={{ pointerEvents: 'auto' }}>
        <h2 className="ol">Open a workspace to start</h2>
        <p>Pick a project and your builders will get to work in it.</p>
        <div className="sp-btns">
          <button className="hud-btn green" onClick={() => void wsActions.openFolder()}>Open workspace</button>
          {naming === null
            ? <button className="hud-btn" onClick={() => setNaming('')}>New workspace</button>
            : (
              <span className="sp-inline">
                <input autoFocus aria-label="Workspace name" placeholder="Workspace name" value={naming} onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setNaming(null); }} />
                <button className="hud-btn sm" disabled={!naming.trim()} onClick={() => void create()}>Create</button>
              </span>
            )}
        </div>
        {naming !== null && <FolderHint disabled={!naming.trim()} onChoose={() => void create(true)} />}
      </div>
    </div>
  );
}
