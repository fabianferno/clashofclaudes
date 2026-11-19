import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import type { SessionInfo, SessionState } from '../api/types';

const ipcMock = vi.hoisted(() => ({
  approve: vi.fn(), deny: vi.fn(), reviewSession: vi.fn(), closeSession: vi.fn(), stopSession: vi.fn(), resumeSession: vi.fn(),
  parkSession: vi.fn(), writeSession: vi.fn(),
}));
vi.mock('../api/ipc', () => ({ ipc: ipcMock }));
vi.mock('../components/TerminalView', () => ({ default: () => <div className="terminal" /> }));
import SessionPanel from './SessionPanel';
import { useApp } from '../state/store';

const sess = (id: string, state: SessionState, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, workspaceId: 'w1', kind: { kind: 'agent', builderId: `b-${id}` }, task: 'Add a dark mode toggle', state, steps: 3,
  startedAt: 0, lastOutputAt: 0, reachedFinished: state.kind === 'finished', worktree: null, commandPreview: '', awaitingDecision: false,
  busy: false, rev: 1, spot: null, stateSince: Date.now() - 5 * 60_000, ...extra,
});

beforeEach(() => {
  for (const f of Object.values(ipcMock)) f.mockReset();
  ipcMock.reviewSession.mockResolvedValue({ isGit: true, branch: 'main', files: [{ path: 'src/theme.ts', added: 42, removed: 3 }], untracked: ['src/Toggle.tsx'], otherSessionsActive: false });
  ipcMock.closeSession.mockResolvedValue({ earnedXp: true, xpGained: 100, levelBefore: 1, levelAfter: 1, workspaceId: 'w1', unfinished: false, stuck: false });
  ipcMock.writeSession.mockResolvedValue(undefined);
  useApp.setState({
    error: null, selection: null, panelOpen: false, notices: [], kanban: null, settingsOpen: false,
    workspaces: [{ id: 'w1', name: 'shop', path: '/w', createdAt: 0, missing: false, level: 1, xp: 0, compound: null }],
    sessions: {}, selectedSessionId: null,
    builders: ['a', 'b'].map((x) => ({ id: `b-${x}`, name: x.toUpperCase(), agent: 'claude' as const, model: null, effort: null, customCommand: null })),
    agents: [{ kind: 'claude', label: 'Claude Code', installed: true, version: null, models: [], efforts: [], canApprove: true }],
  });
});

test('a finished session is briefed: task, its last reply and what it changed', async () => {
  useApp.getState().upsertSession(sess('a', { kind: 'finished' }, { lastMessage: 'Added the toggle; tests pass.' }));
  render(<SessionPanel sessionId="a" />);
  expect(screen.getByText('Ready to review')).toBeTruthy();
  expect(screen.getByText('waiting 5m')).toBeTruthy();
  expect(screen.getByText('Add a dark mode toggle')).toBeTruthy();
  expect(screen.getByText('Added the toggle; tests pass.')).toBeTruthy();
  fireEvent.click(await screen.findByText(/in 2 files/));
  expect(screen.getByText('src/theme.ts')).toBeTruthy();
  expect(screen.getByText('src/Toggle.tsx')).toBeTruthy();
});

test('a permission names the call it waits on', () => {
  useApp.getState().upsertSession(sess('a', { kind: 'needsYou', reason: 'Claude needs your permission to use Bash' }, { awaitingDecision: true, asking: 'Bash: npm test' }));
  render(<SessionPanel sessionId="a" />);
  expect(screen.getByText('Wants a decision')).toBeTruthy();
  expect(screen.getByText('Bash: npm test')).toBeTruthy();
  expect(screen.queryByLabelText('Follow up')).toBeNull(); // Allow or Deny, not typing into the menu
});

