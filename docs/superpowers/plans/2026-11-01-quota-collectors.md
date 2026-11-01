# Elixir Collectors and Terminal Structures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each agent's remaining quota as an elixir collector by the town hall (click for every limit), and give terminals real structures.

**Architecture:** A Rust `quota` module parses three sources (Claude status-line JSON via the existing hook server, Codex rollout logs, `agy -p /usage`) into one `AgentQuota` shape, persists it and emits `quota-updated`. The web side keeps quotas in the zustand store, derives tank level in a pure `village/quota.ts`, and draws collectors as ordinary entities. Terminals reuse agent structure spots.

**Tech Stack:** Rust (serde_json, existing axum hook server), React 19 + zustand, PixiJS with Canvas2D-baked art, vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-11-01-quota-collectors-design.md`

## Global Constraints

- Never write to `~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode` or project agent config; tests use temp dirs.
- No credentials read or sent; no private endpoints; no third-party scrapers.
- The user's own Claude status line keeps working in app-launched sessions.
- Tests never touch the owner's real `state.json` (use `COC_DATA_DIR`).

## Review Focus

1. Claude reports `resets_at` as epoch seconds on some versions and ISO-8601 on others → both parse.
2. A window missing from Claude's JSON (`five_hour` absent) → the other windows still show; an all-missing payload changes nothing.
3. The user has no status line, or one with quotes/newlines in its command → our wrapper still prints their output unchanged (or nothing).
4. `agy` missing, hanging or printing an error → no crash, no collector change; timeout bounds it.
5. A reset time in the past → the tank shows full, not the stale level.

---

### Task 1: Rust quota model and parsers

**Files:** Create `src-tauri/src/quota.rs`; Modify `src-tauri/src/lib.rs` (mod).

**Produces:** `QuotaWindow { id: String, label: String, group: Option<String>, left_pct: f64, resets_at: Option<i64 /*ms*/>, window_mins: Option<u32> }`, `AgentQuota { agent: AgentKind, windows: Vec<QuotaWindow>, updated_at: i64, source: String }` (serde camelCase); `parse_claude_status(&Value) -> Option<Vec<QuotaWindow>>`, `parse_codex_line(&str) -> Option<Vec<QuotaWindow>>`, `parse_agy_usage(&str) -> Option<Vec<QuotaWindow>>`, `latest_codex_rollout(root: &Path) -> Option<PathBuf>`.

- [ ] Tests: claude epoch and ISO `resets_at`; missing `five_hour`; no `rate_limits` → None; codex primary+secondary with `resets_at` and with `resets_in_seconds`; the captured agy output from the spec parses to 5 windows with groups; garbage → None.
- [ ] Implement; `cargo test quota` passes.

### Task 2: Quota store, sources and commands

**Files:** `quota.rs` (QuotaStore), `adapters/claude.rs` (statusLine), `lib.rs` (sink, poller, state), `commands.rs` (`get_quotas`, `refresh_quotas`).

- [ ] `QuotaStore::new(path, emit)`: load/persist `quota.json`, `set(AgentQuota)`, `all()`.
- [ ] Claude settings gain `statusLine { type: "command", command: status_command(hook_url, user_cmd) }`; `user_cmd` from `~/.claude/settings.json` `statusLine.command` (read only, `padding` copied). Test: running the command with `sh -c` posts stdin and prints the user command's output.
- [ ] Hook sink: bodies with `rate_limits` update Claude's quota (before `on_hook`).
- [ ] Poller thread: Codex every 60 s, agy every 5 min (if detected, 20 s timeout, cwd = data dir); `refresh_quotas` runs both now.

### Task 3: Web quota state and math

**Files:** `src/api/types.ts`, `src/api/ipc.ts`, `src/state/store.ts`, `src/village/quota.ts` (+ test), `App.tsx` (load + listen).

- [ ] `leftNow(w, now)` (100 after reset), `primaryWindow(q)`, `tankLevel(q, now)` (0..10 tenths), `quotaTone(left)`, `resetIn(ms)` text. Tests cover reset-passed and primary choice.

### Task 4: Collectors in the village

**Files:** `scene.ts` (entities `collector:<agent>` + label), `art/buildings.ts` (`drawCollector(agent, tenths)`), `input.ts` (selection `{kind:'quota', agent}`), store `Selection`.

- [ ] Fixed slots (−2,4), (0,4), (2,4); shown when the agent has a reading or is installed. Tests in `scene.test.ts` and `input.test.ts`.

### Task 5: Quota panel

**Files:** `src/panels/QuotaPanel.tsx` (+ test), `SidePanel.tsx`, `panels.css`.

- [ ] Windows sorted shortest first, grouped by `group`; bar, %, reset text, as-of, Refresh; empty-state copy per agent.

### Task 6: Terminal structures

**Files:** `store.ts` (ensureSpot/autoLayout/mates for terminals), `scene.ts` (terminal structure entity, spots include terminals, badge removed), `art/buildings.ts` (`drawWorkshop(lit)`).

- [ ] Tests: a terminal gets a spot; entity `struct:<id>` with `workshop:` texture; clicking selects the session; no badge.

### Task 7: Verify live and review

- [ ] `pnpm app`, driver screenshots: collectors visible, panel opens, terminal structure clickable. Full test suites. Whole-branch review.
