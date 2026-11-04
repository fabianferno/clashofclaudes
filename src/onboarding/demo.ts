/**
 * The tour's sample compound: a workspace, builders, sessions, terminals and to-dos that live only
 * in the store (never on disk, never sent to the backend) and a small script that plays a session
 * the way a real agent would: working, asking for permission, finishing, taking a follow-up.
 *
 * Everything is told apart by its id (`demo-…`), and `installSandbox` routes the ipc calls the real
 * UI makes for those ids here, so the real panels, Kanban and terminal work on the sample unchanged.
 */
import { ipc } from '../api/ipc';
import type { AgentKind, Builder, CloseOutcome, Compound, Frame, Review, SessionInfo, Tile, Todo, Workspace } from '../api/types';
import { useApp } from '../state/store';
import { placeCompound, shiftCompound } from '../village/layout';
import { xpNeed } from '../village/look';

export const DEMO = 'demo-';
export const isDemoId = (id: unknown): boolean => typeof id === 'string' && id.startsWith(DEMO);
export const DEMO_WS_ID = `${DEMO}ws`;
export const DEMO_WS_NAME = 'sample-app';
/** Shown where a real workspace shows its folder; it is no folder at all. */
export const DEMO_PATH = 'sample compound (tour only, not on disk)';
/** The task offered in the picker when none is typed. */
export const DEMO_TASK = 'Add a dark mode toggle';
/** XP a closed, finished session earns (src-tauri/src/xp.rs XP_PER_SESSION). */
export const XP_PER_SESSION = 100;

/** How the sample session paces itself, ms. */
export const PACE = { boot: 1100, step: 1500 };
/** Steps before the session stops to ask for permission, and after it is answered. */
const STEPS_BEFORE_ASK = 3;

const NOT_ON_DISK = "The sample workspace isn't on disk, so there's nothing to open. Your own workspaces open in your editor and Finder.";

// ---------------------------------------------------------------- the transcript

