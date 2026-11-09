import { useState } from 'react';
import type { AgentInfo, AgentKind } from '../api/types';
import AgentLogo from './AgentLogo';
import AgentSetupDialog from './AgentSetupDialog';

/** A tile-sized name: no parenthetical and no trailing "CLI" ("Antigravity CLI" → "Antigravity"). */
export const shortAgentLabel = (a: Pick<AgentInfo, 'kind' | 'label'>) =>
  (a.kind === 'custom' ? 'Custom' : a.label.replace(/\s*\(.*\)$/, '').replace(/ CLI$/, ''));

/**
 * One agent as a chunky app-icon button, the same in the Town Hall and the new-session form:
 * gold when `on`, greyed out when `missing`; the badge is a ✓ or a + (set it up).
 */
export function AgentButton({ agent, on = false, missing = false, badge, onClick, ...rest }: {
  agent: Pick<AgentInfo, 'kind' | 'label'>; on?: boolean; missing?: boolean; badge?: 'ok' | 'todo'; onClick: () => void;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'type'>) {
  return (
    <button type="button" className={`agent-pick-btn${on ? ' on' : ''}${missing ? ' missing' : ''}`} onClick={onClick} {...rest}>
      <span className="agent-pick-icon"><AgentLogo kind={agent.kind} size={42} framed /></span>
      <span className="agent-pick-name">{shortAgentLabel(agent)}</span>
      {badge && <span className={`agent-pick-badge ${badge}`} aria-hidden="true">{badge === 'ok' ? '✓' : '+'}</span>}
    </button>
  );
}

/**
 * The agent as a row of app-icon buttons (a radio group, like the Town Hall's agents). With
 * `installedOnly`, agents that are not installed are greyed out and cannot be picked; a click
 * opens their install steps instead (the same dialog as the Town Hall's).
 * A disabled group (a fieldset) disables every button.
 */
export default function AgentPicker({ agents, value, onChange, disabled = false, installedOnly = false }: {
  agents: AgentInfo[]; value: AgentKind; onChange: (k: AgentKind) => void; disabled?: boolean; installedOnly?: boolean;
}) {
  const [setupFor, setSetupFor] = useState<AgentKind | null>(null);
  const setupAgent = agents.find((a) => a.kind === setupFor);
  return (
    <div className="sp-field">
      <span>Agent</span>
      <fieldset className="agent-pick" role="radiogroup" aria-label="Agent" disabled={disabled}>
        {agents.map((a) => {
          const ok = !installedOnly || a.installed || a.kind === 'custom';
          const on = a.kind === value;
          return (
            <AgentButton key={a.kind} agent={a} on={on} missing={!ok} badge={!ok ? 'todo' : on ? 'ok' : undefined}
              role="radio" aria-checked={on} aria-disabled={!ok || undefined}
              aria-label={ok ? a.label : `${a.label} — Not installed — how to install`}
              title={ok ? a.label : `${a.label} is not installed: click for how to install it`}
              onClick={() => (ok ? onChange(a.kind) : setSetupFor(a.kind))} />
          );
        })}
      </fieldset>
      {setupAgent && <AgentSetupDialog agent={setupAgent} onClose={() => setSetupFor(null)} />}
    </div>
  );
}
