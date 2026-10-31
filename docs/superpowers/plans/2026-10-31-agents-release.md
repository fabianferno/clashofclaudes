# Clash of Claudes — Plan 3: Agents, notifications, first run, release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make v1 shippable to other people:
- Codex, OpenCode and Gemini CLI adapters alongside Claude Code.
- macOS notifications and a dock badge for "needs you" and "finished".
- A first-run experience for people who aren't the owner.
- A release track: universal signed build, DMG, auto-update.
- Hardening the backlog that would embarrass a public release.

**Architecture:**
- **Each adapter is a small module** behind the existing `AgentAdapter` trait (detect, models, efforts, launch, policy, parse_hook, approve/deny keys, screen_prompts).
- **Agent events reach the existing localhost hook server** through per-session files in the app data dir, never through the user's own agent config:
  - Codex: `notify` via a `-c` override.
  - OpenCode: a JS plugin via `OPENCODE_CONFIG_DIR`.
  - Gemini: hooks via `GEMINI_CLI_SYSTEM_SETTINGS_PATH`.
- **Prompt detection fallback:** where events don't cover approvals, the Plan 2 screen-prompt mechanism detects them.
- **Notifications and the dock badge** are driven from Rust session-state transitions, gated on window focus.
- **The release track** is config plus scripts. Signing and notarization need the owner's Apple Developer credentials and are wired so they work once those exist.

**Tech Stack:**
- Everything from Plans 1–2.
- `tauri-plugin-notification` (≥ 2.6), `tauri-plugin-updater`, `tauri-plugin-process`.
- Core `Window::set_badge_count` (Tauri ≥ 2.2).

**Spec:** `docs/superpowers/specs/2026-10-30-clashofclaudes-design.md`
- Sections implemented: §2.1, 2.3, 2.8, 2.10; §6.3 (other adapters); §8 (release track, first run).
- Research notes, with a source and date for every fact: `docs/superpowers/research/2026-10-31-agents-and-release.md`.

**Carried in:**
- The remount-memory follow-up parked by Plan 2 Task 14.
- Plan 1 follow-ups still open: quit SIGKILL escalation, the idle flush loop, custom agents stuck in Starting, the per-session dir sweep, caching `claude --version`.
- Owner checks from `docs/verification/plan-2-village.md`; they need a human.

## Global Constraints

- **Everything from Plans 1–2 still holds:**
  - No network calls by the app itself.
  - Localhost hook server with a per-session token.
  - User strings passed as argv elements, never through a shell string.
  - Atomic `state.json`.
  - Debug driver is dev-only.
  - Never write to `~/.claude` or a project `.claude/`.
- **Never write to any agent's user or project config:** `~/.codex`, `<repo>/.codex`, `~/.gemini`, `<repo>/.gemini`, `~/.config/opencode`, `<repo>/.opencode`, `opencode.json`, or the user's `CODEX_HOME`. Per-session files live in `<app data>/sessions/<id>/`, mode 0600 for files and 0700 for dirs, and are removed on close.
- **Shared-folder note** (exact copy as Plan 1), delivered per agent:
  - Claude: `--append-system-prompt`.
  - Codex: `-c developer_instructions=…`.
  - Gemini and OpenCode: prefixed to the initial prompt as a separate paragraph, when a task is given. Without a task it is not delivered. Record this as a display-only limitation.
- **Effort and model** pass only through each agent's documented mechanism; an unsupported option is recorded for display only (spec §6.3).
  - Codex: `-m <model>`, `-c model_reasoning_effort="<effort>"`.
  - OpenCode: `-m provider/model`, effort via `OPENCODE_CONFIG_CONTENT` `provider.<p>.models.<m>.options.reasoningEffort`.
  - Gemini: `-m <model>`; effort is display-only.
