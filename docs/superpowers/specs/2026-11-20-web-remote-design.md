# Web remote: answer your builders from a phone

Date: 2026-11-20. Project 2 of the roadmap in `2026-11-20-board-link-design.md` (read that first:
it fixes the board layout, the labels and the worker this builds on).

## Intent

The owner is away from the Mac. A builder asks to run a command, asks a question, gets stuck or
finishes. Today it waits until the owner is back. With the remote, the owner's phone buzzes, shows
what the builder wants, and one tap answers it. The Mac app applies the answer as if it had been
clicked in the window.

It is a web app, not a Slack bot and not an app-store app (owner's choice). Each team deploys its
own copy to its own Vercel account (owner's choice), so there is no service of ours to run.

## Goals

1. From a phone browser: see the queue of your village (who waits, on what, for how long), and
   - Allow or Deny a permission prompt,
   - answer a question (pick an option or type),
   - send a follow-up to a builder that is stuck or finished.
2. A notification on the phone when a builder starts waiting.
3. Set up from Settings with the `vercel` CLI the owner already has: deploy, then pair a phone.
   No account system, no token typed anywhere.
4. Nothing a phone sends is applied unless it is signed by a phone the owner paired with this Mac.
5. Off by default, and separate from the Board link switch: Board link can be on with the remote off.

## Non-goals (this project)

- Other people acting on your village, and seeing other villages (project 3). The pairing list
  built here is what project 3's "Trusted" level will use.
- Starting a new session from the phone. Accepting or discarding finished work (it needs the diff).
- A live terminal, terminal output, or scrollback on the phone.
- A follow-up to a builder that is working. The window does not offer it either.
- Pickers with several questions or multi-select: the phone says "Answer this one on your Mac".
- Allow / Deny buttons inside the notification itself. The notification opens the page.
- Plain terminals, and agents whose prompts the app cannot answer today (Antigravity, Grok): they
  show in the queue, with follow-up only where the app itself can send one.

## Anti-goals

- **An unsigned or wrongly signed action reaching a session.** The board and the team's grants are
  carriers. Neither is trusted to say "a person decided this".
- **An answer landing on the wrong prompt, or twice.** A tap made for one prompt must never answer
  a later one, and a double tap must not type into the next prompt.
- **Approving something other than what the phone showed.**
- **A public page that shows a village to anyone with the link.** (The spike showed a production
  `*.vercel.app` address is public by default.)
- **The remote slowing or breaking sessions.** Same rule as project 1: no board call on the path
  that handles agent status, prompts or terminal output.

## Known limit, accepted by the owner (2026-11-20)

The phone's key lives in the browser, and the page's own code is what uses it. So **whoever can
deploy to the remote's Vercel project can make the page sign as any phone that opens it**: a
teammate with deploy rights, or one of the owner's own agents (they run with the owner's Vercel
login). Passkeys with Face ID on every action would have closed the silent version of this; the
owner chose a plain tap. What is done instead is the deployment watch in section 4, which narrows
the hole and does not close it. The README must say this in plain words.

## Constraints

- Everything in project 1's constraints still holds: Tauri 2, Rust, no Node in the app, the app
  reaches the board only through the user's `vercel` CLI, other agents share this working tree.
- The remote reaches the board only through `@vercel/board` as its own project (the deployment's
  OIDC token). It stores no Vercel token.
- Board cannot read a subtree at once (`501 not_supported`, from the SDK too): list the channels,
  read them one at a time.
- Labels can be changed by anyone who can label in the channel, whoever wrote the message. Text
  can be changed only by its author. So anything shown, signed or used to decide access comes from
  the **text of a message written by the village owner's login**, never from a label. Labels only
  find things.
- iPhone delivers web push only to a page added to the Home Screen (iOS 16.4+), and (not tested
  here) that installed page keeps storage separate from Safari's.
- Board is experimental; the watcher wake-up time is not promised (see spike).

## What the spike showed (2026-11-20, CLI 66.4.0, `@vercel/board` 0.53.0)

A throwaway Next.js project on the owner's team, against the scratch board `coc-spike`:

- A deployment reads and posts with no secret. The board records it as
  `vercel:project:<id>:production`, and `team.as('remote')` as `…:production+remote`,
  `verified: true`. It may read, post, react, label and sync in every channel by default.
- Every event from `vercel board tail --json` carries the verified author:
  `payload.by.principal`, `payload.by.profile`, and `actor`. `tail --after 0` replays the whole log.
- `reply(id, { text, labels, id })` works, the `id` makes it idempotent. Labels of 3 short keys
  were kept; a `data` field passed the same way was not returned.
- A watcher (`tail: 'v/ --label coc.state=needs_you'`) ran in the deployment and replied as
  `…+notify`. It needed one `POST /api/board/watchers` after deploy to register, and the first
  wake-up arrived somewhere between 5 and 60 seconds after the change. Not measured closer.
- The production address answered the public internet with board data. Deployment Protection did
  not cover it.
- Not tested: a push arriving on a real phone; pairing inside an iPhone Home Screen app; label
  value length limits.

## Approaches

**Who is allowed to act**

1. **Paired phones that sign every action with a key kept in the browser, one tap (chosen by the
   owner).** See "Known limit".
2. Passkeys, Face ID or fingerprint on every action. Stops a tampered page approving silently.
   Offered as the recommendation; the owner chose the tap.
3. Trust the remote's project identity alone. Any teammate who can open the page, and any agent
   that can post as the project, could approve. Rejected by the owner.

**How the Mac hears about actions**

1. **A long-running `vercel board tail v/<owner>/ --json` child process (chosen; my call).** It is
   what the board documents for a process that stays up, and it resumes from a cursor.
2. `vercel board wait` in a loop: a process start per event, and gaps to reason about. Rejected.
3. The Mac polling the remote's HTTP API: makes the remote a trusted party. Rejected.

**Who may open the page**

1. **The remote checks the phone's signature on every request (chosen; my call).** Unpaired
   visitors get only the pairing screen. No Vercel plan feature is needed.
2. Vercel Authentication on the production address: depends on the plan, and the phone must sign
   in to Vercel. Mentioned in the README as an extra layer, not relied on.

**One remote per team (my call).** The channels are per village, so one deployment serves every
village on the team's board. A second teammate does not deploy again; they use the team's.

## Design

### 1. Pieces

| Piece | Where | Does |
|---|---|---|
| The remote | `remote/` in this repo, a Next.js app. Bundled into the Mac app as a resource | Pairing page, queue page, a small API, a watcher that sends push |
| Listener | `src-tauri/src/board/listen.rs` | Runs `tail`, turns lines into events, keeps the cursor |
| Remote logic | `src-tauri/src/board/remote.rs` | Pairing, the paired list, checking and applying actions, results, deployment watch |
| Settings | `TeamSettings.tsx`, a "Phone remote" block under the Board link switches | Deploy or connect, pair, list and remove phones |

### 2. On the board

One more reserved channel per village: `v/<owner>/remote` (workspaces live under `w/`, so no
workspace can collide). "The Mac" below means the app writing as the owner's login, profile
`village`. "By the owner" means `author.verified` and the author is the person whose handle is
`<owner>`, or one of their profiles.

| Message | Written by | Found by label | Text (the part that counts) |
|---|---|---|---|
| Village root, one per Mac | the Mac | `coc.kind=village`, `coc.host` | JSON: host id, app version, `seen` (ms). Edited every 5 minutes: the heartbeat |
| Pairing ticket (root) | the Mac | `coc.kind=pair-open`, `coc.code` | JSON: host id, code, `until` (ms). Edited to `closed` when used or expired |
| Pairing request (reply to the ticket) | the remote | `coc.kind=pair` | JSON: public key, phone name |
| Phone record (root, one per phone) | the Mac | `coc.kind=phone`, `coc.key` | JSON: key id, public key, name, `state`: `paired` or `removed` |
| Push address (reply to the phone record) | the remote | `coc.kind=push` | the browser's push subscription, JSON |

**The prompt block.** Project 1 already posts one reply per wait ("Wants a decision: …"). That
reply now ends with one fenced JSON block, the *prompt block*:
`{ "v": 1, "host", "session", "since", "wait", "can": [...], "question"?, "options"? }`. The
publisher also writes such a reply for stuck and finished (project 1 wrote none for stuck). `can`
is from this table and nothing else:

| The session | `can` |
|---|---|
| Wants a decision the app can answer (`answerable`) | `allow`, `deny` |
| Open picker, one single-select question, Share details on | `answer` |
| Open picker of any other shape, or Share details off | nothing ("Answer this one on your Mac") |
| Asking with no picker (process alive) | `answer` (typed) |
| Stuck or finished, process alive, not paused | `followup` |
| Anything else (working, exited, paused, parked) | nothing |

With Share details off the block is still written, with no command, question or options.

**An action** is a reply in the session's thread, written by the remote as profile `remote`,
labelled `coc.do` so the listener finds it. Its text is one JSON object:
`{ "v": 1, "do", "pick"?, "text"?, "nonce", "key", "prompt": <sha-256 hex of the prompt block's exact bytes>, "sig" }`.

**The result.** The Mac replies to each action it reads, text JSON `{ "re": <action id>,
"result" }` with `applied`, `stale` (the prompt had changed), `refused` (unknown phone, bad
signature) or `failed` (the session could not take it). The phone shows it.

### 3. Keys, pairing and signatures

- **Key.** The phone makes an ECDSA P-256 key pair with WebCrypto, private key not extractable,
  kept in IndexedDB. Key id: the first 16 hex characters of the SHA-256 of the raw public key.
- **Pairing** (the owner is at the Mac):
  1. Settings › Pair a phone posts a ticket with a random six-digit code, valid 5 minutes, and
     shows the code and a QR of the remote's address. Neither is a secret.
  2. On the phone the pairing screen asks for the code. In iPhone Safari outside the Home Screen
     it first says "Add to Home Screen, then open it from there" and takes no code, because a key
     made in Safari would not be in the installed app.
  3. The phone makes its key and sends code, public key and phone name. The remote finds the open
     ticket with that code written by an owner (else 403, and no board write) and posts the request.
  4. Phone and Mac each show a six-digit *check number* derived from SHA-256 of the public key
     and the ticket's message id. Settings shows "iPhone wants to pair. Does it show 482 913?"
     with Confirm and Cancel. If more than one request arrives for a ticket, the Mac cancels the
     ticket and says so (someone else answered it; start again).
  5. On Confirm the Mac adds the phone to its paired list and posts the phone record.
- **The paired list** (key id, public key, name, paired at, last used) is stored in the macOS
  Keychain, one item, not in `board.json`: any process of the user can rewrite a file. It is the
  only authority for actions. If it cannot be read, no phone is paired and Settings says so.
- **Signing an action.** The phone signs the UTF-8 bytes of these lines joined by `\n`:
  `coc-act-1`, `do`, `pick` (or empty), the SHA-256 hex of `text` (or of the empty string),
  `nonce` (16 random bytes, hex), `prompt`. ECDSA with SHA-256, 64-byte `r‖s`, base64url.
- **The Mac applies an action only when all hold:**
  1. the thread is one this Mac published, and maps to a live session;
  2. `key` is in the paired list;
  3. the signature verifies, and its `s` is in the low half (the other form is refused);
  4. `prompt` equals the hash of the prompt block the Mac itself last wrote for that session, and
     the session's `state_since` is still that block's `since`;
  5. `do` is in that block's `can`, and `pick` is a valid index;
  6. the SHA-256 of the signed bytes has not been seen before (kept in memory, and the last 500
     in `board.json`).
  Who posted the message on the board is not checked; the signature proves more.
- **Signing a request to the remote.** Every API call carries key id, a timestamp and a signature
  over method, path, timestamp and body hash. The remote accepts it when the timestamp is within
  2 minutes and a phone record with that key id, written by the owner, says `paired`. It caches
  each village's records, and unknown key ids and owners, for a minute.
- **Removing a phone** deletes it from the Keychain list at once and edits its record to `removed`.

### 4. The Mac side

- **Listener.** While Board link is connected and the remote switch is on, one child process:
  `vercel board tail v/<owner>/ --json --after <cursor>`, read line by line (new: today's
  `BoardCli` only runs commands to their end). The cursor is saved in `board.json` with the board's
  key and dropped when team or board name changes. With no cursor it starts at the newest event.
  It is restarted with the publisher's backoff (2 s to 5 min) when it ends, **and when nothing has
  arrived for 7 minutes**: the Mac's own 5-minute heartbeat shows up on its tail, so silence means
  a dead connection (sleep, network change). Killed on quit and when either switch goes off. Its
  own thread; nothing waits on it.
- **Events it cares about:** `message.posted` labelled `coc.do` in a session thread, and
  `message.posted` labelled `coc.kind=pair` under an open ticket. Everything else moves the cursor.
- **Applying**, through new session-manager calls that check `since` under the lock and move
  `state_since` themselves, so the same prompt cannot be answered twice:
  - `allow` / `deny`: the existing `approve_if` / `deny_if`.
  - `followup`, and typed `answer` with no picker: `prompt_if(id, since, text)`. The bytes the
    window's `sendPrompt` writes (bracketed paste, 120 ms, Enter), with `since` checked again
    before Enter.
  - `answer` on a picker: `pick_if(id, since, answer)`, the keys of `answerKeys` in
    `src/panels/askKeys.ts` for one single-select question, moved into Rust with the same cases.
- **Writes.** Results, tickets, phone records and the heartbeat need delivery in order, addressed
  to a message, without collapsing. The publisher gets a second queue for these beside its
  newest-state-per-session one; same single thread, same backoff, dropped after 5 tries.
- **Deployment watch.** The Mac keeps the ids of the production deployments it made or the owner
  trusted. Every 5 minutes, and when a phone is paired, it asks the CLI for the project's recent
  production deployments. One it does not know pauses the remote: actions get `refused`, and
  Settings says "The remote was redeployed by someone else (when, by whom). Trust it?" A teammate
  updating the team's remote triggers this once on every Mac; that is intended.

### 5. The remote

- **Stack.** Next.js (App Router) on Vercel, `@vercel/board`, `web-push`. Variables: the board's
  name (`COC_BOARD`, default `village`), the two push keys, and a setup secret, all made by the
  first deploy and never regenerated.
- **Pages.** The pairing screen. The queue: one card per waiting builder of your village, in the
  Mac's queue order (decide, answer, stuck, review), with workspace, what it wants (from the
  prompt block), how long it has waited, and the buttons in `can`. A card shows "sent", then the
  Mac's result. A quieter list of working builders, read only. A banner when the village root's
  `seen` is older than 12 minutes: "Your Mac may be asleep or offline."
