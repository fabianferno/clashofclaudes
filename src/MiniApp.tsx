import { useEffect } from 'react';
import { ipc } from './api/ipc';
import { subscribeState } from './state/hydrate';
import { loadSettings } from './state/settings';
import VillageCanvas from './village/VillageCanvas';
import './App.css';
import './MiniApp.css';

/**
 * The mini village: the village alone in a small window that stays on top (`?view=mini`, see
 * src-tauri/src/mini.rs). It only watches: it follows the backend's updates into its own store and
 * draws them. Everything that acts (To Dos that start themselves, layout, snapshots, sounds, the
 * elixir notice, the tour) is the main window's and must not run here, or it would happen twice.
 * A click on a builder or a structure brings the main window up on it.
 */
export default function MiniApp() {
  useEffect(() => {
    const sub = subscribeState((e) => console.error('mini village', e));
    sub.loaded.catch(() => {});
    loadSettings().catch(() => {}); // the Town Hall's plate
    return sub.stop;
  }, []);
  return (
    <div className="mini">
      <header className="mini-bar" data-tauri-drag-region>
        <span className="mini-title" data-tauri-drag-region>Mini Village</span>
        <button className="mini-close" aria-label="Close mini village" onClick={() => { ipc.toggleMini().catch((e) => console.error(e)); }}>✕</button>
      </header>
      <VillageCanvas mini />
    </div>
  );
}
