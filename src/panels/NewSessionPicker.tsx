import { useState } from 'react';
import { ipc } from '../api/ipc';
import { idleBuilders, useApp } from '../state/store';
import type { AgentInfo, AgentKind, Builder } from '../api/types';
import { CLASS_NAMES, classOf } from '../village/look';
import BuilderPreview from './BuilderPreview';
import { modelPlaceholder } from './BuilderPanel';
import { EffortSlider, ModelSlider } from './Choosers';
import AgentPicker from './AgentPicker';

export const RECRUIT_NAMES = ['Ivy', 'Jax', 'Kai', 'Lu', 'Mo', 'Nia', 'Oz', 'Pip', 'Quin', 'Rex'];

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Display-only preview of the command that will be run, mirroring each adapter's arguments
 * (src-tauri/src/adapters). `…` stands for app-supplied arguments (hook settings, the shared-folder
 * note, the project path). Effort is shown only where the agent takes it.
 */
export function commandPreview(
  agent: AgentInfo, model?: string, effort?: string, task?: string, customCommand?: string,
): string {
  const t = task ? q(task) : '';
  const join = (parts: Array<string | false | undefined>) => parts.filter(Boolean).join(' ');
  switch (agent.kind) {
    case 'custom':
      return join([customCommand?.trim(), t]);
    case 'claude':
      return join(['claude …', model && `--model ${model}`, effort && `--effort ${effort}`, t && `-- ${t}`]);
    case 'codex':
      return join(['codex', model && `-m ${model}`, effort && `-c model_reasoning_effort=${q(effort)}`, '…', t && `-- ${t}`]);
    case 'opencode': {
      // Effort goes through OPENCODE_CONFIG_CONTENT, and only for a `provider/model`.
      const providerModel = !!model && /^[^/]+\/.+$/.test(model);
      return join([effort && providerModel && 'OPENCODE_CONFIG_CONTENT=…', 'opencode …', model && `--model=${model}`, t && `--prompt=${t}`]);
    }
    case 'antigravity':
      return join(['agy', model && `--model=${model}`, t && `--prompt-interactive=${t}`]);
  }
}

const RECRUIT = '__recruit__';
const DEFAULT = '';

function unusedName(builders: Builder[]): string {
  const used = new Set(builders.map((b) => b.name.toLowerCase()));
  return RECRUIT_NAMES.find((n) => !used.has(n.toLowerCase())) ?? '';
}

