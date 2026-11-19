# Board Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With one switch in Settings, every agent session in a shared workspace appears as a live thread on the owner's Vercel Board, and builders' own board posts carry the builder's name.

**Architecture:** A new Rust module `board/` holds pure planning code (what to write for a session's state), a thin wrapper around the user's `vercel` CLI, a small JSON store, and one background worker thread that drains a per-session "newest state" map. `lib.rs` hands each session update to the worker next to notifications and the menu bar. The app only writes; it never reads the board in this project.

**Tech Stack:** Rust (Tauri 2, serde, anyhow; no new crates), React 19 + zustand + vitest, the user's `vercel` CLI (66.x or later, has `board`).

**Spec:** `docs/superpowers/specs/2026-11-20-board-link-design.md`. Read "Design" and "Spike results" before any task; the JSON shapes in "Spike results" are measured, not guessed.

## Global Constraints

- No call to `vercel` on any thread that handles agent status, permission prompts or terminal output. Only the board worker thread and the two `board_*` commands (async) run it.
- Every `vercel` call: working directory = the app's data folder, `--json`, `--name <board>`, `--scope <team>` when a team is set, and a 30 second timeout after which the child is killed.
- App status writes use `--as village`. Builders' profile names come from `board::profile_name`.
- Channel: `v/<owner>/w/<workspace-slug>`. Labels: only the `coc.*` names in the spec's table.
- Messages are cut to 10,000 characters, on a character boundary, ending in `… (cut)`.
- Parse stdout only; stderr carries non-JSON lines.
- Everything is off until `settings.board.enabled`, and per workspace until `board_shared`.
- No new third-party crates. macOS 13+. The app never edits agent configuration.
- Other agents share this working tree: commit only the files a task names, on `main`, never `git stash`.
- Checks for every task: `cargo test --manifest-path src-tauri/Cargo.toml`, `pnpm vitest run`, `pnpm exec tsc --noEmit`.

## Review Focus

1. **A builder name that makes no valid profile** (empty, emoji only, starts with a digit, longer than 32): still a legal profile. Test in Task 2.
2. **`vercel` hangs** (no network, a login prompt): the call is killed at 30 s, counted as retryable, and no session is delayed. Test in Task 3.
3. **A long or multi-byte last reply** (10,000+ characters, emoji at the cut): cut on a character boundary, never a panic. Test in Task 2.
4. **The switch is turned off, or a workspace unshared, while writes are queued**: queued state writes are dropped, open threads get one close, and nothing is posted afterwards. Test in Task 4.
5. **`board.json` is missing or corrupt**: treated as empty; sessions get roots again, and the root's idempotency key returns the existing thread instead of a second one. Test in Task 4.

---

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/board/mod.rs` (new) | Pure: slugs, profile names, labels, texts, `plan()`. Re-exports the submodules. |
| `src-tauri/src/board/cli.rs` (new) | `BoardCli` trait, `VercelCli` (runs the binary), error classification, `status()`. |
| `src-tauri/src/board/store.rs` (new) | `board.json` beside the settings: load, save, entries. |
| `src-tauri/src/board/publisher.rs` (new) | The worker thread: queue, 2 s settle, retry, launch and quit passes. |
| `src-tauri/src/model.rs` | `BoardSettings`, `Settings.board`, `Workspace.board_shared`. |
| `src-tauri/src/lib.rs`, `commands.rs`, `sessions.rs` | Wiring: fan-out, close outcome, quit, session env, two commands. |
| `src/api/types.ts`, `src/api/ipc.ts` | Types and the two commands. |
| `src/panels/TeamSettings.tsx` (new), `SettingsPage.tsx`, `WorkspacePanel.tsx` | The Team section and the workspace switch. |
| `README.md` | Team section and one Privacy line. |

---

### Task 1: Settings and workspace fields

**Files:**
- Modify: `src-tauri/src/model.rs` (`Settings`, `Workspace`), `src/api/types.ts`
- Test: `src-tauri/src/model.rs` (its tests module), `src/state/settings.test.ts`

**Interfaces:**
- Produces:
  ```rust
  #[serde(rename_all = "camelCase")]
  pub struct BoardSettings {
      pub enabled: bool,              // default false
      pub team: Option<String>,       // team slug; None = the login's default team
      pub name: String,               // default "village"
      pub share_details: bool,        // default true
      pub session_env: bool,          // default true
      pub share_new: bool,            // default false
      pub host_id: Option<String>,    // random, made the first time `enabled` becomes true
  }
  // Settings gains:  #[serde(default)] pub board: BoardSettings
  // Workspace gains: #[serde(default)] pub board_shared: bool
  ```
  TypeScript mirrors: `Settings.board: BoardSettings`, `Workspace.boardShared: boolean`.

- [ ] **Step 1: Write the failing tests.** Rust: `settings_without_board_load_with_defaults` (a settings JSON from v0.2.10 without `board` deserializes to `enabled == false`, `name == "village"`, `share_details == true`, `session_env == true`, `share_new == false`); `workspace_without_board_shared_loads_false`. TS: the default settings object used in `settings.test.ts` includes `board` with the same defaults.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml model::` and `pnpm vitest run src/state/settings.test.ts`. Expected: FAIL (unknown field / missing type).
- [ ] **Step 3: Add the struct and fields** with `impl Default for BoardSettings` giving the values above, and the TS types. Update every `Workspace { .. }` and `Settings { .. }` literal the compiler reports.
- [ ] **Step 4: Run all three checks.** Expected: PASS.
- [ ] **Step 5: Commit** `git add src-tauri/src/model.rs src/api/types.ts src/state/settings.test.ts` (plus any file the compiler made you touch) with message `Board link: settings and workspace fields`.

---

### Task 2: The pure planner

**Files:**
- Create: `src-tauri/src/board/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod board;`)
- Test: in `board/mod.rs`

