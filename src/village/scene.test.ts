import { describe, expect, it } from 'vitest';
import type { AgentQuota, Builder, Compound, SessionInfo, SessionState, Tile, Workspace } from '../api/types';
import { findSpot, gapBetween, placeCompound, wallRect } from './layout';
import { COLLECTOR_SLOT } from './quota';
import { enclosure, seedOf } from './enclosure';
import { scaffoldHeight } from './look';
import { HALL_LIFT, buildEntities, hopOf, siteDepth, needsRefit, rendererOptions, structureLook, type VillageInput, gateAwareDepth, footprintAwareDepth, walkerDepth, type FootDepth } from './scene';
import { statusSignature, statusesDue } from './status';

const ws = (id: string, compound: Compound | null, level = 1): Workspace => ({
  id, name: id, path: `/p/${id}`, createdAt: 0, missing: false, level, xp: 0, compound,
});
const sess = (
  id: string, wsId: string, builderId: string | null, spot: Tile | null,
  state: SessionState = { kind: 'working' }, steps = 0, reachedFinished = false,
): SessionInfo => ({
  id, workspaceId: wsId, kind: builderId ? { kind: 'agent', builderId } : { kind: 'terminal' },
  task: null, state, steps, startedAt: 0, lastOutputAt: 0, reachedFinished, worktree: null,
  commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot,
});
const bld = (id: string, agent: Builder['agent'] = 'claude'): Builder =>
  ({ id, name: id, agent, model: null, effort: null, customCommand: null });

