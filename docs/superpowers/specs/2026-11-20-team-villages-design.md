# Team villages: invite people, visit theirs, act by your level

Date: 2026-11-20. Project 3 of the roadmap in `2026-11-20-board-link-design.md`. It builds on
Board link (project 1) and the phone remote (project 2: `2026-11-20-web-remote-design.md`, whose
signed actions, prompt blocks, listener and pairing this reuses). Read both first.

## Intent

A team runs several villages, one per person. Today each is visible only on its owner's Mac (and
phone). This project lets an owner invite teammates into their village, lets a teammate walk into
it from their own app and see who is working and who waits, and, where the owner allowed it, lets
them unblock a builder there: answer its question, send a follow-up, or approve a command.

Decided with the owner on the mockup (2026-11-20, `.superpowers/brainstorm/…/team-villages-v2.html`):
one village on screen at a time, a row of people to visit, three levels (Visitor, Helper,
Trusted), acting through the board and never a live terminal, and **no access without an invite**
(confirmed again on 2026-11-20 over "open to the team by default").

## Goals

1. **Private by default where it can be.** A village is closed to the team; only the people its
   owner invited can read it.
2. **Invite** a teammate by their Vercel email, with a level and a choice of workspaces. Change the
   level or remove them later.
3. **Visit.** In the Mac app, a row of the villages you were invited to, each with how many
   builders wait there. Visiting shows that village as its owner laid it out, read-only, clearly
   marked as not yours, with a way home.
4. **Act by level.** A Helper can answer a builder's question and send a follow-up. A Trusted
   person can also Allow and Deny. The owner's Mac enforces the level, whatever the board allows.
5. Everything stays off unless Board link is on. No call to the board sits on a session's path.

## Non-goals (this project)

- Handing a new task to someone else's village, and borrowing builders: project 4 (it needs the
  lender's limits and the guest camp). Helper's "hands over tasks" from the mockup moves there.
- Visiting or acting from the phone remote. The phone stays your own village's remote.
- Live terminals, output, diffs or scrollback of someone else's sessions.
- Chat between people. The board has that already.
- Moving or changing anything in a visited village (its layout, builders, settings).

## Anti-goals

- **A level the board grants and the Mac does not check.** Any team owner can change a grant, and
  anything "written by Bob" on the board can be written by Bob's agents. An action counts only
  when it is signed by a key the village owner paired and gave that level.
- **A village that looks private and is not.** If the app cannot close it, it says so in plain
  words and shows who can see it.
- **Locking the owner, or the phone remote, out of their own village** while closing it.
- **Showing a visitor the wrong village's state** (stale after an invite was removed).

## Known limits, to be said in Settings and the README

- **The owner's own agents can reopen the village.** They run with the owner's Vercel login and
  can change its grants. They cannot act in anyone's village (that takes a paired key), and they
  cannot raise a level (levels live in the Keychain). The app re-checks the grants every 5 minutes
  and warns when the village is no longer as the owner set it.
- **With the phone remote set up, whoever can deploy to `village-remote` can read every private
  village that lets the remote in.** This follows from the limit the owner accepted in project 2.
  The "who can see this village" line names it.

## Constraints, and what the spike showed (CLI 66.5.0, scratch board, 2026-11-20)

- Every board starts open: every team member may do everything everywhere (`g1`), every project's
  deployments may read and post (`g2`).
- Closing works by subtree. Tested: a grant `user=<me>, can {"v/x/": all}`, a grant
  `everyone, can {"v/x/": none}` and a grant `project village-remote (production), can
  {"v/x/": read,post,label}` left the village readable and writable by its owner and the remote's
  project and closed to everyone else (`grants explain` confirmed each). `grants create --file`
  makes several grants in one write. `channels create --private` refuses once the channel exists.
- A person is named by email (`--user`); a grant then carries their user id. A project by name.
- **Vercel's documentation says only a team owner may close a channel to everyone or to every
  person on the team.** The spike ran as an owner, so a regular member's refusal is documented,
  not observed. Members may create other grants.
- `vercel board channels` lists only channels the caller can read. So "the villages I can visit"
  is "the owners of the `v/*/` channels I can list".
- `vercel whoami --json` gives the login's email and username.
- All of project 1's and 2's constraints hold (the CLI is the only way to the board from the Mac;
  labels are never evidence; text only from its author).

## Approaches

**Who can see a village**

1. **Private, closed by grants (chosen by the owner).** Needs the right to close a subtree, which
   Vercel gives team owners. Where the app cannot close it, an owner can with one command.
2. Open to the team, invites only for acting. Works for every member with no owner involved.
   Rejected by the owner.

**How the owner's Mac knows who acts**

