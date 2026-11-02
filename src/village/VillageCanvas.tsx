import { useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { boardKey, moveValid, useApp, type AppState } from '../state/store';
import ZoomControls from '../hud/ZoomControls';
import { PANEL_W } from './camera';
import { createScene, type BoardInput, type Scene, type VillageInput } from './scene';

/** The apps whose board has a spot, as the scene draws them. */
const boardsOf = (s: AppState): BoardInput[] => s.apps.flatMap((a) => {
  const key = boardKey(a), spot = s.boardSpots[key];
  return spot ? [{ key, workspaceId: a.workspaceId, url: a.url, label: a.title ?? a.command, port: a.port, frameable: a.frameable, spot }] : [];
});

const inputOf = (s: AppState): VillageInput => ({
  workspaces: s.workspaces,
  sessions: Object.values(s.sessions),
  builders: s.builders,
  closed: s.lastClosed,
  quotas: s.quotas,
  installed: s.agents.filter((a) => a.installed).map((a) => a.kind),
  collectorSpots: s.collectorSpots,
  boards: boardsOf(s),
});

/** The Pixi village, full-window; syncs from the store on every change (also while hidden). */
export default function VillageCanvas({ onError }: { onError?: (e: unknown) => void } = {}) {
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
      canMove: (t, at) => moveValid(useApp.getState(), t, at),
      onMove: (t, at) => useApp.getState().village.commitMove(t, at, onError),
      onClosedConsumed: (id) => useApp.getState().consumeClosed(id),
      onBuilderAssign: (builderId, id) => useApp.getState().setSelection({ kind: 'workspace', id, builder: builderId }),
      panelWidth: () => (useApp.getState().panelOpen ? PANEL_W : 0),
      // a page that refuses framing would pop out blank: that one goes to the browser
      onOpenApp: (b) => {
        if (b.frameable) useApp.getState().setAppPopout({ url: b.url, title: b.label });
        else openUrl(b.url).catch((e) => useApp.getState().setError(`Could not open ${b.url}: ${String(e)}`));
      },
    }).then(
      (s) => {
        if (cancelled) { s.destroy(); return; }
        made = s;
        setScene(s);
        s.sync(inputOf(useApp.getState()));
        s.select(useApp.getState().selection);
        unsub = useApp.subscribe((st, prev) => {
          if (st.zoomRequest !== prev.zoomRequest && st.zoomRequest) s.fitCompound(st.zoomRequest.id);
          if (st.selection !== prev.selection) { s.reveal(st.selection); s.select(st.selection); }
          if (st.workspaces !== prev.workspaces || st.sessions !== prev.sessions || st.builders !== prev.builders || st.lastClosed !== prev.lastClosed
            || st.quotas !== prev.quotas || st.agents !== prev.agents || st.collectorSpots !== prev.collectorSpots
            || st.apps !== prev.apps || st.boardSpots !== prev.boardSpots)
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
