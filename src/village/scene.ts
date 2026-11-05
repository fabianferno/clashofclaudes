import { Application, Container, Graphics, Sprite, Text, Texture, TilingSprite } from 'pixi.js';
import type { AgentKind, AgentQuota, Builder, CloseOutcome, Compound, SessionInfo, SessionState, Tile, Workspace } from '../api/types';
import { iso, toGrid } from './iso';
import { HALL, HOUSE, STRUCT, gateOutside, gateSide, gateTile, villageRect, wallRect, type Rect } from './layout';
import { enclosure, seedOf } from './enclosure';
import { setVillageSnapshot } from '../screenshot';
import { townHallTitle } from '../state/names';
import { indexTrees, underTree, type TreeIndex } from './clearance';
import { classOf, gearOf, houseColors, houseStage, scaffoldHeight, type ClassTier, type Gear } from './look';
import { blockedBy, dropOf, onGround, plazaPoint, retarget, routeHome, routeToSite, standTile, step, takenBy, walkable, type Blocked, type BuilderDrop, type Walker } from './walkers';
import {
  GROUND_SCALE, drawPathTile, groundTrees, pathLinks, pathTiles, treesOverPaths, drawGroundTree, drawBuilderShadow, drawBoard, drawBubble, drawBuilder, drawCollector, drawGate, drawGround, drawHall, drawHouse, drawPuff, drawRing, drawStatusBar, drawHallPlate, drawStructure,
  drawWallSeg, drawRuneStone, groundOrigin,
  hammerPose, type Art, type GroundTree, type Pose,
} from './art/entities';
import { getTexture, holdTextures, prepareArt, releaseRetired, spriteTextures } from './textures';
import { STATUS_LIFT, statusKey, statusSignature, statusesDue, type StatusTone } from './status';
import type { MoveTarget, Selection } from '../state/store';
import {
  PANEL_W, ZMAX, ease, fitRect, keepVisible, pxRectOfCompound, pxRectOfTiles, screenToWorld, worldToScreen, zoomAt, type Cam,
} from './camera';
import { DRAG_PX, createDragController } from './drag';
import { clickPoint, compoundAt, dragTarget, hitTest, selectionOf } from './input';
import { COLLECTOR_NAME, collectorLook, collectorTiles, shownCollectors, type CollectorAgent } from './quota';
import { FxRenderer, POP_SECONDS, ORB_SECONDS, Particles, RELOCATE_SECONDS, lifecycleEvents, type Snap } from './effects';
import { MAX_MINIONS, MINION_SCALE, minionSpots, popScale, shownMinions, trailOffset, type MinionSpot } from './minions';

// ---------------------------------------------------------------- pure part

export interface VillageInput {
  workspaces: Workspace[];
  sessions: SessionInfo[];
  builders: Builder[];
  /** XP-earning close outcomes by session id; the scene plays orbs for a structure it sees vanish. */
  closed?: Record<string, CloseOutcome>;
  /** Wall-clock ms for the status bars over working structures; without it no bars are emitted. */
  now?: number;
  /** Latest quota reading per agent: the resource collectors by the hall. */
  quotas?: Partial<Record<AgentKind, AgentQuota>>;
  /** Installed agents: each rationed one gets a collector even before its first reading. */
  installed?: readonly AgentKind[];
  /** Collectors the owner has dragged (top-left tiles); the rest stand in their default slots. */
  collectorSpots?: Partial<Record<AgentKind, Tile>>;
  /** App boards that have a spot: local web apps running in a workspace. */
  boards?: BoardInput[];
  /** What the owner is called: the hall's plate reads "<name>'s Town Hall" (plain "Town Hall" without one). */
  ownerName?: string | null;
}

/** A board: a local web app (see src-tauri/src/apps.rs) or a browser the owner opened; `key` as in the store's `boardItems`. */
export interface BoardInput {
  key: string;
  workspaceId: string;
  url: string;
  /** The page title or process name (apps), or the host (browsers). */
  label: string;
  port: number | null;
  /** Set for a browser the owner opened. */
  browserId?: string;
  /** The page may be framed: a click pops it out; otherwise it opens in the browser. */
  frameable: boolean;
  /** Key of the board's latest snapshot (see `art/boardImages`); without one the board shows a card. */
  snapshot?: string;
  /** Top-left tile. */
  spot: Tile;
}

export type EntityKind = 'hall' | 'house' | 'structure' | 'collector' | 'board' | 'builder' | 'wall' | 'gate' | 'tree' | 'status';

/**
 * One drawable. `x`/`y` is the grid point of the sprite's anchor (for footprints, the front
 * corner; see each draw function), so the sprite sits at `iso(x, y)`. `depth` is `x + y` of that
 * front corner with a small per-kind tie-break; larger depth draws later (in front).
 * Forest trees are baked into the ground texture, so no `tree` entities are emitted.
 * A `status` bar shares its structure's centre grid point; the scene lifts it STATUS_LIFT px.
 */
export interface Entity {
  id: string;
  kind: EntityKind;
  x: number;
  y: number;
  depth: number;
  texKey: string;
  /** A status bar's lift above its grid point, world px (default STATUS_LIFT). */
  lift?: number;
}

const KIND_RANK: Record<EntityKind, number> = {
  tree: 0, wall: 1, gate: 2, hall: 3, house: 4, structure: 5, collector: 5, board: 5, builder: 6, status: 8,
};

/** World px from a house's centre up to its name plate: just over the roof (and flag) of each stage. */
const HOUSE_LIFT = [146, 160, 160, 186, 186];
/** World px from the hall's centre up to its name plate: just over the painted flag (hall.png's top edge). */
export const HALL_LIFT = 226;
/** How much higher than the name plate a house's drag hint floats (the plate is ~20 px tall). */
const PLATE_CLEAR = 12;

/**
 * How far builders keep off the hall, the collectors and the walls, in tiles. A collector's painted
 * plinth and corner posts reach about a tile past its 2x2 (collector-base.png is 200 px wide at
 * half size; the 2x2 is 128), and a builder is half a tile wide on screen.
 */
const KEEP_OFF = { hall: 0.3, collector: 1.5, wall: 0.3 };

const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, w: r.w + 2 * d, h: r.h + 2 * d });

const ent = (id: string, kind: EntityKind, x: number, y: number, texKey: string): Entity =>
  ({ id, kind, x, y, depth: x + y + KIND_RANK[kind] * 0.001, texKey });

export type StructStage = 'foundation' | 'scaffold' | 'complete';

/** Structure stage and built fraction from the session's state (no progress percentages). */
export function structureLook(s: SessionInfo): { stage: StructStage; height: number } {
  switch (s.state.kind) {
    case 'starting': return { stage: 'foundation', height: 0 };
    case 'finished': return { stage: 'complete', height: 1 };
    case 'ended':
      return s.reachedFinished ? { stage: 'complete', height: 1 } : { stage: 'scaffold', height: scaffoldHeight(s.steps) };
    default: return { stage: 'scaffold', height: scaffoldHeight(s.steps) };
  }
}

/** The compound's organic wall (see `enclosure`) with the gate in its hall-facing tile. */
function wallEntities(wsId: string, c: Compound, spots: Tile[], level: number): Entity[] {
  const gate = gateTile(c);
  const out: Entity[] = [];
  for (const t of enclosure(c, spots, level, seedOf(wsId)).walls) {
    if (t.x === gate.x && t.y === gate.y) continue;
    out.push(inFrontOfHouse(c, t, ent(`wall:${wsId}:${t.x}:${t.y}`, 'wall', t.x + 1, t.y + 1, `wall:${t.links}`)));
  }
  out.push(inFrontOfHouse(c, gate, ent(`gate:${wsId}`, 'gate', gate.x + 1, gate.y + 1, `gate:${gateSide(c)}`)));
  return out;
}

/**
 * A wall tile beside the house's front faces (east or south of it, alongside) stands in front of
 * the house, though its front corner sums less than the house's: draw it just after the house.
 */
function inFrontOfHouse(c: Compound, t: Tile, e: Entity): Entity {
  const { x: hx, y: hy } = c.house;
  const alongY = t.y >= hy && t.y < hy + HOUSE, alongX = t.x >= hx && t.x < hx + HOUSE;
  const front = (t.x >= hx + HOUSE && alongY) || (t.y >= hy + HOUSE && alongX);
  const house = hx + hy + 2 * HOUSE + KIND_RANK.house * 0.001;
  return front && e.depth <= house ? { ...e, depth: house + 0.0005 } : e;
}

/** Top-left tiles of the structures (agent and terminal sessions, app boards) standing in a workspace's compound. */
export function spotsIn(sessions: readonly SessionInfo[], wsId: string, boards: readonly BoardInput[] = []): Tile[] {
  return sessions.flatMap((s) => (s.workspaceId === wsId && s.spot ? [s.spot] : []))
    .concat(boards.flatMap((b) => (b.workspaceId === wsId ? [b.spot] : [])));
}

/** The app boards in the compounds: the board (its app's latest snapshot on the screen) and its name bar. */
export function boardEntities(input: Pick<VillageInput, 'boards' | 'workspaces'>): Entity[] {
  const out: Entity[] = [];
  for (const b of input.boards ?? []) {
    if (!input.workspaces.some((w) => w.id === b.workspaceId && w.compound)) continue;
    out.push(ent(`board:${b.key}`, 'board', b.spot.x + STRUCT, b.spot.y + STRUCT, `board:${encodeURIComponent(b.label)}:${b.snapshot ?? ''}`));
    // texture keys split on ':', so the label holds none
    const label = `${b.label.replace(/:/g, ' ').slice(0, 24)}${b.port === null ? '' : ` \u00b7 ${b.port}`}`;
    out.push(ent(`status:board:${b.key}`, 'status', b.spot.x + STRUCT / 2, b.spot.y + STRUCT / 2, `status:app:${label}`));
  }
  return out;
}

/**
 * The resource collectors and their labels: one per rationed agent with a reading or installed.
 * The labels are `status` bars (minute-quantized, so the status clock re-syncs them).
 */
export function collectorEntities(input: Pick<VillageInput, 'quotas' | 'installed' | 'collectorSpots' | 'workspaces'>, now: number): Entity[] {
  const out: Entity[] = [];
  const shown = shownCollectors(input.quotas, input.installed);
  const tiles = collectorTiles(shown, input.collectorSpots, input.workspaces.flatMap((w) => (w.compound ? [w.compound] : [])));
  for (const agent of shown) {
    const q = input.quotas?.[agent];
    const t = tiles[agent]!;
    const look = collectorLook(q, now, agent);
    out.push(ent(`collector:${agent}`, 'collector', t.x + STRUCT, t.y + STRUCT, `collector:${agent}:${look?.tenths ?? 'none'}`));
    // named, so a tank reads at a glance without knowing each agent's colour
    const label = look ? `status:${look.tone}:${COLLECTOR_NAME[agent]} ${look.label}` : `status:stuck:${COLLECTOR_NAME[agent]} · no reading`;
    out.push(ent(`status:collector:${agent}`, 'status', t.x + STRUCT / 2, t.y + STRUCT / 2, label));
  }
  return out;
}

