import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../state/store';
import { PLAYER_NAME_MAX, cleanName, saveSettings, townHallTitle } from '../state/settings';
import * as wsActions from '../state/workspaceActions';
import * as probe from '../village/probe';
import { DEMO_WS_ID, demoAgentSession, isDemoId } from './demo';
import { copyOf } from './steps';
import { COACH_STEPS, endTour, goTo, nextStep, raiseSample, specOf, useTour, type StepSpec, type Target } from './tour';
import './onboarding.css';

/** The tour on screen: the welcome, a coach card by what it points at, or the send-off. */
export default function TourOverlay() {
  const step = useTour((s) => s.step);
  if (!step) return null;
  if (step === 'welcome') return <Welcome />;
  if (step === 'done') return <SendOff />;
  return <Coach key={step} spec={specOf(step)} />;
}

const saveName = (name: string | null) => saveSettings({ playerName: name }).catch((e) => useApp.getState().setError(String(e)));

function Welcome() {
  const saved = useApp((s) => s.settings?.playerName ?? null);
  const [draft, setDraft] = useState(saved ?? '');
  const name = cleanName(draft);
  const start = (e: FormEvent) => {
    e.preventDefault();
    if (!name) return;
    void saveName(name); // the store, and so the hall's plate, has it at once
    goTo('hall');
  };
  const skip = () => {
    if (name && name !== saved) void saveName(name);
    void endTour();
  };
  return (
    <div className="tour-modal-bg">
      <form className="tour-modal" role="dialog" aria-modal="true" aria-labelledby="tour-welcome-title" onSubmit={start} data-testid="tour-welcome">
        <img className="tour-crest" src="/icon.png" alt="" />
        <h2 id="tour-welcome-title" className="ol">Welcome to Clash of Claudes</h2>
        <p className="tour-lede">Your coding agents are builders. Your projects are compounds. You run the village.</p>
        <label className="tour-name">
          <span>First, what should we call you?</span>
          <input autoFocus aria-label="Your name" placeholder="Your name" maxLength={PLAYER_NAME_MAX} spellCheck={false} autoComplete="off"
            value={draft} onChange={(e) => setDraft(e.target.value)} />
        </label>
        <div className="tour-plate-row" aria-live="polite">
          <span className="tour-plate-hint">Your hall will read</span>
          <span className="tour-plate" data-testid="tour-plate">{townHallTitle(name)}</span>
        </div>
        <div className="tour-btns">
          <button type="button" className="tour-skip" onClick={skip}>Skip the tour</button>
          <button type="submit" className="hud-btn green" disabled={!name}>Start the tour</button>
        </div>
        <p className="tour-fine">About two minutes. Everything in it is a sample: no files change and no agents run.</p>
      </form>
    </div>
  );
}

function SendOff() {
  const name = useApp((s) => cleanName(s.settings?.playerName));
  const hasOwn = useApp((s) => s.workspaces.some((w) => !isDemoId(w.id)));
  const openFirst = async () => { await endTour(); await wsActions.openFolder(); };
  return (
    <div className="tour-modal-bg">
      <div className="tour-modal" role="dialog" aria-modal="true" aria-labelledby="tour-done-title" data-testid="tour-done">
        <img className="tour-crest" src="/icon.png" alt="" />
        <h2 id="tour-done-title" className="ol">{name ? `You’re all set, ${name}!` : 'You’re all set!'}</h2>
        <p className="tour-lede">The sample compound packs up when you finish. The loop, in short:</p>
        <ol className="tour-recap">
          <li><span><b>Open</b> or <b>Build</b> a workspace and it becomes a compound.</span></li>
          <li><span><b>+ New session</b> puts a builder to work in it.</span></li>
          <li><span>A red <b>!</b> means a builder needs you.</span></li>
          <li><span><b>Review</b>, then <b>Close</b> finished work for XP.</span></li>
        </ol>
        <div className="tour-btns">
          {hasOwn
            ? <button className="hud-btn green" autoFocus onClick={() => void endTour()}>Finish</button>
            : (
              <>
                <button className="tour-skip" onClick={() => void endTour()}>Finish</button>
                <button className="hud-btn green" autoFocus onClick={() => void openFirst()}>Open my first workspace</button>
              </>
            )}
        </div>
      </div>
    </div>
  );
}

interface Spot { x: number; y: number; w: number; h: number; round: boolean }

/** Where the target is in the window; null when it is not on screen. */
export function measure(t: Target | null): Spot | null {
  if (!t) return null;
  if (t.kind === 'village') {
    const p = probe.locate(t.sel);
    if (!p) return null;
    const r = Math.max(26, Math.min(p.r, 220));
    return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r, round: true };
  }
  const el = document.querySelector(t.selector);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return b.width > 0 && b.height > 0 ? { x: b.left, y: b.top, w: b.width, h: b.height, round: false } : null;
}

const MARGIN = 16, GAP = 18;