- **API.** Signed: the queue; post an action; save a push address. Unsigned: pairing (code must
  match an open ticket), version (so the Mac can offer Update), and watcher registration (needs
  the setup secret, which the Mac holds). Nothing else answers.
- **Watcher.** On `message.posted` by an owner in a session thread, carrying a prompt block with a
  non-empty wait: push to every paired phone of that village. "Wizard wants a decision · shop",
  plus the command or question when the block has it. An address the push service reports gone is
  removed.
- **Installable.** A manifest and a service worker (push only, no offline mode).

### 6. Settings › Team › Phone remote

Shown only while Board link is connected.

1. **Not set up.** "Answer your builders from your phone." The app looks for a project named
   `village-remote` on the team. Found: **Use the team's remote** (saves its address, trusts its
   current deployment). Not found: **Deploy the remote**, which creates the project from the
   bundled folder, sets the variables, deploys to production, registers the watcher and saves the
   address. Progress and errors in place. A field "Use an address I deployed myself" covers the rest.
2. **Set up.** The address; **Pair a phone**; paired phones with name, last used and **Remove**;
   **Update the remote** when the bundled version is newer (any teammate may; see deployment watch).
3. One switch, **Phone remote**, turns listening on and off without unpairing.

### 7. Failure handling

| What | Then |
|---|---|
| Mac asleep or offline | Actions wait on the board. On wake the listener resumes from its cursor; each is applied if its prompt is still the open one, else `stale`. The phone shows the offline banner |
| Two taps, or two phones, on one prompt | The first is applied, the second is `stale` |
| Unknown key, bad signature, remote paused | `refused`; Settings shows "A phone that is not paired tried to act" or the trust question |
| `tail` dies or goes silent, CLI signed out | Restart with backoff; Settings shows the same status line as Board link |
| The remote is down | The Mac is unaffected. The phone shows the browser's error |
| Push not delivered | The queue page shows the truth when opened |

