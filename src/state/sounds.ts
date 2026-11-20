import { ipc } from '../api/ipc';
import type { CloseOutcome, SessionInfo, SoundMoment } from '../api/types';
import { DEFAULT_SOUNDS } from './soundDefaults';
import { currentSettings } from './settings';
import { useApp } from './store';

export { DEFAULT_SOUNDS };

/** The moments that play a sound, in the order Settings lists them. */
export const SOUND_MOMENTS: Array<{ moment: SoundMoment; label: string; hint: string }> = [
  { moment: 'decide', label: 'Wants a decision', hint: 'A permission to Allow or Deny' },
  { moment: 'answer', label: 'Asking you', hint: 'A question, or waiting in the terminal' },
  { moment: 'finished', label: 'Finished', hint: 'A builder is done and waits for review' },
  { moment: 'stuck', label: 'Stuck', hint: 'Failed, or silent for too long' },
  { moment: 'start', label: 'Session starts', hint: 'A builder starts on a task' },
  { moment: 'minion', label: 'A minion joins', hint: 'An agent sends out a subagent' },
  { moment: 'working', label: 'Back to work', hint: 'You answered, and the builder picks up again' },
  { moment: 'xp', label: 'Work shipped', hint: 'You accepted finished work' },
];

/** The shipped sound waits for the orbs to reach the house and its "+1 shipped" to rise (ORB_SECONDS + 0.2 in village/effects.ts). */
export const XP_DELAY_MS = 1400;

/** The sound a close outcome plays: work shipped (the `xp` moment); nothing when it didn't ship. */
export function closeSound(o: CloseOutcome): SoundMoment | null {
  return o.shipped ? 'xp' : null;
}

/** What a session waits on the owner for, as a sound moment; null while it does not. */
function attention(s: SessionInfo | undefined): SoundMoment | null {
  if (!s) return null;
  switch (s.state.kind) {
    case 'needsYou': return s.awaitingDecision ? 'decide' : 'answer';
    case 'finished': return 'finished';
    case 'stuck': return 'stuck';
    default: return null;
  }
}

/** A session counts as new (its start plays) only this soon after it started, so restored ones stay quiet. */
export const FRESH_MS = 30_000;

/**
 * The sounds one session update plays. Agent sessions only, never paused ones.
 * - a new session (just started): `start`
 * - entering a wait on the owner: `decide`, `answer`, `finished` or `stuck` (a decision the owner
 *   disarmed by typing, decide → answer, plays nothing)
 * - going back to work after a question, a finish or being stuck: `working` (not after an Allow)
 * - a new subagent: `minion`
 */
export function soundsFor(prev: SessionInfo | undefined, next: SessionInfo, now: number = Date.now()): SoundMoment[] {
  if (next.kind.kind !== 'agent' || next.paused) return [];
  const out: SoundMoment[] = [];
  if (!prev) {
    if ((next.state.kind === 'starting' || next.state.kind === 'working') && now - next.startedAt < FRESH_MS) out.push('start');
  } else {
    const before = attention(prev), after = attention(next);
    if (after && after !== before && !(before === 'decide' && after === 'answer')) out.push(after);
    if (next.state.kind === 'working' && before && before !== 'decide') out.push('working');
  }
  const had = new Set((prev?.subagents ?? []).map((a) => a.id));
  if ((next.subagents ?? []).some((a) => !had.has(a.id))) out.push('minion');
  return out;
}

/** The same moment plays at most once in this span (several builders finishing together play one sound). */
export const REPEAT_MS = 1200;

/** Plays a moment's chosen sound; never throws. */
export function playMoment(moment: SoundMoment): void {
  const s = currentSettings();
  if (s.soundsOn === false) return;
  const path = (s.sounds ?? DEFAULT_SOUNDS)[moment] ?? DEFAULT_SOUNDS[moment];
  if (!path) return;
  try { ipc.playSound(path).catch(() => {}); } catch { /* no backend */ }
}

/** Plays a file now at `volume`, sounds on or off (the owner trying one in Settings). */
export function previewSound(path: string, volume?: number): void {
  if (!path) return;
  try { ipc.playSound(path, volume ?? currentSettings().soundVolume ?? 70, true).catch(() => {}); } catch { /* no backend */ }
}

/**
 * Plays the village's sounds as sessions change, from the first state on (the sessions there at
 * launch are not news). Returns an unsubscribe.
 */
export function watchSounds(play: (m: SoundMoment) => void = playMoment): () => void {
  const last = new Map<SoundMoment, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const unsub = useApp.subscribe((st, prev) => {
    // work accepted: its sound as the orbs land
    if (st.lastClosed !== prev.lastClosed) {
      for (const [id, o] of Object.entries(st.lastClosed)) {
        const m = id in prev.lastClosed ? null : closeSound(o);
        if (!m) continue;
        const t = setTimeout(() => { timers.delete(t); play(m); }, XP_DELAY_MS);
        timers.add(t);
      }
    }
    if (st.sessions === prev.sessions || !prev.loaded) return;
    const now = Date.now();
    const moments = new Set<SoundMoment>();
    for (const s of Object.values(st.sessions)) for (const m of soundsFor(prev.sessions[s.id], s, now)) moments.add(m);
    for (const m of moments) {
      if (now - (last.get(m) ?? -Infinity) < REPEAT_MS) continue;
      last.set(m, now);
      play(m);
    }
  });
  return () => { unsub(); for (const t of timers) clearTimeout(t); timers.clear(); };
}
