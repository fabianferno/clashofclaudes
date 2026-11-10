import type { Builder, SessionInfo, SessionState, Todo } from '../api/types';
import { autoStartable, nextInQueue, ownerQueue, queueReason, roomToStart, runningAgents, waitedLabel } from './queue';

const sess = (id: string, state: SessionState, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, workspaceId: 'w1', kind: { kind: 'agent', builderId: `b-${id}` }, task: null, state, steps: 0, startedAt: 0, lastOutputAt: 0,
  reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false, busy: false, rev: 1, spot: null, ...extra,
});
const ws = [{ id: 'w1', missing: false }];
const byId = (...s: SessionInfo[]) => Object.fromEntries(s.map((x) => [x.id, x]));

test('the queue: decisions, then questions, then stuck, then reviews; oldest wait first in each', () => {
  const sessions = byId(
    sess('review-old', { kind: 'finished' }, { stateSince: 10 }),
    sess('review-new', { kind: 'finished' }, { stateSince: 50 }),
    sess('stuck', { kind: 'stuck', reason: 'no output' }, { stateSince: 5 }),
    sess('ask', { kind: 'needsYou', reason: 'which db?' }, { stateSince: 40 }),
    sess('decide-new', { kind: 'needsYou', reason: 'Bash' }, { awaitingDecision: true, stateSince: 30 }),
    sess('decide-old', { kind: 'needsYou', reason: 'Bash' }, { awaitingDecision: true, stateSince: 20 }),
    sess('working', { kind: 'working' }),
  );
  expect(ownerQueue({ sessions, workspaces: ws }).map((q) => [q.session.id, q.reason])).toEqual([
    ['decide-old', 'decide'], ['decide-new', 'decide'], ['ask', 'answer'], ['stuck', 'stuck'], ['review-old', 'review'], ['review-new', 'review'],
  ]);
});

test('parked, paused, terminal and orphaned sessions stay out of the queue', () => {
  const sessions = byId(
    sess('parked', { kind: 'finished' }, { parked: '' }),
    sess('paused', { kind: 'ended', exitCode: null }, { paused: true }),
    { ...sess('term', { kind: 'finished' }), kind: { kind: 'terminal' } },
    sess('elsewhere', { kind: 'finished' }, { workspaceId: 'gone' }),
    sess('in', { kind: 'finished' }),
  );
  expect(ownerQueue({ sessions, workspaces: ws }).map((q) => q.session.id)).toEqual(['in']);
  expect(queueReason(sessions.parked)).toBeNull();
  expect(queueReason({ ...sessions.parked, parked: null })).toBe('review');
});

test('the next item skips the one open now, and is null when nothing else waits', () => {
  const q = ownerQueue({ sessions: byId(sess('a', { kind: 'finished' }, { stateSince: 1 }), sess('b', { kind: 'finished' }, { stateSince: 2 })), workspaces: ws });
  expect(nextInQueue(q, null)?.session.id).toBe('a');
  expect(nextInQueue(q, 'a')?.session.id).toBe('b');
  expect(nextInQueue(q.slice(0, 1), 'a')).toBeNull();
});

const builder = (id: string): Builder => ({ id, name: id, agent: 'claude', model: null, effort: null, customCommand: null });
const todo = (id: string, extra: Partial<Todo> = {}): Todo => ({ id, workspaceId: 'w1', text: id, createdAt: Number(id.replace(/\D/g, '')) || 0, ...extra });

test('a To Do starts on its own only when set to, with its builder free and room under the limit', () => {
  const builders = [builder('b1'), builder('b2'), builder('b3')];
  const todos = [
    todo('t1', { auto: true, builderId: 'b1' }),
    todo('t2', { auto: true, builderId: 'b1' }), // same builder: waits for t1's session
    todo('t3', { auto: true, builderId: 'b2' }),
    todo('t4', { auto: false, builderId: 'b3' }), // not auto
    todo('t5', { auto: true, builderId: 'ghost' }),
    todo('t6', { auto: true, builderId: 'b3', workspaceId: 'gone' }),
  ];
  const base = { todos, builders, workspaces: ws, settings: null };
  expect(autoStartable({ ...base, sessions: {} }).map((t) => t.id)).toEqual(['t1', 't3']);
  // b2 busy (even finished, its session is live): only t1
  const busy = byId({ ...sess('x', { kind: 'finished' }), kind: { kind: 'agent', builderId: 'b2' } });
  expect(autoStartable({ ...base, sessions: busy }).map((t) => t.id)).toEqual(['t1']);
  // a limit of 2 with one already at work: one slot left
  const atWork = byId(sess('w', { kind: 'working' }));
  expect(autoStartable({ ...base, sessions: atWork, settings: { sessionLimit: 2 } }).map((t) => t.id)).toEqual(['t1']);
  expect(autoStartable({ ...base, sessions: atWork, settings: { sessionLimit: 1 } })).toEqual([]);
});

test('running agents count against the limit; finished ones do not', () => {
  const sessions = byId(sess('a', { kind: 'working' }), sess('b', { kind: 'starting' }), sess('c', { kind: 'finished' }), sess('d', { kind: 'working' }, { paused: true }));
  expect(runningAgents(sessions)).toBe(2);
  expect(roomToStart(sessions, { sessionLimit: 2 })).toBe(false);
  expect(roomToStart(sessions, { sessionLimit: 3 })).toBe(true);
  expect(roomToStart(sessions, null)).toBe(true);
});

test('waited labels', () => {
  expect(waitedLabel(20_000)).toBe('just now');
  expect(waitedLabel(5 * 60_000)).toBe('5m');
  expect(waitedLabel(80 * 60_000)).toBe('1h 20m');
});