- **Hook payloads are untrusted input:** parse defensively, cap at 1 MiB (as now), ignore unknown fields and events.
- **Approve and deny keystrokes** are only enabled (`canApprove`) for a prompt shape verified against a real run. Every new adapter ships with `canApprove = false` (panel says "Answer in the terminal") until an owner check verifies its keys. Claude stays as is.
- **Notifications:**
  - Only when the window is not focused, or is hidden or minimized.
  - At most one per session per state entry.
  - Title is the builder name; body is "needs you: <reason>" or "finished".
  - Never include task text or terminal output.
- **Dock badge** = number of agent sessions in NeedsYou + Finished. Cleared when 0.
- **Release:**
  - Universal (`universal-apple-darwin`), macOS 13+.
  - Developer ID signed and notarized when the env vars are present; otherwise the build still succeeds unsigned with a clear warning.
  - DMG.
  - Updater: signed `latest.json` on GitHub Releases. The owner supplies the repo and keys.
  - The private signing key is never generated or stored by the app or the repo.
- **App sandbox stays OFF** (the app spawns CLIs in PTYs). Hardened runtime ON for notarization.

## Review Focus

1. **An agent CLI is installed but not logged in, or shows a first-run screen** (Codex trust or login, OpenCode provider auth, Gemini auth).
   - Expected: the session shows NeedsYou with a clear reason, or Working with the screen visible in the terminal. Never Finished, and never stuck silently. For Codex, OpenCode and Gemini (policies with `silence_needs_you_until_first_event`), silence before the first agent event goes to NeedsYou "Waiting in the terminal" (canApprove false, so the panel says "Answer in the terminal"); after the first event the agent's own events decide.
   - *Test: Task 2 `codex_trust_screen_goes_needs_you`, `codex_silence_before_first_notify_needs_you`; Task 4 `opencode_silence_before_first_event_needs_you`; `gemini_silence_before_first_event_needs_you`; `status::silence_before_first_event_needs_you_never_finished`.*
2. **A hook or notify payload that is malformed, huge, or from a stale session.**
   - Expected: ignored, with no crash and no state change.
   - *Test: Tasks 2–4 `*_parse_ignores_garbage`.*
3. **Notifications while focused, or repeated on every update.**
   - Expected: none while focused; exactly one per state entry.
   - *Test: Task 5 `notifies_once_per_entry_only_when_unfocused`.*
4. **A user's own global agent config contains hooks or plugins.**
   - Expected: the app's per-session mechanism adds to them and never edits them. A test checks that no file outside `<app data>` is written.
   - *Test: Tasks 2–4 `*_writes_only_inside_session_dir`.*
5. **An update check with no network or a bad signature.**
   - Expected: silent failure (logged), the app keeps working, and nothing is installed.
   - *Test: Task 8 `update_check_failure_is_silent`.*

---

### Task 1: Remount memory churn + backlog hardening (Rust and frontend)

**Files:**
- Modify: `src/components/TerminalView.tsx`, `src-tauri/src/sessions.rs`, `src-tauri/src/pty.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/adapters/claude.rs`, `src-tauri/src/lib.rs`
- Test: in-file tests and `src/components/TerminalView.test.tsx`

**Interfaces / behavior:**
- **Remount churn.** Switching between flooded terminals 40 times reached 318–404 MB (Plan 2 Task 14). Do the following, in order:
  1. Measure with the driver whether a forced full GC brings it back to baseline. If `window.gc` isn't available, open and close a large allocation, or wait 3 minutes. This tells us whether it's lazy garbage or retention.
  2. If it is retention, fix it.
  3. If it is lazy garbage, reuse one `Terminal` per TerminalView host. Swap sessions with `term.reset()` plus replay instead of dispose and new, keeping the single-mounted-terminal invariant.

  Re-measure and record the numbers in `docs/verification/plan-2-village.md` under the remount follow-up. Target: 40 switches ≤ 250 MB after 30 s.