## Changes to project 1's design

Its anti-goal note "Project 2 accepts actions only from the web remote's own project identity,
which an agent cannot use" is wrong and now points here.

## Testing

- Rust unit tests: signature check against vectors made with WebCrypto, including the refused
  high-`s` form; each of the six accept rules failing alone; the check number; the tail line
  parser against the event shapes recorded in the spike; `prompt_if` / `pick_if` (stale `since`,
  double call); picker keys against the TypeScript cases; the `can` table; the listener with a
  fake CLI (restart, silence, cursor, kill on switch-off); the deployment watch.
- Remote: request signature checking; ticket matching; label-only or non-owner records ignored;
  queue building from board messages; an unsigned request gets nothing but pairing and version.
- One real run: deploy to the owner's team, pair the headless browser as a "phone", and take a
  session through Allow, Deny, a picked answer and a follow-up against the real board.
- The owner's checks, on a real iPhone and Android phone: pairing from the Home Screen app, and a
  push arriving. If iPhone pairing fails as designed, stop and bring it back.

## Left to the builder

- The remote's visual design, within "one card per builder, thumb-sized buttons, the village's look".
- Exact wording of pushes and of the Settings block.
- Which Keychain API (the `security-framework` crate or the system's own tool).
- Which CLI calls deploy the bundled folder, set variables and list deployments.
- Measuring the watcher's wake-up time and saying it honestly in the README.
