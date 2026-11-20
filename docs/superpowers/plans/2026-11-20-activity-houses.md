# Activity Houses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace workspace XP and levels with a house look that follows each workspace's recently accepted sessions.

**Architecture:** Each `Workspace` stores the ms timestamps of its accepted sessions (14 days). One pure function, mirrored in Rust (`activity.rs`) and TypeScript (`village/activity.ts`), turns those times and "now" into a stage 0-4 (the five existing house paintings), a name, and a this-week count. Rust uses it for the close outcome and the team map. The frontend uses it for the house, panel and Town Hall, and re-syncs the scene every 10 minutes so houses quiet down while the app is open.

**Tech Stack:** Rust (Tauri 2, serde), TypeScript, React, Zustand, PixiJS, Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-11-20-activity-houses-design.md`

## Global Constraints

- Score: `Σ 0.5^(age_ms / 3 days)` over ships with `0 <= age`. Future timestamps (clock skew) count as age 0.
- Stage thresholds: score `< 0.5` → 0 Quiet, `>= 0.5` → 1 Stirring, `>= 2` → 2 Active, `>= 4` → 3 Busy, `>= 7` → 4 Booming.
- Ships older than 14 days (`14 * 24 * 3600 * 1000` ms) are dropped whenever a ship is added.
- "Shipped this week" = ships with `now - at < 7 days`.
- A ship = the same rule as today's XP: agent session, reached Finished, not stuck, not discarded.
- No lifetime count on a house. Top bar (`stats.shippedTotal`, "Shipped today") and the raid report are untouched.
- Walls: bulge count fixed at 6, independent of activity.
- Team map: new key `a` = stage. Keep `l` filled with `[1, 2, 4, 6, 8][stage]` for apps on the previous version.
- Sound moment key `xp` stays (saved settings keep working), relabelled "Work shipped". `levelUp` is removed everywhere.
- Data file version becomes 3. Files below 3 get `ships` seeded once from `raid.json`.
- Copy has no "XP" or "level" left when it refers to a house (the top bar's "Village level" stays).

## Review Focus

1. **Upgrading user, raid log empty or missing.** Seeding must leave `ships` empty, bump version to 3, and not crash. Pinned in Task 2 (`seed_with_no_raid_ships_still_bumps_version`).
2. **A file already at version 3 loaded again.** Must not seed a second time and duplicate ships. Pinned in Task 2 (`seed_runs_only_below_version_3`).
3. **A visitor's map from an older owner app (no `a`).** The house must use `l` through the old level→stage mapping. Pinned in Task 4 (`visitInput falls back to l when a is missing`).
4. **Clock skew: a ship timestamp in the future.** It must count as age 0, not inflate past 1. Pinned in Task 1 (both languages).
5. **App left open for days.** The house must drop a stage without any new event. Pinned in Task 4 (`the scene re-syncs on the activity tick`).

---

### Task 1: Activity function (Rust and TypeScript)

**Files:**
- Create: `src-tauri/src/activity.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod activity;`, next to `pub mod xp;` at line 36)
- Create: `src/village/activity.ts`
- Test: `src/village/activity.test.ts` (Rust tests live in `activity.rs`)

**Interfaces:**
- Produces (Rust):
  - `pub const HALF_LIFE_MS: i64 = 3 * DAY_MS; pub const KEEP_MS: i64 = 14 * DAY_MS; pub const WEEK_MS: i64 = 7 * DAY_MS;`
  - `pub fn score(ships: &[i64], now: i64) -> f64`
  - `pub fn stage(ships: &[i64], now: i64) -> u8` (0..=4)
  - `pub fn shipped_within(ships: &[i64], now: i64, span_ms: i64) -> u32`
  - `pub fn legacy_level(stage: u8) -> u32` → `[1, 2, 4, 6, 8][stage]`
- Produces (TS):
  - `export type Stage = 0 | 1 | 2 | 3 | 4;`
  - `export const STAGE_NAMES = ['Quiet', 'Stirring', 'Active', 'Busy', 'Booming'] as const;`
  - `export const DAY_MS`, `WEEK_MS`
  - `export function activityOf(ships: readonly number[], now: number): { stage: Stage; name: string; shippedThisWeek: number }`
  - `export function stageFromLevel(level: number): Stage` (the old `houseStage` thresholds, for visitors' old maps)

- [ ] **Step 1: Write the failing tests.** Both files use the same table (`D = 86_400_000`, `now = 100 * D`):

```ts
// src/village/activity.test.ts
const D = 86_400_000, now = 100 * D;
const cases: Array<[number[], number]> = [
  [[], 0],
  [[now], 1],                          // one today
  [[now - 4 * D], 0],                  // 0.397 < 0.5
  [[now - 2 * D, now - 3 * D], 1],     // ~1.13
  [[now, now - D, now - 2 * D], 2],    // ~2.42
  [Array.from({ length: 8 }, (_, i) => now - i * D), 3],   // daily for 8 days, ~4.09
  [Array.from({ length: 14 }, (_, i) => now - (i / 2) * D), 4], // 2/day for a week, ~7.35
  [[now + 5 * D], 1],                  // future counts as age 0
];
test.each(cases)('activityOf(%j).stage = %i', (ships, stage) => expect(activityOf(ships, now).stage).toBe(stage));
test('names and this week', () => {
  expect(activityOf([now, now - 6 * D, now - 7 * D], now)).toEqual({ stage: 1, name: 'Stirring', shippedThisWeek: 2 });
});
test('stageFromLevel matches the old houseStage', () => {
  expect([1, 2, 3, 4, 6, 8, 20].map(stageFromLevel)).toEqual([0, 1, 1, 2, 3, 4, 4]);
});
```

Rust `#[cfg(test)] mod tests` in `activity.rs`: the same eight `(ships, stage)` cases as `stage_table`, plus `shipped_within(&[now, now - 6*D, now - 7*D], now, WEEK_MS) == 2` and `(0..5).map(legacy_level) == [1, 2, 4, 6, 8]`. Before finishing, check each case's score with a quick calculation and adjust the expected *stage* only if the arithmetic disagrees. Keep the thresholds.

