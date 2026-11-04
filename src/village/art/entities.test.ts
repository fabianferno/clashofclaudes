import { describe, expect, it } from 'vitest';
import { PALETTE } from '../look';
import { shade } from './draw';
import {
  GROUND_SCALE, STROKE, drawBuilder, hammerPose, drawGate, drawGround, groundBakeSize, drawHall, drawHouse, drawStatusBar, drawStructure, drawTree, drawWallSeg,
} from './entities';
import { getTexture, clearTextures, textureCacheSize } from '../textures';
import { setSpritesForTest } from './sprites';
import { drawPathTile, pathLinks, pathTiles, treesOverPaths } from './ground';
import { iso } from '../iso';
import { HALL, gateInside, gateTile, placeCompound } from '../layout';
import type { AgentKind, Compound } from '../../api/types';

const AGENTS: AgentKind[] = ['claude', 'codex', 'antigravity', 'opencode', 'custom'];
const ok = (a: { canvas: HTMLCanvasElement; ax: number; ay: number }) => {
  expect(a.canvas.width).toBeGreaterThan(0);
  expect(a.canvas.height).toBeGreaterThan(0);
  expect(a.ax).toBeGreaterThan(0);
  expect(a.ay).toBeGreaterThan(0);
  expect(a.ax).toBeLessThanOrEqual(a.canvas.width);
  expect(a.ay).toBeLessThanOrEqual(a.canvas.height);
};

describe('art', () => {
  it('entities_draw_without_throwing', () => {
    ok(drawHall());
    for (const s of [0, 1, 2, 3, 4] as const) ok(drawHouse(s, '#d4683f', '#f3e2c4'));
    for (const a of AGENTS) {
      for (const st of ['foundation', 'scaffold', 'complete'] as const)
        for (const h of [0, 0.5, 1]) ok(drawStructure(a, st, h));
      for (const cls of [0, 1, 2, 3] as const)
        for (const gear of [0, 1, 2, 3, 4] as const)
          for (const pose of ['idle', 'walk0', 'walk1', 'hammer0', 'hammer1', 'hammer2', 'cheer', 'sad'] as const)
            for (const face of [1, -1] as const) ok(drawBuilder(a, cls, gear, pose, face));
    }
    for (const l of ['ew', 'ns', 'es', 'nw', 'nesw', '']) ok(drawWallSeg(l));
    for (const s of ['n', 's', 'e', 'w'] as const) ok(drawGate(s));
    for (const v of [0, 1, 2, 3] as const) ok(drawTree(v));
    ok(drawStatusBar('working', '12m · 34 steps'));
    ok(drawStatusBar('needs', 'Waiting for you'));
    ok(drawStatusBar('stuck', 'Stuck'));
    expect(drawStatusBar('working', '2h 15m · 1234 steps').canvas.width).toBeGreaterThan(drawStatusBar('stuck', 'Stuck').canvas.width);
    const comp: Compound = { x0: 6, y0: 6, w: 7, h: 7, house: { x: 6, y: 6 } };
    const g = drawGround({ x0: -20, y0: -20, w: 50, h: 50 }, [comp], 5);
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
  });

  it('ground_bakes_at_half_density', () => {
    const comp: Compound = { x0: 6, y0: 6, w: 7, h: 7, house: { x: 6, y: 6 } };
    const b = { x0: -20, y0: -20, w: 50, h: 50 };
    const full = groundBakeSize(b, 1), half = groundBakeSize(b);
    expect(GROUND_SCALE).toBe(0.5);
    // world size: 50 tiles wide and deep -> 50 * 64 px across (+2 * 40 pad), 50 * 32 px down (+40 pad + 90 top pad)
    expect(full.w).toBe(50 * 64 + 80);
    expect(full.h).toBe(50 * 32 + 40 + 90);
    expect(half).toMatchObject({ w: full.w, h: full.h, cw: Math.ceil(full.w / 2), ch: Math.ceil(full.h / 2) });
    expect(half.bytes).toBe(half.cw * half.ch * 4);
    expect(half.bytes).toBeLessThanOrEqual(full.bytes / 4 + 2 * (full.w + full.h) + 4);
    const g = drawGround(b, [comp], 5);
    expect(g.width).toBe(half.cw);
    expect(g.height).toBe(half.ch);
  });

  it('ground_is_deterministic', () => {
    const comp: Compound = { x0: 6, y0: 6, w: 7, h: 7, house: { x: 6, y: 6 } };
    const b = { x0: -10, y0: -10, w: 30, h: 30 };
    const calls = (seed: number) => JSON.stringify(drawGround(b, [comp], seed).getContext('2d')!.__getDrawCalls());
    expect(calls(7)).toBe(calls(7));
    expect(calls(7)).not.toBe(calls(8));
  });

  it('ground_clears_forest_under_a_clearing', () => {
    const b = { x0: -30, y0: -30, w: 60, h: 60 };
    // a patch out in the dense forest (far from the hall), as a collector dragged there
    const count = (cl: { x0: number; y0: number; w: number; h: number }[]) =>
      drawGround(b, [], 5, cl).getContext('2d')!.__getDrawCalls().length;
    const none = count([]), one = count([{ x0: -24, y0: -24, w: 2, h: 2 }]);
    expect(one).toBeLessThan(none);
  });

  it('shade_accepts_hex_and_rgb', () => {
    expect(shade('#808080', 0)).toBe('rgb(128,128,128)');
    expect(shade('rgb(128,128,128)', 0)).toBe('rgb(128,128,128)');
    expect(shade('rgb(200, 100, 50)', -0.5)).toBe('rgb(100,50,25)');
    expect(shade('#000000', 1)).toBe('rgb(255,255,255)');
  });
});

