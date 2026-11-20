/**
 * The first-run tour: the welcome (the owner's name), then a walk through the real UI on the
 * sample compound (see demo.ts), then a send-off. Each step says what it points at, how it moves on
 * (a button, or by itself once the owner has done what it asks), and what "Do it for me" does.
 */
import { create } from 'zustand';
import { useApp, type Selection } from '../state/store';
import { saveSettings } from '../state/settings';
import * as probe from '../village/probe';
import { DEMO_WS_ID, clearDemo, demoAgentSession, demoWorkspace, installSandbox, raiseDemoWorkspace, uninstallSandbox } from './demo';

export type StepId =
  | 'welcome' | 'workspace' | 'new-session' | 'picker' | 'working' | 'needs' | 'wait-finish' | 'review' | 'kanban' | 'roster' | 'team'
  | 'done';

export type Target = { kind: 'dom'; selector: string } | { kind: 'village'; sel: Selection };

export interface StepSpec {
  id: StepId;
  /** A full-window card (the welcome and the send-off); the rest are coach cards beside their target. */
  modal?: boolean;
  /** What the step points at, if anything. */
  target?: () => Target | null;
  /** The step is over (checked every frame): the tour moves on by itself. */
  done?: () => boolean;
  /** Runs on arriving at the step: puts the village and panel where the step needs them. */
  enter?: () => void;
  /** "Do it for me": what the step asks the owner to do. */
  assist?: () => void;
  /** Shows a Next button (steps that only explain). */
  next?: boolean;
  /** The step is about the sample compound: without it the card offers to raise it again. */
  needsDemo?: boolean;
  /** A pause between two steps (the builder carrying on): it shows no step number of its own. */
  interlude?: boolean;
}

const app = () => useApp.getState();
const sel = (s: Selection | null) => app().setSelection(s);
const demoWs = (): Selection => ({ kind: 'workspace', id: DEMO_WS_ID });
const isSel = (s: Selection) => { const c = app().selection; return !!c && JSON.stringify(c) === JSON.stringify(s); };
const click = (selector: string) => (document.querySelector(selector) as HTMLElement | null)?.click();
const dom = (selector: string): Target => ({ kind: 'dom', selector });
const live = () => demoAgentSession();
const stateOf = () => live()?.state.kind;
/** The sample workspace's panel is showing its buttons (not the new-session form). */
const showWorkspace = () => { if (!isSel(demoWs())) sel(demoWs()); };
const showSession = () => { const s = live(); if (s && !isSel({ kind: 'session', id: s.id })) sel({ kind: 'session', id: s.id }); };

export const STEPS: StepSpec[] = [
  { id: 'welcome', modal: true },
  {
    id: 'workspace',
    enter: () => { sel(null); probe.fitVillage(); },
    target: () => dom('[data-testid="build-buttons"]'),
    done: () => !!demoWorkspace(),
    assist: () => raiseSample(),
  },
  {
    id: 'new-session', needsDemo: true,
    enter: () => { showWorkspace(); app().requestZoom(DEMO_WS_ID); },
    target: () => dom('[data-tour="new-session"]'),
    done: () => !!document.querySelector('form.new-session') || !!live(),
    assist: () => { showWorkspace(); requestAnimationFrame(() => click('[data-tour="new-session"]')); },
  },
  {
    id: 'picker', needsDemo: true,
    target: () => dom('form.new-session'),
    done: () => !!live(),
    assist: () => click('form.new-session button[type="submit"]'),
  },
  {
    id: 'working', needsDemo: true,
    enter: showSession,
    target: () => dom('.session-panel .terminal-wrap'),
    done: () => !live() || !['starting', 'working'].includes(stateOf()!),
  },
  {
    id: 'needs', needsDemo: true,
    enter: showSession,
    target: () => dom('.session-panel .brief'),
    done: () => stateOf() !== 'needsYou',
    assist: () => { showSession(); requestAnimationFrame(() => click('[data-tour="allow"]')); },
  },
  {
    id: 'wait-finish', needsDemo: true, interlude: true,
    target: () => { const s = live(); return s ? { kind: 'village', sel: { kind: 'session', id: s.id } } : null; },
    done: () => !live() || stateOf() === 'finished' || stateOf() === 'ended',
  },
  {
    id: 'review', needsDemo: true,
    enter: showSession,
    target: () => dom('.session-panel .brief'),
    done: () => !live(),
    assist: () => { showSession(); requestAnimationFrame(() => click('[data-tour="close-session"]')); },
  },
  {
    id: 'kanban', next: true, needsDemo: true,
    enter: () => { app().setKanban(null); showWorkspace(); },
    target: () => dom(app().kanban ? '.kanban' : '[data-tour="kanban"]'),
  },
  {
    id: 'roster', next: true,
    enter: () => { app().setKanban(null); sel(null); },
    target: () => dom('[data-testid="builders-bar"]'),
  },
  {
    id: 'team', next: true,
    enter: () => { app().setKanban(null); sel(null); },
    target: () => dom('[data-testid="settings-button"]'),
  },
  { id: 'done', modal: true, enter: () => { app().setKanban(null); sel(null); } },
];

/** The numbered steps of the progress bar: the coach cards, less the interludes. */
export const COACH_STEPS = STEPS.filter((s) => !s.modal && !s.interlude);
/** The number a step shows (1-based): an interlude shows the number of the step before it. */
export function stepNumber(id: StepId): number {
  const upTo = STEPS.slice(0, STEPS.findIndex((s) => s.id === id) + 1);
  return Math.max(1, upTo.filter((s) => !s.modal && !s.interlude).length);
}
export const specOf = (id: StepId): StepSpec => STEPS.find((s) => s.id === id)!;

interface TourState {
  /** The step on screen; null when no tour runs. */
  step: StepId | null;
}

export const useTour = create<TourState>(() => ({ step: null }));
export const tourActive = (): boolean => useTour.getState().step !== null;

/** Starts (or restarts) the tour at the welcome, over a clean village. */
export function startTour(): void {
  clearDemo();
  installSandbox();
  const st = app();
  st.setSettingsOpen(false);
  st.setKanban(null);
  st.setSelection(null);
  goTo('welcome');
}

export function goTo(id: StepId): void {
  useTour.setState({ step: id });
  specOf(id).enter?.();
}

/** On to the step after the one showing (the send-off ends at itself). */
export function nextStep(): void {
  const cur = useTour.getState().step;
  if (!cur) return;
  const i = STEPS.findIndex((s) => s.id === cur);
  goTo(STEPS[Math.min(i + 1, STEPS.length - 1)].id);
}

/** Raises the sample compound, opens its panel and turns the camera to it. */
export function raiseSample(): void {
  raiseDemoWorkspace();
  app().setSelection(demoWs());
  app().requestZoom(DEMO_WS_ID);
}

/**
 * Ends the tour, finished or skipped: the sample packs up, ipc goes straight to the backend again,
 * and the welcome is not shown again.
 */
export async function endTour(): Promise<void> {
  clearDemo();
  uninstallSandbox();
  useTour.setState({ step: null });
  try { await saveSettings({ onboarded: true }); } catch (e) { app().setError(String(e)); }
}