1. **The teammate's Mac holds a key; the owner pairs it and gives it a level (chosen; my call).**
   The same judge as for phones, with one more rule: the level allows the action. Pairing uses a
   code the owner sends the teammate out of band, as phone pairing does.
2. Trust the board's "written by Bob". His agents write as him. Rejected.

**How a visitor's app learns a village**

1. **The owner's Mac publishes a layout snapshot; the visitor's Mac reads it and the session
   threads through its own CLI (chosen; my call).** No new service.
2. Through the phone remote's API. It would make the remote a party to every visit and needs each
   visitor paired with it. Rejected.

## Design

Two parts that ship one after the other: **See** (sections 1 to 4) and **Act** (section 5).

### 1. Privacy

- Settings › Team gets **Private village**, on by default once Board link is connected.
- Turning it on makes three grants in one write on `v/<owner>/`: the owner everything, everyone
  nothing, and, when the phone remote is set up, its project read, post and label. The owner's
  email comes from `vercel whoami`. The grant ids are kept in settings.
- Under the switch, always: **who can see this village now**, in words (you; the people below;
  the phone remote and whoever can deploy it; or "everyone on your Vercel team").
- If the board refuses (not an owner), the switch stays off and Settings says: "Only an owner of
  your Vercel team can close a village. Until one does, everyone on the team can see yours." with
  the exact command for an owner to run (the same three grants, naming this member), and Copy.
  In that case the switch is read-only: it shows what `grants explain v/<owner>/` says, and
  opening the village again is also the owner's to do.
