import { Application, Container, Sprite, Texture } from 'pixi.js';
import type { AgentKind, Builder, Compound, SessionInfo, SessionState, Tile, Workspace } from '../api/types';
import { iso, toGrid } from './iso';
import { HALL, HOUSE, STRUCT, gateSide, gateTile, wallRect, type Rect } from './layout';
import { classOf, gearOf, houseColors, houseStage, scaffoldHeight, type ClassTier, type Gear } from './look';
import { routeHome, routeToSite, standTile, step, type Walker } from './walkers';
import {
  drawBadge, drawBubble, drawBuilder, drawGate, drawGround, drawHall, drawHouse, drawPuff, drawRing, drawStructure, drawWallSeg, groundOrigin, type Art, type Pose,
} from './art/entities';
import { getTexture, prepareArt } from './textures';
import type { Selection } from '../state/store';
import {
  PANEL_W, ZMAX, ease, fitRect, keepVisible, pxRectOfCompound, pxRectOfTiles, screenToWorld, worldToScreen, zoomAt, type Cam,
} from './camera';
import { clickPoint, compoundAt, hitTest } from './input';

// ---------------------------------------------------------------- pure part

export interface VillageInput {
  workspaces: Workspace[];
  sessions: SessionInfo[];
  builders: Builder[];
}

export type EntityKind = 'hall' | 'house' | 'structure' | 'builder' | 'wall' | 'gate' | 'tree' | 'badge';

/**
 * One drawable. `x`/`y` is the grid point of the sprite's anchor (for footprints, the front
 * corner; see each draw function), so the sprite sits at `iso(x, y)`. `depth` is `x + y` of that
 * front corner with a small per-kind tie-break; larger depth draws later (in front).
 * Forest trees are baked into the ground texture, so no `tree` entities are emitted.
 */
export interface Entity {
  id: string;
  kind: EntityKind;
  x: number;
  y: number;
  depth: number;
  texKey: string;
}

const KIND_RANK: Record<EntityKind, number> = {
  tree: 0, wall: 1, gate: 2, hall: 3, house: 4, structure: 5, builder: 6, badge: 7,
};

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

function wallEntities(wsId: string, c: Compound): Entity[] {
  const r = wallRect(c);
  const gate = gateTile(c);
  const out: Entity[] = [];
  const seg = (tx: number, ty: number, dir: 'x' | 'y') => {
    if (tx === gate.x && ty === gate.y) return;
    out.push(ent(`wall:${wsId}:${tx}:${ty}`, 'wall', tx + 1, ty + 1, `wall:${dir}`));
  };
  for (let tx = r.x0; tx < r.x0 + r.w; tx++) {
    seg(tx, r.y0, 'x');
    seg(tx, r.y0 + r.h - 1, 'x');
  }
  for (let ty = r.y0 + 1; ty < r.y0 + r.h - 1; ty++) {
    seg(r.x0, ty, 'y');
    seg(r.x0 + r.w - 1, ty, 'y');
  }
  out.push(ent(`gate:${wsId}`, 'gate', gate.x + 1, gate.y + 1, `gate:${gateSide(c)}`));
  return out;
}

/** Everything the village draws for this state, sorted back to front. Pure. */
export function buildEntities(input: VillageInput): Entity[] {
  const out: Entity[] = [ent('hall', 'hall', HALL.x0 + HALL.w, HALL.y0 + HALL.h, 'hall')];
  const agentOf = new Map(input.builders.map((b) => [b.id, b.agent] as [string, AgentKind]));
  const compounds = new Map<string, Compound>();
  for (const w of input.workspaces) {
    const c = w.compound;
    if (!c) continue;
    compounds.set(w.id, c);
    const { roof, wall } = houseColors(w.id);
    out.push(ent(`house:${w.id}`, 'house', c.house.x + HOUSE, c.house.y + HOUSE, `house:${houseStage(w.level)}:${roof}:${wall}`));
    out.push(...wallEntities(w.id, c));
    const terminals = input.sessions.filter(
      (s) => s.workspaceId === w.id && s.kind.kind === 'terminal' && s.state.kind !== 'ended',
    ).length;
    if (terminals > 0)
      out.push(ent(`badge:${w.id}`, 'badge', c.house.x + HOUSE / 2, c.house.y + HOUSE / 2, `badge:${terminals}`));
  }
  for (const s of input.sessions) {
    if (s.kind.kind !== 'agent' || !s.spot || !compounds.has(s.workspaceId)) continue;
    const { stage, height } = structureLook(s);
    const agent = agentOf.get(s.kind.builderId) ?? 'custom';
    // Quantized so a long-running session reuses a bounded set of textures.
    const h = stage === 'scaffold' ? Math.round(height * 50) / 50 : stage === 'complete' ? 1 : 0;
    out.push(ent(`struct:${s.id}`, 'structure', s.spot.x + STRUCT, s.spot.y + STRUCT, `struct:${agent}:${stage}:${h}`));
  }
  return out.sort((a, b) => a.depth - b.depth);
}

