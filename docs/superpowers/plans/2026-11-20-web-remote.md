# Web Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone web app, deployed by the team to its own Vercel account, that shows the owner's queue and sends signed Allow / Deny / answers / follow-ups which the Mac app checks and applies.

**Architecture:** The Mac app keeps writing through the user's `vercel` CLI and now also reads: one long-running `vercel board tail` child feeds a pure judge (`board/remote.rs`) that verifies each action against a paired-phone list in the Keychain and the prompt block the Mac itself wrote. The remote (`remote/`, Next.js) reaches the board as its own project through `@vercel/board`, trusts only text written by the village owner, and checks the phone's signature on every request.

**Tech Stack:** Rust (`ring` for P-256, `security-framework` for the Keychain), Tauri 2, React; Next.js 15 App Router, `@vercel/board`, `web-push`, WebCrypto, vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-web-remote-design.md` (and, for the layout it builds on, `docs/superpowers/specs/2026-11-20-board-link-design.md`).

## Global Constraints

- Work and commit on `main`. Other agents share the tree: no `git stash`, no `git checkout -- <file>`, no `git reset --hard`; stage only this plan's files and hunks.
- No board call on the path that handles agent status, prompts or terminal output.
- The Mac reaches the board only through the user's `vercel` CLI. The remote only through `@vercel/board` as its project. No Vercel token is stored anywhere.
- Anything shown, signed or used for access comes from the **text of a message written by the village owner's login**; labels only find things.
- Signed bytes of an action: lines joined by `\n`: `coc-act-1`, `do`, `pick` or empty, SHA-256 hex of `text` (or of ""), `nonce`, `prompt`. ECDSA P-256 / SHA-256, 64-byte `r‖s`, base64url without padding. High-`s` signatures are refused.
- Key id: first 16 hex characters of SHA-256 of the raw (65-byte uncompressed) public key.
- Check number: SHA-256 of raw public key ‖ ticket message id (UTF-8); first 4 bytes big-endian mod 1,000,000, shown as `482 913`.
- Channel `v/<owner>/remote`; labels `coc.kind` = `village | pair-open | pair | phone | push`, `coc.do`, `coc.code`, `coc.key`, `coc.host`.
- Times: pairing ticket 5 min; heartbeat 5 min; listener silence restart 7 min; offline banner 12 min; request timestamp window 2 min; record cache 1 min; deployment watch 5 min; dedupe memory 500 hashes.
- Off by default. The remote switch needs Board link connected.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Rust tests: `cd src-tauri && cargo test --lib`. Frontend: `pnpm vitest run`, `pnpm tsc --noEmit`. Remote: `cd remote && npm test`.

## Review Focus

1. A valid signature replayed by someone else (same bytes, or the `(r, n−s)` twin) after the prompt changed, or while it is still open: applied at most once, never on a later prompt.
2. A teammate relabels or reposts: a phone record, prompt block, ticket or pairing request that is label-only or not written by the owner must be ignored by the remote; a second pairing request must cancel the ticket.
3. Mac asleep for hours: the `tail` child alive on a dead connection; actions queued meanwhile; cursor from another board.
4. Double tap / two phones on an `answer` or `followup`, where the session's state does not move until the agent's hook fires.
5. A stranger hitting the remote's unsigned routes with random codes, owners and key ids: no board write, bounded board reads.

---

### Task 1: The judge (pure Rust)

**Files:**
- Create: `src-tauri/src/board/remote.rs`, `src-tauri/src/board/remote_tests.rs`, `scripts/remote-vectors.mjs`
- Modify: `src-tauri/src/board/mod.rs` (`pub mod remote;`), `src-tauri/Cargo.toml` (`ring = "0.17"`)

**Interfaces — Produces:**
```rust
pub struct Phone { pub key: String, pub public: Vec<u8>, pub name: String, pub paired_at: i64, pub last_used: i64 } // serde camelCase
pub enum Do { Allow, Deny, Answer, Followup }            // serde lowercase, as_str()
pub struct PromptBlock { pub v: u8, pub host: String, pub session: String, pub since: i64, pub wait: String,
                         pub can: Vec<Do>, pub question: Option<String>, pub options: Option<Vec<String>> }
