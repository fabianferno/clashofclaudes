import type { AgentKind } from '../api/types';

export type ClassTier = 0 | 1 | 2; // Apprentice, Craftsman, Master
export type Gear = 0 | 1 | 2 | 3 | 4; // wooden, iron, gold, runed, enchanted

export const PALETTE: Record<
  AgentKind,
  { body: string; dark: string; hat: string; roof: string; wall: string; label: string }
> = {
  claude: { body: '#d97757', dark: '#8a3f24', hat: '#f6e7c8', roof: '#d4683f', wall: '#f3e2c4', label: 'Claude Code' },
  codex: { body: '#3a3a40', dark: '#111114', hat: '#f4f4f4', roof: '#4a4d57', wall: '#cfccc5', label: 'Codex' },
  gemini: { body: '#4f7cf0', dark: '#22409a', hat: '#c9b8ff', roof: '#4f7cf0', wall: '#eef1f8', label: 'Gemini CLI' },
  opencode: { body: '#33a889', dark: '#17594a', hat: '#ffcc1a', roof: '#2f9a7e', wall: '#dcbf92', label: 'OpenCode' },
  custom: { body: '#8d8a83', dark: '#4f4c47', hat: '#efeae0', roof: '#7d7a74', wall: '#e4ded2', label: 'Custom' },
};

/** Model name (lowercase) to builder class; single-model or unknown agents are Craftsman. */
export const CLASS_MAP: Record<AgentKind, Record<string, ClassTier>> = {
  claude: { haiku: 0, sonnet: 1, opus: 2, fable: 2 },
  codex: {},
  gemini: { flash: 0, pro: 2 },
  opencode: {},
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

const EFFORT_GEAR: Record<string, Gear> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

export function gearOf(effort: string | null): Gear {
  const k = effort?.toLowerCase();
  return k !== undefined && Object.prototype.hasOwnProperty.call(EFFORT_GEAR, k) ? EFFORT_GEAR[k] : 1;
}

export function stars(g: Gear): number {
  return Math.min(g + 1, 4);
}

export const CLASS_NAMES = ['Apprentice', 'Craftsman', 'Master'] as const;
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
];

export function houseColors(workspaceId: string): { roof: string; wall: string } {
  let h = 0;
  for (let i = 0; i < workspaceId.length; i++) h = (h * 31 + workspaceId.charCodeAt(i)) >>> 0;
  return HOUSE_COLORS[h % HOUSE_COLORS.length];
}

/** XP to go from `level` to the next: round(100 x 1.4^(level-1)); mirrors the Rust `need`. */
export function xpNeed(level: number): number {
  return Math.round(100 * Math.pow(1.4, level - 1));
}
