import { ipc } from '../api/ipc';
import type { SessionInfo } from '../api/types';
import { KANBAN_ALL, useApp, type AppState } from '../state/store';
import { createFolder, openFolder } from '../state/workspaceActions';
import { builderTarget } from '../hud/hudState';
import { COLLECTOR_NAME, shownCollectors } from '../village/quota';
import { openBugReport } from './BugReport';
import { sessionName } from './sessionName';

export type CommandGroup = 'Common' | 'Sessions' | 'Workspaces' | 'Builders' | 'Actions';

export interface Command {
  id: string;
  group: CommandGroup;
  label: string;
  /** Second line: where it is, or what it does. */
  hint?: string;
  /** Extra words it is found by. */
  keywords?: string;
  session?: SessionInfo;
  /** Its keyboard shortcut, as shown ("⌘N"); see SHORTCUTS. */
  shortcut?: string;
  /** Runs it; the palette has closed by then. */
  run?: () => void | Promise<void>;
  /** Asks for text first (in the palette), then runs with it. */
  ask?: { placeholder: string; submit: (text: string) => void | Promise<unknown> };
}

type State = Pick<AppState, 'sessions' | 'workspaces' | 'builders' | 'quotas' | 'agents' | 'selection' | 'kanban'>;

/** Sessions that want the owner first, then those at work, then the rest; newest first within each. */
const RANK: Record<SessionInfo['state']['kind'], number> = { needsYou: 0, stuck: 0, starting: 1, working: 1, finished: 2, ended: 3 };

/** Leaves any full page (Kanban, Settings) so what comes next is seen. */
function toVillage() {
  const st = useApp.getState();
  st.setKanban(null);
  st.setSettingsOpen(false);
}

const go = (sel: Parameters<AppState['setSelection']>[0]) => () => {
  toVillage();
  useApp.getState().setSelection(sel);
};

/**
 * The workspace a shortcut acts on: the one open (its panel, a session of it, its Kanban), else
 * the only one there is. Null when it is not clear which.
 */
export function currentWorkspace(st: Pick<AppState, 'sessions' | 'workspaces' | 'selection' | 'kanban'>): string | null {
  const usable = st.workspaces.filter((w) => !w.missing);
  const sel = st.selection;
  const id = st.kanban && st.kanban !== KANBAN_ALL ? st.kanban
    : sel?.kind === 'workspace' ? sel.id
    : sel?.kind === 'session' ? st.sessions[sel.id]?.workspaceId
    : usable.length === 1 ? usable[0].id : null;
  return id && usable.some((w) => w.id === id) ? id : null;
}

/** The sessions that need the owner, oldest wait first. */
const needing = (st: Pick<AppState, 'sessions' | 'workspaces'>) => Object.values(st.sessions)
  .filter((s) => s.kind.kind === 'agent' && !s.paused && (s.state.kind === 'needsYou' || s.state.kind === 'stuck') && st.workspaces.some((w) => w.id === s.workspaceId))
  .sort((a, b) => a.startedAt - b.startedAt);

/**
 * Keyboard shortcuts for the commands used most (⌘ on a Mac, Ctrl elsewhere). Each names the
 * command it runs for the current workspace, or, when none is clear, what the palette opens with
 * to pick one.
 */
export interface Shortcut {
  key: string;
  shift?: boolean;
  /** The command it runs, if there is one now. */
  command: (st: State, ws: string | null) => string | null;
  /** Without one: the palette opens with this typed. */
  otherwise?: string;
}
export const SHORTCUTS: Shortcut[] = [
  { key: 'n', command: (_, ws) => (ws ? `new:${ws}` : null), otherwise: 'New session in ' },
  { key: 't', command: (_, ws) => (ws ? `term:${ws}` : null), otherwise: 'New terminal in ' },
  { key: 'b', command: (_, ws) => (ws ? `kanban:${ws}` : 'kanban:all') },
  { key: 'b', shift: true, command: () => 'kanban:all' },
  { key: 'j', command: () => 'next-needs' },
  { key: 'e', shift: true, command: (_, ws) => (ws ? `editor:${ws}` : null), otherwise: 'Open in editor ' },
  { key: 'h', shift: true, command: () => 'hall' },
  { key: 'n', shift: true, command: () => 'ws:new' },
  { key: 'o', command: () => 'ws:open' },
];

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const keyLabel = (s: Pick<Shortcut, 'key' | 'shift'>) => `${IS_MAC ? '⌘' : 'Ctrl+'}${s.shift ? (IS_MAC ? '⇧' : 'Shift+') : ''}${s.key.toUpperCase()}`;