describe('buildEntities', () => {
  it('walls_beside_the_house_front_draw_over_it', () => {
    // the house in the interior's back-right corner: walls run along its east face
    const c: Compound = { x0: -4, y0: 10, w: 7, h: 7, house: { x: 0, y: 10 } };
    const es = buildEntities({ workspaces: [ws('w1', c, 2)], builders: [], sessions: [] });
    const house = es.find((e) => e.kind === 'house')!;
    const walls = es.filter((e) => e.kind === 'wall' || e.kind === 'gate');
    const at = (x: number, y: number) => walls.find((e) => e.x === x + 1 && e.y === y + 1);
    for (const y of [10, 11, 12]) if (at(3, y)) expect(at(3, y)!.depth).toBeGreaterThan(house.depth);
    expect(at(3, 11)).toBeTruthy();
    for (const x of [0, 1, 2]) if (at(x, 9)) expect(at(x, 9)!.depth).toBeLessThan(house.depth); // behind it
    const order = buildEntities({ workspaces: [ws('w1', c, 2)], builders: [], sessions: [] }).map((e) => e.id);
    expect(order.indexOf(at(3, 10)?.id ?? at(3, 11)!.id)).toBeGreaterThan(order.indexOf(house.id));
  });

  it('status_bars_over_working_needs_and_stuck_structures_only', () => {
    const c1 = placeCompound([]);
    const spots: Tile[] = [];
    for (let i = 0; i < 4; i++) spots.push(findSpot(c1, spots)!);
    const input: VillageInput = {
      workspaces: [ws('w1', c1)],
      builders: [bld('b1'), bld('b2'), bld('b3'), bld('b4')],
      sessions: [
        { ...sess('a1', 'w1', 'b1', spots[0], { kind: 'working' }, 34), startedAt: 1000 },
        sess('a2', 'w1', 'b2', spots[1], { kind: 'needsYou', reason: null } as unknown as SessionState),
        sess('a3', 'w1', 'b3', spots[2], { kind: 'stuck', reason: 'quiet' }),
        sess('a4', 'w1', 'b4', spots[3], { kind: 'finished' }),
      ],
    };
    const structBars = (es: ReturnType<typeof buildEntities>) => es.filter((e) => e.kind === 'status' && !e.id.startsWith('status:house:') && e.id !== 'status:hall');
    expect(structBars(buildEntities(input))).toEqual([]); // no clock, no bars
    const bars = structBars(buildEntities({ ...input, now: 1000 + 12 * 60_000 }));
    expect(Object.fromEntries(bars.map((e) => [e.id, e.texKey]))).toEqual({
      'status:a1': 'status:working:12m · 34 steps',
      'status:a2': 'status:needs:Waiting for you · 12m',
      'status:a3': 'status:stuck:Stuck · 12m',
    });
    const bar = bars.find((e) => e.id === 'status:a1')!;
    expect([bar.x, bar.y]).toEqual([spots[0].x + 1, spots[0].y + 1]); // over the structure's centre
  });

  it('each_house_carries_its_workspace_name_over_the_roof', () => {
    const c1 = placeCompound([]);
    const plate = buildEntities({ workspaces: [{ ...ws('w1', c1), name: 'my:app' }], builders: [], sessions: [] })
      .find((e) => e.id === 'status:house:w1')!;
    expect(plate).toMatchObject({ kind: 'status', texKey: 'houseplate:my app', x: c1.house.x + 1.5, y: c1.house.y + 1.5 });
    expect(plate.lift).toBeGreaterThan(140); // above the roof, not at a structure's height
  });

  it('the_hall_carries_its_owners_name_on_a_plate_over_the_flag', () => {
    const plateOf = (ownerName?: string | null) => buildEntities({ workspaces: [], builders: [], sessions: [], ownerName })
      .find((e) => e.id === 'status:hall')!;
    expect(plateOf('Fabian')).toMatchObject({ kind: 'status', texKey: "hallplate:Fabian's Town Hall", x: 0.5, y: 0.5 });
    expect(plateOf('Fabian').lift).toBe(HALL_LIFT);
    expect(HALL_LIFT).toBeGreaterThan(200); // over the hall's flag, far above a house's plate
    expect(plateOf(null).texKey).toBe('hallplate:Town Hall'); // before a name is given
    expect(plateOf('  ').texKey).toBe('hallplate:Town Hall');
    expect(plateOf('a:b').texKey).toBe("hallplate:a b's Town Hall"); // texture keys split on ':'
  });

  it('the_hall_plate_is_part_of_the_status_signature_so_a_rename_is_not_a_resync_every_second', () => {
    const es = buildEntities({ workspaces: [], builders: [], sessions: [], ownerName: 'Ada' });
    expect(statusesDue(es, [], 0)).toBe(statusSignature(es));
  });

  it('entities_for_two_workspaces_and_three_sessions', () => {
    const c1 = placeCompound([]);
    const c2 = placeCompound([c1]);
    const s1 = findSpot(c1, [])!;
    const s2 = findSpot(c1, [s1])!;
    const s3 = findSpot(c2, [])!;
    const input: VillageInput = {
      workspaces: [ws('w1', c1), ws('w2', c2)],
      builders: [bld('b1'), bld('b2', 'codex'), bld('b3', 'antigravity')],
      sessions: [
        sess('a1', 'w1', 'b1', s1),
        sess('a2', 'w1', 'b2', s2),
        sess('a3', 'w2', 'b3', s3),
        sess('t1', 'w1', null, null),
      ],
    };
    const es = buildEntities(input);
    const count = (k: string) => es.filter((e) => e.kind === k).length;
    expect(count('hall')).toBe(1);
    expect(count('house')).toBe(2);
    expect(count('structure')).toBe(3);
    // the organic wall around each compound's ground, minus the one gate tile per compound
    const walls = (id: string, c: Compound, spots: Tile[]) => enclosure(c, spots, 1, seedOf(id)).walls.length - 1;
    expect(count('wall')).toBe(walls('w1', c1, [s1, s2]) + walls('w2', c2, [s3]));
    for (const e of es.filter((x) => x.kind === 'wall')) {
      const [, wsId, tx, ty] = e.id.split(':');
      const r = wallRect(wsId === 'w1' ? c1 : c2);
      expect(+tx >= r.x0 && +tx < r.x0 + r.w && +ty >= r.y0 && +ty < r.y0 + r.h).toBe(true);
    }
    expect(count('gate')).toBe(2);
    // a terminal without a spot (yet) adds no structure
    expect(es.some((e) => e.id === 'struct:t1')).toBe(false);
  });

  it('app_boards_show_their_snapshot_or_a_card_and_count_for_the_walls', () => {
    const c1 = placeCompound([]);
    const s1 = findSpot(c1, [])!;
    const s2 = findSpot(c1, [s1])!;
    const board = (key: string, spot: Tile, snapshot?: string) =>
      ({ key, workspaceId: 'w1', url: 'http://localhost:3000/', label: 'Shop: admin', port: 3000, frameable: true, spot, snapshot });
    const input: VillageInput = { workspaces: [ws('w1', c1)], builders: [], sessions: [], boards: [board('w1:3000', s1, 's7'), board('w1:4000', s2)] };
    const es = buildEntities(input);
    const shot = es.find((e) => e.id === 'board:w1:3000')!;
    expect([shot.kind, shot.x, shot.y, shot.texKey]).toEqual(['board', s1.x + 2, s1.y + 2, `board:${encodeURIComponent('Shop: admin')}:s7`]);
    expect(es.find((e) => e.id === 'board:w1:4000')?.texKey).toBe(`board:${encodeURIComponent('Shop: admin')}:`); // a card until pictured
    expect(es.find((e) => e.id === 'status:board:w1:3000')?.texKey).toBe('status:app:Shop  admin \u00b7 3000');
    expect(es.filter((e) => e.kind === 'wall')).toHaveLength(enclosure(c1, [s1, s2], 1, seedOf('w1')).walls.length - 1);
    // no compound, no board
    expect(buildEntities({ ...input, workspaces: [ws('w1', null)] }).some((e) => e.kind === 'board')).toBe(false);
  });

  it('terminals_stand_as_rune_stones_lit_only_while_a_command_runs', () => {
    const c1 = placeCompound([]);
    const s1 = findSpot(c1, [])!;
    const s2 = findSpot(c1, [s1])!;
    const input: VillageInput = {
      workspaces: [ws('w1', c1)],
      builders: [bld('b1')],
      sessions: [sess('a1', 'w1', 'b1', s1), { ...sess('t1', 'w1', null, s2), busy: true }, sess('t2', 'w1', null, null)],
    };
    const es = buildEntities(input);
    const shop = es.find((e) => e.id === 'struct:t1')!;
    expect([shop.kind, shop.texKey, shop.x, shop.y]).toEqual(['structure', 'runestone:lit', s2.x + 2, s2.y + 2]);
    expect(es.filter((e) => e.kind === 'wall')).toHaveLength(enclosure(c1, [s1, s2], 1, seedOf('w1')).walls.length - 1);
    expect(es.some((e) => e.id === 'status:t1')).toBe(false); // no status bar over a terminal
    // dark while the shell waits at its prompt
    expect(buildEntities({ ...input, sessions: [sess('t1', 'w1', null, s2)] }).find((e) => e.id === 'struct:t1')?.texKey).toBe('runestone:dark');
    const ended = buildEntities({ ...input, sessions: [{ ...sess('t1', 'w1', null, s2, { kind: 'ended', exitCode: 0 }), busy: true }] });
    expect(ended.find((e) => e.id === 'struct:t1')?.texKey).toBe('runestone:dark');
  });

  it('ended terminals do not count; agents without a spot or compound are skipped', () => {
    const c1 = placeCompound([]);
    const es = buildEntities({
      workspaces: [ws('w1', c1), ws('w2', null)],
      builders: [bld('b1')],
      sessions: [
        sess('t1', 'w1', null, null, { kind: 'ended', exitCode: 0 }),
        sess('a1', 'w1', 'b1', null),
        sess('a2', 'w2', 'b1', { x: 0, y: 0 }),
      ],
    });
    expect(es.filter((e) => e.kind === 'structure')).toHaveLength(0);
    expect(es.filter((e) => e.kind === 'house')).toHaveLength(1);
  });

  it('depth_orders_front_items_later', () => {
    const c: Compound = { x0: 4, y0: 4, w: 10, h: 10, house: { x: 4, y: 4 } };
    const es = buildEntities({
      workspaces: [ws('w1', c)],
      builders: [bld('b1')],
      sessions: [sess('far', 'w1', 'b1', { x: 10, y: 10 }), sess('near', 'w1', 'b1', { x: 5, y: 5 })],
    });
    const far = es.findIndex((e) => e.id === 'struct:far');
    const near = es.findIndex((e) => e.id === 'struct:near');
    expect(far).toBeGreaterThan(near);
    expect(es[far].depth).toBeGreaterThan(es[near].depth);
    // the list is sorted by depth
    for (let i = 1; i < es.length; i++) expect(es[i].depth).toBeGreaterThanOrEqual(es[i - 1].depth);
  });
});

