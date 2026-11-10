import { vi } from 'vitest';

const haptic = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../api/ipc', () => ({ ipc: { haptic } }));
import { DOUBLE_GAP_MS, HAPTICS, hapticFor, playHaptic } from './haptics';
import { useApp } from './store';

beforeEach(() => haptic.mockClear());

test('each haptic plays as AppKit has it; a double is two ticks; off is nothing', () => {
  vi.useFakeTimers();
  try {
    playHaptic('off');
    expect(haptic).not.toHaveBeenCalled();
    for (const k of ['alignment', 'generic', 'levelChange'] as const) { playHaptic(k); expect(haptic).toHaveBeenLastCalledWith(k); }
    haptic.mockClear();
    playHaptic('double');
    expect(haptic).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DOUBLE_GAP_MS);
    expect(haptic.mock.calls).toEqual([['alignment'], ['alignment']]);
  } finally {
    vi.useRealTimers();
  }
});

test('the owner picks one per moment: a light tick on hover and a click on drop by default', () => {
  useApp.setState({ settings: null });
  expect([hapticFor('hover'), hapticFor('drop')]).toEqual(['alignment', 'levelChange']);
  useApp.setState({ settings: { updatesEnabled: true, notifyNeedsYou: true, notifyFinished: true, dockBadge: true, hapticHover: 'off', hapticDrop: 'double' } });
  expect([hapticFor('hover'), hapticFor('drop')]).toEqual(['off', 'double']);
  expect(HAPTICS.map((h) => h.kind)).toEqual(['off', 'alignment', 'double', 'generic', 'levelChange']);
  useApp.setState({ settings: null });
});
