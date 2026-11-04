import type { Selection } from '../state/store';
import type { Scene } from './scene';

/**
 * The live village scene, for the parts of the UI that point into it (the tour's spotlight).
 * VillageCanvas registers it; null while the scene is starting or gone.
 */
let current: Scene | null = null;

export function setProbeScene(scene: Scene): void {
  current = scene;
}

/** A scene going away lets go only of itself (StrictMode makes two and destroys one, in either order). */
export function clearProbeScene(scene: Scene): void {
  if (current === scene) current = null;
}

/** Where the thing is in the window (CSS px) and roughly how big; null when it is not drawn. */
export function locate(sel: Selection): { x: number; y: number; r: number } | null {
  return current?.locate(sel) ?? null;
}

/** Ease the camera to show the whole village (no-op without a scene). */
export function fitVillage(): void {
  current?.fitVillage();
}