- **`quit_now`** waits up to 2 s for SIGHUP'd process groups to exit, then SIGKILLs the survivors, before calling `app.exit(0)`.
- **The 16 ms flush loop** parks when there are no live sessions and wakes on the next session start (hidden-app CPU ~0%).
- **Custom agents** that print nothing for 20 s go from Starting to Finished. Plan 1's silence rule applied only after output.
- **On startup, sweep `<app data>/sessions/*`** dirs left from a crash. Delete only dirs whose name is a UUID and that aren't live.
- **Cache `claude --version` detection** per app run, with a 60 s TTL.

- [ ] **Step 1: Failing tests.** One per bullet:
  - `quit_kills_survivors_after_grace`: a script that traps SIGHUP must not survive `quit_now`.
  - `flush_loop_parks_without_sessions`: a counter of loop iterations stays flat while there are no sessions.
  - `silent_custom_agent_finishes_after_20s`: use the injectable clock.
  - `startup_sweeps_stale_session_dirs`
  - `detection_is_cached`
  - TerminalView: `reuses_terminal_across_session_switch`, applies only if step 3 of the churn fix is taken.
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suites; expect PASS.** Then do the live remount measurement with the driver, recording before and after.
- [ ] **Step 5: Commit.** `perf: terminal remount churn; fix: quit escalation, idle flush park, silent custom agents, stale dir sweep`

---

### Task 2: Codex adapter

**Files:**
- Create: `src-tauri/src/adapters/codex.rs`
- Modify: `src-tauri/src/adapters/mod.rs` (registry), `src/village/look.ts` (CLASS_MAP codex), `src-tauri/tests/fixtures/codex/*.json`
- Test: in-file tests

**Interfaces:**
- `CodexAdapter` implements `AgentAdapter`, with `kind() == AgentKind::Codex` and label "Codex".
- `detect()`: `codex --version` → parse `\d+\.\d+\.\d+` (format `codex-cli X.Y.Z`).
- `models()`: `[]`. Free text; the model is passed through as typed. Class is Craftsman unless a later config maps it.
- `efforts()`: `["low","medium","high","xhigh","max"]`.
- `launch(req)` → `LaunchSpec`:
  - program `codex`, cwd = workspace.
  - args: `-m <model>` if set, `-c model_reasoning_effort="<effort>"` if set, `-c developer_instructions=<TOML string of SHARED_FOLDER_NOTE>`, `-c notify=<TOML array>`, then the task as the trailing positional argument if non-empty.
  - The notify array is `["sh","-c","printf '%s' \"$1\" | curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- '<hook_url>'","coc-notify"]`. The `$1` is the JSON that Codex appends as the last argv. The hook URL is the only interpolated value, and it is app-generated (host, port, session id, token); it is never a user string.
- `parse_hook(body)`: `{"type":"agent-turn-complete", …}` → `[TurnFinished]`. Anything else → `[]`.
- `screen_prompts()`:
  - Trust screen: needle `"allowCodextoworkinthisfolder"` (normalized), reason "Trust this folder?", approve and deny keys empty (Answer in terminal).
  - Command approval: needle `"Yesproceed"`, reason "Codex wants approval".
  - Both arm NeedsYou. `canApprove` is false.
- `policy()`: hooks-capable. Treat silence after output as Finished only when no turn-complete has arrived within 30 s of the last output, as for plain agents. Working on output.

- [ ] **Step 1: Failing tests.**
  - `codex_launch_args_exact`: given model `gpt-6.1`, effort `high` and task `fix "x" $(y)`, the args equal the exact list above, and the task is the last element, verbatim.
  - `codex_notify_array_is_valid_toml_and_embeds_only_hook_url`
  - `codex_parse_turn_complete`
  - `codex_parse_ignores_garbage`: non-JSON, missing type, an unknown type, or 2 MiB of input.
  - `codex_trust_screen_goes_needs_you`: a scripted PTY prints the trust text.
  - `codex_writes_only_inside_session_dir`
  - `codex_detect_parses_version`: from `codex-cli 0.137.0`.
