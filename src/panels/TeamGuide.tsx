import type { ReactNode } from 'react';
import './teamGuide.css';

/** The steps, in the order a team sets up. Bold names match the buttons and switches they point at. */
const STEPS: { title: string; body: ReactNode }[] = [
  {
    title: 'Connect',
    body: <>Turn on <b>Connect this village to Vercel Board</b> below and pick your team. If something is missing, this card says what and gives the command; run it, then press <b>Check again</b>.</>,
  },
  {
    title: 'Share a workspace',
    body: <>In a workspace's panel, turn on <b>Share on the team board</b> (or <b>Share new workspaces</b> here). Its builders show on the board: who is working, waiting or done. <b>Share details</b> adds what they work on.</>,
  },
  {
    title: 'Invite people',
    body: <>Under <b>People</b>, type a teammate's Vercel email, pick a level and press <b>Invite</b>. A <b>Visitor</b> sees builders and what they wait for, a <b>Helper</b> also answers questions and sends follow-ups, and <b>Trusted</b> also allows and denies tool calls. Everyone else is kept out.</>,
  },
  {
    title: 'Pair their Mac',
    body: <>A Helper or Trusted person can act only from a paired Mac. Press <b>Pair their Mac</b> and send them the code; they visit your village and press <b>Enter pairing code</b>. Confirm only if their screen shows the same number as yours.</>,
  },
  {
    title: 'Visit',
    body: <>Villages you were invited to appear at the top left. Click one to walk in, click a builder to see what it waits for, and press <b>Home</b> to come back.</>,
  },
  {
    title: 'Lend and borrow builders',
    body: <>Under <b>Lent builders</b>, choose which builders teammates may hand a task. To borrow one, visit a teammate's village, click one of their workspaces, pick a builder and write the task. It runs on their Mac and comes back as a branch on the repository's <code>origin</code>.</>,
  },
  {
    title: 'Answer from your phone',
    body: <>Under <b>Phone remote</b>, deploy the remote to your team once (or use the one a teammate deployed), then press <b>Pair a phone</b> and scan the code. On an iPhone, add the page to the Home Screen first.</>,
  },
];

/** Settings › Team: a folded, step-by-step guide to the team features, above the switches it describes. */
export default function TeamGuide() {
  return (
    <details className="team-guide">
      <summary>How teams work, step by step</summary>
      <p className="set-note">
        Optional, and off until you turn it on. You need a Vercel team, a recent <code>vercel</code> command and <code>vercel login</code>.
        People, Lent builders and Phone remote appear on this card once you are connected.
      </p>
      <ol>
        {STEPS.map((s) => (
          <li key={s.title}>
            <span className="team-guide-title">{s.title}</span>
            <span className="set-hint">{s.body}</span>
          </li>
        ))}
      </ol>
      <p className="set-note team-guide-warn">
        A lent builder is a teammate running an agent on your Mac with your logins. Lend only to people you would trust with that.
      </p>
    </details>
  );
}