- [ ] **Step 2: Run to verify they fail.**
Run: `pnpm vitest run src/village/activity.test.ts` → FAIL (module not found).
Run: `cd src-tauri && cargo test activity::` → FAIL to compile.

- [ ] **Step 3: Implement both files** to the interfaces above. Score per ship: `0.5f64.powf(((now - at).max(0)) as f64 / HALF_LIFE_MS as f64)`. Thresholds from Global Constraints, as a single `[0.5, 2.0, 4.0, 7.0]` array counted with "how many thresholds score is ≥". `stageFromLevel`: `>=8→4, >=6→3, >=4→2, >=2→1, else 0`.

- [ ] **Step 4: Run to verify they pass.** Same two commands → PASS.

- [ ] **Step 5: Commit.**
```bash
git add src-tauri/src/activity.rs src-tauri/src/lib.rs src/village/activity.ts src/village/activity.test.ts
git commit -m "Activity: score recent ships into a house stage (Rust and TS)"
```

---

### Task 2: Backend data, close outcome, migration, team map, sounds

**Files:**
- Modify: `src-tauri/src/model.rs:56-82` (Workspace), `:98`/`:464` (default version)
- Modify: `src-tauri/src/commands.rs:87` (new workspace), `:683-728` (`CloseOutcome`, `apply_close`), tests at `:1415-1470` and the other `Workspace { .. level: 1, xp: 0 ..}` literals
- Modify: `src-tauri/src/persist.rs` (add `seed_ships`, fix test fixtures at `:96-97`, `:208`)
- Modify: `src-tauri/src/raid.rs` (add `pub fn ship_times(&self) -> Vec<(String, i64)>`)
- Modify: `src-tauri/src/lib.rs:271-273` (run seeding after load)
- Modify: `src-tauri/src/board/snapshot.rs:15-27, :122`, `src-tauri/src/board/snapshot_tests.rs:73`
- Modify: `src-tauri/src/sounds.rs:11, :33-34`
- Delete: `src-tauri/src/xp.rs` and `pub mod xp;` / `use crate::xp;`

