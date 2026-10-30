# Clash of Claudes — Plan 1: Core (workspaces, terminals, sessions, Claude Code status) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working Mac desktop app (plain UI, no village yet) where you add workspaces, start Claude Code or custom-command sessions and plain terminals in real PTYs, and see each session's live state (working / needs you / finished / stuck), with Allow/Deny, Review, Stop and Close.

**Architecture:**
- **Rust core** (Tauri 2), the single source of truth for sessions. It owns:
  - PTYs (portable-pty) and per-session scrollback.
  - A pure status state machine.
  - Per-agent adapters.
  - A localhost hook server that Claude Code hooks POST to.
- **Frontend** (React + TypeScript): renders state pushed from Rust and mounts xterm.js only for the visible terminal.
- **Later plans:** Plan 2 replaces the plain UI with the village; Plan 3 adds the other agents, notifications and the release track.

**Tech Stack:** Tauri 2, Rust (portable-pty, axum, tokio, serde, uuid, anyhow), React 19 + TypeScript + Vite, zustand, @xterm/xterm + @xterm/addon-webgl + @xterm/addon-fit, @tauri-apps/plugin-dialog, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-10-30-clashofclaudes-design.md` (sections implemented here: §2.2–2.4, 2.6–2.7, 2.10; §3; §4; §5.1a data model; §5.3 states and lifecycle minus visuals; §6; §7 terminal and memory parts; §8 portability; §10 shared folder and worktrees).

**Roadmap:**
- **Plan 2, Village:** PixiJS village, compounds, placement and move, XP and levels, camera, panels restyled, builder edit/rename/dismiss UI, pop-out terminal, mapping the 5 Claude effort levels onto gear.
- **Plan 3, Agents + release:** Codex, Gemini CLI and OpenCode adapters, notifications and dock badge, first-run experience, signing, notarization, DMG, updater.

## Global Constraints

- **Platform:** macOS 13+ for v1. No tmux or zsh dependency. Pick the shell from `$SHELL`, falling back to `/bin/zsh`. Keep OS-specific code in `src-tauri/src/platform.rs`.
- **Network:** the app makes **no network calls**. The hook server binds **127.0.0.1 only**, on an OS-assigned port, and every route carries a per-session random token.
- **Never modify the user's Claude config:** never write to `~/.claude` or any project `.claude/` settings. Claude hooks are delivered through a per-session settings file in the app data dir, passed with `--settings`.
- **Arguments:** task prompts and all user strings are passed as **argv elements**, never interpolated into a shell string.
- **Claude Code flags** (verified against v2.1.314):
  - `--session-id <uuid>`, `--settings <file>`, `--append-system-prompt <text>`
  - `--model <alias>`, aliases `haiku | sonnet | opus | fable`
  - `--effort <level>`, levels `low | medium | high | xhigh | max`
  - the task is a trailing positional argument
- **Shared-folder note,** appended to every agent session's system prompt, exact copy: `Other coding agents may be working in this same folder at the same time. If your task needs isolation from their changes, you may create your own git worktree and work there.`
- **No fake data:** unknown values are absent (`None`/`null`), never guessed.
- **Budgets:**
  - Memory ≤ 250 MB for the app (10 sessions + 2 terminals).
  - Scrollback cap **2 MiB per session**.
  - Only the visible terminal has a live xterm instance.
  - Output events to the frontend are batched (one flush per **16 ms** per session at most).
- **Persistence:** a single JSON file `state.json` in the Tauri app data dir, written atomically (temp file + rename).

## Review Focus

1. **A saved workspace folder was deleted or moved** while the app was closed. The app should load fine, mark the workspace "missing", and refuse to start sessions there with a clear error. *Test: Task 2 `load_marks_missing_workspaces`, Task 8 `start_in_missing_workspace_errors`.*
2. **An agent CLI exits immediately** (not installed, not logged in, bad flag). The session should go to Stuck with "exited with code N" and keep its output visible, not hang in Starting. *Test: Task 8 `immediate_nonzero_exit_goes_stuck`.*
3. **A task prompt with quotes, `$()`, newlines or emoji.** It should reach the agent verbatim as one argument. *Test: Task 6 `task_prompt_is_single_verbatim_arg`.*
4. **A hook POST for an unknown or closed session, or with a wrong token.** The app should ignore it (404/403) and keep running. *Test: Task 7 `wrong_token_is_403`, `unknown_session_is_404`.*
5. **A huge output burst** (`yes`, `cat` of a big file). Memory should stay capped and the UI responsive. *Test: Task 3 `scrollback_caps_bytes`, Task 8 `output_is_batched`.*

---

## File Structure

```
src-tauri/
  Cargo.toml
  src/
    main.rs                 # tauri entry → lib::run()
    lib.rs                  # builder, plugins, state, command registration, quit guard
    platform.rs             # default shell, which(), OS bits
    model.rs                # Workspace, Builder, AgentKind, AppData, SessionInfo, SessionState, ...
    persist.rs              # load/save AppData (atomic), missing-folder check
    scrollback.rs           # byte-capped ring buffer
    pty.rs                  # PtyHandle: spawn/write/resize/kill + reader thread
    status.rs               # StatusEvent, StatusPolicy, next_state() (pure)
    git.rs                  # baseline, review_since, worktree_of
    hooks.rs                # localhost hook HTTP server
    adapters/
      mod.rs                # AgentAdapter trait, LaunchRequest/LaunchSpec, Detection, registry
      claude.rs             # Claude Code adapter (launch, settings file, hook parsing, keys)
      generic.rs            # Custom command adapter + plain shell terminal
    sessions.rs             # SessionManager
    commands.rs             # #[tauri::command] wrappers + event emission
  tests/fixtures/claude-hooks/*.json
src/
  main.tsx, App.tsx, App.css
  api/types.ts              # TS mirrors of Rust types
  api/ipc.ts                # typed invoke/listen wrappers
  state/store.ts            # zustand store + event reducers
  state/store.test.ts
  components/Sidebar.tsx        # workspaces → sessions with state dots
  components/NewSessionForm.tsx # builder pick or recruit, task, command preview
  components/NewSessionForm.test.tsx
  components/SessionPanel.tsx   # header, actions, review, TerminalView
  components/TerminalView.tsx   # xterm attach/detach
```

---

### Task 1: Scaffold the Tauri + React app with test runners

**Files:**
- Create: everything from the `create-tauri-app` `react-ts` template at the repo root (`package.json`, `vite.config.ts`, `src/`, `src-tauri/`)
- Modify: `.gitignore` (keep existing lines), `src-tauri/tauri.conf.json`, `package.json`
- Test: `src/App.test.tsx`, `src-tauri/src/lib.rs` (a `#[cfg(test)]` smoke test)

**Interfaces:**
- Produces: `pnpm tauri dev`, `pnpm test` (vitest, jsdom), `cargo test --manifest-path src-tauri/Cargo.toml`.

- [ ] **Step 1: Scaffold into a temp dir and move into the repo root** (the root already has `docs/` and `.gitignore`)

Run:
```bash
cd /tmp && rm -rf coc-scaffold && pnpm create tauri-app@latest coc-scaffold --template react-ts --manager pnpm --identifier dev.clashofclaudes.app -y
rsync -a --exclude .git --exclude .gitignore /tmp/coc-scaffold/ /Users/fabianferno/Documents/clashofclaudes/
cd /Users/fabianferno/Documents/clashofclaudes && pnpm install
```
Expected: `src-tauri/Cargo.toml` and `package.json` exist; install succeeds.

- [ ] **Step 2: Configure the app**

In `src-tauri/tauri.conf.json`:
- `productName` = `"Clash of Claudes"`
- the main window: `title` `"Clash of Claudes"`, 1280×800, `minWidth` 960, `minHeight` 600
- `bundle.macOS.minimumSystemVersion` = `"13.0"`

Add dev dependencies `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, and the script `"test": "vitest run"`. In `vite.config.ts`, set `test: { environment: 'jsdom' }`.

- [ ] **Step 3: Write smoke tests**

```tsx
// src/App.test.tsx
import { render, screen } from '@testing-library/react';
import App from './App';
test('renders app title', () => { render(<App />); expect(screen.getByText('Clash of Claudes')).toBeTruthy(); });
```
```rust
// src-tauri/src/lib.rs
#[cfg(test)] mod smoke { #[test] fn it_builds() { assert_eq!(2 + 2, 4); } }
```
Replace the template `App.tsx` body with an `<h1>Clash of Claudes</h1>`.

- [ ] **Step 4: Run both test suites**

Run: `pnpm test && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: both PASS.

- [ ] **Step 5: Run the app once**

Run: `pnpm tauri dev` (stop it after the window appears)
Expected: a window titled "Clash of Claudes".

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold Tauri 2 + React app with test runners"
```

---

### Task 2: Core model and persistence

**Files:**
- Create: `src-tauri/src/model.rs`, `src-tauri/src/persist.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod model; mod persist;`), `src-tauri/Cargo.toml` (serde, serde_json, uuid with `v4`/`serde`, anyhow, tempfile as a dev-dependency)
- Test: unit tests inside `persist.rs`

**Interfaces:**
- Produces (`model.rs`, all `#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]`, serde `rename_all = "camelCase"`):
  - `enum AgentKind { Claude, Codex, Gemini, OpenCode, Custom }` with `#[serde(rename_all = "lowercase")]`
  - `struct Workspace { id: String, name: String, path: PathBuf, created_at: i64, #[serde(default, skip_serializing)] missing: bool }`
  - `struct Builder { id: String, name: String, agent: AgentKind, model: Option<String>, effort: Option<String>, custom_command: Option<String> }`
  - `struct AppData { version: u32, workspaces: Vec<Workspace>, builders: Vec<Builder> }` with `Default` (`version: 1`)
  - `enum SessionState { Starting, Working, NeedsYou { reason: String }, Finished, Stuck { reason: String }, Ended { exit_code: Option<i32> } }` with `#[serde(tag = "kind")]`
  - `enum SessionKind { Agent { builder_id: String }, Terminal }` with `#[serde(tag = "kind")]`
  - `struct WorktreeInfo { path: PathBuf, branch: Option<String> }`
  - `struct SessionInfo { id: String, workspace_id: String, kind: SessionKind, task: Option<String>, state: SessionState, steps: u32, started_at: i64, last_output_at: i64, reached_finished: bool, worktree: Option<WorktreeInfo>, command_preview: String }`
- Produces (`persist.rs`):
  - `fn load(path: &Path) -> AppData`
  - `fn save(path: &Path, data: &AppData) -> anyhow::Result<()>`
  - `fn mark_missing(data: &mut AppData)`

- [ ] **Step 1: Write failing tests in `persist.rs`**

```rust
#[test] fn roundtrip() { /* tempdir; save AppData with 1 workspace (path with a space and "é") + 1 builder; load; assert_eq!(loaded, saved) */ }
#[test] fn missing_file_gives_default() { assert_eq!(load(&dir.join("nope.json")), AppData::default()); }
#[test] fn corrupt_file_is_backed_up_and_default_returned() {
    // write "{not json" to state.json; load(); assert default; assert dir.join("state.json.bak") exists with "{not json"
}
#[test] fn load_marks_missing_workspaces() {
    // workspace path = tempdir/gone (never created); mark_missing(&mut data); assert!(data.workspaces[0].missing)
}
#[test] fn save_is_atomic_no_partial_file() { /* after save, no "state.json.tmp" remains */ }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml persist`
Expected: FAIL (does not compile: `load`/`save` missing).

