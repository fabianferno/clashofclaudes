import type { Builder, SessionInfo } from '../api/types';
import type { Selection } from '../state/store';

export type BadgeState = 'working' | 'needs' | 'stuck' | 'finished' | 'idle';

/** Live (non-ended) agent session of a builder, if any; the most recently started wins. */
export function liveSessionOf(builderId: string, sessions: SessionInfo[]): SessionInfo | undefined {
  return sessions
    .filter((s) => s.kind.kind === 'agent' && s.kind.builderId === builderId && s.state.kind !== 'ended')
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

/**
 * What a click on a builder (roster card or village sprite) opens: its live session's terminal when it
 * has one (every village element is one click from its terminal), otherwise the builder itself.
 */
export function builderTarget(builderId: string, sessions: SessionInfo[]): Selection {
  const live = liveSessionOf(builderId, sessions);
  return live ? { kind: 'session', id: live.id } : { kind: 'builder', id: builderId };
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

/** Ms from `now` until the next local midnight (at least 1). */
export function msToNextMidnight(now = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return Math.max(1, next - now.getTime());
}
