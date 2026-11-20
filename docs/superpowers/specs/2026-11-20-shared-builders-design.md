# Shared builders: lend a builder, borrow a teammate's

Date: 2026-11-20. Project 4, the last of the roadmap in `2026-11-20-board-link-design.md`. It
builds on team villages (`2026-11-20-team-villages-design.md`: invites, paired Macs, levels,
visiting, the village map) and on the phone remote (`2026-11-20-web-remote-design.md`: signed
actions, prompt blocks, results). Read those first.

## Intent

A teammate has an idle builder and a repository on their Mac; you have a task for it. Today you
ask them in chat and they start it for you. With this project you hand the task to their builder
from your own app, it runs on their Mac in a worktree of its own, you follow it and answer its
questions from your village, and when it finishes its branch is pushed for you to pick up.

Decided with the owner on the mockup (2026-11-20): lending is per builder, with limits; a borrowed
session shows in a guest camp in the borrower's own village; the result is a pushed branch.
Decided on 2026-11-20:

- A borrowed builder's prompts are answered **by level**: the borrower answers its questions and
  sends follow-ups; Allow / Deny goes to the lender unless the borrower is Trusted there.
- **A borrow starts on its own by default, and the lender is notified.** "Ask me first" is an
  optional switch per builder (the mockup had it as the default). It covers the first task only:
  follow-ups go straight to the builder. The owner chose this once it was clear that accepting
  shows one message, and that what limits a borrower is who is lent to, the level rule for
  Allow / Deny, and the worktree.

## Goals

1. **Lend.** The owner marks a builder as lent, to everyone whose Mac is paired or to chosen
   people, for all shared workspaces or chosen ones, with an elixir floor. Borrows start on their
   own and notify the lender; "ask me first" can be turned on per builder.
2. **Borrow.** From their own app, a Helper or Trusted teammate picks a lent builder and one of
   that owner's workspaces, writes a task, and sends it.
3. **Run.** On the lender's Mac the task starts as an ordinary session of that builder, in a new
   worktree on a branch of its own, cut from `origin`'s default branch. With "ask me first" it
   starts when the lender accepts.
4. **Follow.** The borrower sees the session in a guest camp in their own village and in a list
   of their borrowed builders, answers what their level allows, and sees when it finishes.
5. **Hand over.** When it finishes, the lender's Mac pushes the branch to the repository's
   `origin` and says so in the thread. The borrower marks it done, which closes the session.
6. The lender's Mac enforces every limit, whatever the board allows. A request counts only when
   signed by a Mac the lender paired.

## Non-goals (this project)

- A lead agent feeding a village with tasks (the roadmap's "same mechanics"): later.
- More than one session per builder at a time. A builder already has at most one live session in
  this app; a lent builder that is busy refuses. So the mockup's "how many at once" limit is
  always one, and is not a setting.
- Attachments and images with a borrowed task.
- The borrower stopping a running session, reading its terminal, or reviewing its diff. They get
  the summary and the branch.
- Merging, opening a pull request, or deleting the branch. The branch is the handover.
- Lending a workspace that is not a git repository, has no commit, or has no `origin` remote.
- Borrowing, or pressing Done, from the phone remote (it would mean redeploying the remote).
- Borrow requests and borrowed sessions in the Dock badge and the menu bar. They get their own
  lists in the window and a notification.

## Anti-goals

- **A task starting on someone's Mac that its owner's Mac did not check.** The board says who
  posted; only a paired key's signature says who asked.
- **Lending without knowing what it means.** Turning lending on for a builder says, in place: a
  teammate's words will run on this Mac, with your logins, without anyone here looking first.
  "Ask me first" says that it shows the first task only.
- **A request that runs twice, or long after it was asked, or in another workspace than the one
  it was posted in.**
- **Pushing anything but the borrowed work**: another branch, the lender's unpushed commits, or
  over an existing branch.
- **A borrower approving commands above their level** because the session is "theirs".
- **Work lost on the lender's Mac.** A borrowed session's worktree and branch stay until the
  branch is on `origin`, or the lender removes them.
- **The lender's own work disturbed.** A borrowed session never runs in the workspace's own
  folder; it gets its own worktree.

## Known limits, to be said in Settings and the README

- **A borrowed task is a teammate running an agent on your Mac, with your logins, your
  repository and your elixir.** Lend only to people you would give that. "Ask me first" shows you
  the task before it starts; it does not make the task safe.
- **The push uses your git credentials** and goes to the repository's `origin`.
- Everything in the earlier projects' known limits still holds (who can deploy the phone remote;
  the owner's agents can reopen the village; a paired Mac's key is an ordinary Keychain key).