test('Accept closes it for XP and, taken from the queue, the next one comes up', async () => {
  useApp.setState({ sessions: { a: sess('a', { kind: 'finished' }, { stateSince: 1 }), b: sess('b', { kind: 'finished' }, { stateSince: 2 }) } });
  useApp.getState().setSelection({ kind: 'session', id: 'a', queue: true });
  render(<SessionPanel sessionId="a" />);
  expect(screen.getByText('1 of 2')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByText('Accept +XP')); });
  expect(ipcMock.closeSession).toHaveBeenCalledWith('a', false);
  expect(useApp.getState().selection).toEqual({ kind: 'session', id: 'b', queue: true });
});

test('Discard closes it without XP; the last one leaves the queue clear', async () => {
  ipcMock.closeSession.mockResolvedValue({ earnedXp: false, xpGained: 0, levelBefore: 1, levelAfter: 1, workspaceId: 'w1', unfinished: true, stuck: false, discarded: true });
  useApp.setState({ sessions: { a: sess('a', { kind: 'finished' }) } });
  useApp.getState().setSelection({ kind: 'session', id: 'a', queue: true });
  render(<SessionPanel sessionId="a" onClosed={(o, id) => useApp.getState().onClosed(o, id)} />);
  await act(async () => { fireEvent.click(screen.getByText('Discard')); });
  expect(ipcMock.closeSession).toHaveBeenCalledWith('a', true);
  const notes = useApp.getState().notices.map((n) => n.text);
  expect(notes).toContain('Discarded — no XP');
  expect(notes).toContain('Queue clear — nothing waits on you');
});