/** Everything the village draws for this state, sorted back to front. Pure. */
export function buildEntities(input: VillageInput): Entity[] {
  const out: Entity[] = [ent('hall', 'hall', HALL.x0 + HALL.w, HALL.y0 + HALL.h, 'hall')];
  // the owner's name on a plate over the hall (texture keys split on ':', so the label holds none)
  out.push({ ...ent('status:hall', 'status', HALL.x0 + HALL.w / 2, HALL.y0 + HALL.h / 2, `hallplate:${townHallTitle(input.ownerName).replace(/:/g, ' ')}`), lift: HALL_LIFT });
  const agentOf = new Map(input.builders.map((b) => [b.id, b.agent] as [string, AgentKind]));
  const compounds = new Map<string, Compound>();
  for (const w of input.workspaces) {
    const c = w.compound;
    if (!c) continue;
    compounds.set(w.id, c);
    const { roof, wall } = houseColors(w);
    const stage = houseStage(w.level);
    out.push(ent(`house:${w.id}`, 'house', c.house.x + HOUSE, c.house.y + HOUSE, `house:${stage}:${roof}:${wall}`));
    // the workspace's name on a plate over the roof (texture keys split on ':', so the name holds none)
    out.push({ ...ent(`status:house:${w.id}`, 'status', c.house.x + HOUSE / 2, c.house.y + HOUSE / 2, `status:house:${w.name.replace(/:/g, ' ').slice(0, 24)}`), lift: HOUSE_LIFT[stage] });
    out.push(...wallEntities(w.id, c, spotsIn(input.sessions, w.id, input.boards), w.level));
  }
  for (const s of input.sessions) {
    if (!s.spot || !compounds.has(s.workspaceId)) continue;
    if (s.kind.kind === 'terminal') {
      // lit only while a command runs, not while the shell waits at its prompt
      out.push(ent(`struct:${s.id}`, 'structure', s.spot.x + STRUCT, s.spot.y + STRUCT, `runestone:${s.busy && s.state.kind !== 'ended' ? 'lit' : 'dark'}`));
      continue;
    }
    const { stage, height } = structureLook(s);
    const agent = agentOf.get(s.kind.builderId) ?? 'custom';
    // Quantized so a long-running session reuses a bounded set of textures.
    const h = stage === 'scaffold' ? Math.round(height * 50) / 50 : stage === 'complete' ? 1 : 0;
    out.push(ent(`struct:${s.id}`, 'structure', s.spot.x + STRUCT, s.spot.y + STRUCT, `struct:${agent}:${stage}:${h}`));
    const sk = input.now === undefined ? null : statusKey(s, input.now);
    if (sk) out.push(ent(`status:${s.id}`, 'status', s.spot.x + STRUCT / 2, s.spot.y + STRUCT / 2, sk));
  }
  out.push(...collectorEntities(input, input.now ?? Date.now()));
  out.push(...boardEntities(input));
  return out.sort((a, b) => a.depth - b.depth);
}


/** Whether the fitted bounds changed (a house move re-bakes the ground but must not re-fit the camera). */
export function needsRefit(prev: Rect | null, next: Rect): boolean {
  return !prev || prev.x0 !== next.x0 || prev.y0 !== next.y0 || prev.w !== next.w || prev.h !== next.h;
}

export const GROUND_PAD = 12;

/** Ground bake bounds: the village rect padded by GROUND_PAD tiles. */
export function groundBounds(compounds: Compound[]): Rect {
  const r = villageRect(compounds);
  return { x0: r.x0 - GROUND_PAD, y0: r.y0 - GROUND_PAD, w: r.w + 2 * GROUND_PAD, h: r.h + 2 * GROUND_PAD };
}

/** Art for a texture key produced by buildEntities. */
export function artFor(key: string): Art {
  const [kind, a, b, c, d, e] = key.split(':');
  switch (kind) {
    case 'hall': return drawHall();
    case 'house': return drawHouse(Number(a) as 0 | 1 | 2 | 3 | 4, b, c);
    case 'struct': return drawStructure(a as AgentKind, b as StructStage, Number(c));
    case 'wall': return drawWallSeg(a ?? '');
    case 'gate': return drawGate(a as 'n' | 's' | 'e' | 'w');
    case 'collector': return drawCollector(a as CollectorAgent, b === 'none' ? null : Number(b));
    case 'runestone': return drawRuneStone(a === 'lit');
    case 'board': return drawBoard(decodeURIComponent(a ?? ''), b || null);
    case 'builder': return drawBuilder(a as AgentKind, Number(b) as ClassTier, Number(c) as Gear, d as Pose, Number(e) as 1 | -1);
    case 'bubble': return drawBubble(a as 'needs' | 'stuck');
    case 'ring': return drawRing();
    case 'puff': return drawPuff();
    case 'path': return drawPathTile(a ?? '', Number(b));
    case 'gtree': return drawGroundTree(a === '1', Number(b));
    case 'shadow': return drawBuilderShadow();
    case 'status': return drawStatusBar(a as StatusTone, b);
    case 'hallplate': return drawHallPlate(key.slice('hallplate:'.length));
    default: throw new Error(`no art for ${key}`);
  }
}


// ---------------------------------------------------------------- builders

/** Where a builder's live session stands; null when it has none (idle on the plaza). */
interface Site {
  sessionId: string;
  workspaceId: string;
  compound: Compound;
  spot: Tile;
  state: SessionState['kind'];
  reachedFinished: boolean;
  /** Back after a relaunch, not resumed yet: the builder waits by it. */
  paused?: boolean;
  /** The ids of the session's running subagents, oldest first: its minions. */
  subagents: string[];
}

/** A subagent drawn as a small builder by its session's builder (see `minions`). */
interface MinionView {
  sprite: Sprite;
  shadow: Sprite;
  /** Its place among the builder's minions (`minionSpots`, `trailOffset`), kept for as long as it lives. */
  slot: number;
  /** Where it stands now, in tiles; NaN until its first frame. */
  x: number;
  y: number;
  /** Seconds since it appeared, and since its subagent stopped (null while it runs). */
  age: number;
  gone: number | null;
  /** 0..1: keeps its hammer and steps out of time with the builder's. */
  phase: number;
  pose: Pose;
}

interface BuilderView {
  walker: Walker;
  agent: AgentKind;
  cls: ClassTier;
  gear: Gear;
  site: Site | null;
  /** At its site, drawn over this depth: every structure in the compound and the house (see `siteDepth`). */
  siteZ: number;
  pose: Pose;
  sprite: Sprite;
  bubble: Sprite | null;
  ring: Sprite | null;
  /** Its contact shadow, on the ground. */
  shadow: Sprite;
  puffs: Sprite[];
  /** The compound a builder is walking home from, to re-aim if its house (and gate) moves. */
  leaving: { wsId: string; c: Compound } | null;
  /** Picked up by the owner: the tile point it hangs over (not walking meanwhile). */
  held: Tile | null;
  /** Its session's subagents, by id, including ones shrinking away. */
  minions: Map<string, MinionView>;
  /** Where its minions stand while it works at its site, by slot. */
  minionSpots: MinionSpot[];
}

const HEAD_HEIGHT: Record<ClassTier, number> = { 0: 56, 1: 64, 2: 80, 3: 88 };
/** A builder's shadow by class, as the figures grow with it. */
const SHADOW_SIZE: Record<ClassTier, number> = { 0: 0.9, 1: 1, 2: 1.15, 3: 1.25 };

/** The depth a builder at work in compound `c` is drawn over: the house's and every structure's front corner. */
export function siteDepth(c: Compound, spots: readonly Tile[]): number {
  // the house and structures sort by their front corner plus their kind's rank (see `ent`): outrank them
  return Math.max(c.house.x + c.house.y + 2 * HOUSE, ...spots.map((s) => s.x + s.y + 2 * STRUCT)) + KIND_RANK.builder * 0.001;
}
/** Px a picked-up builder hangs above the tile it would be set down on. */
const HELD_LIFT = 18;
const WALK_PERIOD = 0.25;
/** A cheering builder hops in place: one hop every HOP_PERIOD s, HOP_PX world px high. */
const HOP_PERIOD = 0.6;
const HOP_PX = 9;

/**
 * A cheering builder's hop at `time` (seconds; `phase` 0-1 staggers builders): how high its feet are
 * (world px) and its squash (1 = none) as it lands and pushes off.
 */
export function hopOf(time: number, phase: number): { lift: number; squash: number } {
  const t = (((time / HOP_PERIOD + phase) % 1) + 1) % 1;
  const AIR = 0.75; // of each hop in the air; the rest on the ground, squashed
  if (t < AIR) {
    const u = t / AIR;
    return { lift: HOP_PX * 4 * u * (1 - u), squash: 1 };
  }
  return { lift: 0, squash: 1 - 0.1 * Math.sin(((t - AIR) / (1 - AIR)) * Math.PI) };
}

const hashOf = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
};

/** The session a builder is working: its newest live one, else its newest ended one. */
function siteOf(b: Builder, state: VillageInput, compounds: Map<string, Compound>): Site | null {
  let best: SessionInfo | null = null;
  for (const s of state.sessions) {
    if (s.kind.kind !== 'agent' || s.kind.builderId !== b.id || !s.spot || !compounds.has(s.workspaceId)) continue;
    const rank = (x: SessionInfo) => (x.state.kind === 'ended' ? 0 : 1);
    const better = !best || rank(s) > rank(best) || (rank(s) === rank(best) && s.startedAt > best.startedAt);
    if (better) best = s;
  }
  if (!best || !best.spot) return null;
  return {
    sessionId: best.id, workspaceId: best.workspaceId, compound: compounds.get(best.workspaceId)!,
    spot: best.spot, state: best.state.kind, reachedFinished: best.reachedFinished, paused: best.paused,
    subagents: (best.subagents ?? []).map((a) => a.id),
  };
}