**Interfaces:**
- Consumes: `model::{SessionInfo, SessionState, AgentKind, Workspace}`, `queue::{queue_reason, QueueReason}`.
- Produces:
  ```rust
  pub const MAX_TEXT: usize = 10_000;
  pub const STATUS_PROFILE: &str = "village";

  pub fn slug(s: &str) -> String;                    // lower case, [a-z0-9-], runs of others -> one '-', trimmed; "x" if empty
  pub fn profile_name(builder: &str) -> String;      // slug, "builder-" in front unless it starts with a letter, cut to 32
  pub fn workspace_slugs(ws: &[Workspace]) -> HashMap<String, String>; // id -> slug; clashes get "-<first 6 of id>"
  pub fn channel(owner: &str, ws_slug: &str) -> String;                // "v/{owner}/w/{slug}"
  pub fn cut(text: &str) -> String;                  // at most MAX_TEXT chars, "… (cut)" when cut

  #[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
  #[serde(rename_all = "snake_case")]
  pub enum Wire { Starting, Working, NeedsYou, Finished, Stuck, Paused, Closed }
  #[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
  #[serde(rename_all = "snake_case")]
  pub enum Wait { Decide, Answer, Review, Stuck }
  #[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
  #[serde(rename_all = "snake_case")]
  pub enum Outcome { Accepted, Discarded }

  /// What the board last got for a session (stored in board.json).
  #[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
  pub struct Published {
      pub board: String,            // "<team or empty>/<board name>"
      pub channel: String,
      pub root: Option<String>,     // message id once posted
      pub state: Wire,
      pub wait: Option<Wait>,
      pub since: i64,
      pub titled: bool,             // the root was edited to lead with the agent's title
      pub unshared: bool,
  }

  pub enum Now<'a> { Live(&'a SessionInfo), Paused, Closed(Option<Outcome>) }

  pub struct Ctx<'a> {
      pub builder: &'a str,         // display name
      pub agent: AgentKind,
      pub channel: &'a str,
      pub board: &'a str,
      pub host_id: &'a str,
      pub share_details: bool,
      pub files: &'a [String],      // changed files, used only when entering Finished
  }

  #[derive(Clone, PartialEq, Debug)]
  pub enum Write {
      PostRoot { channel: String, text: String, labels: Vec<(String, String)>, key: String },
      Reply { text: String, labels: Vec<(String, String)>, key: String },
      Label { set: Vec<(String, String)>, unset: Vec<String> },
      EditRoot { text: String },
  }

  /// The writes that take the board from `prev` to `now`, and the record to store once they succeed.
  pub fn plan(session_id: &str, prev: Option<&Published>, now: Now<'_>, ctx: &Ctx<'_>) -> (Vec<Write>, Published);
  ```
