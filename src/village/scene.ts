import { Application, Container, Sprite, Texture } from 'pixi.js';
import type { AgentKind, Builder, Compound, SessionInfo, Tile, Workspace } from '../api/types';
import { iso } from './iso';
import { HALL, HOUSE, STRUCT, gateSide, wallRect, type Rect } from './layout';
import { houseColors, houseStage, scaffoldHeight } from './look';
import {
  drawBadge, drawGate, drawGround, drawHall, drawHouse, drawStructure, drawWallSeg, groundOrigin, type Art,
} from './art/entities';
import { getTexture, prepareArt } from './textures';

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

/** The wall tile replaced by the gate: the middle of the side facing the hall. */
export function gateTile(c: Compound): Tile {
  const r = wallRect(c);
  const mx = r.x0 + Math.floor(r.w / 2), my = r.y0 + Math.floor(r.h / 2);
  switch (gateSide(c)) {
    case 'n': return { x: mx, y: r.y0 };
    case 's': return { x: mx, y: r.y0 + r.h - 1 };
    case 'w': return { x: r.x0, y: my };
    default: return { x: r.x0 + r.w - 1, y: my };
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
  const [kind, a, b, c] = key.split(':');
  switch (kind) {
    case 'hall': return drawHall();
    case 'house': return drawHouse(Number(a) as 0 | 1 | 2 | 3 | 4, b, c);
    case 'struct': return drawStructure(a as AgentKind, b as StructStage, Number(c));
    case 'wall': return drawWallSeg(a as 'x' | 'y');
    case 'gate': return drawGate(a as 'n' | 's' | 'e' | 'w');
    case 'badge': return drawBadge(Number(a));
    default: throw new Error(`no art for ${key}`);
  }
}

// ---------------------------------------------------------------- Pixi part

export interface SceneDebug {
  fps: number;
  running: boolean;
  entities: Array<{ id: string; kind: EntityKind; x: number; y: number }>;
  groundBakes: number;
}

export interface Scene {
  sync(state: VillageInput): void;
  destroy(): void;
  world: Container;
  debug(): SceneDebug;
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

export async function createScene(canvasHost: HTMLElement): Promise<Scene> {
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

  // view holds the layers and is what the (Task 8) camera transforms; for now it fits the village.
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
  let fitRect: Rect | null = null;

  const sprites = new Map<string, { sprite: Sprite; key: string; entity: Entity }>();
  let entities: Entity[] = [];
  let destroyed = false;

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

  const fit = () => {
    if (!fitRect) return;
    const r = fitRect;
    const L = iso(r.x0, r.y0 + r.h).x, R = iso(r.x0 + r.w, r.y0).x;
    const T = iso(r.x0, r.y0).y - 140, B = iso(r.x0 + r.w, r.y0 + r.h).y + 20; // 140: tallest roof/flag
    const sw = app.screen.width, sh = app.screen.height, m = 40;
    const z = Math.min(1, (sw - 2 * m) / (R - L), (sh - 2 * m) / (B - T));
    view.scale.set(z);
    view.position.set(sw / 2 - ((L + R) / 2) * z, sh / 2 - ((T + B) / 2) * z);
  };
  app.renderer.on('resize', fit);

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
    fitRect = villageRect(compounds);
    fit();
  };

  const sync = (state: VillageInput) => {
    if (destroyed) return;
    const compounds = state.workspaces.flatMap((w) => (w.compound ? [w.compound] : []));
    syncGround(compounds);
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
    entities: entities.map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y })),
    groundBakes,
  });

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener('focus', applyCap);
    window.removeEventListener('blur', applyCap);
    document.removeEventListener('visibilitychange', onVisibility);
    app.renderer.off('resize', fit);
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

  return { sync, destroy, world, debug };
}
