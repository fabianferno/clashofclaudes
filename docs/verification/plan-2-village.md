# Plan 2 verification: village budgets

Run on 2026-10-31 on branch `plan-2-village`. Machine: macOS (Darwin 27.2), window 1280×800 (the
webview is 1280×768 CSS px at devicePixelRatio 2, so the village canvas is 2560×1536 device px).

**The screen was locked for the whole run** (`ioreg` reports `IOConsoleLocked = true`). So:

- The webview reported `document.hidden = true`.
- The Pixi ticker stayed stopped (`scene().running = false`), which is the designed behaviour.
- `__cocDriver.front()` returned `false`.

What this means for the numbers:

- **Rendering budgets could not be measured:** focused CPU while animating, unfocused fps, and
  cold start until the village is visible. They are in the owner checklist below. No
  requestAnimationFrame shim was used for any number in this file.
- **Every memory figure is for a village that is not drawing.** No texture has been uploaded to
  the GPU yet. The ground texture alone is 2992×1586 px (about 18 MB) for the current two-compound
  layout, so memory with the village visible will be higher. Owner check 5 measures it.

## Results

| Budget (spec §7, task 14) | Target | Measured | Build | Result |
|---|---|---|---|---|
| Hidden (screen locked), idle | ~0% CPU, rendering stopped | **0.05%** of one core (20 s), `running:false` | release | PASS |
| Hidden, 10 sessions + 2 terminals | ~0% CPU | **0.19%** of one core (20 s) | dev | PASS |
| Minimized | ~0% CPU and `running:false` | **0.29%** of one core, `running:false`, `fps:0` (10 + 2 load, window minimized through the driver) | dev | PARTIAL: proves that hidden stops the ticker; gated on owner check 3 (see note 1) |
| Idle village, focused | ≤ 5% of one core, 30 fps cap | not measurable: screen locked | n/a | NOT MEASURABLE (owner check 1) |
| Unfocused | ≤ 15 fps (`scene().fps`) | not measurable: screen locked | n/a | NOT MEASURABLE (owner check 2) |
| Idle, no sessions (for reference) | n/a | **178 MB** (before the fix: 299 MB) | release | n/a |
| 10 sessions (`sleep 600`) + 2 terminals | ≤ 250 MB | **219 MB** with the panel closed, **226 MB** with a terminal on screen. Release estimate: about 192 / 199 MB | dev | PROVISIONAL: lower bound, village hidden (screen locked); gated on owner check 5 (see note 2) |
| `yes \| head -c 50000000` in a terminal, then 30 s settle | ≤ 250 MB | With the fix-round-1 protocol: **245 MB** with scrollback 5000 and **239 MB** with scrollback 2000 (246 MB once a second terminal is flooded too). The first run, at scrollback 5000, read 247 MB, with a 442 MB peak during the flood. Release estimate: about 27 MB lower | dev | PROVISIONAL: lower bound, village hidden (screen locked); gated on owner check 5. Only 4–11 MB of margin on dev (see note 2 and fix round 1) |
| Cold start to village visible | ≤ 2 s | Village visible: not measurable (screen locked). From launch to the scene being built (`scene().entities.length > 0`, hidden): **0.69 / 0.70 / 0.70 s** | dev | NOT MEASURABLE (owner check 4). The scene-built part is within budget. |

**Note 1.** The window really was minimized (`is_minimized` returned true), but the locked screen
had already hidden the page. This row therefore proves "hidden stops the ticker", not specifically
"minimizing stops it". Owner check 3 repeats it with the screen unlocked.

**Note 2: dev versus release.** The debug driver exists only in debug builds, so the 10-session
and flood scenarios were scripted on the dev build. To calibrate, idle was measured on both:

| | Before the fix | After the fix |
|---|---|---|
| Release, idle | 299 MB | 178 MB |
| Dev, idle | 334 MB | 205 MB (a second run: 202 MB) |
| Dev minus release | +35 MB | **+27 MB** |

The release estimates above are the dev number minus 27 MB. That assumes the idle delta also holds
under load, which was not measured. Every memory figure is with the village not drawing, so no
textures are uploaded (see the top of this file). Treat each one as a lower bound until owner
check 5.

### Before the fix (dev, same scenario)

| Situation | Total |
|---|---|
| Idle | 334 MB |
| 10 + 2 sessions, panel closed | 371 MB |
| 10 + 2 sessions, terminal on screen | about 391 MB |
| After the flood, settled | about 380 MB |

## What failed, and the fix

