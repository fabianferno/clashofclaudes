import { useState } from 'react';
import { ipc } from '../api/ipc';
import type { AgentInfo, AgentKind, Builder, SessionInfo } from '../api/types';

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Display-only preview of the command that will be run. */
export function commandPreview(
  agent: AgentInfo, model?: string, effort?: string, task?: string, customCommand?: string,
): string {
  if (agent.kind === 'custom') {
    return [customCommand?.trim() ?? '', task ? q(task) : ''].filter(Boolean).join(' ');
  }
  const parts: string[] = [agent.kind];
  if (agent.kind === 'claude') parts.push('…');
  if (model) parts.push('--model', model);
  if (effort) parts.push('--effort', effort);
  if (task) parts.push(q(task));
  return parts.join(' ');
}

interface Props {
  workspaceId: string;
  agents: AgentInfo[];
  builders: Builder[]; // idle builders
  onStarted: (s: SessionInfo) => void;
}

const RECRUIT = '__recruit__';
const DEFAULT = '';

export default function NewSessionForm({ workspaceId, agents, builders, onStarted }: Props) {
  const offered = agents.filter((a) => a.installed || a.kind === 'custom');
  const [choice, setChoice] = useState(builders[0]?.id ?? RECRUIT);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AgentKind>(offered[0]?.kind ?? 'custom');
  const [model, setModel] = useState(DEFAULT);
  const [effort, setEffort] = useState(DEFAULT);
  const [command, setCommand] = useState('');
  const [task, setTask] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const recruiting = choice === RECRUIT;
  const existing = builders.find((b) => b.id === choice);
  const agent = agents.find((a) => a.kind === (recruiting ? kind : existing?.agent));
  const isCustom = agent?.kind === 'custom';
  const pModel = recruiting ? model : existing?.model ?? '';
  const pEffort = recruiting ? effort : existing?.effort ?? '';
  const pCmd = recruiting ? command : existing?.customCommand ?? '';
  const preview = agent ? commandPreview(agent, pModel || undefined, pEffort || undefined, task.trim() || undefined, pCmd) : '';

  async function start() {
    setError(null);
    try {
      let builderId = choice;
      if (recruiting) {
        if (!name.trim()) return setError('Name your builder');
        if (isCustom && !command.trim()) return setError('Enter the custom command');
        setBusy(true);
        const b = await ipc.createBuilder(
          name.trim(), kind, model.trim() || null, effort.trim() || null, isCustom ? command.trim() : null,
        );
        builderId = b.id;
      } else if (!existing) {
        return setError('Choose a builder');
      }
      setBusy(true);
      onStarted(await ipc.startSession(workspaceId, builderId, task.trim()));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const select = (list: string[], value: string, set: (v: string) => void, label: string) => (
    <label>{label}
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value={DEFAULT}>default</option>
        {list.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </label>
  );

  return (
    <form className="new-session" onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <h3>New session</h3>
      <label>Builder
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          {builders.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          <option value={RECRUIT}>Recruit new</option>
        </select>
      </label>
      {recruiting && (
        <>
          <label>Name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>Agent
            <select value={kind} onChange={(e) => { setKind(e.target.value as AgentKind); setModel(DEFAULT); setEffort(DEFAULT); }}>
              {offered.map((a) => <option key={a.kind} value={a.kind}>{a.label}</option>)}
            </select>
          </label>
          {isCustom ? (
            <>
              <label>Model (optional) <input value={model} onChange={(e) => setModel(e.target.value)} /></label>
              <label>Effort (optional) <input value={effort} onChange={(e) => setEffort(e.target.value)} /></label>
              <label>Command <input value={command} onChange={(e) => setCommand(e.target.value)} /></label>
            </>
          ) : (
            <>
              {select(agent?.models ?? [], model, setModel, 'Model')}
              {select(agent?.efforts ?? [], effort, setEffort, 'Effort')}
            </>
          )}
        </>
      )}
      <label>Task <textarea rows={3} value={task} onChange={(e) => setTask(e.target.value)} /></label>
      <code className="preview">{preview}</code>
      {error && <div className="error">{error}</div>}
      <button type="submit" disabled={busy}>Start</button>
    </form>
  );
}
