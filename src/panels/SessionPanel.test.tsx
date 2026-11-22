import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { SessionInfo, SessionState } from '../api/types';

const approve = vi.fn();
const reviewSession = vi.fn();
const closeSession = vi.fn();
const stopSession = vi.fn();
const resumeSession = vi.fn();
const writeSession = vi.fn();
vi.mock('../api/ipc', () => ({
  ipc: {
    approve: (id: string) => approve(id), deny: vi.fn(), reviewSession: (id: string) => reviewSession(id),
    closeSession: (id: string) => closeSession(id), stopSession: (id: string) => stopSession(id),
    resumeSession: (id: string) => resumeSession(id),
    writeSession: (id: string, b: number[]) => writeSession(id, b),
  },
}));
vi.mock('../components/TerminalView', () => ({ default: ({ sessionId }: { sessionId: string }) => <div className="terminal" tabIndex={0} data-sid={sessionId} /> }));
import SessionPanel from './SessionPanel';
import { useApp } from '../state/store';
import { useTermShown } from '../components/terminalShown';

const sess = (state: SessionState, awaitingDecision: boolean): SessionInfo => ({
  id: 's1', workspaceId: 'w1', kind: { kind: 'agent', builderId: 'b1' }, task: null, state, steps: 0,
  startedAt: 0, lastOutputAt: 0, reachedFinished: false, worktree: null, commandPreview: '', awaitingDecision, busy: false, rev: 1, spot: null,
});

beforeEach(() => {
  approve.mockReset();
  reviewSession.mockReset();
  reviewSession.mockResolvedValue({ isGit: true, branch: 'main', files: [], untracked: [], otherSessionsActive: false });
  closeSession.mockReset();
  stopSession.mockReset();
  resumeSession.mockReset();
  useTermShown.setState({ shown: false });
  useApp.setState({
    error: null, selection: null, panelOpen: false,
    workspaces: [], sessions: {}, selectedSessionId: null,
    builders: [{ id: 'b1', name: 'Ada', agent: 'claude', model: 'haiku', effort: 'low', customCommand: null }],
    agents: [{ kind: 'claude', label: 'Claude Code', installed: true, version: null, models: [], efforts: [], canApprove: true }],
  });
});

