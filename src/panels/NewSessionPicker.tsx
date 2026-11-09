import { useRef, useState } from 'react';
import { ipc } from '../api/ipc';
import { idleBuilders, useApp } from '../state/store';
import type { AgentKind, Builder } from '../api/types';
import { CLASS_NAMES, classOf } from '../village/look';
import BuilderAvatar from '../hud/BuilderAvatar';
import BuilderPreview from './BuilderPreview';
import { modelPlaceholder } from './BuilderPanel';
import { EffortSlider, ModelSlider, effortsFor, modelNames } from './Choosers';
import AgentPicker from './AgentPicker';
import { AttachmentStrip, useAttachments } from './Attachments';
import { DEMO_TASK, createDemoBuilder, isDemoId } from '../onboarding/demo';

export const RECRUIT_NAMES = ['Ivy', 'Jax', 'Kai', 'Lu', 'Mo', 'Nia', 'Oz', 'Pip', 'Quin', 'Rex'];

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
  const [wsId, setWsId] = useState(workspaceId);
  // The tour's sample compound: any agent may be tried (nothing runs), its builders stay in it,
  // and the workspace list keeps the sample and the owner's own apart.
  const sample = isDemoId(wsId);
  const idle = idleBuilders({ builders: allBuilders, sessions }).filter((b) => sample || !isDemoId(b.id));
  const offered = sample ? agents : agents.filter((a) => a.installed || a.kind === 'custom'); // selectable; the rest are shown disabled

  const [picked, setPicked] = useState<string | null>(builderId ?? null);
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  // Derived until the user picks one: agents may be detected after the picker mounts.
  const [kindPick, setKind] = useState<AgentKind | null>(null);
  const kind: AgentKind = (kindPick && offered.some((a) => a.kind === kindPick) ? kindPick : null) ?? offered[0]?.kind ?? 'custom';
  const [model, setModel] = useState(DEFAULT);
  const [effort, setEffort] = useState(DEFAULT);
  const [command, setCommand] = useState('');
  const [task, setTask] = useState('');
  const taskField = useRef<HTMLLabelElement>(null);
  const att = useAttachments(taskField);
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
        const create = sample ? createDemoBuilder : ipc.createBuilder;
        const b = await create(name.trim(), kind, model.trim() || null, effort.trim() || null, isCustom ? command.trim() : null);
        st.addBuilder(b);
        setPicked(b.id);
        builderId = b.id;
      } else if (!existing) {
        return setError('Choose a builder');
      }
      setBusy(true);
      const s = await ipc.startSession(wsId, builderId, task.trim(), att.names);
      att.clear(); // the session has them now
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
          {workspaces.filter((w) => !w.missing && isDemoId(w.id) === sample).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
      <label className="sp-field" ref={taskField}>Task (optional)
        <textarea rows={3} value={task} placeholder={sample ? `Try: ${DEMO_TASK}` : 'Paste or drop images here too'}
          onChange={(e) => setTask(e.target.value)} onPaste={att.onPaste} />
      </label>
      <AttachmentStrip names={att.names} onRemove={att.remove} />

      <div className="sp-sec">Builder</div>
      {idle.length > 0 && (
        <div className="picker-list" data-testid="idle-list">
          {idle.map((b) => (
            <button key={b.id} type="button" className={`sp-row${choice === b.id ? ' picked' : ''}`} onClick={() => setPicked(b.id)}>
              <span className="hud-av sp-row-av"><BuilderAvatar agent={b.agent} model={b.model} effort={b.effort} size={38} /></span>
              <span className="sp-rowtext">
                <span className="sp-t">{b.name}</span>
                <span className="sp-d">{CLASS_NAMES[classOf(b.agent, b.model)]} · {b.agent}</span>
              </span>
            </button>
          ))}
          <button type="button" className={`sp-row${recruiting ? ' picked' : ''}`} onClick={() => setPicked(RECRUIT)}>
            <span className="hud-av sp-row-av sp-row-new" aria-hidden="true">+</span>
            <span className="sp-t">Recruit new</span>
          </button>
        </div>
      )}
      {recruiting && (
        <>
          <label className="sp-field">Name <input value={name} onChange={(e) => setNameEdit(e.target.value)} /></label>
          <AgentPicker agents={agents} value={kind} installedOnly={!sample}
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
                ? <ModelSlider label="Model" options={agent!.models} names={modelNames(agent)} value={model}
                    onChange={(m) => { setModel(m); if (effort && !effortsFor(agent, m).includes(effort)) setEffort(DEFAULT); }} />
                : (
                  <label className="sp-field">Model (optional)
                    <input value={model} placeholder={modelPlaceholder(kind)} onChange={(e) => setModel(e.target.value)} />
                  </label>
                )}
              {effortsFor(agent, model).length > 0 && <EffortSlider label="Effort" options={effortsFor(agent, model)} value={effort} onChange={setEffort} />}
            </>
          )}
        </>
      )}
      {/* existing builders show their portrait in the list; a recruit's follows the choices above */}
      {agent && recruiting && (
        <div className="picker-preview">
          <BuilderPreview agent={agent.kind} model={pModel} effort={pEffort} />
          <span className="sp-d">{tier}</span>
        </div>
      )}
      {error && <div className="panel-warn">{error}</div>}
      <button type="submit" className="hud-btn sm" disabled={busy || att.saving}>Start</button>
    </form>
  );
}
