import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Frame, SessionInfo } from '../api/types';

const real = vi.hoisted(() => ({
  startSession: vi.fn(async () => ({ id: 'real-s' })),
  startTerminal: vi.fn(async () => ({ id: 'real-t' })),
  approve: vi.fn(async () => {}),
  closeSession: vi.fn(async () => ({})),
  openInEditor: vi.fn(async () => {}),
  discardAttachments: vi.fn(async () => {}),
  setCompound: vi.fn(async () => ({})),
  updateBuilder: vi.fn(async () => {}),
}));
vi.mock('../api/ipc', () => ({ ipc: { ...real } }));
import { ipc } from '../api/ipc';
import { useApp } from '../state/store';
import {
  DEMO_PATH, DEMO_TASK, DEMO_WS_ID, PACE, clearDemo, createDemoBuilder, demoAgentSession, installSandbox, isDemoId,
  raiseDemoWorkspace, resetSims, sandboxInstalled, uninstallSandbox,
} from './demo';

const st = () => useApp.getState();
const text = (frames: Frame[]) => frames.map((f) => new TextDecoder().decode(f.data)).join('');
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

async function startSample(task = 'Fix the header'): Promise<SessionInfo> {
  const b = await createDemoBuilder('Ivy', 'claude', null, null, null);
  st().addBuilder(b);
  const s = await ipc.startSession(DEMO_WS_ID, b.id, task);
  st().upsertSession(s);
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({ workspaces: [], sessions: {}, builders: [], todos: [], selection: null, panelOpen: false, kanban: null, notices: [] });
  Object.values(real).forEach((f) => f.mockClear());
  installSandbox();
  raiseDemoWorkspace();
});
afterEach(() => {
  resetSims();
  uninstallSandbox();
  vi.useRealTimers();
});

