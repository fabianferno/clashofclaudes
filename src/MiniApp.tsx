import { useEffect } from 'react';
import { subscribeState } from './state/hydrate';
import { loadSettings } from './state/settings';
import VillageCanvas from './village/VillageCanvas';
import './App.css';

/**
 * The mini village: the village alone in a small panel that stays on top (`?view=mini`, see
 * src-tauri/src/mini.rs; the panel's title bar and close button are the system's). It only watches: it follows the backend's updates into its own store and
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
    <VillageCanvas mini />
  );
}
