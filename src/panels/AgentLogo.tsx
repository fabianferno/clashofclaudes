import { useId } from 'react';
import type { AgentKind } from '../api/types';

// Marks for Claude Code, Google Gemini and OpenCode are from Simple Icons (https://simpleicons.org,
// CC0-1.0; the trademarks belong to their owners and only identify each agent). Simple Icons has no
// OpenAI mark, so Codex and Custom use a neutral prompt glyph.
const PATHS = {
  claude: 'M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z',
  gemini: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
  opencode: 'M22 24H2V0h20zM17 4.8H7v14.4h10z',
} as const;

/** The tile each agent sits on, like a macOS app icon: background top/bottom and mark colour. */
const TILES: Record<AgentKind, { top: string; bottom: string; fg: string }> = {
  claude: { top: '#E58A6B', bottom: '#C9653F', fg: '#FFFFFF' },
  codex: { top: '#3A3A3C', bottom: '#0B0B0C', fg: '#FFFFFF' },
  opencode: { top: '#2C2C2E', bottom: '#000000', fg: '#FFFFFF' },
  gemini: { top: '#FFFFFF', bottom: '#E9E6F2', fg: 'url(#g)' },
  custom: { top: '#9A8668', bottom: '#6E5D45', fg: '#FFFFFF' },
};

/**
 * The agent as an app icon: its mark on a rounded, shaded tile, `size` px square. Decorative (the
 * label beside it names the agent).
 */
export default function AgentLogo({ kind, size = 56 }: { kind: AgentKind; size?: number }) {
  const uid = useId().replace(/:/g, '');
  const t = TILES[kind];
  const fg = t.fg === 'url(#g)' ? `url(#${uid}-mark)` : t.fg;
  const path = kind in PATHS ? PATHS[kind as keyof typeof PATHS] : null;
  return (
    <svg className="agent-logo" data-testid={`agent-logo-${kind}`} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={t.top} />
          <stop offset="1" stopColor={t.bottom} />
        </linearGradient>
        <linearGradient id={`${uid}-mark`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4F8DF7" />
          <stop offset="0.55" stopColor="#9B72CB" />
          <stop offset="1" stopColor="#D96570" />
        </linearGradient>
        <linearGradient id={`${uid}-gloss`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill={`url(#${uid}-bg)`} />
      <g transform="translate(16 16) scale(1.333)">
        {path
          ? <path d={path} fill={fg} />
          : (
            <>
              <path d="M5 7l5 5-5 5" fill="none" stroke={fg} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12.5 17.5h6.5" stroke={fg} strokeWidth="2.6" strokeLinecap="round" />
            </>
          )}
      </g>
      <rect x="2" y="2" width="60" height="60" rx="14" fill={`url(#${uid}-gloss)`} />
      <rect x="2.5" y="2.5" width="59" height="59" rx="13.5" fill="none" stroke="#000" strokeOpacity="0.18" />
    </svg>
  );
}
