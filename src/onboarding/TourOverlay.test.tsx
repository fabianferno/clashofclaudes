import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  setSettings: vi.fn(async (s: unknown) => s),
  getSettings: vi.fn(),
  addWorkspace: vi.fn(),
}));
vi.mock('../api/ipc', () => ({ ipc }));
const dialog = vi.hoisted(() => ({ open: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-dialog', () => dialog);
const probe = vi.hoisted(() => ({ locate: vi.fn(() => null as null | { x: number; y: number; r: number }), fitVillage: vi.fn() }));
vi.mock('../village/probe', () => probe);
import { useApp } from '../state/store';
import { DEFAULT_SETTINGS } from '../state/settings';
import TourOverlay, { measure, placeCard } from './TourOverlay';
import { COACH_STEPS, endTour, goTo, startTour, useTour } from './tour';
import { DEMO_WS_ID, sandboxInstalled } from './demo';

const st = () => useApp.getState();

beforeEach(() => {
  ipc.setSettings.mockClear();
  dialog.open.mockClear();
  useApp.setState({ settings: { ...DEFAULT_SETTINGS }, workspaces: [], sessions: {}, builders: [], selection: null, panelOpen: false, error: null });
});
afterEach(async () => {
  cleanup();
  await act(async () => { await endTour(); });
});

describe('the welcome', () => {
  it('offers usage sharing, unticked, and saves the choice', async () => {
    act(() => startTour());
    render(<TourOverlay />);
    const share = screen.getByLabelText(/Share anonymous usage/) as HTMLInputElement;
    expect(share.checked).toBe(false);
    await act(async () => { fireEvent.click(share); });
    expect(ipc.setSettings).toHaveBeenCalledWith(expect.objectContaining({ shareUsage: true }));
  });

  it('asks for a name and shows the hall plate it will make', () => {
    act(() => startTour());
    render(<TourOverlay />);
    expect(screen.getByTestId('tour-welcome')).toBeTruthy();
    const start = screen.getByRole('button', { name: 'Start the tour' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true); // a name first
    expect(screen.getByTestId('tour-plate').textContent).toBe('Town Hall');
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '  Fabian ' } });
    expect(screen.getByTestId('tour-plate').textContent).toBe("Fabian's Town Hall");
    expect(start.disabled).toBe(false);
  });

  it('starting saves the name and walks to the Town Hall', async () => {
    act(() => startTour());
    render(<TourOverlay />);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Fabian' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start the tour' })); });
    expect(ipc.setSettings).toHaveBeenCalledWith(expect.objectContaining({ playerName: 'Fabian' }));
    expect(st().settings?.playerName).toBe('Fabian');
    expect(useTour.getState().step).toBe('hall');
    expect(screen.getByTestId('tour-card').dataset.step).toBe('hall');
    expect(screen.getByText(/Fabian's Town Hall/)).toBeTruthy();
  });

  it('skipping keeps a typed name, marks the welcome done and puts ipc back', async () => {
    act(() => startTour());
    expect(sandboxInstalled()).toBe(true);
    render(<TourOverlay />);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ada' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' })); });
    expect(useTour.getState().step).toBeNull();
    expect(st().settings).toMatchObject({ playerName: 'Ada', onboarded: true });
    expect(sandboxInstalled()).toBe(false);
    expect(screen.queryByTestId('tour-welcome')).toBeNull();
  });

  it('a replay starts with the saved name filled in', () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, playerName: 'Ada', onboarded: true } });
    act(() => startTour());
    render(<TourOverlay />);
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Ada');
  });
});

