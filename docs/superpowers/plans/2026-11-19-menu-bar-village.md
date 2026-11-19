# Menu Bar Village Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the owner's queue visible without the main window: a menu bar item with the count and a queue dropdown (Allow / Deny / Open), a global ⌃⌥⌘J shortcut, closing the window hides it, and an always-on-top mini village panel.

**Architecture:** Rust gets a port of the queue rules (`queue.rs`) that drives the Dock badge and a native tray menu (`tray.rs`), rebuilt only when its model changes. The main window hides on close so its frontend jobs (auto-start, layout, sounds) keep running. The mini village is a second webview (`?view=mini`) that renders only `VillageCanvas`, runs no background jobs, and is turned into a non-activating NSPanel through `objc2-app-kit`.

**Tech Stack:** Tauri 2 (`tray-icon`, `image-png` features; `tauri-plugin-global-shortcut`), Rust, objc2 0.6 / objc2-app-kit 0.3, React 19, Pixi 8, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-menu-bar-village-design.md`

## Global Constraints

- macOS 13+, Tauri 2. No new third-party crates; Tauri's own plugins and features are allowed.
- Never edit agent configuration; no new network connections.
- Menu bar rows never show task text or the agent's title. A decision row shows the tool call (`asking`) cut to **60 characters** with "…".
- At most **10** rows in the menu; past that a disabled "and N more" line.
- Shortcut: **⌃⌥⌘J**, on by default, Settings toggle; failure message "⌃⌥⌘J is taken by another app". No rebinding UI.
- Mini window: min **240×160**, default **360×240**, always on top, all Spaces, over full-screen apps, never takes keyboard focus.
- The mini window runs none of: `autoStart`, `autoLayout`, `autoSnapshots`, `watchSounds`, `watchElixir`, `tidyOnce`, the tour, the splash.
- Other agents may share this working tree: commit only the files your task touched (`git add <paths>`), never `git add -A`, never `git stash`. Work on `main`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Checks before each commit: `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `pnpm vitest run`, `pnpm exec tsc --noEmit`.

## Review Focus

1. **A stale Allow/Deny from a menu built minutes ago** (the prompt was answered in the terminal or replaced by a newer one): must do nothing. Pinned by Task 1's `deny_if_ignores_a_replaced_prompt` and Task 3's ids carrying `state_since`.
2. **A tool call with multi-byte characters** (emoji, CJK, a path with accents) longer than 60 characters: truncation must cut on a character boundary, never panic. Pinned by Task 3's `row_label_cuts_on_char_boundary`.
3. **Menu rebuild storm**: `session-updated` fires on every tool step and output tick; the native menu must only be rebuilt when its model changes. Pinned by Task 3's `tray_cache_reports_only_changes`.
4. **Quit (⌘Q or the menu bar) while the window is hidden and sessions run**: the window must come forward with the "N sessions are still running" confirmation. Pinned by Task 2's manual check.
5. **A saved mini window position on a monitor that is no longer connected**: it must open on a visible screen. Pinned by Task 6's `clamp_moves_offscreen_rect_onto_a_screen`.

---

### Task 1: One queue, in Rust

**Files:**
- Create: `src-tauri/src/queue.rs`
- Modify: `src-tauri/src/lib.rs` (`mod queue;`, `refresh_badge` at ~line 78)
- Modify: `src-tauri/src/notify.rs` (remove `badge_count` and its test `badge_counts_needs_and_finished`)
- Modify: `src-tauri/src/sessions.rs` (add `deny_if` next to `approve_if`, ~line 917)
- Modify: `src/state/queue.ts` (comment pointing at the Rust twin)

