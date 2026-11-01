import { describe, expect, it } from 'vitest';
import type { AgentQuota, QuotaWindow } from '../api/types';
import { collectorLook, leftNow, primaryWindow, quotaTone, tankTenths, untilText, windowShort } from './quota';

const win = (id: string, leftPct: number, windowMins: number | null, resetsAt: number | null = null): QuotaWindow =>
  ({ id, label: id, group: null, leftPct, resetsAt, windowMins });
const quota = (...windows: QuotaWindow[]): AgentQuota => ({ agent: 'antigravity', windows, updatedAt: 0, source: 't' });

describe('quota', () => {
  it('a window refills once its reset time passes', () => {
    expect(leftNow(win('a', 20, 300, 1000), 999)).toBe(20);
    expect(leftNow(win('a', 20, 300, 1000), 1000)).toBe(100);
    expect(leftNow(win('a', 20, 300, null), 1e12)).toBe(20);
  });

  it('the tank follows the shortest window, the emptiest among equals', () => {
    const q = quota(win('week', 5, 10_080), win('gemini-5h', 80, 300), win('claude-5h', 30, 300), win('argon', 1, null));
    expect(primaryWindow(q, 0)?.id).toBe('claude-5h');
    // once claude-5h has reset it is full, so the other 5-hour window leads
    const q2 = quota(win('gemini-5h', 80, 300), win('claude-5h', 30, 300, 10));
    expect(primaryWindow(q2, 20)?.id).toBe('gemini-5h');
    expect(primaryWindow(quota(), 0)).toBeNull();
  });

  it('tenths are 0 only when empty and 10 only when full', () => {
    expect([0, 0.4, 4, 55, 99.6, 100].map(tankTenths)).toEqual([0, 1, 1, 6, 9, 10]);
  });

  it('labels: percent and window while some is left, a countdown when empty', () => {
    const now = 1_000_000;
    expect(collectorLook(quota(win('5h', 62.4, 300, now + 3_600_000)), now)).toEqual({ tenths: 6, tone: 'elixir', label: '62% · 5h' });
    expect(collectorLook(quota(win('5h', 0, 300, now + (2 * 60 + 10) * 60_000)), now)).toEqual({ tenths: 0, tone: 'needs', label: 'Empty · 2h 10m' });
    expect(collectorLook(quota(win('5h', 0, 300, now - 1)), now)?.label).toBe('100% · 5h');
    expect(collectorLook(undefined, now)).toBeNull();
  });

  it('tones, durations and window names', () => {
    expect([80, 25, 11, 10, 0].map(quotaTone)).toEqual(['elixir', 'working', 'working', 'needs', 'needs']);
    expect([30_000, 12 * 60_000, 120 * 60_000, (3 * 1440 + 4 * 60) * 60_000].map(untilText)).toEqual(['<1m', '12m', '2h', '3d 4h']);
    expect([300, 10_080, 43_200, 1440, null].map(windowShort)).toEqual(['5h', 'week', 'month', '1d', '']);
  });
});