const A = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', accent: '\x1b[38;5;209m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', grey: '\x1b[90m', cyan: '\x1b[36m' };

type Phase = 'boot' | 'work' | 'ask' | 'after' | 'done' | 'followup' | 'stopped';

interface Sim {
  id: string;
  terminal: boolean;
  /** Everything printed so far (the snapshot an attach replays). */
  chunks: Uint8Array[];
  length: number;
  /** The attached terminal (one at a time, as with the backend's channel). */
  listener: ((f: Frame) => void) | null;
  timers: Array<ReturnType<typeof setTimeout>>;
  phase: Phase;
  /** What has been typed at the prompt since the last Enter. */
  typed: string;
  task: string;
  answered: 'yes' | 'no' | null;
}

const sims = new Map<string, Sim>();
let seq = 0;
const nextId = (kind: string) => `${DEMO}${kind}-${(++seq).toString(36)}`;
const enc = new TextEncoder();
const dec = new TextDecoder();

function print(sim: Sim, text: string): void {
  const data = enc.encode(text.replace(/\r?\n/g, '\r\n'));
  const frame: Frame = { offset: sim.length, data };
  sim.chunks.push(data);
  sim.length += data.length;
  sim.listener?.(frame);
}

function snapshot(sim: Sim): Frame {
  const data = new Uint8Array(sim.length);
  let at = 0;
  for (const c of sim.chunks) { data.set(c, at); at += c.length; }
  return { offset: 0, data };
}

const later = (sim: Sim, ms: number, fn: () => void) => { sim.timers.push(setTimeout(fn, ms)); };
const stopTimers = (sim: Sim) => { sim.timers.forEach(clearTimeout); sim.timers = []; };

/** Updates a sample session in the store (a newer rev, as the backend's updates have). */
function patch(id: string, p: Partial<SessionInfo>): SessionInfo | null {
  const cur = useApp.getState().sessions[id];
  if (!cur) return null;
  const next = { ...cur, ...p, rev: cur.rev + 1, lastOutputAt: Date.now() };
  useApp.getState().upsertSession(next);
  return next;
}

const PROMPT = `\n${A.accent}>${A.reset} `;
const SHELL_PROMPT = `${A.green}${DEMO_WS_NAME}${A.reset} % `;

/** Tool calls the sample agent "makes", in order; the task only flavours the words. */
const WORK: Array<(task: string) => string> = [
  () => `${A.accent}⏺${A.reset} ${A.bold}Read${A.reset}(src/App.tsx)\n  ${A.grey}⎿  Read 96 lines${A.reset}\n`,
  () => `${A.accent}⏺${A.reset} ${A.bold}Search${A.reset}(pattern: "theme", path: "src")\n  ${A.grey}⎿  Found 4 files${A.reset}\n`,
  () => `${A.accent}⏺${A.reset} ${A.bold}Update${A.reset}(src/theme.ts)\n  ${A.grey}⎿  Updated src/theme.ts with ${A.green}42 additions${A.grey} and ${A.red}3 removals${A.reset}\n`,
];
const AFTER_YES: Array<(task: string) => string> = [
  () => `${A.accent}⏺${A.reset} ${A.bold}Bash${A.reset}(npm test)\n  ${A.grey}⎿  ${A.green}24 passed${A.grey} (1.8s)${A.reset}\n`,
  () => `${A.accent}⏺${A.reset} ${A.bold}Update${A.reset}(src/App.tsx)\n  ${A.grey}⎿  Updated src/App.tsx with ${A.green}12 additions${A.grey} and ${A.red}2 removals${A.reset}\n`,
];
const AFTER_NO: Array<(task: string) => string> = [
  () => `  ${A.grey}⎿  Okay, I won't run the tests. Skipping them.${A.reset}\n`,
  () => `${A.accent}⏺${A.reset} ${A.bold}Update${A.reset}(src/App.tsx)\n  ${A.grey}⎿  Updated src/App.tsx with ${A.green}12 additions${A.grey} and ${A.red}2 removals${A.reset}\n`,
];
const FOLLOWUP: Array<(task: string) => string> = [
  () => `${A.accent}⏺${A.reset} ${A.bold}Read${A.reset}(src/theme.ts)\n  ${A.grey}⎿  Read 58 lines${A.reset}\n`,
  () => `${A.accent}⏺${A.reset} ${A.bold}Update${A.reset}(src/theme.ts)\n  ${A.grey}⎿  Updated src/theme.ts with ${A.green}6 additions${A.reset}\n`,
];

function banner(builder: Builder | undefined, task: string): string {
  const who = builder ? `${builder.name} (${agentName(builder.agent)})` : 'Sample builder';
  return `${A.accent}✻${A.reset} ${A.bold}Sample session${A.reset} · ${who}\n`
    + `${A.grey}  Tour only: nothing runs and no files change. Type here as you would in a real session.${A.reset}\n`
    + `${PROMPT}${task}\n\n`;
}

const agentName = (k: AgentKind) => ({ claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode', custom: 'Custom' })[k];

const ASK = `\n${A.yellow}╭─ Permission ─────────────────────────────╮${A.reset}\n`
  + `${A.yellow}│${A.reset} ${A.bold}Bash command${A.reset}: npm test\n`
  + `${A.yellow}│${A.reset} Do you want to proceed?\n`
  + `${A.yellow}│${A.reset} ${A.cyan}❯ 1. Yes${A.reset}\n`
  + `${A.yellow}│${A.reset}   2. No, and tell me what to do differently\n`
  + `${A.yellow}╰──────────────────────────────────────────╯${A.reset}\n`
  + `${A.grey}  Allow or Deny in the panel, or type 1 or 2 here.${A.reset}\n`;

/** Runs `lines` one step apart, counting steps, then `then`. */
function steps(sim: Sim, lines: Array<(task: string) => string>, then: () => void): void {
  lines.forEach((line, i) => later(sim, PACE.step * (i + 1), () => {
    print(sim, line(sim.task));
    const cur = useApp.getState().sessions[sim.id];
    if (cur) patch(sim.id, { steps: cur.steps + 1 });
  }));
  later(sim, PACE.step * (lines.length + 1), then);
}

function finish(sim: Sim): void {
  sim.phase = 'done';
  const what = sim.answered === 'no' ? ' (tests skipped, as you asked)' : '';
  print(sim, `\n${A.accent}⏺${A.reset} Done: ${sim.task}${what}. Review the changes, then close me to earn XP.\n${PROMPT}`);
  patch(sim.id, { state: { kind: 'finished' }, reachedFinished: true, awaitingDecision: false });
}

function begin(sim: Sim): void {
  later(sim, PACE.boot, () => {
    sim.phase = 'work';
    patch(sim.id, { state: { kind: 'working' } });
    steps(sim, WORK.slice(0, STEPS_BEFORE_ASK), () => {
      sim.phase = 'ask';
      print(sim, ASK);
      patch(sim.id, { state: { kind: 'needsYou', reason: 'Allow Bash: npm test?' }, awaitingDecision: true });
    });
  });
}

function answer(sim: Sim, yes: boolean): void {
  if (sim.phase !== 'ask') return;
  sim.phase = 'after';
  sim.answered = yes ? 'yes' : 'no';
  print(sim, yes ? `  ${A.green}✓ Allowed${A.reset}\n` : `  ${A.red}✗ Denied${A.reset}\n`);
  patch(sim.id, { state: { kind: 'working' }, awaitingDecision: false });
  steps(sim, yes ? AFTER_YES : AFTER_NO, () => finish(sim));
}

/** Typing into a sample session or terminal. */
function type(sim: Sim, text: string): void {
  if (sim.phase === 'stopped') return;
  for (const ch of text) {
    if (!sim.terminal && sim.phase === 'ask') {
      if (ch === '1' || ch === 'y' || ch === '\r') answer(sim, true);
      else if (ch === '2' || ch === 'n' || ch === '\x1b') answer(sim, false);
      continue;
    }
    if (ch === '\r') { enter(sim); continue; }
    if (ch === '\x7f' || ch === '\b') {
      if (sim.typed) { sim.typed = Array.from(sim.typed).slice(0, -1).join(''); print(sim, '\b \b'); }
      continue;
    }
    if (ch < ' ') continue; // other control keys do nothing here
    sim.typed += ch;
    print(sim, ch);
  }
}

function enter(sim: Sim): void {
  const line = sim.typed.trim();
  sim.typed = '';
  if (sim.terminal) {
    print(sim, line ? `\n${A.grey}(sample shell: commands don't run during the tour)${A.reset}\n${SHELL_PROMPT}` : `\n${SHELL_PROMPT}`);
    return;
  }
  if (!line) { print(sim, PROMPT); return; }
  if (sim.phase !== 'done') {
    print(sim, `\n${A.grey}  (queued: I'll get to it after this)${A.reset}\n`);
    return;
  }
  // a follow-up after finishing: back to work for a moment, then finished again
  sim.phase = 'followup';
  sim.task = line;
  print(sim, '\n\n');
  patch(sim.id, { state: { kind: 'working' } });
  steps(sim, FOLLOWUP, () => finish(sim));
}

// ---------------------------------------------------------------- the sample's ipc

/** The sample compound, standing clear of the owner's compounds; the existing one if it is up. */
export function raiseDemoWorkspace(): Workspace {
  const st = useApp.getState();
  const had = st.workspaces.find((w) => w.id === DEMO_WS_ID);
  if (had) return had;
  const compound = placeCompound(st.workspaces.flatMap((w) => (w.compound ? [w.compound] : [])));
  const w: Workspace = { id: DEMO_WS_ID, name: DEMO_WS_NAME, path: DEMO_PATH, createdAt: Date.now(), missing: false, level: 1, xp: 0, compound, color: null };
  st.addWorkspace(w);
  return w;
}

export const demoWorkspace = (): Workspace | undefined => useApp.getState().workspaces.find((w) => w.id === DEMO_WS_ID);

/** A builder for the sample only (the picker uses it in place of ipc.createBuilder there). */
export async function createDemoBuilder(name: string, agent: AgentKind, model: string | null, effort: string | null, customCommand: string | null): Promise<Builder> {
  return { id: nextId('b'), name, agent, model, effort, customCommand };
}

function session(workspaceId: string, kind: SessionInfo['kind'], task: string | null): SessionInfo {
  const now = Date.now();
  return {
    id: nextId('s'), workspaceId, kind, task, state: { kind: kind.kind === 'agent' ? 'starting' : 'working' }, steps: 0,
    startedAt: now, lastOutputAt: now, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision: false,
    busy: false, rev: 1, spot: null,
  };
}

function newSim(id: string, terminal: boolean, task: string): Sim {
  const sim: Sim = { id, terminal, chunks: [], length: 0, listener: null, timers: [], phase: 'boot', typed: '', task, answered: null };
  sims.set(id, sim);
  return sim;
}

const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new Error(`unknown ${what}`);
  return v;
};
const wsOf = (id: string) => need(useApp.getState().workspaces.find((w) => w.id === id), 'workspace');
const sessionOf = (id: string) => need(useApp.getState().sessions[id], 'session');

/** XP after closing, as the backend awards it (src-tauri/src/xp.rs `award`). */
export function award(level: number, xp: number, gain: number): { level: number; xp: number } {
  let l = Math.max(1, level), x = xp + gain;
  while (x >= xpNeed(l)) { x -= xpNeed(l); l += 1; }
  return { level: l, xp: x };
}

export const demoIpc = {
  startSession: async (workspaceId: string, builderId: string, task: string, images: string[] = []): Promise<SessionInfo> => {
    if (!isDemoId(workspaceId)) throw new Error('Sample builders only work in the sample compound.');
    if (images.length) ipc.discardAttachments(images).catch(() => {}); // the sample has no use for them
    const builder = useApp.getState().builders.find((b) => b.id === builderId);
    const t = task.trim() || DEMO_TASK;
    const s = session(workspaceId, { kind: 'agent', builderId }, t);
    const sim = newSim(s.id, false, t);
    print(sim, banner(builder, t));
    begin(sim);
    return s;
  },
  startTerminal: async (workspaceId: string): Promise<SessionInfo> => {
    wsOf(workspaceId);
    const s = session(workspaceId, { kind: 'terminal' }, null);
    const sim = newSim(s.id, true, '');
    sim.phase = 'done';
    print(sim, `${A.grey}Sample shell for the tour: try typing, nothing runs.${A.reset}\n${SHELL_PROMPT}`);
    return s;
  },
  writeSession: async (id: string, data: number[]) => { const sim = sims.get(id); if (sim) type(sim, dec.decode(new Uint8Array(data))); },
  resizeSession: async () => {},
  ackOutput: async () => {},
  attachSession: async (id: string, onFrame: (f: Frame) => void): Promise<Frame> => {
    const sim = need(sims.get(id), 'session');
    sim.listener = onFrame;
    return snapshot(sim);
  },
  detachSession: async (id: string) => { const sim = sims.get(id); if (sim) sim.listener = null; },
  approve: async (id: string) => { answer(need(sims.get(id), 'session'), true); },
  deny: async (id: string) => { answer(need(sims.get(id), 'session'), false); },
  stopSession: async (id: string) => {
    const sim = need(sims.get(id), 'session');
    stopTimers(sim);
    sim.phase = 'stopped';
    print(sim, `\n${A.grey}[stopped]${A.reset}\n`);
    patch(id, { state: { kind: 'ended', exitCode: null }, awaitingDecision: false, busy: false });
  },
  resumeSession: async (id: string) => sessionOf(id),
  closeSession: async (id: string): Promise<CloseOutcome> => {
    const s = sessionOf(id);
    const agent = s.kind.kind === 'agent';
    const out: CloseOutcome = {
      earnedXp: false, xpGained: 0, levelBefore: 1, levelAfter: 1, workspaceId: s.workspaceId,
      unfinished: agent && !s.reachedFinished, stuck: agent && s.state.kind === 'stuck',
    };
    const sim = sims.get(id);
    if (sim) stopTimers(sim);
    sims.delete(id);
    const w = useApp.getState().workspaces.find((x) => x.id === s.workspaceId);
    if (w) {
      out.levelBefore = out.levelAfter = w.level;
      if (agent && s.reachedFinished && !out.stuck) {
        const next = award(w.level, w.xp, XP_PER_SESSION);
        useApp.getState().updateWorkspace({ ...w, ...next });
        Object.assign(out, { earnedXp: true, xpGained: XP_PER_SESSION, levelAfter: next.level });
      }
    }
    // as the backend's session-removed event: after the caller has the outcome (the village plays its orbs)
    setTimeout(() => useApp.getState().removeSession(id), 0);
    return out;
  },
  reviewSession: async (id: string): Promise<Review> => {
    sessionOf(id);
    return {
      isGit: true, branch: 'sample/dark-mode',
      files: [{ path: 'src/theme.ts', added: 42, removed: 3 }, { path: 'src/App.tsx', added: 12, removed: 2 }],
      untracked: ['src/DarkModeToggle.tsx'], otherSessionsActive: false,
    };
  },
  setCompound: async (workspaceId: string, compound: Compound): Promise<Workspace> => ({ ...wsOf(workspaceId), compound }),
  setWorkspaceColor: async (workspaceId: string, color: string | null): Promise<Workspace> => ({ ...wsOf(workspaceId), color }),
  setSessionSpot: async (id: string, spot: Tile): Promise<SessionInfo> => {
    const s = sessionOf(id);
    return { ...s, spot, rev: s.rev + 1 };
  },
  moveCompound: async (workspaceId: string, dx: number, dy: number) => {
    const w = wsOf(workspaceId);
    const workspace = { ...w, compound: w.compound ? shiftCompound(w.compound, dx, dy) : null };
    const sessions = Object.values(useApp.getState().sessions)
      .filter((s) => s.workspaceId === workspaceId && s.spot)
      .map((s) => ({ ...s, spot: { x: s.spot!.x + dx, y: s.spot!.y + dy }, rev: s.rev + 1 }));
    return { workspace, sessions };
  },
  removeWorkspace: async (id: string) => {
    for (const s of Object.values(useApp.getState().sessions)) if (s.workspaceId === id) endSim(s.id);
  },
  addTodo: async (workspaceId: string, text: string, images: string[] = []): Promise<Todo> => {
    wsOf(workspaceId);
    return { id: nextId('t'), workspaceId, text, images, createdAt: Date.now() };
  },
  removeTodo: async () => {},
  updateBuilder: async () => {},
  deleteBuilder: async () => {},
  openInEditor: async () => { throw new Error(NOT_ON_DISK); },
  openInFinder: async () => { throw new Error(NOT_ON_DISK); },
};

function endSim(id: string): void {
  const sim = sims.get(id);
  if (sim) stopTimers(sim);
  sims.delete(id);
  useApp.getState().removeSession(id);
}

// ---------------------------------------------------------------- routing

type Fn = (...a: never[]) => unknown;
const saved = new Map<string, Fn>();

/** Which argument says the call is for the sample. */
const ROUTES: Record<keyof typeof demoIpc, (...a: never[]) => boolean> = {
  // a real builder may work in the sample; a sample builder sent to a real workspace is refused there
  startSession: (ws: string, builder: string) => isDemoId(ws) || isDemoId(builder),
  startTerminal: (ws: string) => isDemoId(ws),
  writeSession: (id: string) => isDemoId(id),
  resizeSession: (id: string) => isDemoId(id),
  ackOutput: (id: string) => isDemoId(id),
  attachSession: (id: string) => isDemoId(id),
  detachSession: (id: string) => isDemoId(id),
  approve: (id: string) => isDemoId(id),
  deny: (id: string) => isDemoId(id),
  stopSession: (id: string) => isDemoId(id),
  resumeSession: (id: string) => isDemoId(id),
  closeSession: (id: string) => isDemoId(id),
  reviewSession: (id: string) => isDemoId(id),
  setCompound: (ws: string) => isDemoId(ws),
  setWorkspaceColor: (ws: string) => isDemoId(ws),
  setSessionSpot: (id: string) => isDemoId(id),
  moveCompound: (ws: string) => isDemoId(ws),
  removeWorkspace: (ws: string) => isDemoId(ws),
  addTodo: (ws: string) => isDemoId(ws),
  removeTodo: (id: string) => isDemoId(id),
  updateBuilder: (b: Builder) => isDemoId(b?.id),
  deleteBuilder: (id: string) => isDemoId(id),
  openInEditor: (path: string) => path === DEMO_PATH,
  openInFinder: (path: string) => path === DEMO_PATH,
};

/** Routes the ipc calls for sample ids to the sample (idempotent). Real ids still reach the backend. */
export function installSandbox(): void {
  if (saved.size) return;
  const live = ipc as unknown as Record<string, Fn>;
  for (const key of Object.keys(ROUTES) as Array<keyof typeof demoIpc>) {
    const real = live[key];
    saved.set(key, real);
    const isDemo = ROUTES[key] as (...a: unknown[]) => boolean;
    const fake = demoIpc[key] as (...a: unknown[]) => Promise<unknown>;
    live[key] = ((...a: unknown[]) => (isDemo(...a) ? fake(...a) : (real as (...b: unknown[]) => unknown)(...a))) as Fn;
  }
}

export function uninstallSandbox(): void {
  const live = ipc as unknown as Record<string, Fn>;
  for (const [key, real] of saved) live[key] = real;
  saved.clear();
}

export const sandboxInstalled = (): boolean => saved.size > 0;

/** Takes the whole sample down: its sessions (and their scripts), to-dos, builders and the compound. */
export function clearDemo(): void {
  for (const sim of sims.values()) stopTimers(sim);
  sims.clear();
  const st = useApp.getState();
  if (isDemoSelection(st.selection)) st.setSelection(null);
  if (isDemoId(st.kanban)) st.setKanban(null);
  for (const s of Object.values(st.sessions)) if (isDemoId(s.id)) st.removeSession(s.id);
  for (const t of st.todos) if (isDemoId(t.id)) st.removeTodo(t.id);
  for (const b of st.builders) if (isDemoId(b.id)) st.removeBuilder(b.id);
  if (st.workspaces.some((w) => w.id === DEMO_WS_ID)) st.removeWorkspace(DEMO_WS_ID);
}

function isDemoSelection(sel: ReturnType<typeof useApp.getState>['selection']): boolean {
  if (!sel) return false;
  switch (sel.kind) {
    case 'workspace': case 'session': case 'builder': return isDemoId(sel.id);
    default: return false;
  }
}

/** The newest sample agent session, if any. */
export function demoAgentSession(): SessionInfo | undefined {
  return Object.values(useApp.getState().sessions)
    .filter((s) => isDemoId(s.id) && s.kind.kind === 'agent')
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

/** For tests: forget every script without touching the store. */
export function resetSims(): void {
  for (const sim of sims.values()) stopTimers(sim);
  sims.clear();
}