pub fn can(info: &SessionInfo, answerable: bool, share_details: bool) -> Vec<Do>;   // the spec's table
pub fn block(info: &SessionInfo, session_id: &str, host: &str, wait: &str, answerable: bool, share_details: bool) -> PromptBlock;
pub fn block_json(b: &PromptBlock) -> String;            // canonical: serde_json, fields in struct order, no spaces
pub fn fenced(json: &str) -> String;                     // "\n\n```json coc\n<json>\n```"
pub fn block_in(text: &str) -> Option<&str>;             // the exact bytes between the fence lines
pub fn sha_hex(bytes: &[u8]) -> String;
pub fn key_id(public: &[u8]) -> String;
pub fn check_number(public: &[u8], ticket_id: &str) -> String;
pub struct Action { pub v: u8, pub r#do: Do, pub pick: Option<usize>, pub text: Option<String>, pub nonce: String, pub key: String, pub prompt: String, pub sig: String }
pub fn parse_action(text: &str) -> Option<Action>;
pub fn signed_bytes(a: &Action) -> Vec<u8>;
pub fn verify(public: &[u8], msg: &[u8], sig_b64url: &str) -> bool;
pub enum Verdict { Apply, Stale, Refused }
pub struct Open<'a> { pub block_json: &'a str, pub since: i64, pub current_since: i64 }   // what the Mac last wrote, and the session now
pub fn judge(a: &Action, phones: &[Phone], open: Option<Open<'_>>, seen: &HashSet<String>, paused: bool) -> Verdict;
```

- [ ] **Step 1:** Write `scripts/remote-vectors.mjs` (Node 22 WebCrypto): makes a P-256 key, signs the bytes for `{do:"allow", nonce:"00…0f", prompt:<sha of a fixed block>}`, prints JSON `{ public, keyId, check (ticket "msg_t_1"), msg, sig, highS }` where `highS` is the same signature with `s → n−s`. Run it once; paste the output into `remote_tests.rs` as constants.
- [ ] **Step 2:** Write failing tests in `remote_tests.rs`:
  - `verify_accepts_webcrypto_and_refuses_high_s`: `verify(PUB, MSG, SIG)`; `!verify(PUB, MSG, HIGH_S)`; `!verify(PUB, b"x", SIG)`.
  - `key_id_and_check_number_match_the_phone`: equal to the vector's `keyId`, `check` (format `"ddd ddd"`).
  - `signed_bytes_are_the_six_lines`: for allow with no text, equals `"coc-act-1\nallow\n\n<sha of empty>\n<nonce>\n<prompt>"`; with `pick: Some(2)` the third line is `2`.
  - `block_round_trips_through_text`: `block_in(&format!("Wants a decision: `x`{}", fenced(&j))) == Some(j)`; a text with no fence → `None`.
  - `can_follows_the_table`: one case per row of the spec's table (decide+answerable → allow,deny; one single-select picker with details → answer; multi-select, two questions, or details off → empty; asking with no picker → answer; stuck alive / finished → followup; working, exited (`Ended`), paused, parked → empty).
  - `judge_*`, each rule failing alone → its verdict: unknown key → `Refused`; bad sig → `Refused`; `paused` → `Refused`; no `open` → `Stale`; `a.prompt != sha_hex(open.block_json)` → `Stale`; `current_since != since` → `Stale`; `do` not in the block's `can` → `Refused`; `pick` ≥ options length → `Refused`; hash of signed bytes in `seen` → `Stale`; all good → `Apply`.
- [ ] **Step 3:** Run `cargo test --lib remote` → FAIL (unresolved items).
- [ ] **Step 4:** Implement `remote.rs`. `verify` uses `ring::signature::ECDSA_P256_SHA256_FIXED`; low-`s` by comparing the last 32 bytes with n/2 (constant in the file).
- [ ] **Step 5:** `cargo test --lib remote` → PASS. Commit: "Remote: verify and judge a phone's action".

### Task 2: Prompt blocks and message writes in the publisher

**Files:** Modify `src-tauri/src/board/mod.rs`, `tests.rs`, `publisher.rs`, `publisher_tests.rs`, `cli.rs`.

**Interfaces — Consumes:** Task 1 `block`, `block_json`, `fenced`. **Produces:**
```rust
// mod.rs
pub struct Ctx { …, pub answerable: bool }
pub struct Published { …, #[serde(default)] pub block: Option<String> }   // the block_json of the last wait reply
// a wait reply is now also planned for Wait::Stuck, and every wait reply's text ends with fenced(block_json)
// cli.rs
pub enum MsgWrite { Post { channel: String, text: String, labels: Vec<(String,String)>, key: String },
                    ReplyTo { id: String, text: String, labels: Vec<(String,String)>, key: String },
                    Edit { id: String, text: String } }
pub fn args_for_msg(w: &MsgWrite, t: &Target) -> Vec<String>;
// publisher.rs
pub fn send(&self, w: MsgWrite, done: Option<Box<dyn FnOnce(Option<String>) + Send>>);  // ordered, not collapsed, dropped after DRAIN_TRIES; done gets the new message id
pub fn open_block(&self, session_id: &str) -> Option<(String /*block_json*/, i64 /*since*/)>;
pub fn session_for_root(&self, root: &str) -> Option<String>;
pub struct SessionView { …, pub answerable: bool }
```

- [ ] **Step 1:** Failing tests: `tests.rs` — `a_wait_reply_ends_with_its_prompt_block` (decide: text starts ``Wants a decision: `Bash: npm test` `` and `block_in(text)` parses with `can == [allow, deny]`, `since == info.state_since`; `Published.block` equals it); `stuck_gets_a_reply_now`; `details_off_still_has_a_block_without_the_command` (block has no `question`, text starts `Wants a decision`); `the_block_fits_under_the_limit` (a 20,000-character last message: text ≤ `MAX_TEXT` and `block_in` still parses, i.e. the prose is cut, not the block). `publisher_tests.rs` — `message_writes_go_in_order_and_survive_a_retry` (three `send`s, the fake CLI fails the second once: calls arrive 1,2,2,3); `a_message_write_is_dropped_after_five_tries`; `message_writes_do_not_run_while_stopped`; `open_block_and_root_lookup` . `cli.rs` — `args_for_each_msg_write` (`post <channel> <text> --label k=v --idempotency-key …`, `reply <id> …`, `edit <id> <text>`, each with the target's tail and `--as village --json`; copy the flags `args_for` already uses).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `cargo test --lib board` → PASS; existing publisher tests still pass (fix their expected reply texts). Commit: "Board link: prompt blocks in wait replies, and a queue for message writes".

### Task 3: Answer once (session manager)

**Files:** Modify `src-tauri/src/sessions.rs`; create `src-tauri/src/ask_keys.rs`; modify `src-tauri/src/lib.rs` (`mod ask_keys;`).

**Interfaces — Produces:**
```rust
// ask_keys.rs — the single-question, single-select part of src/panels/askKeys.ts
pub fn pick_keys(agent: AgentKind, options: usize, pick: Option<usize>, text: &str) -> Vec<String>;
// sessions.rs
pub fn prompt_if(&self, id: &str, since: i64, text: &str) -> Result<()>;   // bracketed paste, 120 ms, since checked again, Enter
pub fn pick_if(&self, id: &str, since: i64, pick: Option<usize>, text: &str) -> Result<()>;
```
Both err with a message containing `stale` when `state_since != since` or the call was already made for that `since`; both set `state_since` to now (and send the update) when they take the answer, as `answer_if` does.

- [ ] **Step 1:** Failing tests. `ask_keys.rs`: `claude_pick_is_its_digit` (`pick_keys(Claude, 3, Some(1), "") == ["2"]`), `claude_typed_is_the_type_something_row` (`["4", "use sqlite", "\r"]`, newlines in text become spaces), `codex_pick_and_typed` (read `codexKeys` in `askKeys.ts` and its test file for the expected arrays; use the same cases). `sessions.rs` tests (with the existing fake PTY helpers): `prompt_if_types_once` (second call with the same `since` errs `stale`, PTY got one paste and one Enter), `prompt_if_refuses_another_since`, `pick_if_refuses_when_no_single_picker_is_open`, `pick_if_moves_state_since`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `cargo test --lib` → PASS. Commit: "Sessions: prompt_if and pick_if, an answer taken once".

### Task 4: The listener

**Files:** Create `src-tauri/src/board/listen.rs` (tests inside); modify `cli.rs`, `store.rs`.

**Interfaces — Produces:**
```rust
// cli.rs
pub trait BoardCli { …; fn stream(&self, args: &[String], on_line: &mut dyn FnMut(&str) -> bool /*keep going*/, idle: Duration) -> Result<(), CliError>; }
//   VercelCli: spawns, reads stdout by line, kills the child when on_line returns false or no line for `idle`; returns Err(Retryable) on idle
pub fn tail_args(owner: &str, after: Option<&str>, t: &Target) -> Vec<String>;   // board tail v/<owner>/ --json [--after c] + target tail
// listen.rs
pub struct Event { pub cursor: String, pub kind: String, pub id: String, pub thread_root: Option<String>, pub channel: String,
                   pub text: String, pub labels: BTreeMap<String,String>, pub principal: String, pub profile: Option<String>, pub person: bool }
pub fn parse(line: &str) -> Option<Event>;
pub struct Listener;  impl Listener { pub fn start(cli: Arc<dyn BoardCli>, files: PathBuf, on_event: Box<dyn Fn(Event) + Send>) -> Listener;
    pub fn configure(&self, on: Option<(Target, String /*owner*/)>); pub fn stop(&self); }
// store.rs
pub struct Store { …, #[serde(default)] pub cursor: Option<(String /*board key*/, String)>, #[serde(default)] pub seen: VecDeque<String> }
```

- [ ] **Step 1:** Save three real lines from the spike (`message.posted` reply by a project, `labels.changed`, `task.created`) as test constants (shapes are in the spec's spike section and in the scratchpad `tail.jsonl`; `re` gives the root for a reply, the message's own id for a root).
- [ ] **Step 2:** Failing tests: `parse_reads_a_posted_reply` (cursor, id, `thread_root == Some(re)`, labels, `principal == "vercel:project:…:production"`, `profile == Some("remote")`, `person == false`); `parse_skips_garbage`; `the_cursor_is_saved_and_used` (fake CLI: second start's args contain `--after <last cursor>`); `a_cursor_from_another_board_is_dropped`; `it_restarts_after_the_child_ends_with_backoff` (2 s then 4 s, using an injected clock like the publisher's); `silence_restarts_it` (fake `stream` returns `Err(Retryable)`; a new start follows); `turning_it_off_stops_the_child` (`on_line` returns false at the next line or idle tick; no restart); `a_real_child_is_read_line_by_line_and_killed` (`sh -c 'echo a; echo b; sleep 30'`, stop after `b`, returns in under 2 s).
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement; `stream`'s idle check must not need a line to arrive (reader thread + channel with `recv_timeout`). **Step 5:** PASS. Commit: "Board link: listen to the village's events".

### Task 5: Phones, pairing and the heartbeat

**Files:** Create `src-tauri/src/board/phones.rs`, `src-tauri/src/board/pairing.rs` (tests inside); modify `Cargo.toml` (`security-framework = "3"`, macOS only).

**Interfaces — Consumes:** Task 1 `Phone`, `key_id`, `check_number`; Task 2 `MsgWrite`, `Publisher::send`; Task 4 `Event`. **Produces:**
```rust
// phones.rs
pub struct Secrets { pub phones: Vec<Phone>, pub setup_secret: Option<String> }   // one JSON Keychain item
pub trait SecretStore: Send + Sync { fn load(&self) -> Result<Secrets, String>; fn save(&self, s: &Secrets) -> Result<(), String>; }
pub struct Keychain;      // service = the app's bundle identifier + ".remote", account "phones"
pub struct MemoryStore;   // tests
// pairing.rs
pub struct Request { pub id: String, pub name: String, pub public: Vec<u8>, pub check: String }
pub enum PairState { Idle, Open { code: String, until: i64, ticket: Option<String> }, Asking(Request), Cancelled(String /*why*/) }
pub struct Pairing;  impl Pairing {
  pub fn start(&mut self, now: i64, rng6: u32, host: &str, owner: &str) -> MsgWrite;        // the ticket root; code = format!("{:06}", rng6 % 1_000_000)
  pub fn ticket_posted(&mut self, id: String);
  pub fn on_event(&mut self, e: &Event, now: i64) -> Option<MsgWrite>;                      // a coc.kind=pair reply to our ticket; a second one cancels and returns the ticket's "closed" edit
  pub fn confirm(&mut self, now: i64, host: &str, owner: &str) -> Option<(Phone, Vec<MsgWrite>)>; // phone record root + ticket closed
  pub fn cancel(&mut self) -> Option<MsgWrite>;  pub fn tick(&mut self, now: i64) -> Option<MsgWrite>;  pub fn state(&self) -> &PairState; }
pub fn phone_record(p: &Phone, state: &str, host: &str) -> String;   // the record's JSON text
pub fn village_text(host: &str, version: &str, seen: i64) -> String; // heartbeat root's JSON text
```

- [ ] **Step 1:** Failing tests: `the_ticket_carries_the_code_until_and_host` (channel `v/ada/remote`, labels `coc.kind=pair-open`, `coc.code=<code>`, text JSON with `until == now + 300_000`); `a_request_under_our_ticket_asks_with_the_check_number`; `a_request_under_another_ticket_is_ignored`; `a_request_with_a_bad_key_is_ignored` (not 65 bytes / not starting `0x04`); `a_second_request_cancels` (`Cancelled`, edit of the ticket to `closed`); `confirm_gives_the_phone_and_its_record` (key id from Task 1, record text has `"state":"paired"`); `it_expires_after_five_minutes`; `secrets_round_trip_in_memory`; `#[ignore] keychain_round_trip` (real Keychain, unique service name, cleans up).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, then run the ignored Keychain test once by hand and record its output. Commit: "Remote: paired phones in the Keychain, and pairing".

### Task 6: Wire the Mac side

**Files:** Create `src-tauri/src/board/remote_app.rs`; modify `model.rs`, `board/app.rs`, `lib.rs`, `commands.rs` (hunks only), `src/api/types.ts`, `src/api/ipc.ts`, `src/state/settings.ts`.

**Interfaces — Produces:**
```rust
// model.rs, inside BoardSettings (serde default, camelCase)
pub struct RemoteSettings { pub enabled: bool, pub url: Option<String>, pub trusted: Vec<String> /*deployment ids*/, pub paused: Option<String> /*why*/ }
// remote_app.rs
pub struct RemoteStatus { pub phones: Vec<PhoneView /*key,name,pairedAt,lastUsed*/>, pub pairing: PairView, pub listening: bool, pub paused: Option<String>, pub last_refused_at: Option<i64>, pub keychain_error: Option<String> }
pub fn handle(app, e: Event);         // actions → judge → approve_if/deny_if/prompt_if/pick_if → result reply via Publisher::send; pair events → Pairing
pub fn result_text(action_id: &str, result: &str) -> String;
#[tauri::command] remote_status, remote_pair_start, remote_pair_confirm, remote_pair_cancel, remote_remove_phone(key)
```
Emits `remote-changed` (payload `RemoteStatus`) on every change. `board::app::apply` configures the listener (`Some` only when Board link is ready and `remote.enabled`), posts or edits the village root every 5 minutes from the publisher thread's tick, and passes `answerable` into `SessionView`.

- [ ] **Step 1:** Failing tests in `remote_app.rs` against a fake session manager trait and `MemoryStore`: `an_allow_from_a_paired_phone_is_applied_and_answered` (`approve_if(id, since)` called once; a `ReplyTo { id: <action id> }` whose text is `result_text(id, "applied")`); `the_same_action_twice_is_stale_the_second_time`; `a_followup_types_the_text` (`prompt_if`); `a_pick_uses_pick_if`; `an_unknown_phone_is_refused_and_noted` (`last_refused_at` set); `a_session_error_is_failed`; `last_used_is_saved`; `an_action_in_a_thread_we_did_not_publish_is_ignored` (no reply at all); `seen_hashes_are_capped_at_500`. Frontend: `settings.test` default has `board.remote = { enabled:false, url:null, trusted:[], paused:null }`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement and wire. **Step 4:** `cargo test --lib`, `pnpm vitest run`, `pnpm tsc --noEmit` → PASS. Commit: "Remote: apply a phone's actions".

### Task 7: The remote's core (no pages yet)

**Files:** Create `remote/package.json` (name `village-remote`, version `0.1.0`), `remote/tsconfig.json` (`moduleResolution: bundler`), `remote/next.config.mjs`, `remote/vitest.config.ts`, `remote/lib/{board.ts,crypto.ts,records.ts,queue.ts,auth.ts}`, `remote/lib/*.test.ts`, `remote/app/api/{queue,act,push,pair,version}/route.ts`, `remote/app/api/board/[[...path]]/route.ts`, `remote/.gitignore`.

**Interfaces — Produces (TypeScript):**
```ts
// crypto.ts — shared by server and browser
signedBytes(a: {do, pick?, text?, nonce, prompt}): Uint8Array        // identical to Rust's
requestBytes(method, path, ts, bodySha): Uint8Array                  // "coc-req-1\n…"
keyId(rawPublic): Promise<string>; checkNumber(rawPublic, ticketId): Promise<string>; verify(rawPublic, msg, sigB64url): Promise<boolean>
// records.ts
byOwner(m: Message, owner: string): boolean                          // author.verified && (handle === owner || handle startsWith owner + "/") && via is a person
phones(owner): Promise<Map<keyId, {public, name}>>                   // from v/<owner>/remote, text JSON, state "paired", written by owner; cached 60 s, misses cached too
openTicket(code): Promise<{owner, id} | null>                        // text JSON, by its owner, until > now, not closed; channel list + reads cached 15 s
// queue.ts
buildQueue(threads: Thread[], owner): Card[]                         // Card { root, session, builder, workspace, wait, since, can, question?, options?, command?, waitedFrom, promptSha, result? }; block taken only from owner-written replies; order decide, answer, stuck, review, then oldest
// auth.ts
signedBy(request): Promise<{owner, key} | null>                      // headers x-coc-owner, x-coc-key, x-coc-ts, x-coc-sig
```
Routes: `GET /api/queue` (signed) → `{ cards, working, seen }`; `POST /api/act` (signed; body is the action JSON; replies in the card's thread as `team.as('remote')` with label `coc.do`, idempotency id = `nonce`); `POST /api/push` (signed; replies under the phone record, label `coc.kind=push`); `POST /api/pair` (unsigned; `{code, public, name}`; 403 with no board write unless `openTicket(code)`; replies under the ticket, label `coc.kind=pair`; returns `{ owner, ticket, host }`); `GET /api/version` → `{ version }`; `/api/board/*` → `team.fetch`, with `POST /api/board/watchers` requiring header `x-coc-setup` equal to env `COC_SETUP`.

- [ ] **Step 1:** Failing tests (vitest, the board mocked as plain arrays of messages): `crypto` — the Task 1 vector verifies, the high-`s` twin and a changed byte do not, `signedBytes` equals the Rust string, `keyId`/`checkNumber` equal the vector's; `records` — a `paired` record by the owner counts, the same record by a teammate, by the remote project, or with only a `coc.state=paired` label does not, a `removed` text does not, an expired or `closed` ticket is not open, a ticket in `v/ada/remote` written by `bob` is not open; `queue` — the card's block comes from the newest owner-written reply and a later reply by someone else carrying a block is ignored, order is decide/answer/stuck/review, the action's result reply (owner-written `{re,result}`) lands on the card; `auth` — a good request passes, a timestamp 3 minutes old fails, an unknown key fails, a body changed after signing fails; route tests — `/api/queue` unsigned is 401, `/api/pair` with a wrong code is 403 and posts nothing, `/api/board/watchers` without the setup header is 403.
- [ ] **Step 2:** `cd remote && npm i && npm test` → FAIL. **Step 3:** Implement. **Step 4:** `npm test` PASS and `npx next build` succeeds. Commit: "Remote: the web app's core and API".

### Task 8: The remote's pages, push and watcher

**Files:** Create `remote/app/{layout.tsx,page.tsx,pair/page.tsx,globals.css,manifest.ts}`, `remote/app/ui/{Queue.tsx,Card.tsx,Pair.tsx}`, `remote/lib/{phone.ts,push.ts}`, `remote/public/sw.js`, icons; modify `remote/lib/board.ts` (watcher), tests beside.

**Interfaces — Produces:** `phone.ts`: `loadKey()`, `makeKey()`, `sign(bytes)`, `api(path, init)` (adds the four headers), all on IndexedDB + WebCrypto (non-extractable). `push.ts`: `notify(owner, card)` with `web-push` and env `VAPID_PUBLIC`, `VAPID_PRIVATE`; a 404/410 from the push service deletes that address. Watcher `notify`: tail `v/`, runs on `message.posted` written by the channel's owner whose text holds a prompt block with a non-empty `can` or wait `review`/`stuck`.

- [ ] **Step 1:** Failing tests (vitest + Testing Library, jsdom): `Pair` — in iPhone Safari outside standalone (`navigator.standalone === false`, iOS user agent) it shows "Add to Home Screen" and no code field; otherwise entering a 6-digit code posts `{code, public, name}` and then shows the check number and "Confirm on your Mac"; when `/api/queue` starts answering 200 it goes to the queue. `Card` — renders only the buttons in `can`; Allow posts an action whose `prompt` is the card's `promptSha` and whose signature verifies with the test key; shows "Sent", then "Done" / "Too late, it had moved on" / "Refused" from `result`; a picker shows its options as buttons and a text field; `can: []` on a picker shows "Answer this one on your Mac". `Queue` — the offline banner shows when `seen` is older than 12 minutes. `push` — the notification text is `"Wizard wants a decision · shop"` and adds the command only when the block has one; a 410 removes the address. Watcher filter — a block posted by a non-owner sends nothing.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Visual design: load the `frontend-design` skill first; one card per builder, thumb-sized buttons, the village's palette from `src/panels/panels.css`. **Step 4:** `npm test` PASS, `npx next build` succeeds. Commit: "Remote: pairing and queue pages, push".

### Task 9: Settings, deploy and the deployment watch

**Files:** Create `src-tauri/src/board/deploy.rs` (tests inside), `src/panels/RemoteSettings.tsx` + test; modify `remote_app.rs`, `TeamSettings.tsx`, `panels.css`, `src-tauri/tauri.conf.json` (bundle `../remote` without `node_modules`, `.next`), `package.json` (`qrcode-generator`).

**Interfaces — Produces:**
```rust
pub enum Found { Team { url: String, deployment: String }, None }
pub fn find(cli: &dyn BoardCli, team: Option<&str>) -> Result<Found, CliError>;
pub fn deploy(cli: &dyn BoardCli, team: Option<&str>, src: &Path, board: &str, secrets: Option<NewSecrets>, progress: &dyn Fn(&str)) -> Result<Deployed /*url, deployment*/, String>;
pub fn production_deployments(cli: &dyn BoardCli, team: Option<&str>) -> Result<Vec<Deployment /*id, created, by*/>, CliError>;
pub fn unknown<'a>(seen: &'a [Deployment], trusted: &[String]) -> Option<&'a Deployment>;
#[tauri::command] remote_find, remote_deploy, remote_connect(url), remote_trust
```
- [ ] **Step 0 (small spike, real CLI, scratch project):** find the exact commands and JSON for: link/create a named project non-interactively, `env add` from stdin, `deploy --prod` output, listing production deployments with ids and creators. Record them in the spec's spike section. This creates a project on the owner's team: reuse `remote-spike` if it still exists.
- [ ] **Step 1:** Failing tests: `deploy.rs` with a fake CLI replaying the recorded outputs — `find_reads_the_project`, `deploy_sets_the_variables_only_the_first_time`, `deploy_registers_the_watcher_with_the_setup_secret`, `unknown_finds_a_deployment_we_did_not_make`, `the_watch_pauses_and_trust_resumes` (in `remote_app.rs`: `paused` set, an otherwise valid action gets `refused`, `remote_trust` clears it). `RemoteSettings.test.tsx`: hidden unless Board link is ready; not set up + project found → "Use the team's remote"; not found → "Deploy the remote"; set up → address, "Pair a phone" shows the code and a QR `<svg>`; `Asking` shows "iPhone wants to pair. Does it show 482 913?" with Confirm and Cancel; phones list with Remove; paused shows the trust question; Keychain error shows its text.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** all three suites PASS. Commit: "Settings: Phone remote".

### Task 10: Real run and README

**Files:** Modify `README.md`, the spec (a "Built" note), `src-tauri/src/board/remote_app.rs` (an `#[ignore]` real-run test, as project 1 did).

- [ ] **Step 1:** Deploy the remote to the owner's team with the app's own `deploy` (scratch board `coc-spike`, project `village-remote`).
- [ ] **Step 2:** With `/browse`: open the remote, pair (confirm through the ignored test's harness), and against a real session thread send Allow, Deny, a picked answer and a follow-up. Expected on the board: each action followed by the Mac's `applied` result; a repeated action → `stale`; an action signed by an unpaired key → `refused`. Record the watcher's wake-up times over five prompts.
- [ ] **Step 3:** README: a "Phone remote" part under "Team (Vercel Board)": what it does, set-up, **the known limit in plain words** (whoever can deploy the remote can act as your phone; the deployment watch narrows it), the measured notification delay, iPhone Home Screen. Privacy section: what the remote stores (push addresses and phone names on the board).
- [ ] **Step 4:** All suites green. Commit: "README: Phone remote; a real-board run".

**For the owner afterwards (cannot be done here):** pair a real iPhone from the Home Screen app and an Android phone; see a push arrive.
