import { useEffect, useRef, useState } from 'react';
import { useApp, type AppState } from '../state/store';
import ZoomControls from '../hud/ZoomControls';
import { PANEL_W } from './camera';
import { createScene, type Scene, type VillageInput } from './scene';

const inputOf = (s: AppState): VillageInput => ({
  workspaces: s.workspaces,
  sessions: Object.values(s.sessions),
  builders: s.builders,
});

/** The Pixi village, full-window; syncs from the store on every change (also while hidden). */
export default function VillageCanvas() {
  const host = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<Scene | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let made: Scene | null = null;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    createScene(el, {
      onSelect: (sel) => useApp.getState().setSelection(sel),
      panelWidth: () => (useApp.getState().panelOpen ? PANEL_W : 0),
    }).then(
      (s) => {
        if (cancelled) { s.destroy(); return; }
        made = s;
        setScene(s);
        s.sync(inputOf(useApp.getState()));
        unsub = useApp.subscribe((st, prev) => {
          if (st.selection !== prev.selection) s.reveal(st.selection);
          if (st.workspaces !== prev.workspaces || st.sessions !== prev.sessions || st.builders !== prev.builders)
            s.sync(inputOf(st));
        });
      },
      (e) => console.error('village scene failed to start', e),
    );
    return () => {
      cancelled = true;
      unsub?.();
      made?.destroy();
      setScene(null);
    };
  }, []);

  return (
    <>
      <div ref={host} className="village" data-testid="village" />
      {scene && <ZoomControls onZoomIn={() => scene.zoomBy(1.25)} onZoomOut={() => scene.zoomBy(1 / 1.25)} onFit={() => scene.fitVillage()} />}
    </>
  );
}