test('Allow/Deny only while a decision is awaited; disabled while answering', async () => {
  useApp.getState().upsertSession(sess({ kind: 'needsYou', reason: 'Claude needs your permission' }, true));
  render(<SessionPanel sessionId="s1" />);
  let resolve: () => void = () => {};
  approve.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
  fireEvent.click(screen.getByText('Allow'));
  expect((screen.getByText('Allow') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('Allow'));
  expect(approve).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
});

test('after a deny the reason shows instead of live buttons', () => {
  useApp.getState().upsertSession(sess({ kind: 'needsYou', reason: 'Denied — say what to do instead in the terminal' }, false));
  render(<SessionPanel sessionId="s1" />);
  expect(screen.queryByText('Allow')).toBeNull();
  expect(screen.queryByText('Deny')).toBeNull();
  expect(screen.getByText('Denied — say what to do instead in the terminal')).toBeTruthy();
});

test('class_and_gear_text', () => {
  useApp.getState().upsertSession(sess({ kind: 'working' }, false));
  render(<SessionPanel sessionId="s1" />);
  expect(screen.getByText(/haiku · low → Apprentice with wooden hammer/)).toBeTruthy();
});

test('allow_hidden_after_typing', () => {
  useApp.getState().upsertSession(sess({ kind: 'needsYou', reason: 'x' }, false));
  render(<SessionPanel sessionId="s1" />);
  expect(screen.queryByText('Allow')).toBeNull();
  expect(screen.getByText('Asking you')).toBeTruthy();
  expect(screen.getByPlaceholderText('Answer it…')).toBeTruthy(); // answered from the briefing, or in the terminal
});

test('review_shows_no_changes_line', async () => {
  useApp.getState().upsertSession(sess({ kind: 'finished' }, false));
  render(<SessionPanel sessionId="s1" />);
  expect(await screen.findByText('No changes since it started (on main).')).toBeTruthy();
});

test('review of a non-git folder', async () => {
  useApp.getState().upsertSession(sess({ kind: 'finished' }, false));
  reviewSession.mockResolvedValue({ isGit: false, branch: null, files: [], untracked: [], otherSessionsActive: false });
  render(<SessionPanel sessionId="s1" />);
  expect(await screen.findByText('No git history here; open the folder to look.')).toBeTruthy();
});

test('worktree sessions show a branch chip', () => {
  useApp.getState().upsertSession({ ...sess({ kind: 'working' }, false), worktree: { path: '/w', branch: 'coc/x' } });
  render(<SessionPanel sessionId="s1" />);
  expect(screen.getByText('coc/x')).toBeTruthy();
});

test('pop_out_mounts_single_terminal', () => {
  useTermShown.setState({ shown: true });
  useApp.getState().upsertSession(sess({ kind: 'working' }, false));
  const { container } = render(<SessionPanel sessionId="s1" />);
  expect(container.querySelectorAll('.terminal').length).toBe(1);
  fireEvent.click(screen.getByText('Pop out'));
  expect(document.querySelectorAll('.terminal').length).toBe(1);
  expect(document.querySelector('.popout .terminal')).toBeTruthy();
  expect(screen.getByText('Terminal popped out — ✕ to return')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(document.querySelector('.popout')).toBeNull();
  expect(document.querySelectorAll('.terminal').length).toBe(1);
  expect(screen.queryByText('Terminal popped out — ✕ to return')).toBeNull();
});

test('Esc in the pop-out does not close the side panel', () => {
  useApp.getState().upsertSession(sess({ kind: 'working' }, false));
  useApp.getState().setSelection({ kind: 'session', id: 's1' });
  const onKey = vi.fn();
  window.addEventListener('keydown', onKey);
  render(<SessionPanel sessionId="s1" />);
  fireEvent.click(screen.getByText('Pop out'));
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(onKey).not.toHaveBeenCalled();
  window.removeEventListener('keydown', onKey);
});

test('Esc with focus inside the popped-out terminal reaches it; the overlay stays open', () => {
  useApp.getState().upsertSession(sess({ kind: 'working' }, false));
  render(<SessionPanel sessionId="s1" />);
  fireEvent.click(screen.getByText('Pop out'));
  const term = document.querySelector('.popout .terminal') as HTMLElement;
  term.focus();
  const seen = vi.fn();
  term.addEventListener('keydown', seen);
  fireEvent.keyDown(term, { key: 'Escape' });
  expect(seen).toHaveBeenCalled();
  expect(document.querySelector('.popout')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Close terminal'));
  expect(document.querySelector('.popout')).toBeNull();
});

test('a close failure reaches the app error toast even if the panel goes away', async () => {
  useApp.getState().upsertSession(sess({ kind: 'finished' }, false));
  closeSession.mockImplementation(async () => {
    useApp.getState().removeSession('s1'); // the manager removed it, then saving state failed
    throw 'save failed';
  });
  const { container } = render(<SessionPanel sessionId="s1" />);
  await act(async () => { fireEvent.click(screen.getByText('Close')); });
  expect(container.querySelector('.session-panel')).toBeNull();
  expect(useApp.getState().error).toBe('Close failed: save failed');
});

test('Edit builder link in the header selects the builder', () => {
  useApp.getState().upsertSession(sess({ kind: 'working' }, false));
  useApp.getState().setSelection({ kind: 'session', id: 's1' });
  render(<SessionPanel sessionId="s1" />);
  fireEvent.click(screen.getByText('Edit builder'));
  expect(useApp.getState().selection).toEqual({ kind: 'builder', id: 'b1' });
});

test('terminal sessions have no Edit builder link', () => {
  useApp.getState().upsertSession({ ...sess({ kind: 'working' }, false), kind: { kind: 'terminal' } });
  render(<SessionPanel sessionId="s1" />);
  expect(screen.queryByText('Edit builder')).toBeNull();
});

test('switching sessions keeps the terminal host and resets per-session state', async () => {
  useTermShown.setState({ shown: true });
  useApp.getState().upsertSession(sess({ kind: 'finished' }, false));
  useApp.getState().upsertSession({ ...sess({ kind: 'working' }, false), id: 's2' });
  const { container, rerender } = render(<SessionPanel sessionId="s1" />);
  expect(await screen.findByText('No changes since it started (on main).')).toBeTruthy();
  const host = container.querySelector('.terminal');
  rerender(<SessionPanel sessionId="s2" />);
  expect(container.querySelector('.terminal')).toBe(host); // the same xterm host, now showing s2
  expect(host?.getAttribute('data-sid')).toBe('s2');
  expect(screen.queryByText('No changes since it started (on main).')).toBeNull();
});

test('late results for a session switched away from never land on the one shown', async () => {
  useApp.getState().upsertSession({ ...sess({ kind: 'needsYou', reason: 'r' }, true), id: 's1' });
  useApp.getState().upsertSession({ ...sess({ kind: 'needsYou', reason: 'r' }, true), id: 's2' });
  const pending = <T,>() => { let res!: (v: T) => void; let rej!: (e: unknown) => void; const p = new Promise<T>((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
  const stop = pending<void>();
  const allow = pending<void>();
  stopSession.mockReturnValue(stop.p);
  approve.mockReturnValue(allow.p);
  const onClosed = vi.fn();
  const close = pending<unknown>();
  closeSession.mockReturnValue(close.p);
  const { rerender } = render(<SessionPanel sessionId="s1" onClosed={onClosed} />);
  fireEvent.click(screen.getByText('Stop'));
  fireEvent.click(screen.getByText('Allow'));
  fireEvent.click(screen.getAllByText('Close')[0]);
  rerender(<SessionPanel sessionId="s2" onClosed={onClosed} />);
  // s2 starts clean, and starts answering its own prompt.
  const s2allow = pending<void>();
  approve.mockReturnValue(s2allow.p);
  fireEvent.click(screen.getByText('Allow'));
  expect((screen.getByText('Allow') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { stop.rej('s1 stop failed'); allow.res(); close.res({ stuck: false }); });
  expect(screen.queryByText('s1 stop failed')).toBeNull();
  expect((screen.getByText('Allow') as HTMLButtonElement).disabled).toBe(true); // s1's finish did not re-enable s2
  expect(onClosed).toHaveBeenCalledWith({ stuck: false }, 's1'); // the closed session is named
  await act(async () => { s2allow.res(); });
  expect((screen.getByText('Allow') as HTMLButtonElement).disabled).toBe(false);
});

test('a review read for one session does not show on the next', async () => {
  useApp.getState().upsertSession(sess({ kind: 'finished' }, false));
  useApp.getState().upsertSession({ ...sess({ kind: 'finished' }, false), id: 's2' });
  let resolve: (r: unknown) => void = () => {};
  reviewSession.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  reviewSession.mockResolvedValueOnce({ isGit: false, branch: null, files: [], untracked: [], otherSessionsActive: false });
  const { rerender } = render(<SessionPanel sessionId="s1" />);
  await act(async () => {});
  rerender(<SessionPanel sessionId="s2" />);
  expect(await screen.findByText('No git history here; open the folder to look.')).toBeTruthy();
  await act(async () => resolve({ isGit: true, branch: 'main', files: [], untracked: [], otherSessionsActive: false }));
  expect(screen.queryByText('No changes since it started (on main).')).toBeNull(); // s1's late answer
  expect(screen.getByText('No git history here; open the folder to look.')).toBeTruthy();
});

test('the briefing goes once the session works again, and reads the changes anew when it finishes', async () => {
  useApp.getState().upsertSession(sess({ kind: 'finished' }, false));
  render(<SessionPanel sessionId="s1" />);
  expect(await screen.findByText('No changes since it started (on main).')).toBeTruthy();
  act(() => useApp.getState().upsertSession({ ...sess({ kind: 'working' }, false), rev: 2 }));
  expect(screen.queryByText('No changes since it started (on main).')).toBeNull();
  expect(screen.queryByTestId('briefing')).toBeNull();
  // finished again: read anew (its new turn may have changed more)
  reviewSession.mockResolvedValue({ isGit: true, branch: 'main', files: [{ path: 'a.ts', added: 3, removed: 1 }], untracked: [], otherSessionsActive: false });
  act(() => useApp.getState().upsertSession({ ...sess({ kind: 'finished' }, false), rev: 3, stateSince: 99 }));
  expect(await screen.findByText(/in 1 file/)).toBeTruthy();
  expect(reviewSession).toHaveBeenCalledTimes(2);
});

test('a paused session offers Resume instead of a terminal, and resuming shows it running', async () => {
  useTermShown.setState({ shown: true });
  useApp.getState().upsertSession({ ...sess({ kind: 'ended', exitCode: null }, false), paused: true });
  const { container } = render(<SessionPanel sessionId="s1" />);
  expect(screen.getByText('Paused')).toBeTruthy();
  expect(screen.queryByText('Stop')).toBeNull();
  expect(screen.queryByText('Pop out')).toBeNull();
  expect(container.querySelector('.terminal')).toBeNull();
  expect(screen.getByText(/pick Ada's conversation back up/)).toBeTruthy();
  resumeSession.mockResolvedValue({ ...sess({ kind: 'starting' }, false), rev: 2 });
  fireEvent.click(screen.getByText('Resume'));
  await screen.findByText('Stop');
  expect(resumeSession).toHaveBeenCalledWith('s1');
  expect(container.querySelector('.terminal')).not.toBeNull();
});

test('a resume failure stays on the panel and the session stays paused', async () => {
  useApp.getState().upsertSession({ ...sess({ kind: 'ended', exitCode: null }, false), paused: true });
  render(<SessionPanel sessionId="s1" />);
  resumeSession.mockRejectedValue('Claude Code is not installed');
  fireEvent.click(screen.getByText('Resume'));
  expect(await screen.findByText('Claude Code is not installed')).toBeTruthy();
  expect(screen.getByText('Resume')).toBeTruthy();
});

test('opened from a Kanban card it pops out at once, and closing it goes back to that board', async () => {
  useApp.setState({ sessions: { s1: sess({ kind: 'working' }, false) }, selection: { kind: 'session', id: 's1', popout: true, back: 'w1' }, kanban: null });
  render(<SessionPanel sessionId="s1" />);
  const pop = await screen.findByRole('dialog', { name: 'Terminal' });
  expect(pop).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close terminal' }));
  expect(screen.queryByRole('dialog', { name: 'Terminal' })).toBeNull();
  expect(useApp.getState().kanban).toBe('w1');
  expect(useApp.getState().selection).toBeNull();
});

test('Pop out from the panel closes back to the panel', async () => {
  useApp.setState({ sessions: { s1: sess({ kind: 'working' }, false) }, selection: { kind: 'session', id: 's1' }, kanban: null });
  render(<SessionPanel sessionId="s1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Pop out' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Close terminal' }));
  expect(useApp.getState().kanban).toBeNull();
  expect(useApp.getState().selection).toEqual({ kind: 'session', id: 's1' });
});

test('an agent session hides its terminal by default and shows its last reply; the toggle brings the terminal', () => {
  useApp.getState().upsertSession({ ...sess({ kind: 'working' }, false), task: 'Fix the bug', lastMessage: 'Done with step one' });
  const { container } = render(<SessionPanel sessionId="s1" />);
  expect(container.querySelector('.terminal')).toBeNull();
  expect(screen.getByText('Done with step one')).toBeTruthy();
  expect(screen.getByText('Fix the bug')).toBeTruthy();
  fireEvent.click(screen.getByText('Show terminal'));
  expect(container.querySelector('.terminal')).toBeTruthy();
  expect(screen.queryByTestId('session-glance')).toBeNull();
  expect(useTermShown.getState().shown).toBe(true);
  fireEvent.click(screen.getByText('Hide terminal'));
  expect(container.querySelector('.terminal')).toBeNull();
});

test('a shell session always shows its terminal, with no toggle', () => {
  useApp.getState().upsertSession({ ...sess({ kind: 'working' }, false), kind: { kind: 'terminal' } as never });
  const { container } = render(<SessionPanel sessionId="s1" />);
  expect(container.querySelector('.terminal')).toBeTruthy();
  expect(screen.queryByText('Show terminal')).toBeNull();
});

test('a working agent can be messaged from the glance without opening its terminal', async () => {
  writeSession.mockReset();
  writeSession.mockResolvedValue(undefined);
  useApp.getState().upsertSession({ ...sess({ kind: 'working' }, false), lastMessage: 'On it' });
  const { container } = render(<SessionPanel sessionId="s1" />);
  expect(container.querySelector('.terminal')).toBeNull();
  const box = screen.getByLabelText('Message it') as HTMLTextAreaElement;
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(box, { target: { value: 'Use the v2 endpoint instead' } });
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); await new Promise((r) => setTimeout(r, 200)); });
  const typed = writeSession.mock.calls.map(([, b]) => new TextDecoder().decode(new Uint8Array(b))).join('');
  expect(typed).toBe('\x1b[200~Use the v2 endpoint instead\x1b[201~\r');
  expect(box.value).toBe('');
  expect(screen.getByRole('status').textContent).toBe('Sent to its prompt.');
});

test('the message box is only there while it works', () => {
  useApp.getState().upsertSession({ ...sess({ kind: 'starting' }, false) });
  const { rerender } = render(<SessionPanel sessionId="s1" />);
  expect(screen.queryByTestId('steer-box')).toBeNull();
  act(() => useApp.getState().upsertSession({ ...sess({ kind: 'ended', exitCode: 0 }, false), rev: 2 }));
  rerender(<SessionPanel sessionId="s1" />);
  expect(screen.queryByTestId('steer-box')).toBeNull();
  act(() => useApp.getState().upsertSession({ ...sess({ kind: 'working' }, false), rev: 3 }));
  rerender(<SessionPanel sessionId="s1" />);
  expect(screen.getByTestId('steer-box')).toBeTruthy();
});
