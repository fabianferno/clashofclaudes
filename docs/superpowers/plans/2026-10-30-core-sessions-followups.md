# Follow-ups (Plan 1, carried through Plans 2 and 3)

Status after v1 (Plan 3 Task 9): see "Status after v1" at the end for what was resolved and what remains. The sections below are the historical record; items marked FIXED are done.

Collected from the Plan 1 execution ledger at merge time. All were triaged CAN-WAIT by the final review except where noted.

## Must land before or with Plan 2
- Memory after a flood: PROVISIONAL. Re-measured in Plan 2 Task 14 (docs/verification/plan-2-village.md).
  These are lower bounds, measured with the village hidden (screen locked, no textures uploaded).
  The verdict waits on owner check 5.
  - `footprint` (physical footprint), flood + 30 s on dev: 247 MB with scrollback 5000, and
    239 MB (one flooded terminal) / 246 MB (two) with scrollback 2000.
  - Release estimate: about 27 MB lower. That idle delta is assumed to hold under load; it was not
    measured.
  - Plan 1's 395 MB was an RSS figure.
  - The real over-budget cost was the village canvas' 4x MSAA, about 120 MB of graphics memory.
    Release idle went from 299 to 178 MB with `antialias: false`.
  - Checked and cleared: the WebglAddon is disposed with the terminal, `clearTextureAtlas()`
    changes nothing, frames are not retained, and disposed terminals are collected.
  - xterm scrollback is now 2000, per a controller ruling.
- Terminal remount churn (from Task 14): each remount of a terminal whose 2 MiB scrollback is full
  allocates a new xterm buffer. JSC frees the old one only at a full GC. 40 switches between two
  flooded terminals, panel closed, then 30 s (dev):
  - 404 MB with scrollback 5000.
  - 318 MB with scrollback 2000.
  - The first run read 419 MB with the panel open and 340 MB closed.
  - FIXED in Plan 3 Task 1. It was retention, not lazy garbage. In the hidden webview, xterm's
    frame queue never drains and kept every old `Buffer` alive (0 of 39 finalized). Each
    TerminalView host now keeps one `Terminal` and swaps sessions with `reset()` plus replay.
    40 switches, panel closed + 30 s: 297 → **228 MB** (dev, village hidden). See
    docs/verification/plan-2-village.md, "Remount follow-up".
- FIXED (Plan 2, `cedebbd` unfinished-close notice): Closing a session that never reached Finished gives no feedback (no XP, no message). Show "closed: unfinished, no XP".
- FIXED (Plan 2, builders bar): Builders are only visible in the New session builder picker; after Close the builder seems to vanish.
- FIXED (Plan 1 final round, `63f6c2e`): Claude's first-run "Do you trust this folder?" menu now goes to NeedsYou through screen-pattern detection with its own keys.
- FIXED (`63f6c2e`): Add a monotonic `rev` to SessionInfo so stale start responses / hydrate can't overwrite fresher event state.
- FIXED (`63f6c2e`): Disarm `awaiting_decision` when the user answers a permission prompt by typing in the terminal (hook agents).
- FIXED (`63f6c2e`): Serde shape tests for the tagged enums (SessionState/SessionKind).

## Found in the owner GUI run (2026-10-31)
- Fixed: Cmd+Q / menu Quit skipped the quit dialog. The predefined Quit item calls `terminate:`, which never raises ExitRequested; replaced with a custom Quit item that calls `app.exit(0)` (`lib.rs::app_menu`).
- Fixed: the quit dialog's buttons were unclickable over a terminal (xterm's z-indexed layers sat above the unindexed fixed overlay). `.modal-bg` gets `z-index`, `.terminal-wrap` gets `isolation: isolate`.
- FIXED (Plan 2, `816a0a2`): + Session / + Terminal on a missing workspace now carry a "Folder not found: <path>" tooltip and a panel warning.
- Open: the doc's `pgrep -f "claude --session-id"` check also matches any shell whose command line contains that text; check children of the app pid instead.