- Turning it off revokes those grants (the invites' grants stay; they are then redundant).
- Setting up the phone remote later, or changing team or board, re-applies the grants.
- The state shown is always what `grants explain` says, never what the app last tried. It is
  asked again every 5 minutes; a village found open, or an invite found changed, when the owner
  set otherwise shows a warning with **Put it back**.

### 2. Invites

- Settings › Team › **People**: add by email, pick **Visitor**, **Helper** or **Trusted**, and
  all shared workspaces or some.
- An invite is one grant for that person: `read` on `v/<owner>/village` and on each chosen
  workspace channel (or on `v/<owner>/w/` for all), plus, for Helper and Trusted, `post` on those
  workspace channels (they reply with actions) and on `v/<owner>/pair` (section 5). Never
  `label`, and never anything in `v/<owner>/remote`, which holds the owner's phones.
- Kept in settings: email, workspaces, grant id (what to show and what to revoke). **The level
  is not kept there.** A level exists only on a paired key in the Keychain (section 5); until a
  Helper or Trusted invite's Mac is paired, that person is a Visitor in effect, and People says so.
- Changing an invite updates its grant; removing it revokes the grant, and for Helper and Trusted
  also unpairs their key at once (section 5).
- A new shared workspace is added to the "all workspaces" invites by itself (they are subtree grants).
- With Private village off, invites still exist: they decide who may act.

### 3. What the owner's Mac publishes for visitors

- One root in the reserved channel `v/<owner>/village`, written by the Mac (profile `village`),
  its text one JSON object, edited when it changes (at most every 30 seconds):
  `{ v, host, owner, name, seen, workspaces: [{ slug, name, level, color, compound }],
  builders: [{ profile, name, agent }], sessions: [{ id, root, workspace, builder, state, wait,
  since, spot }], mates: [{ key, handle, level }] }`.
- Only shared workspaces and their sessions. `compound` and `spot` are as the app stores them.
  No paths, no notes, no tasks (those are in each session's thread, for those invited to it).
- `sessions` is what a visitor's app draws and counts from: owner-written text, where the
  `coc.state` label could be changed by anyone allowed to label. It is edited when a session's
  state settles (project 1's 2 seconds), at most once every 10 seconds.
- `seen` is the Mac's heartbeat for visitors, edited every 5 minutes whether or not the phone
  remote is on.
- `mates` tells an invited Mac its own level: the paired teammates' key ids and levels. It is
  information for their app's buttons; the authority stays the owner's Keychain.
- With 40 workspaces and 60 sessions it must stay under 10,000 characters; beyond that the oldest
  finished sessions are left out first.

### 4. Visiting

- **Finding villages.** With Board link connected, the Mac lists the channels it can read. Each
  other owner with a readable `v/<them>/village` is a village to visit; one read of that channel
  gives everything the row and the canvas need. The list is read again every 5 minutes and on
  **Check again** (one call, plus one per village). Workspace channels are read only for the
  builder whose panel is opened.
- **Listening follows Board link, not the phone remote's switch.** The listener follows `v/`
  (all the Mac may read), with one cursor per board, so snapshots and results arrive live. What
  it hears for its own village goes where it goes today.
- **People row**, top left of the village: Home, then one chip per village with the owner's name
  and the number of builders waiting there. Hidden when there is none.
- **Visit** swaps what the canvas draws: that village's houses where its owner put them, its
  builders at them by state, a ribbon "Visiting Ada's village · you are a Visitor here", a
  different ground colour, and Home. Your own sessions keep running; your queue, menu bar and
  notifications are still yours and still work.
- **A visited builder's panel** shows its task and what it waits for, from its thread (the prompt
  block's question and options; the wait reply's words). Read-only in this part.
- **Stale or gone.** A village whose `seen` is older than 12 minutes shows "Ada's Mac may be
  asleep or offline." One you can no longer read drops out of the row; if you are in it, you are
  taken Home with a line saying why.
- Read from the board on a background thread through the CLI, kept in memory and in
  `board-visits.json` so the row is there at launch.

### 5. Acting (the second part)

- **A key per Mac.** The app makes a P-256 key for this Mac the first time it is needed, as a
  Keychain key that cannot be exported (not a stored password, which another process of the user
  could read). Its key id identifies this person's Mac to the villages that pair it.
- **Pairing a teammate.** In People, a Helper or Trusted invite has **Pair their Mac**: the same
  twelve-character code as for a phone, good for 5 minutes, which the owner sends them however
  they like. The teammate enters it in Visit › **Enter pairing code**; their Mac posts the request
  (public key, proof made with the code) under the owner's ticket in the reserved channel
  `v/<owner>/pair`; the owner's Mac checks the proof **and that the board's verified author of the
  request is the invited person** (the user id on their invite's grant), shows "bob's Mac wants
  to pair. Does it show 482 913?" and on Confirm keeps the key with the level chosen in People.
  One pairing is open at a time, for a phone or for a teammate.
- **The paired list** (Keychain) gains, per key: who it is (email, handle, user id) and its
  level. It is the only authority for who may act and at what level. Changing a level or removing
  an invite in People rewrites it at once. Phones are the owner's own keys and can do everything,
  as today. A teammate's key gets no phone record, so it never opens the phone remote's API.
- **Acting.** A visited builder's panel shows the buttons its prompt block's `can` allows **and**
  the visitor's level allows: Helper `answer`, `followup`; Trusted also `allow`, `deny`. The
  visitor's Mac signs the action exactly as a phone does and posts it as a reply in the session's
  thread through its own CLI. The owner's Mac judges it as in project 2, plus: the key's level
  must allow that `do`. The phone remote's pause (a redeploy the owner has not trusted) applies
  to phones only; a teammate's action never passes through the remote. It answers with the same result
  reply, which the visitor's panel shows ("Done", "Too late: it had moved on", "Refused").
- **The owner sees it.** A notification and a line in the builder's briefing: "bob allowed
  `npm test`". The session's thread on the board is the record.

### 6. Failure handling

| What | Then |
|---|---|
| The board refuses to close the village | Section 1's message; the village works, open |
| An invite's email is not on the team | The CLI's error, shown at the invite |
| The owner removes an invite while someone visits | Their app loses the channels at its next look and takes them Home |
| A visitor acts above their level, or after removal | `refused`; the owner's Settings notes it |
| The owner's Mac is asleep | The visitor sees the offline line; actions wait and are judged on wake, `stale` if the prompt moved |
| Two people answer one prompt | First applied, second `stale` (project 2's rule) |

## Testing

- Rust unit tests: the grant file for private, for each invite shape, and their revocation; the
  snapshot (only shared workspaces, no paths, size under 10,000 characters with 40 workspaces);
  the visits store built from channel lists and messages (owner-written text only, a village
  that vanished); the judge's level rule; pairing a teammate's key.
- Frontend tests: People (add, change, remove, the refused-to-close message), the people row, the
  visiting ribbon and Home, a visited builder's panel by level.
- Real run on the scratch board: close a test village, grant the remote's project and an invite,
  read it back with `grants explain`, publish a snapshot and build a visit from it. One login
  cannot play two people, so a real second person visiting and acting is the owner's check with a
  teammate.

## Left to the builder

- The exact grants file format and which CLI calls change one invite.
- How the canvas takes a second, read-only data source (a visited village) beside the store.
- Ground colour and ribbon art for a visited village, within the mockup's look.
- Whether the visits listener is the existing listener with a wider subtree or a second one.
- The wording of every line above.

## Built: part 1, See (2026-11-20)

Plan: `docs/superpowers/plans/2026-11-20-team-villages-see.md`. Sections 1 to 4 are built;
section 5 (Act) is not. Differences from the text above:

- **The map is smaller than promised.** One board message holds 10,000 characters. With short
  keys it is tested whole at 20 workspaces and 30 sessions (real-length ids); a bigger village
  loses its finished sessions first, then its oldest. The design said 40 and 60.
- **The default is applied when Settings first asks for the access status**, not silently at
  connect: the owner sees the village close. Until Settings is opened once, a village is open.
- **The grants are re-read when Settings › Team opens**, not every 5 minutes in the background,
  so drift shows there and nowhere else yet.
- **Three separate grant calls in a safe order** (owner, remote, everyone out), not one `--file`
  write. A refused step takes back what the call made.
- **Any refusal of the "everyone out" grant is treated as "not a team owner".** The real refusal
  was never observed (the spike and the run were done as an owner).
- **The level chosen in People is kept in settings as what the owner wants.** Nothing acts on it
  yet; part 2 puts the authority on the paired key in the Keychain, as designed.
- **A visited village's ground is tinted by an overlay**, not by the scene; houses and the hall
  there do nothing when clicked, only builders open a panel.
- **`mates` is always empty** until part 2; the ribbon always says Visitor.

**Fixed after the whole-change review:** one access change runs at a time (two overlapping
ones could orphan a grant the app then could not revoke); the login's email is asked each time,
never remembered (a changed login would have handed the village to the old one); "who can see"
names every grant that reaches the village, whoever made it, and drift flags the strangers;
one map write is in flight at a time (a board down for hours no longer returns to a queue of
stale maps); a village is named by its owner's verified handle, never by the name they chose;
grant ids are kept with their board, and opening skips ids no longer there. Confirmed on the
scratch board: `grants update --can` replaces what a grant allows.

**Verified on the real board** (`real_village_closes_and_is_visited`, scratch board, the updated
CLI): closing the login's village made three grants and read back as closed, visible to "You" and
the phone remote; the owner could still post the map inside; a visits refresh found the village
and its map; opening revoked everything and read back as open.

**Not verified:** a second person (one login cannot play two); a regular member being refused;
the Settings block, the people row and the visiting view in the running app (component tests
only); the map being published by the running app.

## Built: part 2, Act (2026-11-20)

Plan: `docs/superpowers/plans/2026-11-20-team-villages-act.md`. Section 5 is built. Differences:

- **This Mac's key is a login-Keychain key found by its label, not marked non-exportable.** The
  Keychain's own access list protects it (another app asks the user); an agent the user lets into
  the Keychain could export it. The design asked for a key that cannot be exported.
- **The owner learns what a teammate did from a line in Settings › People** (the last action),
  not from a notification or the builder's briefing. The thread on the board is the record.
- **The remote logic serves the village whenever Board link is on.** The phone remote's switch
  and its pause now decide about the owner's phones only (`set_phones_on`).
- **A visit never makes a key.** This Mac's key is made when it first asks to be paired.
- **Acting re-reads the thread first** and refuses when the wait is no longer the one the panel
  showed, before anything is signed.
- **A teammate has one Mac paired per village**; pairing another replaces it.
- **The first time a Mac listens to a board it starts at the newest event**, so something posted
  in the seconds before its listener is up is missed (seen once in the real run: a pairing
  request). After the first event it resumes from its saved place.

**Fixed after the whole-change review:** taking away comes first and does not wait for the
board (removing an invite removes the key before the revoke is tried; lowering a level lowers
the key at once); the invites in settings can only lower or remove a key, never raise it (a
level rises only when the owner raises it in People or pairs a Mac); whose login may answer a
pairing is read from the board's grant when the ticket opens, not from settings; the visitor's
panel treats "sent" as belonging to one wait, so a builder that asks again can be answered, and
it stops polling after two minutes.

**Known and left:** a visitor's panel can be shown "Sent" by someone posting a look-alike action
with that Mac's public key id (never "Done": results must be the owner's); an invited teammate
can ask to pair a key that is already another person's; the level on Confirm is the one from
when the ticket opened; another process of the same user could plant a key under this Mac's
label before first use.

**Verified on the real board** (`real_mate_run`, scratch board, one login playing both sides, the
owner's phone remote off): the owner opened a pairing in `v/<owner>/pair`; the visitor found the
ticket by the code, posted its request, and both sides showed the same check number; after
Confirm the map named the key as trusted; the visitor's Allow for a waiting builder was applied
and its panel showed the result; lowered to Helper, the next Allow was refused and nothing was
applied. The Mac key was made, used and removed in the real Keychain (`keychain_key_round_trip`).

**Not verified:** two people on two Macs (the pairing rule "only the invited person's login" was
exercised with the same login on both sides, so a wrong login being turned away is unit-tested
only); the screens in the running app; a real agent session answered by a teammate (the run used
the simulated session behind the same interface).