/** `builderId`: an idle builder to start with picked (one dropped on the workspace). */
export default function NewSessionPicker({ workspaceId, builderId }: { workspaceId: string; builderId?: string }) {
  const workspaces = useApp((s) => s.workspaces);
  const allBuilders = useApp((s) => s.builders);
  const sessions = useApp((s) => s.sessions);
  const agents = useApp((s) => s.agents);
  const idle = idleBuilders({ builders: allBuilders, sessions });
  const offered = agents.filter((a) => a.installed || a.kind === 'custom'); // selectable; the rest are shown disabled

  const [wsId, setWsId] = useState(workspaceId);
  const [picked, setPicked] = useState<string | null>(builderId ?? null);
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  // Derived until the user picks one: agents may be detected after the picker mounts.
  const [kindPick, setKind] = useState<AgentKind | null>(null);
  const kind: AgentKind = (kindPick && offered.some((a) => a.kind === kindPick) ? kindPick : null) ?? offered[0]?.kind ?? 'custom';
  const [model, setModel] = useState(DEFAULT);
  const [effort, setEffort] = useState(DEFAULT);
  const [command, setCommand] = useState('');
  const [task, setTask] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Recruit is the default when nobody is idle.
  const choice = picked !== null && (picked === RECRUIT || idle.some((b) => b.id === picked))
    ? picked : idle[0]?.id ?? RECRUIT;
  const recruiting = choice === RECRUIT;
  const name = nameEdit ?? unusedName(allBuilders);
  const existing = idle.find((b) => b.id === choice);
  const agent = agents.find((a) => a.kind === (recruiting ? kind : existing?.agent));
  const isCustom = agent?.kind === 'custom';
  const pModel = (recruiting ? model.trim() : existing?.model) || null;
  const pEffort = (recruiting ? effort : existing?.effort) || null;
  const pCmd = recruiting ? command : existing?.customCommand ?? '';
  const preview = agent ? commandPreview(agent, pModel ?? undefined, pEffort ?? undefined, task.trim() || undefined, pCmd) : '';

  async function start() {
    const st = useApp.getState();
    setError(null);
    let builderId = choice;
    try {
      if (recruiting) {
        if (!name.trim()) return setError('Name your builder');
        if (isCustom && !command.trim()) return setError('Enter the custom command');
        setBusy(true);
        // the new builder is a valid roster entry even if the start below fails
        const b = await ipc.createBuilder(name.trim(), kind, model.trim() || null, effort.trim() || null, isCustom ? command.trim() : null);
        st.addBuilder(b);
        setPicked(b.id);
        builderId = b.id;
      } else if (!existing) {
        return setError('Choose a builder');
      }
      setBusy(true);
      const s = await ipc.startSession(wsId, builderId, task.trim());
      st.upsertSession(s);
      // a spot failure must not strand a started session (a second Start would run a duplicate)
      try { await st.village.ensureSpot(s.id); } catch (e) { st.setError(String(e)); }
      st.setSelection({ kind: 'session', id: s.id });
    } catch (e) {
      st.setError(String(e));
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const tier = agent ? `${CLASS_NAMES[classOf(agent.kind, pModel)]}` : '';

  return (
    <form className="new-session" onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <label className="sp-field">Workspace
        <select value={wsId} onChange={(e) => setWsId(e.target.value)}>
          {workspaces.filter((w) => !w.missing).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
      <label className="sp-field">Task (optional)
        <textarea rows={3} value={task} onChange={(e) => setTask(e.target.value)} />
      </label>

      <div className="sp-sec">Builder</div>
      {idle.length > 0 && (
        <div className="picker-list" data-testid="idle-list">
          {idle.map((b) => (
            <button key={b.id} type="button" className={`sp-row${choice === b.id ? ' picked' : ''}`} onClick={() => setPicked(b.id)}>
              <span className="sp-rowtext">
                <span className="sp-t">{b.name}</span>
                <span className="sp-d">{CLASS_NAMES[classOf(b.agent, b.model)]} · {b.agent}</span>
              </span>
            </button>
          ))}
          <button type="button" className={`sp-row${recruiting ? ' picked' : ''}`} onClick={() => setPicked(RECRUIT)}>
            <span className="sp-t">Recruit new</span>
          </button>
        </div>
      )}
      {recruiting && (
        <>
          <label className="sp-field">Name <input value={name} onChange={(e) => setNameEdit(e.target.value)} /></label>
          <AgentPicker agents={agents} value={kind} installedOnly
            onChange={(k) => { setKind(k); setModel(DEFAULT); setEffort(DEFAULT); }} />
          {isCustom ? (
            <>
              <label className="sp-field">Model (optional) <input value={model} onChange={(e) => setModel(e.target.value)} /></label>
              <label className="sp-field">Effort (optional) <input value={effort} onChange={(e) => setEffort(e.target.value)} /></label>
              <label className="sp-field">Command <input value={command} onChange={(e) => setCommand(e.target.value)} /></label>
            </>
          ) : (
            <>
              {(agent?.models.length ?? 0) > 0
                ? <ModelSlider label="Model" options={agent!.models} value={model} onChange={setModel} />
                : (
                  <label className="sp-field">Model (optional)
                    <input value={model} placeholder={modelPlaceholder(kind)} onChange={(e) => setModel(e.target.value)} />
                  </label>
                )}
              {(agent?.efforts.length ?? 0) > 0 && <EffortSlider label="Effort" options={agent!.efforts} value={effort} onChange={setEffort} />}
            </>
          )}
        </>
      )}
      {agent && (
        <div className="picker-preview">
          <BuilderPreview agent={agent.kind} model={pModel} effort={pEffort} />
          <span className="sp-d">{tier}</span>
        </div>
      )}
      <code className="preview">{preview}</code>
      {error && <div className="panel-warn">{error}</div>}
      <button type="submit" className="hud-btn sm" disabled={busy}>Start</button>
    </form>
  );
}
