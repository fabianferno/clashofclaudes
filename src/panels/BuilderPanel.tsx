import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { AgentKind, Builder } from '../api/types';
import { liveSessionOf } from '../hud/hudState';
import { useApp } from '../state/store';
import { CLASS_NAMES, GEAR_NAMES, PALETTE, classOf, gearOf, stars } from '../village/look';

export default function BuilderPanel({ builderId }: { builderId: string }) {
  const b = useApp((s) => s.builders.find((x) => x.id === builderId));
  const sessions = useApp((s) => s.sessions);
  const agents = useApp((s) => s.agents);
  const [name, setName] = useState(b?.name ?? '');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (b) setName(b.name); }, [b?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!b) return null;

  const busy = !!liveSessionOf(b.id, Object.values(sessions));
  const info = agents.find((a) => a.kind === b.agent);
  const save = async (next: Builder) => {
    setErr(null);
    try {
      await ipc.updateBuilder(next);
      useApp.getState().updateBuilder(next);
    } catch (e) { setErr(String(e)); setName(b.name); }
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
      <label className="sp-field">Name
        <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename}
          onKeyDown={(e) => { if (e.key === 'Enter') rename(); }} />
      </label>
      <label className="sp-field">Agent
        <select aria-label="Agent" value={b.agent} onChange={(e) => changeAgent(e.target.value as AgentKind)}>
          {opts(agents.map((a) => a.kind), b.agent).map((k) => (
            <option key={k} value={k}>{agents.find((a) => a.kind === k)?.label ?? PALETTE[k as AgentKind].label}</option>
          ))}
        </select>
      </label>
      {(info?.models.length ?? 0) > 0 && (
        <label className="sp-field">Model
          <select aria-label="Model" value={b.model ?? ''} onChange={(e) => void save({ ...b, model: e.target.value || null })}>
            {opts(info!.models, b.model).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}
      {(info?.efforts.length ?? 0) > 0 && (
        <label className="sp-field">Effort
          <select aria-label="Effort" value={b.effort ?? ''} onChange={(e) => void save({ ...b, effort: e.target.value || null })}>
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