- [ ] **Step 3: Implement `model.rs` types and the `persist.rs` functions**

`save` writes `state.json.tmp` and then renames it. On a parse error, `load` copies the file to `state.json.bak` and returns the default.

- [ ] **Step 4: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml persist`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri && git commit -m "feat(core): app data model and atomic JSON persistence"
```

---

### Task 3: Scrollback buffer and PTY host

**Files:**
- Create: `src-tauri/src/scrollback.rs`, `src-tauri/src/pty.rs`, `src-tauri/src/platform.rs`
- Modify: `src-tauri/Cargo.toml` (portable-pty 0.9), `lib.rs` (mods)
- Test: unit tests in `scrollback.rs` and `pty.rs`

**Interfaces:**
- Produces:
  - `struct Scrollback`: `fn new(cap_bytes: usize) -> Self`, `fn push(&mut self, data: &[u8])`, `fn snapshot(&self) -> Vec<u8>`, `fn len(&self) -> usize`. Keeps the **most recent** `cap_bytes`.
  - `pub const SCROLLBACK_CAP: usize = 2 * 1024 * 1024;`
  - `struct LaunchSpec { program: String, args: Vec<String>, env: Vec<(String, String)>, cwd: PathBuf }`. It is defined here because the PTY consumes it; adapters build it.
  - `struct PtyHandle`:
    - `fn spawn(spec: &LaunchSpec, cols: u16, rows: u16, on_output: Box<dyn Fn(&[u8]) + Send>, on_exit: Box<dyn FnOnce(Option<i32>) + Send>) -> anyhow::Result<PtyHandle>`
    - `fn write(&self, data: &[u8]) -> anyhow::Result<()>`
    - `fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()>`
    - `fn kill(&self) -> anyhow::Result<()>`
  - `platform::default_shell() -> String`
  - `platform::which(program: &str) -> Option<PathBuf>`

