# Activity houses (replacing XP and levels)

## Why

A workspace's house levels up from XP: a flat 100 per accepted session, with each level costing 1.4x
the last. The house's look stops changing at level 8 (~24 accepted sessions), and the wall stops
growing at level 4. After that, XP keeps going up and does nothing. A busy repo reaches the final
look in a week or two, and from then on its house tells you nothing.

The house should instead show **how much the project is shipping right now**: lively when work is
being accepted, settling back to plain when it stops.

## Goals

- A house's look follows its workspace's recent accepted sessions, going up and down over days.
- The workspace panel states recent activity plainly ("Busy · 9 shipped this week").
- Accepting work still has a visible payoff in the village.
- Visitors to a team village see the same house the owner sees.

## Non-goals

- **No lifetime count on a house.** The owner was explicit: activity only.
- No neglected or overgrown look. A quiet house is the plain house (stage 0). That could come later
  with painted art.
- The top bar's global ship counter (`stats.shippedTotal`, today's ships) and the raid report are
  left alone.

## Anti-goals

- A house flickering between looks within minutes or hours. Changes should happen over days.
- A project's walls moving in on its builders when it goes quiet.
- Every existing house dropping to plain on the day of the update.

## Approaches

1. **Ship times on each workspace; the level worked out where it's shown.** *Chosen.* Each workspace
   saves the times its sessions were accepted, keeping 14 days. The village and panel compute
   activity from those times and the current time, so a house quiets on its own with no backend
   timer. The owner's app sends the computed level to visitors.
2. **Read the raid report's log (`raid.json`).** No new data, but that log only keeps 8 days and is
   shaped for the daily report. Tying the two together means a change to one breaks the other.
3. **A backend timer that recalculates levels and sends updates.** Every view agrees by
   construction, but it adds a timer and extra events for a number each view can work out.

## Design

**Data.** `Workspace` gains `ships: Vec<i64>` (ms timestamps, `#[serde(default)]`). `apply_close`
appends `now` when a session earns (same rule as today: an agent session that reached Finished, not
stuck, not discarded) and drops entries older than 14 days. `level` and `xp` are removed from
`Workspace` and from the `CloseOutcome` fields `xpGained` / `levelBefore` / `levelAfter`. The outcome
says it counted as a ship. `xp.rs` and its frontend mirror (`xpNeed`, demo `award`) go away.

**Migration.** The data file version goes from 2 to 3. When an older file loads, each workspace's
`ships` is seeded once from `raid.json`'s accepted sessions for that workspace (the last 8 days), so
houses start at their real activity.

**Activity score.** `score = Σ 0.5^(age / 3 days)` over the workspace's ships. A ship counts half
after 3 days and is effectively gone by 14. Mapping score to house stage (the five existing
paintings):

| Score | Stage | Name | Roughly |
|---|---|---|---|
| < 0.5 | 0 plain | Quiet | nothing in the last ~3 days |
| ≥ 0.5 | 1 banner | Stirring | a ship in the last few days |
| ≥ 2 | 2 wing | Active | ~3 a week |
| ≥ 4 | 3 tower | Busy | ~1 a day |
| ≥ 7 | 4 gold trim | Booming | ~2 a day, sustained |

There is one pure function, `activityOf(ships, now) → { stage, name, shippedThisWeek }`, used by the
scene, the panel and the team snapshot. The frontend re-evaluates it periodically (a slow tick, e.g.
every 10 minutes) so houses change while the app stays open.

**Walls.** `enclosure(...)` no longer takes a level. The bulge count is fixed at today's maximum
(6), so a house's wall shape never changes with activity.

**Panel.** The level line and XP bar are replaced by `<Name> · N shipped this week`, plus a short
line saying the house reflects the last couple of weeks of accepted work. The Town Hall avatar shows
the stage name or nothing, not a number.

**Accepting work.** The orbs still fly to the house and show `+1 shipped`. If the ship moves the
house up a stage, the scene shows it changing (the existing puff, plus the new look). The
"LEVEL UP!" text and notice are removed. The `xp` sound moment becomes "Work shipped", and the
`levelUp` moment is removed. Unknown sound keys in saved settings are ignored.

**Team snapshot.** The map's workspace entry gains `a` (stage 0-4). For apps on the previous version,
`l` is kept and filled with a level that maps to the same stage under the old `houseStage` (0→1,
1→2, 2→4, 3→6, 4→8). New apps read `a` and fall back to `houseStage(l)` when it's missing.

**Copy.** "Accept +XP" becomes "Accept". "(no XP)" becomes "(doesn't count as shipped)" or is
dropped. The tour's `xp` step is renamed (e.g. `shipped`) and its text explains that the house
reflects recent work. The demo workspace starts Quiet, and accepting the demo session moves it to
Stirring, so the tour still shows the house change.

## Left to the builder

The exact names, panel wording, tick interval, puff/animation details on a stage change, and how
tests are reorganised. Thresholds above are a starting point. Tune them if they feel off in a real
village, keeping changes slow (days, not hours).
