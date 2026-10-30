import { create } from 'zustand';
import type { AgentInfo, Builder, ListState, SessionInfo, SessionState, Workspace } from '../api/types';

export interface AppState {
  workspaces: Workspace[];
  builders: Builder[];
  sessions: Record<string, SessionInfo>;
  agents: AgentInfo[];
  selectedSessionId: string | null;
  hydrate: (s: ListState) => void;
  upsertSession: (s: SessionInfo) => void;
  removeSession: (id: string) => void;
  select: (id: string | null) => void;
  setAgents: (a: AgentInfo[]) => void;
  addWorkspace: (w: Workspace) => void;
  updateWorkspace: (w: Workspace) => void;
  addBuilder: (b: Builder) => void;
  updateBuilder: (b: Builder) => void;
}

export const useApp = create<AppState>((set) => ({
  workspaces: [],
  builders: [],
  sessions: {},
  agents: [],
  selectedSessionId: null,
  hydrate: (s) =>
    set({
      workspaces: s.workspaces,
      builders: s.builders,
      sessions: Object.fromEntries(s.sessions.map((x) => [x.id, x])),
    }),
  upsertSession: (s) => set((st) => ({ sessions: { ...st.sessions, [s.id]: s } })),
  removeSession: (id) =>
    set((st) => {
      const { [id]: _removed, ...rest } = st.sessions;
      return { sessions: rest, selectedSessionId: st.selectedSessionId === id ? null : st.selectedSessionId };
    }),
  select: (id) => set({ selectedSessionId: id }),
  setAgents: (agents) => set({ agents }),
  addWorkspace: (w) => set((st) => ({ workspaces: [...st.workspaces, w] })),
  updateWorkspace: (w) => set((st) => ({ workspaces: st.workspaces.map((x) => (x.id === w.id ? w : x)) })),
  addBuilder: (b) => set((st) => ({ builders: [...st.builders, b] })),
  updateBuilder: (b) => set((st) => ({ builders: st.builders.map((x) => (x.id === b.id ? b : x)) })),
}));

export function sessionsByWorkspace(state: Pick<AppState, 'sessions'>, wsId: string): SessionInfo[] {
  return Object.values(state.sessions)
    .filter((s) => s.workspaceId === wsId)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Builders with no live (non-ended) session. */
export function idleBuilders(state: Pick<AppState, 'builders' | 'sessions'>): Builder[] {
  const busy = new Set<string>();
  for (const s of Object.values(state.sessions)) {
    if (s.kind.kind === 'agent' && s.state.kind !== 'ended') busy.add(s.kind.builderId);
  }
  return state.builders.filter((b) => !busy.has(b.id));
}

export function stateLabel(s: SessionState): 'Starting' | 'Working' | 'Needs you' | 'Finished' | 'Stuck' | 'Ended' {
  switch (s.kind) {
    case 'starting': return 'Starting';
    case 'working': return 'Working';
    case 'needsYou': return 'Needs you';
    case 'finished': return 'Finished';
    case 'stuck': return 'Stuck';
    case 'ended': return 'Ended';
  }
}