- [ ] **Step 1: Write failing tests**

```rust
// scrollback.rs
#[test] fn scrollback_keeps_all_under_cap() { let mut s = Scrollback::new(10); s.push(b"abc"); assert_eq!(s.snapshot(), b"abc"); }
#[test] fn scrollback_caps_bytes() { let mut s = Scrollback::new(4); s.push(b"abcdef"); s.push(b"gh"); assert_eq!(s.snapshot(), b"efgh"); assert_eq!(s.len(), 4); }
// pty.rs
#[test] fn spawn_captures_output_and_exit_code() {
    // spec: program "/bin/sh", args ["-c", "printf hello; exit 3"], cwd tempdir
    // collect output via Arc<Mutex<Vec<u8>>>; wait for exit (channel, 5s timeout)
    // assert output contains "hello"; assert exit == Some(3)
}
#[test] fn write_reaches_child() { /* "/bin/cat"; write b"ping\n"; output eventually contains "ping"; kill(); exit observed */ }
#[test] fn cwd_with_spaces_is_respected() { /* cwd tempdir/"my dir"; "/bin/pwd"; output contains "my dir" */ }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml scrollback pty`
Expected: FAIL (compile errors).

- [ ] **Step 3: Implement**

- **`Scrollback`:** a `VecDeque<u8>` that drains from the front when over the cap.
- **`PtyHandle`:**
  - Spawn with `native_pty_system().openpty`.
  - Build `CommandBuilder` from `program` plus `args` exactly as given (no shell). Set `cwd`, `env`, and `TERM=xterm-256color`.
  - Run a reader thread that loops `read` into an 8 KiB buffer and calls `on_output`.
  - Run a waiter thread that calls `on_exit(exit_status.exit_code() as i32)`.
  - Guard writer, master and child with mutexes.

- [ ] **Step 4: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml scrollback pty`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri && git commit -m "feat(core): PTY host and capped scrollback"
```

---

### Task 4: Status state machine (pure)

**Files:**
- Create: `src-tauri/src/status.rs`
- Test: unit tests in `status.rs`

**Interfaces:**
- Consumes: `SessionState` (Task 2).
- Produces:
  - `enum StatusEvent { Output, Silence { secs: u64 }, TurnFinished, PermissionRequested { message: String }, WaitingForInput, ToolUsed, PromptSubmitted, UserInput, Exited { code: Option<i32> } }`
  - `struct StatusPolicy { uses_hooks: bool, finished_after_silence_secs: Option<u64>, stuck_after_silence_secs: Option<u64> }`
  - `fn next_state(state: &SessionState, ev: &StatusEvent, policy: &StatusPolicy) -> SessionState`

