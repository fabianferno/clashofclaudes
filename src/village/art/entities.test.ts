import { describe, expect, it } from 'vitest';
import { PALETTE } from '../look';
import { shade } from './draw';
import {
  drawBuilder, drawGate, drawGround, drawHall, drawHouse, drawStructure, drawTree, drawWallSeg,
} from './entities';
import { getTexture, clearTextures, textureCacheSize } from '../textures';
import type { AgentKind, Compound } from '../../api/types';

const AGENTS: AgentKind[] = ['claude', 'codex', 'gemini', 'opencode', 'custom'];
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
      for (const cls of [0, 1, 2] as const)
        for (const gear of [0, 1, 2, 3, 4] as const)
          for (const pose of ['idle', 'walk0', 'walk1', 'hammer0', 'hammer1', 'cheer', 'sad'] as const)
            for (const face of [1, -1] as const) ok(drawBuilder(a, cls, gear, pose, face));
    }
    for (const d of ['x', 'y'] as const) ok(drawWallSeg(d));
    for (const s of ['n', 's', 'e', 'w'] as const) ok(drawGate(s));
    for (const v of [0, 1, 2, 3] as const) ok(drawTree(v));
    const comp: Compound = { x0: 6, y0: 6, w: 7, h: 7, house: { x: 6, y: 6 } };
    const g = drawGround({ x0: -20, y0: -20, w: 50, h: 50 }, [comp], 5);
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
  });

  it('ground_is_deterministic', () => {
    const comp: Compound = { x0: 6, y0: 6, w: 7, h: 7, house: { x: 6, y: 6 } };
    const b = { x0: -10, y0: -10, w: 30, h: 30 };
    const calls = (seed: number) => JSON.stringify(drawGround(b, [comp], seed).getContext('2d')!.__getDrawCalls());
    expect(calls(7)).toBe(calls(7));
    expect(calls(7)).not.toBe(calls(8));
  });

  it('shade_accepts_hex_and_rgb', () => {
    expect(shade('#808080', 0)).toBe('rgb(128,128,128)');
    expect(shade('rgb(128,128,128)', 0)).toBe('rgb(128,128,128)');
    expect(shade('rgb(200, 100, 50)', -0.5)).toBe('rgb(100,50,25)');
    expect(shade('#000000', 1)).toBe('rgb(255,255,255)');
  });
});

describe('palette', () => {
  it('custom_palette_matches_constraints', () => {
    expect(PALETTE.custom).toMatchObject({
      body: '#8d8a83', roof: '#7d7a74', wall: '#e4ded2', dark: '#4f4c47', hat: '#efeae0',
    });
    expect(PALETTE.claude).toMatchObject({ body: '#d97757', roof: '#d4683f', wall: '#f3e2c4' });
    expect(PALETTE.codex).toMatchObject({ body: '#3a3a40', roof: '#4a4d57', wall: '#cfccc5' });
    expect(PALETTE.gemini).toMatchObject({ body: '#4f7cf0', roof: '#4f7cf0', wall: '#eef1f8' });
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
