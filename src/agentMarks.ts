import type { AgentKind } from './api/types';

// Marks for Claude Code and OpenCode are from Simple Icons (https://simpleicons.org, CC0-1.0), and
// Codex's (the OpenAI mark) from Lobe Icons (@lobehub/icons-static-svg 1.71.0, MIT); the trademarks
// belong to their owners and only identify each agent. Antigravity has an original lift mark, and
// Custom a neutral prompt glyph.
/** Each agent's mark as a filled path in a 24x24 box; agents without one use `PROMPT_GLYPH`. */
export const MARK_PATHS: Partial<Record<AgentKind, string>> = {
  claude: 'M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z',
  // Original: an upward chevron over a hovering dot ("anti-gravity").
  antigravity: 'M12 .5 23.5 14.5h-6.8L12 8.8l-4.7 5.7H.5Zm0 14.3a4.35 4.35 0 1 1 0 8.7 4.35 4.35 0 0 1 0-8.7z',
  opencode: 'M22 24H2V0h20zM17 4.8H7v14.4h10z',
  codex: 'M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z',
};

/** Marks drawn with the even-odd rule (their holes are subpaths, as in the source SVG). */
export const MARK_FILL_RULE: Partial<Record<AgentKind, 'evenodd'>> = { codex: 'evenodd' };

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