/** The shortcut a key press is, if any: ⌘ (Ctrl off a Mac, where Ctrl belongs to the terminal) and a letter. */
export function shortcutOf(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): Shortcut | null {
  const mod = e.metaKey || (!IS_MAC && e.ctrlKey);
  if (!mod || e.altKey || (e.metaKey && e.ctrlKey)) return null;
  const key = e.key.toLowerCase();
  return SHORTCUTS.find((s) => s.key === key && !!s.shift === e.shiftKey) ?? null;
}

/** Everything the palette offers, in its order when nothing is typed: the shortcuts' commands first. */
export function paletteCommands(st: State): Command[] {
  const out: Command[] = [];
  const wsName = (id: string) => st.workspaces.find((w) => w.id === id)?.name ?? '';
  const sessions = Object.values(st.sessions)
    .filter((s) => st.workspaces.some((w) => w.id === s.workspaceId))
    .sort((a, b) => RANK[a.state.kind] - RANK[b.state.kind] || (a.paused ? 1 : 0) - (b.paused ? 1 : 0) || b.startedAt - a.startedAt);
  for (const s of sessions) {
    const b = s.kind.kind === 'agent' ? st.builders.find((x) => x.id === (s.kind as { builderId: string }).builderId) : undefined;
    const terminal = s.kind.kind === 'terminal';
    out.push({
      id: `session:${s.id}`, group: 'Sessions', session: s,
      label: terminal ? 'Terminal' : sessionName(s) ?? 'Session',
      hint: `${wsName(s.workspaceId)} · ${b?.name ?? 'plain shell'}`,
      keywords: [s.task, b?.agent].filter(Boolean).join(' '),
      run: go({ kind: 'session', id: s.id }),
    });
  }

  const waiting = needing(st);
  if (waiting.length > 0) {
    const sel = st.selection?.kind === 'session' ? st.selection.id : null;
    // the next one after the session open now, round the list
    const next = waiting[(waiting.findIndex((s) => s.id === sel) + 1) % waiting.length];
    out.push({ id: 'next-needs', group: 'Actions', label: 'Next session that needs you', hint: `${waiting.length} waiting`, keywords: 'jump approve permission',
      run: go({ kind: 'session', id: next.id }) });
  }
  out.push(
    { id: 'hall', group: 'Actions', label: 'Town Hall', hint: 'Every workspace and builder', run: go({ kind: 'hall' }) },
    { id: 'kanban:all', group: 'Actions', label: 'Kanban: all workspaces', hint: 'Every session and To Do on one board', keywords: 'board todo',
      run: () => { toVillage(); useApp.getState().setKanban(KANBAN_ALL); } },
  );
  for (const w of st.workspaces.filter((x) => !x.missing)) {
    out.push(
      { id: `new:${w.id}`, group: 'Actions', label: `New session in ${w.name}`, hint: 'Pick a builder and give it a task', keywords: 'start agent task',
        run: go({ kind: 'workspace', id: w.id, newSession: true }) },
      { id: `term:${w.id}`, group: 'Actions', label: `New terminal in ${w.name}`, hint: 'A plain shell in its folder', keywords: 'shell',
        run: async () => {
          toVillage();
          const s = await ipc.startTerminal(w.id);
          useApp.getState().upsertSession(s);
          useApp.getState().setSelection({ kind: 'session', id: s.id });
        } },
      { id: `kanban:${w.id}`, group: 'Actions', label: `Kanban: ${w.name}`, hint: 'Its sessions and To Do', keywords: 'board todo',
        run: () => { toVillage(); useApp.getState().setKanban(w.id); } },
      { id: `editor:${w.id}`, group: 'Actions', label: `Open ${w.name} in editor`, hint: w.path, keywords: 'code vscode cursor',
        run: () => ipc.openInEditor(w.path) },
      { id: `finder:${w.id}`, group: 'Actions', label: `Open ${w.name} in Finder`, hint: w.path, keywords: 'folder reveal',
        run: () => ipc.openInFinder(w.path) },
    );
    if (w.compound) {
      out.push({ id: `focus:${w.id}`, group: 'Actions', label: `Focus ${w.name}`, hint: 'Zoom the village to it', keywords: 'zoom camera',
        run: () => { toVillage(); useApp.getState().requestZoom(w.id); } });
    }
  }
  out.push(
    { id: 'ws:new', group: 'Actions', label: 'New workspace…', hint: 'A new folder, as a workspace', keywords: 'build create project',
      ask: { placeholder: 'Workspace name', submit: (name) => createFolder(name) } },
    { id: 'ws:open', group: 'Actions', label: 'Open a folder as a workspace…', hint: 'An existing project', keywords: 'add project',
      run: () => openFolder() },
    { id: 'settings', group: 'Actions', label: 'Settings', keywords: 'preferences update', run: () => { useApp.getState().setKanban(null); useApp.getState().setSettingsOpen(true); } },
    { id: 'bug', group: 'Actions', label: 'Report a bug', keywords: 'feedback', run: () => openBugReport('bug') },
    { id: 'feature', group: 'Actions', label: 'Request a feature', keywords: 'feedback idea', run: () => openBugReport('feature') },
  );
  for (const a of shownCollectors(st.quotas, st.agents.filter((x) => x.installed).map((x) => x.kind))) {
    out.push({ id: `quota:${a}`, group: 'Actions', label: `${COLLECTOR_NAME[a]} limits`, hint: 'Usage left and the account signed in', keywords: 'quota tank resource usage account',
      run: go({ kind: 'quota', agent: a }) });
  }

  for (const w of st.workspaces) {
    const n = sessions.filter((s) => s.workspaceId === w.id).length;
    out.push({ id: `ws:${w.id}`, group: 'Workspaces', label: w.name, hint: `${n} ${n === 1 ? 'session' : 'sessions'} · ${w.path}`, run: go({ kind: 'workspace', id: w.id }) });
  }
  for (const b of st.builders) {
    out.push({ id: `builder:${b.id}`, group: 'Builders', label: b.name, hint: b.agent, run: go(builderTarget(b.id, Object.values(st.sessions))) });
  }
  // the shortcuts' commands, labelled, lead the list
  const ws = currentWorkspace(st);
  const common: Command[] = [];
  for (const s of SHORTCUTS) {
    const id = s.command(st, ws);
    const c = id ? out.find((x) => x.id === id) : undefined;
    if (!c || c.shortcut) continue;
    c.shortcut = keyLabel(s);
    common.push(c);
  }
  for (const c of common) c.group = 'Common';
  return [...common, ...out.filter((c) => !common.includes(c))];
}

/**
 * The commands matching `query`, best first: every word must appear in the label, hint or
 * keywords; a label that starts with it, or whose words start with them, ranks higher. Ties keep
 * the palette's order.
 */
export function matchCommands(all: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return all;
  const q = words.join(' ');
  const scored: Array<{ c: Command; score: number; i: number }> = [];
  all.forEach((c, i) => {
    const label = c.label.toLowerCase();
    const hay = `${label} ${(c.hint ?? '').toLowerCase()} ${(c.keywords ?? '').toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) return;
    let score = label.startsWith(q) ? 100 : label.includes(q) ? 40 : 0;
    for (const w of words) {
      if (new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(label)) score += 10;
      else if (label.includes(w)) score += 4;
    }
    scored.push({ c, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.c);
}