- [ ] **Step 2: Run; expect FAIL.** Step 3: Implement. Step 4: Run; expect PASS.
- [ ] **Step 5: Commit.** `feat: Codex adapter (notify turn-complete, prompt detection)`

---

### Task 3: OpenCode adapter

**Files:**
- Create: `src-tauri/src/adapters/opencode.rs`, `src-tauri/src/adapters/opencode_plugin.js` (embedded with `include_str!`)
- Modify: `src-tauri/src/adapters/mod.rs`, `src/village/look.ts`
- Test: in-file tests

**Interfaces:**
- `detect()`: `opencode --version`, parsing the first semver.
- `models()`: `[]` (free text, `provider/model`).
- `efforts()`: `["low","medium","high","xhigh","max"]`.
- `launch(req)`:
  - program `opencode`, args `[<cwd>]`, plus `--prompt <SHARED_FOLDER_NOTE + "\n\n" + task>` when a task is given, and `-m <model>` if set.
  - env:
    - `OPENCODE_CONFIG_DIR=<session dir>/opencode`, containing `plugins/coc.js` (written 0600).
    - `COC_HOOK_URL=<hook_url>`.
    - When effort is set and the model's provider is known from `provider/model`: `OPENCODE_CONFIG_CONTENT` = `{"provider":{"<p>":{"models":{"<m>":{"options":{"reasoningEffort":"<effort>"}}}}}}`.
- **The plugin** (`opencode_plugin.js`) exports one plugin whose `event` handler POSTs `{type, properties?}` JSON to `process.env.COC_HOOK_URL` with `fetch` and a 2 s timeout, for:
  - `session.idle` → TurnFinished
  - `permission.asked` → PermissionRequested{reason: "OpenCode wants permission"}
  - `tool.execute.after` → ToolUsed
  - `session.error` → Failed

  It swallows every error and never throws into OpenCode.
- `parse_hook`: maps those types to the events above. Unknown → `[]`.
- `canApprove = false`.

- [ ] **Step 1: Failing tests.**
  - `opencode_launch_exact`: args, the env keys, and that the plugin file exists with mode 0600 inside the session dir.
  - `opencode_effort_config_content_json`
  - `opencode_parse_events`
  - `opencode_parse_ignores_garbage`
  - `opencode_writes_only_inside_session_dir`
  - `opencode_silence_before_first_event_needs_you` (renamed from `opencode_no_events_falls_back_to_silence_policy` in the final review: silence before the first event is NeedsYou, not Finished)
  - `plugin_js_is_syntax_valid`: run `node --check` on the embedded file when node is available, otherwise skip with a message.
- [ ] **Step 2: Run; expect FAIL.** Step 3: Implement. Step 4: Run; expect PASS.
- [ ] **Step 5: Commit.** `feat: OpenCode adapter (per-session plugin via OPENCODE_CONFIG_DIR)`

---

### Task 4: Gemini CLI adapter (API key / enterprise users)

**Files:**
- Create: `src-tauri/src/adapters/gemini.rs`
- Modify: `src-tauri/src/adapters/mod.rs`, `src/village/look.ts` (`CLASS_MAP.gemini` stays `{flash:0, pro:2}`)
- Test: in-file tests

**Interfaces:**
- `detect()`: `gemini --version`, first semver.
- `models()`: `["flash","pro"]`, passed through `-m` as typed.
- `efforts()`: `[]`, display-only.
- `launch(req)`:
  - program `gemini`, cwd = workspace, args `-m <model>` if set, `-i <SHARED_FOLDER_NOTE + "\n\n" + task>` when a task is given.
  - env `GEMINI_CLI_SYSTEM_SETTINGS_PATH=<session dir>/gemini-settings.json` (0600) containing:
    - hooks: `AfterAgent` → TurnFinished, `Notification` → PermissionRequested, `AfterTool` → ToolUsed, `SessionEnd`.
    - Each hook is a command: the same `curl … --data-binary @- '<hook_url>'` as Claude's, reading stdin.
