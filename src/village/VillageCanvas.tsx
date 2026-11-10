import { useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { boardItems, moveValid, useApp, type AppState } from '../state/store';
import ZoomControls from '../hud/ZoomControls';
import { getPanelWidth, usePanelWidth } from '../state/panelWidth';
import { createScene, type BoardInput, type Scene, type VillageInput } from './scene';
import { setBoardImage } from './art/entities';
import { clearProbeScene, setProbeScene } from './probe';
import { splashReady } from '../splash';
import { zoomKey } from './zoomKey';
import { hapticFor, playHaptic } from '../state/haptics';

export { zoomKey };

/** Each page's decoded snapshot: the store's `at` it came from and its key for `drawBoard`. */
const decoded = new Map<string, { at: number; key: string }>();
let snapSeq = 0;

/** The boards that have a spot, as the scene draws them (with a snapshot once one is decoded). */
const boardsOf = (s: AppState): BoardInput[] => boardItems(s).flatMap((b) =>
  (s.boardSpots[b.key] ? [{ ...b, spot: s.boardSpots[b.key], snapshot: decoded.get(b.url)?.key }] : []));

/** Decode snapshots that arrived, swap each into its board, and let go of pages no board shows. */
async function decodeSnapshots(s: AppState): Promise<boolean> {
  let changed = false;
  const shown = new Set(boardItems(s).map((b) => b.url));
  for (const [url, d] of decoded) {
    if (shown.has(url)) continue;
    setBoardImage(d.key, null);
    decoded.delete(url);
    changed = true;
  }
  for (const [url, snap] of Object.entries(s.snapshots)) {
    if (!shown.has(url) || decoded.get(url)?.at === snap.at) continue;
    const img = new Image();
    img.src = snap.data;
    try { await img.decode(); } catch { continue; }
    const key = `s${++snapSeq}`;
    const old = decoded.get(url);
    setBoardImage(key, img);
    decoded.set(url, { at: snap.at, key });
    if (old) setBoardImage(old.key, null);
    changed = true;
  }
  return changed;
}

const inputOf = (s: AppState): VillageInput => ({
  workspaces: s.workspaces,
  sessions: Object.values(s.sessions),
  builders: s.builders,
  closed: s.lastClosed,
  quotas: s.quotas,
  installed: s.agents.filter((a) => a.installed).map((a) => a.kind),
  collectorSpots: s.collectorSpots,
  boards: boardsOf(s),
  ownerName: s.settings?.playerName ?? null,
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
      // a tap under the finger as the held builder crosses into a workspace; nothing to tell the owner if it fails
      onBuilderOver: () => playHaptic(hapticFor('drop')),
      // the pointer comes over a workspace's house or the Town Hall (Settings › Haptics picks the feel)
      onBuildingHover: () => playHaptic(hapticFor('hover')),
      panelWidth: () => (useApp.getState().panelOpen ? getPanelWidth() : 0),
      openPanelWidth: getPanelWidth,
      // a page that refuses framing would pop out blank: that one goes to the browser
      onOpenApp: (b) => {
        if (b.frameable) useApp.getState().setAppPopout({ url: b.url, title: b.label, key: b.key, browserId: b.browserId });
        else openUrl(b.url).catch((e) => useApp.getState().setError(`Could not open ${b.url}: ${String(e)}`));
      },
    }).then(
      (s) => {
        if (cancelled) { s.destroy(); return; }
        made = s;
        setScene(s);
        setProbeScene(s);
        s.sync(inputOf(useApp.getState()));
        s.select(useApp.getState().selection);
        s.setCovered(useApp.getState().covers > 0);
        splashReady('scene');
        unsub = useApp.subscribe((st, prev) => {
          if (st.zoomRequest !== prev.zoomRequest && st.zoomRequest) s.fitCompound(st.zoomRequest.id);
          if (st.covers !== prev.covers) s.setCovered(st.covers > 0);
          if (st.snapshots !== prev.snapshots || st.apps !== prev.apps || st.browsers !== prev.browsers)
            void decodeSnapshots(st).then((changed) => { if (changed && !cancelled) s.sync(inputOf(useApp.getState())); });
          if (st.selection !== prev.selection) { s.reveal(st.selection); s.select(st.selection); }
          if (st.workspaces !== prev.workspaces || st.sessions !== prev.sessions || st.builders !== prev.builders || st.lastClosed !== prev.lastClosed
            || st.quotas !== prev.quotas || st.agents !== prev.agents || st.collectorSpots !== prev.collectorSpots
            || st.apps !== prev.apps || st.browsers !== prev.browsers || st.boardSpots !== prev.boardSpots
            || st.settings?.playerName !== prev.settings?.playerName)
            s.sync(inputOf(st));
        });
      },
      (e) => { console.error('village scene failed to start', e); splashReady('scene'); },
    );
    return () => {
      cancelled = true;
      unsub?.();
      if (made) clearProbeScene(made);
      made?.destroy();
      setScene(null);
    };
  }, []);

  // A panel dragged wider must not cover what it shows: keep the selection in the room left of it.
  useEffect(() => {
    if (!scene) return;
    return usePanelWidth.subscribe((st, prev) => {
      if (st.width === prev.width) return;
      const { panelOpen, selection } = useApp.getState();
      if (panelOpen) scene.reveal(selection);
    });
  }, [scene]);

  // Cmd +/- like the zoom buttons, unless a pop-out or the Kanban covers the village
  useEffect(() => {
    if (!scene) return;
    const onKey = (e: KeyboardEvent) => {
      const z = zoomKey(e);
      if (!z || useApp.getState().covers > 0) return;
      e.preventDefault();
      if (z === 'fit') scene.fitVillage();
      else scene.zoomBy(z === 'in' ? 1.25 : 1 / 1.25);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scene]);

  return (
    <>
      <div ref={host} className="village" data-testid="village" />
      {scene && <ZoomControls onZoomIn={() => scene.zoomBy(1.25)} onZoomOut={() => scene.zoomBy(1 / 1.25)} onFit={() => scene.fitVillage()} />}
    </>
  );
}
