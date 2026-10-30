# Plan 1 end-to-end verification

The native window cannot be driven from the automated environment. The lifecycle was therefore
verified below the UI with a real `HookServer`, real `SessionManager`, real `ClaudeAdapter` and the
real `claude` CLI (v2.1.x, `--model haiku --effort low`) in a fresh temp git repo. Items that need a
human at the window are listed as OWNER-GUI-CHECK with exact steps.

## Automated results

```
cargo test --manifest-path src-tauri/Cargo.toml
  lib:        71 passed
  e2e_claude: 2 passed; 1 ignored (real Claude)
cargo test --manifest-path src-tauri/Cargo.toml --test e2e_claude real_claude -- --ignored --nocapture
  test real_claude_full_lifecycle ... ok   (finished in 15.58s)
pnpm test
  Test Files 5 passed (5), Tests 17 passed (17)
```

The ignored test (`src-tauri/tests/e2e_claude.rs::real_claude_full_lifecycle`) asserts:
1. `start_agent` reaches Working.
2. A Bash permission request moves the state to NeedsYou, and the file does not exist yet. The prompt
   is forced by `.claude/settings.json` (`permissions.ask: ["Bash"]`) written inside the temp repo only.
3. `approve()` makes the tool run (`hello2.txt` appears), and a NeedsYou -> Working update was emitted.
4. The turn ends in Finished with `reached_finished` true and `steps >= 1`.
5. `review()` lists `hello2.txt` as untracked.
6. `close()` returns `earned_xp: true`, empties the session list, removes the per-session settings
   dir, and `pgrep -f <session-id>` finds no process afterwards.

Non-ignored: `custom_builder_exit_3_goes_stuck_with_output_retained`, `missing_workspace_start_errors`
(plus the in-crate `immediate_nonzero_exit_goes_stuck`, `start_in_missing_workspace_errors`).

Finding (no code change needed): in a never-trusted folder Claude first shows its
"Do you trust this folder?" menu, with "No, exit" preselected. Hooks do not fire until the user
answers it, so a new session in a new folder looks Working (output) but cannot reach NeedsYou/Finished
until the user picks "Yes, I trust this folder" in the terminal (Down, Enter). The test does this
itself. Allow/Deny buttons do not apply to this menu.

Fixes: none were required. Only change to product code: `src-tauri/src/lib.rs` modules made `pub`
so the integration test can reach them (no behavior change).

## Brief walkthrough

| # | Item | Status |
|---|------|--------|
| 1 | Open folder -> workspace appears | OWNER-GUI-CHECK |
| 2 | Recruit Ada, Starting -> Working | AUTOMATED (`real_claude_full_lifecycle`); terminal display OWNER-GUI-CHECK |
| 3 | Permission -> Needs you -> Allow -> Working | AUTOMATED (state + approve); Allow/Deny buttons OWNER-GUI-CHECK |
| 4 | Finished; Review lists untracked file | AUTOMATED (`real_claude_full_lifecycle`); review panel OWNER-GUI-CHECK |
| 5 | Follow-up typed in terminal -> Working -> Finished | OWNER-GUI-CHECK (UserPromptSubmit/Stop mapping covered by unit tests) |
| 6 | Close -> session gone, +XP, Ada idle | AUTOMATED (`real_claude_full_lifecycle`: earned_xp, removal, cleanup, no child); banner OWNER-GUI-CHECK |
| 7 | Custom `exit 3` -> Stuck, output kept | AUTOMATED (`custom_builder_exit_3_goes_stuck_with_output_retained`) |
| 8 | Missing folder: start errors | AUTOMATED (`missing_workspace_start_errors`); badge after restart OWNER-GUI-CHECK |
| 9 | Quit with live sessions -> confirm dialog, no leftover claude | OWNER-GUI-CHECK (close-kills-children AUTOMATED) |
| 10 | `yes \| head -c 50000000` responsiveness | OWNER-GUI-CHECK |
| 11 | Memory with 10 sessions + 2 terminals <= 250 MB | OWNER-GUI-CHECK |

## OWNER-GUI-CHECK steps

Start with `pnpm tauri dev` (or the built app).

**Open folder / workspace (1).** Click "Open folder", choose `/tmp/coc-hooks` (create it with
`mkdir -p /tmp/coc-hooks && git -C /tmp/coc-hooks init`). Look for: it appears in the sidebar.

**Recruit and terminal (2).** Click Recruit, name "Ada", Claude Code, model haiku, effort low, task
"Create hello2.txt containing hi using Bash". Look for: Starting then Working within ~3 s and Claude's
UI in the terminal. If you see "Do you trust this folder?", choose "Yes, I trust" with the arrow keys.

**Allow/Deny (3).** When Claude asks about Bash the badge must read "Needs you" with the tool message.
Click Allow: the badge returns to Working. Repeat with a new task and click Deny: Claude shows
"Interrupted - What should Claude do instead?".

**Review panel (4).** After Finished, open Review. Look for `hello2.txt` under untracked files and the
branch name.

**Follow-up (5).** Click into the terminal, type "now append a second line", Enter. Look for
Working then Finished.

**Close and XP (6).** Click Close on Ada. Look for: the session disappears, a "+XP earned" banner
shows, and Ada is selectable again. Also run `pgrep -f "claude --session-id"`: no output.

**Missing workspace (8).** Quit the app. `rm -rf` a workspace folder (or rename it). Relaunch.
Look for: the workspace shows a "missing" badge; starting a session there shows a clear error.

**Quit dialog (9).** Start 2 sessions. (a) Click the red window-close button: a confirm dialog
mentioning 2 sessions must appear; Cancel keeps the app open. (b) Press Cmd+Q: the same dialog must
appear. Confirm: the app exits and `pgrep -f "claude --session-id"` prints nothing.

**Flood (10).** Open a terminal session and run `yes | head -c 50000000`. Look for: the UI stays
responsive (you can switch sessions and click buttons while it prints) and the scrollback does not
grow without bound.

**Memory (11).** Start 10 sessions (e.g. custom builders `sleep 600` or terminals) with 2 terminals
open. In Activity Monitor, filter "Clash of Claudes" and sum Memory for the app and its WebKit helper
processes (exclude `claude` children). Target: <= 250 MB. Record it here: ______ MB.
