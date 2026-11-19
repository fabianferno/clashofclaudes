# Menu bar village and mini village: design

Date: 2026-11-19. Status: owner's answers folded in, waiting for approval.

## Why

The app's value is seeing at a glance which agent needs you. But the full window sits behind the
editor most of the day, and a notification only covers the moment something changes: miss one and
nothing on screen says a builder has waited 20 minutes. This feature keeps the queue visible
without the window:

- a **menu bar item** with the waiting count, a dropdown of the queue with Allow / Deny, and a
  system-wide shortcut;
- a small **always-on-top mini village** to park in a corner or on a second monitor.

It came out of the 10x session of 2026-11-18 (`.claude/docs/ai/clash-of-claudes/10x/session-2.md`,
Medium #2).

## Goals

1. The waiting count is always visible in the menu bar while the app runs, window open or not.
2. A permission prompt (Claude Code, Antigravity) can be allowed or denied from the menu bar
   without the window coming forward.
3. Any queue item can be opened from the menu bar or with one shortcut from any app.
4. Closing the window keeps agents running; the app lives on in the menu bar.
5. A live village can stay on screen in a small window above other apps.

## Non-goals

- A styled (game-look) popover for the dropdown. Considered and deferred (see Approaches).
- Answering questions, reviewing, following up or parking from the menu bar. Those open the app.
- Showing task text or terminal output in the menu bar. (A permission row does show the tool call,
  which can hold a command, a path or a URL: see Design › 3.)
- App boards, their snapshots, opened browsers and closing animations in the mini village. That state
  lives only in the main window's memory; syncing it between windows is out of scope.
- Interacting with the village from the mini window beyond clicking a builder or structure
  (no dragging, no building, no panels).
- Launch at login. Separate feature.

## Anti-goals (would make this a failure even if it works)

- **The menu bar count disagreeing with ▶ N waiting on you.** Both must use the same rules.
- **Auto-started To Dos stopping when the window is closed**, or starting twice because a second
  window runs them too.
- **Clicking the menu bar icon pulling the village window in front of the editor.**
- A quit path that skips the existing "N sessions are still running" confirmation.

## Constraints

- Tauri 2, macOS 13+. No new third-party (non-Tauri) crates.
- The app never edits agent configuration and makes no new network connections (README › Privacy).
- To Dos that start on their own, layout, snapshots and elixir warnings run in the main window's
  frontend (`src/App.tsx` effect: `autoStart`, `autoLayout`, `autoSnapshots`, `watchElixir`,
  `watchSounds`). They must keep running while the window is closed, and only once.
- The queue's rules live in `src/state/queue.ts` (`queueReason`, `ownerQueue`, `waitedLabel`).
- The Dock badge is computed in Rust (`notify.rs::badge_count`) with different rules: it counts
  NeedsYou and Finished but not Stuck, and does not skip paused or parked sessions.

## Decisions made with the owner

1. **Closing the window keeps the app running in the menu bar** (option A). The window is hidden,
   not destroyed, so the frontend's background jobs keep running.
2. **The dropdown is a native macOS menu built in Rust** (approach 1 below).
3. **A permission row shows the tool call**, cut to about 60 characters, so Allow approves
   something the owner can read (not a blind approval).
4. **The mini village is a non-activating floating panel**: it never takes focus from the editor
   and shows over full-screen apps.
5. **The mini village draws compounds, structures and builders only** (no boards). Claude's call,
   accepted by the owner.
6. **The shortcut is ⌃⌥⌘J**, not ⌘⇧J: a global shortcut silently takes its keys from every app,
   and ⌘⇧J is Downloads in Chrome and bound in some editors. Claude's call, accepted by the owner.

## Approaches

1. **Native macOS menu, built in Rust (picked).** Rust holds the session state and rebuilds the
   tray menu when the queue changes. Works while the window is hidden, opens over full-screen apps,
   never steals focus, needs no extra webview. Cost: the queue's ordering rules (~30 lines) are
   ported to Rust and kept in step with `queue.ts`; the menu looks like macOS, not the game; wait
   times don't tick while the menu is open.
2. **Game-styled popover window.** React, reusing `queue.ts`, on-brand, live timers. Rejected for
   now: Tauri shows it as an ordinary window, which activates the app and can bring the village
   window in front of the editor; it may open on another Space over full-screen apps; positioning
   and hide-on-blur are fiddly. Doing it properly needs a third-party non-activating panel plugin.
   Can replace the dropdown later without changing anything else here.
3. **No dropdown, count only, click opens the window.** Rejected: loses Allow from the menu bar,
   which is the most frequent action.

## Design

### 1. Window lifecycle

- **Close (red button, ⌘W)** hides the main window instead of closing it. No confirmation, since
  nothing stops. `WindowEvent::CloseRequested` on `main` → `prevent_close()` + `hide()`.
- **Quit** (⌘Q, the app menu, the menu bar menu) goes through the existing `ExitRequested`
  guard and its confirmation. While the window is hidden and sessions run, quitting first shows
  the window so the confirmation can be seen.
- **Clicking the Dock icon** while the window is hidden shows it (`RunEvent::Reopen`).
- The Dock icon stays (no switch to a menu-bar-only "accessory" app). The Dock badge keeps working.
- The hidden window's `Focused` state counts as unfocused, so notifications keep showing.
- The existing `Destroyed` → `snapshot::close` handling stays for a real destroy at exit.

### 2. One queue, in Rust too

- New Rust module `queue.rs` mirroring `queue.ts`: `queue_reason(&SessionInfo)`,
  `owner_queue(&[SessionInfo], workspace ids)` (same ranks: decide, answer, stuck, review; oldest
  `state_since` first; ties by id), `waited_label(ms)`.
- Each function carries a comment pointing at its TypeScript twin, and both sides get the same
  table of test cases, so the two can't drift silently.
- The Dock badge switches to `owner_queue(..).len()`. It will then also count stuck sessions and
  skip paused and parked ones, matching ▶ N waiting on you. (A visible change, noted in the README.)

### 3. Menu bar item

- **Icon**: a monochrome template image (a small crossed-swords or helmet glyph made from the app
  icon's shape), so macOS tints it for light and dark menu bars.
- **Title next to the icon**: the queue count when it's above zero ("3"); nothing when it's zero.
- **Menu** (rebuilt whenever the queue's contents or labels change; rebuilt on open to refresh
  wait times if Tauri exposes a menu-will-open hook, otherwise once a minute while non-empty):

  ```
  3 waiting on you                      (disabled header; "Nothing waiting on you" when empty)
  ─────────────
  Wants a decision                      (disabled section label, only when it has items)
    Sir Hammer · Bash: npm test · 4m  ▸   Allow
                                          Deny
                                          Open
  Ready to review
    Codex Carl · webapp · 12m         ▸   Open      (or the row itself opens, see builder's call)
  ─────────────
  Open Village                   ⌃⌥⌘J
  Mini Village                         (checkmark when it's open)
  ─────────────
  Quit Clash of Claudes
  ```

- **Row text**: builder name, then for a decision the tool call (`asking`, already in
  `SessionInfo`, built by each adapter's `tool_summary`; it can hold a full command, a file path,
  a URL or a subagent's description), cut to about 60 characters with "…"; otherwise the workspace
  name; then the wait ("4m", "just now"). Never task text or the agent's title. The menu only shows
  while the owner holds it open, unlike a notification on the lock screen. README › Privacy gains
  a sentence saying the menu bar shows the pending tool call.
  When `asking` is empty for a decision, the row shows the NeedsYou reason instead.
- **Allow / Deny** appear only when `awaiting_decision` is true and the agent supports answering
  (Claude Code, Antigravity, same rule as the notification's Allow). They call the same manager
  methods as the `approve` / `deny` commands and record the same usage event. The window does not
  come forward. If the prompt was answered meanwhile, the click does nothing harmful (the manager
  already refuses a stale answer; verify, and if it doesn't, check `awaiting_decision` first).
- **Open** (or clicking a row without a submenu) calls the existing `focus_and_select`, which shows
  the window and selects the session as its queue item.
- At most 10 rows are listed; past that, a disabled "and N more" line. "Open Village" covers the rest.

### 4. Global shortcut

- **⌃⌥⌘J**, through Tauri's official `global-shortcut` plugin: shows the window and opens the
  first queue item (as ⌘J does inside the window). With an empty queue it just shows the window.
- On by default. If registration fails (another app holds the same global shortcut), the app keeps
  working and Settings shows "⌃⌥⌘J is taken by another app". No rebinding UI in this version.
- Settings gets a toggle to turn the shortcut off.

### 5. Mini village window

- A second webview window, label `mini`, loading the same page with `?view=mini`.
- **Frontend in mini mode**: `main.tsx` renders a `MiniApp` instead of `App`. `MiniApp` subscribes
  to the same events and hydrates from `list_state` / `get_quotas`, then renders only
  `VillageCanvas` (no HUD, side panel, Kanban, palette, tour, sounds, splash, game cursor). It runs
  **none** of the background jobs (`autoStart`, `autoLayout`, `autoSnapshots`, `watchSounds`,
  `watchElixir`, `tidyOnce`, the tour). This is what keeps To Dos from starting twice.
- **Panel, not a plain window**: after Tauri creates the window, convert it (via the `objc2` /
  `objc2-app-kit` crates the app already depends on; no new crate) into a non-activating floating
  panel: clicking or dragging it never takes keyboard focus from the frontmost app, and its
  collection behaviour joins all Spaces and shows over full-screen apps (`canJoinAllSpaces` +
  `fullScreenAuxiliary`). Clicking a builder *does* bring the main window forward, on purpose.
  If converting Tauri's NSWindow in place proves unsafe, the builder reports back before falling
  back to a plain window.
- **Window**: always on top, visible on all Spaces, resizable (min about 240×160, default 360×240),
  with a thin draggable top strip and a close button; no full title bar. It remembers its position
  and size between openings and launches (saved in Settings: `mini_window: { x, y, w, h, open }`).
  It reopens on launch if it was open at quit.
- **Camera**: fits all compounds into the window on open and when workspaces are added or removed.
  Zooming with the trackpad works; panning by dragging works.
- **Clicking** a builder or structure brings up the main window with that session selected
  (`focus_and_select` via a command). Clicking the Town Hall or empty ground shows the main window.
- **Opened from**: the menu bar menu ("Mini Village", a toggle), and the ⌘K palette.
- **Capability**: `src-tauri/capabilities` gets the `mini` window added with only the permissions
  it uses (the same core/event/command set as `main`, minus dialog).
- **Rendering cost**: the mini village runs its own Pixi renderer. It should cap its frame rate
  lower than the main window (e.g. 30 fps) if Pixi allows it simply.

## Left to the builder

- The tray icon artwork (template PNG at 1x/2x), within the "monochrome glyph from the app icon"
  direction.
- How menu rebuilds are triggered (on every `session-updated`, debounced, or diffed against the
  last rendered queue). It must not rebuild the menu on every terminal output tick.
- Whether a row without Allow/Deny is a plain clickable item or a one-item submenu.
- How `MiniApp` shares hydration code with `App` (extract a function rather than copy).
- Test strategy for the tray and shortcut (likely: unit tests for `queue.rs` and menu-model
  building as pure functions, manual check of the native parts on an installed build).
- README updates: Notifications section (menu bar, shortcut, badge rule change), First run (closing
  the window doesn't quit), Privacy is unchanged.
