# Shared Builders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A village owner lends a builder; a paired Helper or Trusted teammate hands it a task from a visit; it runs on the lender's Mac in its own worktree, the borrower follows and answers it from their own village, and its branch is pushed to `origin` when it finishes.

**Architecture:** A borrow request is one more signed message from a paired Mac, posted as a thread root in the lender's workspace channel and judged by the lender's Mac against a lending record kept in the Keychain. A taken request starts an ordinary session of that builder in a worktree cut from `origin`'s default branch, marked with who it works for (`by`). The existing action path gains one rule (a borrowed session takes answers only from its borrower) and one action (`close`). The lender's map names what is lent and marks borrowed sessions, which is how the borrower's app finds them.

**Tech Stack:** Rust (Tauri 2, `ring`, Keychain), git through the `git` CLI as `git.rs` already does, React.

**Spec:** `docs/superpowers/specs/2026-11-20-shared-builders-design.md`. Builds on `2026-11-20-team-villages-design.md` and `2026-11-20-web-remote-design.md` (read their Built notes).

## Global Constraints

- Work and commit on `main`; other agents share the tree (no stash, no `checkout -- file`, no `reset --hard`; stage only this plan's files and hunks).
- No board call, git network call or Keychain write on a session's path.
- A request counts only when signed by a paired key of level Helper or Trusted. The lending record in the Keychain is the only authority for what is lent; settings can only make it stricter.
- Signed bytes of a request, lines joined by `\n`: `coc-borrow-1`, lender host id, `builder` (profile), `workspace` (slug), SHA-256 hex of `task`, `at` (ms), `nonce`. Signature form as for actions (P-256, `r‖s`, low-s, base64url). Message ≤ 9,000 characters. Signed time within the last 24 h and not more than 5 min ahead. Nonces kept 24 h in the Keychain record.
- A request must be posted in `v/<owner>/w/<workspace>`, the workspace it names.
- Branch: `borrow/<slug(handle)>/<slug(task)>-<4 hex>`, slugs by `git::slug`, an empty slug becomes `task`; cut from `origin/<default branch>` after `git fetch origin`. Push: `git push origin refs/heads/<b>:refs/heads/<b>`, never forced; the first push refused when the name exists on `origin`. A worktree is removed only when clean and its tip equals `origin`'s; a branch is never deleted.
- Results under a request, one message edited as things move: `waiting`, `started`, `declined`, `expired`, `busy`, `low`, `refused`, `failed`. Ask-first requests expire after 30 minutes.
- On a borrowed session: `answer` and `followup` only from its `by` key; `allow` and `deny` only from that key when Trusted; `close` only from that key and only when finished. The lender's own phones and app are unchanged.
- Default: a borrow starts on its own and the lender is notified; ask-first is per builder, off by default.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Tests: `cd src-tauri && cargo test --lib`; `pnpm vitest run`; `pnpm tsc --noEmit`.

## Review Focus

1. A request replayed, reposted in another workspace's channel, altered after signing, older than a day, or signed by a key that is paired but not lent this builder or this workspace: nothing starts.
2. A Helper who borrowed sending `allow`; another Helper acting on someone else's borrowed session; `close` on a session that is not finished, not borrowed, or not theirs.
3. The push: a session that switched branches, a branch name that exists on `origin`, a task or handle with shell or git-option characters, a repository with no `origin`, a failed fetch.
4. Done with uncommitted or unpushed work in the worktree: nothing is deleted.
5. The lender's Mac asleep, the builder busy, low elixir, ask-first accepted after the builder became busy, and the 30-minute expiry.

---

### Task 1: The request and its judge (pure)

**Files:** Create `src-tauri/src/board/borrow.rs`, `borrow_tests.rs`; modify `board/mod.rs`.

**Produces:**
```rust
pub struct Request { pub v: u8, pub builder: String, pub workspace: String, pub task: String, pub at: i64, pub nonce: String, pub key: String, pub sig: String }
pub fn parse_request(text: &str) -> Option<Request>;                    // v == 1, text <= 9_000 chars
pub fn request_bytes(host: &str, r: &Request) -> Vec<u8>;
pub struct Lend { pub builder: String /*builder id*/, pub keys: Option<Vec<String>> /*None: every paired Mac*/, pub workspaces: Option<Vec<String>> /*workspace ids; None: all shared*/, pub floor: u32 /*percent*/, pub ask: bool }   // serde camelCase
pub enum Take { Start, Ask, Busy, Low, Refused(&'static str) }
pub struct Facts<'a> { pub host: &'a str, pub channel: &'a str, pub owner: &'a str, pub now: i64, pub phones: &'a [Phone], pub lends: &'a [Lend], pub seen: &'a HashSet<String>,
                       pub builder: Option<(&'a str /*id*/, bool /*has a live session*/, Option<u32> /*least elixir left, percent*/)>, pub workspace: Option<(&'a str /*id*/, bool /*shared and lendable*/)> }
pub fn take(r: &Request, f: &Facts<'_>) -> Take;
pub fn branch_name(handle: &str, task: &str, nonce: &str) -> String;
pub fn result_text(request_id: &str, result: &str, why: Option<&str>) -> String;   // {"re","result","why"?}
```
- [ ] Tests: `the_signed_bytes_are_the_seven_lines`; `parse_refuses_other_versions_garbage_and_oversize`; `take_starts_a_good_request` and `asks_when_the_builder_is_ask_first`; one test per refusal failing alone (unknown key, Visitor key, owner's phone key, bad signature, altered task, posted in another workspace's channel, another village's host, older than 24 h, more than 5 min ahead, nonce seen, builder not lent, not lent to this key, not lent for this workspace, workspace not lendable, unknown builder or workspace); `busy_and_low_are_said_as_such` (no reading counts as enough); `branch_names_are_safe` (`"Bob!"`, `"--force ../x; rm -rf"` → `borrow/bob/force-x-rm-rf-ab12`; empty slugs → `borrow/task/task-ab12`; never starts with `-`, no `..`, no spaces).
- [ ] RED, implement, GREEN. Commit: "Shared builders: the request and its judge".

### Task 2: Git for borrowed work

**Files:** Modify `src-tauri/src/git.rs` (tests inside, with a local bare repository as `origin`).

**Produces:** `has_origin(dir) -> bool`; `default_branch(dir) -> Option<String>` (`origin/HEAD`, else `main`, else `master`, whichever exists on `origin`); `fetch_origin(dir) -> Result<()>`; `add_worktree_from(dir, at, branch, start_point) -> Result<(WorktreeInfo, PathBuf)>`; `on_origin(dir, branch) -> Option<String /*tip*/>`; `push_branch(dir, branch, first: bool) -> Result<()>` (explicit refspec, no force; `first` refuses when the name exists on `origin`); `safe_to_remove(worktree, branch) -> bool` (clean and tip == `origin`'s); `remove_worktree_keep_branch(dir, wt)`.
- [ ] Tests: `the_default_branch_is_origins`; `a_worktree_is_cut_from_origin_not_from_local_commits` (a local unpushed commit is not in it); `push_sends_only_the_named_branch` (another local branch does not appear on origin); `a_first_push_refuses_a_name_that_exists`; `a_later_push_fast_forwards_and_never_forces` (a rewritten branch fails); `safe_to_remove_needs_clean_and_pushed`; `removing_keeps_the_branch`; `no_origin_is_not_lendable`.
- [ ] RED, implement, GREEN. Commit: "Git: worktrees from origin, a narrow push, a safe remove".

### Task 3: The lending record, elixir floor, and the map

**Files:** Modify `phones.rs` (`Secrets.lends: Vec<Lend>`, `Secrets.borrow_nonces: Vec<(String, i64)>`), `remote_app.rs` (`set_lend`, `lends`, `tighten_lends`), `snapshot.rs` (`lend`, session `by`), `quota.rs` (`least_left`), `model.rs` (`AccessSettings.lends` for display, `SessionInfo.borrowed`), tests beside each.

**Produces:** `Remote::set_lend(lend: Option<Lend>, builder_id)` (the only way lending is turned on or widened), `Remote::tighten_lends(settings_copy)` (only narrows or removes), `quota::least_left(&AgentQuota, now) -> Option<u32>` (the rule of `src/state/elixir.ts`, same cases; None for a reading older than an hour), `SessionInfo.borrowed: Option<Borrowed { key, handle, branch, request, pushed: bool }>` (serde default; persisted), `MapLend { b /*profile*/, n /*name*/, w: Option<Vec<slug>>, k: Option<Vec<key id>> }` (at most 12), `MapSession.by: Option<String>`; `snapshot::text` drops borrowed sessions last.
- [ ] Tests: `lends_round_trip_in_the_keychain_blob`; `tightening_never_widens`; `nonces_older_than_a_day_are_forgotten`; `least_left_matches_the_windows_rule` (cases copied from `src/state/elixir.test.ts`); `the_map_names_what_is_lent_and_to_whom`; `a_borrowed_session_carries_by_and_is_dropped_last`.
- [ ] RED, implement, GREEN. Commit: "Shared builders: the lending record, the elixir floor, the map".

### Task 4: Borrowed sessions and their rules

**Files:** Modify `sessions.rs` (`start_borrowed`, `close_if`), `remote.rs` (`Do::Close`; `judge` gets the session's `by`), `board/mod.rs` + `remote.rs::can`/`block` (a finished borrowed session offers `followup` and `close`; the block carries `by`), `remote_app.rs` (`Sessions::borrowed_by`, `close_if`), tests.

**Produces:** `PromptBlock.by: Option<String>` (skipped when None, so existing blocks hash the same); `judge(a, phones, open, seen, phones_off)` reads `by` from the block: on a borrowed session a teammate's key must equal `by` for `answer`/`followup`/`close`, and be Trusted and equal `by` for `allow`/`deny`; `close` is refused on a session that is not borrowed or not finished; `SessionManager::start_borrowed(ws, builder, task, cwd, worktree, borrowed) -> Result<SessionInfo>`; `SessionManager::close_if(id, since) -> Result<()>` (marks it for the app to close as accepted).
- [ ] Tests: `a_borrowed_session_takes_answers_only_from_its_borrower`; `a_trusted_stranger_cannot_allow_on_someone_elses_borrow`; `a_helper_borrower_cannot_allow`; `close_is_for_the_borrower_of_a_finished_borrowed_session_only`; `the_lenders_phone_still_does_everything_but_close` (close is not offered to phones); `blocks_without_by_hash_as_before`; `start_borrowed_records_who_it_is_for`.
- [ ] RED, implement, GREEN. Commit: "Shared builders: borrowed sessions take only their borrower's answers".

### Task 5: The lender's desk

**Files:** Create `src-tauri/src/board/desk.rs` (+ tests with fakes); modify `remote_app.rs` / `app.rs` (events labelled `coc.kind=borrow` go to the desk), `lib.rs`, `src/api/{types,ipc}.ts`.

**Produces:** `Desk` (no Tauri): `on_request(event, facts) -> Vec<Effect>`, `accept(id)`, `decline(id)`, `tick(now)` (expiry), `on_finished(session)` → `Effect::{Reply/Edit result, Start{…}, Notify{title, body}, Push{session, branch, first}}`; trait `Yard` for what it needs from the app (start a borrowed session in a new worktree, push, builder busy, elixir, workspace facts). Commands `borrow_requests() -> Vec<RequestView>`, `borrow_accept(id)`, `borrow_decline(id)`, `lend_set(builder_id, lend | null)`, `lends() -> Vec<LendView>`; event `borrow-changed`.
- [ ] Tests: `a_good_request_starts_and_notifies` (worktree from origin, `started` result, notification text "bob borrowed Wizard in shop"); `ask_first_waits_then_accept_starts` (one result message: `waiting` then edited to `started`); `decline_and_expiry`; `accept_after_the_builder_got_busy_says_busy`; `a_request_heard_twice_starts_once`; `a_refused_request_says_why_without_starting`; `a_failed_start_is_failed_with_the_reason`; `finishing_pushes_once_and_says_so` and `a_failed_push_is_said_and_tried_again_on_open`; `done_closes_and_keeps_an_unpushed_worktree`.
- [ ] RED, implement, wire, GREEN. Commit: "Shared builders: the lender's desk".

### Task 6: The borrower's side

**Files:** Modify `visitor.rs` (`borrow_request`), `visits.rs` (`borrowed(my_key) -> Vec<BorrowedView>` across all villages; `lent_to(owner, my_key)`), `app.rs` (commands `borrow_send(owner, workspace, builder, task)`, `borrowed() -> Vec<BorrowedView>`, `lent_here(owner, workspace)`; `visit_act` takes `close`), a local `board-borrows.json` of requests sent and their last result; tests.
- [ ] Tests: `a_request_signed_here_is_one_the_lender_takes` (round trip through `borrow::take`); `the_builders_lent_to_this_mac_for_a_workspace`; `borrowed_sessions_are_the_ones_whose_by_is_this_mac` (across two villages; someone else's are not); `sent_requests_and_their_results_survive_a_restart`; `the_result_is_read_from_the_owners_reply_only`.
- [ ] RED, implement, GREEN. Commit: "Shared builders: borrow from a visit".

### Task 7: The lender's screens

**Files:** Create `src/panels/LentBuilders.tsx` + test, `src/panels/BorrowRequests.tsx` + test; modify `AccessSettings.tsx`, the queue panel that hosts Requests, `panels.css`.
- [ ] Tests: per builder a Lend switch with the sentence about what lending means; To (everyone paired / chosen), Workspaces (only lendable ones choosable, the others say why), elixir floor, Ask me first with its "first task only" hint; saving calls `lend_set`; Requests: who, builder, workspace, the whole task, Accept, Decline, and it leaves the list when answered or expired; a borrowed session's briefing line "Working for bob" and "Branch not pushed yet".
- [ ] RED, implement, GREEN. Commit: "Shared builders: lending in Settings, requests beside the queue".

### Task 8: The borrower's screens and the guest camp

**Files:** Create `src/panels/BorrowHere.tsx` + test, `src/panels/BorrowedList.tsx` + test, `src/state/guestCamp.ts` + test; modify `VisitedBuilder.tsx` (works from home; **Done**), `PeopleRow`/`VillageCanvas.tsx` (a house click while visiting opens BorrowHere; the camp in the home input), `store.ts`, `hud.css`.
- [ ] Tests: BorrowHere lists the builders lent to this Mac for that workspace, sends, and shows each result's wording; none lent → says so; BorrowedList shows what each waits for and opens the panel; the panel shows Done on a finished borrowed session and sends `close`; `guestCamp` builds one extra compound with a stored place, only when there is a borrowed session, and never overlaps a workspace.
- [ ] RED, implement, GREEN. Commit: "Shared builders: borrow, follow and the guest camp".

### Task 9: Real run and README

- [ ] An `#[ignore]` test on the scratch board with the real CLI, one login playing both sides, a throwaway repository with a local bare `origin`: lend a builder, pair a visitor key, send a signed request, see `started`, a worktree cut from origin and a session with `by`; answer a question as the borrower; finish; see the branch on `origin` and the thread say so; send Done; see the session closed and the worktree gone. Then a replayed request and one posted in another workspace's channel: nothing starts.
- [ ] README (Team villages: lending and borrowing, the limits in plain words); spec "Built" note.
- [ ] All suites green. Commit: "README: shared builders; a real-board run".

**For the owner afterwards:** with a teammate on a second Mac: lend, borrow, answer, Done.