- Rules `plan` must follow (spec, Design 1 and 2):
  - `Wire` from a live session: `Starting`/`Working` map directly; `NeedsYou`, `Finished`, `Stuck` map directly; `Ended` with `paused` is `Paused`; any other `Ended` is `Stuck`. `Wait` is `queue::queue_reason` mapped one to one, `None` when it returns `None`.
  - No `prev` (or `prev.root == None`): one `PostRoot` with key `coc-<session>-root`, all root labels (`coc.kind=session`, `coc.state`, `coc.wait` when set, `coc.agent`, `coc.builder` = `profile_name`, `coc.host`, `coc.session`, `coc.since`), then the reply for the current state if it has one.
  - Same state, wait and since as `prev`: no writes (except the one-time `EditRoot` when `info.title` is set and `!prev.titled`).
  - Otherwise one `Label` (`set` the changed `coc.state`/`coc.since`/`coc.wait`; `unset` `coc.wait` when it goes away), plus a `Reply` when entering Decide, Answer, Finished or Stuck, key `coc-<session>-<since>-<wait>`, label `coc.since`.
  - `Closed(outcome)`: `Label` with `coc.state=closed` and `coc.outcome` when given; unset `coc.wait`.
  - `prev.unshared` and `now` is `Live`: treat as a state change (labels set afresh), never a `PostRoot`.
  - Texts. Root: `**<builder>** (<agent name>): <task or "No task given">`; with `share_details == false`: `**<builder>** (<agent name>)`. Replies with details: `Wants a decision: \`<asking>\``; each question followed by its options numbered from 1, or `NeedsYou.reason` when there are no questions; `Finished.` + the last reply + `Changed: a, b, …` (20 names, then `and N more`); `Stuck: <reason>`. Without details: `Wants a decision`, `Asking you`, `Finished`, `Stuck`. Every text passes through `cut`.