/** Tiles: HALL and every wall rect (unpadded). */
export function villageRect(compounds: Compound[]): Rect {
  let x0 = HALL.x0, y0 = HALL.y0, x1 = HALL.x0 + HALL.w, y1 = HALL.y0 + HALL.h;
  for (const c of compounds) {
    const r = wallRect(c);
    x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0);
    x1 = Math.max(x1, r.x0 + r.w); y1 = Math.max(y1, r.y0 + r.h);
  }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
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
    case 'wall': return drawWallSeg(a as 'x' | 'y');
    case 'gate': return drawGate(a as 'n' | 's' | 'e' | 'w');
    case 'badge': return drawBadge(Number(a));
    case 'builder': return drawBuilder(a as AgentKind, Number(b) as ClassTier, Number(c) as Gear, d as Pose, Number(e) as 1 | -1);
    case 'bubble': return drawBubble(a as 'needs' | 'stuck');
    case 'ring': return drawRing();
    case 'puff': return drawPuff();
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
}

interface BuilderView {
  walker: Walker;
  agent: AgentKind;
  cls: ClassTier;
  gear: Gear;
  site: Site | null;
  pose: Pose;
  sprite: Sprite;
  bubble: Sprite | null;
  ring: Sprite | null;
  puffs: Sprite[];
}

const HEAD_HEIGHT: Record<ClassTier, number> = { 0: 46, 1: 56, 2: 80 };
const HAMMER_PERIOD = 0.18;
const WALK_PERIOD = 0.25;

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
    spot: best.spot, state: best.state.kind, reachedFinished: best.reachedFinished,
  };
}

