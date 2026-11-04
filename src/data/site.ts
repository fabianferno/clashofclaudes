// All copy and links for the site. Facts come from the app's README and source.
// Assumptions (see DESIGN.md): the beta is not described as free; feedback happens inside the app,
// and the one personal contact is a DM on X; builder ranks per agent in the roster are for variety only.

export const site = {
  name: 'Clash of Claudes',
  tagline: 'Run all your coding agents from one village',
  url: 'https://clashofclaudes.crevn.xyz',
  description:
    'A Mac app that turns Claude Code, Codex, Antigravity CLI and OpenCode sessions into builders in a cozy village. See who is working, who needs you, who shipped.',
  download: 'https://github.com/fabianferno/clashofclaudes-releases/releases/latest/download/Clash-of-Claudes.dmg',
  releases: 'https://github.com/fabianferno/clashofclaudes-releases/releases',
  latestApi: 'https://api.github.com/repos/fabianferno/clashofclaudes-releases/releases/latest',
  requirements: 'macOS 13 or later, Apple Silicon or Intel',
  /** Who makes it: the studio credit and the maker's X account for DMs. */
  studio: { name: 'Crevn', url: 'https://crevn.xyz', label: 'crevn.xyz' },
  maker: { name: 'Fabian Ferno', handle: 'fabianferno', x: 'https://x.com/fabianferno' },
};

export const nav = [
  { href: '/#session', label: 'How it works' },
  { href: '/#builders', label: 'Agents' },
  { href: '/#faq', label: 'FAQ' },
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
    approve: 'Allow or deny from the village, no terminal needed.',
    verified: true,
  },
  {
    key: 'codex',
    name: 'Codex',
    command: 'codex',
    builder: 'craftsman-codex',
    rank: 'Craftsman',
    reports: 'Working and finished. Needs you is read from its approval and trust prompts on screen.',
    approve: 'Answer in its terminal. The red “!” still tells you when.',
    verified: false,
  },
  {
    key: 'antigravity',
    name: 'Antigravity CLI',
    command: 'agy',
    builder: 'apprentice-antigravity',
    rank: 'Apprentice',
    reports: 'Working, needs you, finished, interrupted, failed, and tool steps, read from what agy prints. No settings files at all.',
    approve: 'Allow or deny from the village too.',
    verified: true,
  },
  {
    key: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    builder: 'craftsman-opencode',
    rank: 'Craftsman',
    reports: 'Working, needs you, finished, and stuck on an error.',
    approve: 'Answer in its terminal, one click from the builder.',
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

// The fly-over of the real window: each stop is a point on the screenshot (fractions of its width and
// height), the zoom to hold there, and what it shows. The last stop is the whole window.
export const tour = [
  { x: 0.3, y: 0.62, zoom: 2.4, title: 'Someone needs you', text: 'Cyra hit a permission prompt in payments-api. The red plate and the “!” say so from across the village.' },
  { x: 0.06, y: 0.12, zoom: 2.3, title: 'Counts you can trust', text: 'Building, needs you, ready to review: the top left counts every builder, and each pill jumps to them.' },
  { x: 0.9, y: 0.1, zoom: 2.3, title: 'Limits before they bite', text: 'Each agent’s usage left this week or month, read from the agent itself, refilling like a potion.' },
  { x: 0.44, y: 0.92, zoom: 2, title: 'The whole crew', text: 'The roster shows every builder’s rank, stars and state. Click one to open its live terminal.' },
  { x: 0.5, y: 0.5, zoom: 1, title: 'Your whole town', text: 'Four workspaces, eight builders, one window. This is the app running, not a mockup.' },
] as const;

// Answers people (and answer engines) look for. Shown on the home page and marked up as FAQPage.
export const faq = [
  {
    q: 'What is Clash of Claudes?',
    a: 'A Mac app that runs your coding agent sessions (Claude Code, Codex, Antigravity CLI, OpenCode or any command) and shows each one as a builder in an isometric village. Each project folder is a walled compound. You can see at a glance which agents are working, which need your approval and which have finished.',
  },
  {
    q: 'How do I run several Claude Code sessions at once without losing track?',
    a: 'Open each project as a workspace and start a builder per task. Every session runs in its own real terminal, and the village shows its state: hammering means working, a red “!” means it is waiting on a permission prompt, a medal means it finished. Notifications and the Dock badge tell you when one needs you while the app is in the background.',
  },
  {
    q: 'Which coding agents does it support?',
    a: 'Claude Code and Antigravity CLI are checked against real runs, including allowing or denying permission prompts from the village. Codex and OpenCode are supported from their documentation and testers are helping confirm them. Any other command also works: it counts as working while it prints and finished once it goes quiet.',
  },
  {
    q: 'Does it send my code or prompts anywhere?',
    a: 'No. Agent output, prompts, file names and folders stay on your Mac. The only network calls are the update check, which you can turn off, and bug reports or feature requests you choose to send.',
  },
  {
    q: 'Will it change my Claude Code, Codex or OpenCode settings?',
    a: 'No. Nothing under ~/.claude, ~/.codex, ~/.gemini or ~/.config/opencode is edited. Each session gets a private settings file in the app’s own folder, deleted when the session closes. It uses the CLIs and logins you already have.',
  },
  {
    q: 'What do I need to run it?',
    a: 'Any Mac on macOS 13 or newer (Apple Silicon and Intel both work), and at least one agent CLI installed and signed in. The app is signed and notarized by Apple, so it opens like any other app.',
  },
  {
    q: 'How do updates work?',
    a: 'The app checks for a new beta every few hours and offers it in a small banner. Updates are signed, and the app installs one only if its signature matches. You can also check from Settings at any time.',
  },
  {
    q: 'How do I report a bug or ask for a feature?',
    a: 'From the app: Help › Report a Bug… or Help › Request a Feature…, or the Beta feedback card in Settings. Nothing is sent until you read it and press Send. For anything else, send Fabian a DM on X.',
  },
  {
    q: 'Is it made by Anthropic, OpenAI or Google?',
    a: 'No. Clash of Claudes is an independent app built by Crevn. It is not affiliated with or endorsed by Anthropic, OpenAI, Google or the OpenCode team.',
  },
] as const;
