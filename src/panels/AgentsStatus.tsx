import { useState } from 'react';
import { useApp } from '../state/store';
import type { AgentInfo, AgentKind } from '../api/types';
import { AgentButton, shortAgentLabel } from './AgentPicker';
import AgentSetupDialog from './AgentSetupDialog';

export { COPIED_MS, SETUP } from './AgentSetupDialog';

const shortLabel = shortAgentLabel;
const ready = (a: AgentInfo) => a.kind === 'custom' || a.installed;

/** Each agent as the new-session form's button (✓ set up, + not yet); a click opens its setup (or details) dialog. */
export default function AgentsStatus() {
  const agents = useApp((s) => s.agents);
  const [open, setOpen] = useState<AgentKind | null>(null);
  const shown = agents.find((a) => a.kind === open);

  return (
    <div className="agents-status" data-testid="agents-status">
      <div className="agent-pick">
        {agents.map((a) => (
          <AgentButton key={a.kind} agent={a} missing={!ready(a)} badge={ready(a) ? 'ok' : 'todo'} data-testid={`agent-tile-${a.kind}`}
            aria-label={`${shortLabel(a)}: ${ready(a) ? 'ready' : 'not set up'}`} title={ready(a) ? a.label : `${a.label} is not installed: click for how to install it`}
            onClick={() => setOpen(a.kind)} />
        ))}
      </div>
      {shown && <AgentSetupDialog agent={shown} onClose={() => setOpen(null)} />}
    </div>
  );
}