/** Pose from what the builder is doing and what its session is doing. */
export function poseOf(w: Walker, site: Site | null, time: number): Pose {
  if (w.path.length) return Math.floor(time / WALK_PERIOD) % 2 ? 'walk1' : 'walk0';
  if (w.mode !== 'atSite' || !site) return 'idle';
  switch (site.state) {
    case 'starting':
    case 'working': return Math.floor(time / HAMMER_PERIOD) % 2 ? 'hammer1' : 'hammer0';
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
  cam: Cam;
  /** Client (window) position of an entity's clickable middle: an entity id, or a workspace id for its house. */
  screenOf(id: string): { x: number; y: number } | null;
}

export interface SceneOptions {
  /** A click (or double-click on a compound) picked this, or null for empty ground. */
  onSelect?: (sel: Selection | null) => void;
  /** Width of the panel currently covering the right of the window (0 when closed). */
  panelWidth?: () => number;
}

export interface Scene {
  sync(state: VillageInput): void;
  destroy(): void;
  world: Container;
  debug(): SceneDebug;
  /** Ease the camera to fit the whole village. */
  fitVillage(): void;
  /** Ease-zoom by `factor` around the centre of the area left of the panel. */
  zoomBy(factor: number): void;
  /** Pan (eased) just enough that the selected thing is not under the panel. */
  reveal(sel: Selection | null): void;
}

const GROUND_SEED = 7;
/**
 * Live scenes, newest last; the dev driver always points at the newest one. React StrictMode
 * creates two and destroys one, in either order, so a single "owner" slot is not enough.
 */
interface DriverHooks { snapshot: () => Promise<string>; debug: () => SceneDebug }
const liveScenes: DriverHooks[] = [];
function publishToDriver(): void {
  if (!import.meta.env.DEV) return;
  void import('../driver').then((d) => {
    const top = liveScenes[liveScenes.length - 1];
    d.registerSnapshot(top ? top.snapshot : async () => '');
    d.registerScene(top ? top.debug : () => null);
  });
}
const FPS_FOCUSED = 30;
const FPS_BLURRED = 15;

export async function createScene(canvasHost: HTMLElement, opts: SceneOptions = {}): Promise<Scene> {
  const app = new Application();
  await app.init({
    resizeTo: canvasHost,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    antialias: true,
    preference: 'webgl',
    background: '#3f7d22',
  });
  await prepareArt();
  canvasHost.appendChild(app.canvas);

  // view holds the layers and is what the camera transforms.
  const view = new Container();
  const groundLayer = new Container();
  const world = new Container({ sortableChildren: true });
  const overlay = new Container({ sortableChildren: true });
  view.addChild(groundLayer, world, overlay);
  app.stage.addChild(view);

  const ground = new Sprite(Texture.EMPTY);
  groundLayer.addChild(ground);
  let groundKey = '';
  let groundBakes = 0;
  let villageTiles: Rect | null = null;
  let workspaces: Workspace[] = [];

  const sprites = new Map<string, { sprite: Sprite; key: string; entity: Entity }>();
  let entities: Entity[] = [];
  let destroyed = false;
  const views = new Map<string, BuilderView>();
  let time = 0;

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
  const onVisibility = () => {
    if (document.hidden) {
      app.ticker.stop();
      ticks.length = 0;
    } else {
      applyCap();
      app.ticker.start();
    }
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

  const syncGround = (compounds: Compound[]) => {
    const b = groundBounds(compounds);
    const key = JSON.stringify([b, compounds.map((c) => [c.x0, c.y0, c.w, c.h, c.house.x, c.house.y])]);
    if (key === groundKey) return;
    groundKey = key;
    const old = ground.texture;
    ground.texture = Texture.from(drawGround(b, compounds, GROUND_SEED));
    if (old !== Texture.EMPTY) old.destroy(true);
    const o = groundOrigin(b);
    ground.position.set(o.x, o.y);
    groundBakes++;
    const first = villageTiles === null;
    villageTiles = villageRect(compounds);
    if (autoFit) {
      if (first) fit();
      else fitVillage(); // the village grew: ease to the new extent
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

  /** Bring the walkers in line with the store. The walk is cosmetic: nothing here waits on it. */
  const syncBuilders = (state: VillageInput) => {
    const compounds = new Map<string, Compound>();
    for (const w of state.workspaces) if (w.compound) compounds.set(w.id, w.compound);
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
        v = {
          walker: { id: b.id, x: 0.5 + Math.cos(a) * 5.1, y: 0.5 + Math.sin(a) * 5.1, path: [], mode: 'idle', face: 1, wait: 0.5 },
          agent: b.agent, cls: classOf(b.agent, b.model), gear: gearOf(b.effort), site: null,
          pose: 'idle', sprite, bubble: null, ring: null, puffs: [],
        };
        views.set(b.id, v);
      }
      v.agent = b.agent; v.cls = classOf(b.agent, b.model); v.gear = gearOf(b.effort);
      const w = v.walker, was = v.site;
      if (site) {
        if (!was || was.sessionId !== site.sessionId) {
          v.walker = { ...w, mode: 'toSite', path: routeToSite(w, site.compound, site.spot) };
        } else if (was.spot.x !== site.spot.x || was.spot.y !== site.spot.y) {
          const st = standTile(site.spot); // moved structure: the builder is simply there
          v.walker = { ...w, x: st.x, y: st.y, path: [], mode: 'atSite', face: -1 };
        }
      } else if (was) {
        const c = compounds.get(was.workspaceId);
        if (!c) v.walker = { ...w, path: [], mode: 'idle', wait: 0.5 };
        else {
          const route = routeHome(w, c);
          // a builder that has not reached the gate yet turns around on the plaza side
          v.walker = { ...w, mode: 'home', path: w.mode === 'toSite' && w.path.length >= 3 ? route.slice(2) : route };
        }
      }
      v.site = site;
    }
    for (const [id, v] of views) {
      if (live.has(id)) continue;
      for (const sp of [v.sprite, v.bubble, v.ring, ...v.puffs]) sp?.destroy();
      views.delete(id);
    }
  };

  const updateBuilders = (dt: number) => {
    time += dt;
    for (const v of views.values()) {
      const before = v.walker.mode;
      v.walker = step(v.walker, dt, Math.random);
      const w = v.walker;
      if (before !== 'atSite' && w.mode === 'atSite') w.face = -1; // look at the structure
      v.pose = poseOf(w, v.site, time);
      setTex(v.sprite, `builder:${v.agent}:${v.cls}:${v.gear}:${v.pose}:${w.face}`);
      const p = iso(w.x, w.y);
      v.sprite.position.set(p.x, p.y);
      v.sprite.zIndex = w.x + w.y + KIND_RANK.builder * 0.001;
      if (v.site && w.mode === 'atSite') {
        // the stand tile sits behind the structure and often the house; hammering must stay visible
        const c = v.site.compound, sp = v.site.spot;
        v.sprite.zIndex = Math.max(sp.x + sp.y + STRUCT, c.house.x + c.house.y + 2 * HOUSE) + 0.002;
      }

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
        const f = (time * 0.35 + i / 3) % 1;
        const c = iso(v.site.spot.x + 1, v.site.spot.y + 1);
        pf.position.set(c.x + Math.sin(f * 6 + i) * 6, c.y - 40 - f * 46);
        pf.alpha = 1 - f;
        pf.scale.set(0.5 * (0.6 + f));
      });
    }
  };
  app.ticker.add((t) => updateBuilders(Math.min(t.deltaMS / 1000, 0.25)));

  const sync = (state: VillageInput) => {
    if (destroyed) return;
    workspaces = state.workspaces;
    const compounds = state.workspaces.flatMap((w) => (w.compound ? [w.compound] : []));
    syncGround(compounds);
    syncBuilders(state);
    entities = buildEntities(state);
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
        (e.kind === 'badge' ? overlay : world).addChild(sprite);
        rec = { sprite, key: '', entity: e };
        sprites.set(e.id, rec);
      }
      const { sprite } = rec;
      if (sprite.texture !== t.texture) {
        sprite.texture = t.texture;
        sprite.anchor.set(t.ax / t.texture.width, t.ay / t.texture.height);
      }
      rec.key = e.texKey;
      rec.entity = e;
      const p = iso(e.x, e.y);
      sprite.position.set(p.x, p.y);
      sprite.zIndex = e.depth;
    });
    for (const [id, rec] of sprites) {
      if (seen.has(id)) continue;
      rec.sprite.destroy(); // textures stay in the shared cache
      sprites.delete(id);
    }
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
    cam: { ...cam },
    screenOf: (id) => {
      const e = hitEntities().find((x) => x.id === id) ?? hitEntities().find((x) => x.id === `house:${id}`);
      if (!e) return null;
      const p = clickPoint(e), q = worldToScreen(cam, p.x, p.y), r = app.canvas.getBoundingClientRect();
      return { x: q.x + r.left, y: q.y + r.top };
    },
  });

  // ---- input: drag pans, wheel zooms to the cursor, click selects, double-click zooms to a compound
  const hitEntities = (): Entity[] => [
    ...entities,
    ...[...views].map(([id, v]): Entity => ({
      id: `builder:${id}`, kind: 'builder', x: v.walker.x, y: v.walker.y, depth: v.walker.x + v.walker.y, texKey: '',
    })),
  ];
  const selectionOf = (e: Entity | null): Selection | null => {
    if (!e) return null;
    if (e.kind === 'hall') return { kind: 'hall' };
    if (e.kind === 'house') return { kind: 'workspace', id: e.id.slice('house:'.length) };
    if (e.kind === 'structure') return { kind: 'session', id: e.id.slice('struct:'.length) };
    if (e.kind === 'builder') return { kind: 'builder', id: e.id.slice('builder:'.length) };
    return null;
  };
  const localPoint = (ev: MouseEvent) => {
    const r = app.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const DRAG_PX = 4;
  let down: { id: number; x: number; y: number; cam: Cam; moved: boolean } | null = null;
  const canvas = app.canvas;
  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    const p = localPoint(ev);
    down = { id: ev.pointerId, x: p.x, y: p.y, cam: { ...cam }, moved: false };
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic events have no live pointer */ }
  };
  const onMove = (ev: PointerEvent) => {
    if (!down || ev.pointerId !== down.id) return;
    const p = localPoint(ev);
    const dx = p.x - down.x, dy = p.y - down.y;
    if (!down.moved && Math.hypot(dx, dy) > DRAG_PX) {
      down.moved = true;
      autoFit = false;
      canvas.style.cursor = 'grabbing';
    }
    if (down.moved) jumpTo({ ...down.cam, x: down.cam.x + dx, y: down.cam.y + dy });
  };
  const onUp = (ev: PointerEvent) => {
    if (!down || ev.pointerId !== down.id) return;
    const d = down;
    down = null;
    canvas.style.cursor = '';
    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* see onDown */ }
    if (d.moved) return;
    const w = screenToWorld(cam, d.x, d.y);
    opts.onSelect?.(selectionOf(hitTest(hitEntities(), w.x, w.y)));
  };
  const onCancel = () => { down = null; canvas.style.cursor = ''; };
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
  const reveal = (sel: Selection | null) => {
    if (!sel) return;
    const id = sel.kind === 'hall' ? 'hall' : sel.kind === 'workspace' ? `house:${sel.id}`
      : sel.kind === 'session' ? `struct:${sel.id}` : `builder:${sel.id}`;
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
    sprites.clear();
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

  return { sync, destroy, world, debug, fitVillage, zoomBy, reveal };
}
