# Ideas backlog

Parked on 2026-11-10 from a product brainstorm. Nothing here is decided: the owner will go
through it to keep or drop each one. Already built from the same list: elixir that drives
decisions (forecast, reserve, stand-ins) and app-wide sounds (Settings › Sounds).

## Review and merging

- **Inspection (in-app review).** The briefing shows only line counts per file (`git.rs` reads no
  contents). A real diff viewer: split view, revert one hunk, then **Accept → commit**. For
  sessions in their own worktree, **Accept → merge branch**, since `coc/…` branches pile up today
  and are merged by hand. Review is the bottleneck once 3–4 agents run, so this lifts everything else.
- **Clash detection.** Two builders in one compound touching the same file: crossed swords
  between their tents and a "Clash" item in the queue. Cheap once Inspection exists (per-session
  numstat is already there), and it is what the product's name promises.

## Gamification tied to real signal

XP is volume-based today (Accept = XP), which rewards starting more agents: the opposite of Focus.

- **Unblock speed.** XP or streaks for answering a "needs you" quickly. Idle builders waiting on
  the owner are the real waste.
- **Builder veterancy.** Per builder and agent/model: accept rate, average time, discard rate.
  Ranks or chevrons on the portrait. It also shows which agent is good at what.
- **Achievements, kept rare.** About 15: first merged worktree, three agents finishing clean
  together, a day with an empty queue.
- **Levels that unlock something.** Today a level only grows the house. Unlock village cosmetics
  (banners, wall styles, a forge) so XP means something.
- **Sounds for XP and level-ups.** Settings › Sounds now exists; adding moments is cheap.

## Ambient and delight

- **Weather and day/night from state.** Night while nothing runs, a storm cloud over a compound
  with a stuck session, sun when the queue is empty.
- **Optional village ambience.** A quiet background bed under the event sounds.
- **Menu bar mini-village.** Queue count and a status dot per workspace, Allow/Deny from the
  dropdown, without the full window.

## Launch (Product Hunt, git-trends)

- **Daily "Raid report" card.** End of day: what shipped, lines changed, time builders waited on
  you, elixir spent, as a shareable village image. Saved locally as a PNG, never uploaded.
- **Streamer mode.** Hide paths, task text and names for recordings and demos.

## Later, or worth a debate

- **Pipelines.** "When Claude finishes, Codex reviews it" as a drag-to-chain blueprint; reusable
  task templates (write tests, fix lint, review) as blueprint scrolls.
- **Watchtower.** CI and PR status through the owner's own `gh` login; a failing check becomes a
  raid to send a builder to. Runs into the no-network stance, so it would need to be opt-in.
- **Session replay.** Scrub through what an agent did, tool call by tool call.
- **Phone approvals** and **shared team villages.** Both big, and both clash with the privacy
  model. Probably skip for now.
