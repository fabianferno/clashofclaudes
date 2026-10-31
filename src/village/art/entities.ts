// The art seam: one replaceable draw function per entity. Everything else (textures.ts, the Pixi
// scene) only sees `Art`; swapping to hand-made sprites means re-implementing these functions.
export type { Art } from './draw';
export { drawHall, drawHouse, drawStructure } from './buildings';
export { drawBuilder, type Pose } from './builders';
export { drawWallSeg, drawGate, drawTree, drawBadge, drawBubble, drawRing, drawPuff, drawStatusBar } from './scenery';
export { GROUND_SCALE, drawGround, groundBakeSize, groundOrigin } from './ground';