- **The label says "Gemini CLI (API key)".** The picker shows a note that Google moved consumer plans to Antigravity CLI, which can be run as a Custom command.
- `parse_hook`: maps by `hook_event_name`.
- `canApprove = false`.

**Ruling recorded here:** pointing `GEMINI_CLI_SYSTEM_SETTINGS_PATH` at our own file can shadow an existing system-settings file (enterprise policy). If `/Library/Application Support/GeminiCli/settings.json` exists, copy its contents into the per-session file before adding our hooks, merging the hooks arrays. Never modify the original.

- [ ] **Step 1: Failing tests.**
  - `gemini_launch_exact`
  - `gemini_settings_file_hooks_shape`: matches the documented `{"hooks":{"AfterAgent":[{"matcher":"*","hooks":[{"type":"command","command":…,"timeout":5000}]}]}}`.
  - `gemini_merges_existing_system_settings`: point the system settings path at a temp file and inject the path in the test.
  - `gemini_parse_events`
  - `gemini_parse_ignores_garbage`
  - `gemini_writes_only_inside_session_dir`
- [ ] **Step 2: Run; expect FAIL.** Step 3: Implement. Step 4: Run; expect PASS.
- [ ] **Step 5: Commit.** `feat: Gemini CLI adapter (per-session system settings hooks)`

---

### Task 5: Notifications and dock badge

**Files:**
- Create: `src-tauri/src/notify.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/sessions.rs` (transition hook), `src-tauri/Cargo.toml`, `package.json`, `src-tauri/capabilities/default.json`
- Test: in-file tests

**Interfaces:**
- **Pure core in `notify.rs`:**
  - `pub struct Notifier { focused: AtomicBool, last: Mutex<HashMap<String, StateKind>> }`
  - `pub fn on_update(&self, prev: Option<&SessionState>, info: &SessionInfo, builder_name: &str) -> Option<Note>`, where `Note { title: String, body: String }`. It returns a note only for an agent session entering NeedsYou or Finished, when not focused, once per entry.
  - `pub fn badge_count(sessions: &[SessionInfo]) -> i64`
- **Wiring:**
  - `WindowEvent::Focused(b)` updates `focused`. Minimized or hidden also counts as unfocused.
  - Each manager `Updated` event calls `on_update`. A returned note goes to `tauri-plugin-notification`.
  - After each update and remove, call `window.set_badge_count(Some(n))`, or `None` when n is 0.
  - On notification `tap`, where the plugin's desktop `on_action` works, focus the window and emit `select-session {id}`. The frontend selects it.
  - Request permission once, on the first NeedsYou or Finished while unfocused. Never request at startup.

- [ ] **Step 1: Failing tests.**
  - `notifies_once_per_entry_only_when_unfocused`
  - `no_note_for_terminals`
  - `note_body_never_contains_task_or_output`
  - `badge_counts_needs_and_finished`
  - `badge_clears_at_zero`
- [ ] **Step 2: Run; expect FAIL.** Step 3: Implement. Step 4: Run; expect PASS. Live (driver): unfocus with `__cocDriver.unfront()` while another app is focused, if possible. Otherwise record it as an owner check.
- [ ] **Step 5: Commit.** `feat: macOS notifications and dock badge for needs-you/finished`

---

### Task 6: First-run experience

**Files:**
- Create: `src/panels/WelcomeCard.tsx`, `src/panels/AgentsStatus.tsx`
- Modify: `src/App.tsx`, `src/panels/TownHallPanel.tsx`, `src/panels/NewSessionPicker.tsx`
- Test: `src/panels/WelcomeCard.test.tsx`, `src/panels/AgentsStatus.test.tsx`

