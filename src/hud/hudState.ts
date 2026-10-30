import type { Builder, SessionInfo } from '../api/types';

export type BadgeState = 'working' | 'needs' | 'stuck' | 'finished' | 'idle';

/** Live (non-ended) agent session of a builder, if any; the most recently started wins. */
export function liveSessionOf(builderId: string, sessions: SessionInfo[]): SessionInfo | undefined {
  return sessions
    .filter((s) => s.kind.kind === 'agent' && s.kind.builderId === builderId && s.state.kind !== 'ended')
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

export function badgeOf(s: SessionInfo | undefined): BadgeState {
  switch (s?.state.kind) {
    case 'starting': case 'working': return 'working';
    case 'needsYou': return 'needs';
    case 'stuck': return 'stuck';
    case 'finished': return 'finished';
    default: return 'idle';
  }
}

export const BADGE_LABEL: Record<BadgeState, string> = {
  working: 'Working', needs: 'Needs you', stuck: 'Stuck', finished: 'Ready', idle: 'Idle',
};

/** Agent sessions only; terminals never count. */
export function liveAgentSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.filter((s) => s.kind.kind === 'agent' && s.state.kind !== 'ended');
}

export function idleOf(builders: Builder[], sessions: SessionInfo[]): Builder[] {
  const busy = new Set(liveAgentSessions(sessions).map((s) => (s.kind as { builderId: string }).builderId));
  return builders.filter((b) => !busy.has(b.id));
}

export function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