**Interfaces:**
- Consumes: `activity::{stage, legacy_level, KEEP_MS}` (Task 1).
- Produces:
  - `Workspace.ships: Vec<i64>` (`#[serde(default)]`; JSON `ships`). `level` and `xp` removed. Old files' `level`/`xp` keys are ignored by serde.
  - `CloseOutcome { shipped: bool, stage_before: u8, stage_after: u8, workspace_id, unfinished, stuck, discarded }` → JSON `shipped`, `stageBefore`, `stageAfter`.
  - `pub fn apply_close(d: &mut AppData, closed: &ClosedSession, now_ms: i64) -> CloseOutcome` (same signature).
  - `pub fn seed_ships(data: &mut AppData, raid: &[(String, i64)], now: i64) -> bool` in `persist.rs`: returns true when it changed the data (version < 3).
  - `MapWorkspace { .., level: u32 /* "l" */, activity: u8 /* "a", #[serde(default)] */, .. }`
  - `sounds::MOMENTS: [&str; 8]` without `levelUp`.

- [ ] **Step 1: Write the failing tests.**
  - `commands.rs`: replace `close_finished_awards_xp_and_stats` with `close_finished_records_a_ship`. `apply_close(&mut d, &closed(true,true,false), 5_000)` returns `CloseOutcome { shipped: true, stage_before: 0, stage_after: 1, .. }`, `d.workspaces[0].ships == vec![5_000]`, stats unchanged from today (`shipped_total 1`, `recent_ships [5_000]`), and JSON keys `shipped == true`, `stageAfter == 1`.
  - New `close_drops_ships_older_than_14_days`: workspace starts with `ships: vec![0, 10 * D]`. Close at `now = 15 * D`. Result `ships == vec![10 * D, 15 * D]`.
  - Update the other three close tests: `earned_xp` → `shipped`, `xp_gained` removed.
  - `persist.rs`: `seed_ships_from_raid` (v2 data with workspaces w1, w2; raid `[("w1", 5), ("w1", 6), ("gone", 7)]` → w1 `[5, 6]`, w2 `[]`, version 3, returns true). `seed_runs_only_below_version_3` (version 3 data → returns false, ships unchanged). `seed_with_no_raid_ships_still_bumps_version` (empty raid → version 3, returns true).
  - `snapshot_tests.rs:73`: fixture workspace gets `ships: vec![5_000]` (build's `now` is 5_000). Assert `w.activity == 1` and `w.level == 2`. Add `map_without_a_parses`: deserialize `{"s":"api","n":"API","l":6}` → `activity == 0`, `level == 6`.
  - `sounds.rs`: whatever test lists the moments now expects 8 without `levelUp`. A saved `{"levelUp": ".."}` is dropped by `normalized`.

- [ ] **Step 2: Run to verify they fail.** `cd src-tauri && cargo test` → compile errors and failing tests.

- [ ] **Step 3: Implement.**
  - `apply_close`: compute `stage_before = activity::stage(&w.ships, now_ms)`. If it earns, push `now_ms`, `retain(|t| now_ms - t < KEEP_MS)`, then compute `stage_after`. Keep the stats lines as they are.
  - `seed_ships`: if `data.version >= 3` return false. Otherwise, for each workspace, set `ships` to the raid times for its id, sorted, keeping only times within `KEEP_MS` of `now`. Set version 3 and return true.
  - `RaidLog::ship_times`: `(workspace_id, at)` for every ship in the file.
  - `lib.rs`: after `persist::load`, `let raid_ships = app.state::<raid::RaidState>().lock().ship_times();` (use the same lock accessor the file already uses). If `persist::seed_ships(&mut data, &raid_ships, now)` returns true, `persist::save(&data_path, &data)` and log, without failing, on error. `AppData::default()` version becomes 3. `persist::load`'s `max(2)` stays.
  - `snapshot::build`: `let a = activity::stage(&w.ships, now);` then `level: activity::legacy_level(a), activity: a`.
  - Delete `xp.rs` and its uses.

- [ ] **Step 4: Run to verify they pass.** `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings` → PASS, no warnings.

- [ ] **Step 5: Commit.**
```bash
git add -A src-tauri/src
git commit -m "Backend: workspaces keep ship times; close reports stage; seed from raid log"
```

---

### Task 3: Frontend types and fixtures

**Files:**
- Modify: `src/api/types.ts:42-58` (Workspace), `:262-274` (CloseOutcome), `:380` (VillageMap workspace), `:427` (SoundMoment)
- Modify: every test fixture that writes `level: N, xp: N` on a Workspace (found with `grep -rln "xp: 0" src`)
- Modify: `src/village/look.ts:70-77, :116-119` (remove `houseStage`, `xpNeed`), `src/village/look.test.ts:40-61` (drop `house_stage_thresholds` and `xp_is_independent_of_look`, now covered by Task 1)

**Interfaces:**
- Produces:
  - `Workspace { ..; ships?: number[]; /** Visited villages only: the stage the owner's app sent. */ stage?: Stage }` without `level`/`xp`.
  - `CloseOutcome { shipped: boolean; stageBefore: number; stageAfter: number; workspaceId; unfinished; stuck; discarded? }`
  - `VillageMap.workspaces[i]: { s; n; l: number; a?: number; c?; p? }`
  - `SoundMoment` without `'levelUp'`.

- [ ] **Step 1: Make the type changes.** Then run `pnpm tsc --noEmit 2>&1 | grep -c error` and record the count. The errors are the consumer list for Tasks 4-6.
- [ ] **Step 2: Sweep the fixtures.** Remove `level: <n>, xp: <n>, ` from Workspace literals in tests. Where a test *meant* a level (e.g. `scene.test.ts:11` takes `level`, `panels.test.tsx:35` has `level: 2, xp: 70`), change it to a `ships` array giving the intended stage, and leave those tests' assertions to the task that owns them.
- [ ] **Step 3: Run** `pnpm vitest run` → expected failures only in the files that Tasks 4-6 own (scene, panels, store, sounds, Briefing, onboarding). Nothing else fails.
- [ ] **Step 4: Commit.**
```bash
git add -A src
git commit -m "Types: workspaces carry ships, close outcomes carry stages"
```

---

### Task 4: The village: house, walls, visitors, tick

**Files:**
- Modify: `src/village/scene.ts:134-138, :220-224, :912-913, :994-996, :1348, :1558` (stage and enclosure calls), `:684-695` (orbs)
- Modify: `src/village/enclosure.ts:43-47, :74`
- Modify: `src/state/visits.ts:50-58`
- Modify: `src/village/VillageCanvas.tsx:125-136` (tick)
- Test: `src/village/scene.test.ts`, `src/village/enclosure.test.ts` (if present, else scene tests), `src/state/visits.test.ts` (create if missing), `src/village/VillageCanvas.test.tsx` (or the nearest existing canvas test)

**Interfaces:**
- Consumes: `activityOf`, `stageFromLevel` (Task 1). Types (Task 3).
- Produces:
  - `export function houseStageOf(w: Workspace, now: number): Stage` in `scene.ts` (or `activity.ts`): `w.stage ?? activityOf(w.ships ?? [], now).stage`.
  - `enclosure(c: Compound, spots: Tile[], seed: number): Enclosure`. The level parameter is gone and the bulge count is `const BULGES = 6`.
  - `export const ACTIVITY_TICK_MS = 10 * 60_000` in `VillageCanvas.tsx`.

- [ ] **Step 1: Write the failing tests.**
  - scene: `buildEntities` with a workspace whose `ships` are `[now]` and `now` passed → house texKey starts `house:1:`. With `ships: []` → `house:0:`. With `stage: 3` and no ships → `house:3:`.
  - enclosure: the same compound and seed give the same walls as calling it twice (determinism), and the wall count does not depend on anything but compound, spots and seed (the old level param is gone, so this is a compile-level change plus one snapshot of wall count for a fixed seed).
  - visits: `visitInput` on a map workspace `{ s, n, l: 6, a: 2 }` gives `stage: 2`. On `{ s, n, l: 6 }` (no `a`) it gives `stage: 3` ("visitInput falls back to l when a is missing").
  - canvas: with fake timers, after `ACTIVITY_TICK_MS` the scene's `sync` is called again with no store change ("the scene re-syncs on the activity tick"). Follow how the existing canvas test mocks the scene. If there is no such test, test a small exported `startActivityTick(sync: () => void): () => void` instead and use it in the component.
- [ ] **Step 2: Run** `pnpm vitest run src/village src/state/visits.test.ts` → the new tests FAIL.
- [ ] **Step 3: Implement.** The `buildEntities` input already has `now`. Inside the scene, the other enclosure/stage call sites use `Date.now()`. Orbs: the float text becomes `+1 shipped`. When `o.stageAfter > o.stageBefore`, add `particles.dust(h, 12, false)` (a bigger puff) instead of the "LEVEL UP!" text. Keep `XP_DELAY_MS` timing.
- [ ] **Step 4: Run** `pnpm vitest run src/village src/state/visits.test.ts` → PASS.
- [ ] **Step 5: Commit.**
```bash
git add -A src/village src/state/visits.ts src/state/visits.test.ts
git commit -m "Village: houses show recent activity; walls fixed; visitors read the stage"
```

---

### Task 5: Panels, notices, sounds, Accept copy

**Files:**
- Modify: `src/panels/WorkspacePanel.tsx:44-45, :93-97`, `src/panels/panels.css:39-40` (drop `.sp-xp` only if nothing else uses it; `QuotaPanel` does, so keep it)
- Modify: `src/panels/TownHallPanel.tsx:28`
- Modify: `src/state/store.ts:156, :175, :343-355`
- Modify: `src/state/sounds.ts:18-29, :94`, `src/state/soundDefaults.ts:14-15`
- Modify: `src/panels/Briefing.tsx:53, :279, :284`
- Test: `src/panels/panels.test.tsx:150-155`, `src/state/store.test.ts:450-476`, `src/state/sounds.test.ts:66-90`, `src/panels/Briefing.test.tsx:55-73, :252`

**Interfaces:**
- Consumes: `activityOf`, `STAGE_NAMES` (Task 1). `CloseOutcome` (Task 3).
- Produces: `closeSound(o: CloseOutcome): SoundMoment | null` returns `'xp'` when `o.shipped`, else null. `Notice.kind: 'ship' | 'info'` (rename `'xp'`, drop `'level'`; update `.notice-level` CSS usage accordingly).

- [ ] **Step 1: Update the failing tests to the new copy.**
  - panels: a workspace with `ships = [0..8].map(i => Date.now() - i * 12 * 3600_000)` (score ~5.9) shows text `Busy · 9 shipped this week`. No `xp-fill` test id.
  - store: notices are `'Discarded — doesn’t count as shipped'`, `'Closed while stuck — not shipped'`, `'Closed — not finished, not shipped'`, and for a ship `['+1 shipped']` with kind `'ship'`. There is no level notice even when `stageAfter > stageBefore`.
  - sounds: a shipped outcome plays `['xp']` once, whatever the stages. `SOUND_MOMENTS` has 8 entries and the `xp` label is `'Work shipped'`, hint `'You accepted finished work'`.
  - Briefing: the button text is `Accept` (title `Close it: the work is done`). Discard titles drop "(no XP)".
- [ ] **Step 2: Run** `pnpm vitest run src/panels src/state` → FAIL.
- [ ] **Step 3: Implement.** Panel box: `<b>{name}</b> · <span>{n} shipped this week</span>` and the hint line `This house shows the last couple of weeks of accepted work. It quiets down when work stops.`. The panel uses `Date.now()` at render. It re-renders on workspace updates, and that's enough here. Town Hall avatar: drop the number (empty `.ol` span) and add `title={name}`.
- [ ] **Step 4: Run** `pnpm vitest run src/panels src/state` → PASS.
- [ ] **Step 5: Commit.**
```bash
git add -A src/panels src/state
git commit -m "Panels and notices: shipped this week instead of XP"
```

---

### Task 6: Tour and demo

**Files:**
- Modify: `src/onboarding/demo.ts:13, :23-24, :143, :219, :253-258, :303-318`
- Modify: `src/onboarding/steps.tsx:4, :92-104`, `src/onboarding/tour.ts:14, :114`, `src/onboarding/TourOverlay.tsx:81`
- Test: the existing onboarding tests (`grep -rln "XP\|award" src/onboarding/*.test.*`)

**Interfaces:**
- Consumes: `activityOf` (Task 1), `CloseOutcome` (Task 3).
- Produces: tour step id `'shipped'` (renamed from `'xp'`). The demo `closeSession` appends `Date.now()` to the demo workspace's `ships` and returns `{ shipped, stageBefore, stageAfter }`.

- [ ] **Step 1: Update the failing tests.** Closing the finished demo session gives `shipped: true, stageBefore: 0, stageAfter: 1`, and the demo workspace has one ship. Step `shipped` copy with a shipped sample: title `'Shipped'`, body mentions the house "livens up". Without a ship: title `'Not shipped this time'`.
- [ ] **Step 2: Run** `pnpm vitest run src/onboarding` → FAIL.
- [ ] **Step 3: Implement.** Copy:
  - review step: "…<K>Accept</K> stands the builder down and counts it as shipped." Unfinished variant: "This session never finished, so closing it doesn't count as shipped."
  - shipped step body: `<>Accepted work counts as shipped, and a house livens up with the work its project ships. It settles back down when work stops. Your <K>Village level</K> at the top left counts every session you ship.</>`
  - not shipped body: `<>Only sessions that finish count as shipped. Accept finished work to liven up its house.</>`
  - demo terminal line: `Review the changes, then accept them.`
  - TourOverlay: `<b>Review</b>, then <b>Accept</b> finished work.`
  - Remove `XP_PER_SESSION`, `award`, and the `xpNeed` import.
- [ ] **Step 4: Run** `pnpm vitest run src/onboarding` → PASS.
- [ ] **Step 5: Commit.**
```bash
git add -A src/onboarding
git commit -m "Tour: the sample house livens up when its work ships"
```

---

### Task 7: Whole-tree check

- [ ] **Step 1:** `pnpm tsc --noEmit` → 0 errors.
- [ ] **Step 2:** `pnpm vitest run` → all pass. `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings` → all pass.
- [ ] **Step 3:** `grep -rniE "\bxp\b|xpNeed|houseStage\(|levelUp|level up|earnedXp" src src-tauri/src README.md docs/*.md | grep -v "notice\|loglevel"` → only the `xp` sound-moment key and its default. Fix any leftover wording, including README.
- [ ] **Step 4:** Run the app (`pnpm tauri dev`, or the project's `run` skill). Accept a finished session in a workspace and check that the orbs say "+1 shipped", the house steps up, and the panel shows the week count.
- [ ] **Step 5: Commit** any fixes: `git commit -am "Activity houses: leftovers"`.
