import { useState } from 'react';
import type { AgentInfo, AgentKind } from '../api/types';
import AgentLogo from './AgentLogo';
import AgentSetupDialog from './AgentSetupDialog';

/** A tile-sized name: no parenthetical and no trailing "CLI" ("Antigravity CLI" → "Antigravity"). */
export const shortAgentLabel = (a: Pick<AgentInfo, 'kind' | 'label'>) =>
  (a.kind === 'custom' ? 'Custom' : a.label.replace(/\s*\(.*\)$/, '').replace(/ CLI$/, ''));

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
            <button key={a.kind} type="button" role="radio" aria-checked={on} aria-disabled={!ok || undefined}
              aria-label={ok ? a.label : `${a.label} — Not installed — how to install`}
              title={ok ? a.label : `${a.label} is not installed: click for how to install it`}
              className={`agent-pick-btn${on ? ' on' : ''}${ok ? '' : ' missing'}`}
              onClick={() => (ok ? onChange(a.kind) : setSetupFor(a.kind))}>
              <span className="agent-pick-icon"><AgentLogo kind={a.kind} size={42} framed /></span>
              <span className="agent-pick-name">{shortAgentLabel(a)}</span>
              {on && <span className="agent-pick-badge ok" aria-hidden="true">✓</span>}
              {!ok && <span className="agent-pick-badge todo" aria-hidden="true">+</span>}
            </button>
          );
        })}
      </fieldset>
      {setupAgent && <AgentSetupDialog agent={setupAgent} onClose={() => setSetupFor(null)} />}
    </div>
  );
}
