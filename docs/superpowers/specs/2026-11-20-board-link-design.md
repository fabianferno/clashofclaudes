# Board link: the village on Vercel Board (design)

Date: 2026-11-20. Status: project 1 built (2026-11-20), plan `docs/superpowers/plans/2026-11-20-board-link.md`.

**Built.** Checked against the real board (`coc-spike`, Vercel CLI 66.4.0) with the worker and the
real CLI (`real_board_round_trip`, an ignored test): one session went working, wants a decision,
working, finished, accepted, and the board showed one root (edited to lead with the title), the two
replies, and the labels ending in `coc.state=closed`, `coc.outcome=accepted`. **Not yet checked by
hand in the running app:** the Settings › Team section and the workspace switch (covered by
component tests only), quitting with a session alive, and signing out mid-session.

Differences from the text below:

- The glue between the worker and the app is its own file, `src-tauri/src/board/app.rs`.
- Nothing is published until one `vercel board whoami` has succeeded (at launch, when Settings ›
  Team opens, or on Check again), because the channel needs the owner's Vercel username.
- The workspace switch does not show the channel's name.
- A session closed before it finished gets no `coc.outcome`.
- Closes for a board being left, or a workspace no longer shared, are retried like other writes.
- `BOARD_PROFILE` and `BOARD_URL` are given only once the board's URL is known.
- A close that arrives without an outcome waits 2 seconds for one (the session manager reports a
  removal before the command knows whether it was accepted or discarded).
- A close on a board being left is given up after 5 failed tries, so that board cannot hold up
  the new one.
- At launch the app keeps looking for the board (5 s, doubling to 5 min) while the failure may
  pass by itself; reaching it again restarts a worker that had stopped for a missing login.

## Why

The product is moving from one person's village to team villages: people invite others, see each
other's builders, and act on them (hand over a task, answer a question, allow a tool call), also
from a phone. That needs a shared place every village reports to and listens on.

