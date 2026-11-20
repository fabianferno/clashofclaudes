# Team Villages, part 2 (Act) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teammate whose Mac the village owner paired can act in that village from their own app, as far as their level allows: a Helper answers questions and sends follow-ups, a Trusted person also allows and denies.

**Architecture:** Each Mac gets a P-256 key kept in the Keychain. The owner pairs a teammate's Mac with the same code-and-proof pairing as a phone, in the reserved channel `v/<owner>/pair`, and the request must be written by the invited person's verified Vercel login. The owner's Keychain list holds each key's level and is the only authority. The visitor's Mac signs an action exactly as a phone does and posts it in the session's thread through its own CLI; the owner's Mac judges it with one more rule (the level allows it) and answers with the same result reply.

**Tech Stack:** Rust (`ring`, `security-framework` keys), Tauri 2, React.

**Spec:** `docs/superpowers/specs/2026-11-20-team-villages-design.md`, section 5 and its "Known limits". Builds on part 1 (same spec, "Built" note) and on `2026-11-20-web-remote-design.md` (signed actions, prompt blocks, pairing).

## Global Constraints

- Work and commit on `main`; other agents share the tree (no stash, no `checkout -- file`, no `reset --hard`; stage only this plan's files and hunks).
- No board call on a session's path; every CLI call on a background thread.
- A level exists only on a paired key in the owner's Keychain. Settings' invite level is what the owner wants; it is copied to the key when it is paired and whenever the invite changes. Removing an invite removes the key at once.
- Levels: Visitor nothing; Helper `answer`, `followup`; Trusted also `allow`, `deny`. The owner's own phones (no level) everything, and only they are stopped by the phone remote's switch and its pause.
- A teammate's pairing request counts only when: it is a reply under the open ticket in `v/<owner>/pair`; it carries the proof made with the code; and the board's verified author is the invited person (`principal == "vercel:user:" + invite.user_id`).
- The signed bytes, the action JSON, the result reply and the "applied once" rules are project 2's, unchanged.
- A teammate's key gets no phone record (it must never open the phone remote's API). The owner's map lists paired teammates in `mates: [{ key, handle, level }]`.
- One pairing open at a time, for a phone or a teammate.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Tests: `cd src-tauri && cargo test --lib`; `pnpm vitest run`; `pnpm tsc --noEmit`.

## Review Focus

1. A Visitor, or someone never paired, posting a well-formed action: refused. A Helper sending `allow`: refused. A level lowered or an invite removed while an action is in flight: judged by the level at that moment.
2. The owner's own agent (posting as the owner, able to change grants) or a teammate's agent (posting as the teammate): can either get a key paired, or an action applied, without the code and the Mac key?
3. The phone remote switched off or paused: teammates still act; phones do not.
4. A teammate's pairing request under a phone's ticket, or a phone's under a teammate's ticket; two requests; a request from the right person without the proof, and with the proof from the wrong person.
5. The visitor's side: acting on a stale panel (the prompt moved on), a double click, a village that vanished, the result never arriving.

---

### Task 1: Levels in the judge and the paired list

**Files:** Modify `src-tauri/src/board/remote.rs`, `remote_tests.rs`, `remote_app.rs`, `remote_app_tests.rs`, `pairing_tests.rs`.

**Produces:** `Phone { …, level: Option<Level> /*None: the owner's own phone*/, who: Option<Mate /*email, handle, user_id*/> }` (serde default); `pub fn allows(level: Option<Level>, d: Do) -> bool`; `judge(a, phones, open, seen, phones_off: bool /*remote switch off or paused*/)`: an owner's phone is refused when `phones_off`; a teammate's key is refused when its level does not allow `do`. `Remote::configure(village, paused, phones_on)`: the remote keeps a village whenever Board link is active; `phones_on` is the phone remote's switch.
- [ ] Tests: `allows_follows_the_levels`; `judge_refuses_a_helper_allow_and_takes_a_trusted_one`; `judge_refuses_a_visitor_key`; `phones_off_stops_phones_and_not_teammates`; `a_lowered_level_is_what_counts` (in remote_app: `set_mate_level`, then the action); `a_removed_mate_is_refused`.
- [ ] RED, implement, GREEN. Commit: "Team villages: levels on paired keys".

### Task 2: Pairing a teammate's Mac (owner side)