describe('collectors', () => {
  const now = 1_000_000;
  const q = (agent: AgentQuota['agent'], leftPct: number, resetsAt: number | null = null): AgentQuota =>
    ({ agent, windows: [{ id: 'five_hour', label: '5-hour limit', group: null, leftPct, resetsAt, windowMins: 300 }], updatedAt: 0, source: 't' });
  const base: VillageInput = { workspaces: [], sessions: [], builders: [], now };

  it('one_collector_per_rationed_agent_with_a_reading_or_installed', () => {
    const es = buildEntities({ ...base, quotas: { codex: q('codex', 62) }, installed: ['claude', 'opencode'] });
    const cols = es.filter((e) => e.kind === 'collector');
    expect(cols.map((e) => [e.id, e.texKey])).toEqual(expect.arrayContaining([
      ['collector:codex', 'collector:codex:6'],
      ['collector:claude', 'collector:claude:none'],
    ]));
    expect(cols).toHaveLength(2); // OpenCode reports no limits
    const label = es.find((e) => e.id === 'status:collector:codex')!;
    expect(label.texKey).toBe('status:resource-codex:Codex 62% · 5h');
    expect(es.find((e) => e.id === 'status:collector:claude')?.texKey).toBe('status:stuck:Claude · no reading');
    const c = cols.find((e) => e.id === 'collector:codex')!;
    expect([c.x, c.y]).toEqual([COLLECTOR_SLOT.codex.x + 2, COLLECTOR_SLOT.codex.y + 2]);
  });

  it('a_dragged_collector_stands_where_it_was_dropped', () => {
    const es = buildEntities({ ...base, installed: ['claude', 'codex'], collectorSpots: { codex: { x: -6, y: -6 } } });
    const at = (id: string) => { const e = es.find((x) => x.id === id)!; return [e.x, e.y]; };
    expect(at('collector:codex')).toEqual([-4, -4]);
    expect(at('status:collector:codex')).toEqual([-5, -5]);
    expect(at('collector:claude')).toEqual([COLLECTOR_SLOT.claude.x + 2, COLLECTOR_SLOT.claude.y + 2]);
  });

  it('collector_slots_stay_clear_of_the_hall_and_any_compound', () => {
    const hall = { x0: -2, y0: -2, w: 5, h: 5 };
    const slots = Object.values(COLLECTOR_SLOT).map((t) => ({ x0: t.x, y0: t.y, w: 2, h: 2 }));
    let others: Compound[] = [];
    for (let i = 0; i < 8; i++) others = [...others, placeCompound(others)];
    for (const r of slots) {
      expect(gapBetween(r, hall)).toBeGreaterThanOrEqual(1);
      for (const c of others) expect(gapBetween(r, wallRect(c))).toBeGreaterThanOrEqual(1);
      for (const o of slots) if (o !== r) expect(gapBetween(r, o)).toBeGreaterThanOrEqual(0);
    }
  });

  it('an_emptied_tank_refills_at_its_reset', () => {
    const quotas = { claude: q('claude', 0, now + 90 * 60_000) };
    const before = buildEntities({ ...base, quotas });
    expect(before.find((e) => e.id === 'collector:claude')?.texKey).toBe('collector:claude:0');
    expect(before.find((e) => e.id === 'status:collector:claude')?.texKey).toBe('status:needs:Claude Empty · 1h 30m');
    const after = buildEntities({ ...base, quotas, now: now + 90 * 60_000 });
    expect(after.find((e) => e.id === 'collector:claude')?.texKey).toBe('collector:claude:10');
  });
});