describe('the coach', () => {
  it('moves on by itself once the owner does what it asks', async () => {
    act(() => { startTour(); goTo('hall'); });
    render(<TourOverlay />);
    expect(screen.getByText('Click the Town Hall')).toBeTruthy();
    act(() => st().setSelection({ kind: 'hall' }));
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)); await new Promise((r) => requestAnimationFrame(r)); });
    expect(useTour.getState().step).toBe('hall-panel');
  });

  it('Do it for me does it', async () => {
    act(() => { startTour(); goTo('hall'); });
    render(<TourOverlay />);
    fireEvent.click(screen.getByRole('button', { name: 'Do it for me' }));
    expect(st().selection).toEqual({ kind: 'hall' });
  });

  it('raises the sample compound on request and turns to it', async () => {
    act(() => { startTour(); goTo('workspace'); });
    render(<TourOverlay />);
    fireEvent.click(screen.getByRole('button', { name: 'Raise the sample compound' }));
    expect(st().workspaces.map((w) => w.id)).toEqual([DEMO_WS_ID]);
    expect(st().zoomRequest?.id).toBe(DEMO_WS_ID);
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)); await new Promise((r) => requestAnimationFrame(r)); });
    expect(useTour.getState().step).toBe('open-workspace');
  });

  it('counts its steps and Next moves on', () => {
    act(() => { startTour(); goTo('resources'); });
    render(<TourOverlay />);
    const i = COACH_STEPS.findIndex((s) => s.id === 'resources');
    expect(screen.getByText(`Step ${i + 1} of ${COACH_STEPS.length}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(useTour.getState().step).toBe('roster');
  });

  it('offers to raise the sample again when it was removed', () => {
    act(() => { startTour(); goTo('terminal'); });
    render(<TourOverlay />);
    expect(screen.getByText('The sample is gone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Raise it again' }));
    expect(st().workspaces.some((w) => w.id === DEMO_WS_ID)).toBe(true);
    expect(useTour.getState().step).toBe('open-workspace');
  });

  it('Skip tour packs the sample up', async () => {
    act(() => { startTour(); goTo('workspace'); });
    render(<TourOverlay />);
    fireEvent.click(screen.getByRole('button', { name: 'Raise the sample compound' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Skip tour' })); });
    expect(st().workspaces).toEqual([]);
    expect(st().settings?.onboarded).toBe(true);
  });
});

describe('the send-off', () => {
  it('offers the first workspace when the owner has none', async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, playerName: 'Fabian' } });
    act(() => { startTour(); goTo('done'); });
    render(<TourOverlay />);
    expect(screen.getByText('You’re all set, Fabian!')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open my first workspace' })); });
    expect(useTour.getState().step).toBeNull();
    expect(dialog.open).toHaveBeenCalledWith({ directory: true });
  });

  it('just finishes for an owner who has workspaces', async () => {
    useApp.setState({ workspaces: [{ id: 'w1', name: 'mine', path: '/p', createdAt: 0, missing: false, level: 1, xp: 0, compound: null }] });
    act(() => { startTour(); goTo('done'); });
    render(<TourOverlay />);
    expect(screen.queryByRole('button', { name: 'Open my first workspace' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Finish' })); });
    expect(st().settings?.onboarded).toBe(true);
    expect(st().workspaces.map((w) => w.id)).toEqual(['w1']);
  });
});

describe('placing the card', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, round: false });
  it('goes beside a target, on the side with room, nearer the middle first', () => {
    expect(placeCard(box(100, 300, 80, 80), 340, 200, 1400, 900)).toEqual({ left: 198, top: 240 }); // right of a left-hand target
    expect(placeCard(box(1000, 0, 400, 900), 340, 200, 1400, 900)).toEqual({ left: 642, top: 350 }); // left of the side panel
  });
  it('goes above a full-width bar at the bottom', () => {
    expect(placeCard(box(0, 760, 1400, 120), 340, 200, 1400, 900)).toEqual({ left: 530, top: 542 });
  });
  it('without a target sits low on the left', () => {
    expect(placeCard(null, 340, 200, 1400, 900)).toEqual({ left: 20, top: 550 });
  });
});

describe('measuring a target', () => {
  it('rings a village thing round its centre, within sane sizes', () => {
    probe.locate.mockReturnValueOnce({ x: 500, y: 400, r: 10 });
    expect(measure({ kind: 'village', sel: { kind: 'hall' } })).toEqual({ x: 474, y: 374, w: 52, h: 52, round: true });
    probe.locate.mockReturnValueOnce(null);
    expect(measure({ kind: 'village', sel: { kind: 'hall' } })).toBeNull();
  });
  it('is nothing for a missing element', () => {
    expect(measure({ kind: 'dom', selector: '#nope' })).toBeNull();
    expect(measure(null)).toBeNull();
  });
});