/** Top-left of a `w`×`h` card beside `r` (the side with room, nearer the middle first), in a `vw`×`vh` window. */
export function placeCard(r: Spot | null, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, vw - w - MARGIN));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(y, vh - h - MARGIN));
  // nothing to point at: low on the left, clear of the roster
  if (!r) return { left: MARGIN + 4, top: clampY(vh - h - 150) };
  const midY = clampY(r.y + r.h / 2 - h / 2), midX = clampX(r.x + r.w / 2 - w / 2);
  const left = { left: r.x - GAP - w, top: midY, ok: r.x - GAP - w >= MARGIN };
  const right = { left: r.x + r.w + GAP, top: midY, ok: r.x + r.w + GAP + w <= vw - MARGIN };
  const below = { left: midX, top: r.y + r.h + GAP, ok: r.y + r.h + GAP + h <= vh - MARGIN };
  const above = { left: midX, top: r.y - GAP - h, ok: r.y - GAP - h >= MARGIN };
  const order = r.x + r.w / 2 > vw / 2 ? [left, below, above, right] : [right, below, above, left];
  const pick = order.find((o) => o.ok);
  return pick ? { left: pick.left, top: pick.top } : { left: MARGIN + 4, top: clampY(vh - h - 150) };
}

function Coach({ spec }: { spec: StepSpec }) {
  const name = useApp((s) => s.settings?.playerName ?? null);
  const session = useApp(() => demoAgentSession());
  const sample = useApp((s) => s.workspaces.find((w) => w.id === DEMO_WS_ID));
  const builder = useApp((s) => {
    const k = session?.kind;
    return k?.kind === 'agent' ? s.builders.find((b) => b.id === k.builderId)?.name : undefined;
  });
  const [spot, setSpot] = useState<Spot | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Every frame: has the owner done what the step asks, and where is its target now? Store changes
  // check too, as frames pause while the window is in the background. Each step moves on once.
  useEffect(() => {
    let raf = 0, last = '', moved = false;
    const advance = () => {
      if (moved || useTour.getState().step !== spec.id || !spec.done?.()) return false;
      moved = true;
      nextStep();
      return true;
    };
    const tick = () => {
      if (advance()) return;
      const s = measure(spec.target?.() ?? null);
      const key = s ? `${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.w)},${Math.round(s.h)}` : '';
      if (key !== last) { last = key; setSpot(s); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const unsub = useApp.subscribe(() => { advance(); });
    return () => { cancelAnimationFrame(raf); unsub(); };
  }, [spec]);

  const lost = spec.needsDemo && !sample;
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    setPos(placeCard(lost ? null : spot, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight));
  }, [spot, lost, session?.state.kind, builder]);
  useEffect(() => {
    const onResize = () => { const el = card.current; if (el) setPos(placeCard(spot, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight)); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [spot]);

  const index = COACH_STEPS.findIndex((s) => s.id === spec.id);
  const copy = copyOf(spec.id, { hall: name ? townHallTitle(name) : 'your Town Hall', name, builder: builder ?? 'Your builder', session, sample });
  const style = pos ? { left: pos.left, top: pos.top } : { left: MARGIN, top: MARGIN, visibility: 'hidden' as const };

  return (
    <>
      {spot && !lost && (
        <div className={`tour-spot${spot.round ? ' round' : ''}`} aria-hidden="true"
          style={{ left: spot.x - 6, top: spot.y - 6, width: spot.w + 12, height: spot.h + 12 }} />
      )}
      <div ref={card} className="tour-card" role="dialog" aria-labelledby="tour-card-title" aria-describedby="tour-card-body" style={style} data-testid="tour-card" data-step={spec.id}>
        <div className="tour-progress" aria-label={`Step ${index + 1} of ${COACH_STEPS.length}`}>
          <span>Step {index + 1} of {COACH_STEPS.length}</span>
          <i><b style={{ width: `${((index + 1) / COACH_STEPS.length) * 100}%` }} /></i>
        </div>
        {lost ? (
          <>
            <h3 id="tour-card-title" className="ol">The sample is gone</h3>
            <p id="tour-card-body">The sample compound was removed. Raise it again to carry on, or end the tour here.</p>
            <div className="tour-btns">
              <button className="tour-skip" onClick={() => void endTour()}>End tour</button>
              <button className="hud-btn green sm" onClick={() => { raiseSample(); goTo('open-workspace'); }}>Raise it again</button>
            </div>
          </>
        ) : (
          <>
            <h3 id="tour-card-title" className="ol">{copy.title}</h3>
            <p id="tour-card-body">{copy.body}</p>
            {copy.waiting && (
              <div className="tour-wait" role="status"><i className="tour-pulse" aria-hidden="true" />{copy.waiting}</div>
            )}
            <div className="tour-btns">
              <button className="tour-skip" onClick={() => void endTour()}>Skip tour</button>
              {spec.assist && !copy.action && copy.waiting && (
                <button className="hud-btn grey sm" onClick={spec.assist}>Do it for me</button>
              )}
              {spec.assist && copy.action && <button className="hud-btn green sm" onClick={spec.assist}>{copy.action}</button>}
              {spec.next && <button className="hud-btn green sm" autoFocus onClick={nextStep}>Next</button>}
            </div>
          </>
        )}
      </div>
    </>
  );
}
