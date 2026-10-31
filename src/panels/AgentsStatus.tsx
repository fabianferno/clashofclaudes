import { useEffect, useRef, useState } from 'react';
import { ipc } from '../api/ipc';
import { useApp } from '../state/store';
import type { AgentKind } from '../api/types';
import AgentLogo from './AgentLogo';

/** Copyable install commands. Display only: the app never runs them or touches the network. */
export const INSTALL_COMMANDS: Partial<Record<AgentKind, string>> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  opencode: 'npm i -g opencode-ai',
  gemini: 'npm i -g @google/gemini-cli',
};

/** How long a Copy button reads "Copied". */
export const COPIED_MS = 2000;

export const GEMINI_NOTE = 'Google moved Gemini consumer plans to Antigravity CLI — you can run it as a Custom command.';

/** Each agent as installed (with version) or "Not installed" plus its install command; Re-check re-detects. */
export default function AgentsStatus() {
  const agents = useApp((s) => s.agents);
  const setAgents = useApp((s) => s.setAgents);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<AgentKind | null>(null);

  const recheck = async () => {
    setBusy(true);
    try { setAgents(await ipc.detectAgents(true)); } catch (e) { useApp.getState().setError(String(e)); } finally { setBusy(false); }
  };
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const copy = async (kind: AgentKind, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
    } catch (e) { useApp.getState().setError(String(e)); }
  };

  return (
    <div className="agents-status" data-testid="agents-status">
      {agents.map((a) => {
        const cmd = INSTALL_COMMANDS[a.kind];
        return (
          <div key={a.kind} className="sp-box agent-row">
            <div className="agent-head">
              <span className="agent-name"><AgentLogo kind={a.kind} /><span className="sp-t">{a.label}</span></span>
              {a.kind === 'custom'
                ? <span className="sp-d">Custom: always available</span>
                : a.installed
                  ? <span className="sp-d agent-ok">Installed{a.version ? ` · ${a.version.replace(` (${a.label})`, '')}` : ''}</span>
                  : <span className="sp-d agent-missing">Not installed</span>}
            </div>
            {!a.installed && cmd && (
              <div className="agent-cmd">
                <code>{cmd}</code>
                <button type="button" className="hud-btn grey sm" onClick={() => void copy(a.kind, cmd)}>{copied === a.kind ? 'Copied' : 'Copy'}</button>
              </div>
            )}
            {a.kind === 'gemini' && <div className="sp-note agent-note">{GEMINI_NOTE}</div>}
          </div>
        );
      })}
      <button type="button" className="hud-btn blue sm" disabled={busy} onClick={() => void recheck()}>Re-check</button>
    </div>
  );
}