describe('structureLook', () => {
  it('structure_stage_from_state', () => {
    const s = (state: SessionState, steps = 0, reached = false) => sess('a', 'w', 'b', { x: 0, y: 0 }, state, steps, reached);
    expect(structureLook(s({ kind: 'starting' })).stage).toBe('foundation');
    for (const st of [{ kind: 'working' }, { kind: 'needsYou', reason: 'x' }, { kind: 'stuck', reason: 'x' }] as SessionState[]) {
      const l = structureLook(s(st, 12));
      expect(l.stage).toBe('scaffold');
      expect(l.height).toBeCloseTo(scaffoldHeight(12), 1);
    }
    expect(structureLook(s({ kind: 'finished' })).stage).toBe('complete');
    expect(structureLook(s({ kind: 'ended', exitCode: 0 }, 5, true)).stage).toBe('complete');
    const ended = structureLook(s({ kind: 'ended', exitCode: 1 }, 5, false));
    expect(ended.stage).toBe('scaffold');
    expect(ended.height).toBeCloseTo(scaffoldHeight(5), 1);
  });
});

describe('needsRefit', () => {
  it('refits_only_when_bounds_change', () => {
    const r = { x0: -2, y0: -2, w: 20, h: 20 };
    expect(needsRefit(null, r)).toBe(true);
    expect(needsRefit(r, { ...r })).toBe(false); // a house move changes tiles, not the fitted bounds
    expect(needsRefit(r, { ...r, w: 23 })).toBe(true);
  });
});