/** Pose from what the builder is doing and what its session is doing. */
export function poseOf(w: Walker, site: Site | null, time: number): Pose {
  if (w.path.length) return Math.floor(time / WALK_PERIOD) % 2 ? 'walk1' : 'walk0';
  if (w.mode !== 'atSite' || !site || site.paused) return 'idle';
  switch (site.state) {
    case 'starting':
    case 'working': return hammerPose(time, (hashOf(site.sessionId) % 997) / 997);
    case 'finished': return 'cheer';
    case 'stuck': return 'sad';
    case 'ended': return site.reachedFinished ? 'cheer' : 'sad';
    default: return 'idle';
  }
}

// ---------------------------------------------------------------- Pixi part

export interface SceneDebug {
  fps: number;
  running: boolean;
  entities: Array<{ id: string; kind: EntityKind; x: number; y: number; mode?: Walker['mode']; pose?: string }>;
  groundBakes: number;
  /** Live particles (dust, smoke, orbs, floating text). */
  particles: number;
  /** The minions standing by the builders, one per running subagent (none while shrinking away). */
  minions: Array<{ id: string; builderId: string; x: number; y: number; pose: string }>;
  cam: Cam;
  /** Client (window) position of an entity's clickable middle: an entity id, or a workspace id for its house. */
  screenOf(id: string): { x: number; y: number } | null;
}

export interface SceneOptions {
  /** A click (or double-click on a compound) picked this, or null for empty ground. */
  onSelect?: (sel: Selection | null) => void;
  /** Width of the panel currently covering the right of the window (0 when closed). */
  panelWidth?: () => number;
  /** Whether the structure/house may stand with its top-left on this tile (drives the green/red footprint). */
  canMove?: (t: MoveTarget, at: Tile) => boolean;
  /** Persist a move released on a valid tile; resolves false when it was not applied. */
  onMove?: (t: MoveTarget, at: Tile) => Promise<boolean>;
  /** Hook: a drag was released on a blocked tile (nothing persisted, the object snapped back; the scene adds the dust). */
  onBlockedDrop?: (at: Tile) => void;
  /** An idle builder was dropped on a workspace: offer to start a session there with it. */
  onBuilderAssign?: (builderId: string, workspaceId: string) => void;
  /** A builder being dragged just came over a workspace it could be dropped on. */
  onBuilderOver?: (workspaceId: string) => void;
  /** The scene has played (or given up on) the close outcome for this session id. */
  onClosedConsumed?: (sessionId: string) => void;
  /** An app board was clicked: open its app. */
  onOpenApp?: (board: BoardInput) => void;
}

export interface Scene {
  sync(state: VillageInput): void;
  destroy(): void;
  world: Container;
  debug(): SceneDebug;
  /** Ease the camera to fit the whole village. */
  fitVillage(): void;
  /** Ease the camera to fit a workspace's compound into the space left of the panel (as a double-click does). */
  fitCompound(workspaceId: string): void;
  /** Ease-zoom by `factor` around the centre of the area left of the panel. */
  zoomBy(factor: number): void;
  /** Pan (eased) just enough that the selected thing is not under the panel. */
  reveal(sel: Selection | null): void;
  /** Tell the scene which thing is selected (draws the move affordance for structures and houses). */
  select(sel: Selection | null): void;
  /** A full-window view covers the village: stop drawing it until uncovered. */
  setCovered(covered: boolean): void;
  /** Where the selected thing is in the window (CSS px) and roughly how big, for pointing at it; null when not drawn. */
  locate(sel: Selection): { x: number; y: number; r: number } | null;
}

/** Rough on-screen radius of each kind at zoom 1, world px (for pointing at one). */
const LOCATE_R: Partial<Record<EntityKind, number>> = { hall: 150, house: 105, structure: 70, collector: 70, builder: 34 };

const GROUND_SEED = 7;
/**
 * Live scenes, newest last; the dev driver always points at the newest one. React StrictMode
 * creates two and destroys one, in either order, so a single "owner" slot is not enough.
 */
interface DriverHooks { snapshot: () => Promise<string>; debug: () => SceneDebug }
const liveScenes: DriverHooks[] = [];
function publishToDriver(): void {
  setVillageSnapshot(liveScenes[liveScenes.length - 1]?.snapshot ?? null); // for bug report screenshots
  if (!import.meta.env.DEV) return;
  void import('../driver').then((d) => {
    const top = liveScenes[liveScenes.length - 1];
    d.registerSnapshot(top ? top.snapshot : async () => '');
    d.registerScene(top ? top.debug : () => null);
  });
}
const FPS_FOCUSED = 30;
const FPS_BLURRED = 15;

/**
 * Renderer settings. No MSAA: the art is baked at 2x density, and 4x multisampling at 2x
 * resolution multiplies the canvas' colour and depth/stencil buffers by 4. Measured on a release
 * build: ~120 MB of graphics memory (app total 299 -> 178 MB idle; the budget is 250 MB).
 */
export function rendererOptions(dpr: number) {
  return {
    resolution: dpr,
    autoDensity: true,
    antialias: false,
    preference: 'webgl' as const,
    background: '#5aa832',
  };
}

/** A seamless 512px grass tile (drawn at 2x density, shown at half size) for the ground beyond the baked village. */
function grassTile(): HTMLCanvasElement {
  const N = 512, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5aa832'; g.fillRect(0, 0, N, N);
  let s = 7;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const wrap = (x: number, y: number, f: (x: number, y: number) => void) => {
    for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) f(x + dx, y + dy);
  };
  for (let i = 0; i < 40; i++) {
    const x = rnd() * N, y = rnd() * N, rx = 40 + rnd() * 80, ry = rx / 2, rgb = rnd() < 0.5 ? '120,196,64' : '62,130,34';
    wrap(x, y, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, rx);
      gr.addColorStop(0, `rgba(${rgb},.5)`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.beginPath(); g.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2); g.fill();
    });
  }
  g.strokeStyle = 'rgba(40,100,20,.5)'; g.lineWidth = 2;
  for (let i = 0; i < 120; i++) {
    wrap(rnd() * N, rnd() * N, (x, y) => {
      g.beginPath(); g.moveTo(x - 4, y); g.lineTo(x - 1, y - 7); g.moveTo(x, y); g.lineTo(x + 1, y - 8); g.moveTo(x + 4, y); g.lineTo(x + 5, y - 6); g.stroke();
    });
  }
  return c;
}

