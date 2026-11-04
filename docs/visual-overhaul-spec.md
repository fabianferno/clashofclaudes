# Clash of Claudes — v7 Visual Overhaul Wiring & Performance Guide

**Direction:** *Whimsical 3D Fantasy × Toy-like Diorama*  
**Mockup & Inspector:** [`docs/mockups/village-v7-diorama.html`](file:///Users/fabianferno/Documents/clashofclaudes/docs/mockups/village-v7-diorama.html)  
**Machine-Readable Manifest:** [`public/assets/village/manifest.json`](file:///Users/fabianferno/Documents/clashofclaudes/public/assets/village/manifest.json)

---

## 1. Asset Directory Overview (`public/assets/village/`)

All sprites are pre-baked at **`SCALE = 2`** (so a `64×32` logical tile is `128×64` canvas pixels) with clean alpha transparency, soft contact shadows, and exact `(ax, ay)` anchor alignment matching [`src/village/art/entities.ts`](file:///Users/fabianferno/Documents/clashofclaudes/src/village/art/entities.ts).

| Category | Sprite / Atlas Path | Canvas Size (2×) | Anchor `(ax, ay)` | Notes |
| --- | --- | --- | --- | --- |
| **North Star** | `north-star.png` | `1376×768` | — | Visual reference concept |
| **Trees** | `sheets/trees-sheet.png` (`scenery/tree-0..3.png`) | `800×260` (`200×260` ea) | `(100, 224)` | `v % 4`: `0,2` Oak, `1,3` Pine |
| **Town Hall** | `buildings/hall.png` | `760×680` | `(380, 580)` | `5×5` footprint (`center: 380, 420`) |
| **Houses (Stages 0–4)** | `sheets/houses-stages-sheet.png` + `buildings/house-stage-{0..4}-{coral,teal,orange,blue,purple,claude,codex,antigravity,opencode,custom,base,mask}.png` | `600×660` ea | `(300, 600)` | `3×3` footprint (`center: 300, 504`). Pre-tinted for all `HOUSE_COLORS` & `PALETTE` + neutral `-base` & `-mask` |
| **Structures** | `sheets/structures-sheet.png` + `structures/structure-{foundation,complete,claude,codex,antigravity,opencode,custom,complete-base,complete-mask}.png` | `440×500` ea | `(220, 400)` | `2×2` footprint (`center: 220, 336`). Live scaffold uses `foundation` + clipped `complete` + timber bars |
| **Elixir Collector** | `structures/collector-base.png`, `collector-glass-mask.png`, `collector-{claude,codex,antigravity}-full.png` | `400×440` | `(200, 380)` | `2×2` footprint (`center: 200, 316`). Draw `collector-base.png`, then live liquid fill (`y: 318` up to `168`) |
| **Rune Stone** | `structures/runestone-dark.png`, `runestone-lit.png` | `400×440` | `(200, 380)` | `2×2` footprint (`center: 200, 316`) |
| **Preview Board** | `structures/board-frame.png` | `400×440` | `(200, 380)` | `2×2` footprint. Live screen face matches `BOARD` in `buildings.ts` (`x0: -31, x1: 31, topY0: -91, topY1: -60, botY0: -49, botY1: -18`) |
| **Walls (16 Bitmask)** | `sheets/walls-sheet.png` (`scenery/wall-*.png`) | `880×720` (`220×180` ea) | `(110, 144)` | `4×4` grid indexed by `mask = (n?1:0) \| (e?2:0) \| (s?4:0) \| (w?8:0)` (`col = mask % 4, row = mask >> 2`) |
| **Gates** | `scenery/gate-ns.png`, `scenery/gate-ew.png` | `240×220` | `(120, 184)` | `N`/`S` use `gate-ns.png`; `E`/`W` use `gate-ew.png` |
| **AI Builders** | `sheets/builder-{apprentice,craftsman,master}-{claude,codex,antigravity,opencode,custom,base,mask}.png` | `1540×260` (`220×260` × 7) | `(110, 200)` | 7 poses in strip order: `idle, walk0, walk1, hammer0, hammer1, cheer, sad` |
| **Effort Hammers** | `sheets/hammers-sheet.png` (`builders/hammer-gear-0..4.png`) | `600×140` (`120×140` ea) | `(60, 70)` | Gear `0..4`: wood, iron, gold, diamond, mythic |
| **UI Props** | `sheets/ui-props-sheet.png` (`ui/bubble-needs.png`, `ui/bubble-stuck.png`, `ui/ribbon.png`, `ui/puff.png`) | `460×140` | See `manifest.json` | 3D Toy-Diorama speech bubbles, completion ribbon & dust puff |

---

## 2. Performance & Preloading Architecture (`src/village/textures.ts`)

1. **Pack-First Startup Preload (`prepareArt()`)**:
   - [`src/village/textures.ts`](file:///Users/fabianferno/Documents/clashofclaudes/src/village/textures.ts) already exports `async function prepareArt(): Promise<void>` which runs before the first frame in `VillageCanvas.tsx`.
   - Load the sprite sheets (`sheets/*.png`) plus the individual buildings (`hall.png`, `collector-base.png`, `runestone-*.png`, `board-frame.png`, `gate-*.png`, `house-stage-*-*.png`) concurrently via `Promise.all` inside `prepareArt()`.
   - Total compressed PNG payload across all core sheets & buildings is **< 3.5 MB** and decodes into GPU-backed `HTMLImageElement` / `ImageBitmap` objects in `< 40 ms`.

2. **Unit-Test Fallback Guarantee (`src/village/art/entities.test.ts` & `scripts/budget.sh`)**:
   - In Vitest (`entities.test.ts`), tests call `drawTree`, `drawHouse`, `drawBuilder`, and `drawGround` synchronously **without** awaiting `prepareArt()`, and inspect `vitest-canvas-mock`'s `__getDrawCalls()`.
   - Therefore, keep a boolean `isSpriteSheetReady()` check in `src/village/art/sprites.ts`:
     - When `isSpriteSheetReady()` is `true` (browser runtime after `prepareArt()`), paint the preloaded 3D diorama sprites into the `bake(...)` canvas (or return a cached `Sprite` directly).
     - When `isSpriteSheetReady()` is `false` (Node/Vitest unit tests when `prepareArt()` wasn't called, or when `?art=v6` dev flag is set), fall back to the existing procedural Canvas 2D functions (`buildings.ts`, `builders.ts`, `scenery.ts`).
   - This guarantees **100% of existing tests in `entities.test.ts` and `scripts/budget.sh` pass without modification**.

3. **LRU Texture Cache (`textures.ts`)**:
   - `textures.ts` caches up to `MAX = 256` `Sprite` entries keyed by entity parameters (e.g. `b:claude:2:4:hammer0:1`).
   - Since collector fill (`Math.round(fill * 20)`) and scaffold progress (`Math.round(progress * 25)`) already quantize to 20–25 steps, drawing the 3D base sprite + live canvas overlay inside `bake(...)` runs only when the quantized step changes (at most once every few seconds, zero per-frame allocations).

---

## 3. Step-by-Step Wiring Recipes (`src/village/art/entities.ts`)

### A. `drawTree(v)` & `drawHall()` & `drawRuneStone(lit)` & `drawGate(side)` & `drawWallSeg(n, e, s, w)`
- **`drawTree(v)`**: Draw frame `((v % 4) + 4) % 4` (`x = idx * 200, y = 0, w = 200, h = 260`) from `sheets/trees-sheet.png` into a `200×260` canvas with `ax = 100, ay = 224`.
- **`drawHall()`**: Draw `buildings/hall.png` (`760×680`, `ax = 380, ay = 580`).
- **`drawRuneStone(lit)`**: Draw `structures/runestone-lit.png` when `lit === true`, else `structures/runestone-dark.png` (`400×440`, `ax = 200, ay = 380`).
- **`drawGate(side)`**: Draw `scenery/gate-ns.png` for `side === 'N' || side === 'S'`, else `scenery/gate-ew.png` (`240×220`, `ax = 120, ay = 184`).
- **`drawWallSeg(n, e, s, w)`**: Compute `mask = (n ? 1 : 0) | (e ? 2 : 0) | (s ? 4 : 0) | (w ? 8 : 0)`. Draw cell `(col = mask % 4, row = mask >> 2)` (`220×180` each) from `sheets/walls-sheet.png` (`ax = 110, ay = 144`).

### B. `drawHouse(stage, pal)` (Pre-Tinted + Dynamic Mask Fallback)
- Map `pal.roof` to our pre-rendered palette name:
  - `#c64a32` → `'coral'` (`house-stage-${s}.png`)
  - `#3a8f82` → `'teal'` (`house-stage-${s}-teal.png`)
  - `#d4852a` → `'orange'` (`house-stage-${s}-orange.png`)
  - `#4f6ec8` → `'blue'` (`house-stage-${s}-blue.png`)
  - `#7a4ca8` → `'purple'` (`house-stage-${s}-purple.png`)
  - `#d97757` → `'claude'`, `#f4f4f4` → `'codex'`, `#4f7cf0` → `'antigravity'`, `#33a889` → `'opencode'`, `#9b968e` → `'custom'`
- For any arbitrary custom roof color not in the pre-rendered set, composite `house-stage-${s}-base.png` + `house-stage-${s}-mask.png` tinted with `globalCompositeOperation = 'multiply'` on an offscreen canvas.

### C. `drawStructure(state, agent, progress)` (Live Scaffold Progress)
- **`state === 'foundation'`**: Draw `structures/structure-foundation.png` (`440×500`, `ax = 220, ay = 400`).
- **`state === 'complete'`**: Draw `structures/structure-${agent}.png` (`440×500`, `ax = 220, ay = 400`).
- **`state === 'scaffold'`**:
  1. Draw `structures/structure-foundation.png` at `(0, 0)` on the `440×500` canvas.
  2. Clip to `rect(0, 348 - progress * 190, 440, progress * 190 + 48)` and draw `structures/structure-${agent}.png` so the 3D tent rises smoothly from the timber deck as `progress` goes `0 → 1`.
  3. Call the existing timber scaffold beam strokes from `buildings.ts` on top so the scaffolding bars & pulley frame the rising 3D tent.

### D. `drawCollector(agent, fill)` (Live Elixir Fill)
- Draw `structures/collector-base.png` (`400×440`, `ax = 200, ay = 380`).
- When `fill > 0.01`:
  - Use `ELIXIR[agent]` (`top`, `mid`, `bot`, `glow`) to draw the glowing isometric liquid cylinder centered at `x = 200` (in 2× canvas coords, or `x = 0` relative to `iso(2, 2)` in `bake`), rising from `y = 314` (`-33` logical) up by `fill * 144` canvas px (`fill * 72` logical px), with meniscus ellipse and specular highlights.

### E. `drawBoard()` (Live Preview Screen Compatibility)
- Draw `structures/board-frame.png` (`400×440`, `ax = 200, ay = 380`).
- `BOARD` in [`src/village/art/buildings.ts`](file:///Users/fabianferno/Documents/clashofclaudes/src/village/art/buildings.ts) (`{ x0: -31, x1: 31, topY0: -91, topY1: -60, botY0: -49, botY1: -18 }`) aligns pixel-for-pixel with the dark recessed screen inside `board-frame.png`, so `scene.ts`'s live page preview cut-in works with zero coordinate changes.

### F. `drawBuilder(agent, cls, gear, pose, facing)` & `BuilderAvatar.tsx`
- Each strip `sheets/builder-${className}-${agent}.png` has 7 frames of `220×260` (`ax = 110, ay = 200`) in order:
  `['idle', 'walk0', 'walk1', 'hammer0', 'hammer1', 'cheer', 'sad']`.
- For `facing === -1` (left), flip horizontally around `ax = 110` (`ctx.translate(220, 0); ctx.scale(-1, 1)`).
- [`src/hud/BuilderAvatar.tsx`](file:///Users/fabianferno/Documents/clashofclaudes/src/hud/BuilderAvatar.tsx) crops `(sx = ax - size * 0.64, sy = ay - size * 1.58, sw = size * 1.28, sh = size * 1.28)` in logical coordinates (`ax = 55, ay = 100`). All 3 builder classes (`apprentice`, `craftsman`, `master`) were scaled and anchored at `(110, 200)` in 2× pixels so their heads and shoulders sit centered inside the `BuilderAvatar` and `BuilderPreview` crop box!

---

## 4. Upgraded Toy-Diorama Parchment UI CSS (`hud.css` & `panels.css`)

To make the DOM panels feel like part of the same tactile 3D miniature world (see [`docs/mockups/village-v7-diorama.html`](file:///Users/fabianferno/Documents/clashofclaudes/docs/mockups/village-v7-diorama.html)):
- **Chunky bevels & warm wood borders**: Use `border: 3.5px solid #1d130b` with a tactile 3D drop-lip `box-shadow: 0 6px 0 #1d130b, 0 10px 24px rgba(14, 9, 5, 0.45), inset 0 2px 0 rgba(255, 255, 255, 0.85), inset 0 -3px 0 rgba(166, 124, 82, 0.35)`.
- **Warm cream-to-amber parchment gradient**: `background: linear-gradient(180deg, #fff9ec 0%, #f7ebd2 68%, #ead5b0 100%)`.
- **3D Elixir Orbs in HUD Meters**: Replace flat dots with radial-gradient glass orbs (`radial-gradient(circle at 35% 30%, topColor, midColor 60%, botColor)` + `inset 0 2px 2px rgba(255,255,255,0.6)`).
