import type { SessionInfo } from '../api/types';
import type { Entity } from './scene';

/** The bar over a structure (spec 5.3.2): its colour and text. */
/** `resource-<agent>`: a collector with plenty left, in its agent's resource colour. */
/** `house`: a workspace's name plate over its house. */
export type StatusTone = 'working' | 'needs' | 'stuck' | 'app' | 'resource-claude' | 'resource-codex' | 'resource-antigravity';

/** Elapsed time at minute granularity, so a label (and its texture) changes at most once a minute. */
export function elapsedLabel(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * What the bar over an agent's structure says, or null when it shows none (finished, ended, terminals).
 * Real data only: elapsed from `startedAt`, steps as reported in SessionInfo.
 */
export function statusOf(s: SessionInfo, now: number): { tone: StatusTone; label: string } | null {
  if (s.kind.kind !== 'agent') return null;
  switch (s.state.kind) {
    case 'starting':
    case 'working':
      return { tone: 'working', label: `${elapsedLabel(now - s.startedAt)} · ${s.steps} ${s.steps === 1 ? 'step' : 'steps'}` };
    case 'needsYou': return { tone: 'needs', label: 'Waiting for you' };
    case 'stuck': return { tone: 'stuck', label: 'Stuck' };
    default: return null;
  }
}

export function statusLabel(s: SessionInfo, now: number): string | null {
  return statusOf(s, now)?.label ?? null;
}

/** Texture key for the bar; null when there is none. Minute-quantized, so the shared cache stays bounded. */
export function statusKey(s: SessionInfo, now: number): string | null {
  const st = statusOf(s, now);
  return st ? `status:${st.tone}:${st.label}` : null;
}

/** World px from a structure's centre up to its bar's bottom (above the scaffold and the stuck smoke). */
export const STATUS_LIFT = 92;

/** The status bars a built entity list shows, as one comparable string. */
export function statusSignature(entities: readonly Entity[]): string {
  return entities.filter((e) => e.kind === 'status').map((e) => `${e.id}=${e.texKey}`).sort().join('|');
}

/**
 * The same signature as the bars over the structures in `entities` would have at `now`, plus the
 * bars in `extra` (already built for `now`, e.g. the collectors' labels) and the houses' and hall's name plates
 * (which change only with the state, itself a re-sync); a mismatch means re-sync.
 */
export function statusesDue(entities: readonly Entity[], sessions: readonly SessionInfo[], now: number, extra: readonly Entity[] = []): string {
  const shown = new Set(entities.filter((e) => e.kind === 'structure').map((e) => e.id));
  return sessions
    .filter((s) => shown.has(`struct:${s.id}`))
    .flatMap((s) => { const k = statusKey(s, now); return k ? [`status:${s.id}=${k}`] : []; })
    .concat(extra.filter((e) => e.kind === 'status').map((e) => `${e.id}=${e.texKey}`))
    .concat(entities.filter((e) => e.id.startsWith('status:house:') || e.id === 'status:hall').map((e) => `${e.id}=${e.texKey}`))
    .sort().join('|');
}
