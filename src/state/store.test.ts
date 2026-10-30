import { useApp, sessionsByWorkspace, idleBuilders, stateLabel } from './store';
import type { Builder, SessionInfo, SessionState } from '../api/types';

const sess = (id: string, ws: string, builderId?: string, startedAt = 0, state: SessionState = { kind: 'working' }): SessionInfo => ({
  id, workspaceId: ws, kind: builderId ? { kind: 'agent', builderId } : { kind: 'terminal' },
  task: null, state, steps: 0, startedAt, lastOutputAt: 0, reachedFinished: false, worktree: null, commandPreview: '',
});
const bld = (id: string): Builder => ({ id, name: id, agent: 'claude', model: null, effort: null, customCommand: null });

beforeEach(() => {
  useApp.setState({ workspaces: [], builders: [], sessions: {}, agents: [], selectedSessionId: null });
});

test('upsert then remove session', () => {
  useApp.getState().upsertSession(sess('s1', 'w1'));
  expect(useApp.getState().sessions.s1).toBeDefined();
  useApp.getState().removeSession('s1');
  expect(useApp.getState().sessions.s1).toBeUndefined();
});

test('removing selected session clears selection', () => {
  useApp.getState().upsertSession(sess('s1', 'w1'));
  useApp.getState().select('s1');
  useApp.getState().removeSession('s1');
  expect(useApp.getState().selectedSessionId).toBeNull();
});

test('idleBuilders excludes busy builders', () => {
  useApp.getState().addBuilder(bld('b1'));
  useApp.getState().addBuilder(bld('b2'));
  useApp.getState().upsertSession(sess('s1', 'w1', 'b1'));
  expect(idleBuilders(useApp.getState()).map((b) => b.id)).toEqual(['b2']);
  useApp.getState().upsertSession(sess('s1', 'w1', 'b1', 0, { kind: 'ended', exitCode: 0 }));
  expect(idleBuilders(useApp.getState()).map((b) => b.id)).toEqual(['b1', 'b2']);
});

test('sessionsByWorkspace sorts by startedAt', () => {
  const s = useApp.getState();
  s.upsertSession(sess('a', 'w1', undefined, 30));
  s.upsertSession(sess('b', 'w1', undefined, 10));
  s.upsertSession(sess('c', 'w2', undefined, 20));
  expect(sessionsByWorkspace(useApp.getState(), 'w1').map((x) => x.id)).toEqual(['b', 'a']);
});

test('stateLabel maps needsYou', () => {
  expect(stateLabel({ kind: 'needsYou', reason: 'x' })).toBe('Needs you');
});

test('updateWorkspace replaces the matching workspace', () => {
  const w = (id: string, missing = false) => ({ id, name: id, path: `/p/${id}`, createdAt: 0, missing });
  useApp.getState().addWorkspace(w('w1'));
  useApp.getState().addWorkspace(w('w2'));
  useApp.getState().updateWorkspace(w('w2', true));
  expect(useApp.getState().workspaces.map((x) => [x.id, x.missing])).toEqual([['w1', false], ['w2', true]]);
});