## Approaches

**How a request travels**

1. **A signed message, like an action (chosen; my call).** The borrower's Mac posts a root in the
   lender's workspace channel, signed with its paired key; the lender's Mac judges it and replies
   with a result. Same listener, same judge shape, same "applied once".
2. Vercel Board's task primitives (create, claim, complete). They add a state the board keeps,
   but nothing the lender's Mac may trust, and a second vocabulary beside results. Rejected.

**Where the borrowed work runs**

1. **A new worktree on a new branch (chosen by the owner on the mockup).**
2. In the workspace's own folder. It would mix a teammate's work into the lender's. Rejected.

**Who answers its prompts:** by level (chosen by the owner). Lender-only and borrower-always were
offered and declined.

## Design

### 1. Lending (the lender's Settings)

- Settings › Team › People gains **Lent builders**: per builder a switch, and when on:
  - **To**: everyone whose Mac is paired, or chosen people (from the paired ones).
  - **Workspaces**: all shared workspaces, or chosen ones. Only workspaces that are git
    repositories with a commit and an `origin` remote can be chosen; the others say why not.
  - **Elixir floor** (percent, default the app's elixir reserve): below it, requests are refused.
    "Below" is the rule the window already uses for low elixir (the least left across the
    agent's windows, `src/state/elixir.ts`), ported to Rust with the same test cases. A reading
    older than an hour, no reading, and custom agents count as enough.
  - **Ask me first** (default off): the first task waits for Accept. Its hint says follow-ups do
    not.
- The record of what is lent (builder, to which keys, for which workspaces, floor, ask-first)
  lives in the Keychain item beside the paired keys. Settings keeps a copy for display; as with
  levels, the settings file can only make it stricter. Turning lending on or widening it happens
  only from this screen.

### 2. What the lender's map says

The village map (`v/<owner>/village`) gains `lend`: for each lent builder, its profile and name,
the workspace slugs it may work in (null: all shared), and the key ids it is lent to (null: every
paired Mac); at most 12 entries. A visitor's app shows a builder as borrowable when its own key
is among them. A session started for a borrower carries `by` (the borrower's key id) in its map
entry, and borrowed sessions are the last to be dropped when the map is too big.

### 3. The request

- Posted by the borrower's Mac, through its own CLI, as a new thread root in the lender's
  workspace channel (a Helper's invite already lets them post there), labelled `coc.kind=borrow`.
- It must be posted in the channel of the workspace it names (`v/<owner>/w/<workspace>`).
- Text, one JSON object: `{ v:1, builder, workspace, task, at, nonce, key, sig }`; `at` is when
  it was signed (ms).
- Signed bytes, lines joined by `\n`: `coc-borrow-1`, the lender's host id (from their map),
  `builder`, `workspace`, SHA-256 hex of `task`, `at`, `nonce`. Same signature form as an action.
- The whole message is at most 9,000 characters (the board's limit is 10,000).

### 4. The lender's Mac

Hears the request on its listener and takes it only when all hold:

1. the key is paired here, and its level is Helper or Trusted;
2. the signature verifies; its signed time is within the last 24 hours and not in the future by
   more than 5 minutes; its nonce was not seen before (borrow nonces are kept for 24 hours in the
   Keychain record, where an agent on this Mac cannot erase them);
3. it was posted in the channel of the workspace it names, and this Mac's own record lends that
   builder to that key, for that workspace;
4. the workspace is shared, lendable (git, a commit, `origin`), and the builder exists;
5. the builder has no live session;
6. the builder's agent has elixir above the floor (no reading counts as enough).

Then:

- **By default it starts**, and the lender gets a notification: "bob borrowed Wizard in shop",
  with the task's first line.
- **With ask me first:** an entry in a **Requests** list above the lender's queue: "bob asks to
  borrow Wizard in shop", the whole task, **Accept** and **Decline**, and a notification. It
  expires after 30 minutes. Accepting checks 5 and 6 again.
- **Starting:** `git fetch origin`, then a worktree at the app's usual place on a new branch
  `borrow/<slug of the handle>/<slug of the task>-<4 hex characters>` cut from `origin`'s default
  branch (never from the lender's local state, whose unpushed commits are not the borrower's to
  receive); slugs come from the app's `git::slug`, and an empty one becomes `task`. Then the
  builder's session there with the task, as "+ New session" would start it. The branch name is
  recorded with the session and is the only thing ever pushed for it.
- It answers under the request with one result message, edited as things move: `waiting`, then
  `started`, `declined` or `expired`; or at once `busy`, `low` (elixir), `refused` (anything in
  1 to 4), `failed` (the session could not start; the reason in words). The borrower's app finds
  the session by `by` in the lender's map.
- The session is published like any other. Its map entry has `by`. In the lender's own village it
  is drawn as usual with a mark saying who it works for, and its briefing says so.

**Its prompts.** The lender (and their phones) may do everything. For a borrowed session,
`answer` and `followup` are taken only from the borrower's key (its `by`); `allow` and `deny`
only from the borrower's key when it is Trusted. Other invited teammates can look and cannot
act on it. (On the lender's own sessions the rules of team villages are unchanged.) `by` is kept
with the session and survives pause, resume and restart.

**Finishing.** Each time a borrowed session reaches Finished, the lender's Mac pushes the
recorded branch, and only it: `git push origin refs/heads/<branch>:refs/heads/<branch>`, never
forced, off the session's path. The first push is refused when that name already exists on
`origin`. It adds a reply to the thread: "Pushed to origin as `<branch>`", or why not. A failed
push is tried again when the lender opens the session, and the lender's briefing says the branch
is not pushed yet.

**Done.** One new action, `close`, offered in the prompt block of a finished borrowed session
and taken only from the key in the session's `by` (the lender closes it in their own app, as any
session). It closes the session on the lender's Mac as accepted. The worktree is removed only
when it has no uncommitted changes and its tip is the one on `origin`; otherwise it stays, and
the lender's app says where. The branch is never deleted, locally or on `origin`.

### 5. The borrower's app

- **Borrowing starts from a visit.** In a village you visit, clicking a workspace's house opens
  **Borrow a builder here**: the builders lent to this Mac for that workspace, a task box, Send.
  ("+ New session" in this app belongs to a workspace, so the lender's workspace is where it
  goes; the mockup had it in the borrower's own form.) It shows what came back: "Started",
  "Waiting for ada to accept", "ada declined", "The request expired", "Wizard is busy", "ada's
  elixir is low", or the lender's Mac's reason.
- **Guest camp.** Sessions in the maps of villages you can visit whose `by` is this Mac's key
  are drawn in your own village in one extra compound, the guest camp. It has a stored place of
  its own (in settings, placed like a new workspace the first time, and counted in every
  collision check), cannot be built in, and is not there when empty. Each borrowed builder
  stands in it with its owner's handle.
- **Borrowed builders list.** Beside your queue, a short list of your borrowed sessions: what
  each waits for, or that it is finished. Opening one shows the visited builder's panel (made to
  work from home as well as during a visit): its question and the buttons your level allows, and
  for a finished one the summary, the branch name, and **Done**. A notification tells you when a
  borrowed builder starts waiting or finishes.
- Requests sent and their results are remembered locally, so "Waiting for ada" survives a restart.

### 6. Failure handling

| What | Then |
|---|---|
| The lender's Mac is asleep | The request waits on the board; it is judged on wake. The borrower sees "Waiting for ada's Mac" |
| A request older than 24 hours when heard | `refused` (stale), so nothing starts by surprise long after it was asked |
| The same request heard twice | Taken once |
| The push fails (no access, offline) | Said in the thread; tried again when the lender opens the session; the worktree stays |
| The lender closes or discards the session | It leaves the borrower's camp and queue; the thread says closed |
| The lender unpairs the borrower, lowers them to Visitor, or stops lending the builder | Running sessions go on (the lender can stop them); new requests and the borrower's actions are refused |

## Testing

- Rust unit tests: the request's signed bytes and parse; every accept and refuse rule failing
  alone; ask-first accept, decline and expiry; the branch name; the push step with a fake git;
  `close` allowed only for the borrower's key and the lender's phones; the map's `lend` and `by`;
  lending records only loosened from the screen.
- Frontend tests: Lent builders in Settings; borrowed builders and their workspaces in the
  new-session form and each result's wording; the guest camp's input; borrowed sessions in the
  queue; Done.
- Real run on the scratch board, one login playing both sides (as in team villages): lend a
  builder, borrow it with a signed request, see it start in a worktree of a throwaway repository
  with a local bare `origin`, answer a prompt, finish, see the branch pushed, send Done.
- Two people on two Macs is the owner's check.

## Left to the builder

- Where the lending record lives in the Keychain item and how settings and record are reconciled.
- How the guest camp's compound is placed and drawn with the existing layout code.
- How the lender's queue shows a borrow request beside its session items.
- The mark on a borrowed session in the lender's village, and the wording of every line above.

## Built (2026-11-20)

Plan: `docs/superpowers/plans/2026-11-20-shared-builders.md`. Differences from the text above:

- **Who a session works for is kept in the board module's own file** (`board-borrowed.json`,
  beside the branch and worktree), not in `SessionInfo`. The record of what is lent and the
  nonces of taken requests are in the Keychain as designed.
- **Low elixir is "at or under the floor", and a floor of 0 is none**, the window's own rule.
- **Borrowing lives in one card at the top right** for both sides: the lender's requests and
  sessions working for teammates (with "Push again"), and the borrower's borrowed builders and
  the answers to their requests. The lender's line "Working for bob" is there, not in the
  session's own Briefing panel.
- **The guest camp's place is kept in the window's local storage**, not in settings. A workspace
  dragged onto it makes the camp find a new place on the next draw.
- **Done closes through the app's own Close**, so the raid report, ships and the board see it as
  an accepted close.
- **The branch suffix is the first four hex characters of the request's nonce** (random in the
  app; a test that builds its nonce from the clock gets `0000`).

**Fixed after the whole-change review:** the app's push runs from the repository's own folder
with every hook off (`--no-verify`, `core.hooksPath=/dev/null`), so a hook the borrowed agent
wrote and pointed git at cannot run outside the Allow/Deny gate; taken nonces are kept for a day
plus the five minutes a request may be signed ahead, so a request cannot be replayed at the edge
of its window; who asked is checked before anything on the lender's Mac is looked at; requests
are judged and started one at a time, and pushes run one at a time; a first push that already
landed counts as pushed.

**Known and left:** the first prompt block of a borrowed session can lack `by` for the moment
between the session starting and the desk recording it; two results written within a second of
each other can lose the second; the visitor's panel offers buttons on someone else's borrowed
session that the lender's Mac then refuses, and does not show the branch name.

**Verified on the real board** (`real_borrow_run`, scratch board, the updated CLI, one login
playing both sides, a throwaway repository with a local bare `origin`, a commit standing in for
the agent's work): the visitor's signed request was heard and taken; the worktree was cut from
`origin` and did not contain the lender's unpushed commit; the visitor read `started`; finishing
pushed that branch and nothing else; a replay was refused as already taken and a request posted
in another workspace's channel was refused; Done removed the worktree and kept the branch.

**Not verified:** a real agent session started for a borrower; the screens, the guest camp and
the borrow card in the running app (component tests, and a test that the scene draws the camp);
two people on two Macs; a push to a real hosted `origin`.
