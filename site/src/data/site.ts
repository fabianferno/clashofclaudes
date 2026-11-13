// All copy and links for the site. Facts come from the app's README and source.
// Assumptions (see DESIGN.md): the beta is not described as free; feedback happens inside the app,
// and the one personal contact is a DM on X; builder ranks per agent in the roster are for variety only.

export const site = {
  name: 'Clash of Claudes',
  tagline: 'Run all your coding agents from one village',
  url: 'https://clashofclaudes.crevn.xyz',
  description:
    'A Mac app that turns Claude Code, Codex, Antigravity CLI, OpenCode and Grok Build sessions into builders in a cozy village. See who is working, who needs you, who shipped.',
  download: 'https://github.com/fabianferno/clashofclaudes-releases/releases/latest/download/Clash-of-Claudes.dmg',
  releases: 'https://github.com/fabianferno/clashofclaudes-releases/releases',
  /** The source, under the Business Source License 1.1. */
  source: 'https://github.com/fabianferno/clashofclaudes',
  latestApi: 'https://api.github.com/repos/fabianferno/clashofclaudes-releases/releases/latest',
  requirements: 'macOS 13 or later, Apple Silicon or Intel',
  /** Who makes it: the studio credit and the maker's X account for DMs. */
  studio: { name: 'Crevn', url: 'https://crevn.xyz', label: 'crevn.xyz' },
  maker: { name: 'Fabian Ferno', handle: 'fabianferno', x: 'https://x.com/fabianferno' },
};

export const nav = [
  { href: '/#features', label: 'How it works' },
  { href: '/#builders', label: 'Agents' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/beta/', label: 'Beta guide' },
  { href: '/privacy/', label: 'Privacy' },
];

export type AgentKey = 'claude' | 'codex' | 'antigravity' | 'opencode' | 'grok';

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
  {
    key: 'grok',
    name: 'Grok Build',
    command: 'grok',
    builder: 'master-grok',
    rank: 'Master',
    reports: 'Working, needs you (its trust screen too), finished, and failed with Grok’s own reason, read from what grok prints. No settings files at all.',
    approve: 'Answer in its terminal. The red “!” still tells you when.',
    verified: false,
  },
];

// The agents section: each agent reports to the village. A sample of what each might say, in the
// app's own states (illustrative, matching the sample village in the screenshots).
export const reports: { agent: AgentKey; name: string; status: 'needs' | 'work' | 'done' | 'stuck'; label: string; text: string }[] = [
  { agent: 'claude', name: 'Claude Code', status: 'needs', label: 'Needs you', text: 'Allow Bash: pnpm prisma migrate deploy?' },
  { agent: 'codex', name: 'Codex', status: 'work', label: 'Working', text: 'Rate-limiting the webhook route. 5 steps in.' },
  { agent: 'antigravity', name: 'Antigravity CLI', status: 'done', label: 'Finished', text: 'Docs updated in 31 tool steps.' },
  { agent: 'opencode', name: 'OpenCode', status: 'stuck', label: 'Stuck', text: 'Exited with an error. Open its terminal?' },
  { agent: 'grok', name: 'Grok Build', status: 'work', label: 'Working', text: 'Writing tests for the parser. 12 steps in.' },
];

// The feature reel: the ad's beats as a scroll story. Each beat plays a loop of real app footage
// (public/reel/<clip>.mp4, cut from the ad's raw shots) or, for the Kanban, the real screenshot.
// In a title, the words between asterisks are set in gold.
export const reel: { clip: string; title: string; text: string }[] = [
  {
    clip: 'build',
    title: 'Every session is a *builder*',
    text: 'Start Claude Code, Codex, Antigravity CLI, OpenCode or Grok Build in a project and a builder walks onto a plot and starts hammering. The tent rises as the agent works. When the turn is done it stands finished and the builder cheers.',
  },
  {
    clip: 'needs',
    title: 'Needs you? *It shouts.*',
    text: 'The moment an agent stops for a permission prompt, a red “!” pops over its builder. Allow or deny Claude Code and Antigravity requests right from the village, or click the builder for its live terminal.',
  },
  {
    clip: 'outfits',
    title: 'Dressed by *provider*',
    text: 'Claude Code builders work in orange, Codex in white, Antigravity in blue, OpenCode in teal and Grok Build in black, tents included, so you can tell whose work you are looking at from across the village.',
  },
  {
    clip: 'ranks',
    title: 'Model = *rank*. Effort = *hammer*.',
    text: 'The model sets the rank: Apprentice for Haiku, Craftsman for Sonnet, Master for Opus, Legend for Fable. The effort level picks the hammer, from wood to enchanted, and the stars over it.',
  },
  {
    clip: 'elixir',
    title: 'Elixir = your *token limits*',
    text: 'Each agent gets an elixir collector filled with what is left of its weekly or monthly limit, read from the agent itself. Watch it drain while you work and fill back up when the limit resets.',
  },
  {
    clip: 'minions',
    title: 'Subagents? *Minions.*',
    text: 'When a Claude Code session spins up subagents, small builders pop out beside it, follow it to the site and hammer along until each one is done.',
  },
  {
    clip: 'stones',
    title: 'Terminals = *rune stones*',
    text: 'A plain shell in a workspace stands as a rune stone that glows while a command runs. A local web app running in the workspace gets a board in the compound, showing its page.',
  },
  {
    clip: 'levelup',
    title: 'Ship tasks. *Level up.*',
    text: 'Every finished turn earns the workspace XP. Its house grows through five stages as you ship, so your busiest projects stand tallest.',
  },
  {
    clip: 'kanban',
    title: 'Plan it on the *Kanban*',
    text: 'Write tasks in To Do and start one when a builder is free. Sessions move across Active, Needs You and Finished on their own, and a permission prompt can be allowed or denied right on its card.',
  },
];

