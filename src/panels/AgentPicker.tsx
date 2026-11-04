import type { AgentInfo, AgentKind } from '../api/types';
import AgentLogo from './AgentLogo';

/** A tile-sized name: no parenthetical and no trailing "CLI" ("Antigravity CLI" → "Antigravity"). */
export const shortAgentLabel = (a: Pick<AgentInfo, 'kind' | 'label'>) =>
  (a.kind === 'custom' ? 'Custom' : a.label.replace(/\s*\(.*\)$/, '').replace(/ CLI$/, ''));

/**
 * The agent as a row of app-icon buttons (a radio group, like the Town Hall's agents). With
 * `installedOnly`, agents that are not installed are greyed out and point to the Town Hall.
 * A disabled group (a fieldset) disables every button.
 */
export default function AgentPicker({ agents, value, onChange, disabled = false, installedOnly = false }: {
  agents: AgentInfo[]; value: AgentKind; onChange: (k: AgentKind) => void; disabled?: boolean; installedOnly?: boolean;
}) {
  return (
    <div className="sp-field">
      <span>Agent</span>
      <fieldset className="agent-pick" role="radiogroup" aria-label="Agent" disabled={disabled}>
        {agents.map((a) => {
          const ok = !installedOnly || a.installed || a.kind === 'custom';
          const on = a.kind === value;
          return (
            <button key={a.kind} type="button" role="radio" aria-checked={on} disabled={!ok}
              aria-label={ok ? a.label : `${a.label} — Not installed — see Town Hall`}
              title={ok ? a.label : `${a.label} is not installed: set it up in the Town Hall`}
              className={`agent-pick-btn${on ? ' on' : ''}`} onClick={() => onChange(a.kind)}>
              <span className="agent-pick-icon"><AgentLogo kind={a.kind} size={42} framed /></span>
              <span className="agent-pick-name">{shortAgentLabel(a)}</span>
              {on && <span className="agent-pick-badge ok" aria-hidden="true">✓</span>}
              {!ok && <span className="agent-pick-badge todo" aria-hidden="true">+</span>}
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}
