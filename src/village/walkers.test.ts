import { describe, expect, it } from 'vitest';
import type { Compound } from '../api/types';
import type { Tile } from '../api/types';
import { enclosure, seedOf } from './enclosure';
import { gateInside, gateOutside, placeCompound, roadPath, spotFor } from './layout';
import { ANCHOR_HOP, PLAZA, SPEED, blockedBy, dropOf, interiorPath, onGround, routeHome, retarget, routeToSite, standTile, step, takenBy, walkable, type Walker } from './walkers';

const mk = (over: Partial<Walker> = {}): Walker =>
  ({ id: 'b', x: 0, y: 0, path: [], mode: 'idle', face: 1, wait: 0, ...over });
const lcg = (seed = 1) => () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const east: Compound = { x0: 9, y0: -3, w: 7, h: 7, house: { x: 9, y: -3 } };
const centre = (t: { x: number; y: number }) => ({ x: t.x + 0.5, y: t.y + 0.5 });

describe('walkers', () => {
  it('route_goes_through_gate', () => {
    const spot = { x: 12, y: 1 };
    const r = routeToSite({ x: 4, y: 0 }, east, spot);
    const o = r.findIndex((p) => p.x === centre(gateOutside(east)).x && p.y === centre(gateOutside(east)).y);
    const i = r.findIndex((p) => p.x === centre(gateInside(east)).x && p.y === centre(gateInside(east)).y);
    expect(o).toBeGreaterThanOrEqual(0);
    expect(i).toBeGreaterThan(o);
    expect(r[r.length - 1]).toEqual(standTile(east, spot, east.house));
    const h = routeHome({ x: 12, y: 1 }, east);
    const ho = h.findIndex((p) => p.x === centre(gateOutside(east)).x && p.y === centre(gateOutside(east)).y);
    const hi = h.findIndex((p) => p.x === centre(gateInside(east)).x && p.y === centre(gateInside(east)).y);
    expect(hi).toBeGreaterThanOrEqual(0);
    expect(ho).toBeGreaterThan(hi);
  });

  it('route_follows_the_road_bends_both_ways', () => {
    const ne: Compound = { x0: 12, y0: -18, w: 7, h: 7, house: { x: 12, y: -14 } };
    const bends = roadPath(ne).slice(1, -1);
    expect(bends).toHaveLength(2);
    const to = routeToSite({ x: 4, y: 0 }, ne, { x: 15, y: -17 });
    expect(to.slice(0, 3)).toEqual([...bends, centre(gateOutside(ne))]);
    const home = routeHome({ x: 15, y: -14 }, ne);
    const o = home.findIndex((p) => p.x === centre(gateOutside(ne)).x && p.y === centre(gateOutside(ne)).y);
    expect(home.slice(o + 1, o + 3)).toEqual(bends.slice().reverse());
    // straight roads add no bends
    expect(routeToSite({ x: 4, y: 0 }, east, { x: 12, y: 1 })[0]).toEqual(centre(gateOutside(east)));
  });

  it('a_builder_set_down_wanders_around_that_spot_not_the_plaza', () => {
    const at = { x: -9, y: 9 };
    let w = mk({ x: at.x, y: at.y, anchor: at, wait: 0 });
    const rnd = lcg(3);
    for (let i = 0; i < 400; i++) {
      w = step(w, 0.1, rnd);
      expect(Math.hypot(w.x - at.x, w.y - at.y)).toBeLessThanOrEqual(ANCHOR_HOP + 1e-9);
    }
  });

  it('a_builder_waiting_at_the_gate_goes_straight_in', () => {
    const ne: Compound = { x0: 12, y0: -18, w: 7, h: 7, house: { x: 12, y: -14 } };
    const out = centre(gateOutside(ne));
    expect(routeToSite(out, ne, { x: 15, y: -17 })[0]).toEqual(out);
    expect(routeToSite({ x: 4, y: 0 }, ne, { x: 15, y: -17 })[0]).toEqual(roadPath(ne)[1]);
  });

  it('dropping_a_builder_assigns_it_sets_it_down_or_refuses', () => {
    const wss = [{ id: 'e', missing: false, compound: east }, { id: 'gone', missing: true, compound: { ...east, x0: -16, house: { x: -16, y: -3 } } }];
    expect(dropOf({ x: 12.3, y: 0.4 }, wss, [], true)).toEqual({ kind: 'assign', workspaceId: 'e' });
    expect(dropOf({ x: 8.5, y: 0.5 }, wss, [], true)).toEqual({ kind: 'assign', workspaceId: 'e' }); // on the wall counts
    expect(dropOf({ x: 12.3, y: 0.4 }, wss, [], false)).toEqual({ kind: 'blocked' }); // busy
    expect(dropOf({ x: -12, y: 0.5 }, wss, [], true)).toEqual({ kind: 'blocked' }); // folder missing
    expect(dropOf({ x: 0.5, y: 0.5 }, wss, [], true)).toEqual({ kind: 'blocked' }); // on the hall
    expect(dropOf({ x: 4.5, y: 0.5 }, wss, [], true)).toEqual({ kind: 'blocked' }); // hugging the hall
    expect(dropOf({ x: 6.5, y: 0.5 }, wss, [], true)).toEqual({ kind: 'blocked' }); // hugging the wall (x 8)
    expect(dropOf({ x: 0.5, y: 6.5 }, wss, [], false)).toEqual({ kind: 'place' }); // open ground, busy or not
    expect(dropOf({ x: 0.5, y: 6.5 }, wss, [{ x: 0, y: 6 }], true)).toEqual({ kind: 'blocked' }); // on a collector
    expect(dropOf({ x: 0.5, y: 40.5 }, wss, [], true)).toEqual({ kind: 'blocked' }); // off in the forest
  });

  it('standTile_offset', () => {
    const c: Compound = { x0: 0, y0: 0, w: 12, h: 12, house: { x: 0, y: 0 } };
    expect(standTile(c, { x: 5, y: 6 }, c.house)).toEqual({ x: 7.45, y: 7.1 });
  });

  it('standTile_not_east_in_last_columns', () => {
    const c: Compound = { x0: 9, y0: -3, w: 7, h: 7, house: { x: 9, y: -3 } };
    const st = standTile(c, { x: 14, y: 0 }, c.house); // east would be x=16.45, outside
    expect(st.x).toBeLessThan(c.x0 + c.w);
    expect(st).toEqual({ x: 15.1, y: 2.45 });
  });

  it('standTile_south_wall_falls_to_west', () => {
    const c: Compound = { x0: 9, y0: -3, w: 7, h: 7, house: { x: 12, y: 1 } };
    // east is on the house, south is outside the wall -> west
    expect(standTile(c, { x: 10, y: 2 }, c.house)).toEqual({ x: 9.55, y: 3.1 });
  });

  it('step_reaches_target_at_speed', () => {
    const dt = 0.05;
    let w = mk({ mode: 'toSite', path: [{ x: 10, y: 0 }] });
    let t = 0;
    while (w.path.length && t < 30) { w = step(w, dt, lcg()); t += dt; }
    expect(Math.abs(t - 10 / SPEED)).toBeLessThanOrEqual(dt + 1e-9);
    expect(w.mode).toBe('atSite');
    expect(w.x).toBeCloseTo(10, 5);
  });

  it('idle_stays_in_plaza', () => {
    const rnd = lcg(7);
    let w = mk({ x: 5, y: 0.5 });
    let moved = false;
    for (let i = 0; i < 1000; i++) {
      w = step(w, 0.1, rnd);
      if (Math.hypot(w.x - 5, w.y - 0.5) > 0.5) moved = true;
      expect(Math.hypot(w.x, w.y)).toBeLessThanOrEqual(PLAZA + 0.5);
    }
    expect(moved).toBe(true);
    expect(w.mode).toBe('idle');
  });

  it('face_follows_direction', () => {
    const a = step(mk({ face: -1, path: [{ x: 5, y: -5 }] }), 0.1, lcg());
    expect(a.face).toBe(1);
    const b = step(mk({ face: 1, path: [{ x: -5, y: 5 }] }), 0.1, lcg());
    expect(b.face).toBe(-1);
  });

  it('retarget_follows_a_moved_house', () => {
    const before: Compound = { x0: 9, y0: -3, w: 7, h: 7, house: { x: 9, y: -3 } };
    const after: Compound = { ...before, house: { x: 12, y: 1 } }; // gate and east stand tile are now different
    const spot = { x: 10, y: 2 };
    const at = retarget(mk({ mode: 'atSite', x: 12.45, y: 3.1 }), after, spot);
    expect(at).toMatchObject({ ...standTile(after, spot, after.house), mode: 'atSite', path: [] });
    const walking = mk({ mode: 'toSite', path: routeToSite({ x: 0, y: 0 }, before, spot).slice(1) });
    const re = retarget(walking, after, spot);
    expect(re.path).toEqual(routeToSite({ x: 0, y: 0 }, after, spot).slice(1));
    expect(re.path.length).toBe(2);
    const home = retarget(mk({ mode: 'home', path: routeHome({ x: 0, y: 0 }, before).slice(2) }), after, null);
    expect(home.path).toEqual(routeHome({ x: 0, y: 0 }, after).slice(2));
    expect(retarget(mk({ mode: 'idle' }), after, null).mode).toBe('idle');
  });

  it('routes_inside_organic_compounds_stay_on_walkable_ground', () => {
    const onGround = (walk: Set<string>, pts: Tile[]) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        for (let k = 0; k <= 20; k++) {
          const x = a.x + ((b.x - a.x) * k) / 20, y = a.y + ((b.y - a.y) * k) / 20;
          expect(walk.has(`${Math.floor(x)},${Math.floor(y)}`)).toBe(true);
        }
      }
    };
    let turns = 0;
    for (const seed of ['alpha', 'beta', 'gamma']) {
      let c = placeCompound([]);
      const spots: Tile[] = [];
      for (let i = 0; i < 6; i++) {
        const r = spotFor(c, [c], spots);
        c = r.compound;
        spots.push(r.spot);
      }
      const walk = walkable(enclosure(c, spots, 3, seedOf(seed)).inside, c, spots);
      for (const spot of spots) {
        const to = routeToSite({ x: 0, y: 5 }, c, spot, walk);
        const out = centre(gateOutside(c));
        // along the road (with any bends), then in through the gate
        const inAt = to.findIndex((p) => p.x === out.x && p.y === out.y) + 1;
        expect(to[inAt]).toEqual(centre(gateInside(c)));
        if (to.length - inAt > 2) turns++;
        onGround(walk, to.slice(inAt)); // gate inside -> stand, never through a wall, the house or a tent
        const stand = to[to.length - 1];
        const home = routeHome(stand, c, walk);
        onGround(walk, [stand, ...home.slice(0, home.indexOf(home.find((p) => p.x === centre(gateInside(c)).x && p.y === centre(gateInside(c)).y)!) + 1)]);
      }
    }
    expect(turns).toBeGreaterThan(0); // some sites are not in a straight line from the gate
  });

  it('interior_path_falls_back_off_the_ground', () => {
    const walk = new Set(['0,0', '1,0']);
    expect(interiorPath(walk, { x: 5.5, y: 5.5 }, { x: 0.5, y: 0.5 })).toEqual([{ x: 0.5, y: 0.5 }]);
    expect(interiorPath(walk, { x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 })).toEqual([{ x: 1.5, y: 0.5 }]);
  });

  it('retarget_over_walkable_ground_keeps_the_gate_and_routes_from_the_builder', () => {
    let c = placeCompound([]);
    const spots: Tile[] = [];
    for (let i = 0; i < 6; i++) {
      const r = spotFor(c, [c], spots);
      c = r.compound;
      spots.push(r.spot);
    }
    const walk = walkable(enclosure(c, spots, 3, seedOf('alpha')).inside, c, spots);
    const gO = centre(gateOutside(c)), gI = centre(gateInside(c));
    for (const spot of spots) {
      // A: still outside with [gate outside, gate inside, stand] left -> the new route keeps both gate points
      const out = retarget(mk({ x: gO.x - 3, y: gO.y, mode: 'toSite', path: [gO, gI, { x: 0, y: 0 }] }), c, spot, walk);
      expect(out.path[0]).toEqual(gO);
      expect(out.path[1]).toEqual(gI);
      // B: inside with only the stand point left -> routed from where it stands, on the ground
      const at = mk({ x: gI.x, y: gI.y, mode: 'toSite', path: [{ x: 0, y: 0 }] });
      const inside = retarget(at, c, spot, walk);
      expect(inside.path[inside.path.length - 1]).toEqual(standTile(c, spot, c.house, walk));
      for (const p of inside.path) expect(onGround(walk, p)).toBe(true);
      // C: heading home from inside -> the whole way out, through the gate
      const home = retarget({ ...at, mode: 'home', path: [gO] }, c, null, walk);
      expect(home.path).toEqual(routeHome(at, c, walk));
      expect(home.path).toContainEqual(gO);
    }
  });
});

