import type { AgentKind } from '../api/types';

export type ClassTier = 0 | 1 | 2 | 3; // Apprentice, Craftsman, Master, Legend
export type Gear = 0 | 1 | 2 | 3 | 4; // wooden, iron, gold, runed, enchanted

export const PALETTE: Record<
  AgentKind,
  { body: string; dark: string; hat: string; roof: string; wall: string; label: string }
> = {
  claude: { body: '#d97757', dark: '#8a3f24', hat: '#f6e7c8', roof: '#d4683f', wall: '#f3e2c4', label: 'Claude Code' },
  codex: { body: '#3a3a40', dark: '#111114', hat: '#f4f4f4', roof: '#4a4d57', wall: '#cfccc5', label: 'Codex' },
  antigravity: { body: '#4f7cf0', dark: '#22409a', hat: '#c9b8ff', roof: '#4f7cf0', wall: '#eef1f8', label: 'Antigravity' },
  opencode: { body: '#33a889', dark: '#17594a', hat: '#ffcc1a', roof: '#2f9a7e', wall: '#dcbf92', label: 'OpenCode' },
  grok: { body: '#8e3f7f', dark: '#45193f', hat: '#f4eef2', roof: '#7f3772', wall: '#efe2ea', label: 'Grok Build' },
  custom: { body: '#8d8a83', dark: '#4f4c47', hat: '#efeae0', roof: '#7d7a74', wall: '#e4ded2', label: 'Custom' },
};

/**
 * Each collector's resource (tank, label, panel bars) in its agent's colour: Claude's coral, Codex's
 * white, Antigravity's blue. `deep` shades the tank's sides, `lit` is the surface and highlights,
 * `label` fills the bar over the tank (darker than white Codex resource, so the white text reads).
 */
export const RESOURCE: Record<'claude' | 'codex' | 'antigravity', { deep: string; mid: string; lit: string; bubble: string; label: string }> = {
  claude: { deep: '#9a3c1f', mid: '#e27a50', lit: '#ffb995', bubble: 'rgba(255, 228, 212, 0.75)', label: '#e27a50' },
  codex: { deep: '#a9b0bf', mid: '#eef1f6', lit: '#ffffff', bubble: 'rgba(150, 160, 182, 0.55)', label: '#9aa2b3' },
  antigravity: { deep: '#1d3a9a', mid: '#4f7cf0', lit: '#a8c1ff', bubble: 'rgba(222, 232, 255, 0.75)', label: '#4f7cf0' },
};

/** Model name (lowercase) to builder class; single-model or unknown agents are Craftsman. */
export const CLASS_MAP: Record<AgentKind, Record<string, ClassTier>> = {
  claude: { haiku: 0, sonnet: 1, opus: 2, fable: 3 },
  codex: {},
  // Model ids such as "gemini-3.8-flash-medium" or "claude-opus-5-5-high" (matched by substring).
  antigravity: { flash: 0, sonnet: 1, argon: 2, opus: 2 },
  opencode: {},
  grok: {},
  custom: {},
};

export function classOf(agent: AgentKind, model: string | null): ClassTier {
  if (!model) return 1;
  const m = model.toLowerCase();
  const map = CLASS_MAP[agent];
  if (m in map) return map[m];
  // model ids such as "claude-opus-4-1" or "gemini-2.5-pro"
  const hit = Object.keys(map).find((k) => m.includes(k));
  return hit ? map[hit] : 1;
}

const EFFORT_GEAR: Record<string, Gear> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 4 };

export function gearOf(effort: string | null): Gear {
  const k = effort?.toLowerCase();
  return k !== undefined && Object.prototype.hasOwnProperty.call(EFFORT_GEAR, k) ? EFFORT_GEAR[k] : 1;
}

export function stars(g: Gear): number {
  return Math.min(g + 1, 4);
}

export const CLASS_NAMES = ['Apprentice', 'Craftsman', 'Master', 'Legend'] as const;
export const GEAR_NAMES = [
  'Wooden hammer',
  'Iron hammer',
  'Gold hammer',
  'Runed hammer',
  'Enchanted hammer',
] as const;

/** 1 plain; 2-3 banner; 4-5 side wing; 6-7 tower; 8+ gold trim. */
export function houseStage(level: number): 0 | 1 | 2 | 3 | 4 {
  if (level >= 8) return 4;
  if (level >= 6) return 3;
  if (level >= 4) return 2;
  if (level >= 2) return 1;
  return 0;
}

/** Fraction of full height a scaffold shows after `steps` steps; asymptotes below 0.92. */
export function scaffoldHeight(steps: number): number {
  return 0.92 * (1 - Math.exp(-steps / 12));
}

/** Workspace house colours (the mockup's compound palette); picked per workspace id, stable across restarts. */
export const HOUSE_COLORS: ReadonlyArray<{ roof: string; wall: string }> = [
  { roof: '#2a9d8f', wall: '#e6d7b8' },
  { roof: '#f08a2e', wall: '#f4e4c1' },
  { roof: '#3f7fd6', wall: '#efe0bf' },
  { roof: '#8a4fd0', wall: '#f2e6c8' },
  { roof: '#c64a32', wall: '#f3e2c4' }, // coral, the painted houses' own colour
];

/** The colours offered for a house: the automatic ones first, then more to choose from. */
export const HOUSE_SWATCHES: ReadonlyArray<{ roof: string; label: string }> = [
  { roof: '#2a9d8f', label: 'Teal' },
  { roof: '#f08a2e', label: 'Orange' },
  { roof: '#3f7fd6', label: 'Blue' },
  { roof: '#8a4fd0', label: 'Purple' },
  { roof: '#c64a32', label: 'Coral' },
  { roof: '#3fa34d', label: 'Green' },
  { roof: '#e8c22a', label: 'Gold' },
  { roof: '#e0568f', label: 'Pink' },
  { roof: '#56657a', label: 'Slate' },
  { roof: '#8a5a34', label: 'Brown' },
];
const CHOSEN_WALL = '#f0e2c2';

/** A workspace's house colours: the one the owner chose, else one picked by id (stable across restarts). */
export function houseColors(w: { id: string; color?: string | null }): { roof: string; wall: string } {
  if (w.color) return { roof: w.color, wall: HOUSE_COLORS.find((c) => c.roof === w.color)?.wall ?? CHOSEN_WALL };
  let h = 0;
  for (let i = 0; i < w.id.length; i++) h = (h * 31 + w.id.charCodeAt(i)) >>> 0;
  return HOUSE_COLORS[h % HOUSE_COLORS.length];
}

/** XP to go from `level` to the next: round(100 x 1.4^(level-1)); mirrors the Rust `need`. */
export function xpNeed(level: number): number {
  return Math.round(100 * Math.pow(1.4, level - 1));
}
