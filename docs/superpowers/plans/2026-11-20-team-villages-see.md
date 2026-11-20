# Team Villages, part 1 (See) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A village can be closed to the team, its owner can invite teammates by email, and an invited teammate sees it in their own Mac app: a row of villages with waiting counts, and a read-only visit drawn as the owner laid it out.

**Architecture:** The owner's Mac sets Vercel Board grants through the `vercel` CLI and publishes one owner-written snapshot (layout, builders, session states, heartbeat) in `v/<owner>/village`. A visitor's Mac lists the channels it can read, reads each village's snapshot, keeps them in a visits store fed live by the listener (now following `v/` whenever Board link is on), and the canvas draws a visited village by swapping its input for one built from the snapshot.

**Tech Stack:** Rust (Tauri 2), the user's `vercel` CLI, React + the existing canvas scene.

**Spec:** `docs/superpowers/specs/2026-11-20-team-villages-design.md`, sections 1 to 4 and 6. Section 5 (Act) is the next plan. Builds on `2026-11-20-board-link-design.md` and `2026-11-20-web-remote-design.md`.

## Global Constraints

- Work and commit on `main`. Other agents share the tree: no stash, no `checkout -- file`, no `reset --hard`; stage only this plan's files and hunks.
- No board call on a session's path. Every CLI call runs on a background thread.
- The Mac reaches the board only through the user's `vercel` CLI.
- What is shown or counted comes from the **text of a message written by that village's owner** (`principal` starts `vercel:user:` and the handle is `<owner>` or `<owner>/…`), never from a label.
- Grants: the owner `all` on `v/<owner>/`; everyone `none` on `v/<owner>/`; the remote's project `read,post,label` on `v/<owner>/` (production), only when the phone remote is set up. An invite: `read` on `v/<owner>/village` and on `v/<owner>/w/` (all) or each `v/<owner>/w/<slug>`; Helper and Trusted also `post` on those workspace patterns and on `v/<owner>/pair`. Never `label`, never `v/<owner>/remote`.
- Order when closing: the owner's grant first, then the remote's, then everyone-none. When opening: everyone-none first. Never pass `--lock-me-out`.
- Snapshot: channel `v/<owner>/village`, one root labelled `coc.kind=village-map`, `coc.host`; text JSON `{ v:1, host, owner, name, seen, workspaces, builders, sessions, mates }`; edited at most every 10 s on change and every 5 min for `seen`; under 10,000 characters (oldest finished sessions dropped first).
- Times: visits list refresh 5 min; grants re-check 5 min; a village is "away" when `seen` is older than 12 min.
- Off unless Board link is on. Private village defaults on at first connect.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Tests: `cd src-tauri && cargo test --lib`; `pnpm vitest run`; `pnpm tsc --noEmit`.

## Review Focus

1. A teammate (or a Helper later) relabels or posts in a village channel: a snapshot not written by the channel's owner, or a second "snapshot" root, must never be drawn or counted.
2. Closing the village when the phone remote is set up, when it is not, and when a step fails halfway: the owner is never locked out, and the state shown is what `grants explain` says.
3. A regular member (the board refuses to close): the switch stays read-only with the command; nothing is half-applied.
4. An invite removed while its village is on screen; a village whose owner's Mac is off; a snapshot that is not JSON or is another version.
5. The visits refresh on a board with many villages: one call for the list and one per village, never per workspace.

---

### Task 1: Access rules (pure)

**Files:** Create `src-tauri/src/board/access.rs`, `access_tests.rs`; modify `board/mod.rs`, `model.rs`.