[Vercel Board](https://vercel.com/docs/board) (experimental, free for now, on every plan) is that
place: a hosted message board with channels, threads, labels, an ordered event log, tasks, and
identity taken from the Vercel team. Using it means no server or account system of our own. The
feature is for people who already have a Vercel team, and it is off until they turn it on.

Privacy is not a constraint on this work (owner, 2026-11-20): the README's privacy claims get
revisited later. Security still is: see Anti-goals.

## The whole road, and what this document covers

Four projects, in this order. Each gets its own design. **This document is project 1 only**, plus
the board layout and label names all four share, so later projects don't have to migrate data.

| # | Project | What the owner gets |
|---|---|---|
| 1 | **Board link** (this document) | Every shared workspace's sessions appear on the team's board, live. Builders' own board posts carry the builder's name. |
| 2 | **Web remote** | A small web app each team deploys to its own Vercel account (owner's choice of 2026-11-20, over one app hosted by us and over Slack). On a phone: the queue, Allow / Deny, answers, follow-ups, with web push. The desktop app starts listening to the board and applies those actions. |
| 3 | **Team village** | Invite people from your Vercel team to your village, visit theirs, and act there as far as your level allows. Acting on another village means messages on the board, never a live terminal (owner's choice of 2026-11-20). |
| 4 | **Shared builders** | Lend a builder to the team; a teammate sends it a task from their own "+ New session". The work runs on the lender's Mac and the borrower follows it from home. The same mechanics let a lead agent feed a village with board tasks. |

### How team villages work (decided with the owner on a clickable mockup, 2026-11-20)

The mockup is kept at `.superpowers/brainstorm/85153-1795115405/content/team-villages-v2.html`
(not in git). These five decisions belong to projects 3 and 4; they are recorded here because they
fix the shared board layout below.

1. **Visit.** One village on screen at a time. Yours is Home. A teammate's is a separate place
   reached from a row of people at the top left, shown with a ribbon ("Visiting Ada's village ·
   you are a Helper here"), a different ground colour and a Home button. Each person's chip shows
   how many of their builders wait.
2. **Three levels.** An invite names a person on the Vercel team, a level and which workspaces.
   *Visitor* sees builders and what they wait for. *Helper* also hands over tasks, follows up,
   answers questions and borrows shared builders. *Trusted* also allows and denies tool calls.
   Visitor and Helper are grants on the board; Trusted is a list kept in the village owner's app,
   because an Allow runs a command on their Mac and any team owner can change a board grant.
   Without an invite a teammate sees nothing of a village.
3. **Lending is per builder.** A shared builder has limits (who, which workspaces, how many
   borrowed sessions at once, an elixir floor) and a switch: *ask me first* (the default: the
   request lands in the lender's queue with Accept / Decline) or *start on its own*. The lender's
   app enforces the limits, whatever the board allows.
4. **The borrower follows from home.** A borrowed session appears in a guest camp in the
   borrower's own village and in their queue, as well as in the lender's village.
5. **The result is a pushed branch.** The borrowed session works in its own worktree on the
   lender's Mac, and its branch is pushed to the shared remote when it finishes. The borrower
   reviews the summary and accepts.

A shared builder uses the lender's Mac, repository, agent login and elixir. The borrower never
gets a terminal.

Project 1 on its own gives visibility only: the village can be read from any machine with
`vercel board read`, and agents that use the Board skill see what the other builders are doing.
Answering from a phone arrives with project 2.

## Goals

1. One switch in Settings connects the app to a board on the owner's Vercel team, using the
   `vercel` CLI and login they already have. The app never sees or stores a token.
2. Each workspace has its own "share on the board" switch, off by default.
3. Every agent session in a shared workspace is one thread on the board, and the thread shows the
   session's current state and what it waits for, within a few seconds of the change.
4. Agents started in a shared workspace write to the board under their builder's name
   ("barbarian via fabian") when they use `vercel board` themselves.
5. A board that is slow, down, rate-limited or signed out never slows, blocks or breaks a session.

## Non-goals (in this project)

- Reading the board. The app only writes in project 1; listening (`vercel board tail`) starts in
  project 2, with the first thing that needs it.
- Any action coming from the board into the app (allow, deny, answer, follow-up, tasks).
- Drawing other people's villages.
- Slack, GitHub or Linear sync.
- Telling agents about the board in their instructions. They get the environment (goal 4) and
  nothing else; whether a builder uses the board is up to the owner's own skills and prompts.
- Publishing plain terminals, terminal output, or a session's history from before sharing was on.
- Managing the board's grants from the app. Whoever the team's grants let in can read the village.

## Anti-goals (would make this a failure even if it works)

- **A session waiting on the board.** No call to `vercel` may sit on the path that handles agent
  status, permission prompts or terminal output.
- **Two villages for one team by accident.** The board the app writes to is the one named in
  Settings, never one picked from the workspace's own `.vercel/project.json`.
- **Duplicate or stale threads**: two roots for one session, or a thread that says "working" long
  after the session closed.
- **Laying ground for unsafe remote approval.** An agent runs with its owner's `vercel` login, so a
  message written "by fabian" may have been written by one of fabian's agents. Nothing in this
  layout may assume that a message from a team member is a decision from a person. (Project 2
  accepts actions only from the web remote's own project identity, which an agent cannot use.)

## Constraints

- Tauri 2, macOS 13+, Rust backend. No Node runtime in the app, so the JavaScript SDK
  (`@vercel/board`) is not an option on the desktop side.
- The app never edits agent configuration. Environment variables for the session's own process are
  fine (they are how `CODEX_HOME` and the like are already handled in `adapters/`).
- Board limits: 10,000 characters a message; requests are rate-limited per login, and all of a
  login's agents and profiles share that limit (no numbers published).
- Board is experimental: commands, JSON shapes and limits may change.
- Profile names: start with a letter, up to 32 letters, numbers and hyphens.
- Other agents may be editing this repository at the same time (work on `main`, no stash).

## Approaches

**How the app talks to the board**

1. **The user's `vercel` CLI, run as a child process (chosen; my call).** It is the documented
   interface, it carries the login, team choice and token refresh, and the app already treats
   agent CLIs this way (`codex debug models`, `claude auth status`). Cost: the user must have a
   recent `vercel` installed, and each write starts a process (about a second).
2. Board's HTTP API from Rust. No process per write, no CLI needed. But the protocol is not
   documented, the app would have to read the CLI's stored login itself, and an experimental API
   would break us without a version to pin. Rejected for now.
3. A bundled Node sidecar with `@vercel/board`. Adds a runtime to the DMG for no gain over 1.

**Where the web UI lives (project 2; recorded here because it shapes the layout)**

1. A template each team deploys to its own Vercel account (chosen by the owner). It acts as the
   team's project with no stored secret, sits behind Vercel's deployment protection, and can send
   web push from a watcher. The board sees the project, not the person who tapped.
2. One app hosted by us with "Sign in with Vercel". Nothing to deploy and real per-person
   identity, but unconfirmed that a signed-in user's token can act on Board, and it is a service
   the owner would run. Kept as a later step; the template is to be written so it can become this.
3. Slack sync. Dropped by the owner in favour of our own UI.

## Design

### 1. Board layout (shared by all four projects)

- **Board**: a named board on the team, `village` by default (changeable in Settings), created on
  first use with `--ensure`. A board of its own keeps the village out of the team's `General`
  board and lets its grants be changed alone.
- **Channel**: `v/<owner>/w/<workspace>`. `<owner>` is the Vercel username `vercel board whoami`
  reports; `<workspace>` is a slug of the workspace's name, made unique within the owner by adding
  the first 6 characters of the workspace id when two workspaces share a slug. A person's whole
  village is the subtree `v/<owner>/`, so a village can be read, closed or granted as one, and an
  invite to some workspaces is a grant on those channels.
- **Reserved for project 4**: `v/<owner>/builders`, one thread per shared builder
  (`coc.kind=builder`, `coc.builder`, `coc.agent`, `coc.lend=ask|auto`), which teammates' apps read
  to fill their "+ New session" picker. A request to a builder is a board task in the workspace's
  channel (`coc.kind=request`, `coc.builder`); the lender's app claims it, and the task's thread
  becomes the session's thread. Nothing is written there in project 1; the `w/` level exists so a
  workspace named "builders" cannot collide with it.
- **Thread**: one per agent session. The root is posted when the session starts (or, for a session
  already running when sharing is turned on, at that moment).
- **Author**: the app writes every status message as the profile `village`
  ("village via fabian"). Builders' own posts (section 4) use a profile made from the builder's
  name (lower case, other characters to hyphens, cut to 32, `builder-` put in front when it would
  not start with a letter). Keeping the two apart means an agent cannot edit the app's messages by
  accident (a profile can change only what it wrote), and a reader can tell status from chatter.
  (My call, after the reviewer's question.)
- **One person, two Macs**: both write under the same `v/<owner>/`, and workspaces with the same
  name share a channel. That is wanted: it is one person's village. Each install has a random
  village id, written as `coc.host`, so a later project can tell the machines apart, and each app
  only ever updates the threads listed in its own `board.json`. (My call.)

**What may be trusted on the board.** A message's author is checked by Vercel, and nobody can edit
another person's message. Labels are weaker: anyone with the label permission in the channel can
change them on any message. So labels are an index for finding and filtering threads, never
evidence. Anything a later project acts on (which prompt is open, what it asks) must be read from
the text of a message written by the village's owner, and an action must name the `since` it
answers. An owner's own agents share the owner's login and so can write as the owner; that is
accepted, because an agent able to run `vercel` already has a shell on that Mac.

Labels on the thread's root. Names under `coc.` are ours; nothing else is set.

| Label | Values | Meaning |
|---|---|---|
| `coc.kind` | `session` | Marks a village thread (later: `builder`, `request`) |
| `coc.state` | `starting`, `working`, `needs_you`, `finished`, `stuck`, `paused`, `closed` | The session's state. `ended` sessions that are not paused show as `stuck` or `closed` as the app already treats them |
| `coc.wait` | `decide`, `answer`, `review`, `stuck`, or absent | Why it waits on its owner: the queue's own four reasons (`queue.rs`) |
| `coc.agent` | `claude`, `codex`, `opencode`, `antigravity`, `grok`, `custom` | The agent |
| `coc.builder` | the builder's profile name | Whose session it is (the root's text carries the display name) |
| `coc.host` | the install's random village id | Which Mac runs it |
| `coc.session` | the session id | Finds the thread again |
| `coc.since` | the session's `state_since` (ms) | Names the prompt or state a later answer refers to |
| `coc.outcome` | `accepted`, `discarded`, on closed threads | How it ended |

Reserved for project 2 and not written in project 1: replies carrying `coc.do`
(`allow`, `deny`, `answer`, `followup`) with `coc.since`.

### 2. What gets written, and when

Only state changes cause writes. Terminal output never does.

| Moment | Write |
|---|---|
| Session starts in a shared workspace | Post the root: builder, agent, and the task (or "No task given"). Labels as above |
| State changes | Set `coc.state`, `coc.wait`, `coc.since` on the root |
| Enters "wants a decision" | Also reply: the tool call it asks about (`Bash: npm test`) |
| Enters "asking you" | Also reply: each question with its numbered options, or the reason text when the agent gave no options |
| Enters finished | Also reply: the agent's last reply, and the names of the files changed since the session started (up to 20, then "and N more") |
| Enters stuck | Also reply: the reason |
| Quit with the session alive | `coc.state=paused` |
| Closed (Accept or Discard) | `coc.state=closed`, `coc.outcome` |
| The agent names the conversation (terminal title) | Edit the root once to lead with that title |

- Text longer than the limit is cut to fit with "… (cut)".
- Each reply uses `--idempotency-key coc-<session>-<state_since>-<wait>`, and the root uses
  `coc-<session>-root`, so a retry never posts twice.
- A state that lasts under 2 seconds is not published (a builder flickering between working and
  waiting writes once, with where it settled).
- **Settings › Team › Share details** (on by default) controls whether the task, the tool call,
  questions, the last reply and file names are written. Off: roots say only builder and agent, and
  replies say only "Wants a decision", "Asking you", "Finished", "Stuck".

### 3. The publisher (Rust)

A new module, `src-tauri/src/board.rs`, in the shape of `notify.rs` and `tray.rs`: pure functions
that are unit-tested, and a thin runner around them.

- **Pure**: channel and profile slugs; the labels and texts for a `SessionInfo`; and
  `plan(previous, now) -> Vec<Write>`, which turns what the board last got for a session and the
  session's new state into the writes above.
- **Runner**: one worker thread with a queue. The place in `lib.rs` that already fans a session
  update out to notifications and the menu bar also hands it to the publisher, which only stores
  the newest `SessionInfo` per session and returns. The worker drains them in order, one `vercel`
  call at a time.
- **Calls**: `vercel board post|reply|label|edit … --json --name <board> --scope <team> --as
  village`, with the working directory set to the app's data folder so no workspace's
  `.vercel/project.json` is picked up. The `vercel` binary is found with `platform::which` on the
  login shell's PATH, like the agents.
- **Memory**: `board.json` beside the settings maps session id → root message id, the last
  published state and `since`. It is what makes restarts and retries exact. Entries go when their
  thread is marked closed.
- **Failure**: a failed call is retried with a growing wait (2 s, doubling, up to 5 min); writes
  for the same session collapse to the newest while waiting. After a sign-out or a missing CLI the
  worker stops calling and Settings shows why, until **Check again**. Nothing is shown in the
  village for a failed write.
- **Launch**: for each entry in `board.json`, publish the session's present state (restored
  sessions are paused; ones that are gone are marked closed).
- **Quit**: the worker gets the time the existing shutdown grace allows to mark live sessions
  paused; whatever does not make it is fixed on the next launch.
- **Unsharing a workspace or turning the feature off**: its open threads are marked closed with
  no outcome, then nothing more is written. Threads are never deleted. The `board.json` entries of
  sessions still alive stay, marked unshared, so **sharing again reopens the same thread** (its
  state labels are set afresh) instead of posting a second root.
- **Changing the team or the board name**: the old board's open threads are marked closed first
  (best effort), every entry is dropped, and live sessions get new roots on the new board. Entries
  record which board they belong to.

The CLI sits behind a small trait so tests use a fake that records calls.

### 4. Builders on the board (session environment)

A session started in a shared workspace gets, in its own process environment only:

- `BOARD_PROFILE=<builder profile>`
- `BOARD_URL=<the board's URL from whoami>`

So an agent that runs `vercel board …` itself (the owner has installed the Board skill, or says so
in a task) writes to the same board under its builder's name. Controlled by **Settings › Team ›
Builders write under their own name**, on by default while the feature is on. Sessions resumed
after a restart get it too.

### 5. Settings and workspace UI

**Settings › Team (Vercel Board)**, a new section:

- **Connect this village to Vercel Board** (off by default).
- A status line once on: "Signed in as fabian · team acme · board village", from
  `vercel board whoami --json`; or what is missing, with copyable commands in the Town Hall's
  style (`npm i -g vercel`, `vercel login`) and **Check again**. An installed `vercel` without the
  `board` command counts as "update the Vercel CLI".
- **Team**: the teams the login has, default the login's default team. **Board name**: `village`.
- **Share details** and **Builders write under their own name** (above).
- **Share new workspaces** (off): whether a workspace added later starts shared.
- The last error, if any, and when the board was last written.

**Workspace panel**: a **Share on the team board** switch per workspace, shown only while the
feature is on, with the channel name under it (`v/fabian/w/clashofclaudes`).

**Data**: `Settings` gains `board: BoardSettings { enabled, team, name, share_details,
session_env, share_new }` (all with defaults, so old data loads); `Workspace` gains
`board_shared: bool`.

### 6. Docs

- README › Privacy gains one factual line: with the Team switch on, shared workspaces' session
  states (and, with Share details, tasks, tool calls, replies and file names) go to Vercel Board
  through the user's own `vercel` CLI. The rest of that section is left for the owner's later
  pass. (My call: the README must not be false the day this ships.)
- README gains a short **Team (Vercel Board)** section.

## Spike results (2026-11-20, Vercel CLI 66.4.0, scratch board `coc-spike` on a Pro team)

Run with `npx vercel@latest`, because the Mac's global `vercel` (50.18.2) has no `board` command.

- **CLI version.** `board` needs a newer CLI than many people have installed. The app checks
  `vercel board --help` and says "update the Vercel CLI" when it is missing.
- **Output.** With `--json`, the result is one JSON document on stdout. stderr carries other lines
  (a `<claude-code-hint …>` tag), so parse stdout only. Exit code 0 on success, 1 on failure.
- **Success shapes.** `post` and `reply`: `{"message":{id, channel, text, re, thread, labels,
  by:{actor, principal, profile}, author:{handle, name, verified}, createdAt, …},
  "outcome":"posted"}`. `label` and `edit`: `{"message":{"id"},"outcome":"labeled"|"edited"}`.
  `whoami`: `{actor, principal, handle, profile, can, board}`; `handle` is the `<owner>`, and
  `board` is the URL for `BOARD_URL`. `vercel teams ls` lists the teams.
- **Failure shape.** `{"status":"error","reason":…,"message":…,"retryable":bool,
  "data":{"error":{"code":…,"status":…}}}`. Use `retryable` and `reason` to decide between
  retrying and stopping. The document also holds `feedback` and `next` fields addressed to coding
  agents; the app ignores them.
- **Idempotency.** Posting again with the same `--idempotency-key` returns the first message
  (same id), so retries are safe.
- **Profiles.** `village` can label and edit its own root in a later process. Another profile's
  `edit` fails (`permission_denied`, code `message_not_owned`), but another profile's `label` on
  that root **succeeds**: this confirms labels are an index, never evidence.
- **Removing a label** is `--unset <key>`; `key=` with no value is refused.
- **Session environment.** `BOARD_URL` plus `BOARD_PROFILE`, from an unrelated folder, posts to the
  right board as `fabianferno/wizard`.
- **Pace.** A write takes about 2 seconds through `npx` (process start included). 25 writes back
  to back were all accepted, so no limit was reached; the real limit is still unknown. The worker
  runs one call at a time, which is already under that pace.
- **Following a village (projects 2 to 4).** `vercel board tail v/ --json` and a whole-board `tail`
  both deliver events from every channel, one JSON line each (`cursor`, `type`, `payload`,
  `message`). But `vercel board read v/` fails: reading a subtree at once is not supported yet
  (`not_supported`, 501). A late-joining app therefore lists channels (`channels --json`) and
  reads them one at a time, then tails from the cursor.
- **Tasks (project 4).** `tasks create` with our labels, `tasks claim` and `tasks complete` work
  as documented; the state shows as the label `board.task`.

Still open: whether a Hobby (single-person) team can use named boards and invite anyone (the
spike's team is Pro), and whether `BOARD_URL` wins inside a folder linked to a *different* team.
Neither blocks project 1.

## Left to the builder

- Names of functions, the exact wording of board messages and Settings copy.
- How the file list for a finished session is taken (the existing `review()` has it).
- The worker runs one call at a time; no extra pacing unless a rate-limit error shows up.
- Test layout, following `notify.rs` and `tray.rs`.

## Testing

- Rust unit tests for slugs, labels, texts, cutting to the limit, and `plan()` for every state
  change in the table, including flicker, restart and unshare.
- Runner tests with the fake CLI: ordering, collapse while failing, retry timing, idempotency keys.
- Vitest for the Settings section and the workspace switch.
- By hand, on a real team: start, wait on a decision, answer, finish, accept; quit and relaunch;
  sign out of `vercel` mid-session; read the result with `vercel board read v/<owner>/`.
