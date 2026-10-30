import { PANEL_W } from '../village/camera';

/** Right-edge margin of the Build/Open group. */
export const BUILD_MARGIN = 14;
/** Width reserved for the Build/Open group (buttons ~180 px wide, with headroom). */
export const BUILD_W = 190;
/** Right-edge offset of the top-right resources (clear of the zoom column). */
export const RES_MARGIN = 64;

/** Distance the HUD must stay clear of at the right edge: the open panel, if any. */
export const panelInset = (panelOpen: boolean) => (panelOpen ? PANEL_W : 0);
/** Space the builders bar keeps free on its right so it never runs under Build/Open. */
export const rosterReserve = (_panelOpen: boolean) => BUILD_MARGIN + BUILD_W + 12;