describe('rendererOptions', () => {
  it('renderer_has_no_msaa', () => {
    // 4x MSAA at 2x density multiplies the canvas' colour and depth/stencil buffers by 4: ~120 MB
    // of graphics memory on a release build (docs/verification/plan-2-village.md). Baked art needs none.
    const o = rendererOptions(2);
    expect(o.antialias).toBe(false);
    expect(o.resolution).toBe(2);
    expect(o.preference).toBe('webgl');
  });
});

describe('hopOf', () => {
  it('a_cheering_builder_hops_and_lands_with_a_squash', () => {
    const lifts = Array.from({ length: 60 }, (_, i) => hopOf(i / 100, 0));
    expect(Math.max(...lifts.map((h) => h.lift))).toBeGreaterThan(8); // up about 9 px
    expect(lifts.some((h) => h.lift === 0 && h.squash < 1)).toBe(true); // squashed on the ground
    expect(lifts.every((h) => h.lift >= 0 && h.squash <= 1 && h.squash > 0.85)).toBe(true);
    expect(hopOf(0.3, 0)).not.toEqual(hopOf(0.3, 0.5)); // builders hop out of step
  });
});

describe('siteDepth', () => {
  it('a_builder_at_work_draws_over_its_own_and_its_neighbours_structures', () => {
    const c = { x0: 0, y0: 0, w: 9, h: 9, house: { x: 1, y: 1 } };
    const own = { x: 5, y: 1 }, neighbour = { x: 5, y: 4 };
    const z = siteDepth(c, [own, neighbour]);
    // the sprites sort by their entity depth: the front corner plus the kind's rank
    const depth = (id: string) => buildEntities({ ...input, now: 0 }).find((e) => e.id === id)!.depth;
    const input: VillageInput = {
      workspaces: [{ id: 'w', name: 'w', path: '/w', level: 1, compound: c } as VillageInput['workspaces'][number]],
      sessions: [own, neighbour].map((spot, i) => ({
        id: `s${i}`, workspaceId: 'w', kind: { kind: 'agent', builderId: `b${i}` }, task: null, state: { kind: 'working' }, steps: 0,
        startedAt: 0, lastOutputAt: 0, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot,
      })),
      builders: [],
    };
    expect(z).toBeGreaterThan(depth('struct:s0'));
    expect(z).toBeGreaterThan(depth('struct:s1'));
    expect(z).toBeGreaterThan(depth('house:w'));
  });
});



