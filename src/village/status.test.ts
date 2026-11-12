import { describe, expect, it } from 'vitest';
import type { SessionInfo, SessionState } from '../api/types';
import { elapsedLabel, statusKey, statusLabel, statusSignature, statusesDue } from './status';
import { buildEntities } from './scene';
import { placeCompound, findSpot } from './layout';

const MIN = 60_000;
const sess = (state: SessionState, steps = 0, startedAt = 0, terminal = false): SessionInfo => ({
  id: 's', workspaceId: 'w', kind: terminal ? { kind: 'terminal' } : { kind: 'agent', builderId: 'b' }, task: null, state, steps,
  startedAt, lastOutputAt: 0, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot: { x: 0, y: 0 },
});

describe('statusLabel', () => {
  it('working shows real elapsed minutes and steps', () => {
    expect(statusLabel(sess({ kind: 'working' }, 34, 1000), 1000 + 12 * MIN + 59_000)).toBe('12m · 34 steps');
    expect(statusLabel(sess({ kind: 'working' }, 1), 30_000)).toBe('0m · 1 step');
    expect(statusLabel(sess({ kind: 'starting' }), 0)).toBe('0m · 0 steps');
    expect(statusLabel(sess({ kind: 'working' }, 3), 125 * MIN)).toBe('2h 5m · 3 steps');
  });

  it('needs-you and stuck variants', () => {
    expect(statusLabel(sess({ kind: 'needsYou', reason: 'x' } as SessionState, 9), 30_000)).toBe('Waiting for you');
    expect(statusLabel(sess({ kind: 'stuck', reason: 'quiet' }, 9), 30_000)).toBe('Stuck');
  });

  it('a builder waiting on you shows for how long, from its last state change', () => {
    const needs = { ...sess({ kind: 'needsYou', reason: 'x' } as SessionState, 9), stateSince: 10 * MIN };
    expect(statusLabel(needs, 10 * MIN + 59_000)).toBe('Waiting for you');
    expect(statusLabel(needs, 17 * MIN)).toBe('Waiting for you · 7m');
    expect(statusLabel(needs, 10 * MIN + 75 * MIN)).toBe('Waiting for you · 1h 15m');
    const stuck = { ...sess({ kind: 'stuck', reason: 'quiet' }, 9), stateSince: MIN };
    expect(statusLabel(stuck, 13 * MIN)).toBe('Stuck · 12m');
    // saves from before stateSince was kept: from its start
    expect(statusLabel(sess({ kind: 'needsYou', reason: 'x' } as SessionState, 0, 2 * MIN), 5 * MIN)).toBe('Waiting for you · 3m');
  });

  it('hidden when finished or ended, and for terminals', () => {
    expect(statusLabel(sess({ kind: 'finished' }, 9), 5 * MIN)).toBeNull();
    expect(statusLabel(sess({ kind: 'ended' } as SessionState, 9), 5 * MIN)).toBeNull();
    expect(statusLabel(sess({ kind: 'working' }, 9, 0, true), 5 * MIN)).toBeNull();
  });

  it('key changes at most once a minute, and with steps or state', () => {
    const s = sess({ kind: 'working' }, 4);
    const keys = new Set<string | null>();
    for (let t = 3 * MIN; t < 4 * MIN; t += 1000) keys.add(statusKey(s, t));
    expect(keys.size).toBe(1);
    expect(statusKey(s, 4 * MIN)).not.toBe(statusKey(s, 4 * MIN - 1));
    expect(statusKey({ ...s, steps: 5 }, 3 * MIN)).not.toBe(statusKey(s, 3 * MIN));
    expect(statusKey(sess({ kind: 'stuck', reason: 'quiet' }), 3 * MIN)).toBe('status:stuck:Stuck · 3m');
  });

  it('elapsed never goes negative', () => {
    expect(elapsedLabel(-5000)).toBe('0m');
  });
});

describe('status refresh', () => {
  it('a re-sync is due only when a minute ticks over (or steps/state change)', () => {
    const c = placeCompound([]);
    const s = { ...sess({ kind: 'working' }, 3), spot: findSpot(c, [])! };
    const input = {
      workspaces: [{ id: 'w', name: 'w', path: '/w', createdAt: 0, missing: false, level: 1, xp: 0, compound: c }],
      builders: [{ id: 'b', name: 'b', agent: 'claude' as const, model: null, effort: null, customCommand: null }],
      sessions: [s],
    };
    const es = buildEntities({ ...input, now: 5 * MIN });
    const sig = statusSignature(es);
    expect(sig).toContain('5m · 3 steps');
    expect(statusesDue(es, [s], 5 * MIN + 59_000)).toBe(sig);
    expect(statusesDue(es, [s], 6 * MIN)).not.toBe(sig);
    expect(statusesDue(es, [{ ...s, steps: 4 }], 5 * MIN)).not.toBe(sig);
  });
});
