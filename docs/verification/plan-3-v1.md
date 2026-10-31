# Plan 3 / v1 verification and owner handoff

Run on 2026-10-31 on branch `plan-3-release` (HEAD `b0ffe64` plus the docs commit). Machine: macOS (Darwin 27.2). **The screen was locked for the whole run** (`IOConsoleLocked = true`), so anything that needs a drawing window, focus, notifications or a human is an owner check below. Only Claude Code is installed here; Codex, OpenCode and Gemini CLI are not.

## 1. Automated suites

| Suite | Result |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml` | lib 187 passed; e2e_claude 2 passed, 1 ignored (the real-Claude test); 0 failed |
| `pnpm vitest run` | 26 files, 193 tests passed |
| `pnpm exec tsc --noEmit` | clean |
| `node --test scripts/*.test.mjs` | 2 passed (`make-latest-json`) |
| Real Claude e2e (`real_claude_full_lifecycle`, `--ignored`) | last run in Plan 3 Task 2 fix round (after the `--` change): passed, "trust menu seen: true". Not re-run for this task (it costs a small haiku call). |

## 2. Agent x capability matrix

"Verified (real run)" means exercised by the real end-to-end test against the installed CLI (`src-tauri/tests/e2e_claude.rs`, haiku, low effort) or by the owner's GUI run in `plan-1-e2e.md`. "Unit-tested against docs, owner check" means the code and its tests follow the agent's documentation and fixtures, but the CLI was never run, so the first real run is an owner check.

| Agent | Launch | Status events | Prompt detection | Approve / deny from the app |
|---|---|---|---|---|
| Claude Code | **Verified (real run)**, including `--` before the task | **Verified (real run)**: hooks give Working, Finished, step count; owner GUI run confirmed Working to Finished | **Verified (real run)**: Bash permission request gives Needs you. Trust-folder menu detected in the e2e test | Approve **verified (real run)** (`approve()` made the tool run). Deny: unit-tested only, owner check (Plan 1 check 3) |
| Codex | Unit-tested against docs, owner check (`-c notify=[...]`, `-c developer_instructions=...`, `--` before the task) | Unit-tested against docs, owner check. `notify` reports turn-complete only; before the first notify, 30 s of silence counts as Finished | Unit-tested against docs, owner check. Screen needles for the trust and approval screens; wording is a guess from docs | Disabled (`canApprove = false`): panel says "Answer in the terminal" |
| OpenCode | Unit-tested against docs, owner check (`OPENCODE_CONFIG_DIR` plugin, `--model=`, `--prompt=`). The plugin JS passes a node syntax check and a node-driven call test | Unit-tested against docs, owner check (event and property shapes, `tool.execute.after`, plugin loading are unconfirmed) | Unit-tested against docs, owner check (`permission.asked` event) | Disabled |
| Gemini CLI | Unit-tested against docs, owner check (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `--model=`, `--prompt-interactive=`) | Unit-tested against docs, owner check (hook field names; whether system-level hooks need an enable flag) | Unit-tested against docs, owner check (`Notification` with `ToolPermission`) | Disabled |
| Custom command | **Verified (real run)** via non-ignored e2e (`custom_builder_exit_3_goes_stuck_with_output_retained`) and owner GUI run | Verified by tests: output gives Working, 20 s of silence gives Finished, non-zero exit gives Stuck | n/a | n/a |
| Antigravity (`agy`) | No adapter in v1 (ruling P3-R2). Run it as a Custom command | | | |

Not covered by any real run, for any agent: effort and model flag acceptance beyond Claude's, and the shared-folder note delivery for Codex, Gemini and OpenCode.

## 3. Budgets (spec section 7)

Measured with `scripts/budget.sh` on a **single-architecture (arm64) release build**, `pnpm tauri build --bundles app` (1 m 29 s), launched from `src-tauri/target/release/bundle/macos/Clash of Claudes.app`. The owner's `state.json` was checked byte-identical before and after (same SHA-1). The universal build was not re-run for this task; its unsigned build and `lipo -archs` (x86_64 arm64) were verified in Task 7, and 5.8 MB DMG built then.

| Budget | Target | Value | Build | Result |
|---|---|---|---|---|
| Idle memory, no sessions (physical footprint: app + WebKit helpers) | n/a (reference) | **161 MB** (WebContent 106, app 30, GPU 20, Networking 5). Plan 2 measured 178 MB before Plan 3 | release arm64 | Reference. Village hidden, so no textures uploaded: lower bound |
| Hidden CPU, idle | ~0% | **0.00%** of one core over 20 s (`budget.sh cpu`) | release arm64 | Pass (village hidden, ticker stopped) |
| Launch to process ready | <= 2 s to interactive village | **0.67 s** from exec to the WebKit WebContent process being up (process-level only: it does not prove the village is drawn) | release arm64 | Provisional. Not measurable as "village visible": screen locked |
| Memory, 10 sessions + 2 terminals | <= 250 MB | 219 / 226 MB dev (Plan 2), about 192 / 199 MB estimated release; not re-run here | dev | Provisional (village hidden). Owner check 5 |
| Memory after flood, and after 40 terminal switches | <= 250 MB | 234-236 MB after flood; **228 MB** after 40 switches (Plan 3 Task 1, dev, village hidden) | dev | Provisional. Owner check 5 |
| Focused CPU, village animating | <= 5% of one core, 30 fps cap | not measured | n/a | **Not measurable** (screen locked). Owner check 1 |
| Unfocused frame rate | <= 15 fps | not measured | n/a | **Not measurable**. Owner check 2 |
| Minimized | ~0% CPU, ticker stopped | Plan 2: 0.29% dev, `running:false` (but already hidden by the lock) | dev | Partial. Owner check 3 |
| Cold start to village visible | <= 2 s | not measured | n/a | **Not measurable**. Owner check 4 |

Details of the earlier numbers and the protocol are in `plan-2-village.md`.

## 4. Consolidated owner checklist

Do these on an unlocked Mac. Plan 2's checks are deduplicated here (their original text is in `plan-2-village.md` and `plan-1-e2e.md`; the steps below are the current form). Build the release app first: `pnpm tauri build --bundles app` (output `src-tauri/target/release/bundle/macos/Clash of Claudes.app`). Use `COC_DRIVER=1 pnpm tauri dev` where a check says dev. Record a result next to each item.

### A. Performance and rendering

1. **Focused CPU (release), <= 5% of one core.** `open` the release app, click empty grass, do not cover it. After 10 s run `scripts/budget.sh cpu`. Repeat while a session is starting or building. Record both.
2. **Frame rate (dev).** `COC_DRIVER=1 pnpm tauri dev`, click the village, run `scripts/drive.sh '({fps:__cocDriver.scene().fps, running:__cocDriver.scene().running})'`: about 30 and `true`. Click another app so the window stays visible but unfocused, wait 2 s, run again: <= 15.
3. **Minimized (dev).** Screen unlocked, Cmd+M, run the same command: `{fps:0, running:false}`; `scripts/budget.sh cpu` about 0%. Click the Dock icon: `running` returns to `true`.
4. **Cold start, <= 2 s.** Run `pnpm dev` in one terminal (a debug binary must exist), quit all copies of the app, run `scripts/budget.sh cold`. It prints "launch to village visible: N s". If it is over 2 s, time the release app by eye from `open` until the village is drawn.
5. **Memory with the village drawing, <= 250 MB.** Have at least 5 workspaces (see `plan-2-village.md` check 5 for the bench-workspace command). Release app, visible and focused 30 s, then `scripts/budget.sh mem`. For the loaded case (10 sessions + 2 terminals, flood with `yes | head -c 50000000`, then 40 switches between two terminals) follow the load commands in `plan-2-village.md` check 5; subtract about 27 MB for release. Clean up the Bench builders and sessions afterwards.
6. **Village edges without MSAA.** With a few sessions, select a structure and drag a house. Look at the selection ring, drag ghost and effects for jagged edges. Report if they bother you.

### B. Core behaviour (Plans 1 and 2)

7. **Quit dialog, Cmd+Q.** Start 2 sessions, press Cmd+Q: a dialog mentioning 2 running sessions appears. Cancel: the app stays. Cmd+Q again and confirm: it exits. Then check for leftovers with `pgrep -f "sleep 600"` (or look at children of the app pid; `pgrep -f "claude --session-id"` also matches any shell whose command line contains that text). Nothing should print.
8. **Quit dialog, red button.** Same as 7 using the red window button.
9. **Folder picker.** Town Hall, "Open folder", choose a folder. A native picker appears, a compound appears, the camera eases to it. Remove the workspace afterwards.
10. **Mouse drag.** Dragging empty grass pans without lag and registers no click; dragging a structure or house follows the cursor and drops on a free spot; a blocked spot refuses and snaps back.
11. **Trackpad.** Two-finger scroll zooms toward the cursor. Pinch: note whether the village zooms or WebKit magnifies the whole page (the latter is a bug). The +, - and "Village" buttons still work.
12. **Plan 1 GUI items not yet covered by the owner run.** Allow/Deny buttons with real Claude (Deny should show "Interrupted - What should Claude do instead?"); a follow-up typed in the terminal gives Working then Finished; the "+XP earned" banner after Close; the "missing" badge after relaunching with a deleted workspace folder (in `plan-1-e2e.md`, steps 3, 5, 6, 8).

### C. Agent install checks (each needs the real CLI)

For each, add a folder, install the agent (the Town Hall shows the command), press **Re-check**, then start a session with a small task such as "create hello.txt containing hi".

13. **Claude Code.** Re-check shows the version. Run the Plan 1 step 2-4 flow once in a never-trusted folder: the trust menu should turn the badge to Needs you with Allow/Deny meaning "Yes I trust / No, exit". Pass if the badge matches what Claude shows. (Also re-run `cargo test --manifest-path src-tauri/Cargo.toml --test e2e_claude real_claude -- --ignored --nocapture` if you want the automated proof.)
14. **Codex.** Start a session with a task that starts with a dash, e.g. `--help me` (checks that Codex accepts `--` before the prompt and treats the text as the prompt). Then a normal task. Expect Working while it runs and Finished when the turn ends (this proves `-c notify=[...]` is accepted: if it never reaches Finished after the turn, or Codex prints a config error, note the message). Trigger an approval (ask it to run a shell command in a non-trusted folder). Write down the **exact wording** of the folder-trust screen and the approval screen and compare with the needles `allow Codex to work in this folder` and `Yes, proceed`; the badge should read Needs you and the panel "Answer in the terminal". To enable Approve/Deny later, note which keys Codex accepts.
15. **OpenCode.** Same flow. Pass if the badge goes Working, Needs you on a permission prompt, Finished at the end. If the badge stays Working all the time, the plugin did not load (note OpenCode's version and any plugin error in its log). Also note what `--prompt=<text>` does with a task.
16. **Gemini CLI (API key).** Set `GEMINI_API_KEY`, install, same flow. Pass if Working, Needs you on a tool-permission prompt, Finished. If it never moves past Working, Gemini probably ignored `GEMINI_CLI_SYSTEM_SETTINGS_PATH` or needs hooks enabled; note the Gemini version.
17. **Custom command.** Create a builder with command `printf done; sleep 30`. Expect Finished after about 20 s of silence.
18. **Shared-folder note.** For each agent that has a task, confirm the agent mentions the shared-folder note (ask "what does your system prompt say about shared folders?" or read the first message). Codex uses `developer_instructions`, Gemini and OpenCode get it prefixed to the first prompt.

### D. Notifications and dock badge (use the bundled app, not dev)

19. **Notification.** Create a custom builder with command `printf done; sleep 30`. Start it, then switch to another app so Clash of Claudes is unfocused. Within about 20 s a macOS notification titled with the builder's name and body "finished" should appear. Allow notifications in System Settings if macOS asks. The notification must not contain your task text or terminal output. Pass/fail and macOS version: ____
20. **Tap to select.** Click the notification: the window comes forward, and that session is selected with its panel open. (The tap callback is unverified on macOS.)
21. **Needs-you notification.** Run a Claude session with a Bash permission prompt (see Plan 1 step 3) while unfocused. Body reads "needs you: <reason>".
22. **Dock badge.** With 2 sessions Finished or Needs you the Dock icon shows 2; it clears when they are closed or return to Working. Minimized and hidden windows should also notify.
23. **No notification when focused.** With the window focused, a finishing session must not notify.

### E. Release, signing and updater (need your credentials)

24. **DMG and icon layout.** `bash scripts/release.sh` (universal, about 4 min). Open `src-tauri/target/universal-apple-darwin/release/bundle/dmg/Clash of Claudes_0.1.0_universal.dmg`. The window should be 660x400 with the app icon at about (180,170) and the Applications link at about (480,170). Headless runs may ignore these positions; fix in `tauri.conf.json` `bundle.macOS.dmg` if they are off. Drag to Applications and launch it.
25. **Unsigned-build warning.** Without credentials the script must print `UNSIGNED BUILD — not for distribution` and still produce the DMG.
26. **Signing and notarization.** Follow `docs/release.md` "One-time setup" steps 1-2, run `scripts/release.sh --dry-run` (credentials detected, secrets never printed), then the real build. Verify with `codesign -dv --verbose=2 <app>`, `spctl -a -vv <app>`, `xcrun stapler validate <dmg>`. Expect Developer ID, hardened runtime, accepted, and a stapled DMG. If notarization rejects it, the log may ask for `com.apple.security.cs.allow-jit` in `src-tauri/Entitlements.plist` (currently empty). Untested here (no credentials).
27. **Updater end to end.** Needs the GitHub repo and keys. Generate the key (`pnpm tauri signer generate -w ~/.tauri/clashofclaudes.key`), set `pubkey` and OWNER/REPO in `src-tauri/tauri.conf.json`, export `TAURI_SIGNING_PRIVATE_KEY`, build and publish v0.1.0 (DMG, `.app.tar.gz`, `latest.json`) as a GitHub Release. Install it. Bump the version, build and publish v0.1.1. Launch v0.1.0: within about 10 s a toast "Update available - Restart to update" appears; click it; with a running session the quit guard asks first; the app relaunches as v0.1.1. Check that universal updates work with one tarball serving both `darwin-aarch64` and `darwin-x86_64` (unverified). Also check "Check for updates automatically" off (Town Hall) means no request is made.
28. **Placeholder build starts.** The shipped app with the placeholder pubkey must launch normally and never check for updates (the plugin does not validate the key at init per the Task 8 review; confirmed by reading source, never run). Launched once in this run (release arm64 with placeholders): it started and idled normally.
29. **Public name.** Before sharing, pick the final name and work through "Public-name / rename checklist" in `docs/release.md` (trademark note, identifier, icons, updater URL).