**Interfaces:**
- Produces:
  - `pub enum QueueReason { Decide, Answer, Stuck, Review }` (`Clone, Copy, Debug, PartialEq, Eq`), `pub fn label(self) -> &'static str` returning exactly the TS `QUEUE_LABEL` strings ("Wants a decision", "Asking you", "Stuck", "Ready to review").
  - `pub struct QueueItem { pub reason: QueueReason, pub session: SessionInfo }`
  - `pub fn queue_reason(s: &SessionInfo) -> Option<QueueReason>`
  - `pub fn waiting_since(s: &SessionInfo) -> i64` (first non-zero of `state_since`, `last_output_at`, `started_at`)
  - `pub fn owner_queue(sessions: &[SessionInfo], workspace_ids: &[String]) -> Vec<QueueItem>`
  - `pub fn waited_label(ms: i64) -> String` ("just now", "4m", "1h 20m")
  - `SessionManager::deny_if(&self, id: &str, since: i64) -> Result<()>`
  - `pub(crate) fn queue_now<R: Runtime>(app: &AppHandle<R>) -> Vec<QueueItem>` in `lib.rs` (manager list + workspace ids from `AppState.data`)

- [ ] **Step 1: Write the failing tests in `queue.rs`** (`#[cfg(test)] mod tests`, with a `sess(id, state, f: impl FnOnce(&mut SessionInfo))` helper modeled on `notify.rs`'s `info`). Mirror `src/state/queue.test.ts` case for case:
  - `order_decide_answer_stuck_review_oldest_first`: the seven sessions of the TS test `the queue: decisions, then questions…` give ids `["decide-old","decide-new","ask","stuck","review-old","review-new"]` with matching reasons.
  - `parked_paused_terminal_orphaned_stay_out`: parked (`parked: Some("")`), paused, a terminal, and a session whose `workspace_id` is not in the list → empty queue.
  - `waited_label_formats`: `0 → "just now"`, `59_999 → "just now"`, `240_000 → "4m"`, `4_800_000 → "1h 20m"`, negative → `"just now"`.
- [ ] **Step 2: Write the failing test in `sessions.rs`**: `deny_if_ignores_a_replaced_prompt`, modeled on the existing `approve_if` test: a session awaiting a decision at `state_since = 10`; `deny_if(id, 5)` is `Err` and writes nothing to the PTY; `deny_if(id, 10)` is `Ok`.
- [ ] **Step 3: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib queue deny_if`. Expected: FAIL (module/functions missing).
- [ ] **Step 4: Implement** `queue.rs` per the interfaces (same sort as TS: rank, then `waiting_since`, then id), `deny_if` as `self.answer_if(id, false, Some(since))`, and `queue_now`. Change `refresh_badge` to use `queue_now(app).len() as i64`; delete `notify::badge_count`. In `queue.ts`, add one line above `queueReason`: `// Mirrored in src-tauri/src/queue.rs (menu bar, Dock badge): change both, and both tests.` and the reverse pointer in `queue.rs`.
- [ ] **Step 5: Run** the three checks from Global Constraints. Expected: all PASS.
- [ ] **Step 6: Commit** `queue.rs`, `lib.rs`, `notify.rs`, `sessions.rs`, `queue.ts`: "One queue in Rust too: the Dock badge counts what ▶ N waiting counts".

### Task 2: Closing the window hides it

**Files:**
- Modify: `src-tauri/src/lib.rs` (`on_window_event` ~line 409, `.run(...)` ~line 505)
- Modify: `src-tauri/src/commands.rs` (`emit_confirm_quit` ~line 1134)

**Interfaces:**
- Produces: `pub(crate) fn show_main<R: Runtime>(app: &AppHandle<R>)` in `lib.rs` (show, unminimize, set_focus); `focus_and_select` calls it.

- [ ] **Step 1: Implement.** `CloseRequested` on `main` → `api.prevent_close()` and `window.hide()`, always (the quit guard moves entirely to `ExitRequested`). `RunEvent::Reopen { has_visible_windows: false, .. }` → `show_main`. `emit_confirm_quit` calls `show_main` before emitting, so the confirmation is seen when the window was hidden. Leave the `Destroyed` → `snapshot::close` branch as is.
- [ ] **Step 2: Run** the three checks. Expected: PASS.
- [ ] **Step 3: Manual check** with `pnpm app`: (a) start a custom-command session, close the window with ⌘W: app keeps running, the Dock icon stays; (b) click the Dock icon: the window returns, session still running; (c) hide again, press ⌘Q from the app menu (via the Dock icon's menu → Quit): window comes forward with "1 sessions are still running…"; Cancel keeps it running; (d) a self-starting To Do whose builder frees up while hidden still starts.
- [ ] **Step 4: Commit** `lib.rs`, `commands.rs`: "Closing the window hides it; agents keep working".

### Task 3: Menu bar item and queue menu

**Files:**
- Create: `src-tauri/src/tray.rs`
- Create: `src-tauri/icons/tray-template.png` (18×18), `src-tauri/icons/tray-template@2x.png` (36×36): black glyph on transparent, from the app icon's crossed-swords/helmet shape
- Modify: `src-tauri/Cargo.toml` (`tauri` features `["tray-icon", "image-png"]`)
- Modify: `src-tauri/src/lib.rs` (`mod tray;`, build the tray in `setup`, call `tray::refresh` wherever `refresh_badge` is called, handle tray menu events)

**Interfaces:**
- Consumes: `queue::{QueueItem, QueueReason, waited_label}`, `queue_now`, `SessionManager::{approve_if, deny_if, answerable}`, `focus_and_select`, `show_main`, `QUIT_MENU_ID` quit path.
- Produces:
  - `#[derive(Clone, Debug, PartialEq)] pub struct TrayRow { pub session_id: String, pub reason: QueueReason, pub label: String, pub decide_since: Option<i64> }`
  - `#[derive(Clone, Debug, PartialEq)] pub struct TrayModel { pub count: usize, pub header: String, pub rows: Vec<TrayRow>, pub more: usize, pub mini_open: bool }`
  - `pub fn row_label(builder: &str, detail: &str, waited: &str) -> String` → `"{builder} · {detail cut to 60 chars} · {waited}"`
  - `pub fn model(queue: &[QueueItem], builder_name: &dyn Fn(&str) -> String, workspace_name: &dyn Fn(&str) -> String, answerable: &dyn Fn(&str) -> bool, now_ms: i64, mini_open: bool) -> TrayModel`
  - `pub enum TrayAction { Allow { id: String, since: i64 }, Deny { id: String, since: i64 }, Open { id: String }, OpenVillage, ToggleMini, Quit }`, `pub fn action_id(a: &TrayAction) -> String`, `pub fn parse_action(id: &str) -> Option<TrayAction>`; ids: `q:allow:<sid>:<since>`, `q:deny:<sid>:<since>`, `q:open:<sid>`, `tray:open`, `tray:mini`, `tray:quit`.
  - `#[derive(Default)] pub struct TrayCache(Mutex<Option<TrayModel>>)` with `pub fn changed(&self, m: &TrayModel) -> bool`
  - `pub fn refresh<R: Runtime>(app: &AppHandle<R>)` (builds the model, returns early when `TrayCache` says unchanged, else rebuilds the menu and sets the title)
  - `pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()>` (tray id `"main"`, template icon, menu on left click)

- [ ] **Step 1: Write the failing tests in `tray.rs`:**
  - `row_label_cuts_tool_call_at_60`: a 100-char ASCII detail → the detail part is exactly 59 chars + "…"; a 60-char detail is kept whole.
  - `row_label_cuts_on_char_boundary`: a detail of 80 "🔨" → no panic, detail part is 59 "🔨" + "…".
  - `model_header_and_rows`: empty queue → `count 0`, header `"Nothing waiting on you"`; three items → header `"3 waiting on you"`, decide row's label uses `asking` and has `decide_since == Some(state_since)` when `answerable` is true, `None` when false; a review row's detail is the workspace name; a decide row with `asking: None` uses the NeedsYou reason.
  - `model_caps_at_ten`: 13 items → 10 rows, `more == 3`.
  - `action_ids_round_trip`: every `TrayAction` variant through `action_id` → `parse_action` returns it; `parse_action("q:allow:abc:notanumber")` and `parse_action("nope")` → `None`. Session ids contain `-` (uuid), so split on the first two `:` only.
  - `tray_cache_reports_only_changes`: first call true, same model false, a model differing only in a label true.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib tray`. Expected: FAIL.
- [ ] **Step 3: Implement `row_label`, `model`, actions, `TrayCache`.** Truncate with `chars().count()` / `chars().take(59)`. Labels use `waited_label(now_ms - waiting_since)`.
- [ ] **Step 4: Run** the tray tests. Expected: PASS.
- [ ] **Step 5: Implement `init`, `refresh` and event handling.** Menu layout exactly as the spec's sketch: disabled header; separator; per non-empty reason a disabled section label (`reason.label()`), then rows: a row with `decide_since` is a submenu with Allow / Deny / Open, any other row is a plain item (`q:open`); "and N more" disabled when `more > 0`; separator; "Open Village" with accelerator text `Ctrl+Alt+Cmd+J`; `CheckMenuItem` "Mini Village" checked by `mini_open` (until Task 6, `mini_open` is always false and `tray:mini` does nothing); separator; "Quit Clash of Claudes". Title: `Some(count.to_string())` when `count > 0`, else `None`. Events: Allow → `approve_if` + usage `PromptAnswered { allowed: true }`; Deny → `deny_if` + `allowed: false`; errors ignored (stale prompt); neither shows the window. Open → `focus_and_select`. OpenVillage → `show_main`. Quit → the same code path as `QUIT_MENU_ID`. Manage `TrayCache` as state. A background thread calls `tray::refresh` every 60 s so wait labels move (cheap when unchanged).
- [ ] **Step 6: Run** the three checks. Expected: PASS.
- [ ] **Step 7: Manual check** with `pnpm app`: start a Claude Code session that asks permission; the menu bar shows "1"; the menu lists it under "Wants a decision" with the tool call; Allow answers it without the window coming forward; answer one in the terminal, then click the old menu's Allow: nothing happens; the icon tints correctly in light and dark menu bars.
- [ ] **Step 8: Commit** `tray.rs`, the two icons, `Cargo.toml`, `Cargo.lock`, `lib.rs`: "Menu bar: the queue's count, and Allow / Deny / Open from its menu".

### Task 4: Global shortcut ⌃⌥⌘J

**Files:**
- Create: `src-tauri/src/shortcut.rs`
- Modify: `src-tauri/Cargo.toml` (`tauri-plugin-global-shortcut = "2"`), `src-tauri/src/lib.rs` (plugin, `mod shortcut;`, setup, `invoke_handler`), `src-tauri/src/model.rs` (`Settings.global_shortcut: bool`, `#[serde(default = "default_true")]`), `src-tauri/src/commands.rs` (`set_settings` re-applies the shortcut when the flag changed), `src-tauri/capabilities/default.json` only if the plugin needs a permission for Rust-side registration (it should not)
- Modify: `src/api/types.ts` (`globalShortcut?: boolean`), `src/api/ipc.ts` (`shortcutStatus`), `src/panels/SettingsPage.tsx` (Notifications card, ~line 275)
- Test: `src/panels/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: `queue_now`, `focus_and_select`, `show_main`.
- Produces:
  - `pub const ACCELERATOR: &str = "Control+Alt+Super+J"`
  - `#[derive(Default)] pub struct ShortcutState { pub taken: AtomicBool }`
  - `pub fn apply<R: Runtime>(app: &AppHandle<R>, enabled: bool)` (register or unregister; sets `taken` on register failure)
  - `pub fn on_pressed<R: Runtime>(app: &AppHandle<R>)` (first queue item → `focus_and_select`, else `show_main`)
  - command `shortcut_status() -> ShortcutStatus { enabled: bool, taken: bool }` (camelCase); TS `ipc.shortcutStatus(): Promise<{ enabled: boolean; taken: boolean }>`

- [ ] **Step 1: Write the failing frontend test** `settings shows the global shortcut toggle and a taken note`: with `ipc.shortcutStatus` mocked to `{ enabled: true, taken: true }`, the Notifications card shows a checkbox labelled "⌃⌥⌘J opens your queue from any app" (checked) and the text "⌃⌥⌘J is taken by another app"; with `taken: false` the note is absent; unticking calls `ipc.setSettings` with `globalShortcut: false`.
- [ ] **Step 2: Run** `pnpm vitest run src/panels/SettingsPage.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** Rust (`apply` at setup from saved settings; handler fires on `ShortcutState::Pressed` only) and the Settings UI; refetch `shortcutStatus` after saving.
- [ ] **Step 4: Run** the three checks. Expected: PASS.
- [ ] **Step 5: Manual check**: from another app, ⌃⌥⌘J opens the first queue item; with an empty queue it shows the window; turning it off in Settings frees the keys.
- [ ] **Step 6: Commit** the touched files: "⌃⌥⌘J opens your queue from any app".

### Task 5: Mini village frontend

**Files:**
- Create: `src/state/hydrate.ts`, `src/MiniApp.tsx`, `src/MiniApp.css`, `src/MiniApp.test.tsx`
- Modify: `src/App.tsx` (use `hydrate.ts`), `src/main.tsx` (pick the app by `?view=mini`; no splash or driver in mini), `src/village/VillageCanvas.tsx` (`mini` prop), `src/api/ipc.ts` (`toggleMini`, `focusSession`), `src/panels/commands.ts` (palette command)

**Interfaces:**
- Produces:
  - `export function subscribeState(onError: (e: unknown) => void): { stop: () => void; loaded: Promise<void> }` in `hydrate.ts`: the session/workspace/stats/quota/apps listeners plus `listState` → `hydrate`, `getQuotas`, `detectAgents`. `App.tsx` keeps its own extras (select-session, confirm-quit, settings, bug report, background jobs, layout after `loaded`).
  - `VillageCanvas` prop `mini?: boolean`: `onSelect` → `ipc.focusSession(sel?.kind === 'session' ? sel.id : null)`; `canMove` → `false`; no `ZoomControls`; `panelWidth` → 0; no haptics; board clicks ignored; `fitVillage()` after the first sync and whenever the workspace count changes.
  - `ipc.toggleMini(): Promise<void>` → command `toggle_mini`; `ipc.focusSession(id: string | null): Promise<void>` → command `focus_session` (both implemented in Task 6).
  - Palette command `{ id: 'mini-village', group: 'Actions', label: 'Mini village', hint: 'A small village that stays on top', run: () => ipc.toggleMini() }`.
- [ ] **Step 1: Write the failing tests** in `MiniApp.test.tsx` (mock `./api/ipc`, `./village/VillageCanvas`, `./state/autoStart`, `./state/sounds`, `./state/elixirWatch`, `./state/snapshots`):
  - `mini runs no background jobs`: render `<MiniApp />`; `autoStart`, `watchSounds`, `watchElixir`, `autoSnapshots` were not called; `ipc.listState` was called once.
  - `mini close button toggles the window`: clicking the button labelled "Close mini village" calls `ipc.toggleMini`.
  - `the top strip is a drag region`: the header has the attribute `data-tauri-drag-region`.
  And in `src/panels/CommandPalette.test.tsx` (or `commands` tests): `palette offers the mini village` → `paletteCommands(...)` includes id `mini-village`.
- [ ] **Step 2: Run** `pnpm vitest run src/MiniApp.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** `hydrate.ts` (extract, don't copy, from `App.tsx`), `MiniApp` (a 22 px header strip with "Mini Village" and ✕, then `<VillageCanvas mini />` filling the rest), `main.tsx` switch, the `mini` prop, ipc functions, palette command.
- [ ] **Step 4: Run** the three checks. Expected: PASS (existing `App.test.tsx` still passes with the extraction).
- [ ] **Step 5: Commit** the touched files: "Mini village view: the village alone, with no background jobs".

### Task 6: Mini village window as a floating panel

**Files:**
- Create: `src-tauri/src/mini.rs`, `src-tauri/capabilities/mini.json`
- Modify: `src-tauri/Cargo.toml` (`objc2-app-kit` features add `NSWindow`, `NSPanel`, `NSResponder`, `NSScreen` as needed), `src-tauri/src/model.rs` (`Settings.mini_window: Option<MiniWindow>`; `MiniWindow { x: f64, y: f64, w: f64, h: f64, open: bool }`, logical points, camelCase), `src-tauri/src/lib.rs` (`mod mini;`, commands, reopen on launch, `on_window_event` branch for `mini` before the `main`-only early return), `src-tauri/src/tray.rs` (`mini_open` from `mini::is_open`, `ToggleMini` → `mini::toggle`, refresh after toggling), `src/api/types.ts` (`miniWindow?`)

**Interfaces:**
- Consumes: `focus_and_select`, `show_main`, `tray::refresh`, ipc names from Task 5.
- Produces:
  - `pub const LABEL: &str = "mini"`; `pub fn open/close/toggle<R: Runtime>(app: &AppHandle<R>)`; `pub fn is_open<R: Runtime>(app: &AppHandle<R>) -> bool`
  - `pub fn clamp(rect: Rect, screens: &[Rect]) -> Rect` (`Rect { x, y, w, h: f64 }`): unchanged when at least 40×40 of it is on some screen; otherwise moved to the top-right corner of the first screen with a 16 pt margin; size clamped to ≥ 240×160 and ≤ the screen.
  - commands `toggle_mini()`, `focus_session(id: Option<String>)` (some → `focus_and_select`, none → `show_main`)
- [ ] **Step 1: Write the failing tests in `mini.rs`:** `clamp_keeps_visible_rect` (rect inside a screen unchanged), `clamp_moves_offscreen_rect_onto_a_screen` (rect at x = 5000 with one 1440×900 screen → `x = 1440 - w - 16, y = 16`), `clamp_enforces_min_size` (100×50 → 240×160), `default_rect` (no saved geometry → 360×240 at the top-right of the first screen).
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib mini`. Expected: FAIL.
- [ ] **Step 3: Implement `clamp` and the window.** `WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?view=mini".into()))`, `.decorations(false)`, `.always_on_top(true)`, `.visible_on_all_workspaces(true)`, `.skip_taskbar(true)`, `.accept_first_mouse(true)`, `.resizable(true)`, `.min_inner_size(240.0, 160.0)`, size and position from `clamp(saved or default, monitors)`. `capabilities/mini.json`: windows `["mini"]`, permissions `core:default`, `core:window:allow-start-dragging`. Save geometry on `Moved` / `Resized` (in memory at once; persist after 500 ms without another event), `open` on open/close. In setup, reopen when `mini_window.open`.
- [ ] **Step 4: Make it a non-activating panel (macOS).** After build, from `window.ns_window()`: swap the window's class to a runtime `NSPanel` subclass that returns `false` from `canBecomeMainWindow` (the approach the `tauri-nspanel` plugin uses), add `NSWindowStyleMask::NonactivatingPanel`, set `setFloatingPanel(true)`, `setHidesOnDeactivate(false)`, and collection behaviour `CanJoinAllSpaces | FullScreenAuxiliary`. All AppKit calls on the main thread (`run_on_main_thread`). **If this proves unsafe or crashes and can't be fixed in reasonable time, stop and report to the owner before falling back to a plain window** (spec, Design › 5).
- [ ] **Step 5: Run** the three checks. Expected: PASS.
- [ ] **Step 6: Manual check** on an installed build (`pnpm app:install`): open from the menu bar and from ⌘K; typing in the editor continues while dragging and clicking the panel; the panel shows over a full-screen editor and on every Space; clicking a builder opens the main window on that session; it stays at 15 fps (scene's unfocused cap); quit with it open → it reopens at the same place; unplug the external monitor it was on → it opens on the built-in screen.
- [ ] **Step 7: Commit** the touched files: "Mini village: a floating panel that stays on top and never takes focus".

### Task 7: Docs

**Files:**
- Modify: `README.md` (First run, Notifications, Privacy), `docs/superpowers/specs/2026-11-19-menu-bar-village-design.md` (Status: built)

- [ ] **Step 1: Update README.** First run: closing the window keeps agents working; the app stays in the menu bar; ⌘Q quits. Notifications: the menu bar item (count, menu, Allow / Deny), ⌃⌥⌘J and its Settings toggle, the mini village, and that the Dock badge now counts what **▶ N waiting on you** counts (stuck included, parked and paused out). Privacy: one sentence that the menu bar menu shows a waiting permission's tool call (a command, path or URL, cut short), never task text.
- [ ] **Step 2: Commit** `README.md` and the spec: "README: the menu bar, ⌃⌥⌘J and the mini village".