**Produces:**
```rust
// model.rs, in BoardSettings (serde default, camelCase)
pub struct AccessSettings { pub private: bool, pub grants: Vec<String> /*ids this Mac made to close it*/, pub invites: Vec<Invite>, pub asked: bool /*the default was applied once*/ }
pub struct Invite { pub email: String, pub level: Level, pub workspaces: Option<Vec<String>> /*workspace ids; None = all shared*/, pub grant: Option<String>, pub user_id: Option<String> }
pub enum Level { Visitor, Helper, Trusted }   // serde lowercase
// access.rs
pub enum Who { User(String /*email*/), Project(String), Everyone }
pub struct GrantSpec { pub who: Who, pub can: Vec<(String /*pattern*/, Vec<&'static str> /*perms; empty = none*/)> }
pub fn closing(owner: &str, email: &str, remote: bool) -> Vec<GrantSpec>;            // in the safe order
pub fn invite_spec(owner: &str, inv: &Invite, slugs: &BTreeMap<String,String>) -> GrantSpec;
pub fn create_args(g: &GrantSpec, t: &Target) -> Vec<String>;                         // board grants create …
pub fn update_args(id: &str, g: &GrantSpec, t: &Target) -> Vec<String>;               // board grants update <id> --can … (replaces)
pub fn revoke_args(id: &str, t: &Target) -> Vec<String>;
pub struct Grant { pub id: String, pub user_id: Option<String>, pub email: Option<String>, pub project: Option<String>, pub everyone: bool, pub can: BTreeMap<String, Vec<String>> }
pub fn parse_grants(v: &Value) -> Vec<Grant>;                                         // `grants list --json`
pub enum Seen { Closed, Open, Unknown }
pub fn village_state(grants: &[Grant], owner: &str) -> Seen;                          // closed: an everyone grant with no perms at v/<owner>/
pub fn who_can_see(grants: &[Grant], owner: &str, me: &str /*user id*/) -> Vec<String>; // lines for Settings
pub fn drift(settings: &AccessSettings, grants: &[Grant], owner: &str) -> Option<String>; // what differs from what the owner set
```
- [ ] Tests (recorded shapes from the design's spike): `closing_names_the_owner_first_and_everyone_last`; `closing_adds_the_remote_only_when_set_up`; `an_invite_reads_the_map_and_its_workspaces` (all → `v/ada/w/`; some → each slug; a workspace no longer shared is left out); `helper_and_trusted_also_post_and_never_label_or_touch_remote`; `create_update_and_revoke_args` (`--user e`, `-p village-remote`, `--everyone`, `--can 'v/ada/=none'`, repeated `--can`, `--json --name … [--scope …]`); `parse_grants_reads_the_recorded_list`; `village_state_closed_open`; `who_can_see_names_people_remote_and_team`; `drift_notices_an_opened_village_and_a_missing_invite`.
- [ ] RED, implement, GREEN. Commit: "Team villages: access rules".

### Task 2: The snapshot (pure)

**Files:** Create `src-tauri/src/board/snapshot.rs`, `snapshot_tests.rs`.

**Produces:**
```rust
pub struct Snapshot { pub v: u8, pub host: String, pub owner: String, pub name: Option<String>, pub seen: i64,
  pub workspaces: Vec<MapWorkspace /*slug,name,level,color,compound*/>, pub builders: Vec<MapBuilder /*profile,name,agent*/>,
  pub sessions: Vec<MapSession /*id,root,workspace,builder,state,wait,since,started,spot,steps*/>, pub mates: Vec<MapMate /*key,handle,level*/> }
pub fn build(data: &AppData, owner: &str, host: &str, sessions: &[SessionInfo], roots: &dyn Fn(&str)->Option<String>, now: i64) -> Snapshot;
pub fn text(s: &Snapshot) -> String;                 // JSON, <= 10_000 chars: drops oldest finished sessions first
pub fn same_but_seen(a: &Snapshot, b: &Snapshot) -> bool;
pub fn parse(text: &str) -> Option<Snapshot>;        // v == 1 only
```
- [ ] Tests: `only_shared_workspaces_and_their_agent_sessions`; `no_paths_notes_or_tasks` (the JSON has none of the workspace's path, notes, a session's task); `sessions_carry_state_wait_spot_and_root`; `forty_workspaces_and_sixty_sessions_fit` and `the_oldest_finished_go_first_when_it_does_not`; `parse_refuses_other_versions_and_garbage`; `same_but_seen`.
- [ ] RED, implement, GREEN. Commit: "Team villages: the village snapshot".

### Task 3: Publish the snapshot; listen whenever Board link is on

**Files:** Modify `board/app.rs`, `board/remote_app.rs` (the village heartbeat moves), `board/listen.rs`, `lib.rs`; create `board/map.rs` (+ tests).

**Produces:**
```rust
// map.rs: decides when the snapshot is written; no I/O
pub struct MapWriter; impl MapWriter { pub fn tick(&mut self, snap: Snapshot, now: i64) -> Option<MsgWrite>; pub fn posted(&mut self, id: Option<String>); pub fn reset(&mut self); }
// listen.rs: Following { target, owner } follows `v/` (not v/<owner>/); cursor keyed by board only
```
- [ ] Tests: `the_first_tick_posts_the_root_and_later_ones_edit_it`; `a_change_is_written_at_most_every_ten_seconds`; `seen_is_refreshed_every_five_minutes_without_a_change`; `another_board_starts_a_new_root`; `tail_args_follow_the_whole_village_tree` (`board tail v/ …`); in `app.rs` tests: the listener is configured when Board link is ready even with the remote off, and the remote still takes nothing while its switch is off.
- [ ] RED, implement (a 1 s tick thread already exists for the remote: it builds the snapshot from `AppData` + `manager.list()` + `publisher.session_for_root` reverse lookup and calls `MapWriter::tick`), GREEN. Commit: "Team villages: publish the village's map; listen with Board link".

### Task 4: The visits store

**Files:** Create `src-tauri/src/board/visits.rs`, `visits_tests.rs`; modify `board/app.rs`, `lib.rs`, `src/api/{types,ipc}.ts`.

**Produces:**
```rust
pub struct Visit { pub owner: String, pub snapshot: Snapshot, pub read_at: i64 }
pub struct Visits; impl Visits {
  pub fn load(path) -> Visits; 
  pub fn refresh(&mut self, cli: &dyn BoardCli, t: &Target, me: &str, now: i64) -> Result<(), CliError>;  // channels list, then one read per v/<them>/village
  pub fn on_event(&mut self, e: &Event, now: i64) -> bool;      // an owner-written map posted or edited; true when something changed
  pub fn list(&self) -> Vec<VisitView /*owner,name,waiting,away,seen*/>; pub fn get(&self, owner: &str) -> Option<&Visit>; }
pub fn owners_of(channels: &[String], me: &str) -> Vec<String>;   // owners with a readable v/<them>/village, not me
#[tauri::command] visits() -> Vec<VisitView>; visit(owner) -> Option<Snapshot>; visits_refresh(); visit_builder(owner, root) -> Option<VisitedBuilder /*task line, prose, question, options, wait*/>
```
Emits `visits-changed`. Refreshed at connect, every 5 minutes and on command.
- [ ] Tests: `owners_are_those_whose_map_channel_is_listed`; `refresh_makes_one_call_per_village` (fake CLI counts calls: 1 + villages); `a_map_not_written_by_its_channels_owner_is_ignored` (a teammate's root in `v/ada/village`; a project's; an unverified one); `the_newest_owner_map_wins_when_there_are_two_roots`; `a_village_no_longer_listed_is_dropped`; `an_edit_heard_on_the_tail_updates_the_visit`; `waiting_counts_needs_you_stuck_and_finished`; `away_after_twelve_minutes`; `it_survives_a_restart` (file); `a_visited_builders_words_come_from_owner_written_replies`.
- [ ] RED, implement, GREEN. Commit: "Team villages: the villages you can visit".

### Task 5: Privacy and invites in the app

**Files:** Create `src-tauri/src/board/access_app.rs` (+ tests with a fake CLI); modify `board/app.rs`, `lib.rs`, `commands.rs` (`set_settings` keeps `access` as the app's own), `src/api/{types,ipc}.ts`.

**Produces:** `AccessStatus { state: closed|open|unknown, can_close: bool, command: Option<String> /*for an owner to run*/, who: Vec<String>, drift: Option<String>, invites: Vec<InviteView> }`; commands `access_status`, `access_set_private(on)`, `access_put_back`, `invite_add(email, level, workspaces)`, `invite_update(email, level, workspaces)`, `invite_remove(email)`. Each runs the CLI on a blocking worker, then reads `grants list` and returns the status. A refusal with the board's "owner only" error sets `can_close = false` and fills `command`. The first connect applies the default once (`asked`).
- [ ] Tests: `closing_runs_the_three_creates_in_order_and_keeps_their_ids`; `a_refusal_on_the_last_step_revokes_what_was_made_and_says_owner_only`; `opening_revokes_everyone_first`; `adding_an_invite_creates_its_grant_and_keeps_the_user_id`; `changing_and_removing_an_invite`; `put_back_recloses_and_recreates_missing_invites`; `set_settings_cannot_change_access` (in `commands.rs` terms: a pure helper `keep_app_owned(old, new)`).
- [ ] RED, implement, GREEN. Commit: "Team villages: private village and invites".

### Task 6: Settings › Team: Private village and People

**Files:** Create `src/panels/AccessSettings.tsx` + test; modify `TeamSettings.tsx`, `panels.css`.

- [ ] Tests: the switch shows closed/open from status, not from the click; "who can see this village now" lists the lines; not an owner → read-only switch, the message and the command with Copy; drift → warning with **Put it back**; People: add by email with level and "all shared workspaces" or a choice, rows with level select and Remove, an error from the board shown at the row; a Helper or Trusted row not yet paired says "A Visitor until their Mac is paired".
- [ ] RED, implement, GREEN (`pnpm vitest run`, `tsc`). Commit: "Settings: Private village and People".

### Task 7: The people row and visiting

**Files:** Create `src/hud/PeopleRow.tsx` + test, `src/state/visits.ts` + test (snapshot → `VillageInput`), `src/panels/VisitedBuilder.tsx` + test; modify `src/state/store.ts` (`visits`, `visiting`), `src/village/VillageCanvas.tsx` (input swap, no moving while visiting), `src/App.tsx`, `App.css`.

**Produces:** `visitInput(snapshot: Snapshot): VillageInput` (workspaces with `id = slug`, sessions with `workspaceId = slug`, `kind.builderId = profile`, state from the snapshot, `spot`; builders with `id = profile`; `ownerName`); store `visiting: string | null`, `setVisiting`; the canvas uses `visitInput` while visiting and refuses moves and builder assignment.
- [ ] Tests: `visitInput` maps every field the scene reads (a session without a spot is still listed for the count but not drawn); the row is hidden with no villages, shows Home and a chip per village with its waiting count and an "away" mark; clicking a chip sets `visiting`, Home clears it; the ribbon reads "Visiting Ada's village · you are a Visitor here"; a village that disappears while visited sends you Home with "You can no longer see Ada's village."; the visited builder's panel shows the task line, the wait's words, question and options, and no buttons.
- [ ] RED, implement (load `frontend-design` for the ribbon and chips; ground tint via the scene's existing options if it has one, else a CSS overlay), GREEN. Commit: "Team villages: the people row and visiting".

### Task 8: Real run and README

- [ ] An `#[ignore]` test on the scratch board with the real CLI: close a test village `v/<me>-priv/`? No: the owner's real handle is needed for "written by owner", so use the login's own village on board `coc-spike`: close it, add the remote's project, read `grants list`, check `village_state == Closed` and `who_can_see`; publish a snapshot; build a visit by reading it back as "another owner" through `Visits::refresh` with `me` set to a different name; open the village again and revoke everything made. Print each step.
- [ ] README: a "Team villages" part (private village, who can close one, invites, visiting, the two known limits). Spec: a "Built" note with differences and what was and was not verified.
- [ ] All suites green. Commit: "README: team villages; a real-board run".

**For the owner afterwards:** with a teammate, invite them, have them open the app, and see your village in their row.