describe('gateAwareDepth', () => {
  // a north gate (wall along x) at tile (4, 0), its sprite at depth 6.002; a west one at (0, 4)
  const north = { x: 4, y: 0, alongX: true, depth: 6.002 };
  const west = { x: 0, y: 4, alongX: false, depth: 6.002 };
  it('a builder passing through is behind the gate until he crosses its wall line, then in front', () => {
    for (const g of [north, west]) {
      const at = (along: number, across: number) => (g.alongX ? [g.x + along, g.y + 0.5 + across] : [g.x + 0.5 + across, g.y + along]);
      const d = (along: number, across: number) => { const [x, y] = at(along, across); return gateAwareDepth(x, y, x + y, [g]); };
      expect(d(0.5, -0.9)).toBeLessThan(g.depth); // outside, about to go in
      expect(d(0.5, -0.05)).toBeLessThan(g.depth); // under the lintel, not past it yet
      expect(d(0.5, 0.05)).toBeGreaterThan(g.depth); // just past the posts: over the gate
      expect(d(0.5, 0.9)).toBeGreaterThan(g.depth); // inside
    }
  });
  it('leaves builders away from every gate alone', () => {
    expect(gateAwareDepth(10, 10, 20.006, [north, west])).toBe(20.006);
    expect(gateAwareDepth(4.5, 2, 6.5, [north])).toBe(6.5); // two tiles in: plain depth again
  });
});

describe('footprintAwareDepth', () => {
  // a tent at (10,10)-(12,12), sorting by its front corner
  const tent: FootDepth = { x0: 10, y0: 10, x1: 12, y1: 12, depth: 24.005 };
  const d = (x: number, y: number) => footprintAwareDepth(x, y, x + y + 0.006, [tent]);

  it('draws a builder walking along its east or south side over it', () => {
    expect(d(12.5, 10.5)).toBeGreaterThan(tent.depth); // east side, x + y = 23
    expect(d(10.5, 12.5)).toBeGreaterThan(tent.depth); // south side
    expect(d(12.5, 9.5)).toBe(12.5 + 9.5 + 0.006); // off its corner: no overlap to settle
  });

  it('draws a builder behind its north or west side under it', () => {
    expect(d(11, 9.5)).toBeLessThan(tent.depth);
    expect(d(9.5, 11)).toBeLessThan(tent.depth);
  });

  it('leaves a builder far from it alone', () => {
    expect(d(16, 10.5)).toBe(16 + 10.5 + 0.006);
  });

  it('between a building it is in front of and one it is behind, it is drawn between them', () => {
    const house: FootDepth = { x0: 13, y0: 10, x1: 16, y1: 13, depth: 29.004 }; // just east of the tent
    const z = footprintAwareDepth(12.5, 11, 23.506, [tent, house]); // in the lane between them
    expect(z).toBeGreaterThan(tent.depth);
    expect(z).toBeLessThan(house.depth);
  });
});

describe('walkerDepth', () => {
  it('passing a gate, the gate decides', () => {
    const g = { x: 10, y: 13, alongX: true, depth: 24.002 };
    const tent: FootDepth = { x0: 10, y0: 10, x1: 12, y1: 12, depth: 24.005 };
    expect(walkerDepth(10.5, 13.2, [g], [tent])).toBeLessThan(g.depth); // still behind the wall line
  });
});