**Rules** (the spec's §5.3 states; this table is the decision):

| From | Event | To |
|---|---|---|
| any non-Ended | `Exited{Some(0)}` | `Ended{exit_code: Some(0)}` |
| any non-Ended | `Exited{code}` where code ≠ Some(0) | `Stuck{reason: "exited with code N"}` (`"process ended"` when None) |
| Starting | `Output` | Working |
| any non-Ended | `PromptSubmitted` | Working |
| NeedsYou, Finished, Starting | `ToolUsed` | Working |
| any non-Ended | `TurnFinished` | Finished |
| any non-Ended | `PermissionRequested{m}` | `NeedsYou{reason: m}` |
| Working | `WaitingForInput` | Finished |
| Working, `!uses_hooks` | `UserInput` | Working (from Finished too) |
| Working | `Silence{s}`, s ≥ `finished_after_silence_secs` (when Some) | Finished |
| Working | `Silence{s}`, s ≥ `stuck_after_silence_secs` (when Some) | `Stuck{reason: "no output for N min"}` |
| Stuck (from silence) | `Output` | Working |
| Ended | anything | Ended |

Anything not listed leaves the state unchanged.

- [ ] **Step 1: Write failing table tests**

```rust
fn hooks() -> StatusPolicy { StatusPolicy { uses_hooks: true, finished_after_silence_secs: None, stuck_after_silence_secs: Some(900) } }
fn plain() -> StatusPolicy { StatusPolicy { uses_hooks: false, finished_after_silence_secs: Some(20), stuck_after_silence_secs: Some(900) } }
#[test] fn starting_output_is_working() { assert_eq!(next_state(&Starting, &Output, &hooks()), Working); }
#[test] fn permission_needs_you() { assert_eq!(next_state(&Working, &PermissionRequested{message:"Bash".into()}, &hooks()), NeedsYou{reason:"Bash".into()}); }
#[test] fn tool_after_permission_resumes() { assert_eq!(next_state(&NeedsYou{reason:"x".into()}, &ToolUsed, &hooks()), Working); }
#[test] fn turn_finished() { assert_eq!(next_state(&Working, &TurnFinished, &hooks()), Finished); }
#[test] fn hook_agents_ignore_short_silence() { assert_eq!(next_state(&Working, &Silence{secs:60}, &hooks()), Working); }
#[test] fn plain_agents_finish_on_silence() { assert_eq!(next_state(&Working, &Silence{secs:20}, &plain()), Finished); }
#[test] fn long_silence_is_stuck() { assert_eq!(next_state(&Working, &Silence{secs:900}, &hooks()), Stuck{reason:"no output for 15 min".into()}); }
#[test] fn nonzero_exit_is_stuck() { assert_eq!(next_state(&Working, &Exited{code:Some(1)}, &hooks()), Stuck{reason:"exited with code 1".into()}); }
#[test] fn clean_exit_ends() { assert_eq!(next_state(&Finished, &Exited{code:Some(0)}, &hooks()), Ended{exit_code:Some(0)}); }
#[test] fn ended_is_terminal() { assert_eq!(next_state(&Ended{exit_code:Some(0)}, &PromptSubmitted, &hooks()), Ended{exit_code:Some(0)}); }
#[test] fn plain_user_input_resumes_from_finished() { assert_eq!(next_state(&Finished, &UserInput, &plain()), Working); }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml status`
Expected: FAIL.

- [ ] **Step 3: Implement `next_state` per the table**

- [ ] **Step 4: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml status`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri && git commit -m "feat(core): session status state machine"
```

---

### Task 5: Adapter trait, registry and generic adapter

**Files:**
- Create: `src-tauri/src/adapters/mod.rs`, `src-tauri/src/adapters/generic.rs`
- Test: unit tests in `generic.rs` and `mod.rs`

**Interfaces:**
- Consumes: `LaunchSpec` (Task 3), `StatusEvent`/`StatusPolicy` (Task 4), `AgentKind` (Task 2), `platform::which`.
- Produces:
  - `struct Detection { installed: bool, path: Option<PathBuf>, version: Option<String> }`
  - `struct LaunchRequest<'a> { session_id: &'a str, cwd: &'a Path, model: Option<&'a str>, effort: Option<&'a str>, task: Option<&'a str>, hook_url: &'a str, data_dir: &'a Path, custom_command: Option<&'a str> }`
  - `trait AgentAdapter: Send + Sync` with:
    - `fn kind(&self) -> AgentKind`
    - `fn label(&self) -> &'static str`
    - `fn detect(&self) -> Detection`
    - `fn models(&self) -> Vec<String>`
    - `fn efforts(&self) -> Vec<String>`
    - `fn launch(&self, req: &LaunchRequest) -> anyhow::Result<LaunchSpec>`
    - `fn policy(&self) -> StatusPolicy`
    - `fn parse_hook(&self, body: &serde_json::Value) -> Vec<StatusEvent>`, default `vec![]`
    - `fn approve_keys(&self) -> Option<&'static [u8]>`, default `None`
    - `fn deny_keys(&self) -> Option<&'static [u8]>`, default `None`
  - `struct AdapterRegistry`:
    - `fn new() -> Self`, which registers Claude (Task 6) and Custom
    - `fn get(&self, kind: AgentKind) -> Option<Arc<dyn AgentAdapter>>`
    - `fn all(&self) -> Vec<Arc<dyn AgentAdapter>>`
  - `struct CustomAdapter`:
    - `launch` runs `default_shell()` with args `["-lc", custom_command]`, plus the task as `$1` via `["-lc", custom_command, "coc", task]` so the task is never spliced into the string.
    - `policy`: `uses_hooks: false, finished_after_silence_secs: Some(20), stuck_after_silence_secs: Some(900)`.
  - `fn terminal_launch(cwd: &Path) -> LaunchSpec`: the user's shell as a login shell (`-l`), with no adapter. Terminal sessions use `StatusPolicy { uses_hooks: false, finished_after_silence_secs: None, stuck_after_silence_secs: None }`.

- [ ] **Step 1: Write failing tests**

```rust
#[test] fn custom_launch_passes_task_as_positional() {
    let spec = CustomAdapter.launch(&req_with(Some("aider --yes"), Some("fix \"it\" $(rm -rf /)"))).unwrap();
    assert_eq!(spec.args, vec!["-lc", "aider --yes", "coc", "fix \"it\" $(rm -rf /)"]);
}
#[test] fn custom_without_command_errors() { assert!(CustomAdapter.launch(&req_with(None, None)).is_err()); }
#[test] fn terminal_uses_login_shell_in_cwd() { let s = terminal_launch(Path::new("/tmp")); assert_eq!(s.args, vec!["-l"]); assert_eq!(s.cwd, PathBuf::from("/tmp")); }
#[test] fn registry_has_claude_and_custom() { let r = AdapterRegistry::new(); assert!(r.get(AgentKind::Claude).is_some()); assert!(r.get(AgentKind::Custom).is_some()); }
```

The registry test passes after Task 6. For now, mark it `#[ignore]`; Task 6 un-ignores it.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml adapters`
Expected: FAIL.

- [ ] **Step 3: Implement the trait, registry (Custom only for now), `CustomAdapter` and `terminal_launch`**

- [ ] **Step 4: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml adapters`
Expected: PASS (3 passed, 1 ignored).

- [ ] **Step 5: Commit**

```bash
git add src-tauri && git commit -m "feat(core): agent adapter trait, registry, custom command adapter"
```

---

### Task 6: Claude Code adapter (with real hook fixtures)

**Files:**
- Create: `src-tauri/src/adapters/claude.rs`, `src-tauri/tests/fixtures/claude-hooks/` (captured JSON)
- Modify: `adapters/mod.rs` (register Claude; un-ignore the registry test)
- Test: unit tests in `claude.rs`

**Interfaces:**
- Consumes: Task 5's trait and types.
- Produces: `struct ClaudeAdapter` implementing `AgentAdapter`:
  - `models()` = `["haiku","sonnet","opus","fable"]`
  - `efforts()` = `["low","medium","high","xhigh","max"]`
  - `launch` writes `{data_dir}/sessions/{session_id}/claude-settings.json` and returns:
    - program `claude`
    - args in order: `["--session-id", id, "--settings", <path>, "--append-system-prompt", SHARED_FOLDER_NOTE]`, then `["--model", m]` if Some, then `["--effort", e]` if Some, then `[task]` if Some
  - **Settings JSON:** hooks `SessionStart`, `UserPromptSubmit`, `PostToolUse` (matcher `"*"`), `Notification`, `Stop` and `SessionEnd`, each with one `{"type":"command","command": HOOK_CMD}`, where `HOOK_CMD` = `curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- '<hook_url>'`
  - `policy()` = `uses_hooks: true, finished_after_silence_secs: None, stuck_after_silence_secs: Some(900)`
  - `parse_hook` maps `hook_event_name`:
    - `UserPromptSubmit` → `PromptSubmitted`
    - `PostToolUse` → `ToolUsed`
    - `Stop` → `TurnFinished`
    - `Notification`: permission-type → `PermissionRequested{message}`; idle-type → `WaitingForInput`. Exact field names come from the fixtures (Step 1).
    - other → `[]`
  - Every payload containing `cwd` also yields `CwdChanged`. This adds `CwdChanged { cwd: PathBuf }` to `StatusEvent`; `next_state` leaves the state unchanged on it, and Task 8 consumes it for worktrees.
  - `approve_keys` / `deny_keys`: set from Step 1's verification. Expected `b"1"` and `b"\x1b"`.
- Produces: `pub const SHARED_FOLDER_NOTE: &str` (exact copy in Global Constraints).

- [ ] **Step 1: HUMAN-ASSISTED: capture real hook payloads and confirm the approval keys**

In a scratch git repo, run:
```bash
mkdir -p /tmp/coc-hooks && cd /tmp/coc-hooks && git init -q
cat > /tmp/coc-hooks/log.json <<'EOF'
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"cat >> /tmp/coc-hooks/events.jsonl; echo >> /tmp/coc-hooks/events.jsonl"}]}],
"UserPromptSubmit":[{"hooks":[{"type":"command","command":"cat >> /tmp/coc-hooks/events.jsonl; echo >> /tmp/coc-hooks/events.jsonl"}]}],
"PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"cat >> /tmp/coc-hooks/events.jsonl; echo >> /tmp/coc-hooks/events.jsonl"}]}],
"Notification":[{"hooks":[{"type":"command","command":"cat >> /tmp/coc-hooks/events.jsonl; echo >> /tmp/coc-hooks/events.jsonl"}]}],
"Stop":[{"hooks":[{"type":"command","command":"cat >> /tmp/coc-hooks/events.jsonl; echo >> /tmp/coc-hooks/events.jsonl"}]}],
"SessionEnd":[{"hooks":[{"type":"command","command":"cat >> /tmp/coc-hooks/events.jsonl; echo >> /tmp/coc-hooks/events.jsonl"}]}]}}
EOF
claude --settings /tmp/coc-hooks/log.json --model haiku "Create a file hello.txt containing hi using the Bash tool"
```

Then, in that Claude session:
1. At the permission prompt, press `1` and note whether that approves.
2. Ask for another Bash command and press `Esc` at the prompt; note whether that denies.
3. Wait 70 seconds idle so the idle notification fires.
4. Type `/exit`.

Copy one line per kind into `src-tauri/tests/fixtures/claude-hooks/`: `user_prompt_submit.json`, `post_tool_use.json`, `notification_permission.json`, `notification_idle.json`, `stop.json`, `session_end.json`. Record the confirmed approve and deny keys in a comment at the top of `claude.rs`.

Expected: six fixture files, each with `hook_event_name`, `session_id` and `cwd`.

- [ ] **Step 2: Write failing tests**

```rust
#[test] fn launch_args_in_order() {
    let spec = ClaudeAdapter.launch(&req("sid-1", Some("opus"), Some("max"), Some("fix bug"))).unwrap();
    assert_eq!(spec.program, "claude");
    assert_eq!(&spec.args[0..2], &["--session-id", "sid-1"]);
    assert_eq!(spec.args[2], "--settings");
    assert_eq!(&spec.args[4..6], &["--append-system-prompt", SHARED_FOLDER_NOTE]);
    assert_eq!(&spec.args[6..], &["--model", "opus", "--effort", "max", "fix bug"]);
}
#[test] fn task_prompt_is_single_verbatim_arg() {
    let t = "say \"hi\" && $(whoami)\nline2 🚀";
    let spec = ClaudeAdapter.launch(&req("s", None, None, Some(t))).unwrap();
    assert_eq!(spec.args.last().unwrap(), t);
}
#[test] fn settings_file_has_all_hooks_pointing_at_url() {
    // read written settings; for each of the 6 events, the command contains the hook_url and "--data-binary @-"
}
#[test] fn parses_fixtures() {
    assert_eq!(parse("stop.json"), vec![TurnFinished, cwd_ev()]);
    assert!(matches!(parse("notification_permission.json")[0], PermissionRequested{..}));
    assert_eq!(parse("notification_idle.json")[0], WaitingForInput);
    assert_eq!(parse("post_tool_use.json")[0], ToolUsed);
    assert_eq!(parse("user_prompt_submit.json")[0], PromptSubmitted);
}
#[test] fn unknown_event_is_ignored() { assert_eq!(ClaudeAdapter.parse_hook(&json!({"hook_event_name":"Nope"})), vec![]); }
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml claude`
Expected: FAIL.

- [ ] **Step 4: Implement `ClaudeAdapter`, add the `CwdChanged` variant, and register the adapter**

`detect()` uses `platform::which("claude")` plus `claude --version` (first line).

- [ ] **Step 5: Run all adapter tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml adapters claude status`
Expected: PASS (registry test now active).

- [ ] **Step 6: Commit**

```bash
git add src-tauri && git commit -m "feat(core): Claude Code adapter with per-session hook settings"
```

---

### Task 7: Localhost hook server

**Files:**
- Create: `src-tauri/src/hooks.rs`
- Modify: `Cargo.toml` (axum 0.8, tokio with `rt-multi-thread,macros,net`; reqwest as a dev-dependency)
- Test: async tests in `hooks.rs`

**Interfaces:**
- Produces:
  - `type HookSink = Arc<dyn Fn(String /*session_id*/, serde_json::Value) + Send + Sync>`
  - `struct HookServer`:
    - `async fn start(sink: HookSink) -> anyhow::Result<HookServer>`, binding `127.0.0.1:0`
    - `fn port(&self) -> u16`
    - `fn register(&self, session_id: &str) -> String`, returning the full URL `http://127.0.0.1:{port}/hook/{session_id}/{token}`. The token is 32 random hex characters.
    - `fn unregister(&self, session_id: &str)`
  - Route: `POST /hook/:session/:token`.
    - Valid → call the sink, return 204.
    - Known session with a bad token → 403.
    - Unknown session → 404.
    - Invalid JSON → 400.
    - Body limit 1 MiB.

- [ ] **Step 1: Write failing tests**

```rust
#[tokio::test] async fn valid_post_reaches_sink() { /* register "s1"; POST {"hook_event_name":"Stop"} to url → 204; sink got ("s1", body) */ }
#[tokio::test] async fn wrong_token_is_403() { /* register "s1"; POST to /hook/s1/deadbeef → 403; sink not called */ }
#[tokio::test] async fn unknown_session_is_404() { /* POST /hook/zzz/abc → 404 */ }
#[tokio::test] async fn unregistered_session_is_404() { /* register, unregister, POST → 404 */ }
#[tokio::test] async fn binds_loopback_only() { /* assert server local addr ip is 127.0.0.1 */ }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hooks`
Expected: FAIL.

- [ ] **Step 3: Implement with axum and a `Mutex<HashMap<String, String>>` of tokens**

- [ ] **Step 4: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hooks`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri && git commit -m "feat(core): loopback hook server with per-session tokens"
```

---

### Task 8: Git review helpers and SessionManager

**Files:**
- Create: `src-tauri/src/git.rs`, `src-tauri/src/sessions.rs`
- Test: unit tests in `git.rs`; integration-style tests in `sessions.rs`

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces (`git.rs`, shells out to the `git` CLI with `-C <dir>`):
  - `struct GitBaseline { repo_root: PathBuf, head: Option<String> }`
  - `fn baseline(dir: &Path) -> Option<GitBaseline>`, which is `None` when not a git repo
  - `struct FileChange { path: String, added: u32, removed: u32 }`
  - `struct Review { is_git: bool, branch: Option<String>, files: Vec<FileChange>, untracked: Vec<String>, other_sessions_active: bool }`
  - `fn review_since(dir: &Path, base: Option<&GitBaseline>) -> anyhow::Result<Review>`: uses `git diff --numstat <head>` (working tree vs baseline; binary files count 0/0) plus `git ls-files --others --exclude-standard`. When `base` is None, returns `Review { is_git: false, .. }`.
  - `fn worktree_of(workspace_root: &Path, cwd: &Path) -> Option<WorktreeInfo>`: `Some` when `cwd` is inside a different worktree of the same repository (same `git rev-parse --git-common-dir`, different `--show-toplevel`).
  - `fn init_repo(dir: &Path) -> anyhow::Result<()>`
- Produces (`sessions.rs`):
  - `enum ManagerEvent { Updated(SessionInfo), Output { id: String, data: Vec<u8> }, Removed { id: String } }`
  - `type Emit = Arc<dyn Fn(ManagerEvent) + Send + Sync>`
  - `struct SessionManager`. Constructor: `fn new(registry: AdapterRegistry, hooks: Arc<HookServer>, data_dir: PathBuf, emit: Emit) -> Arc<SessionManager>`. Methods:
    - `fn start_agent(&self, ws: &Workspace, builder: &Builder, task: Option<&str>) -> anyhow::Result<SessionInfo>`: errors if `ws.missing`, if the adapter is not installed, or if the builder already has a non-Ended session (one session per builder, spec §5.1a)
    - `fn start_terminal(&self, ws: &Workspace) -> anyhow::Result<SessionInfo>`
    - `fn on_hook(&self, session_id: &str, body: serde_json::Value)`
    - `fn write(&self, id: &str, data: &[u8]) -> anyhow::Result<()>`: feeds `UserInput` when `data` contains `\r`
    - `fn resize(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()>`
    - `fn approve(&self, id: &str) -> anyhow::Result<()>` and `fn deny(&self, id: &str) -> anyhow::Result<()>`: error if the adapter has no keys or the state isn't NeedsYou
    - `fn stop(&self, id: &str) -> anyhow::Result<()>`: kill; the session stays listed in its final state
    - `fn close(&self, id: &str) -> anyhow::Result<CloseOutcome>`, with `struct CloseOutcome { earned_xp: bool }`: kill if alive, unregister the hook, emit `Removed`. `earned_xp = reached_finished && !matches!(state, Stuck{..})`.
    - `fn attach(&self, id: &str) -> anyhow::Result<Vec<u8>>` (scrollback snapshot)
    - `fn review(&self, id: &str) -> anyhow::Result<Review>`: uses the worktree path and branch when set; `other_sessions_active` = another live session exists in the same workspace
    - `fn tick(&self, now_ms: i64)`: feeds `Silence{secs}` per session
    - `fn list(&self) -> Vec<SessionInfo>`
    - `fn live_count(&self) -> usize`: sessions not Ended
- Behavior:
  - Output is pushed to scrollback immediately and coalesced for emission: at most one `Output` event per session per 16 ms, with an empty-buffer flush on a timer.
  - Every state change emits `Updated`.
  - On `CwdChanged`, run `worktree_of` and set `worktree` when Some.
  - `command_preview` = the program and args joined with shell quoting (display only).

- [ ] **Step 1: Write failing `git.rs` tests** (each in a fresh temp repo with one commit)

```rust
#[test] fn non_git_dir_has_no_baseline() { assert!(baseline(tmp.path()).is_none()); }
#[test] fn review_counts_changes_since_baseline() {
    // commit a.txt "1\n"; b = baseline(); write a.txt "1\n2\n"; create new.txt
    // r = review_since(dir, Some(&b)); assert files == [FileChange{path:"a.txt",added:1,removed:0}]; untracked == ["new.txt"]
}
#[test] fn review_without_git_is_flagged() { assert!(!review_since(tmp.path(), None).unwrap().is_git); }
#[test] fn detects_worktree() {
    // git worktree add ../wt -b feature; assert_eq!(worktree_of(repo, &wt).unwrap().branch.as_deref(), Some("feature"))
    // assert!(worktree_of(repo, repo).is_none())
}
```

- [ ] **Step 2: Write failing `sessions.rs` tests**

Use a `CustomAdapter` builder whose `custom_command` is a shell snippet, plus a recording `Emit`:
```rust
#[test] fn start_custom_session_runs_and_updates() { /* cmd "printf ok; sleep 0.2"; assert an Updated with Working, then Output containing "ok" */ }
#[test] fn immediate_nonzero_exit_goes_stuck() { /* cmd "exit 7"; wait; final state == Stuck{reason:"exited with code 7"}; attach() still returns output */ }
#[test] fn start_in_missing_workspace_errors() { /* ws.missing = true → Err */ }
#[test] fn one_session_per_builder() { /* start "sleep 5"; second start with same builder → Err */ }
#[test] fn hook_events_drive_state() {
    // agent session with ClaudeAdapter not needed: call on_hook directly on a session created with policy uses_hooks
    // (inject via a test-only constructor `start_with_spec(ws, builder, spec, adapter)`)
    // on_hook(Stop) → Finished and reached_finished; on_hook(Notification permission fixture) → NeedsYou
}
#[test] fn close_reports_xp_only_after_finished() { /* finished → earned_xp true; fresh session → false */ }
#[test] fn output_is_batched() { /* cmd "yes | head -c 2000000"; count Output events within 1s < 100; scrollback len <= SCROLLBACK_CAP */ }
#[test] fn silence_tick_finishes_plain_agent() { /* cmd "printf hi; sleep 30"; tick(now + 21s) → Finished */ }
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml git sessions`
Expected: FAIL.

- [ ] **Step 4: Implement `git.rs`, then `SessionManager`**

Use one `Mutex<HashMap<String, SessionEntry>>`. `SessionEntry` holds the info, `PtyHandle`, `Scrollback`, adapter, policy, baseline, pending output buffer and last flush time. A single background thread does the 16 ms flushes and the 1 s `tick`. `start_with_spec` is `pub(crate)` for tests.

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml git sessions`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri && git commit -m "feat(core): session manager with git review and worktree detection"
```

---

### Task 9: Tauri commands, events and quit guard

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (managed state, `tauri-plugin-dialog`, command registration, `on_window_event` close guard), `src-tauri/capabilities/default.json` (dialog permission)
- Test: unit tests in `commands.rs` for the non-Tauri logic

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces:
  - **Managed state:** `AppState { data: Mutex<AppData>, data_path: PathBuf, manager: Arc<SessionManager>, registry: AdapterRegistry }`.
  - **Commands** (camelCase on the JS side; each persists `AppData` after mutation):

| Command | Returns |
|---|---|
| `list_state()` | `{ workspaces: Workspace[], builders: Builder[], sessions: SessionInfo[] }` |
| `detect_agents()` | `{ kind, label, installed, version, models, efforts, canApprove }[]` (`canApprove` = adapter has approve/deny keys) |
| `add_workspace(path: String)` | `Workspace` (name = folder name; error if already added) |
| `create_workspace(parent: String, name: String)` | `Workspace` (creates the dir, errors if it exists, runs `git init`) |
| `remove_workspace(id)` | `()` (error if live sessions) |
| `create_builder(name, agent, model, effort, customCommand)` | `Builder` |
| `update_builder(builder)` | `()` |
| `delete_builder(id)` | `()` (error if busy) |
| `start_session(workspaceId, builderId, task)` | `SessionInfo` |
| `start_terminal(workspaceId)` | `SessionInfo` |
| `write_session(id, data: Vec<u8>)`, `resize_session(id, cols, rows)`, `approve(id)`, `deny(id)`, `stop_session(id)` | `()` |
| `close_session(id)` | `CloseOutcome` |
| `review_session(id)` | `Review` |
| `attach_session(id, onData: Channel<Vec<u8>>)` | `Vec<u8>` (snapshot; then streams `Output` for that id to the channel) |
| `detach_session(id)` | `()` |

  - **Events:** `session-updated` (payload `SessionInfo`) and `session-removed` (`{ id }`).
  - **Quit guard:** on `CloseRequested`, if `live_count() > 0`, prevent close and emit `confirm-quit` (`{ live: n }`). Command `quit_now()` kills all sessions and exits.
- Pure helpers (unit-tested):
  - `fn workspace_from_path(path: &Path, now: i64) -> anyhow::Result<Workspace>`: error if not a directory
  - `fn validate_builder_name(name: &str) -> anyhow::Result<String>`: trimmed, 1–40 characters

- [ ] **Step 1: Write failing tests**

```rust
#[test] fn workspace_name_is_folder_name() { assert_eq!(workspace_from_path(&tmp.join("my app"), 0).unwrap().name, "my app"); }
#[test] fn workspace_from_file_errors() { assert!(workspace_from_path(&file_path, 0).is_err()); }
#[test] fn builder_name_trimmed_and_bounded() { assert_eq!(validate_builder_name("  Ada ").unwrap(), "Ada"); assert!(validate_builder_name("").is_err()); assert!(validate_builder_name(&"x".repeat(41)).is_err()); }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands`
Expected: FAIL.

- [ ] **Step 3: Implement the helpers, commands, wiring and quit guard**

On startup:
1. `load` and `mark_missing`.
2. Start `HookServer` on Tauri's async runtime, with a sink that forwards to `manager.on_hook`.
3. Build `SessionManager` with an `Emit` that maps `Updated`/`Removed` to app events and `Output` to the attached channel (if any) in a `Mutex<HashMap<id, Channel>>`.

- [ ] **Step 4: Run all Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (all tests from Tasks 2–9).

- [ ] **Step 5: Commit**

```bash
git add src-tauri && git commit -m "feat(app): tauri commands, session events, quit guard"
```

---

### Task 10: Frontend IPC types and store

**Files:**
- Create: `src/api/types.ts`, `src/api/ipc.ts`, `src/state/store.ts`
- Test: `src/state/store.test.ts`

**Interfaces:**
- Consumes: Task 9's commands and events. The TS types mirror Task 2's serde shapes exactly: camelCase fields, `SessionState`/`SessionKind` as `{ kind: ... }` unions.
- Produces:
  - `ipc` object with one async function per command (same names, camelCase), plus:
    - `onSessionUpdated(cb): Promise<UnlistenFn>`
    - `onSessionRemoved(cb)`
    - `onConfirmQuit(cb)`
  - zustand `useApp` with:
    - fields: `workspaces`, `builders`, `sessions: Record<string, SessionInfo>`, `agents: AgentInfo[]`, `selectedSessionId: string | null`
    - actions:
      - `hydrate(s: ListState)`
      - `upsertSession(s: SessionInfo)`
      - `removeSession(id)`
      - `select(id | null)`
      - `setAgents(a)`
      - `addWorkspace(w)`
      - `addBuilder(b)`
      - `updateBuilder(b)`
  - Selectors:
    - `sessionsByWorkspace(state, wsId): SessionInfo[]`, sorted by `startedAt`
    - `idleBuilders(state): Builder[]`, builders with no session whose state is not Ended
    - `stateLabel(s: SessionState): 'Starting'|'Working'|'Needs you'|'Finished'|'Stuck'|'Ended'`

- [ ] **Step 1: Write failing tests**

```ts
test('upsert then remove session', () => { useApp.getState().upsertSession(sess('s1','w1')); expect(useApp.getState().sessions.s1).toBeDefined(); useApp.getState().removeSession('s1'); expect(useApp.getState().sessions.s1).toBeUndefined(); });
test('removing selected session clears selection', () => { /* select('s1'); removeSession('s1'); selectedSessionId === null */ });
test('idleBuilders excludes busy builders', () => { /* builders b1,b2; session agent b1 Working → idle == [b2]; set b1 session Ended → idle == [b1,b2] */ });
test('sessionsByWorkspace sorts by startedAt', () => { /* ... */ });
test('stateLabel maps NeedsYou', () => { expect(stateLabel({ kind: 'NeedsYou', reason: 'x' })).toBe('Needs you'); });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm test src/state`
Expected: FAIL.

- [ ] **Step 3: Implement `types.ts`, `ipc.ts` (thin `invoke`/`listen`/`Channel` wrappers) and `store.ts`**

- [ ] **Step 4: Run the tests**

Run: `pnpm test src/state`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src && git commit -m "feat(ui): typed IPC layer and app store"
```

---

### Task 11: Plain UI: sidebar, new-session form, session panel, terminal

**Files:**
- Create: `src/components/Sidebar.tsx`, `src/components/NewSessionForm.tsx`, `src/components/SessionPanel.tsx`, `src/components/TerminalView.tsx`, `src/components/NewSessionForm.test.tsx`
- Modify: `src/App.tsx` (layout + event subscriptions + hydrate), `src/App.css`, `package.json` (@xterm/xterm, @xterm/addon-webgl, @xterm/addon-fit, @tauri-apps/plugin-dialog)

**Interfaces:**
- Consumes: Task 10's `ipc` and `useApp`.
- Produces (props):
  - `<NewSessionForm workspaceId agents builders onStarted(s: SessionInfo) />`
  - `<SessionPanel sessionId />`
  - `<TerminalView sessionId />`, which on mount runs `attachSession` → `term.write(snapshot)` → streams from the channel; on unmount runs `detachSession` and disposes the terminal. Resize goes through the fit addon → `resizeSession`, and keystrokes go through `term.onData` → `writeSession`.
  - Pure helper exported from `NewSessionForm.tsx`: `commandPreview(agent: AgentInfo, model?: string, effort?: string, task?: string): string`. It mirrors the Claude args order (`claude --model opus --effort max "task"`, with `--session-id`/`--settings`/`--append-system-prompt` shown as `…`) and is display only.

**UI behavior** (plain, functional; Plan 2 restyles it):
- **Sidebar:**
  - Workspaces, each with "+ Session", "+ Terminal" and a missing badge.
  - Under each workspace, its sessions with a colored dot (Working amber, Needs you red, Finished gold, Stuck grey, Ended dim) and builder name or "Terminal".
  - Buttons: "Open folder" (dialog `open({directory:true})` → `addWorkspace`) and "New folder" (parent picker + name → `createWorkspace`).
- **New session form:**
  - Choose an idle builder, or "Recruit new" with fields: name, agent (installed agents only, from `detectAgents`), model (adapter list, or free text for Custom command), effort, and the custom command when the agent is Custom.
  - Task textarea and the live `commandPreview`.
  - Start → `createBuilder` if recruiting → `startSession`.
- **Session panel:**
  - Header: builder name, agent, model and effort, state label, steps, elapsed time.
  - Actions by state:
    - NeedsYou → Allow / Deny (hidden when the agent's `canApprove` is false; then show "Answer in the terminal below")
    - Finished → Review (lists `reviewSession` files `+a −r`, untracked files, branch, an "other sessions were active" note, and "not a git folder" when `!isGit`)
    - always → Stop and Close (Close shows "+XP earned" text when `earnedXp`, a placeholder for Plan 2)
  - The `TerminalView` fills the rest. Only the selected session's `TerminalView` is mounted.
- **Quit dialog:** on `confirm-quit`, "N sessions are still running. Quit and end them?" → `quitNow()`.

- [ ] **Step 1: Write failing tests**

```tsx
test('commandPreview for claude', () => {
  expect(commandPreview(claude, 'opus', 'max', 'fix "bug"')).toBe('claude … --model opus --effort max "fix \\"bug\\""');
});
test('commandPreview omits unset model/effort', () => { expect(commandPreview(claude, undefined, undefined, undefined)).toBe('claude …'); });
test('recruit requires a name', async () => { /* render form with no idle builders; click Start with empty name → shows "Name your builder" and ipc.startSession not called (mock ipc) */ });
test('only installed agents are offered', () => { /* agents: claude installed, custom always; codex not installed → options exclude Codex */ });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm test src/components`
Expected: FAIL.

- [ ] **Step 3: Implement the components and App layout**

Sidebar is 280px on the left; the session panel fills the rest. Subscribe to events in `App` with `useEffect`, and unlisten on cleanup.

- [ ] **Step 4: Run all frontend tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src package.json pnpm-lock.yaml && git commit -m "feat(ui): plain workspace/session UI with live terminals"
```

---

### Task 12: End-to-end verification with real Claude Code, and budgets

**Files:**
- Create: `docs/verification/plan-1-e2e.md` (filled-in checklist with observed results)
- Modify: whatever the walkthrough shows is broken (with a regression test in the owning module before each fix)

**Interfaces:**
- Consumes: the whole app.

- [ ] **Step 1: Run the app**

Run: `pnpm tauri dev`
Expected: a window with an empty sidebar.

- [ ] **Step 2: Walk the lifecycle and record each observation in `docs/verification/plan-1-e2e.md`**

1. Open folder `/tmp/coc-hooks` → the workspace appears.
2. Recruit "Ada" (Claude Code, haiku, low) with the task "Create hello2.txt containing hi using Bash" → the session goes Starting → Working within ~3 s, and the terminal shows Claude.
3. At the Bash permission prompt → the state becomes **Needs you** with the tool message → click **Allow** → back to Working.
4. Claude finishes → **Finished**; Review lists `hello2.txt` as untracked.
5. Type a follow-up in the terminal → Working → Finished.
6. Close → the session disappears, the "+XP earned" text shows, and Ada is idle (pickable again).
7. Start a session with a custom builder (`custom_command` = `exit 3`) → **Stuck** "exited with code 3", with output still visible.
8. Remove the folder on disk, restart the app → the workspace shows the missing badge, and starting a session errors clearly.
9. Start 2 sessions → quit → the confirm dialog appears; confirm → the app exits and `pgrep -f claude` shows none of its sessions.
10. In a terminal session, run `yes | head -c 50000000` → the UI stays responsive.
11. Activity Monitor: app (all its processes, excluding claude) with 10 sessions + 2 terminals open → record memory. Target ≤ 250 MB.

Expected: every item observed as described, or a fix committed with its regression test.

- [ ] **Step 3: Run the full test suites**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: plan 1 end-to-end verification"
```
