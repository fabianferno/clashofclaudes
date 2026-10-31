import type { AgentKind } from '../api/types';

// Brand marks for Claude Code, Google Gemini and OpenCode are from Simple Icons
// (https://simpleicons.org, CC0-1.0; the trademarks belong to their owners and identify each
// agent only). Simple Icons carries no OpenAI mark, so Codex and Custom use a neutral prompt glyph.
const MARKS: Partial<Record<AgentKind, { d: string; color: string }>> = {
  claude: { color: '#D97757', d: 'M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z' },
  gemini: { color: '#8E75B2', d: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81' },
  opencode: { color: '#000000', d: 'M22 24H2V0h20zM17 4.8H7v14.4h10z' },
};

/** A 24-unit "›_" prompt in a rounded tile: Codex (in its black) and Custom (neutral). */
function PromptGlyph({ color }: { color: string }) {
  return (
    <>
      <rect x="1" y="1" width="22" height="22" rx="5" fill={color} />
      <path d="M6.5 8l4 4-4 4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 16.5h5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </>
  );
}

/** The agent's logo, `size` px square; decorative (the label next to it names the agent). */
export default function AgentLogo({ kind, size = 20 }: { kind: AgentKind; size?: number }) {
  const mark = MARKS[kind];
  return (
    <svg className="agent-logo" data-testid={`agent-logo-${kind}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {mark ? <path d={mark.d} fill={mark.color} /> : <PromptGlyph color={kind === 'codex' ? '#111111' : '#7a6a55'} />}
    </svg>
  );
}
