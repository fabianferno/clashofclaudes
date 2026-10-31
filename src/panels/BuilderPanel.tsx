import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { AgentKind, Builder } from '../api/types';
import { liveSessionOf } from '../hud/hudState';
import { useApp } from '../state/store';
import { CLASS_NAMES, GEAR_NAMES, PALETTE, classOf, gearOf, stars } from '../village/look';

/** Placeholder for the free-text model field of an agent without a model list. */
export function modelPlaceholder(kind: AgentKind): string {
  return kind === 'opencode' ? 'provider/model' : 'model id';
}

export default function BuilderPanel({ builderId }: { builderId: string }) {
  const b = useApp((s) => s.builders.find((x) => x.id === builderId));
  const sessions = useApp((s) => s.sessions);
  const agents = useApp((s) => s.agents);
  const [name, setName] = useState(b?.name ?? '');
  const [modelText, setModelText] = useState(b?.model ?? '');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (b) setName(b.name); }, [b?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setModelText(b?.model ?? ''); }, [b?.model]);
  if (!b) return null;

  const live = liveSessionOf(b.id, Object.values(sessions));
  const busy = !!live;
  const info = agents.find((a) => a.kind === b.agent);
  const save = async (next: Builder) => {
    setErr(null);
    try {
      await ipc.updateBuilder(next);
      useApp.getState().updateBuilder(next);
    } catch (e) { setErr(String(e)); setName(b.name); setModelText(b.model ?? ''); }
  };
  const rename = () => {
    const n = name.trim();
    if (!n) { setName(b.name); return; }
    if (n !== b.name) void save({ ...b, name: n });
  };
  const changeAgent = (kind: AgentKind) => {
    const a = agents.find((x) => x.kind === kind);
    void save({ ...b, agent: kind, model: a?.models[0] ?? null, effort: a?.efforts[0] ?? null });
  };
  // Free-text model (an agent without a model list, e.g. Codex or OpenCode): empty means default.
  const saveModelText = () => {
    const m = modelText.trim() || null;
    if (m !== b.model) void save({ ...b, model: m });
    else setModelText(b.model ?? '');
  };
  const opts = (list: string[], cur: string | null) => (cur && !list.includes(cur) ? [cur, ...list] : list);
  const tier = classOf(b.agent, b.model);
  const gear = gearOf(b.effort);

  return (
    <>
      <div className="sp-box">
        <div className="sp-t">{CLASS_NAMES[tier]} · {GEAR_NAMES[gear]}</div>
        <div className="sp-d">{PALETTE[b.agent].label} · {b.model ?? 'default model'} · effort {b.effort ?? 'n/a'} {'★'.repeat(stars(gear))}</div>
      </div>
      {err && <div className="panel-warn">{err}</div>}
      {live && (
        <div className="sp-note" data-testid="builder-busy-note">
          {b.name} is in a session, so agent, model and effort are locked until it ends (they set up the session that is running).{' '}
          <button type="button" className="sp-link" onClick={() => useApp.getState().setSelection({ kind: 'session', id: live.id })}>Open session</button>
        </div>
      )}
      <label className="sp-field">Name
        <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename}
          onKeyDown={(e) => { if (e.key === 'Enter') rename(); }} />
      </label>
      <label className="sp-field">Agent
        <select aria-label="Agent" value={b.agent} disabled={busy} onChange={(e) => changeAgent(e.target.value as AgentKind)}>
          {opts(agents.map((a) => a.kind), b.agent).map((k) => (
            <option key={k} value={k}>{agents.find((a) => a.kind === k)?.label ?? PALETTE[k as AgentKind].label}</option>
          ))}
        </select>
      </label>
      {(info?.models.length ?? 0) > 0 && (
        <label className="sp-field">Model
          <select aria-label="Model" value={b.model ?? ''} disabled={busy} onChange={(e) => void save({ ...b, model: e.target.value || null })}>
            <option value="">Default</option>
            {opts(info!.models, b.model).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}
      {info && info.models.length === 0 && b.agent !== 'custom' && (
        <label className="sp-field">Model
          <input aria-label="Model" value={modelText} placeholder={modelPlaceholder(b.agent)} disabled={busy}
            onChange={(e) => setModelText(e.target.value)} onBlur={saveModelText}
            onKeyDown={(e) => { if (e.key === 'Enter') saveModelText(); }} />
        </label>
      )}
      {(info?.efforts.length ?? 0) > 0 && (
        <label className="sp-field">Effort
          <select aria-label="Effort" value={b.effort ?? ''} disabled={busy} onChange={(e) => void save({ ...b, effort: e.target.value || null })}>
            <option value="">Default</option>
            {opts(info!.efforts, b.effort).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}
      <div className="sp-sec">Danger zone</div>
      {busy && <div className="sp-note">{b.name} is in a session. Close the session first to dismiss this builder.</div>}
      <div className="sp-btns">
        <button className="hud-btn red sm" disabled={busy}
          title={busy ? `${b.name} is in a session; close it first` : undefined}
          onClick={async () => {
            setErr(null);
            try {
              await ipc.deleteBuilder(b.id);
              useApp.getState().removeBuilder(b.id);
              useApp.getState().setSelection(null);
            } catch (e) { setErr(String(e)); }
          }}>Dismiss</button>
      </div>
    </>
  );
}
