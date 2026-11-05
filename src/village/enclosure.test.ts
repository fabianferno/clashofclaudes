import { describe, expect, it } from 'vitest';
import type { Compound, Tile } from '../api/types';
import { enclosure, seedOf } from './enclosure';
import { HOUSE, STRUCT, gateInside, gateOutside, gateTile, placeCompound, spotFor, wallRect } from './layout';

const key = (t: Tile) => `${t.x},${t.y}`;

/** A fresh compound east of the hall with `n` structures placed the usual way. */
function grown(n: number): { c: Compound; spots: Tile[] } {
  let c = placeCompound([]);
  const spots: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const r = spotFor(c, [c], spots);
    c = r.compound;
    spots.push(r.spot);
  }
  return { c, spots };
}

describe('enclosure', () => {
  it('keeps the ground inside the compound rect and the walls on or inside its ring', () => {
    for (const n of [0, 2, 6]) {
      const { c, spots } = grown(n);
      const e = enclosure(c, spots, 1, seedOf('w'));
      const r = wallRect(c);
      for (const k of e.inside) {
        const [x, y] = k.split(',').map(Number);
        expect(x >= c.x0 && x < c.x0 + c.w && y >= c.y0 && y < c.y0 + c.h).toBe(true);
      }
      for (const w of e.walls) expect(w.x >= r.x0 && w.x < r.x0 + r.w && w.y >= r.y0 && w.y < r.y0 + r.h).toBe(true);
    }
  });

  it('encloses the house and every structure with a tile to spare, and the gate opens onto ground', () => {
    const { c, spots } = grown(4);
    const e = enclosure(c, spots, 2, seedOf('w'));
    const covered = (x0: number, y0: number, s: number) => {
      for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) expect(e.inside.has(`${x},${y}`)).toBe(true);
    };
    covered(c.house.x, c.house.y, HOUSE);
    for (const s of spots) covered(s.x, s.y, STRUCT);
    const walls = new Set(e.walls.map(key));
    expect(walls.has(key(gateTile(c)))).toBe(true);
    expect(e.inside.has(key(gateInside(c)))).toBe(true);
    expect(e.inside.has(key(gateOutside(c))) || walls.has(key(gateOutside(c)))).toBe(false);
  });

  it('keeps two tiles of ground between every structure and the wall, so builders and art stay off it', () => {
    for (const n of [1, 4, 9]) {
      const { c, spots } = grown(n);
      const e = enclosure(c, spots, 0, seedOf('w'));
      for (const s of spots) {
        for (const w of e.walls) {
          const d = Math.max(s.x - w.x, w.x - (s.x + STRUCT - 1), s.y - w.y, w.y - (s.y + STRUCT - 1));
          expect(d).toBeGreaterThan(2);
        }
      }
    }
  });

  it('closes the ring: every ground tile is surrounded by ground or wall', () => {
    const { c, spots } = grown(5);
    const e = enclosure(c, spots, 3, seedOf('x'));
    const walls = new Set(e.walls.map(key));
    for (const k of e.inside) {
      const [x, y] = k.split(',').map(Number);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const n = `${x + dx},${y + dy}`;
        expect(e.inside.has(n) || walls.has(n)).toBe(true);
      }
    }
  });

  it('starts smaller than its reserved rect and grows as sessions are added', () => {
    const empty = grown(0);
    const small = enclosure(empty.c, [], 1, seedOf('w')).inside.size;
    expect(small).toBeLessThan(empty.c.w * empty.c.h * 0.6);
    const busy = grown(5);
    expect(enclosure(busy.c, busy.spots, 1, seedOf('w')).inside.size).toBeGreaterThan(small);
  });

  it('is deterministic per workspace and differs between workspaces', () => {
    const { c } = grown(0);
    const shape = (id: string) => [...enclosure(c, [], 1, seedOf(id)).inside].sort().join(' ');
    expect(shape('alpha')).toBe(shape('alpha'));
    expect(new Set(['alpha', 'beta', 'gamma', 'delta'].map(shape)).size).toBeGreaterThan(1);
  });

  it('links_every_wall_tile_to_its_wall_neighbours_so_the_ring_has_no_gaps', () => {
    for (const lvl of [1, 3, 5]) {
      const { c, spots } = grown(lvl);
      const { walls } = enclosure(c, spots, lvl, seedOf('w'));
      const at = new Map(walls.map((t) => [`${t.x},${t.y}`, t]));
      const step = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] } as const;
      const back = { n: 's', e: 'w', s: 'n', w: 'e' } as const;
      for (const t of walls) {
        expect(t.links.length).toBeGreaterThanOrEqual(2); // a closed ring: no dead ends or lone posts
        for (const d of t.links as unknown as (keyof typeof step)[]) {
          const o = at.get(`${t.x + step[d][0]},${t.y + step[d][1]}`)!;
          expect(o.links).toContain(back[d]); // links are mutual
        }
      }
      expect(new Set(walls.map((t) => t.links))).toContain('es'); // corners join both runs
    }
  });
});