**Interfaces / behavior:**
- **With zero workspaces,** the village shows only the Town Hall, and a non-blocking WelcomeCard overlays the empty area: "Open a folder to start", with an Open folder button and New folder. It closes itself once a workspace exists. No tutorial, no modal, and the HUD stays usable.
- **AgentsStatus** appears in the Town Hall panel and the picker. It lists each adapter as installed with version, or "Not installed", with the install command as copyable text (no network):
  - Claude: `npm i -g @anthropic-ai/claude-code`
  - Codex: `npm i -g @openai/codex`
  - OpenCode: `npm i -g opencode-ai`
  - Gemini: `npm i -g @google/gemini-cli`
  - Custom: always available.
- **The picker** greys out uninstalled agents with "Not installed — see Town Hall".
- **A "Re-check" button** re-runs `detect_agents`, bypassing the 60 s cache.

- [ ] **Step 1: Failing tests.**
  - `welcome_shows_only_without_workspaces`
  - `welcome_is_not_modal`: HUD buttons stay clickable.
  - `agents_status_lists_install_commands`
  - `picker_disables_uninstalled`
  - `recheck_bypasses_cache`
- [ ] **Step 2: Run; expect FAIL.** Step 3: Implement. Step 4: Run; expect PASS. Driver snap-dom with an empty state: point a temp app data dir at a dev run via env `COC_DATA_DIR` added in this task, debug builds only.
- [ ] **Step 5: Commit.** `feat: first-run welcome and agent install status`

---

### Task 7: Release build (universal, DMG, signing and notarization wiring)

**Files:**
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/Entitlements.plist` (create), `package.json` scripts
- Create: `scripts/release.sh`, `docs/release.md`
- Test: `scripts/release.sh --dry-run` output; a real unsigned universal build

**Behavior:**
- **`tauri.conf.json`:**
  - `bundle.targets`: `["app","dmg"]`
  - `bundle.macOS`: `minimumSystemVersion "13.0"`, `entitlements "./Entitlements.plist"`, `hardenedRuntime true`
  - `bundle.macOS.dmg`: window size 660×400 with app and Applications positions
  - `bundle.createUpdaterArtifacts: true`
- **`Entitlements.plist`:** hardened runtime only. No app-sandbox. Add `com.apple.security.cs.allow-jit` only if WebKit needs it; it does not for WKWebView, so leave it out unless the notarization log asks.
- **`scripts/release.sh`:**
  1. Checks that rustup has both targets.
  2. Runs `pnpm tauri build --target universal-apple-darwin`.
  3. If `APPLE_SIGNING_IDENTITY` and (`APPLE_ID`+`APPLE_PASSWORD`+`APPLE_TEAM_ID` or `APPLE_API_ISSUER`+`APPLE_API_KEY`+`APPLE_API_KEY_PATH`) are set, Tauri signs and notarizes. Otherwise it prints "UNSIGNED BUILD — not for distribution" and continues.
  4. Prints the artifact paths and their SHA-256s.
  5. Supports `--dry-run`.
- **`docs/release.md`:** the owner's one-time setup:
  - Apple Developer account and certificate.
  - Notarization credentials.
  - Updater key: `pnpm tauri signer generate -w ~/.tauri/clashofclaudes.key`, stored outside the repo; the pubkey goes into config.
  - GitHub repo for releases.
  - The release procedure.
  - The public-name/rename checklist (identifier, productName, icons).

- [ ] **Step 1:** `scripts/release.sh --dry-run` prints the plan and detects missing credentials.
- [ ] **Step 2:** A real unsigned universal build succeeds. `lipo -archs` on the binary shows `x86_64 arm64`. A DMG exists. Updater artifacts (`.app.tar.gz` + `.sig`) are produced, or skipped with a clear message when `TAURI_SIGNING_PRIVATE_KEY` is unset.
- [ ] **Step 3: Commit.** `build: universal DMG release script with optional signing/notarization`

---

### Task 8: Auto-update

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json` (`plugins.updater`), `package.json`, `src-tauri/capabilities/default.json`
- Create: `src/hud/UpdateToast.tsx`, `scripts/make-latest-json.mjs`
- Test: `src/hud/UpdateToast.test.tsx`, `scripts/make-latest-json.test.mjs`

