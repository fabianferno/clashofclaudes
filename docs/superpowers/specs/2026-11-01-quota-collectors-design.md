# Elixir collectors (agent quota) and terminal structures — design

Approved by the owner in chat on 2026-11-01 ("sounds good proceed").

## Intent

Every agent provider rations usage, and running out mid-task is the moment the owner wants to
see coming. The village should show each agent's quota as a Clash-of-Clans-style **elixir
collector**: a glass tank whose level is the quota left in the agent's shortest window. Clicking a
collector opens every limit for that agent (weekly, per-model). In the same batch, **terminals
become real structures** in their compound instead of a number badge on the house.

## Goals

- One collector per agent that has quota data or is installed (Claude Code, Codex, Antigravity).
  OpenCode has no quota of its own (it uses whatever provider key it is given) and gets none;
  custom agents get none.
- The tank level is "% left" of the agent's **primary window**: the shortest window it reports;
  among equal lengths (Antigravity's per-group 5-hour limits), the one with the least left.
- A window whose reset time has passed counts as **full** (refilled) until a fresh reading says
  otherwise, so a tank visibly refills at its reset without waiting for new data.
- Empty (≤ 0 % left) goes dark and its label counts down to the refill.
- Clicking a collector opens a side-panel view listing every window: label, a bar of what is
  left, the reset time ("in 3h 12m · Sat 21:00"), when the reading was taken and where it came
  from, and a Refresh button.
- Each live or ended terminal session gets its own 2×2 structure inside its compound (a small
  workshop with a lit window; lights off once ended). Clicking it opens that terminal's session
  panel, exactly as an agent structure does. It can be dragged like an agent structure. The
  house badge goes away.

## Non-goals

- No guessing of absolute token/message counts; only the percentages the agents report.
- No notifications about quota (could come later).
- No quota for OpenCode, custom agents, or API-key Claude accounts (Claude reports limits only
  on Pro/Max plans).

## Anti-goals (would make this a failure even if it works)

- Reading or sending the user's credentials/tokens; calling private, undocumented endpoints
  (Anthropic's OAuth usage endpoint) or third-party scrapers.
- Writing anything to `~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode` or a project's
  agent config. Reading is fine.
- Breaking the user's own Claude status line in sessions the app launches.
- Spending model quota to read quota.

## Where the numbers come from (verified 2026-11-01)

| Agent | Source | Shape |
|---|---|---|
| Claude Code (2.1.316) | Claude pipes JSON to the status-line command; it carries `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage` 0–100, `resets_at` epoch seconds or ISO-8601), sometimes more `seven_day_*` windows. Each window may be absent. | The app already launches Claude with a per-session `--settings` file (hooks). That file gains a `statusLine` whose command copies stdin to the session's existing hook URL (backgrounded `curl`) and then pipes the same stdin to the user's own status-line command, read from `~/.claude/settings.json` (read only), so their line still shows. Readings arrive only while an app-launched Claude session runs. |
| Codex | Codex writes `token_count` events with `rate_limits: { primary, secondary }` (`used_percent`, `window_minutes`, `resets_at` epoch s or `resets_in_seconds`) into `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. | Read the newest rollout file's last `rate_limits` line, read only. Owner's machine shows one 43 200-minute (30-day) window. |
| Antigravity (agy 1.4.12) | `agy -p /usage` prints tab-separated rows `group \t label \t NN% \t ISO reset` with "Remaining" percentages (5-hour and weekly per model group, plus Argon weekly). Answered locally, no model turn. | Run with a timeout from the app's data dir, only when agy is detected, at most every 5 minutes and on Refresh. |

## Decisions (mine, recorded so the owner can check them)

- Collectors stand in a row in front of the town hall on tiles that compounds can never take
  (the hall keeps a 4-tile gap): fixed slots so they never shuffle — Claude at (−2, 4), Codex at
  (0, 4), Antigravity at (2, 4), each 2×2. They are not draggable.
- Readings persist in `<data dir>/quota.json` so collectors show the last known level after a
  restart, with "as of" age in the panel.
- Fill levels are quantised to tenths for textures; the label shows the exact percentage.
- Label tone: green-ish "working" above 25 % left, amber "needs" at ≤ 25 %, red "stuck" at ≤ 10 %.
- Terminal structures reuse the agent structure footprint (2×2) and spot logic so walls,
  walkers and dragging keep working unchanged.

## Left to the builder

Exact art, panel styling, module boundaries, polling cadence for Codex (cheap file read).
