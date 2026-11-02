import { describe, expect, it } from 'vitest';
import type { AgentQuota, Builder, Compound, SessionInfo, SessionState, Tile, Workspace } from '../api/types';
import { findSpot, gapBetween, placeCompound, wallRect } from './layout';
import { COLLECTOR_SLOT } from './quota';
import { enclosure, seedOf } from './enclosure';
import { scaffoldHeight } from './look';
import { buildEntities, needsRefit, rendererOptions, structureLook, type VillageInput } from './scene';

const ws = (id: string, compound: Compound | null, level = 1): Workspace => ({
  id, name: id, path: `/p/${id}`, createdAt: 0, missing: false, level, xp: 0, compound,
});
const sess = (
  id: string, wsId: string, builderId: string | null, spot: Tile | null,
  state: SessionState = { kind: 'working' }, steps = 0, reachedFinished = false,
): SessionInfo => ({
  id, workspaceId: wsId, kind: builderId ? { kind: 'agent', builderId } : { kind: 'terminal' },
  task: null, state, steps, startedAt: 0, lastOutputAt: 0, reachedFinished, worktree: null,
  commandPreview: '', awaitingDecision: false, rev: 1, spot,
});
const bld = (id: string, agent: Builder['agent'] = 'claude'): Builder =>
  ({ id, name: id, agent, model: null, effort: null, customCommand: null });

describe('buildEntities', () => {
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
    expect(buildEntities(input).some((e) => e.kind === 'status')).toBe(false); // no clock, no bars
    const bars = buildEntities({ ...input, now: 1000 + 12 * 60_000 }).filter((e) => e.kind === 'status');
    expect(Object.fromEntries(bars.map((e) => [e.id, e.texKey]))).toEqual({
      'status:a1': 'status:working:12m · 34 steps',
      'status:a2': 'status:needs:Waiting for you',
      'status:a3': 'status:stuck:Stuck',
    });
    const bar = bars.find((e) => e.id === 'status:a1')!;
    expect([bar.x, bar.y]).toEqual([spots[0].x + 1, spots[0].y + 1]); // over the structure's centre
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

  it('app_boards_show_their_preview_through_a_cut_out_and_count_for_the_walls', () => {
    const c1 = placeCompound([]);
    const s1 = findSpot(c1, [])!;
    const s2 = findSpot(c1, [s1])!;
    const board = (key: string, spot: Tile, frameable: boolean) =>
      ({ key, workspaceId: 'w1', url: 'http://localhost:3000/', label: 'Shop: admin', port: 3000, frameable, spot });
    const input: VillageInput = { workspaces: [ws('w1', c1)], builders: [], sessions: [], boards: [board('w1:3000', s1, true), board('w1:4000', s2, false)] };
    const es = buildEntities(input);
    const live = es.find((e) => e.id === 'board:w1:3000')!;
    expect([live.kind, live.x, live.y, live.texKey]).toEqual(['board', s1.x + 2, s1.y + 2, `board:live:${encodeURIComponent('Shop: admin')}`]);
    const hole = es.find((e) => e.id === 'hole:w1:3000')!;
    // the cut-out is drawn right after its board, so whatever stands in front still covers the preview
    expect(es.indexOf(hole)).toBe(es.indexOf(live) + 1);
    expect(es.find((e) => e.id === 'board:w1:4000')?.texKey).toMatch(/^board:card:/);
    expect(es.some((e) => e.id === 'hole:w1:4000')).toBe(false); // a page that refuses framing gets a card
    expect(es.find((e) => e.id === 'status:board:w1:3000')?.texKey).toBe('status:app:Shop  admin \u00b7 3000');
    expect(es.filter((e) => e.kind === 'wall')).toHaveLength(enclosure(c1, [s1, s2], 1, seedOf('w1')).walls.length - 1);
    // no compound, no board
    expect(buildEntities({ ...input, workspaces: [ws('w1', null)] }).some((e) => e.kind === 'board')).toBe(false);
  });

  it('terminals_stand_as_rune_stones_that_count_for_the_walls', () => {
    const c1 = placeCompound([]);
    const s1 = findSpot(c1, [])!;
    const s2 = findSpot(c1, [s1])!;
    const input: VillageInput = {
      workspaces: [ws('w1', c1)],
      builders: [bld('b1')],
      sessions: [sess('a1', 'w1', 'b1', s1), sess('t1', 'w1', null, s2), sess('t2', 'w1', null, null)],
    };
    const es = buildEntities(input);
    const shop = es.find((e) => e.id === 'struct:t1')!;
    expect([shop.kind, shop.texKey, shop.x, shop.y]).toEqual(['structure', 'runestone:lit', s2.x + 2, s2.y + 2]);
    expect(es.filter((e) => e.kind === 'wall')).toHaveLength(enclosure(c1, [s1, s2], 1, seedOf('w1')).walls.length - 1);
    expect(es.some((e) => e.id === 'status:t1')).toBe(false); // no status bar over a terminal
    const ended = buildEntities({ ...input, sessions: [sess('t1', 'w1', null, s2, { kind: 'ended', exitCode: 0 })] });
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
    expect(label.texKey).toBe('status:elixir-codex:Codex 62% · 5h');
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