describe('keeping off blocked ground', () => {
  // a 2x2 collector on the plaza ring, east of the hall, grown by half a tile
  const tank = blockedBy([{ x0: 4.5, y0: -0.5, w: 3, h: 3 }]);
  const idle = (x: number, y: number): Walker => ({ id: 'b', x, y, path: [], mode: 'idle', face: 1, wait: 0 });

  it('idle_builders_never_wander_onto_or_across_a_collector', () => {
    const next = lcg(7);
    for (let start = 0; start < 40; start++) {
      const a = (start / 40) * Math.PI * 2;
      const from = idle(0.5 + Math.cos(a) * 5.1, 0.5 + Math.sin(a) * 5.1);
      if (tank(from)) continue; // standing on it: walks off (next test)
      const w = step(from, 0.01, next, tank);
      for (const t of w.path) {
        expect(tank(t)).toBe(false);
        for (let i = 1; i <= 20; i++) expect(tank({ x: w.x + ((t.x - w.x) * i) / 20, y: w.y + ((t.y - w.y) * i) / 20 })).toBe(false);
      }
    }
  });

  it('a_builder_standing_on_a_collector_walks_off_it', () => {
    const w = step(idle(6, 1), 0.01, () => 0.3, tank);
    expect(w.path).toHaveLength(1);
    expect(tank(w.path[0])).toBe(false);
  });

  it('the_walk_home_ends_beside_a_collector_not_in_it', () => {
    const c = placeCompound([]);
    const home = routeHome(gateOutside(c), c), end = home[home.length - 1];
    const block = blockedBy([{ x0: end.x - 1, y0: end.y - 1, w: 2, h: 2 }]);
    const moved = routeHome(gateOutside(c), c, undefined, block);
    expect(block(moved[moved.length - 1])).toBe(false);
  });
});

describe('spacing', () => {
  it('an idle builder never picks a spot where another stands or is heading', () => {
    const others = [{ x: 5.1, y: 0.5 }, { x: 0.5, y: 5.1 }];
    const taken = takenBy(others);
    expect(taken({ x: 5.3, y: 0.7 })).toBe(true);
    expect(taken({ x: 0.5 - 5.1, y: 0.5 })).toBe(false);
    let seed = 1;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < 200; i++) {
      const w = step({ id: 'a', x: 0.5 + 5, y: 0.5 + 1, path: [], mode: 'idle', face: 1, wait: 0 }, 0.01, rnd, undefined, taken);
      for (const t of w.path) expect(taken(t)).toBe(false);
    }
  });
});
