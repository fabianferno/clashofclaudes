// All copy and links for the site. Facts come from the app's README and source.
// Assumptions (see DESIGN.md): the beta is not described as free; no email or socials; feedback
// happens inside the app; builder ranks per agent in the roster are for variety only.

export const site = {
  name: 'Clash of Claudes',
  tagline: 'Run all your coding agents from one village',
  url: 'https://clashofclaudes.vercel.app',
  description:
    'A Mac app that turns Claude Code, Codex, Antigravity CLI and OpenCode sessions into builders in a cozy village. See who is working, who needs you, who shipped.',
  download: 'https://github.com/fabianferno/clashofclaudes-releases/releases/latest/download/Clash-of-Claudes.dmg',
  releases: 'https://github.com/fabianferno/clashofclaudes-releases/releases',
  latestApi: 'https://api.github.com/repos/fabianferno/clashofclaudes-releases/releases/latest',
  requirements: 'macOS 13 or later, Apple Silicon or Intel',
};

export const nav = [
  { href: '/#session', label: 'How it works' },
  { href: '/#builders', label: 'Agents' },
  { href: '/beta/', label: 'Beta guide' },
  { href: '/privacy/', label: 'Privacy' },
];

export type AgentKey = 'claude' | 'codex' | 'antigravity' | 'opencode';

export const agents: {
  key: AgentKey;
  name: string;
  command: string;
  builder: string; // sprite file
  rank: string;
  reports: string;
  approve: string;
  verified: boolean;
}[] = [
  {
    key: 'claude',
    name: 'Claude Code',
    command: 'claude',
    builder: 'master-claude',
    rank: 'Master',
    reports: 'Working, needs you, finished, and how many tool steps it took. It also spots the first run "trust this folder" menu.',
    approve: 'Allow or deny right from the village',
    verified: true,
  },
  {
    key: 'codex',
    name: 'Codex',
    command: 'codex',
    builder: 'craftsman-codex',
    rank: 'Craftsman',
    reports: 'Working and finished. Needs you is read from its approval and trust prompts on screen.',
    approve: 'Answer in the terminal',
    verified: false,
  },
  {
    key: 'antigravity',
    name: 'Antigravity CLI',
    command: 'agy',
    builder: 'apprentice-antigravity',
    rank: 'Apprentice',
    reports: 'Working, needs you, finished, interrupted, failed, and tool steps, read from what agy prints. No settings files at all.',
    approve: 'Allow or deny right from the village',
    verified: true,
  },
  {
    key: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    builder: 'craftsman-opencode',
    rank: 'Craftsman',
    reports: 'Working, needs you, finished, and stuck on an error.',
    approve: 'Answer in the terminal',
    verified: false,
  },
];

// The signature stage: one session, start to finish. `state` drives the stage.
export const chapters = [
  {
    state: 'working',
    title: 'Give it a task',
    text: 'Pick a builder, an agent and a first task. The agent starts in a real terminal inside that workspace, and its builder walks onto an empty plot and starts hammering.',
    status: 'Working',
  },
  {
    state: 'needs',
    title: 'It needs you',
    text: 'The moment an agent stops for a permission prompt, a red "!" pops over its builder. From across the village you can tell which one is waiting.',
    status: 'Needs you',
  },
  {
    state: 'allowed',
    title: 'Answer without hunting',
    text: 'Allow or deny a Claude Code or Antigravity request right from the village, or click the builder to open its live terminal in the side panel. Back to work.',
    status: 'Working',
  },
  {
    state: 'finished',
    title: 'Shipped',
    text: 'When the turn is done the tent stands in the agent’s colours, the builder cheers and a medal goes up. If the app is in the background, macOS tells you and the Dock counts what is waiting.',
    status: 'Finished',
  },
] as const;

export const villageNotes = [
  { title: 'A compound per workspace', text: 'Open a project folder and it becomes a walled compound around the Town Hall. Its house grows as you ship.' },
  { title: 'The real terminal, one click away', text: 'Click any builder or tent for its live terminal. Pop it out for a bigger view, or open a plain shell in the same folder.' },
  { title: 'Ranks and hammers mean something', text: 'The model sets a builder’s rank, from Apprentice to Master. The effort level sets the hammer and its stars.' },
  { title: 'Quit without losing your place', text: 'Sessions come back paused where they stood. Resume picks Claude Code, Codex and Antigravity up on their own conversation.' },
];

export const privacy = [
  {
    title: 'Nothing leaves your Mac',
    text: 'Agent output, prompts, file names and folders stay on your machine. The only network calls are the update check (you can turn it off) and bug reports you choose to send.',
  },
  {
    title: 'Your agent config is never touched',
    text: 'Nothing under ~/.claude, ~/.codex, ~/.gemini or ~/.config/opencode is ever edited. Each session gets a private settings file in the app’s own folder, deleted when it closes.',
  },
  {
    title: 'Status stays on localhost',
    text: 'Agents report their status to a server that only listens on your Mac, behind a random token per session.',
  },
  {
    title: 'Quiet notifications',
    text: 'Notifications say a builder needs you or finished. They never include your task or terminal output.',
  },
];
