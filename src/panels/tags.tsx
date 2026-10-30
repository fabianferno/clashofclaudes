import type { SessionState } from '../api/types';
import { stateLabel } from '../state/store';

const COLOR: Record<SessionState['kind'], string> = {
  starting: 'var(--hud-working)', working: 'var(--hud-working)', needsYou: 'var(--hud-needs)',
  finished: 'var(--hud-finished)', stuck: 'var(--hud-stuck)', ended: '#8e8e8e',
};

export function StateTag({ state }: { state: SessionState }) {
  return <span className="sp-tag ol" style={{ background: COLOR[state.kind] }}>{stateLabel(state)}</span>;
}
