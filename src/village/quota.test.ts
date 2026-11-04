import { describe, expect, it } from 'vitest';
import type { AgentQuota, Compound, QuotaWindow } from '../api/types';
import { gapBetween, wallRect } from './layout';
import {
  COLLECTOR_SLOT, collectorFits, collectorLook, collectorTiles, leftNow, primaryWindow, quotaTone, shownCollectors, tankTenths, untilText, windowShort,
} from './quota';

const win = (id: string, leftPct: number, windowMins: number | null, resetsAt: number | null = null): QuotaWindow =>
  ({ id, label: id, group: null, leftPct, resetsAt, windowMins });
const quota = (...windows: QuotaWindow[]): AgentQuota => ({ agent: 'antigravity', windows, updatedAt: 0, source: 't' });

describe('quota', () => {
  it('a window refills once its reset time passes', () => {
    expect(leftNow(win('a', 20, 300, 1000), 999)).toBe(20);
    expect(leftNow(win('a', 20, 300, 1000), 1000)).toBe(100);
    expect(leftNow(win('a', 20, 300, null), 1e12)).toBe(20);
  });

  it('every tank follows the weekly window, the emptiest among equals', () => {
    const q = quota(win('gemini-5h', 5, 300), win('gemini-week', 80, 10_080), win('claude-week', 30, 10_080), win('odd', 1, null));
    expect(primaryWindow(q, 0)?.id).toBe('claude-week');
    // once claude-week has reset it is full, so the other weekly window leads
    const q2 = quota(win('gemini-week', 80, 10_080), win('claude-week', 30, 10_080, 10));
    expect(primaryWindow(q2, 20)?.id).toBe('gemini-week');
    // no weekly window: the one closest to a week (Codex reports only a 30-day one on some plans)
    expect(primaryWindow(quota(win('5h', 50, 300), win('month', 90, 43_200)), 0)?.id).toBe('month');
    expect(primaryWindow(quota(win('5h', 50, 300), win('odd', 9, null)), 0)?.id).toBe('5h');
    expect(primaryWindow(quota(), 0)).toBeNull();
  });

  it('tenths are 0 only when empty and 10 only when full', () => {
    expect([0, 0.4, 4, 55, 99.6, 100].map(tankTenths)).toEqual([0, 1, 1, 6, 9, 10]);
  });

  it('labels: percent and window while some is left, a countdown when empty', () => {
    const now = 1_000_000;
    expect(collectorLook(quota(win('5h', 62.4, 300, now + 3_600_000)), now, 'antigravity')).toEqual({ tenths: 6, tone: 'resource-antigravity', label: '62% · 5h' });
    expect(collectorLook(quota(win('5h', 0, 300, now + (2 * 60 + 10) * 60_000)), now, 'antigravity')).toEqual({ tenths: 0, tone: 'needs', label: 'Empty · 2h 10m' });
    expect(collectorLook(quota(win('5h', 0, 300, now - 1)), now, 'antigravity')?.label).toBe('100% · 5h');
    expect(collectorLook(undefined, now, 'claude')).toBeNull();
  });

  it('tones, durations and window names', () => {
    expect([80, 25, 11, 10, 0].map((l) => quotaTone(l, 'codex'))).toEqual(['resource-codex', 'working', 'working', 'needs', 'needs']);
    expect(quotaTone(80, 'claude')).toBe('resource-claude');
    expect([30_000, 12 * 60_000, 120 * 60_000, (3 * 1440 + 4 * 60) * 60_000].map(untilText)).toEqual(['<1m', '12m', '2h', '3d 4h']);
    expect([300, 10_080, 43_200, 1440, null].map(windowShort)).toEqual(['5h', 'week', 'month', '1d', '']);
  });

  describe('collector placement', () => {
    const all = ['claude', 'codex', 'antigravity'] as const;
    const c: Compound = { x0: 8, y0: -4, w: 10, h: 10, house: { x: 8, y: -4 } };

    it('shows a collector per rationed agent with a reading or installed', () => {
      expect(shownCollectors({ codex: quota() }, ['claude', 'opencode'])).toEqual(['claude', 'codex']);
      expect(shownCollectors(undefined, undefined)).toEqual([]);
    });

    it('a collector fits clear of the hall, compound walls, roads and other collectors, near the village', () => {
      expect(collectorFits({ x: 4, y: 4 }, [], [])).toBe(true);
      expect(collectorFits({ x: 2, y: 2 }, [], [])).toBe(false); // on the hall
      expect(collectorFits({ x: 3, y: 0 }, [], [])).toBe(false); // touching the hall
      expect(collectorFits({ x: 5, y: 0 }, [c], [])).toBe(false); // touching the west wall (x 7)
      expect(collectorFits({ x: 4, y: -3 }, [c], [])).toBe(true);
      expect(collectorFits({ x: 4, y: 0 }, [c], [])).toBe(false); // on the road to the gate (row 0)
      expect(collectorFits({ x: 4, y: -1 }, [c], [])).toBe(false); // half on it
      expect(collectorFits({ x: 4, y: 1 }, [c], [])).toBe(true); // beside it
      expect(collectorFits({ x: 10, y: 0 }, [c], [])).toBe(false); // inside the compound
      expect(collectorFits({ x: 4, y: 4 }, [], [{ x: 5, y: 5 }])).toBe(false); // on another collector
      expect(collectorFits({ x: 4, y: 4 }, [], [{ x: 6, y: 4 }])).toBe(true); // side by side
      expect(collectorFits({ x: 9, y: 9 }, [], [])).toBe(true); // 8 tiles out from the hall (x 3)
      expect(collectorFits({ x: 10, y: 9 }, [], [])).toBe(false); // further out than COLLECTOR_REACH
    });

    it('dragged tiles win; the rest stand in their default slots', () => {
      expect(collectorTiles(all, {}, [])).toEqual(COLLECTOR_SLOT);
      expect(collectorTiles(all, { codex: { x: -6, y: -6 } }, [])).toEqual({ ...COLLECTOR_SLOT, codex: { x: -6, y: -6 } });
      expect(collectorTiles(['codex'], undefined, [])).toEqual({ codex: COLLECTOR_SLOT.codex });
    });

    it('a collector a compound has grown over goes back to its slot, never overlapping anything', () => {
      // Codex was dragged to (10, 0); a compound now stands there
      expect(collectorTiles(all, { codex: { x: 10, y: 0 } }, [c]).codex).toEqual(COLLECTOR_SLOT.codex);
      // Claude was dragged onto Codex's slot, so Codex moves to the nearest free tile instead
      const tiles = collectorTiles(all, { claude: COLLECTOR_SLOT.codex }, [c]);
      expect(tiles.claude).toEqual(COLLECTOR_SLOT.codex);
      const placed = Object.values(tiles).map((t) => ({ x0: t.x, y0: t.y, w: 2, h: 2 }));
      for (const r of placed) {
        expect(gapBetween(r, wallRect(c))).toBeGreaterThanOrEqual(1);
        for (const o of placed) if (o !== r) expect(gapBetween(r, o)).toBeGreaterThanOrEqual(0);
      }
      expect(collectorFits(tiles.codex!, [c], [tiles.claude!, tiles.antigravity!])).toBe(true);
    });
  });
});
