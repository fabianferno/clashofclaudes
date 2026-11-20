import type { ReactNode } from 'react';
import type { SessionInfo, Workspace } from '../api/types';
import type { StepId } from './tour';
import { DEMO_TASK, DEMO_WS_NAME } from './demo';

/** What a step's words may depend on. */
export interface StepContext {
  /** The hall's title: "Fabian's Town Hall" (or "your Town Hall" before a name). */
  hall: string;
  name: string | null;
  /** The builder of the sample session ("Your builder" before one starts). */
  builder: string;
  session: SessionInfo | undefined;
  sample: Workspace | undefined;
}

export interface StepCopy {
  title: string;
  body: ReactNode;
  /** While the step waits on the owner: what it waits for. */
  waiting?: string;
  /** Label of the step's own action, shown as the main button (instead of a quiet "Do it for me"). */
  action?: string;
}

const K = ({ children }: { children: ReactNode }) => <b className="tour-k">{children}</b>;

export function copyOf(id: StepId, c: StepContext): StepCopy {
  switch (id) {
    case 'welcome': case 'done': return { title: '', body: null };
    case 'workspace':
      return {
        title: 'Projects become compounds',
        body: <>Every workspace becomes a walled compound. For your own, use <K>Open</K> (a project you have) or <K>Build</K> (a new one) down here. For now, let’s raise a sample one. It lives only in this tour: nothing is created on disk.</>,
        action: 'Raise the sample compound',
      };
    case 'new-session':
      return {
        title: `Meet ${DEMO_WS_NAME}`,
        body: <>The house is the workspace, and this is its panel. Each agent session is a builder raising a tent in the compound. Click <K>+ New session</K>.</>,
        waiting: 'Click + New session',
      };
    case 'picker':
      return {
        title: 'Hire your first builder',
        body: (
          <>
            Pick a builder or recruit one, then choose the agent, its model and its effort. Better models and more effort mean
            better gear. Give a first task (try <i>“{DEMO_TASK}”</i>) and press <K>Start</K>.
            <span className="tour-fine">Sample builders run no agent and change no files.</span>
          </>
        ),
        waiting: 'Press Start',
      };
    case 'working':
      return {
        title: `${c.builder} is on it`,
        body: <>The tent rises as the agent works, and the bar over it shows time and steps. This panel is the session’s live terminal: type into it whenever you like, as you would in any terminal.</>,
        waiting: 'Working…',
      };
    case 'needs':
      return {
        title: `${c.builder} needs you`,
        body: <>A red <K>!</K> means a session is waiting on you. Its briefing says what it asks and what it changed so far: <K>Allow</K> or <K>Deny</K> right here, or answer in the terminal. Everything waiting on you lines up in one queue: <K>⌘J</K> takes the next.</>,
        waiting: 'Allow or Deny',
      };
    case 'wait-finish':
      return c.session?.state.kind === 'ended'
        ? { title: 'Stopped', body: <>You stopped the session. Close it from its panel, or start another from the workspace.</> }
        : { title: 'Back to work', body: <>Answered. The builder carries on: watch the tent go up.</>, waiting: 'Almost done…' };
    case 'review':
      return c.session?.reachedFinished
        ? {
          title: 'Ready to review',
          body: <>A finished tent means <K>ready to review</K>. The briefing shows the agent’s last reply and the files it changed. Happy with it? <K>Accept</K> stands the builder down and counts it as shipped: the house livens up and your <K>Village level</K> climbs. Or follow up, <K>Park</K> it for later, or <K>Discard</K> it.</>,
          waiting: 'Accept the work',
        }
        : { title: 'Close it', body: <>This session never finished, so closing it doesn't count as shipped. Close it to carry on.</>, waiting: 'Close the session' };
    case 'kanban':
      return {
        title: 'Plan on the Kanban',
        body: <>Each workspace has a <K>Kanban</K>: jot tasks down, then hand one to an idle builder to start it. Running sessions show up there by state, too.</>,
      };
    case 'roster':
      return {
        title: 'Your builders',
        body: <>Every builder you’ve recruited, with what they’re doing. Click one to jump to its terminal, or drag an idle one onto a compound to start work there.</>,
      };
    case 'team':
      return {
        title: 'Bring your team',
        body: (
          <>
            On a Vercel team? <K>Settings › Team</K> puts your village on the team’s board. Invite teammates to visit and
            answer your builders, lend a builder for a task, and pair your phone to Allow or Deny from anywhere.
            <span className="tour-fine">It is off until you turn it on, and your village is closed to everyone you did not invite.</span>
          </>
        ),
      };
  }
}