export const privacy = [
  {
    title: 'Nothing leaves your Mac',
    text: 'Agent output, prompts, file names and folders stay on your machine. The only network calls are the update check (you can turn it off), bug reports you choose to send, and anonymous usage counts if you turn them on.',
  },
  {
    title: 'Your agent config is never touched',
    text: 'Nothing under ~/.claude, ~/.codex, ~/.gemini, ~/.config/opencode or ~/.grok is ever edited. Each session gets a private settings file in the app’s own folder, deleted when it closes.',
  },
  {
    title: 'Status stays on localhost',
    text: 'Agents report their status to a server that only listens on your Mac, behind a random token per session.',
  },
  {
    title: 'Quiet notifications',
    text: 'Notifications say a builder needs you or finished, and a permission prompt can be allowed right from one. They never include your task or terminal output.',
  },
];

// Answers people (and answer engines) look for. Shown on the home page and marked up as FAQPage.
export const faq = [
  {
    q: 'What is Clash of Claudes?',
    a: 'A Mac app that runs your coding agent sessions (Claude Code, Codex, Antigravity CLI, OpenCode, Grok Build or any command) and shows each one as a builder in a village. Each project folder is a walled compound. You can see at a glance which agents are working, which need your approval and which have finished.',
  },
  {
    q: 'How do I run several Claude Code sessions at once without losing track?',
    a: 'Open each project as a workspace and start a builder per task. Every session runs in its own real terminal, and the village shows its state: hammering means working, a red “!” means it is waiting on a permission prompt, a medal means it finished. Notifications and the Dock badge tell you when one needs you while the app is in the background.',
  },
  {
    q: 'Which coding agents does it support?',
    a: 'Claude Code and Antigravity CLI are checked against real runs, including allowing or denying permission prompts from the village. Grok Build’s status reports were checked against a real grok; Codex, OpenCode and the rest of Grok Build are supported from their documentation and testers are helping confirm them. Any other command also works: it counts as working while it prints and finished once it goes quiet.',
  },
  {
    q: 'Does it send my code or prompts anywhere?',
    a: 'No. Agent output, prompts, file names and folders stay on your Mac. The only network calls are the update check, which you can turn off, bug reports or feature requests you choose to send, and anonymous usage counts, which are off unless you turn them on.',
  },
  {
    q: 'Will it change my Claude Code, Codex, OpenCode or Grok Build settings?',
    a: 'No. Nothing under ~/.claude, ~/.codex, ~/.gemini, ~/.config/opencode or ~/.grok is edited. Each session gets a private settings file in the app’s own folder, deleted when the session closes. It uses the CLIs and logins you already have.',
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
    q: 'Can I see the source code?',
    a: 'Yes, it is on GitHub under the Business Source License 1.1. You can read it, build it, change it and use it for your own work, at home or at a company. What it does not allow is offering it, or a version of it, to others as a competing product for running or managing coding agents. Each version becomes MIT four years after its release.',
  },
  {
    q: 'Is it made by Anthropic, OpenAI, Google or xAI?',
    a: 'No. Clash of Claudes is an independent app built by Crevn. It is not affiliated with or endorsed by Anthropic, OpenAI, Google, xAI or the OpenCode team.',
  },
] as const;