## Final-review minors not yet fixed
- FIXED (Plan 3 Task 1): `start_agent` ran `claude --version` on every start. Detection is now cached for 60 s per app run (`adapters::DetectionCache`).
- FIXED (Plan 3 Task 1): the 16 ms flush loop never parked. It now parks while no session has a process or unsent output, and wakes on the next start (idle: 0.00% CPU).
- FIXED (Plan 3 Task 1): custom agents that printed nothing stayed Starting forever. They now go to Finished after 20 s of silence.
- FIXED (Plan 3 Task 1): `quit_now` exited before the SIGKILL escalation could run. It now waits up to 2 s for the SIGHUP'd groups, SIGKILLs the survivors, then exits (live: 2.29 s, no survivors).
- `remove_workspace` leaves Ended sessions orphaned; no UI to remove a missing workspace; missing flag never clears during a run.

## Deferred minors by task
- Task 1: minor (deferred): src-tauri/gen/schemas committed (template .gitignore dropped by rsync) — add to root .gitignore
- Task 1: minor (deferred): jest-dom installed but unwired; stale @ts-expect-error in vite.config.ts; template cruft (greet cmd, svgs, App.css, Cargo description/authors)
- Task 2: minor (deferred): save() lacks fsync before rename; .bak overwritten on repeated corruption; serde shape tests for tagged enums absent; load_marks_missing test doesn't call load; model.rs comment implies load() calls mark_missing (caller must)
- Task 2: minor (carry to T9): save() does not create the parent dir — T9 must create_dir_all(app data dir) before first save, and call mark_missing after load
- Task 3: minor (deferred): on_output may fire after on_exit if a grandchild holds the PTY; fds held until PtyHandle dropped (manager must drop on exit); write_reaches_child passes on tty echo alone; blanket #![allow(dead_code)] in pty/platform/scrollback (remove in T8); escalation signals pid not process group (grandchildren may survive); each kill() spawns a 2s thread
- Task 4: minor (deferred): untested table rows (ToolUsed from Starting, WaitingForInput no-op, UserInput ignored with hooks, exit-stuck no recovery, silence-stuck recovery, Exited{None}, unknown-event no-op); Stuck recovery keyed on reason-string prefix; secs/60 truncation for sub-minute thresholds
- Task 5: minor (deferred): no captured RED run; detect/policy/models/efforts/terminal_policy untested; terminal_launch test doesn't assert program
- Task 5: minor (deferred): "$1" substring check also matches "$10"; a command ending in a shell comment swallows the appended "$@"
- Task 6: minor (deferred): settings write errors lack path context; session_id joined into path unvalidated; settings file (contains hook token) written 0644 — should be 0600; claimed CwdChanged-unchanged test missing in status.rs; unknown events carrying cwd yield [] (undocumented)
- Task 7: minor (carry to T8/T9): HookSink runs inline on a tokio worker — sink must be quick and non-blocking (no git subprocess inside on_hook; offload)
- Task 7: minor (deferred): Drop aborts only accept loop (keep-alive conns linger); session_id not percent-encoded in URL (UUIDs safe); no test for 1 MiB limit/413 or token rotation; duplicate reqwest 0.12 dev-dep vs tauri's 0.13; blanket allow(dead_code) to remove in T8
- Task 8: minor (carry to T9): attach() snapshot vs queued Output events can duplicate bytes and arrive on different transports — T9 should tag Output events with a byte offset (or sequence) so the frontend drops data at or before the snapshot end
- Task 8: minor (deferred): stop() within ~20 ms of exit returns EPERM from killpg on a zombie group (treat EPERM/ESRCH as gone); per-session dirs leak on quit (FIXED in Plan 3 Task 1: stale `sessions/<uuid>` dirs are swept at startup); tests don't assert byte totals / stop-while-starting / no events after Removed; out-of-order worktree checks; spawn() 7-arg clippy allow; worktree detection needs git ≥2.31; module-wide allow(dead_code) on git/sessions until T9
- Task 8: minor (deferred): emit panic leaves in_flight stuck (thread dead anyway); dropped output not signalled to frontend; sessions.rs 836 lines; new test ~9 s
- Task 9: minor (deferred): in-memory AppData mutated before save can diverge on save failure; remove_workspace/delete_builder check-then-act gap and silent success on unknown id; detect()/close() blocking calls inside async commands (use spawn_blocking); create_workspace rollback uses remove_dir not remove_dir_all; stale attach channel after natural session end; no Tauri-command integration tests
- Task 9: minor (deferred): quit guard wiring untested end-to-end; any future app.exit(n) outside quit_now will prompt
- Task 10: minor (carry to T11): live frames can reach onFrame before attachSession's snapshot resolves — TerminalView must queue frames until the snapshot is written, then apply trimSeen to queued and later frames
- Task 10: minor (deferred): u64→Number precision >2^53 (theoretical); decodeFrame throws on <8-byte buffer; unused _removed var; addWorkspace/addBuilder don't dedupe
- Task 11: minor (deferred): detachSession rejection swallowed on unmount; agent kind init sticks to 'custom' if agents load late; review not cleared after leaving Finished, no "no changes" text; hydrate can overwrite fresher event state; "1 sessions" grammar; New folder silent on empty name; no tests for App listeners/SessionPanel; generic non-claude previews
- Task 11: minor (deferred): chains Map never deletes entries (one settled promise per session id); banner timer not restarted on a second XP close within 3 s; no banner/SessionPanel tests; ffea53f was committed with a failing test (fixed in 840d0e2)
- Task 12: minor (deferred): all lib.rs modules made pub for the integration test (tighter: test-support feature); Working wait doesn't prove hook-driven state; duplicated non-ignored tests; owner steps 8-10 need concrete paths/how-to

