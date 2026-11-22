// The art seam: one replaceable draw function per entity. Everything else (textures.ts, the Pixi
// scene) only sees `Art`; swapping to hand-made sprites means re-implementing these functions.
export type { Art } from './draw';
export { BOARD, boardFacePoint, drawBoard, drawCollector, setBoardImage, drawHall, drawHouse, drawStructure, drawForge } from './buildings';
export { FORGE_FX, type Heat } from './sprites';
export { drawBuilder, hammerPose, STROKE, type Pose } from './builders';
export { drawWallSeg, drawGate, drawTree, drawGroundTree, drawBuilderShadow, drawBubble, drawRing, drawPuff, drawStatusBar, drawHallPlate, drawHousePlate } from './scenery';
export { GROUND_SCALE, drawGround, drawPathTile, groundBakeSize, groundOrigin, groundTrees, pathLinks, pathTiles, pathVariant, treesOverPaths, type GroundTree } from './ground';
