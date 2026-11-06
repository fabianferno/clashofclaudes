import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ipc } from '../api/ipc';
import { useApp } from '../state/store';
import type { AgentInfo, AgentKind } from '../api/types';
import AgentLogo from './AgentLogo';

/** One way to install an agent; `label` introduces an alternative ("Or with Homebrew"). */
export type InstallOption = { cmd: string; label?: string };

/**
 * How to set each agent up: install, then sign in. Display only: the app never runs these.
 * The first install option is the vendor's recommended one; the rest are alternatives.
 * Sources: code.claude.com/docs (Claude Code), github.com/openai/codex (Codex),
 * antigravity.google/docs (Antigravity CLI), opencode.ai (OpenCode).
 */
export const SETUP: Partial<Record<AgentKind, { install?: InstallOption[]; installNote?: string; signIn?: string; signInNote?: string; note?: string }>> = {
  claude: {
    install: [
      { cmd: 'curl -fsSL https://claude.ai/install.sh | bash' },
      { label: 'Or with Homebrew:', cmd: 'brew install --cask claude-code' },
      { label: 'Or with npm (Node.js 22 or later):', cmd: 'npm i -g @anthropic-ai/claude-code' },
    ],
    signIn: 'claude',
    signInNote: 'Run it once in a terminal and follow the login.',
  },
  codex: {
    install: [
      { cmd: 'npm i -g @openai/codex' },
      { label: 'Or with Homebrew:', cmd: 'brew install --cask codex' },
    ],
    signIn: 'codex login',
  },
  opencode: { install: [{ cmd: 'npm i -g opencode-ai' }], signIn: 'opencode auth login' },
  antigravity: {
    install: [{ cmd: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' }],
    installNote: 'Puts agy in ~/.local/bin. More at antigravity.google/docs. It replaced Gemini CLI.',
    signIn: 'agy',
    signInNote: 'Run it once in a terminal and sign in with Google.',
  },
};

/** How long a Copy button reads "Copied". */
export const COPIED_MS = 2000;

/** The version without a repeat of the agent name ("2.1.0 (Claude Code)" → "2.1.0"). */
const version = (a: AgentInfo) => a.version?.replace(` (${a.label})`, '') ?? null;

/**
 * Setup steps for an agent that is not installed; its version and sign-in for one that is.
 * Rendered on <body>: opened from the side panel (its own stacking context) it must still cover the HUD.
 */
export default function AgentSetupDialog({ agent, onClose }: { agent: AgentInfo; onClose: () => void }) {
  const setAgents = useApp((s) => s.setAgents);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setup = SETUP[agent.kind];
  const titleId = `agent-dialog-${agent.kind}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(copiedTimer.current); };
  }, [onClose]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
    } catch (e) { useApp.getState().setError(String(e)); }
  };
  const recheck = async () => {
    setBusy(true);
    try { setAgents(await ipc.detectAgents(true)); setChecked(true); } catch (e) { useApp.getState().setError(String(e)); } finally { setBusy(false); }
  };
  const cmd = (text: string) => (
    <div className="agent-cmd">
      <code>{text}</code>
      <button type="button" className="hud-btn grey sm" onClick={() => void copy(text)}>{copied === text ? 'Copied' : 'Copy'}</button>
    </div>
  );

  return createPortal(
    <div className="modal-bg" onClick={onClose}>
      <div className="agent-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <header className="agent-dialog-head">
          <AgentLogo kind={agent.kind} size={48} />
          <div>
            <h3 id={titleId} className="ol">{agent.label}</h3>
            {agent.kind === 'custom'
              ? <span className="sp-d">Always available</span>
              : agent.installed
                ? <span className="sp-d agent-ok">Installed{version(agent) ? ` · ${version(agent)}` : ''}</span>
                : <span className="sp-d agent-missing">Not installed</span>}
          </div>
          <button type="button" className="agent-dialog-x" aria-label="Close" onClick={onClose}>×</button>
        </header>
        {agent.kind === 'custom' && (
          <p className="sp-d">Any command you like. Set it when you recruit a builder in + New session.</p>
        )}
        {agent.kind !== 'custom' && !agent.installed && setup && (
          <>
            <div className="sp-sec">1. Install</div>
            {setup.install?.map((o, i) => (
              <div key={o.cmd} className="agent-install-opt">
                {(o.label || i === 0) && <p className="sp-d">{o.label ?? 'Copy this into a terminal:'}</p>}
                {cmd(o.cmd)}
              </div>
            ))}
            {setup.installNote && <p className="sp-d">{setup.installNote}</p>}
            {setup.signIn && (
              <>
                <div className="sp-sec">2. Sign in</div>
                {setup.signInNote && <p className="sp-d">{setup.signInNote}</p>}
                {cmd(setup.signIn)}
              </>
            )}
            <div className="sp-sec">{setup.signIn ? '3' : '2'}. Check</div>
            <p className="sp-d">Then check again here.</p>
          </>
        )}
        {agent.kind !== 'custom' && agent.installed && setup?.signIn && (
          <>
            <p className="sp-d">Ready to recruit. If sessions ask you to log in, sign in once in a terminal:</p>
            {cmd(setup.signIn)}
          </>
        )}
        {setup?.note && <p className="sp-note agent-note">{setup.note}</p>}
        {checked && !agent.installed && agent.kind !== 'custom' && (
          <div className="panel-warn">Still not found. Open a new terminal after installing, then check again.</div>
        )}
        <div className="sp-btns">
          {agent.kind !== 'custom' && (
            <button type="button" className="hud-btn blue sm" disabled={busy} onClick={() => void recheck()}>{busy ? 'Checking…' : 'Check again'}</button>
          )}
          <button type="button" className="hud-btn grey sm" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
