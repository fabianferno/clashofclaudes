// The art seam: one replaceable draw function per entity. Everything else (textures.ts, the Pixi
// scene) only sees `Art`; swapping to hand-made sprites means re-implementing these functions.
export type { Art } from './draw';
export { BOARD, boardFacePoint, drawBoard, drawCollector, setBoardImage, drawHall, drawHouse, drawStructure, drawRuneStone } from './buildings';
export { drawBuilder, type Pose } from './builders';
export { drawWallSeg, drawGate, drawTree, drawGroundTree, drawBuilderShadow, drawBubble, drawRing, drawPuff, drawStatusBar } from './scenery';
export { GROUND_SCALE, drawGround, drawPathTile, groundBakeSize, groundOrigin, pathLinks, pathTiles, treesOverPaths, type GroundTree } from './ground';