test('a follow-up is pasted into the prompt as one block, then sent', async () => {
  vi.useFakeTimers();
  try {
    useApp.getState().upsertSession(sess('a', { kind: 'finished' }));
    render(<SessionPanel sessionId="a" />);
    const box = screen.getByLabelText('Follow up');
    fireEvent.change(box, { target: { value: 'Also add a test' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const sent = ipcMock.writeSession.mock.calls.map(([, b]) => new TextDecoder().decode(new Uint8Array(b as number[])));
    expect(sent).toEqual(['\x1b[200~Also add a test\x1b[201~', '\r']);
  } finally {
    vi.useRealTimers();
  }
});

test('Park puts it aside with a note; it shows parked with a way back', async () => {
  const s = sess('a', { kind: 'finished' });
  useApp.getState().upsertSession(s);
  ipcMock.parkSession.mockImplementation(async (_id: string, note: string | null) => ({ ...s, parked: note, rev: s.rev + 1 }));
  render(<SessionPanel sessionId="a" />);
  fireEvent.click(screen.getByText('Park'));
  fireEvent.change(screen.getByLabelText('Why park it'), { target: { value: 'after lunch' } });
  await act(async () => { fireEvent.submit(screen.getByLabelText('Why park it').closest('form')!); });
  expect(ipcMock.parkSession).toHaveBeenCalledWith('a', 'after lunch');
  await waitFor(() => expect(screen.getByText('Parked')).toBeTruthy());
  expect(screen.getByText(/after lunch/)).toBeTruthy();
  ipcMock.parkSession.mockResolvedValue({ ...s, parked: null, rev: 9 });
  await act(async () => { fireEvent.click(screen.getByText('Back to queue')); });
  expect(ipcMock.parkSession).toHaveBeenLastCalledWith('a', null);
});

test('the task shows as plain text, and as markdown once opened', async () => {
  useApp.getState().upsertSession(sess('m', { kind: 'finished' }, { task: '## Add **dark** mode\n\n- toggle\n- theme' }));
  const { container } = render(<SessionPanel sessionId="m" />);
  const task = await screen.findByTitle('Show all');
  expect(task.textContent).toBe('Add dark mode toggle theme');
  fireEvent.click(task);
  expect(container.querySelector('.brief-task strong')?.textContent).toBe('dark');
  expect(container.querySelectorAll('.brief-task li')).toHaveLength(2);
  fireEvent.click(screen.getByText('Show less'));
  expect(screen.getByTitle('Show all')).toBeTruthy();
});

describe('a question picker', () => {
  const fruit = { question: 'Pick a fruit', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple', description: 'crisp' }, { label: 'Banana' }] };
  const colors = { question: 'Pick colors', header: 'Colors', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }] };
  const asking = (questions: typeof fruit[]) =>
    sess('a', { kind: 'needsYou', reason: 'Claude asks you a question' }, { asking: 'AskUserQuestion', questions });
  const typed = () => ipcMock.writeSession.mock.calls.map(([, b]) => new TextDecoder().decode(new Uint8Array(b as number[])));

  test('shows the options as buttons and answers one question with one click', async () => {
    useApp.getState().upsertSession(asking([fruit]));
    render(<SessionPanel sessionId="a" />);
    expect(screen.getByText('Pick a fruit')).toBeTruthy();
    expect(screen.getByText('crisp')).toBeTruthy();
    expect(screen.queryByText('AskUserQuestion')).toBeNull();
    expect(screen.queryByLabelText('Follow up')).toBeNull(); // typing there would land in the picker
    expect(screen.queryByText('Allow')).toBeNull(); // Allow's key would pick the first option
    fireEvent.click(screen.getByRole('radio', { name: /Banana/ }));
    await waitFor(() => expect(typed()).toEqual(['2']));
  });

  test('own words go through the "Type something" row', async () => {
    useApp.getState().upsertSession(asking([fruit]));
    render(<SessionPanel sessionId="a" />);
    fireEvent.change(screen.getByLabelText('Your own answer'), { target: { value: 'kiwi' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(typed()).toEqual(['3', 'kiwi', '\r']));
  });

  test('several questions go together once each is answered', async () => {
    useApp.getState().upsertSession(asking([colors, fruit]));
    render(<SessionPanel sessionId="a" />);
    const sendAll = screen.getByText('Send answers') as HTMLButtonElement;
    expect(sendAll.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Blue/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Apple/ }));
    expect(ipcMock.writeSession).not.toHaveBeenCalled();
    expect(sendAll.disabled).toBe(false);
    fireEvent.click(sendAll);
    await waitFor(() => expect(typed()).toEqual(['2', '\x1b[B', '\x1b[B', '\x1b[B', '\r', '1', '1']));
  });
});

describe('a question from another agent', () => {
  const asked = (agent: 'codex' | 'grok', questions: SessionInfo['questions']) => {
    useApp.setState({ builders: [{ id: 'b-a', name: 'A', agent, model: null, effort: null, customCommand: null }] });
    useApp.getState().upsertSession(sess('a', { kind: 'needsYou', reason: 'Has a question for you' }, { questions }));
  };
  const typed = () => ipcMock.writeSession.mock.calls.map(([, b]) => new TextDecoder().decode(new Uint8Array(b as number[])));

  test("Codex's picker takes Codex's keys", async () => {
    asked('codex', [{ question: 'Favourite fruit?', header: null, multiSelect: false, options: [{ label: 'Apple' }, { label: 'Pear' }] }]);
    render(<SessionPanel sessionId="a" />);
    fireEvent.change(screen.getByLabelText('Your own answer'), { target: { value: 'kiwi' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(typed()).toEqual(['\x1b[B', '\x1b[B', '\t', 'kiwi', '\r']));
  });

  test('a question without options is answered in the terminal, not in a box that would type into its menu', () => {
    asked('grok', [{ question: 'Which colour do you prefer?', header: null, multiSelect: false, options: [] }]);
    render(<SessionPanel sessionId="a" />);
    expect(screen.getByText('Which colour do you prefer?')).toBeTruthy();
    expect(screen.getByText('Answer it in the terminal below.')).toBeTruthy();
    expect(screen.queryByLabelText('Follow up')).toBeNull();
    expect(screen.queryByTestId('question-picker')).toBeNull();
  });
});
