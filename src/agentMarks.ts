import type { AgentKind } from './api/types';

// Marks for Claude Code and OpenCode are from Simple Icons (https://simpleicons.org, CC0-1.0; the
// trademarks belong to their owners and only identify each agent). Simple Icons has no OpenAI or
// Antigravity mark: Codex and Custom use a neutral prompt glyph, Antigravity an original lift mark.
/** Each agent's mark as a filled path in a 24x24 box; agents without one use `PROMPT_GLYPH`. */
export const MARK_PATHS: Partial<Record<AgentKind, string>> = {
  claude: 'M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z',
  // Original: an upward chevron over a hovering dot ("anti-gravity").
  antigravity: 'M12 .5 23.5 14.5h-6.8L12 8.8l-4.7 5.7H.5Zm0 14.3a4.35 4.35 0 1 1 0 8.7 4.35 4.35 0 0 1 0-8.7z',
  opencode: 'M22 24H2V0h20zM17 4.8H7v14.4h10z',
};

/** A prompt (`>_`) as two stroked paths in the 24x24 box, stroke width 2.6, round caps. */
export const PROMPT_GLYPH = ['M5 7l5 5-5 5', 'M12.5 17.5h6.5'] as const;

/** The tile each agent's mark sits on: background top/bottom and the mark's colour (`gradient`: `MARK_GRADIENT`). */
export const TILES: Record<AgentKind, { top: string; bottom: string; fg: string | 'gradient' }> = {
  claude: { top: '#E58A6B', bottom: '#C9653F', fg: '#FFFFFF' },
  codex: { top: '#3A3A3C', bottom: '#0B0B0C', fg: '#FFFFFF' },
  opencode: { top: '#2C2C2E', bottom: '#000000', fg: '#FFFFFF' },
  antigravity: { top: '#FFFFFF', bottom: '#E9E6F2', fg: 'gradient' },
  custom: { top: '#9A8668', bottom: '#6E5D45', fg: '#FFFFFF' },
};

/** Antigravity's mark colours, top-left to bottom-right. */
export const MARK_GRADIENT: ReadonlyArray<[offset: number, color: string]> = [[0, '#4F8DF7'], [0.55, '#9B72CB'], [1, '#D96570']];