describe('painted sprites', () => {
  const img = (w: number, h: number) => Object.assign(document.createElement('img'), { width: w, height: h });
  const drew = (a: { canvas: HTMLCanvasElement }) =>
    a.canvas.getContext('2d')!.__getDrawCalls().filter((c: { type: string }) => c.type === 'drawImage').length;

  it('draw_functions_use_loaded_sprites_and_fall_back_without_them', () => {
    setSpritesForTest({
      'buildings/hall.png': img(760, 680),
      'buildings/house-stage-2-teal.png': img(600, 660),
      'buildings/house-stage-0.png': img(600, 660), // coral: the untinted house
      'sheets/trees-sheet.png': img(800, 260),
      'sheets/builder-master-claude.png': img(1540, 260),
      'structures/structure-foundation.png': img(440, 500),
      'structures/structure-complete-codex.png': img(440, 500),
      'ui/ribbon.png': img(140, 140),
    });
    try {
      expect(drawHall()).toMatchObject({ ax: 380, ay: 600 });
      expect(drawHall().canvas.width).toBe(760);
      // a teal roof picks the teal house; a roof with no sprite loaded falls back to baked art
      expect(drawHouse(2, '#2a9d8f', '#e6d7b8')).toMatchObject({ ax: 300, ay: 600 });
      expect(drawHouse(1, '#2a9d8f', '#e6d7b8').canvas.width).toBe(600); // procedural: 300 x 2
      expect(drew(drawHouse(0, '#c64a32', '#f3e2c4'))).toBe(1);
      expect(drawTree(3)).toMatchObject({ ax: 100, ay: 224 });
      const right = drawBuilder('claude', 2, 4, 'walk1', 1), left = drawBuilder('claude', 2, 4, 'walk1', -1);
      expect(right).toMatchObject({ ax: 110, ay: 200 });
      expect(drew(right)).toBe(1);
      // mirrored about the feet (x = 110 of the 220 px frame)
      expect(left.canvas.getContext('2d')!.__getDrawCalls()[0].transform.map((v: number) => v + 0)).toEqual([-1, 0, 0, 1, 220, 0]);
      // the cap badge goes on after the mirroring, so its mark never reads backwards
      const calls = left.canvas.getContext('2d')!.__getDrawCalls();
      const badge = calls.filter((c: { type: string }) => c.type === 'fill');
      expect(badge.length).toBeGreaterThan(0);
      expect(badge.every((c: { transform: number[] }) => c.transform[0] > 0)).toBe(true);
      // a Legend (Fable) is the Master's strip, a size up about the feet
      const legend = drawBuilder('claude', 3, 4, 'idle', 1);
      expect(drew(legend)).toBe(1);
      expect(legend.canvas.getContext('2d')!.__getDrawCalls()[0].transform.map((v: number) => +v.toFixed(2))).toEqual([1.08, 0, 0, 1.08, -8.8, -16]);
      expect(drew(drawBuilder('codex', 2, 4, 'idle', 1))).toBe(0); // no strip loaded: baked figure
      expect(drew(drawStructure('codex', 'foundation', 0))).toBe(1);
      expect(drew(drawStructure('codex', 'scaffold', 0.5))).toBe(2); // cloth, then the canvas climbing the frame
      expect(drew(drawStructure('codex', 'scaffold', 0))).toBe(1); // just the frame on the cloth
      expect(drew(drawStructure('codex', 'complete', 1))).toBe(2); // tent and ribbon
    } finally {
      setSpritesForTest(null);
    }
    expect(drew(drawHall())).toBe(0);
  });
});

