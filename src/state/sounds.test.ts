import type { SessionInfo, SessionState, SoundMoment } from '../api/types';
import { closeSound, soundsFor, watchSounds, REPEAT_MS, XP_DELAY_MS } from './sounds';
import { ORB_SECONDS } from '../village/effects';
import { useApp } from './store';

const now = 1_800_000_000_000;
const s = (state: SessionState, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's1', workspaceId: 'w1', kind: { kind: 'agent', builderId: 'b1' }, task: null, state, steps: 0, startedAt: now - 1000, lastOutputAt: 0,
  reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot: null, ...extra,
});
const working = s({ kind: 'working' });
const decide = s({ kind: 'needsYou', reason: 'Bash' }, { awaitingDecision: true });
const ask = s({ kind: 'needsYou', reason: 'which db?' });
const done = s({ kind: 'finished' });

test('a session just started plays its start; one restored from before does not', () => {
  expect(soundsFor(undefined, s({ kind: 'starting' }), now)).toEqual(['start']);
  expect(soundsFor(undefined, s({ kind: 'working' }, { startedAt: now - 3_600_000 }), now)).toEqual([]);
  expect(soundsFor(undefined, s({ kind: 'ended', exitCode: null }, { paused: true }), now)).toEqual([]);
  expect(soundsFor(undefined, { ...s({ kind: 'starting' }), kind: { kind: 'terminal' } }, now)).toEqual([]);
});

test('entering a wait plays its moment once; a disarmed decision and an Allow stay quiet', () => {
  expect(soundsFor(working, decide, now)).toEqual(['decide']);
  expect(soundsFor(working, ask, now)).toEqual(['answer']);
  expect(soundsFor(working, done, now)).toEqual(['finished']);
  expect(soundsFor(working, s({ kind: 'stuck', reason: 'x' }), now)).toEqual(['stuck']);
  expect(soundsFor(done, { ...done, rev: 2 }, now)).toEqual([]); // the same wait again
  expect(soundsFor(ask, decide, now)).toEqual(['decide']); // the permission prompt showed after the question
  expect(soundsFor(decide, ask, now)).toEqual([]); // the owner typed: disarmed
  expect(soundsFor(decide, working, now)).toEqual([]); // allowed
  expect(soundsFor(done, working, now)).toEqual(['working']);
  expect(soundsFor(ask, working, now)).toEqual(['working']);
});

test('a new subagent plays the minion', () => {
  const one = { ...working, subagents: [{ id: 'a', agentType: null }] } as SessionInfo;
  const two = { ...working, subagents: [{ id: 'a', agentType: null }, { id: 'b', agentType: null }] } as SessionInfo;
  expect(soundsFor(working, one, now)).toEqual(['minion']);
  expect(soundsFor(one, one, now)).toEqual([]);
  expect(soundsFor(one, two, now)).toEqual(['minion']);
  expect(soundsFor(two, one, now)).toEqual([]);
});

test('the watcher plays nothing for the first state, and one sound for builders finishing together', () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const played: SoundMoment[] = [];
  useApp.setState({ loaded: false, sessions: {} });
  const stop = watchSounds((m) => played.push(m));
  useApp.setState({ loaded: true, sessions: { s1: working, s2: { ...working, id: 's2' } } }); // the first state
  expect(played).toEqual([]);
  useApp.setState({ sessions: { s1: done, s2: { ...done, id: 's2' } } });
  expect(played).toEqual(['finished']);
  useApp.setState({ sessions: { s1: working, s2: { ...working, id: 's2' } } });
  vi.setSystemTime(now + 100);
  useApp.setState({ sessions: { s1: done, s2: { ...working, id: 's2' } } });
  expect(played).toEqual(['finished', 'working']); // the second finish came too soon
  vi.setSystemTime(now + REPEAT_MS + 200);
  useApp.setState({ sessions: { s1: done, s2: { ...done, id: 's2' } } });
  expect(played).toEqual(['finished', 'working', 'finished']);
  stop();
  vi.useRealTimers();
});

test('accepted work plays XP as the orbs land, or a level up instead', () => {
  vi.useFakeTimers();
  try {
    const played: string[] = [];
    const stop = watchSounds((m) => played.push(m));
    const o = { earnedXp: true, xpGained: 100, levelBefore: 1, levelAfter: 1, workspaceId: 'w1', unfinished: false, stuck: false, discarded: false };
    useApp.getState().onClosed(o, 'a');
    expect(played).toEqual([]);
    vi.advanceTimersByTime(XP_DELAY_MS);
    expect(played).toEqual(['xp']);
    useApp.getState().onClosed({ ...o, levelAfter: 2 }, 'b');
    vi.advanceTimersByTime(XP_DELAY_MS);
    expect(played).toEqual(['xp', 'levelUp']);
    useApp.getState().onClosed({ ...o, earnedXp: false, discarded: true }, 'c');
    vi.advanceTimersByTime(XP_DELAY_MS);
    expect(played).toEqual(['xp', 'levelUp']);
    stop();
  } finally {
    vi.useRealTimers();
  }
});

test('the XP sound waits as long as the orbs fly', () => {
  expect(XP_DELAY_MS).toBe((ORB_SECONDS + 0.2) * 1000);
  expect(closeSound({ earnedXp: false, xpGained: 0, levelBefore: 1, levelAfter: 1, workspaceId: 'w', unfinished: true, stuck: false, discarded: false })).toBeNull();
});
