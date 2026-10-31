import { describe, expect, it } from 'vitest';
import type { Builder, Compound, SessionInfo, SessionState, Tile, Workspace } from '../api/types';
import { findSpot, placeCompound, wallRect } from './layout';
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
    const badges = es.filter((e) => e.kind === 'badge');
    expect(badges).toHaveLength(1);
    expect(badges[0].id).toBe('badge:w1');
    expect(badges[0].texKey).toBe('badge:1');
    // the terminal session adds no structure
    expect(es.some((e) => e.id === 'struct:t1')).toBe(false);
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
    expect(es.filter((e) => e.kind === 'badge')).toHaveLength(0);
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