## Owner GUI checks still open
See docs/verification/plan-1-e2e.md (OWNER-GUI-CHECK items, incl. memory figure and an unbounded `yes` memory watch).

## Status after v1 (Plan 3 Task 9)

Resolved across Plans 1-3: everything marked FIXED above (remount memory churn, quit SIGKILL escalation, flush-loop parking, silent custom agents, stale session dirs, detection caching, trust-menu detection, `rev`, folder-not-found tooltip, unfinished-close feedback, builders bar).

Still open: the owner checklist in `docs/verification/plan-3-v1.md` (rendering budgets, each non-Claude agent against its real CLI, notifications on a bundled build, signing and notarization, updater end to end, DMG icon layout).

### What remains after v1, grouped (from the Plan 3 ledger and the older lists above)

User-visible:
- Open: the quit-time kill misses a SIGHUP-ignoring child when its group leader has already exited, and a session still starting at quit gets only SIGHUP (`kill_now` skips reaped leaders; `killpg` would be safe).
- Open: after Codex's first notify, an interrupted turn stays Working until the 900 s Stuck rule. Failure-stuck (OpenCode `session.error`) clears only on typing or the next agent event.
- Open: update toast: the button does nothing after a cancelled restart (the pending update was taken), no download feedback, double-click not guarded.
- Open: the welcome card never shows if `listState` errors on first run (it fails closed); "Copied" on the install-command button never resets; the New-folder name is cleared before creation succeeds (lost on cancel).
- Open: the notification permission-denied path is dormant (the desktop plugin always reports Granted) and the notifier starts as focused, so a launch in the background is silent until the first focus event. Badge counts are computed at emit time and can lag one event.
- Open (from Plan 1): `remove_workspace` leaves Ended sessions orphaned; no UI to remove a missing workspace; the missing flag never clears during a run; builders/workspaces are not de-duplicated; dropped output is not signalled to the frontend; a "1 sessions" plural; review is not cleared after leaving Finished.

Agent adapters (need real CLIs):
- Open: verify event shapes, flag forms (`--model=`, `--prompt=`, `--prompt-interactive=`, `--` before the task) and prompt wording for Codex, OpenCode and Gemini, then flip `canApprove` per agent. Antigravity (`agy`) has no adapter; users run it as a Custom command.
- Open: the shared-folder note reaches Gemini and OpenCode only when a task is given (display-only limitation).
- Open: the session hook URL with its token is visible in `ps` argv and inherited by an agent's subprocesses (local only; it can only forge status for that session). The sh+curl notify script is not portable to Windows.

Release:
- Open: signed, notarized and updater paths are unexercised until credentials exist. `release.sh` does not refuse `OWNER/REPO` or the placeholder pubkey when building a signed `latest.json`. The identifier ends in `.app` (Tauri warns); changing it moves the data dir.
- Open: the public name and trademark check (see `docs/release.md`).

Code health (internal):
- Reason-string prefixes decide Stuck recovery (use a typed kind); `sessions.rs` is large; `all lib.rs modules pub` for the integration test (use a test-support feature); blocking calls inside async commands (use `spawn_blocking`); no Tauri-command integration tests; weak or constant-asserting tests in the Codex adapter; no TerminalView tests for rapid A-B-A switches or real-xterm reset; template cruft (greet command, unused svgs, jest-dom unwired); `src-tauri/gen/schemas` committed; unbounded `read_to_string` of Gemini's system settings file; `save()` lacks fsync before rename.
