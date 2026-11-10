import { ipc } from '../api/ipc';
import type { HapticKind } from '../api/types';
import { currentSettings } from './settings';

/** The haptics on offer, lightest first, with what each feels like. */
export const HAPTICS: Array<{ kind: HapticKind; label: string; hint: string }> = [
  { kind: 'off', label: 'Off', hint: 'Nothing' },
  { kind: 'alignment', label: 'Tick', hint: 'The lightest: one faint tick, as when something snaps to a guide' },
  { kind: 'double', label: 'Double tick', hint: 'Two light ticks in quick succession' },
  { kind: 'generic', label: 'Tap', hint: 'A soft tap' },
  { kind: 'levelChange', label: 'Click', hint: 'The firmest: a click, as a slider stepping through its detents' },
];

/** Gap between the two ticks of a double, ms. */
export const DOUBLE_GAP_MS = 70;

/** Plays a haptic on the trackpad (nothing with a mouse, or for `off`); never throws. */
export function playHaptic(kind: HapticKind): void {
  const once = (k: Exclude<HapticKind, 'off' | 'double'>) => { try { ipc.haptic(k).catch(() => {}); } catch { /* no backend */ } };
  if (kind === 'off') return;
  if (kind === 'double') {
    once('alignment');
    setTimeout(() => once('alignment'), DOUBLE_GAP_MS);
    return;
  }
  once(kind);
}

/** The haptic the owner chose for this moment. */
export const hapticFor = (moment: 'hover' | 'drop'): HapticKind =>
  (moment === 'hover' ? currentSettings().hapticHover : currentSettings().hapticDrop) ?? (moment === 'hover' ? 'alignment' : 'levelChange');
