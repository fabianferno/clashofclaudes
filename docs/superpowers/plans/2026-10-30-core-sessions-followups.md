# Plan 1 follow-ups (carry into Plans 2/3)

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
  - It is garbage, not a leak, and it is still over 250 MB.
  - Options: reuse one `Terminal` per session across mounts, or a single shared `Terminal` that
    is reset and refilled.
- Closing a session that never reached Finished gives no feedback (no XP, no message). Show "closed: unfinished, no XP".
- Builders are only visible in the New session builder picker; after Close the builder seems to vanish. The Plan 2 builders bar covers this.
- Claude's first-run "Do you trust this folder?" menu (default "No, exit") appears before any hook fires: the session shows Working, never NeedsYou. Add screen-pattern detection → NeedsYou with its own keys.
- Add a monotonic `rev` to SessionInfo so stale start responses / hydrate can't overwrite fresher event state.
- Disarm `awaiting_decision` when the user answers a permission prompt by typing in the terminal (hook agents).
- Serde shape tests for the tagged enums (SessionState/SessionKind).

## Found in the owner GUI run (2026-10-31)
- Fixed: Cmd+Q / menu Quit skipped the quit dialog. The predefined Quit item calls `terminate:`, which never raises ExitRequested; replaced with a custom Quit item that calls `app.exit(0)` (`lib.rs::app_menu`).
- Fixed: the quit dialog's buttons were unclickable over a terminal (xterm's z-indexed layers sat above the unindexed fixed overlay). `.modal-bg` gets `z-index`, `.terminal-wrap` gets `isolation: isolate`.
- Open: + Session / + Terminal on a missing workspace are disabled with no explanation; add a "folder not found" tooltip.
- Open: the doc's `pgrep -f "claude --session-id"` check also matches any shell whose command line contains that text; check children of the app pid instead.

## Final-review minors not yet fixed
- `start_agent` runs `claude --version` on every start (cache detection).
- 16 ms flush loop never parks with zero sessions (spec wants ~0% CPU when hidden).
- Custom agents that print nothing stay Starting forever.
- `quit_now` exits before SIGKILL escalation can run.
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
- Task 8: minor (deferred): stop() within ~20 ms of exit returns EPERM from killpg on a zombie group (treat EPERM/ESRCH as gone); per-session dirs leak on quit (sweep data_dir/sessions at startup); tests don't assert byte totals / stop-while-starting / no events after Removed; out-of-order worktree checks; spawn() 7-arg clippy allow; worktree detection needs git ≥2.31; module-wide allow(dead_code) on git/sessions until T9
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
