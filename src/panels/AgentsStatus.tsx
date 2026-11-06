import { useState } from 'react';
import { useApp } from '../state/store';
import type { AgentInfo, AgentKind } from '../api/types';
import AgentLogo from './AgentLogo';
import { shortAgentLabel } from './AgentPicker';
import AgentSetupDialog from './AgentSetupDialog';

export { COPIED_MS, SETUP } from './AgentSetupDialog';

const shortLabel = shortAgentLabel;
const ready = (a: AgentInfo) => a.kind === 'custom' || a.installed;

/** Each agent as an app icon; a click opens its setup (or details) dialog. */
export default function AgentsStatus() {
  const agents = useApp((s) => s.agents);
  const [open, setOpen] = useState<AgentKind | null>(null);
  const shown = agents.find((a) => a.kind === open);

  return (
    <div className="agents-status" data-testid="agents-status">
      <div className="agents-grid">
        {agents.map((a) => (
          <button key={a.kind} type="button" className={`agent-tile${ready(a) ? '' : ' off'}`} data-testid={`agent-tile-${a.kind}`}
            aria-label={`${shortLabel(a)}: ${ready(a) ? 'ready' : 'not set up'}`} onClick={() => setOpen(a.kind)}>
            <span className="agent-icon">
              <AgentLogo kind={a.kind} />
              <span className={`agent-badge ${ready(a) ? 'ok' : 'todo'}`} aria-hidden="true">{ready(a) ? '✓' : '+'}</span>
            </span>
            <span className="agent-tile-label">{shortLabel(a)}</span>
          </button>
        ))}
      </div>
      {shown && <AgentSetupDialog agent={shown} onClose={() => setOpen(null)} />}
    </div>
  );
}
