// Copied from the app (src/agentMarks.ts) so the site draws the same marks.
export type AgentKind = 'claude' | 'codex' | 'antigravity' | 'opencode' | 'custom';

// Marks for Claude Code and OpenCode are from Simple Icons (https://simpleicons.org, CC0-1.0), and
// Codex's (the OpenAI mark) and Antigravity's from Lobe Icons (@lobehub/icons-static-svg 1.71.0 and
// 1.102.0, MIT); the trademarks belong to their owners and only identify each agent. Custom has a
// neutral prompt glyph.
/** Each agent's mark as a filled path in a 24x24 box; agents without one use `PROMPT_GLYPH`. */
export const MARK_PATHS: Partial<Record<AgentKind, string>> = {
  claude: 'M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z',
  antigravity: 'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z',
  opencode: 'M22 24H2V0h20zM17 4.8H7v14.4h10z',
  codex: 'M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z',
};

/** Marks drawn with the even-odd rule (their holes are subpaths, as in the source SVG). */
export const MARK_FILL_RULE: Partial<Record<AgentKind, 'evenodd'>> = { codex: 'evenodd', antigravity: 'evenodd' };

/**
 * Antigravity's colour mark (Lobe Icons' antigravity-color): blurred Google-colour shapes inside
 * its arch (`MARK_PATHS.antigravity`). Each blur's filter region is `box` ([x, y, w, h], 24px box).
 */
export const ANTIGRAVITY_COLOR: ReadonlyArray<{ d: string; fill: string; blur: number; box: readonly [number, number, number, number] }> = [
  { d: 'M-1.018-3.992c-.408 3.591 2.686 6.89 6.91 7.37 4.225.48 7.98-2.043 8.387-5.633.408-3.59-2.686-6.89-6.91-7.37-4.225-.479-7.98 2.043-8.387 5.633z', fill: '#FFE432', blur: 1.117, box: [-3.288, -11.917, 19.838, 17.587] },
  { d: 'M15.269 7.747c1.058 4.557 5.691 7.374 10.348 6.293 4.657-1.082 7.575-5.653 6.516-10.21-1.058-4.556-5.691-7.374-10.348-6.292-4.657 1.082-7.575 5.653-6.516 10.21z', fill: '#FC413D', blur: 5.4, box: [4.251, -13.493, 38.9, 38.565] },
  { d: 'M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z', fill: '#00B95C', blur: 4.591, box: [-21.889, -10.592, 40.955, 36.517] },
  { d: 'M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z', fill: '#00B95C', blur: 4.591, box: [-21.889, -10.592, 40.955, 36.517] },
  { d: 'M-7.608 14.703c3.352 3.424 9.126 3.208 12.896-.483 3.77-3.69 4.108-9.459.756-12.883C2.69-2.087-3.083-1.871-6.853 1.82c-3.77 3.69-4.108 9.458-.755 12.883z', fill: '#00B95C', blur: 4.591, box: [-19.099, -10.278, 36.632, 36.595] },
  { d: 'M9.932 27.617c1.04 4.482 5.384 7.303 9.7 6.3 4.316-1.002 6.971-5.448 5.93-9.93-1.04-4.483-5.384-7.304-9.7-6.301-4.316 1.002-6.971 5.448-5.93 9.93z', fill: '#3186FF', blur: 4.363, box: [.981, 8.758, 33.533, 34.087] },
  { d: 'M2.572-8.185C.392-3.329 2.778 2.472 7.9 4.771c5.122 2.3 11.042.227 13.222-4.63 2.18-4.855-.205-10.656-5.327-12.955-5.122-2.3-11.042-.227-13.222 4.63z', fill: '#FBBC04', blur: 3.954, box: [-6.143, -21.659, 35.978, 35.276] },
  { d: 'M-3.267 38.686c-5.277-2.072 3.742-19.117 5.984-24.83 2.243-5.712 8.34-8.664 13.616-6.592 5.278 2.071 11.533 13.482 9.29 19.195-2.242 5.713-23.613 14.298-28.89 12.227z', fill: '#3186FF', blur: 3.531, box: [-11.96, -.46, 45.114, 46.523] },
  { d: 'M28.71 17.471c-1.413 1.649-5.1.808-8.236-1.878-3.135-2.687-4.531-6.201-3.118-7.85 1.412-1.649 5.1-.808 8.235 1.878s4.532 6.2 3.119 7.85z', fill: '#749BFF', blur: 3.159, box: [10.485, .58, 25.094, 24.054] },
  { d: 'M18.163 9.077c5.81 3.93 12.502 4.19 14.946.577 2.443-3.612-.287-9.727-6.098-13.658-5.81-3.931-12.502-4.19-14.946-.577-2.443 3.612.287 9.727 6.098 13.658z', fill: '#FC413D', blur: 2.669, box: [5.833, -12.467, 33.508, 30.007] },
  { d: 'M-.915 2.684c-1.44 3.473-.97 6.967 1.05 7.804 2.02.837 4.824-1.3 6.264-4.772 1.44-3.473.97-6.967-1.05-7.804-2.02-.837-4.824 1.3-6.264 4.772z', fill: '#FFEE48', blur: 3.303, box: [-8.355, -8.876, 22.194, 26.151] },
];

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

/**
 * Antigravity's colours as one gradient, top-left to bottom-right, where its blurred colour mark
 * can't be drawn (the canvas badges): green and yellow above, red to the right, blue below.
 */
export const MARK_GRADIENT: ReadonlyArray<[offset: number, color: string]> = [[0, '#00B95C'], [0.38, '#FBBC04'], [0.62, '#FC413D'], [1, '#3186FF']];
