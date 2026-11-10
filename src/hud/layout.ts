import { useApp } from '../state/store';
import { getPanelWidth, usePanelWidth } from '../state/panelWidth';

/** Right-edge margin of the Build/Open group. */
export const BUILD_MARGIN = 14;
/** Width reserved for the Build/Open group (buttons ~180 px wide, with headroom). */
export const BUILD_W = 190;
/** Right-edge offset of the top-right resources: the zoom column's margin (it stays below them). */
export const RES_MARGIN = 12;

/** Distance the HUD must stay clear of at the right edge: the open panel (as wide as dragged), if any. */
export const panelInset = (panelOpen: boolean, width = getPanelWidth()) => (panelOpen ? width : 0);
/** `panelInset` as a hook: re-renders while the panel opens, closes or is being resized. */
export function usePanelInset(): number {
  const panelOpen = useApp((s) => s.panelOpen);
  const width = usePanelWidth((s) => s.width);
  return panelInset(panelOpen, width);
}
/** Space the builders bar keeps free on its right so it never runs under Build/Open. */
export const rosterReserve = (_panelOpen: boolean) => BUILD_MARGIN + BUILD_W + 12;

/** Clear space the top-centre stats keep from the Village level block and the resource column. */
export const STATS_CLEAR = 16;
/** Gap between the two stats when they sit in a row. */
export const STATS_GAP = 34;

export type StatsPlacement = { mode: 'center'; left: number; right: number } | { mode: 'column' };

/**
 * Where the top-centre stats (builders busy, shipped today) go: centred in the band between the
 * top-left block (its right edge `leftEdge`) and the resource column (`resWidth` wide, standing
 * `resRight` from the window's right edge), or, when that band is narrower than their row
 * (`rowWidth`), under the resource bars in that column, so they never overlap. All in px.
 */
export function statsPlacement(vw: number, leftEdge: number, resRight: number, resWidth: number, rowWidth: number): StatsPlacement {
  const left = leftEdge + STATS_CLEAR;
  const right = resRight + resWidth + STATS_CLEAR;
  return vw - left - right >= rowWidth ? { mode: 'center', left, right } : { mode: 'column' };
}
