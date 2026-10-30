import { useEffect, useRef } from 'react';
import { useApp, type AppState } from '../state/store';
import { createScene, type Scene, type VillageInput } from './scene';

const inputOf = (s: AppState): VillageInput => ({
  workspaces: s.workspaces,
  sessions: Object.values(s.sessions),
  builders: s.builders,
});

/** The Pixi village, full-window; syncs from the store on every change (also while hidden). */
export default function VillageCanvas() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let scene: Scene | null = null;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    createScene(el).then(
      (s) => {
        if (cancelled) { s.destroy(); return; }
        scene = s;
        s.sync(inputOf(useApp.getState()));
        unsub = useApp.subscribe((st, prev) => {
          if (st.workspaces !== prev.workspaces || st.sessions !== prev.sessions || st.builders !== prev.builders)
            s.sync(inputOf(st));
        });
      },
      (e) => console.error('village scene failed to start', e),
    );
    return () => {
      cancelled = true;
      unsub?.();
      scene?.destroy();
    };
  }, []);

  return <div ref={host} className="village" data-testid="village" />;
}