- [ ] **Step 1: Write the failing tests** (one `#[test]` each):
  - `slug_and_profile_names`: `profile_name("Wizard") == "wizard"`, `profile_name("") == "builder-x"`, `profile_name("🧙") == "builder-x"`, `profile_name("9 Lives") == "builder-9-lives"`, a 60-letter name gives 32 characters, every result matches `^[a-z][a-z0-9-]{0,31}$`.
  - `workspace_slugs_separate_clashes`: two workspaces named "API" get different slugs, each still starting with `api`.
  - `cut_respects_char_boundaries`: 10,050 "é" gives exactly 10,000 chars ending in `… (cut)`; a 10-char string is unchanged.
  - `first_sight_posts_a_root_with_all_labels` (key `coc-s1-root`, channel from `ctx`).
  - `working_to_decide_labels_and_replies` (reply text ``Wants a decision: `Bash: npm test` ``, key `coc-s1-<since>-decide`).
  - `questions_list_their_options_numbered`.
  - `finished_lists_twenty_files_then_counts_the_rest` (25 files: 20 names and `and 5 more`).
  - `back_to_working_unsets_wait_and_does_not_reply`.
  - `no_change_no_writes`.
  - `title_edits_the_root_once`.
  - `without_details_nothing_of_the_task_appears` (assert no write's text contains the task, the tool call or a file name).
  - `closed_sets_outcome`, `paused_on_quit`.
  - `resharing_reuses_the_root` (`prev.unshared == true` gives a `Label`, no `PostRoot`, and the returned record has `unshared == false`).
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml board::`. Expected: FAIL to compile.
- [ ] **Step 3: Implement** the items above in `board/mod.rs`.
- [ ] **Step 4: Run** the same command. Expected: all PASS.
- [ ] **Step 5: Commit** `src-tauri/src/board/mod.rs src-tauri/src/lib.rs`: `Board link: plan what a session's state writes to the board`.

---

### Task 3: The CLI wrapper

**Files:**
- Create: `src-tauri/src/board/cli.rs`
- Test: in `board/cli.rs`

**Interfaces:**
- Consumes: `platform::which`, `board::Write`, `board::STATUS_PROFILE`.
- Produces:
  ```rust
  #[derive(Debug, Clone, PartialEq)]
  pub enum CliError {
      Missing,                 // no `vercel` on PATH
      NoBoard,                 // `vercel` has no `board` command
      SignedOut(String),       // stop until Check again
      Retryable(String),       // network, timeout, `retryable: true`
      Fatal(String),           // this write can never succeed; drop it
  }
  pub trait BoardCli: Send + Sync {
      /// Runs `vercel <args>` and returns stdout parsed as JSON.
      fn run(&self, args: &[String]) -> Result<serde_json::Value, CliError>;
  }
  pub struct VercelCli { pub cwd: PathBuf, pub timeout: Duration }   // timeout 30 s in the app
  impl BoardCli for VercelCli { … }

  pub struct Target { pub team: Option<String>, pub name: String }
  pub fn args_for(w: &Write, root: Option<&str>, t: &Target) -> Vec<String>;
  pub fn classify(exit_ok: bool, stdout: &str) -> Result<serde_json::Value, CliError>;
  pub fn message_id(v: &serde_json::Value) -> Option<String>;        // v["message"]["id"]

  #[derive(Clone, Debug, Serialize, PartialEq, Default)]
  #[serde(rename_all = "camelCase")]
  pub struct BoardStatus {
      pub state: String,        // "off" | "noCli" | "oldCli" | "signedOut" | "ready" | "error"
      pub handle: Option<String>,
      pub board_url: Option<String>,
      pub teams: Vec<String>,   // slugs; empty when they could not be listed
      pub last_error: Option<String>,
      pub last_write_at: Option<i64>,
  }
  pub fn status(cli: &dyn BoardCli, t: &Target) -> BoardStatus;
  ```
- `args_for`: `PostRoot` → `board post <channel> <text> --label k=v … --idempotency-key <key>`; `Reply` → `board reply <root> <text> --label … --idempotency-key <key>`; `Label` → `board label <root> k=v … --unset k …`; `EditRoot` → `board edit <root> <text>`. All end with `--as village --json --name <name>`, plus `--scope <team>` when set; `PostRoot` also gets `--ensure`.
- `classify`: exit ok and stdout is JSON → `Ok`. JSON with `"status":"error"`: `retryable == true` → `Retryable(message)`; `data.error.status` 401 or `reason` containing `auth` or `login` → `SignedOut(message)`; anything else → `Fatal(message)`. Stdout that is not JSON → `Retryable`.
- `VercelCli::run`: `Missing` when `platform::which("vercel")` is `None`; spawn with `cwd`, read stdout, kill at `timeout` → `Retryable("timed out")`. Polling `try_wait` on a helper thread is enough; no async.
- `status`: `vercel board --help` failing or printing the deploy help (no line containing `board`) → `oldCli`; then `vercel board whoami --json --name <name> --ensure` gives `handle` and `board`; `vercel teams ls` output is parsed for the first column of each data row (best effort, empty on any surprise).

- [ ] **Step 1: Write the failing tests:**
  - `args_for_each_write` (exact vectors for the four writes, with and without a team).
  - `classify_success_and_the_measured_errors`, using these two documents from the spike verbatim: the `permission_denied` / `message_not_owned` one (`Fatal`) and the `not_supported` 501 one (`Fatal`); plus `{"status":"error","reason":"x","message":"m","retryable":true}` (`Retryable`), `{"status":"error","reason":"not_authenticated","message":"m"}` (`SignedOut`), and `"<html>"` (`Retryable`).
  - `message_id_reads_the_post_shape` with the spike's `post` output.
  - `a_hanging_child_is_killed_at_the_timeout`: a `VercelCli`-like runner pointed at `/bin/sleep 5` with a 300 ms timeout returns `Retryable` in under 2 s. (Give `VercelCli` a `program: PathBuf` field so the test can point it at `sleep`; the app sets it from `which`.)
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml board::cli`. Expected: FAIL to compile.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `src-tauri/src/board/cli.rs src-tauri/src/board/mod.rs`: `Board link: run the vercel CLI and read its answers`.

---

### Task 4: Store and worker

**Files:**
- Create: `src-tauri/src/board/store.rs`, `src-tauri/src/board/publisher.rs`
- Test: in both files

**Interfaces:**
- Consumes: everything from Tasks 2 and 3.
- Produces:
  ```rust
  // store.rs
  #[derive(Default, Serialize, Deserialize)]
  pub struct Store { pub sessions: BTreeMap<String, Published> }
  impl Store {
      pub fn load(path: &Path) -> Store;                 // missing or unreadable -> empty
      pub fn save(&self, path: &Path) -> anyhow::Result<()>;   // write to a temp file, then rename
  }

  // publisher.rs
  pub struct Config {
      pub enabled: bool,
      pub target: Target,
      pub owner: String,                // whoami handle
      pub host_id: String,
      pub share_details: bool,
  }
  pub struct SessionView {              // what lib.rs knows about a session, gathered off the worker
      pub info: SessionInfo,
      pub builder: String,
      pub agent: AgentKind,
      pub channel: Option<String>,      // None: its workspace is not shared
  }
  pub struct Publisher { /* private */ }
  impl Publisher {
      pub fn start(cli: Arc<dyn BoardCli>, store_path: PathBuf,
                   files: Arc<dyn Fn(&str) -> Vec<String> + Send + Sync>,
                   now_ms: Arc<dyn Fn() -> i64 + Send + Sync>) -> Arc<Publisher>;
      pub fn configure(&self, cfg: Config);              // settings or sharing changed
      pub fn update(&self, view: SessionView);           // never blocks, never calls the CLI
      pub fn closed(&self, session_id: &str, outcome: Option<Outcome>);
      pub fn pause_all(&self, wait: Duration);           // quit: mark live threads paused, wait at most this long
      pub fn status(&self) -> (Option<String>, Option<i64>);   // last error, last write time
      pub fn stopped_reason(&self) -> Option<CliError>;  // Missing / NoBoard / SignedOut
      pub fn check_again(&self);                         // clears a stop
  }
  pub const SETTLE_MS: i64 = 2_000;
  ```
- Worker behaviour:
  - Holds `pending: HashMap<session_id, (SessionView or Closed/Paused, arrived_at_ms)>`. `update` replaces the entry. A live state is published once it is `SETTLE_MS` old; `closed` and paused are published at once.
  - For each due entry: `plan` against the store's record, run the writes in order with `args_for`, take the root id from the `PostRoot` answer, save the store after the entry succeeds. A closed entry is removed from the store after its write.
  - `Retryable`: keep the entry, wait 2 s doubling to 300 s (reset on any success); newer updates for that session replace it meanwhile. `Fatal`: drop the entry, record the error. `Missing`, `NoBoard`, `SignedOut`: stop calling until `check_again`.
  - `configure` with `enabled == false`, or an `update` whose `channel` is `None` for a session with a record: publish one close (no outcome), set `unshared = true` on the record if the session is still alive, and drop queued state writes for it. A changed `target` or `owner`: close every record on the old target first (best effort, one attempt), then clear the store.
  - First `configure` after `start` (launch): every stored session that gets no `update` within 5 s is published as `Closed(None)` and removed; sessions that do report are published as they are (paused ones are `Ended` + `paused`).
  - `Finished` entries call `files(session_id)` on the worker thread just before planning.

- [ ] **Step 1: Write the failing tests** with a `FakeCli` that records `args` and returns scripted answers, and a settable clock:
  - `store_round_trips_and_survives_garbage` (a file holding `not json` loads as empty).
  - `update_returns_at_once_and_writes_later` (`update` returns with zero CLI calls recorded; after the clock passes `SETTLE_MS` there is one `post`).
  - `a_flicker_writes_once`: Working, NeedsYou, Working within 1 s gives exactly one label write for the settled state and no reply.
  - `retry_keeps_only_the_newest`: first call `Retryable`, two more updates arrive, next attempt sends one plan for the newest state.
  - `fatal_drops_the_write_and_records_the_error`.
  - `signed_out_stops_until_check_again`.
  - `turning_off_closes_once_and_posts_nothing_after` (Review Focus 4).
  - `a_lost_store_reuses_the_thread` (Review Focus 5): empty store, `FakeCli` answers the root post with an existing id; the record stores that id and later writes address it.
  - `changing_the_board_closes_old_threads_then_starts_fresh`.
  - `launch_closes_threads_whose_session_is_gone`.
  - `pause_all_marks_live_threads_paused`.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml board::`. Expected: FAIL to compile.
- [ ] **Step 3: Implement** `store.rs`, then `publisher.rs` (one `std::thread`, a `Mutex` + `Condvar` for the pending map; tests drive a `step()` function directly instead of sleeping).
- [ ] **Step 4: Run** again. Expected: PASS, and the whole Rust suite still passes.
- [ ] **Step 5: Commit** the two files and `board/mod.rs`: `Board link: the worker that publishes session states`.

---

### Task 5: Wire it into the app

**Files:**
- Modify: `src-tauri/src/lib.rs` (setup, the `ManagerEvent::Updated` / `Removed` arms near line 296), `src-tauri/src/commands.rs` (`close_session`, `set_settings`, `add_workspace`, `quit_now`, new commands), `src-tauri/src/sessions.rs` (session environment), `src/api/ipc.ts`
- Test: `src-tauri/src/sessions.rs` tests, `src/api/ipc.test.ts`

**Interfaces:**
- Consumes: `Publisher`, `Config`, `SessionView`, `cli::status`, `board::{workspace_slugs, channel, profile_name}`.
- Produces:
  ```rust
  // sessions.rs
  pub type EnvHook = Arc<dyn Fn(&Workspace, &Builder) -> Vec<(String, String)> + Send + Sync>;
  impl SessionManager { pub fn set_env_hook(&self, hook: Option<EnvHook>); }
  // commands.rs
  #[tauri::command] pub async fn board_status(…) -> Result<BoardStatus, String>;   // runs cli::status off the main thread
  #[tauri::command] pub async fn board_check(…) -> Result<BoardStatus, String>;    // Publisher::check_again, then status
  #[tauri::command] pub fn set_workspace_shared(workspace_id: String, shared: bool, …) -> Result<Workspace, String>;
  ```
  `ipc.ts`: `boardStatus()`, `boardCheck()`, `setWorkspaceShared(id, shared)`.
- Wiring rules:
  - `lib.rs` setup: build `VercelCli { program, cwd: data folder, timeout: 30 s }`, start the `Publisher` with `files` = names from `manager.review(id)` (empty on error) and manage it as Tauri state (`BoardState`).
  - A helper `fn board_config(data: &AppData, owner: &str) -> Config` and `fn session_view(data: &AppData, owner: &str, info: &SessionInfo) -> Option<SessionView>` (agents only; `None` for terminals) live in `lib.rs`. `owner` is cached in `BoardState` from the last successful `status`.
  - `ManagerEvent::Updated`: after the existing notification code, `publisher.update(view)` when the feature is on and the session is an agent. This is a map insert; nothing else may be added to this arm.
  - `close_session` command: `publisher.closed(id, Some(Accepted or Discarded))` (discard flag → `Discarded`). `ManagerEvent::Removed`: `publisher.closed(id, None)`; the publisher ignores a second close for the same session.
  - `set_settings`: when `board.enabled` turns on and `host_id` is `None`, set a random one (16 hex characters; use the same randomness source `usage.rs` uses for `install_id`). Then `publisher.configure(…)` and install or clear the env hook.
  - `add_workspace` / `create_workspace`: `board_shared = settings.board.share_new`.
  - `quit_now`: `publisher.pause_all(Duration::from_secs(3))` before `manager.shutdown`.
  - Env hook (only while `enabled && session_env`): for a workspace with `board_shared`, return `BOARD_PROFILE=<profile_name(builder.name)>` and `BOARD_URL=<cached board url>`; otherwise empty. `SessionManager` appends the hook's pairs to the `LaunchSpec.env` of every agent launch: `start_agent`, `resume`, `continue_conversation`. Terminals get nothing.

- [ ] **Step 1: Write the failing tests.** `sessions.rs`: `env_hook_reaches_agent_sessions_and_not_terminals` (with the existing test fixture and a hook returning `("BOARD_PROFILE","wizard")`, an agent session started with a `/bin/sh -c 'echo $BOARD_PROFILE'` custom agent prints `wizard`; a terminal's environment lacks it), and `env_hook_applies_on_resume`. `ipc.test.ts`: the three new wrappers call `invoke` with `board_status`, `board_check`, and `set_workspace_shared` with `{ workspaceId, shared }`.
- [ ] **Step 2: Run** the Rust and vitest suites. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the wiring above; register the three commands in `lib.rs`'s `invoke_handler`.
- [ ] **Step 4: Run** all three checks. Expected: PASS.
- [ ] **Step 5: Commit** the files listed: `Board link: publish sessions and name builders on the board`.

---

### Task 6: Settings and workspace UI

**Files:**
- Create: `src/panels/TeamSettings.tsx`, `src/panels/TeamSettings.test.tsx`
- Modify: `src/panels/SettingsPage.tsx` (a new `<section className="set-card" aria-label="Team">` after "Notifications"), `src/panels/WorkspacePanel.tsx`, `src/panels/panels.test.tsx` if it lists settings sections

**Interfaces:**
- Consumes: `boardStatus`, `boardCheck`, `setWorkspaceShared`, `Settings.board`, `Workspace.boardShared`, the existing settings setter used by the other sections.
- Produces: `<TeamSettings settings={…} onChange={(board: BoardSettings) => void} />`.
- Copy (exact):
  - Section title: `Team (Vercel Board)`.
  - Switch: `Connect this village to Vercel Board`. Under it while off: `Shows your shared workspaces' builders to your Vercel team. Off until you turn it on.`
  - Status by `state`: `ready` → `Signed in as {handle} · board {name}`; `noCli` → `The Vercel CLI is not installed.` with copyable `npm i -g vercel` and `vercel login`; `oldCli` → `This Vercel CLI has no board command. Update it:` with copyable `npm i -g vercel@latest`; `signedOut` → `Not signed in to Vercel.` with copyable `vercel login`; `error` → the `lastError` text. All non-ready states show a `Check again` button.
  - Fields while on: `Team` (a select of `teams` plus `Default team`; a text field when `teams` is empty), `Board name`, switches `Share details (tasks, tool calls, replies, file names)`, `Builders write under their own name`, `Share new workspaces`.
  - Footer line when `lastWriteAt` is set: `Last written {relative time}`; when `lastError` is set: `Last problem: {lastError}`.
  - Workspace panel, only while `settings.board.enabled`: switch `Share on the team board`, and under it the channel `v/{handle}/w/{slug}` once the status is known.
- The copyable command rows reuse the component the Town Hall's install steps use (`TownHallPanel.tsx` / `AgentSetupDialog.tsx`).

- [ ] **Step 1: Write the failing tests** (`TeamSettings.test.tsx`, mocking the ipc module): `off_shows_only_the_switch`; `turning_it_on_calls_onChange_with_enabled_true`; one test per status state asserting the exact text and commands above; `check_again_calls_boardCheck`; `changing_the_board_name_calls_onChange`. In the workspace panel's tests: `share_switch_is_hidden_while_the_feature_is_off` and `share_switch_calls_setWorkspaceShared`.
- [ ] **Step 2: Run** `pnpm vitest run src/panels`. Expected: FAIL.
- [ ] **Step 3: Implement** the component and the two insertions. The status is fetched when the section mounts and after each change to `enabled`, `team` or `name`.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** the files listed: `Settings: Team (Vercel Board) and a share switch per workspace`.

---

### Task 7: README and a run against a real board

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a `## Team (Vercel Board)` section** after "Menu bar and mini village": what the switch does, that it needs the Vercel CLI with the `board` command and a `vercel login`, the channel layout (`v/<you>/w/<workspace>`), what "Share details" includes, that builders post under their own name, and that this release only publishes (answering from a phone and team villages come later).
- [ ] **Step 2: In `## Privacy`,** change "except these three" to "except these" and add one bullet: `**Vercel Board, only if you turn it on** (Settings › Team): for each workspace you share, the state of its agent sessions and, with Share details on, their tasks, tool calls, the agent's last reply and changed file names go to your Vercel team's board through your own vercel CLI. Board stores them in the United States, and your Vercel team can read them.`
- [ ] **Step 3: Run it for real** with `pnpm app` and a board named `coc-spike` (already exists from the spike): share one workspace, start a Claude Code session with a task, let it ask for a permission, allow it, let it finish, accept it. After each step run `npx vercel@latest board read v/<handle>/w/<slug> --name coc-spike` and confirm the thread shows the state within about 5 seconds, with one root only.
- [ ] **Step 4: Quit with a session alive** and confirm `coc.state=paused`; relaunch and resume, confirm it returns to working on the same thread. Sign out (`vercel logout`) mid-session: the session keeps working and Settings › Team says `Not signed in to Vercel.`
- [ ] **Step 5: Record** what Step 3 and 4 showed (pass or what differed) under a new "Built" note at the top of the spec, as `2026-11-19-menu-bar-village-design.md` does.
- [ ] **Step 6: Commit** `README.md` and the spec: `README: Team (Vercel Board)`.