**Files:** Modify `pairing.rs`, `pairing_tests.rs`, `remote_app.rs`, `remote_app_tests.rs`, `board/app.rs`, `snapshot.rs` users (the map's `mates`), `lib.rs`, `src/api/{types,ipc}.ts`.

**Produces:** `Pairing::start_for(now, rng, host, owner, For::Phone | For::Mate { email, handle?, user_id, level })`: a mate's ticket goes to `v/<owner>/pair`; `on_event` for a mate's ticket also requires `e.principal == "vercel:user:<user_id>"`; `confirm` gives a `Phone` with that level and `who`, and posts no phone record. `Remote::pair_start_mate(rng, email)` (the invite must exist, be Helper or Trusted, and have a user id), `Remote::set_mate_level(email, level)`, `Remote::remove_mate(email)`, `Remote::mates() -> Vec<MapMate>`; commands `mate_pair_start(email) -> code`; `invite_put` / `invite_remove` call `set_mate_level` / `remove_mate`; `tick_map` fills `mates`. `RemoteStatus.pairing` gains `for_email`.
- [ ] Tests: `a_mates_ticket_goes_to_the_pair_channel`; `a_mates_request_must_come_from_the_invited_login` (right proof, wrong principal → ignored; a project → ignored); `a_phones_request_under_a_mates_ticket_is_not_enough` and the reverse; `confirm_keeps_the_key_with_its_level_and_posts_no_record`; `pairing_a_mate_needs_a_helper_or_trusted_invite_with_a_user_id`; `changing_an_invite_changes_the_keys_level`; `removing_an_invite_removes_the_key`; `the_map_lists_paired_mates_only`.
- [ ] RED, implement, GREEN. Commit: "Team villages: pair a teammate's Mac".

### Task 3: This Mac's key

**Files:** Create `src-tauri/src/board/mac_key.rs` (+ tests); modify `Cargo.toml` only if a crate is needed.

**Produces:** `pub trait MacKey: Send + Sync { fn public(&self) -> Result<Vec<u8>, String>; fn sign(&self, msg: &[u8]) -> Result<String /*r‖s base64url, low-s*/, String>; }`; `KeychainKey` (a Keychain EC key labelled for the app, made on first use; not exportable where the Keychain allows marking it so); `MemoryKey` for tests; `pub fn raw_low_s(der: &[u8]) -> Option<[u8; 64]>` (X9.62 DER → `r‖s`, `s` flipped to the low half).
- [ ] Tests: `der_becomes_raw_r_s` (vectors made with ring), `a_high_s_is_flipped_and_still_verifies`, `memory_key_signs_what_verify_accepts`, `#[ignore] keychain_key_round_trip` (makes, signs, verifies with `remote::verify`, finds the same key again, deletes).
- [ ] RED, implement, GREEN; run the ignored test once. Commit: "Team villages: a key for this Mac".

### Task 4: The visitor's side

**Files:** Create `src-tauri/src/board/visitor.rs` (+ tests); modify `visits.rs` (the visited builder carries its block's hash, `can`, and the Mac's result for our last action), `board/app.rs`, `lib.rs`, `src/api/{types,ipc}.ts`.

**Produces:** `find_ticket(read: &Value, owner, code, now) -> Option<String>` (owner-written, open, named by `ticket_id(code)`); `pair_request(code, public, name) -> MsgWrite::ReplyTo`; `action(key: &dyn MacKey, d: Do, pick, text, prompt_sha, nonce) -> Result<Action, String>`; `VisitedBuilder { …, can: Vec<Do>, prompt: Option<String>, result: Option<String>, sent: bool }`; commands `mate_key() -> key id`, `mate_pair(owner, code) -> check number`, `visit_act(owner, root, do, pick, text) -> ()`.
- [ ] Tests: `the_ticket_is_found_by_the_codes_name_among_owner_written_roots` (a teammate's look-alike ticket is not it); `the_request_carries_the_proof_the_owner_checks` (round trip through `Pairing::on_event`); `an_action_signed_by_this_mac_is_one_the_owner_takes` (round trip through `judge`); `a_visited_builder_says_what_can_be_done_and_how_our_action_ended`; `visit_act_refuses_when_the_prompt_is_not_the_one_shown` (the panel passes the hash it showed).
- [ ] RED, implement, GREEN. Commit: "Team villages: act in a village you visit".

### Task 5: The screens

**Files:** Modify `src/panels/AccessSettings.tsx` (+ test), `src/panels/VisitedBuilder.tsx`, `src/hud/PeopleRow.tsx` (+ tests), `hud.css`.

- [ ] Tests: People: a Helper or Trusted row with a user id shows **Pair their Mac**; pressing it shows the code to send them; when their request arrives: "bob@acme.com's Mac wants to pair. Does it show 482 913?" with Confirm and Cancel; a paired row says "Paired". Visiting: the ribbon says the level the map gives this Mac's key (Visitor without one), with **Enter pairing code** for a village that has not paired this Mac; entering a code shows the check number to tell the owner. A visited builder's panel shows only the buttons that both its `can` and the level allow; a click sends once and shows "Sent", then "Done" / "Too late: it had moved on" / "Refused"; a Visitor sees none.
- [ ] RED, implement, GREEN. Commit: "Team villages: pairing and acting in the app".

### Task 6: Real run and README

- [ ] An `#[ignore]` test with the real CLI on the scratch board, one login playing both sides: an owner-side `Remote` with a mate invite whose user id is this login's; a visitor-side `MemoryKey`; pair through the real `v/<owner>/pair` channel (ticket, request, listener, confirm); publish a session waiting on a decision; the visitor signs Allow and posts it; the owner applies it and answers; then lower the level to Helper and see the next Allow refused. Print each step.
- [ ] README (Team villages: what Helper and Trusted can do, how to pair a teammate's Mac, what the owner sees); spec "Built: part 2" note with differences and what was and was not verified.
- [ ] All suites green. Commit: "README: acting in a teammate's village; a real-board run".

**For the owner afterwards:** with a teammate on a second Mac: pair, answer, approve.