**The failure: memory over budget even at idle** (release, 299 MB). The WebContent process carried
210 MB of "Owned physical footprint (graphics)". The driver showed why, in the village's WebGL
context:

- drawing buffer 2560×1536
- `antialias: true`, `SAMPLES = 4`
- depth and stencil enabled

With 4× MSAA at 2× resolution, the colour and depth/stencil buffers are multisampled: about 63 MB
each, on top of the normal resolve and display buffers. The art is baked onto canvases at 2×
density, so it gains nothing from MSAA.

**The fix: `perf:` commit, `antialias: false`.** The renderer options moved into `rendererOptions()`
in `src/village/scene.ts`, with the regression test `renderer_has_no_msaa` in
`src/village/scene.test.ts`.

| After the fix | Before | After |
|---|---|---|
| WebContent graphics | 210 MB | 93 MB |
| Release idle total | 299 MB | 178 MB |
| Dev 10 + 2 | 371 MB | 219 MB |
| Dev flood, settled | 380 MB | 247 MB |

Trade-off: live Pixi `Graphics` edges (selection ring, drag ghost, effects) are no longer
multisampled. At 2× density this should be hard to see; owner check 6 looks at it.

## Flood memory: what was checked

Plan 1 saw WebContent go from 51 MB to about 395 MB RSS after the flood. That does not reproduce as
physical footprint. With the fix, the flood leaves **+21 MB after 30 s** (226 → 247 MB, dev). xterm
really did process the 50 MB: WebContent CPU time went from 0.67 s to 13.28 s.

Each suspect, checked before any fix:

- **WebglAddon not disposed on unmount.** It is disposed: `term.dispose()` disposes every loaded
  addon (xterm's `AddonManager`). Evidence:
  - Graphics memory stayed flat across 60 remounts.
  - Loading no WebGL addon at all (a temporary toggle) gave the same memory growth as with it.
  - Calling `WEBGL_lose_context.loseContext()` explicitly on unmount had no reproducible effect:
    164 MB vs 165 MB in the GPU process when the order was reversed. It was not committed.
- **The WebGL glyph atlas.** Graphics memory stayed flat, so it is not growing. No change.
- **Frames retained in JS queues.** The backend keeps one frame in flight and sends the next only
  after the ack, which comes after xterm has written the frame. Mounting the terminal without
  writing the 2 MiB snapshot (a temporary toggle) stopped all growth. The frames are not what is
  kept.
- **Disposed `Terminal` objects kept alive.** No. A temporary `FinalizationRegistry` probe showed
  59 of 60 disposed terminals collected.
- **xterm `scrollback: 5000`.** This sets how much each mount allocates. It is not a leak. It was
  lowered to 2000 in fix round 1 (see below).

**Finding: remount churn (not a budget item, but it can break the budget).** Each time the panel
mounts a terminal whose 2 MiB scrollback is full, xterm builds a new 5000-line buffer of about
4.7 MB. JavaScriptCore frees the previous one only at its next full GC. Measured on dev:

- Remounting a flooded terminal: about **+47 MB per 10 remounts**. After 40 remounts the total
  was 419 MB with the panel open (the GPU process read 105 MB of that) and 340 MB with the panel
  closed.
- With scrollback 2000 (temporary change): about **+19 MB per 10 remounts**.
- A terminal with little output: about +0.5 MB per remount.

It is garbage, not a leak: a GC dropped one run from 427 to 405 MB. But a user who flips between
flooded terminals can go past 250 MB.

The version of this file committed in `c562199` said the controller's ruling kept scrollback at 5000. That was wrong:
the ruling only said "not below 1000". The controller then ruled for 2000; see fix round 1.

**GPU process transient.** For some seconds after a flood or a burst of remounts, the WebKit GPU
process holds 140–165 MB. It is back to about 25 MB within 30 s. This happened with and without
`loseContext`. It is why every memory budget is read after a settle.

## Fix round 1: scrollback 2000, and `clearTextureAtlas`

Controller ruling: xterm `scrollback` goes from 5000 to 2000 (`src/components/TerminalView.tsx`).
What you see shrinks from 5000 to 2000 lines. xterm keeps the last 2000 lines; the backend keeps
the last 2 MiB of raw output and replays it on attach, so older output beyond those limits is not
shown.
The test `keeps 2000 lines of scrollback` in `src/components/TerminalView.test.tsx` pins the value.

**Protocol (dev build, driver, fresh app each run, village hidden):**

1. Start 10 `sleep 600` sessions and 2 terminals.
2. Put terminal 1 on screen, run `yes | head -c 50000000` in it, and wait 30 s after it ends.
3. Do the same with terminal 2.
4. Switch the panel between the two flooded terminals 40 times, 700 ms each.
5. Close the panel and wait 30 s.

| Step (total footprint) | scrollback 5000 (before) | scrollback 2000 (after) | 2000 + `clearTextureAtlas()` (tried, not kept) |
|---|---|---|---|
| Idle | 202 MB | 203 MB | 204 MB |
| 10 sleep + 2 terminals | 236 MB | 217 MB | 218 MB |
| Flood terminal 1 + 30 s | **245 MB** | **239 MB** | 240 MB |
| Flood terminal 2 + 30 s | 254 MB | 246 MB | 245 MB |
| 20 switches | 382 MB | 331 MB | 438 MB |
| 40 switches, panel open | 490 MB | 379 MB | 405 MB |
| 40 switches, panel closed + 30 s | **404 MB** | **318 MB** | 316 MB |

The panel-open readings include GPU-process transients of 70–107 MB, which were gone after the
settle.

What this shows:

- With 2000 lines, the flood + 30 s figure is 239 MB for one flooded terminal and 246 MB for two.
  Both are still PROVISIONAL lower bounds, because the village was hidden.
- Remount churn falls by about 86 MB after 40 switches (404 → 318 MB). It still ends **above
  250 MB**. JSC releases the old buffers only at a full GC, and lowering scrollback reduces how
  much is waiting, but not the mechanism. The follow-up stays open.
- **`term.clearTextureAtlas()` before `term.dispose()` changed nothing** (318 vs 316 MB after the
  settle, within noise), so it was not kept.
- The WebGL addon was already disposed on unmount, because `term.dispose()` disposes every loaded
  addon. Nothing else to add there.

## Method

**Memory.** `footprint -f bytes -p <app> -p <WebContent> -p <GPU> -p <Networking>`, reading
"Summary Footprint" (physical footprint, as Activity Monitor shows it). The WebKit helpers are XPC
services, not child processes. They are identified as the `com.apple.WebKit.*` processes started
within 60 s after the app. No other WebKit helper started in that window. `scripts/budget.sh mem`
does this.

**CPU.** The summed `ps -o %cpu` of the same four processes, sampled every 1 s for 20 s and
averaged. macOS `%cpu` is a decaying average, so the CPU-time delta (`ps -o time`) over the same
interval is reported as well. `scripts/budget.sh cpu` does both.

**Load (dev, `COC_DRIVER=1`).** In `~/Documents/coc-check`:

- 10 custom builders `Bench1..10`, each with command `sleep 600`, each started with an empty task:
  `__cocDriver.ipc.createBuilder(name,'custom',null,null,'sleep 600')`, then
  `startSession(wsId, id, '')`.
- 2 terminals: `startTerminal(wsId)`.
- Then terminal 1 was selected so its panel was mounted.
- Flood: `writeSession(t1, bytes of "yes | head -c 50000000\r")`. Memory was sampled every 5 s,
  and again 30 s after `yes` had exited.

**Cold start.** The debug binary was launched against a running `pnpm dev`. The driver was polled
with a 250 ms client timeout, because an eval sent before the page loads is lost and the driver
answers it only after 10 s. `scripts/budget.sh cold` does the same, but waits for the village to
be visible, not just built.

**Clean-up after each run.** Every session was stopped and closed, the `Bench*` builders were
deleted, `unfront()` was called, and the dev and release apps were quit. Running the load had
grown coc-check's compound (7 → 10 wide). `state.json` was restored byte-for-byte from the copy
taken before the run. The other workspaces were never touched.

## Owner checklist

These need an unlocked screen or a real input device.

- Build the release app with `pnpm tauri build --bundles app`. It appears at
  `src-tauri/target/release/bundle/macos/Clash of Claudes.app`.
- Run `scripts/budget.sh` in a terminal while the app runs.

**1. Focused CPU (release), target ≤ 5% of one core.**

1. `open "src-tauri/target/release/bundle/macos/Clash of Claudes.app"`.
2. Click once on empty grass so the window has focus. Do not cover it with another window.
3. Wait 10 s, then run `scripts/budget.sh cpu`.
4. Repeat while one builder is walking or building (start any session), since that is the
   animating case.

Record both values.

**2. Frame rate, focused and unfocused (dev).**

1. Run `COC_DRIVER=1 pnpm tauri dev` and click the village.
2. Run `scripts/drive.sh '({fps:__cocDriver.scene().fps, running:__cocDriver.scene().running})'`.
   Expect about 30 fps and `running:true`.
3. Click another app's window so Clash of Claudes stays visible but loses focus. Wait 2 s and run
   the same command. Target: ≤ 15 fps.

**3. Minimized (dev).**

1. Leave the screen unlocked and press Cmd+M on the app.
2. Run `scripts/drive.sh '({fps:__cocDriver.scene().fps, running:__cocDriver.scene().running})'`.
   Expect `{fps:0, running:false}`.
3. Run `scripts/budget.sh cpu`. Expect about 0%.
4. Click the Dock icon to restore. `running` must return to `true`.

**4. Cold start to village visible, target ≤ 2 s.**

1. Run `pnpm dev` in one terminal. The debug binary must already exist (it does after any
   `pnpm tauri dev`).
2. Quit every running copy of the app.
3. Run `scripts/budget.sh cold` with the screen unlocked. It prints "launch to village visible: N s". If the village is still hidden after 30 s, it gives up.
4. Quit that app afterwards.

This is the unbundled dev build, which is slower than release. If it is over 2 s, time the release
app by eye: from `open` until the village is drawn.

**5. Memory with the village drawing, target ≤ 250 MB.**

The ground is baked at half density and scales with the village, so measure with a village of
**at least 5 workspaces** (each with its compound on the map). Check the count first:
`scripts/drive.sh '__cocDriver.state().workspaces.length'`. If it is under 5, add bench workspaces
(they are new empty folders; remove them in the clean-up step):

```
scripts/drive.sh "(async()=>{const n=()=>__cocDriver.state().workspaces.length;for(let i=1;n()<5&&i<=5;i++){await __cocDriver.ipc.createWorkspace('$HOME/Documents','coc-bench'+i)}return n()})()"
```

1. Open the release app (same workspaces) and keep it visible and focused for 30 s.
2. Run `scripts/budget.sh mem` and record the total.
3. For the loaded case, use the dev build with the screen unlocked and the window visible:
   1. Run the load setup from "Method". It finds the `coc-check` workspace by name (never by a
      hard-coded id) and fails loudly if it is missing:
      ```
      scripts/drive.sh '(async()=>{const w=__cocDriver.state().workspaces.find((x)=>x.name==="coc-check");if(!w)throw new Error("no workspace named coc-check");const ws=w.id;const ipc=__cocDriver.ipc;for(let i=1;i<=10;i++){const b=await ipc.createBuilder("Bench"+i,"custom",null,null,"sleep 600");await ipc.startSession(ws,b.id,"")}const t=await ipc.startTerminal(ws);await ipc.startTerminal(ws);__cocDriver.state().setSelection({kind:"session",id:t.id});return t.id})()'
      ```
   2. Run `scripts/budget.sh mem`.
   3. Type `yes | head -c 50000000` in the terminal on screen. Wait 30 s after it ends and run
      `scripts/budget.sh mem` again.
   4. Subtract about 27 MB for release.
   5. Clean up: Stop, then Close, every Bench session and both terminals, and delete the Bench
      builders. Remove any `coc-bench*` workspaces you added (Workspace panel → Remove), then
      delete their folders.

**6. Village edges without MSAA.**

1. With a few sessions, select a structure and drag a house.
2. Check the selection ring, the drag ghost and the effects. Look for jagged edges that bother you.
   If there are any, report them: MSAA costs about 120 MB, so the fix would be something else.

**7. Quit dialog, Cmd+Q.**

1. Start 2 sessions.
2. Press Cmd+Q. A dialog mentioning 2 running sessions must appear.
3. Press Cancel. The app must stay open.
4. Press Cmd+Q again and confirm. The app must exit.
5. Run `pgrep -f "sleep 600"` (or `pgrep -f "claude --session-id"`). It must print nothing.

**8. Quit dialog, red close button.** Same as check 7, but click the red window button instead of
pressing Cmd+Q.

**9. Folder picker.**

1. Click the town hall. The town hall panel opens.
2. Click "Open folder" and choose a folder. A native picker must appear.
3. Look for: a new compound appears in the village and the camera eases to fit it.
4. Remove that workspace afterwards.

**10. Mouse drag feel.**

1. Drag on empty grass. The village must pan with no lag, and no click is registered after the
   drag.
2. Drag a structure, and then a house, to a free spot. They must follow the cursor and drop
   there.
3. Drag them onto a blocked spot. They must refuse and snap back.

**11. Trackpad.**

1. Scroll with two fingers over the village. It must zoom towards the cursor smoothly.
2. Pinch. Note whether the village zooms, or whether WebKit magnifies the whole page instead.
   Magnifying the page is a bug to report.
3. The +, − and "Village" zoom buttons must still work afterwards.