**Behavior:**
- **Plugin setup:** register `tauri-plugin-updater` and `tauri-plugin-process` under `#[cfg(desktop)]`.
  - Config: `plugins.updater.endpoints: ["https://github.com/<OWNER>/<REPO>/releases/latest/download/latest.json"]`.
  - `pubkey` is the placeholder `"REPLACE_WITH_UPDATER_PUBLIC_KEY"`. Release builds refuse to check while the placeholder is present (logged, no network).
- **Update check:**
  - Runs 10 s after startup, then every 6 h, only in release builds and only when the pubkey is real.
  - When an update exists, a small non-blocking toast says "Update available — Restart to update".
  - The download happens only on click, then `relaunch()`.
  - Before relaunching, the quit guard asks if sessions are running.
- **Failure:** any failure (network, signature, parse) is silent in the UI and logged.
- **The spec's "app makes no network calls" vs updates:** the updater is the single exception. It is documented in `docs/release.md` and can be turned off with a setting.
  - Add the `Settings.updates_enabled` (default true) persisted toggle in the Town Hall panel.
  - **Ruling:** spec §8 requires auto-update; §6.5's "no network calls" refers to agent data. The updater only fetches `latest.json` and the signed artifact from the configured host.
- **`scripts/make-latest-json.mjs`:** builds `latest.json` from the build artifacts and `.sig` files. `darwin-aarch64` and `darwin-x86_64` both point at the universal tarball.

- [ ] **Step 1: Failing tests.**
  - `update_check_failure_is_silent`
  - `placeholder_pubkey_disables_checks`
  - `toast_restart_runs_quit_guard`
  - `settings_toggle_disables_updates`
  - `latest_json_shape`
- [ ] **Step 2: Run; expect FAIL.** Step 3: Implement. Step 4: Run; expect PASS.
- [ ] **Step 5: Commit.** `feat: signed auto-update via GitHub Releases latest.json (owner supplies keys)`

---

### Task 9: v1 verification, user docs, owner handoff

**Files:**
- Create: `docs/verification/plan-3-v1.md`, `README.md` (rewrite for users)
- Modify: `docs/superpowers/plans/2026-10-30-core-sessions-followups.md`

**Behavior:**
- **README:** what the app is, install (DMG), first run, supported agents and what each one can report, and privacy (no network except optional update checks; never edits your agent configs).
- **Verification doc:** a matrix of each agent × capability (launch, status events, prompt detection, approve/deny), with each cell **verified** or **owner check**. Also budgets re-run on the release build where measurable, and the consolidated owner checklist (Plan 2's checks plus agent install checks plus notifications plus signing).
- **Follow-ups doc:** mark resolved items and list what remains for after v1.

- [ ] **Step 1:** Run all suites and a release build, and collect the numbers.
- [ ] **Step 2:** Write the docs.
- [ ] **Step 3: Commit.** `docs: v1 verification, README, owner handoff`

---

## Rulings made while planning (check these)

- **P3-R1:** Codex, OpenCode and Gemini ship with `canApprove = false` until an owner check verifies their approval keys; none of the three CLIs is installed here. Cost if wrong: one extra click into the terminal.
- **P3-R2:** Antigravity CLI (`agy`) gets no dedicated adapter in v1. Its flags and hooks are unverified; users run it as a Custom command, and the picker says so.
- **P3-R3:** Codex events go through `notify` (turn-complete only). Approvals come from screen-pattern detection, because there is no verified per-session hooks route that doesn't touch `CODEX_HOME`.
- **P3-R4:** The Gemini per-session settings route uses `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, merged with any existing system settings so enterprise policy is kept.
- **P3-R5:** The updater is the only network access the app makes, and it can be turned off. The private key is never generated by us.
- **P3-R6:** Signing and notarization are wired but unexercised. A real signed build needs the owner's Apple Developer credentials.