export async function createScene(canvasHost: HTMLElement, opts: SceneOptions = {}): Promise<Scene> {
  const app = new Application();
  await app.init({ resizeTo: canvasHost, ...rendererOptions(window.devicePixelRatio || 1) });
  await prepareArt();
  canvasHost.appendChild(app.canvas);

  // view holds the layers and is what the camera transforms.
  const view = new Container();
  const groundLayer = new Container();
  const world = new Container({ sortableChildren: true });
  const overlay = new Container({ sortableChildren: true });
  view.addChild(groundLayer, world, overlay);
  // endless grass behind the baked ground: it follows the camera so zooming out never shows a bare edge
  const meadow = new TilingSprite({ texture: Texture.from(grassTile()), width: 1, height: 1 });
  app.stage.addChild(meadow, view);

  const ground = new Sprite(Texture.EMPTY);
  groundLayer.addChild(ground);
  const paths = new Container(); // the dirt path tiles, over the grass and under everything else
  groundLayer.addChild(paths);
  const pathTrees = new Container(); // the ground's trees in front of a path, whose canopies reach over it
  groundLayer.addChild(pathTrees);
  const shadows = new Container(); // the builders' contact shadows, on the ground under every building
  groundLayer.addChild(shadows);
  const fx = new Graphics(); // footprint glow, tile grid, green/red footprint: redrawn only when it changes
  groundLayer.addChild(fx);
  const fxTop = new Graphics(); // the green/red drag footprint, above the sprites so a blocking building cannot hide it
  overlay.addChild(fxTop);
  let groundKey = '';
  let groundBakes = 0;
  let villageTiles: Rect | null = null;
  let workspaces: Workspace[] = [];

  const sprites = new Map<string, { sprite: Sprite; key: string; entity: Entity; ws?: string; base: { x: number; y: number } }>();
  let entities: Entity[] = [];
  let lastState: VillageInput = { workspaces: [], sessions: [], builders: [] };
  let destroyed = false;
  const views = new Map<string, BuilderView>();
  // Every sprite under `view` (visible or not, ghosts included) holds its texture: the cache never destroys those.
  const unholdTextures = holdTextures(() => spriteTextures(view));
  // Status bars: labels are minute-quantized, so checking once a second re-syncs at most once a minute
  // per structure (or sooner when steps/state change, which syncs anyway).
  let statusSig = '';
  let statusClock = 0;
  app.ticker.add((t) => {
    statusClock += t.deltaMS;
    if (statusClock < 1000) return;
    statusClock = 0;
    const now = Date.now();
    if (statusesDue(entities, lastState.sessions, now, [...collectorEntities(lastState, now), ...boardEntities(lastState)]) !== statusSig) sync(lastState);
  });
  let releaseClock = 0;
  app.ticker.add((t) => { // between syncs, evictions by builder poses are released every few seconds
    releaseClock += t.deltaMS;
    if (releaseClock > 5000) { releaseClock = 0; releaseRetired(); }
  });
  let time = 0;

  // ---- lifecycle effects (see effects.ts): pooled particles plus a few sprite tweens
  const fxLayer = new Container({ sortableChildren: true });
  overlay.addChild(fxLayer);
  const particles = new Particles();
  const fxRender = new FxRenderer(fxLayer, particles);
  let fxClock = 0;
  const pops = new Map<string, number>(); // structure id -> seconds since it appeared
  const ghosts: Array<{ sprite: Sprite; t: number }> = []; // closed structures being taken down
  const relocs = new Map<string, { ox: number; oy: number; t: number }>(); // workspace -> remaining pixel offset
  const pendingClose = new Map<string, { wsId: string; from: { x: number; y: number }; until: number }>();
  let prevSnap: Snap | null = null;
  const OUTCOME_WAIT = 2; // seconds to wait for the close outcome after a structure vanishes
  const easeOutBack = (k: number) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
  const smooth = (k: number) => k * k * (3 - 2 * k);
  const relocOffset = (ws: string | undefined) => {
    const r = ws ? relocs.get(ws) : undefined;
    if (!r) return null;
    const k = 1 - smooth(Math.min(1, r.t / RELOCATE_SECONDS));
    return { x: r.ox * k, y: r.oy * k };
  };
  const applyRelocs = () => {
    if (!relocs.size) return;
    for (const rec of sprites.values()) {
      const o = relocOffset(rec.ws);
      if (o) rec.sprite.position.set(rec.base.x + o.x, rec.base.y + o.y);
    }
  };
  const playOrbs = (from: { x: number; y: number }, wsId: string, o: CloseOutcome) => {
    const c = lastState.workspaces.find((w) => w.id === wsId)?.compound;
    if (!c) return;
    const h = iso(c.house.x + HOUSE / 2, c.house.y + HOUSE / 2);
    const to = { x: h.x, y: h.y - 40 };
    particles.orbs(from, to, 8);
    particles.later(ORB_SECONDS + 0.2, () => {
      particles.floatText({ x: to.x, y: to.y - 30 }, `+${o.xpGained} XP`, '#ffffff');
      particles.dust(h, 5, false);
      if (o.levelAfter > o.levelBefore) particles.floatText({ x: to.x, y: to.y - 64 }, 'LEVEL UP!', '#ffe066');
    });
  };
  const updateFx = (dt: number) => {
    if (!pops.size && !ghosts.length && !relocs.size && !pendingClose.size && particles.idle) return; // nothing playing
    fxClock += dt;
    for (const [id, t0] of pops) {
      const t = t0 + dt, rec = sprites.get(id);
      if (!rec || t >= POP_SECONDS) { pops.delete(id); rec?.sprite.scale.set(0.5); continue; }
      pops.set(id, t);
      rec.sprite.scale.set(0.5 * Math.max(0.01, easeOutBack(t / POP_SECONDS)));
    }
    for (let i = ghosts.length - 1; i >= 0; i--) {
      const g = ghosts[i];
      g.t += dt;
      const k = g.t / 0.5;
      if (k >= 1) { g.sprite.destroy(); ghosts.splice(i, 1); continue; }
      g.sprite.scale.set(0.5 * (1 + 0.15 * k), 0.5 * (1 - k));
      g.sprite.alpha = 1 - k;
    }
    if (relocs.size) {
      for (const [ws, r] of relocs) { r.t += dt; if (r.t >= RELOCATE_SECONDS) relocs.delete(ws); }
      for (const rec of sprites.values()) {
        if (rec.ws && !relocs.has(rec.ws)) rec.sprite.position.set(rec.base.x, rec.base.y);
      }
      applyRelocs();
      if (!relocs.size) syncGround(lastState.workspaces.flatMap((w) => (w.compound ? [w.compound] : [])), lastState); // the one re-bake
    }
    for (const [id, p] of pendingClose) {
      if (fxClock > p.until) { pendingClose.delete(id); opts.onClosedConsumed?.(id); }
    }
    particles.update(dt);
    fxRender.draw();
  };

  // ---- frame policy: 30 fps focused, 15 unfocused, stopped while hidden/minimized
  const ticks: number[] = [];
  const applyCap = () => {
    const cap = document.hasFocus() ? FPS_FOCUSED : FPS_BLURRED;
    if (app.ticker.maxFPS !== cap) app.ticker.maxFPS = cap;
  };
  let lastCapCheck = 0;
  const countFrame = () => {
    const now = performance.now();
    ticks.push(now);
    while (ticks.length && ticks[0] < now - 1000) ticks.shift();
    // focus/blur events can arrive before the webview reports focus (e.g. on un-hide); re-check twice a second
    if (now - lastCapCheck > 500) { lastCapCheck = now; applyCap(); }
  };
  app.ticker.add(countFrame);
  // a full-window view (an app or terminal popped out, a Kanban) hides the village: no drawing under it
  let covered = false;
  const onVisibility = () => {
    if (document.hidden || covered) {
      app.ticker.stop();
      ticks.length = 0;
    } else {
      applyCap();
      app.ticker.start();
    }
  };
  const setCovered = (c: boolean) => {
    if (c === covered || destroyed) return;
    covered = c;
    onVisibility();
  };
  window.addEventListener('focus', applyCap);
  window.addEventListener('blur', applyCap);
  document.addEventListener('visibilitychange', onVisibility);
  applyCap();
  if (document.hidden) app.ticker.stop();

  // ---- camera: screen = world * zoom + (x, y). Eased only while a target is set.
  let cam: Cam = { x: 0, y: 0, zoom: 1 };
  let camTarget: Cam | null = null;
  let autoFit = true; // follow the village rect until the user moves the camera
  const applyCam = () => {
    view.scale.set(cam.zoom);
    view.position.set(cam.x, cam.y);
    meadow.position.set(0, 0);
    meadow.width = app.screen.width; meadow.height = app.screen.height;
    meadow.tileScale.set(cam.zoom / 2);
    meadow.tilePosition.set(cam.x, cam.y);
  };
  const panelW = () => opts.panelWidth?.() ?? 0;
  const villageCam = (): Cam | null =>
    villageTiles ? fitRect(pxRectOfTiles(villageTiles), app.screen.width, app.screen.height, panelW(), 1) : null;
  const jumpTo = (c: Cam) => { cam = c; camTarget = null; applyCam(); };
  const fit = () => {
    const c = villageCam();
    if (c) jumpTo(c);
  };
  const fitVillage = () => {
    const c = villageCam();
    if (!c) return;
    autoFit = true;
    camTarget = c;
  };
  const onResize = () => { if (autoFit) fit(); };
  app.renderer.on('resize', onResize);
  app.ticker.add((t) => {
    if (!camTarget) return; // idle: no camera work
    cam = ease(cam, camTarget, Math.min(t.deltaMS / 1000, 0.25));
    if (cam.x === camTarget.x && cam.y === camTarget.y && cam.zoom === camTarget.zoom) camTarget = null;
    applyCam();
  });

  /**
   * Upload the ground now and drop the canvas' pixels: the GPU copy is all it needs (the source is
   * not garbage-collected, and a lost WebGL context re-bakes below). If the upload cannot be forced,
   * the canvas is kept and Pixi uploads it lazily as usual.
   */
  const uploadAndRelease = (tex: Texture, canvas: HTMLCanvasElement) => {
    try { app.renderer.texture.initSource(tex.source); } catch { return; }
    canvas.width = 1;
    canvas.height = 1;
  };
  const onContextRestored = () => {
    groundKey = ''; // the released canvas cannot be re-uploaded: bake again
    syncGround(lastState.workspaces.flatMap((w) => (w.compound ? [w.compound] : [])), lastState);
  };
  app.canvas.addEventListener('webglcontextrestored', onContextRestored);
  const syncGround = (compounds: Compound[], state: VillageInput) => {
    const b = groundBounds(compounds);
    // trees are baked into the ground, so each collector clears its own patch of forest
    const clearings = Object.values(collectorTiles(shownCollectors(state.quotas, state.installed), state.collectorSpots, compounds))
      .map((t): Rect => ({ x0: t.x, y0: t.y, w: STRUCT, h: STRUCT }));
    const key = JSON.stringify([b, compounds.map((c) => [c.x0, c.y0, c.w, c.h, c.house.x, c.house.y]), clearings]);
    if (key === groundKey) return;
    groundKey = key;
    const old = ground.texture;
    const tiles = pathTiles(compounds);
    const lifted = treesOverPaths(b, compounds, GROUND_SEED, clearings, tiles);
    trees = indexTrees(groundTrees(b, compounds, GROUND_SEED, clearings));
    const liftedAt = new Set(lifted.map((t) => `${t.x},${t.y}`));
    // half density (see GROUND_SCALE), shown at 2x; the trees over a path stand over it instead
    const canvas = drawGround(b, compounds, GROUND_SEED, clearings, (t) => liftedAt.has(`${t.x},${t.y}`));
    const tex = Texture.from(canvas);
    ground.texture = tex;
    if (old !== Texture.EMPTY) old.destroy(true);
    uploadAndRelease(tex, canvas);
    const o = groundOrigin(b);
    ground.position.set(o.x, o.y);
    ground.scale.set(1 / GROUND_SCALE);
    groundBakes++;
    syncPaths(tiles, lifted);
    const first = villageTiles === null;
    const next = villageRect(compounds);
    const changed = needsRefit(villageTiles, next);
    villageTiles = next;
    if (autoFit && changed) {
      if (first) fit();
      else fitVillage(); // the village grew: ease to the new extent
    }
  };


  /** Lay the path tiles afresh (only when the ground is re-baked: the compounds moved or changed). */
  const syncPaths = (tiles: Map<string, Tile>, lifted: GroundTree[]) => {
    for (const sp of paths.removeChildren()) sp.destroy();
    for (const t of [...tiles.values()].sort((a, b) => a.x + a.y - (b.x + b.y))) {
      const sp = new Sprite();
      sp.scale.set(0.5);
      setTex(sp, `path:${pathLinks(tiles, t)}:${(((t.x * 7 + t.y * 13) % 3) + 3) % 3}`);
      const p = iso(t.x + 1, t.y + 1);
      sp.position.set(p.x, p.y);
      paths.addChild(sp);
    }
    // a few sizes of tree texture, each scaled to the tree's own
    for (const sp of pathTrees.removeChildren()) sp.destroy();
    for (const t of lifted) {
      const q = Math.round(t.s * 10) / 10;
      const sp = new Sprite();
      setTex(sp, `gtree:${t.pine ? 1 : 0}:${q}`);
      sp.scale.set((0.5 * t.s) / q);
      const p = iso(t.x, t.y);
      sp.position.set(p.x, p.y);
      pathTrees.addChild(sp);
    }
  };

  const texOf = (key: string) => getTexture(key, () => artFor(key));
  const setTex = (sp: Sprite, key: string) => {
    const t = texOf(key);
    if (sp.texture === t.texture) return;
    sp.texture = t.texture;
    sp.anchor.set(t.ax / t.texture.width, t.ay / t.texture.height);
  };
  const makeSprite = (layer: Container, key: string) => {
    const sp = new Sprite();
    sp.scale.set(0.5);
    setTex(sp, key);
    layer.addChild(sp);
    return sp;
  };

  /** Walkable ground inside a compound (see `walkable`). */
  const walkFor = (state: VillageInput, wsId: string, c: Compound) => {
    const spots = spotsIn(state.sessions, wsId, state.boards);
    const level = state.workspaces.find((w) => w.id === wsId)?.level ?? 1;
    return walkable(enclosure(c, spots, level, seedOf(wsId)).inside, c, spots);
  };

  /** Ground the builders keep off outside the compounds (see `Blocked`); set by `syncBuilders`. */
  let blocked: Blocked = () => false;
  /** The ground's trees, for keeping builders out from under them; set by `syncGround`. */
  let trees: TreeIndex = new Map();

  /** Bring the walkers in line with the store. The walk is cosmetic: nothing here waits on it. */
  const syncBuilders = (state: VillageInput) => {
    const compounds = new Map<string, Compound>();
    for (const w of state.workspaces) if (w.compound) compounds.set(w.id, w.compound);
    const tanks = Object.values(collectorTiles(shownCollectors(state.quotas, state.installed), state.collectorSpots, [...compounds.values()]));
    const offLimits = blockedBy([
      grow(HALL, KEEP_OFF.hall),
      ...tanks.map((t) => grow({ x0: t.x, y0: t.y, w: STRUCT, h: STRUCT }, KEEP_OFF.collector)),
      ...[...compounds.values()].map((c) => grow(wallRect(c), KEEP_OFF.wall)),
    ]);
    // and never in a trunk or under a canopy in front (the trees are drawn under the builders)
    blocked = (p) => offLimits(p) || underTree(trees, p);
    // Walkable ground per compound, built only for the compounds a walker is routed through.
    const walks = new Map<string, Set<string>>();
    const walkOf = (wsId: string, c: Compound) => {
      let walk = walks.get(wsId);
      if (!walk) { walk = walkFor(state, wsId, c); walks.set(wsId, walk); }
      return walk;
    };
    const live = new Set<string>();
    for (const b of state.builders) {
      live.add(b.id);
      const site = siteOf(b, state, compounds);
      let v = views.get(b.id);
      if (!v) {
        const a = (hashOf(b.id) % 360) * (Math.PI / 180);
        const sprite = new Sprite();
        sprite.scale.set(0.5);
        world.addChild(sprite);
        const shadow = makeSprite(shadows, 'shadow');
        v = {
          walker: { id: b.id, ...plazaPoint({ x: 0.5 + Math.cos(a), y: 0.5 + Math.sin(a) }, blocked), path: [], mode: 'idle', face: 1, wait: 0.5 },
          agent: b.agent, cls: classOf(b.agent, b.model), gear: gearOf(b.effort), site: null,
          pose: 'idle', sprite, shadow, bubble: null, ring: null, puffs: [], leaving: null, held: null, siteZ: 0, minions: new Map(), minionSpots: [],
        };
        views.set(b.id, v);
      }
      v.agent = b.agent; v.cls = classOf(b.agent, b.model); v.gear = gearOf(b.effort);
      const w = v.walker, was = v.site;
      if (site) {
        if (!was || was.sessionId !== site.sessionId) {
          v.walker = { ...w, mode: 'toSite', anchor: undefined, path: routeToSite(w, site.compound, site.spot, walkOf(site.workspaceId, site.compound)) };
        } else if (was.spot.x !== site.spot.x || was.spot.y !== site.spot.y) {
          const st = standTile(site.compound, site.spot, site.compound.house, walkOf(site.workspaceId, site.compound)); // moved structure: the builder is simply there
          v.walker = { ...w, x: st.x, y: st.y, path: [], mode: 'atSite', face: -1 };
        } else if (JSON.stringify(was.compound) !== JSON.stringify(site.compound)) {
          v.walker = retarget(w, site.compound, site.spot, walkOf(site.workspaceId, site.compound)); // the house moved: stand tile and gate may have changed
        }
      } else if (was) {
        const c = compounds.get(was.workspaceId);
        if (!c) v.walker = { ...w, path: [], mode: 'idle', wait: 0.5 };
        else {
          v.leaving = { wsId: was.workspaceId, c };
          const walk = walkOf(was.workspaceId, c);
          const route = routeHome(w, c, walk, blocked);
          // a builder still outside the walls turns around on the plaza side
          v.walker = { ...w, mode: 'home', path: w.mode === 'toSite' && !onGround(walk, w) ? route.slice(-1) : route };
        }
      }
      if (site) v.leaving = null;
      else if (v.leaving) {
        const c = compounds.get(v.leaving.wsId);
        if (c && JSON.stringify(c) !== JSON.stringify(v.leaving.c)) {
          if (v.walker.mode === 'home') v.walker = retarget(v.walker, c, null, walkOf(v.leaving.wsId, c), blocked);
          v.leaving = { wsId: v.leaving.wsId, c };
        }
        if (v.walker.mode !== 'home') v.leaving = null;
      }
      v.site = site;
      if (site) v.siteZ = siteDepth(site.compound, spotsIn(state.sessions, site.workspaceId, state.boards));
      syncMinions(v, site && !site.paused ? shownMinions(site.subagents) : []);
      if (site && v.minions.size) {
        const walk = walkOf(site.workspaceId, site.compound);
        const level = state.workspaces.find((x) => x.id === site.workspaceId)?.level ?? 1;
        const spots = spotsIn(state.sessions, site.workspaceId, state.boards);
        const inside = enclosure(site.compound, spots, level, seedOf(site.workspaceId)).inside;
        v.minionSpots = minionSpots(standTile(site.compound, site.spot, site.compound.house, walk), walk, inside, MAX_MINIONS);
      }
    }
    for (const [id, v] of views) {
      if (live.has(id)) continue;
      for (const sp of [v.sprite, v.shadow, v.bubble, v.ring, ...v.puffs]) sp?.destroy();
      for (const m of v.minions.values()) { m.sprite.destroy(); m.shadow.destroy(); }
      views.delete(id);
    }
  };

  /** A minion for each of `ids`; the others shrink away (see `updateMinions`). */
  const syncMinions = (v: BuilderView, ids: string[]) => {
    const want = new Set(ids);
    for (const [id, m] of v.minions) if (!want.has(id) && m.gone === null) m.gone = 0;
    for (const id of ids) {
      const m = v.minions.get(id);
      if (m) { m.gone = null; continue; } // stopped and started again before it was gone
      const used = new Set([...v.minions.values()].map((o) => o.slot));
      let slot = 0;
      while (used.has(slot) && slot < MAX_MINIONS) slot++;
      const sprite = new Sprite();
      world.addChild(sprite);
      v.minions.set(id, { sprite, shadow: makeSprite(shadows, 'shadow'), slot, x: NaN, y: NaN, age: 0, gone: null, phase: (hashOf(id) % 97) / 97, pose: 'idle' });
    }
  };

  /**
   * Minions follow their builder, then stand on open ground by it at its site (`minionSpots`) and
   * hammer away, each out of step with it.
   */
  const updateMinions = (v: BuilderView, dt: number, ro: { x: number; y: number } | null) => {
    const w = v.walker;
    const atSite = !!v.site && w.mode === 'atSite' && !v.held;
    const follow = 1 - Math.exp(-dt * 6);
    for (const [id, m] of v.minions) {
      const off = trailOffset(m.slot);
      const spot = atSite ? v.minionSpots[m.slot] : undefined;
      const to = spot ?? { x: w.x + off.x, y: w.y + off.y };
      if (Number.isNaN(m.x)) { // its first frame: it appears in a puff where it stands
        m.x = to.x; m.y = to.y;
        const p = iso(m.x, m.y);
        particles.dust({ x: p.x + (ro?.x ?? 0), y: p.y + (ro?.y ?? 0) }, 6, false);
      }
      const dx = to.x - m.x, dy = to.y - m.y;
      const moving = Math.hypot(dx, dy) > 0.08;
      m.x += dx * follow; m.y += dy * follow;
      m.age += dt;
      if (m.gone !== null) m.gone += dt;
      const k = popScale(m.age, m.gone);
      if (m.gone !== null && k <= 0) {
        m.sprite.destroy(); m.shadow.destroy();
        v.minions.delete(id);
        continue;
      }
      // its subagent is at work even when its builder's turn is over (subagents run on in the background)
      const pose: Pose = moving || v.pose.startsWith('walk') ? (Math.floor(time / WALK_PERIOD + m.phase * 2) % 2 ? 'walk1' : 'walk0')
        : v.held ? 'idle' : hammerPose(time, m.phase);
      m.pose = pose;
      const face = moving && Math.abs(dx - dy) > 0.05 ? (dx - dy > 0 ? 1 : -1) : w.face;
      setTex(m.sprite, `builder:${v.agent}:0:0:${pose}:${face}`);
      const p = iso(m.x, m.y);
      const x = p.x + (ro?.x ?? 0), y = p.y + (ro?.y ?? 0);
      const size = 0.5 * MINION_SCALE * k;
      m.sprite.position.set(x, y);
      m.sprite.scale.set(size);
      // its own depth (its spot is clear of anything in front that would cover it); one huddled at its
      // builder's feet is drawn with the builder, over the site
      const depth = m.x + m.y + KIND_RANK.builder * 0.001;
      m.sprite.zIndex = (spot?.huddled && !moving ? v.siteZ : depth) + 0.0001 * (1 + m.slot);
      setTex(m.shadow, 'shadow');
      m.shadow.position.set(x, y);
      m.shadow.scale.set(size * SHADOW_SIZE[0]);
    }
  };

  const updateBuilders = (dt: number) => {
    time += dt;
    for (const v of views.values()) {
      const before = v.walker.mode;
      // a held builder hangs over the pointer instead of walking
      // idle builders stop clear of where the others stand or are heading (asked only when picking a spot)
      const taken: Blocked = (p) => takenBy([...views.values()].flatMap((o) => (o === v ? [] : [o.walker, o.walker.path[o.walker.path.length - 1] ?? o.walker])))(p);
      v.walker = v.held ? { ...v.walker, x: v.held.x, y: v.held.y } : step(v.walker, dt, Math.random, blocked, taken);
      const w = v.walker;
      if (before !== 'atSite' && w.mode === 'atSite') w.face = -1; // look at the structure
      v.pose = v.held ? 'cheer' : poseOf(w, v.site, time);
      setTex(v.sprite, `builder:${v.agent}:${v.cls}:${v.gear}:${v.pose}:${w.face}`);
      const p = iso(w.x, w.y);
      const ro = relocOffset(v.site?.workspaceId);
      const hop = v.pose === 'cheer' && !v.held ? hopOf(time, (hashOf(w.id) % 100) / 100) : { lift: 0, squash: 1 };
      v.sprite.position.set(p.x + (ro?.x ?? 0), p.y + (ro?.y ?? 0) - (v.held ? HELD_LIFT : 0) - hop.lift);
      v.sprite.scale.set(0.5 * (2 - hop.squash), 0.5 * hop.squash); // feet planted: the anchor is at the feet
      v.sprite.zIndex = v.held ? 20000 : w.x + w.y + KIND_RANK.builder * 0.001;
      // the shadow stays on the ground, smaller and fainter while the builder is in the air
      v.shadow.visible = !v.held;
      if (!v.held) {
        setTex(v.shadow, 'shadow');
        const up = hop.lift / HOP_PX;
        v.shadow.position.set(p.x + (ro?.x ?? 0), p.y + (ro?.y ?? 0));
        v.shadow.scale.set(0.5 * SHADOW_SIZE[v.cls] * (1 - 0.25 * up));
        v.shadow.alpha = 1 - 0.35 * up;
      }
      // the stand tile sits beside the structure, often behind it, a neighbour or the house (whose
      // painted sprites reach past their footprints); hammering must stay visible
      if (v.site && w.mode === 'atSite' && !v.held) v.sprite.zIndex = v.siteZ;
      updateMinions(v, dt, ro);

      const st = v.site?.state;
      const needs = st === 'needsYou', stuck = st === 'stuck';
      if ((needs || stuck) && !v.bubble) v.bubble = makeSprite(overlay, 'bubble:needs');
      if (v.bubble) {
        v.bubble.visible = needs || stuck;
        if (needs || stuck) {
          setTex(v.bubble, `bubble:${needs ? 'needs' : 'stuck'}`);
          v.bubble.position.set(p.x, p.y - HEAD_HEIGHT[v.cls] + Math.sin(time * 6) * 2);
        }
      }
      if (needs && !v.ring) v.ring = makeSprite(groundLayer, 'ring');
      if (v.ring) {
        v.ring.visible = needs;
        if (needs && v.site) {
          setTex(v.ring, 'ring'); // re-fetched when shown: the cached texture may have been evicted and replaced
          const c = iso(v.site.spot.x + 1, v.site.spot.y + 1);
          const k = 0.5 * (0.92 + 0.12 * Math.sin(time * 4));
          v.ring.position.set(c.x, c.y);
          v.ring.scale.set(k);
          v.ring.alpha = 0.6 + 0.4 * Math.sin(time * 4 + 1);
        }
      }
      if (stuck && !v.puffs.length) for (let i = 0; i < 3; i++) v.puffs.push(makeSprite(overlay, 'puff'));
      v.puffs.forEach((pf, i) => {
        pf.visible = stuck;
        if (!stuck || !v.site) return;
        setTex(pf, 'puff');
        const f = (time * 0.35 + i / 3) % 1;
        const c = iso(v.site.spot.x + 1, v.site.spot.y + 1);
        pf.position.set(c.x + Math.sin(f * 6 + i) * 6, c.y - 40 - f * 46);
        pf.alpha = 1 - f;
        pf.scale.set(0.5 * (0.6 + f));
      });
    }
  };
  app.ticker.add((t) => updateBuilders(Math.min(t.deltaMS / 1000, 0.25)));
  app.ticker.add((t) => updateFx(Math.min(t.deltaMS / 1000, 0.25)));

  const sync = (state: VillageInput) => {
    if (destroyed) return;
    workspaces = state.workspaces;
    lastState = state;
    const compounds = state.workspaces.flatMap((w) => (w.compound ? [w.compound] : []));
    const snap: Snap = { structs: new Map(), compounds: new Map() };
    for (const w of state.workspaces) if (w.compound) snap.compounds.set(w.id, w.compound);
    for (const s of state.sessions)
      if (s.spot && snap.compounds.has(s.workspaceId)) snap.structs.set(`struct:${s.id}`, s.workspaceId);
    const ev = lifecycleEvents(prevSnap, snap);
    prevSnap = snap;
    for (const r of ev.relocated) {
      if (pending?.m.group === r.wsId) continue; // the owner dropped it there: no travel from the old site
      const d = iso(r.dx, r.dy), cur = relocOffset(r.wsId);
      relocs.set(r.wsId, { ox: -d.x + (cur?.x ?? 0), oy: -d.y + (cur?.y ?? 0), t: 0 });
    }
    if (!relocs.size) syncGround(compounds, state); // while a compound travels the old ground stays; it is re-baked once at the end
    syncBuilders(state);
    entities = buildEntities({ ...state, now: Date.now() });
    statusSig = statusSignature(entities);
    // Fetch every live texture first: this refreshes their LRU slots before anything new can evict them.
    const tex = entities.map((e) => getTexture(e.texKey, () => artFor(e.texKey)));
    const seen = new Set<string>();
    entities.forEach((e, i) => {
      seen.add(e.id);
      const t = tex[i];
      let rec = sprites.get(e.id);
      if (!rec) {
        const sprite = new Sprite();
        sprite.scale.set(0.5); // art is baked at 2x density
        (e.kind === 'status' ? overlay : world).addChild(sprite);
        rec = { sprite, key: '', entity: e, base: { x: 0, y: 0 } };
        sprites.set(e.id, rec);
      }
      const { sprite } = rec;
      rec.ws = e.id.startsWith('struct:') ? snap.structs.get(e.id)
        : e.kind === 'board' ? e.id.split(':')[1]
        : e.id.startsWith('status:board:') ? e.id.split(':')[2]
        : e.id.startsWith('status:house:') ? e.id.split(':')[2]
        : e.kind === 'status' ? snap.structs.get(`struct:${e.id.slice('status:'.length)}`)
        : e.kind === 'house' || e.kind === 'gate' || e.kind === 'wall' ? e.id.split(':')[1] : undefined;
      if (sprite.texture !== t.texture) {
        sprite.texture = t.texture;
        sprite.anchor.set(t.ax / t.texture.width, t.ay / t.texture.height);
      }
      rec.key = e.texKey;
      rec.entity = e;
      const p = iso(e.x, e.y);
      if (e.kind === 'status') p.y -= e.lift ?? STATUS_LIFT;
      rec.base = p;
      sprite.position.set(p.x, p.y);
      sprite.zIndex = e.depth;
    });
    const closedIds = new Map(ev.closed.map((c) => [c.id, c.wsId]));
    for (const [id, rec] of sprites) {
      if (seen.has(id)) continue;
      sprites.delete(id);
      pops.delete(id);
      const wsId = closedIds.get(id);
      if (wsId === undefined) { rec.sprite.destroy(); continue; } // textures stay in the shared cache
      // a closed structure comes down in dust; the sprite lingers as a collapsing ghost
      const at = { x: rec.base.x, y: rec.base.y - 32 };
      ghosts.push({ sprite: rec.sprite, t: 0 });
      particles.dust(at, 16, true);
      particles.smoke(at);
      particles.smoke(at);
      pendingClose.set(id.slice('struct:'.length), { wsId, from: { x: at.x, y: at.y - 20 }, until: fxClock + OUTCOME_WAIT });
    }
    for (const s of ev.spawned) {
      const rec = sprites.get(s.id);
      if (!rec) continue;
      pops.set(s.id, 0);
      rec.sprite.scale.set(0.5 * 0.01);
      particles.dust({ x: rec.base.x, y: rec.base.y - 32 }, 8, false);
    }
    for (const wsId of ev.expanded) {
      const c = snap.compounds.get(wsId)!;
      const r = wallRect(c);
      const top = iso(r.x0 + r.w / 2, r.y0 + r.h / 2);
      particles.floatText({ x: top.x, y: top.y - 70 }, 'Walls expanded!', '#ffffff');
      for (let i = 0; i < 12; i++) {
        const f = i / 12, per = 2 * (r.w + r.h);
        let d = f * per, x: number, y: number;
        if (d < r.w) { x = r.x0 + d; y = r.y0; }
        else if ((d -= r.w) < r.h) { x = r.x0 + r.w; y = r.y0 + d; }
        else if ((d -= r.h) < r.w) { x = r.x0 + r.w - d; y = r.y0 + r.h; }
        else { d -= r.w; x = r.x0; y = r.y0 + r.h - d; }
        particles.dust(iso(x, y), 2, false);
      }
    }
    // the outcome may arrive before or after the structure vanishes
    for (const [sid, p] of pendingClose) {
      const o = state.closed?.[sid];
      if (!o) continue;
      pendingClose.delete(sid);
      if (o.earnedXp) playOrbs(p.from, p.wsId, o);
      opts.onClosedConsumed?.(sid);
    }
    applyRelocs();
    applyDragSprite();
    redrawOverlay();
    releaseRetired(); // every live sprite has re-fetched its texture by now
  };

  const debug = (): SceneDebug => ({
    fps: app.ticker.started ? ticks.filter((t) => t >= performance.now() - 1000).length : 0,
    running: app.ticker.started,
    entities: [
      ...entities.map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y })),
      ...[...views].map(([id, v]) => ({
        id: `builder:${id}`, kind: 'builder' as const, x: v.walker.x, y: v.walker.y, mode: v.walker.mode, pose: v.pose,
      })),
    ],
    groundBakes,
    particles: particles.count,
    minions: [...views].flatMap(([builderId, v]) => [...v.minions].filter(([, m]) => m.gone === null)
      .map(([id, m]) => ({ id, builderId, x: m.x, y: m.y, pose: m.pose }))),
    cam: { ...cam },
    screenOf: (id) => {
      const e = hitEntities().find((x) => x.id === id) ?? hitEntities().find((x) => x.id === `house:${id}`);
      if (!e) return null;
      const p = clickPoint(e), q = worldToScreen(cam, p.x, p.y), r = app.canvas.getBoundingClientRect();
      return { x: q.x + r.left, y: q.y + r.top };
    },
  });


  // ---- move affordance: selected structure/house/collector shows a glow, arrows and a chip; dragging shows the grid.
  // A selected workspace drags as a whole compound (walls, house and structures); Option-drag moves only its house.
  /**
   * `entityId` is the drag handle. The footprint is `w` x `h` tiles from `tile` less `inset` (a compound's
   * tile is its interior origin, its footprint the walls). `compound`: where the grid is drawn while
   * dragging; null gets a patch of grid around the footprint. `group`: a workspace whose sprites all follow.
   */
  interface Movable {
    target: MoveTarget; entityId: string; w: number; h: number; inset: number; tile: Tile; compound: Compound | null;
    height: number; group?: string; chip: string;
  }
  const movableOf = (s: Selection | null, houseOnly = false): Movable | null => {
    if (s?.kind === 'workspace') {
      const w = lastState.workspaces.find((x) => x.id === s.id);
      const c = w?.compound;
      if (!c) return null;
      const height = HOUSE_LIFT[houseStage(w.level)] + PLATE_CLEAR; // over the name plate
      if (houseOnly)
        return { target: { kind: 'workspace', id: s.id }, entityId: `house:${s.id}`, w: HOUSE, h: HOUSE, inset: 0, tile: c.house, compound: c, height, chip: '' };
      return {
        target: { kind: 'compound', id: s.id }, entityId: `house:${s.id}`, w: c.w + 2, h: c.h + 2, inset: 1, tile: { x: c.x0, y: c.y0 },
        compound: null, height, group: s.id, chip: 'Drag to move \u00b7 \u2325 house only',
      };
    }
    if (s?.kind === 'session') {
      const x = lastState.sessions.find((q) => q.id === s.id);
      const c = x && lastState.workspaces.find((w) => w.id === x.workspaceId)?.compound;
      if (!x || !c || !x.spot) return null;
      return { target: { kind: 'session', id: x.id }, entityId: `struct:${x.id}`, w: STRUCT, h: STRUCT, inset: 0, tile: x.spot, compound: c, height: 100, chip: '' };
    }
    if (s?.kind === 'quota') {
      const e = entities.find((q) => q.id === `collector:${s.agent}`);
      if (!e) return null;
      return {
        target: { kind: 'collector', agent: s.agent }, entityId: e.id, w: STRUCT, h: STRUCT, inset: 0, tile: { x: e.x - STRUCT, y: e.y - STRUCT },
        compound: null, height: 110, chip: '',
      };
    }
    return null;
  };
  let selected: Selection | null = null;
  /** A committed move awaiting the store: glow, chip and ghost all stay on the new tile meanwhile. */
  let pending: { m: Movable; tile: Tile } | null = null;
  let od: { m: Movable; grab: { x: number; y: number }; moved: boolean; target: Tile; valid: boolean } | null = null;

  const ARROW_DIRS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
  const arrows = ARROW_DIRS.map(() => {
    const g = new Graphics().poly([11, 0, -7, -8, -7, 8]).fill({ color: 0xffd84a }).stroke({ width: 2, color: 0x1d130b });
    g.visible = false;
    overlay.addChild(g);
    return g;
  });
  const arrowBase = ARROW_DIRS.map(() => ({ x: 0, y: 0, dx: 0, dy: 0 }));
  const chip = new Container();
  const chipLabel = new Text({
    text: 'Drag to move',
    style: { fontFamily: 'Lilita One', fontSize: 16, fill: '#ffffff', stroke: { color: '#1d130b', width: 4 } },
    resolution: 2,
  });
  chipLabel.anchor.set(0.5);
  const chipBg = new Graphics();
  chip.addChild(chipBg, chipLabel);
  chip.visible = false;
  overlay.addChild(chip);
  const setChip = (text: string) => {
    if (chipLabel.text === text && chipBg.width) return;
    chipLabel.text = text;
    chipBg.clear().roundRect(-chipLabel.width / 2 - 10, -chipLabel.height / 2 - 3, chipLabel.width + 20, chipLabel.height + 6, 10)
      .fill({ color: 0x2b1d12, alpha: 0.85 }).stroke({ width: 2, color: 0xffd84a });
  };
  /** The footprint's top-left tile when the movable's tile is `t`. */
  const cornerOf = (m: Movable, t: Tile): Tile => ({ x: t.x - m.inset, y: t.y - m.inset });
  const footprint = (m: Movable, t: Tile) => {
    const o = cornerOf(m, t);
    const a = iso(o.x, o.y), b = iso(o.x + m.w, o.y), c = iso(o.x + m.w, o.y + m.h), d = iso(o.x, o.y + m.h);
    return [a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y];
  };
  let overlayKey = '';
  const redrawOverlay = () => {
    // a board is dragged without being selected (a click on it opens it)
    const m0 = od?.m.target.kind === 'board' ? od.m : movableOf(selected);
    const m = m0 && pending && pending.m.entityId === m0.entityId ? { ...m0, tile: pending.tile } : m0;
    const dragging = !!(od && od.moved);
    const key = JSON.stringify([m && [m.target, m.tile, m.compound], dragging && od && [od.target, od.valid]]);
    if (key === overlayKey) return;
    overlayKey = key;
    fx.clear();
    fxTop.clear();
    chip.visible = false;
    for (const a of arrows) a.visible = false;
    if (!m) return;
    if (dragging && od) {
      const o = cornerOf(m, od.target);
      const c = m.compound ?? { x0: o.x - 6, y0: o.y - 6, w: m.w + 12, h: m.h + 12 };
      for (let i = 0; i <= c.w; i++) { const a = iso(c.x0 + i, c.y0), b = iso(c.x0 + i, c.y0 + c.h); fx.moveTo(a.x, a.y).lineTo(b.x, b.y); }
      for (let j = 0; j <= c.h; j++) { const a = iso(c.x0, c.y0 + j), b = iso(c.x0 + c.w, c.y0 + j); fx.moveTo(a.x, a.y).lineTo(b.x, b.y); }
      fx.stroke({ width: 1, color: 0xffffff, alpha: 0.3 });
      fxTop.poly(footprint(m, od.target)).fill({ color: od.valid ? 0x5cf05c : 0xff3b2f, alpha: 0.4 })
        .stroke({ width: 4, color: od.valid ? 0x1f8a1f : 0xb02218 });
      return;
    }
    fx.poly(footprint(m, m.tile)).fill({ color: 0xffd84a, alpha: 0.35 }).stroke({ width: 3, color: 0xffd84a, alpha: 0.9 });
    const o = cornerOf(m, m.tile), cx = o.x + m.w / 2, cy = o.y + m.h / 2;
    ARROW_DIRS.forEach((d, i) => {
      const p = iso(cx + d.x * (m.w / 2 + 0.6), cy + d.y * (m.h / 2 + 0.6)), v = iso(d.x, d.y), n = Math.hypot(v.x, v.y);
      arrowBase[i] = { x: p.x, y: p.y, dx: v.x / n, dy: v.y / n };
      arrows[i].rotation = Math.atan2(v.y, v.x);
      arrows[i].position.set(p.x, p.y);
      arrows[i].visible = true;
    });
    // a compound's chip floats over its house, the drag handle
    const handle = m.group ? lastState.workspaces.find((w) => w.id === m.group)?.compound?.house : null;
    const top = handle ? iso(handle.x + HOUSE / 2, handle.y + HOUSE / 2) : iso(cx, cy);
    setChip(m.chip || 'Drag to move');
    chip.position.set(top.x, top.y - m.height - 22);
    chip.visible = true;
  };
  app.ticker.add(() => {
    if (!arrows[0].visible) return;
    const k = Math.sin(time * 4) * 3;
    arrows.forEach((a, i) => a.position.set(arrowBase[i].x + arrowBase[i].dx * k, arrowBase[i].y + arrowBase[i].dy * k));
  });
  /** While dragging, the object's sprite (or a compound's every sprite) follows the snapped target tile. */
  const applyDragSprite = () => {
    const g = od?.moved ? { m: od.m, t: od.target } : pending ? { m: pending.m, t: pending.tile } : null;
    if (!g) return;
    if (g.m.group) {
      // relative to where the store has the compound now, so this holds once the move lands too
      const c = lastState.workspaces.find((w) => w.id === g.m.group)?.compound;
      if (!c) return;
      const d = iso(g.t.x - c.x0, g.t.y - c.y0);
      for (const rec of sprites.values()) {
        if (rec.ws !== g.m.group) continue;
        rec.sprite.position.set(rec.base.x + d.x, rec.base.y + d.y);
        rec.sprite.zIndex = rec.entity.depth + 10000;
        rec.sprite.alpha = 0.85;
      }
      return;
    }
    const rec = sprites.get(g.m.entityId);
    if (!rec) return;
    const size = g.m.w;
    const p = iso(g.t.x + size, g.t.y + size);
    rec.sprite.position.set(p.x, p.y);
    rec.sprite.zIndex = 10000;
    rec.sprite.alpha = 0.85;
    const bar = sprites.get(g.m.entityId.startsWith('struct:') ? g.m.entityId.replace(/^struct:/, 'status:') : `status:${g.m.entityId}`);
    if (bar && bar !== rec) {
      const q = iso(g.t.x + size / 2, g.t.y + size / 2);
      bar.sprite.position.set(q.x, q.y - (bar.entity.lift ?? STATUS_LIFT));
    }
  };
  const endDragVisual = () => {
    for (const r of sprites.values()) r.sprite.alpha = 1;
    sync(lastState);
  };

  // ---- input: drag pans, wheel zooms to the cursor, click selects, double-click zooms to a compound
  const hitEntities = (): Entity[] => [
    ...entities,
    ...[...views].map(([id, v]): Entity => ({
      id: `builder:${id}`, kind: 'builder', x: v.walker.x, y: v.walker.y, depth: v.walker.x + v.walker.y, texKey: '',
    })),
  ];
  const localPoint = (ev: MouseEvent) => {
    const r = app.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const canvas = app.canvas;
  let pointerId = -1;
  let downAt = { x: 0, y: 0 };
  const drag = createDragController({
    getCam: () => cam,
    setCam: jumpTo,
    setTarget: (t) => { camTarget = t; },
    onAutoFitOff: () => { autoFit = false; canvas.style.cursor = 'grabbing'; },
  });
  // ---- builders: press and drag one to pick it up; drop it on a workspace to put it to work there
  // (idle builders), or on open ground to set it down. A press without a drag is still a click.
  let bd: { id: string; hit: Entity; grab: { x: number; y: number }; orig: Walker | null; drop: BuilderDrop } | null = null;
  const bdFx = new Graphics(); // where a held builder would land: the workspace, or the tile
  groundLayer.addChild(bdFx);
  const idleBuilder = (id: string) =>
    !lastState.sessions.some((x) => x.kind.kind === 'agent' && x.kind.builderId === id && x.state.kind !== 'ended');
  const collectorCorners = () =>
    entities.filter((e) => e.kind === 'collector').map((e) => ({ x: e.x - STRUCT, y: e.y - STRUCT }));
  const drawDrop = (at: Tile, drop: BuilderDrop) => {
    bdFx.clear();
    const ws = drop.kind === 'assign' ? lastState.workspaces.find((w) => w.id === drop.workspaceId)?.compound : null;
    const r = ws ? wallRect(ws) : { x0: Math.floor(at.x), y0: Math.floor(at.y), w: 1, h: 1 };
    const a = iso(r.x0, r.y0), b = iso(r.x0 + r.w, r.y0), c = iso(r.x0 + r.w, r.y0 + r.h), d = iso(r.x0, r.y0 + r.h);
    const ok = drop.kind !== 'blocked';
    bdFx.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]).fill({ color: ok ? 0x5cf05c : 0xff3b2f, alpha: ws ? 0.22 : 0.4 })
      .stroke({ width: ws ? 4 : 3, color: ok ? 0x1f8a1f : 0xb02218 });
  };
  const endBuilderDrag = (ev: PointerEvent | null) => {
    const d = bd;
    bd = null;
    bdFx.clear();
    canvas.style.cursor = '';
    if (ev) { try { canvas.releasePointerCapture(ev.pointerId); } catch { /* see onDown */ } }
    const v = d && views.get(d.id);
    if (!d || !v) return;
    if (!d.orig) { // no drag: a click on the builder
      if (ev) opts.onSelect?.(selectionOf(d.hit, lastState.sessions));
      return;
    }
    const at = v.held ?? { x: v.walker.x, y: v.walker.y };
    v.held = null;
    const drop = ev ? d.drop : { kind: 'blocked' as const };
    if (drop.kind === 'assign') {
      const c = lastState.workspaces.find((w) => w.id === drop.workspaceId)?.compound;
      const o = c ? gateOutside(c) : at;
      // waits at the gate while the owner fills in the task; walks back to the plaza if nothing starts
      v.walker = { ...d.orig, x: o.x + 0.5, y: o.y + 0.5, path: [], mode: 'idle', wait: 30, anchor: undefined, face: -1 };
      v.leaving = null;
      opts.onBuilderAssign?.(d.id, drop.workspaceId);
    } else if (drop.kind === 'place') {
      const site = v.site && !idleBuilder(d.id) ? v.site : null;
      v.walker = site
        // a builder at work walks straight back to its structure
        ? { ...d.orig, x: at.x, y: at.y, anchor: undefined, mode: 'toSite', path: routeToSite(at, site.compound, site.spot, walkFor(lastState, site.workspaceId, site.compound)) }
        : { ...d.orig, x: at.x, y: at.y, anchor: at, mode: 'idle', path: [], wait: 1 + Math.random() * 2 };
      if (!site) v.leaving = null;
    } else {
      v.walker = d.orig; // snap back, with a puff where it was refused
      if (ev) particles.dust(iso(at.x, at.y), 8, false);
    }
  };

  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    const p = localPoint(ev);
    pointerId = ev.pointerId;
    downAt = p;
    const w = screenToWorld(cam, p.x, p.y);
    const top = hitTest(entities, w.x, w.y);
    const front = hitTest(hitEntities(), w.x, w.y); // a builder in front of a board is picked up instead
    const b = front?.kind === 'board' ? lastState.boards?.find((x) => `board:${x.key}` === front.id) : undefined;
    const c = b && lastState.workspaces.find((x) => x.id === b.workspaceId)?.compound;
    // a press on a board drags it (a press without a drag opens it); on the selected object drags
    // that; anywhere else pans the camera
    const m = b && c
      ? { target: { kind: 'board', key: b.key } as const, entityId: top!.id, w: STRUCT, h: STRUCT, inset: 0, tile: b.spot, compound: c, height: 100, chip: '' }
      : movableOf(selected, ev.altKey);
    if (m && top?.id === m.entityId) {
      const g = toGrid(w.x, w.y);
      od = { m, grab: { x: g.x - m.tile.x, y: g.y - m.tile.y }, moved: false, target: m.tile, valid: true };
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic events have no live pointer */ }
      return;
    }
    const hit = hitTest(hitEntities(), w.x, w.y);
    const v = hit?.kind === 'builder' ? views.get(hit.id.slice('builder:'.length)) : undefined;
    if (hit && v) {
      // keep the feet where they were relative to the pointer
      const f = iso(v.walker.x, v.walker.y);
      bd = { id: hit.id.slice('builder:'.length), hit, grab: { x: f.x - w.x, y: f.y - w.y }, orig: null, drop: { kind: 'blocked' } };
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic events have no live pointer */ }
      return;
    }
    drag.down(p.x, p.y);
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic events have no live pointer */ }
  };
  const onMove = (ev: PointerEvent) => {
    if (bd && ev.pointerId === pointerId) {
      const p = localPoint(ev);
      const v = views.get(bd.id);
      if (!v) return;
      if (!bd.orig) {
        if (Math.hypot(p.x - downAt.x, p.y - downAt.y) <= DRAG_PX) return;
        bd.orig = v.walker;
        canvas.style.cursor = 'grabbing';
      }
      const w = screenToWorld(cam, p.x, p.y);
      // the feet stay under the grab point, the figure lifted above the tile it would land on
      const at = toGrid(w.x + bd.grab.x, w.y + bd.grab.y + HELD_LIFT);
      v.held = at;
      const was = bd.drop;
      bd.drop = dropOf(at, lastState.workspaces, collectorCorners(), idleBuilder(bd.id));
      if (bd.drop.kind === 'assign' && (was.kind !== 'assign' || was.workspaceId !== bd.drop.workspaceId)) {
        opts.onBuilderOver?.(bd.drop.workspaceId);
      }
      drawDrop(at, bd.drop);
      return;
    }
    if (od && ev.pointerId === pointerId) {
      const p = localPoint(ev);
      if (!od.moved) {
        if (Math.hypot(p.x - downAt.x, p.y - downAt.y) <= DRAG_PX) return;
        od.moved = true;
        autoFit = false; // a deliberate edit: stop following the village rect
        canvas.style.cursor = 'grabbing';
      }
      const w = screenToWorld(cam, p.x, p.y), g = toGrid(w.x, w.y);
      od.target = dragTarget(od.m.tile, od.grab, g);
      od.valid = opts.canMove?.(od.m.target, od.target) ?? false;
      applyDragSprite();
      redrawOverlay();
      return;
    }
    if (!drag.active || ev.pointerId !== pointerId) return;
    const p = localPoint(ev);
    drag.move(p.x, p.y);
  };
  const endObjectDrag = (ev: PointerEvent | null) => {
    const d = od;
    od = null;
    canvas.style.cursor = '';
    if (ev) { try { canvas.releasePointerCapture(ev.pointerId); } catch { /* see onDown */ } }
    if (d && !d.moved && ev && d.m.target.kind === 'board') {
      const key = d.m.target.key;
      const b = lastState.boards?.find((x) => x.key === key);
      if (b) opts.onOpenApp?.(b);
    }
    if (!d || !d.moved) { redrawOverlay(); return; } // a plain click on the selected object changes nothing
    const same = d.target.x === d.m.tile.x && d.target.y === d.m.tile.y;
    if (ev && d.valid && !same && opts.onMove) {
      // the sprite stays on the new tile until the store confirms; either way sync puts it where the store says
      pending = { m: d.m, tile: d.target };
      // a rejection is reported by the store action (onError); either way the sprite ends where the store says
      void opts.onMove(d.m.target, d.target).catch(() => false).finally(() => {
        pending = null;
        if (!destroyed) { endDragVisual(); redrawOverlay(); }
      });
    } else {
      if (ev && !d.valid) {
        const o = cornerOf(d.m, d.target);
        particles.dust(iso(o.x + d.m.w / 2, o.y + d.m.h / 2), 10, false); // snap back immediately, with a puff where it was refused
        opts.onBlockedDrop?.(d.target);
      }
      endDragVisual();
    }
    redrawOverlay();
  };
  const onUp = (ev: PointerEvent) => {
    if (bd && ev.pointerId === pointerId) { endBuilderDrag(ev); return; }
    if (od && ev.pointerId === pointerId) { endObjectDrag(ev); return; }
    if (!drag.active || ev.pointerId !== pointerId) return;
    canvas.style.cursor = '';
    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* see onDown */ }
    if (drag.up() !== 'click') return;
    const w = screenToWorld(cam, downAt.x, downAt.y);
    opts.onSelect?.(selectionOf(hitTest(hitEntities(), w.x, w.y), lastState.sessions));
  };
  const onCancel = () => { if (od) endObjectDrag(null); if (bd) endBuilderDrag(null); drag.cancel(); canvas.style.cursor = ''; };
  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const p = localPoint(ev);
    const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
    autoFit = false;
    jumpTo(zoomAt(cam, p.x, p.y, Math.exp(-dy * 0.0015)));
  };
  const onDblClick = (ev: MouseEvent) => {
    const p = localPoint(ev);
    const w = screenToWorld(cam, p.x, p.y);
    const g = toGrid(w.x, w.y);
    const ws = compoundAt(workspaces, g.x, g.y);
    if (ws?.compound) {
      autoFit = false;
      // the panel opens with the selection, so fit into the space it leaves
      camTarget = fitRect(pxRectOfCompound(ws.compound), app.screen.width, app.screen.height, PANEL_W, ZMAX);
      opts.onSelect?.({ kind: 'workspace', id: ws.id });
    } else {
      fitVillage();
    }
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDblClick);

  const zoomBy = (factor: number) => {
    const cx = (app.screen.width - panelW()) / 2, cy = app.screen.height / 2;
    autoFit = false;
    camTarget = zoomAt(camTarget ?? cam, cx, cy, factor);
  };
  const fitCompound = (workspaceId: string) => {
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws?.compound) return;
    autoFit = false;
    camTarget = fitRect(pxRectOfCompound(ws.compound), app.screen.width, app.screen.height, PANEL_W, ZMAX);
  };
  const entityIdOf = (sel: Selection) => (sel.kind === 'hall' ? 'hall' : sel.kind === 'workspace' ? `house:${sel.id}`
    : sel.kind === 'session' ? `struct:${sel.id}` : sel.kind === 'quota' ? `collector:${sel.agent}` : `builder:${sel.id}`);
  const locate = (sel: Selection) => {
    const e = hitEntities().find((x) => x.id === entityIdOf(sel));
    if (!e) return null;
    const p = clickPoint(e);
    const s = worldToScreen(cam, p.x, p.y), box = app.canvas.getBoundingClientRect();
    return { x: box.left + s.x, y: box.top + s.y, r: (LOCATE_R[e.kind] ?? 60) * cam.zoom };
  };
  const reveal = (sel: Selection | null) => {
    if (!sel) return;
    const id = entityIdOf(sel);
    const e = hitEntities().find((x) => x.id === id);
    if (!e) return;
    const p = clickPoint(e);
    const next = keepVisible(camTarget ?? cam, p.x, p.y, app.screen.width, app.screen.height, PANEL_W, 60);
    if (next) { autoFit = false; camTarget = next; }
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener('focus', applyCap);
    window.removeEventListener('blur', applyCap);
    document.removeEventListener('visibilitychange', onVisibility);
    app.renderer.off('resize', onResize);
    app.canvas.removeEventListener('webglcontextrestored', onContextRestored);
    sprites.clear();
    unholdTextures();
    fxRender.destroy();
    const gt = ground.texture;
    app.destroy({ removeView: true }, { children: true, texture: false });
    if (gt !== Texture.EMPTY) gt.destroy(true);
    const i = liveScenes.indexOf(hooks);
    if (i >= 0) liveScenes.splice(i, 1);
    publishToDriver();
  };

  // The driver is dev-only; publishToDriver's DEV guard keeps it out of release bundles.
  const hooks: DriverHooks = {
    snapshot: async () => {
      const url = await app.renderer.extract.base64({ target: app.stage, frame: app.screen.clone() });
      return url.slice(url.indexOf(',') + 1); // snap.sh expects bare base64, not a data URL
    },
    debug,
  };
  liveScenes.push(hooks);
  publishToDriver();

  const select = (sel: Selection | null) => { selected = sel; redrawOverlay(); };

  return { sync, destroy, world, debug, fitVillage, fitCompound, zoomBy, reveal, select, setCovered, locate };
}
