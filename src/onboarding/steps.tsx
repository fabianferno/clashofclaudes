import type { ReactNode } from 'react';
import type { SessionInfo, Workspace } from '../api/types';
import type { StepId } from './tour';
import { DEMO_TASK, DEMO_WS_NAME, XP_PER_SESSION } from './demo';

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
    case 'hall':
      return {
        title: 'Your Town Hall',
        body: <>This is <b>{c.hall}</b>, the heart of your village. Every project and every coding agent you run will gather around it.</>,
        waiting: 'Click the Town Hall',
      };
    case 'hall-panel':
      return {
        title: 'Everything at a glance',
        body: <>The Town Hall lists your workspaces and builders, and checks which agent CLIs are on this Mac: Claude Code, Codex, Antigravity and OpenCode. Missing one? It shows the command to install it.</>,
      };
    case 'workspace':
      return {
        title: 'Projects become compounds',
        body: <>Every workspace becomes a walled compound. For your own, use <K>Open</K> (a project you have) or <K>Build</K> (a new one) down here. For now, let’s raise a sample one. It lives only in this tour: nothing is created on disk.</>,
        action: 'Raise the sample compound',
      };
    case 'open-workspace':
      return {
        title: `Meet ${DEMO_WS_NAME}`,
        body: <>The house is the workspace. Click it to open the workspace panel: its sessions, terminals, Kanban and settings.</>,
        waiting: `Click the ${DEMO_WS_NAME} house`,
      };
    case 'new-session':
      return {
        title: 'Put a builder to work',
        body: <>Each agent session is a builder raising a tent in the compound. Click <K>+ New session</K>.</>,
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
        body: <>A red <K>!</K> means a session is waiting on you: a permission, a question or a sign-in. <K>Allow</K> or <K>Deny</K> right here, or answer in the terminal. The <K>needs you</K> pill at the top left pulses until you do.</>,
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
          body: <>A finished tent means <K>ready to review</K>. <K>Review</K> lists the files the agent changed. Happy with it? <K>Close</K> stands the builder down and earns XP for the workspace.</>,
          waiting: 'Close the session',
        }
        : { title: 'Close it', body: <>This session never finished, so closing it earns no XP. Close it to carry on.</>, waiting: 'Close the session' };
    case 'xp': {
      const leveled = (c.sample?.level ?? 1) > 1;
      return c.sample && (leveled || c.sample.xp > 0)
        ? {
          title: leveled ? `+${XP_PER_SESSION} XP: level up!` : `+${XP_PER_SESSION} XP`,
          body: <>Closing finished work earns XP for its compound, and the house grows grander as it levels up. Your <K>Village level</K> at the top left counts every session you ship.</>,
        }
        : { title: 'No XP this time', body: <>Only sessions that finish earn XP. Close finished work to level up its house and your village.</> };
    }
    case 'terminal':
      return {
        title: 'Shells and pages too',
        body: <><K>+ Terminal</K> opens a plain shell in the workspace and stands a rune stone in the compound. <K>+ Browser</K> puts a live page, like your dev server on localhost, on a board.</>,
      };
    case 'kanban':
      return {
        title: 'Plan on the Kanban',
        body: <>Each workspace has a <K>Kanban</K>: jot tasks down, then hand one to an idle builder to start it. Running sessions show up there by state, too.</>,
      };
    case 'resources':
      return {
        title: 'Resources and output',
        body: <>Top right: each agent’s <K>resources</K>, how much of its usage limit is left. Below it, how many builders are busy and how much shipped today.</>,
      };
    case 'roster':
      return {
        title: 'Your builders',
        body: <>Every builder you’ve recruited, with what they’re doing. Click one to jump to its terminal, or drag an idle one onto a compound to start work there.</>,
      };
    case 'camera':
      return {
        title: 'Find your way around',
        body: <>Scroll to zoom (<K>⌘ +</K> and <K>⌘ −</K> too, <K>⌘ 0</K> fits everything) and drag to pan. Drag a house, a tent or a whole compound to rearrange your village.</>,
      };
    case 'settings':
      return {
        title: 'Settings',
        body: <>Notifications, updates, your name on the Town Hall, and this tour, whenever you want it again.</>,
      };
  }
}