describe('the sample compound', () => {
  it('stands clear of the owner’s compounds and is raised only once', () => {
    const w = st().workspaces.find((x) => x.id === DEMO_WS_ID)!;
    expect(w).toMatchObject({ name: 'sample-app', path: DEMO_PATH, missing: false });
    expect(w.compound).not.toBeNull();
    raiseDemoWorkspace();
    expect(st().workspaces.filter((x) => x.id === DEMO_WS_ID)).toHaveLength(1);
  });

  it('routes only sample ids away from the backend', async () => {
    await ipc.startSession('w-real', 'b-real', 'task');
    expect(real.startSession).toHaveBeenCalledWith('w-real', 'b-real', 'task');
    const s = await startSample();
    expect(isDemoId(s.id)).toBe(true);
    expect(real.startSession).toHaveBeenCalledTimes(1);
    await ipc.approve('real-s');
    expect(real.approve).toHaveBeenCalledWith('real-s');
    await ipc.updateBuilder({ id: 'b-real', name: 'x', agent: 'claude', model: null, effort: null, customCommand: null });
    expect(real.updateBuilder).toHaveBeenCalledTimes(1);
  });

  it('refuses a sample builder in a real workspace', async () => {
    const b = await createDemoBuilder('Ivy', 'claude', null, null, null);
    await expect(ipc.startSession('w-real', b.id, '')).rejects.toThrow(/sample compound/);
    expect(real.startSession).not.toHaveBeenCalled();
  });

  it('has nothing on disk to open', async () => {
    await expect(ipc.openInEditor(DEMO_PATH)).rejects.toThrow(/isn't on disk/);
    await ipc.openInEditor('/Users/me/proj');
    expect(real.openInEditor).toHaveBeenCalledWith('/Users/me/proj');
  });

  it('uninstalling puts the real ipc back', () => {
    expect(sandboxInstalled()).toBe(true);
    uninstallSandbox();
    expect(sandboxInstalled()).toBe(false);
    expect(ipc.startSession).toBe(real.startSession);
    installSandbox();
    installSandbox(); // idempotent: never wraps the wrapper
    uninstallSandbox();
    expect(ipc.approve).toBe(real.approve);
  });
});

describe('a sample session', () => {
  it('works, asks, and finishes once allowed, printing to its terminal as it goes', async () => {
    const s = await startSample();
    expect(s.state.kind).toBe('starting');
    expect(s.task).toBe('Fix the header');
    const frames: Frame[] = [];
    const snap = await ipc.attachSession(s.id, (f) => frames.push(f));
    expect(text([snap])).toContain('Sample session');
    expect(text([snap])).toContain('Fix the header');

    await tick(PACE.boot);
    expect(demoAgentSession()!.state.kind).toBe('working');
    await tick(PACE.step * 4);
    const asking = demoAgentSession()!;
    expect(asking.state).toEqual({ kind: 'needsYou', reason: 'Allow Bash: npm test?' });
    expect(asking.awaitingDecision).toBe(true);
    expect(asking.steps).toBe(3);
    expect(text(frames)).toContain('Do you want to proceed?');
    // frames continue the stream where the snapshot ended
    expect(frames[0].offset).toBe(snap.data.length);

    await ipc.approve(s.id);
    expect(demoAgentSession()!.state.kind).toBe('working');
    await tick(PACE.step * 3);
    const done = demoAgentSession()!;
    expect(done.state.kind).toBe('finished');
    expect(done.reachedFinished).toBe(true);
    expect(done.steps).toBe(5);
    expect(text(frames)).toContain('Done: Fix the header');
    expect(done.rev).toBeGreaterThan(s.rev);
  });

  it('takes the answer from the terminal too, and a denial skips the tests', async () => {
    const s = await startSample();
    const frames: Frame[] = [];
    await ipc.attachSession(s.id, (f) => frames.push(f));
    await tick(PACE.boot + PACE.step * 4);
    await ipc.writeSession(s.id, [...new TextEncoder().encode('2')]);
    expect(text(frames)).toContain('Denied');
    await tick(PACE.step * 3);
    expect(demoAgentSession()!.state.kind).toBe('finished');
    expect(text(frames)).toContain('tests skipped');
  });

  it('uses a sample task when none was given', async () => {
    const s = await startSample('  ');
    expect(s.task).toBe(DEMO_TASK);
  });

  it('takes a follow-up after finishing, then finishes again', async () => {
    const s = await startSample();
    await tick(PACE.boot + PACE.step * 4);
    await ipc.approve(s.id);
    await tick(PACE.step * 3);
    const frames: Frame[] = [];
    await ipc.attachSession(s.id, (f) => frames.push(f));
    await ipc.writeSession(s.id, [...new TextEncoder().encode('also add tests\r')]);
    expect(text(frames)).toContain('also add tests');
    expect(demoAgentSession()!.state.kind).toBe('working');
    await tick(PACE.step * 3);
    expect(demoAgentSession()!.state.kind).toBe('finished');
  });

  it('stops for good when stopped', async () => {
    const s = await startSample();
    await tick(PACE.boot);
    await ipc.stopSession(s.id);
    expect(demoAgentSession()!.state).toEqual({ kind: 'ended', exitCode: null });
    await tick(PACE.step * 10);
    expect(demoAgentSession()!.state.kind).toBe('ended');
  });

  it('closing finished work ships it and livens up the sample house, then the session goes', async () => {
    const s = await startSample();
    await tick(PACE.boot + PACE.step * 4);
    await ipc.approve(s.id);
    await tick(PACE.step * 3);
    const o = await ipc.closeSession(s.id);
    expect(o).toMatchObject({ shipped: true, stageBefore: 0, stageAfter: 1, unfinished: false, stuck: false, workspaceId: DEMO_WS_ID });
    expect(st().workspaces.find((w) => w.id === DEMO_WS_ID)!.ships).toHaveLength(1);
    expect(st().sessions[s.id]).toBeDefined(); // the outcome lands first, so the village can play its orbs
    await tick(0);
    expect(st().sessions[s.id]).toBeUndefined();
    expect(st().stats.shippedTotal).toBe(0); // the owner's real tally is untouched
  });

  it('closing unfinished work earns nothing', async () => {
    const s = await startSample();
    const o = await ipc.closeSession(s.id);
    expect(o).toMatchObject({ shipped: false, stageBefore: 0, stageAfter: 0, unfinished: true });
    expect(st().workspaces.find((w) => w.id === DEMO_WS_ID)!.ships ?? []).toEqual([]);
  });

  it('gets a spot in the compound like a real one', async () => {
    const s = await startSample();
    const spot = await st().village.ensureSpot(s.id);
    expect(st().sessions[s.id].spot).toEqual(spot);
  });
});

describe('a sample terminal', () => {
  it('echoes, erases and answers Enter without running anything', async () => {
    const t = await ipc.startTerminal(DEMO_WS_ID);
    st().upsertSession(t);
    expect(t.kind).toEqual({ kind: 'terminal' });
    const frames: Frame[] = [];
    const snap = await ipc.attachSession(t.id, (f) => frames.push(f));
    expect(text([snap])).toContain('sample-app');
    await ipc.writeSession(t.id, [...new TextEncoder().encode('lsx\x7f\r')]);
    const out = text(frames);
    expect(out.startsWith('lsx\b \b')).toBe(true);
    expect(out).toContain("commands don't run");
    expect(real.startTerminal).not.toHaveBeenCalled();
  });
});

describe('clearDemo', () => {
  it('takes down every sample thing and nothing of the owner’s', async () => {
    st().addWorkspace({ id: 'w-real', name: 'mine', path: '/p', createdAt: 0, missing: false, compound: null });
    st().addBuilder({ id: 'b-real', name: 'Real', agent: 'claude', model: null, effort: null, customCommand: null });
    const s = await startSample();
    const todo = await ipc.addTodo(DEMO_WS_ID, 'later');
    st().addTodo(todo);
    st().setSelection({ kind: 'session', id: s.id });
    st().setKanban(DEMO_WS_ID);
    clearDemo();
    expect(st().workspaces.map((w) => w.id)).toEqual(['w-real']);
    expect(st().builders.map((b) => b.id)).toEqual(['b-real']);
    expect(Object.keys(st().sessions)).toEqual([]);
    expect(st().todos).toEqual([]);
    expect(st().selection).toBeNull();
    expect(st().kanban).toBeNull();
  });
});