describe('path tiles', () => {
  it('paths_cover_the_plaza_roads_and_house_pads_and_join_up', () => {
    const c = placeCompound([]);
    const tiles = pathTiles([c]);
    const has = (x: number, y: number) => tiles.has(`${x},${y}`);
    for (let y = HALL.y0; y < HALL.y0 + HALL.h; y++) for (let x = HALL.x0; x < HALL.x0 + HALL.w; x++) expect(has(x, y)).toBe(true);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) expect(has(c.house.x + x, c.house.y + y)).toBe(true);
    const g = gateTile(c), gi = gateInside(c);
    expect(has(g.x, g.y) && has(gi.x, gi.y)).toBe(true);
    // one connected network: from the plaza every path tile is reachable
    const seen = new Set([`${HALL.x0},${HALL.y0}`]), queue = [{ x: HALL.x0, y: HALL.y0 }];
    while (queue.length) {
      const t = queue.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${t.x + dx},${t.y + dy}`;
        if (tiles.has(k) && !seen.has(k)) { seen.add(k); queue.push({ x: t.x + dx, y: t.y + dy }); }
      }
    }
    expect(seen.size).toBe(tiles.size);
    const mid = { x: HALL.x0 + 2, y: HALL.y0 + 2 };
    expect(pathLinks(tiles, mid)).toBe('nesw');
    for (const l of ['', 'n', 'ns', 'nesw', 'esw']) ok(drawPathTile(l, 1));
  });
});

describe('palette', () => {
  it('custom_palette_matches_constraints', () => {
    expect(PALETTE.custom).toMatchObject({
      body: '#8d8a83', roof: '#7d7a74', wall: '#e4ded2', dark: '#4f4c47', hat: '#efeae0',
    });
    expect(PALETTE.claude).toMatchObject({ body: '#d97757', roof: '#d4683f', wall: '#f3e2c4' });
    expect(PALETTE.codex).toMatchObject({ body: '#3a3a40', roof: '#4a4d57', wall: '#cfccc5' });
    expect(PALETTE.antigravity).toMatchObject({ body: '#4f7cf0', roof: '#4f7cf0', wall: '#eef1f8' });
    expect(PALETTE.opencode).toMatchObject({ body: '#33a889', roof: '#2f9a7e', wall: '#dcbf92' });
  });
});

describe('textures', () => {
  const art = () => ({ canvas: document.createElement('canvas'), ax: 1, ay: 2 });
  const toTexture = () => ({ destroy: () => {} }) as never;

  it('texture_cache_reuses_and_evicts', () => {
    clearTextures();
    let made = 0;
    const make = () => { made++; return art(); };
    const a = getTexture('k', make, toTexture);
    const b = getTexture('k', make, toTexture);
    expect(b).toBe(a);
    expect(made).toBe(1);
    for (let i = 0; i < 300; i++) getTexture(`k${i}`, art, toTexture);
    expect(textureCacheSize()).toBeLessThanOrEqual(256);
    clearTextures();
    expect(textureCacheSize()).toBe(0);
  });
});

describe('treesOverPaths', () => {
  it('lifts_only_trees_standing_in_front_of_a_path_tile_and_near_it', () => {
    const c = placeCompound([]);
    const tiles = pathTiles([c]);
    const b = { x0: -30, y0: -30, w: 60, h: 60 };
    const lifted = treesOverPaths(b, [c], 7, [], tiles);
    const tops = [...tiles.values()].map((t) => iso(t.x + 0.5, t.y + 0.5));
    for (const t of lifted) {
      const p = iso(t.x, t.y);
      // the trunk stands below some tile's top edge and within a canopy's reach of it
      expect(tops.some((q) => p.y > q.y - 16 && p.y - q.y < 140 && Math.abs(p.x - q.x) < 100)).toBe(true);
    }
    expect(treesOverPaths(b, [c], 7, [], tiles)).toEqual(lifted); // deterministic
  });
});

test('a hammer stroke holds the hammer up, swings it down fast and rests on the work', () => {
  const at = (t: number, phase = 0) => hammerPose(t, phase);
  expect(at(0)).toBe('hammer0');
  expect(at(0.3)).toBe('hammer0');
  expect(at(0.48)).toBe('hammer1');
  expect(at(0.6)).toBe('hammer2');
  expect(at(0.78)).toBe('hammer1');
  expect(at(0.85)).toBe('hammer0');
  expect(at(STROKE + 0.6)).toBe('hammer2');
  expect(at(0.6, 0.5)).not.toBe(at(0.6)); // builders out of step
});
