export const TW = 64;
export const TH = 32;

/** Tile coordinates to isometric world (pixel) coordinates. */
export function iso(x: number, y: number): { x: number; y: number } {
  return { x: ((x - y) * TW) / 2, y: ((x + y) * TH) / 2 };
}

/** Inverse of `iso`. */
export function toGrid(wx: number, wy: number): { x: number; y: number } {
  const a = wx / (TW / 2); // x - y
  const b = wy / (TH / 2); // x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
}
