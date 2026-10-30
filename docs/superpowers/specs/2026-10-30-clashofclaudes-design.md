# Clash of Claudes — Design

*Date: 2026-10-30 · Status: draft for review · Working name: v1 will be shared publicly, so it needs a final name before release ("Clash of Claudes" plays on two trademarks)*

Visual and behavioral reference: [`docs/mockups/village-v6.html`](../../mockups/village-v6.html). Open it in a browser. Where this document and the mockup disagree, this document wins. Everything in the mockup is placeholder data and placeholder art.

---

## 1. Why this exists

People who run several coding agents at once (Claude Code, Codex, Gemini CLI, OpenCode…) across several project folders lose track of them: which one is working, which one is waiting for approval, which one is stuck, which one finished ten minutes ago. Today that means flipping through terminal tabs.

Clash of Claudes is a desktop app where every project folder is a walled compound in an isometric village and every running agent session is a builder raising a structure inside it. You can see the state of everything at a glance, and the real terminal is always one click away. It is gamified so that keeping it open all day is pleasant, but it is a work tool first.

**What success looks like:** the owner keeps it open all day instead of a grid of terminal tabs, and notices "needs you" and "done" moments faster than before.

## 2. Goals (v1)

1. **Mac desktop app** (macOS 13+, Apple Silicon and Intel), built on a stack that also runs on Windows so a later port is focused work, not a rewrite.
2. **Workspaces = folders.** Create a new empty folder or open an existing one. Each becomes a walled compound.
3. **Sessions = agents in real terminals.** Start any command-line agent in a workspace: Claude Code, Codex, Gemini CLI, OpenCode, or a user-defined custom command. Choose the model and effort level where the agent supports them, plus an initial task prompt.
4. **Plain terminals** in any workspace (a shell in that folder).
5. **The village is the home screen**, with the rules in §5.
6. **Live status per session:** working, needs you, stuck, finished (ready to review), plus idle builders.
7. **One click to the real thing:** every builder and structure opens its live terminal in a side panel, and it can be popped out to a larger view.
8. **Notifications** when the app is in the background: a macOS notification and a dock badge when a session needs you or finishes.
9. **Stays light** (budgets in §7). Agents are the heavy part; the village must not be.
10. **Shareable:** other people can download and install v1. It is signed and notarized, ships as a DMG, and updates itself (§8).
11. **Remembers the village** across restarts: workspaces, compound layout and size, structure and house positions, levels and XP, and stats.

## 3. Non-goals (v1)

- Cloud or remote agents, and remote machines. Local processes only.
- Social and multiplayer: visiting other villages, sending builders to help someone else.
- A Windows release (the code stays portable; see §8).
- A phone app.
- Representing the codebase in the village. **Structures never stand for files, folders or code areas.**
- Managing API keys or logins. Each agent uses whatever login the user already set up for it.
- A full code editor or diff editor inside the app.
- Keeping agents alive after the app quits, or reattaching to them later.

## 4. Anti-goals: failure even if it "works"

- **The game gets in the way.** No forced animations before you can act, no tutorials that block the screen, no hiding the terminal behind game screens. Every game element is at most one click from the real terminal.
- **The app is heavy.** If the village measurably slows the agents or the machine, it has failed.
- **It rewards spending.** Bigger models or higher effort must never earn more XP or permanent rewards. Model and effort change how a builder *looks*, never what you *earn*.
- **It fakes data.** No invented progress percentages. Activity is shown as elapsed time and step counts. Unknown values (for example tokens, for an agent that doesn't report them) are hidden, not guessed.
- **It copies Clash of Clans.** No Supercell art, characters, UI elements, sounds, names or layouts. The target is the *genre's* look and quality bar (chunky isometric, bold outlines, saturated, glossy UI) with original art.

## 5. The village: concepts and rules

### 5.1 Pieces

| Village piece | Real thing |
|---|---|
| **Town Hall** (center) | Overview of all workspaces; where idle builders hang out and where new builders come from |
| **Compound** (stone walls with a gate) | One workspace (folder) |
| **Main house** (inside each compound, always present) | The workspace itself. Has a level and XP |
| **Structure** (inside a compound) | One live agent session. Exists only while the session is open |
| **Builder** (character) | The agent running that session |
| Builders bar (bottom) | Roster of all builders, with state badges |
| Village level (top left) | Total sessions shipped (closed after Finished) across all workspaces |
| Status pills (top left) | Counts per state; click to jump to one |
| Resource bars (top right) | Builders busy, tasks shipped today, tokens today (only where known) |

### 5.1a Builders are a persistent roster

The owner said: *"Different agents can just be walking around, and if they are tasked to do something, they keep building."*

- **What a builder is:** a saved preset. It has a name, an agent type, a model and an effort, and its look comes from those.
- **Idle:** with no session, a builder wanders around the Town Hall.
- **Starting a session** means sending an idle builder, or recruiting a new one in the picker, which adds them to the roster.
- **After a session closes,** the builder walks back to the Town Hall and is idle again. They don't disappear.
- **Managing builders:** you can rename, edit (agent, model, effort) or dismiss a builder from their panel.
- **No limit on roster size.** "Builders busy X / N" means builders in a session out of roster size. *(My call.)*
- **Concurrency:** a builder runs one session at a time. If every builder is busy, the picker recruits a new one by default. *(My call.)*

### 5.2 What things look like

- **All structures are the same size.** Their roof and wall style comes from the **agent type**. The mockup colors are terracotta for Claude Code, slate for Codex, blue for Gemini, green for OpenCode, and a neutral style for custom agents.
- **Builders encode the session's setup:**
  - **Outfit color = agent type** (same palette as above).
  - **Class = model tier.** Apprentice (cloth cap, small) → Craftsman (hard hat) → Master (bigger, gold helmet, plume, cape). Each agent's models map onto these three tiers. Claude: Haiku → Apprentice, Sonnet → Craftsman, Opus → Master. Agents with one or unknown model → Craftsman. The mapping is per-agent config, so new models are a config change.
  - **Gear + stars = effort.** low → wooden hammer ★, medium → iron ★★, high → gold ★★★, max → enchanted glowing hammer ★★★★. If an agent has no effort setting, it shows the effort the user picked (recorded for display only).
- **The main house gets visibly grander as it levels up**: extra details, banner, wing or tower at certain levels.
- **Plain terminals don't get structures.** They are listed in the workspace panel, and the main house shows a small count badge. *(My call.)*

### 5.3 Session lifecycle

1. **Start:** the user picks a workspace, task, agent, model and effort (picker with a live builder preview, as in the mockup). The app finds a spot in the compound (§5.4), a foundation pops in, and the builder walks out of the Town Hall, through the compound gate, to the spot. The agent process starts immediately; the walk is cosmetic and must not delay it.
2. **Working:** scaffolding with a blueprint outline of the finished structure; the builder hammers. Scaffolding height grows with activity (for example steps taken, on a curve that approaches but never reaches full height). It is **not** a completion percentage. A small bar shows elapsed time and step count.
3. **Needs you:** a red "!" bubble, a pulsing ring, the "needs you" pill, and a notification when the app is in the background. The panel offers **Allow / Deny** where the adapter supports it (§6.3), otherwise **Open terminal**.
4. **Stuck:** smoke and a "?!" bubble. Triggered by a crash or non-zero exit, repeated failure signals from the agent, or no output for a long time while not waiting on the user (threshold is the builder's call).
5. **Finished (ready to review):** the structure is complete, a gold ribbon floats above it, and the builder celebrates. "Finished" means the agent finished its turn and is waiting for the next instruction. If the user types more into the terminal, it goes back to Working.
6. **Review:** the ribbon opens the session panel showing what changed in the workspace (changed files and line counts from git where the folder is a git repo), with **Open in editor**, **Open terminal**, and **Close session**.
7. **Close session:** the agent process is ended, the structure is taken down with dust, gold orbs fly into the main house, "+XP" pops, and "LEVEL UP!" appears when the house levels. The builder walks back to the Town Hall and becomes idle.
   - **XP is a flat amount per closed session that reached Finished.** Sessions that are stopped early, crash or are closed while stuck give no XP. *(My call.)*
   - Level thresholds grow per level, for example ×1.4. Exact numbers are the builder's call.
8. **Quitting the app ends all sessions.** Warn first if any are running. *(My call; see non-goals.)*

### 5.4 Layout and placement

- The map is a large tile grid with forest around the village. **Compounds clear the forest as they grow.** The ground is pre-drawn once and re-drawn only when the layout changes.
- **Footprints:** main house 3×3 tiles, structure 2×2 tiles.
- **New sessions** go in the free spot nearest the main house, preferring spots with a one-tile walking gap around them.
- **Unlimited sessions.** If nothing fits, the compound's walls expand by one 3-tile row or column (alternating to stay roughly square), with dust and a "Walls expanded!" pop. Walls never shrink automatically in v1. *(My call.)*
- **Compounds grow away from the Town Hall.** The mockup only handles four compounds, one per quadrant.
  - **v1 rule for any number:** new compounds are auto-placed in the nearest free area around the Town Hall, and expansion prefers the side away from the Town Hall.
  - If an expansion would collide with another compound, it grows in the other direction. If neither direction fits, the compound relocates to free space, animated. The exact algorithm is the builder's call. Collisions must never happen.
- **Moving things:** click a structure or main house to select it (footprint glow, four arrows, "Drag to move"). Drag it to move: a tile grid shows, the footprint turns green or red, release on green to place it or on red to snap back. Objects stay inside their own compound. Positions persist. Builders move with their structure.
- *Nice to have, not v1:* dragging whole compounds around the map.

### 5.5 Camera and controls

- Drag to pan; scroll to zoom toward the cursor; double-click a compound to zoom into it; double-click open ground to zoom back to the whole village.
- **+ / − / Village** buttons.
- The camera eases smoothly and never jumps.
- Selecting something that the side panel would cover pans it into view.
- **Builders bar:** slides away and back, and scrolls sideways when it overflows.

### 5.6 Panels (right side, over the village)

- **Town Hall:** list of workspaces, idle builders, new workspace, open folder.
- **Workspace (compound/main house):** level and XP, list of sessions with state, terminals, **+ New session**, **+ Terminal**, **Open in editor**, **Zoom in**.
- **Session (structure/builder):** agent, model and effort mapped to class and gear, the **live terminal**, and state-specific actions (Allow/Deny, Review, Close session, Stop session, Pop out terminal).
- **New session picker:** workspace, task, then either an idle builder or **Recruit new** (agent, model, effort, name), a live builder preview, and the exact command that will run.
- **Build:** new empty folder or open existing folder. *Clone a repo* is a nice-to-have.

## 6. How it works

### 6.1 Stack

- **Tauri 2** (Rust core, system WebView). Chosen over Electron for memory and CPU footprint.
- **Frontend:** TypeScript, React for panels and HUD, **PixiJS v8** for the village canvas.
- **Terminals:** **xterm.js** (with the WebGL renderer) in the frontend; **portable-pty** in Rust (works with ConPTY on Windows later).
- **Persistence:** local file(s) in the app data directory: SQLite or JSON, builder's choice.

### 6.2 Process model

- **The Rust core owns every PTY and process.** It keeps a scrollback ring buffer per session (size is the builder's call) and streams output to the frontend over Tauri channels.
- **Only visible terminals have a mounted xterm instance.** Opening a terminal replays its buffer. Hidden sessions cost no rendering.
- **The Rust core is the single source of truth for session state.** It emits state-change events, and the frontend just renders them.

### 6.3 Agent adapters

One adapter per agent type, plus a generic one for custom commands. Each adapter provides:
- **detect:** is it installed (on PATH), and which version.
- **command:** the launch command for (model, effort, task prompt, folder), including how the task prompt is passed and how model and effort are set (flag, environment variable or config override). Unsupported options are recorded for display only.
- **status signals,** layered from universal to specific:
  1. **Universal** (every agent, including custom ones): process alive, output activity and silence, exit code.
  2. **Agent events** where the agent offers them. Examples:
     - Claude Code hooks, loaded through a per-session settings file passed on the command line, so the user's own config is never modified.
     - Codex's notify setting, passed as a command-line config override.
     - Gemini CLI and OpenCode hooks or plugins.

     Hooks report to the app over a local socket with a per-session token. Events of interest: turn finished, permission requested, tool used (step count), session ended, and token usage where available.
  3. **Screen pattern fallback:** recognizing an agent's approval prompt or idle prompt on screen, for agents without events.
- **approve / deny** (optional per adapter): the keystrokes that answer that agent's approval prompt. If an adapter doesn't support it, the panel shows "Open terminal" instead.

**These capabilities change often.** The first build step for each adapter is to verify, against the installed version, what it actually offers. Don't trust this document's examples.

### 6.4 Review data

At session start, record the folder's git state. Review shows the changes since then: changed files with added and removed line counts. Non-git folders show "no git history; open the folder to review". *(Concurrency caveat in §10.)*

### 6.5 Security and privacy

- **Network:** the app itself makes no network calls. Agents do their own.
- **Local socket:** bound locally only, with a per-session token.
- **File access:** the app reads only git metadata and diff statistics from workspaces, never file contents beyond what's needed for diff counts.

## 7. Performance budgets (targets on an M1-class Mac)

| Situation | Target |
|---|---|
| App hidden / minimized | ~0% CPU; village rendering fully stopped |
| App visible, village animating | ≤ 5% of one core; frame rate capped at 30 fps |
| App visible but not focused | ≤ 15 fps |
| Memory (app only, 10 sessions + 2 terminals open) | ≤ 250 MB |
| Cold start to interactive village | ≤ 2 s |

**Techniques:**
- **Village:** ground and forest baked into one texture (re-baked on layout change); each building and character drawn once into a cached texture, so frames only move sprites.
- **Animation:** driven by events; no polling of agent status from the frontend.
- **Terminals:** only visible ones rendered.

## 8. Platform

- **v1 targets macOS and is shared with other people** (owner decision). The release track is part of v1:
  - Universal build (Apple Silicon + Intel), signed with a Developer ID and notarized by Apple.
  - DMG installer.
  - Auto-update through Tauri's updater, with signed update manifests served from a static host. Which host is the builder's call.
  - A final public name and app icon before the first release (open; see §10).
  - **Needs from the owner:** an Apple Developer account (paid). The build can be prepared without it, but not shipped.
  - **First-run experience** for people who aren't the owner: detect which agents are installed, explain what's missing, and start with an empty village plus one "Open a folder" prompt.
- **Windows-ready from day one:**
  - No macOS-only APIs outside one small platform module.
  - No dependence on tmux or zsh.
  - Paths handled cross-platform.
  - Shell chosen per OS.
  - A Windows CI build is a nice-to-have.

## 9. Art direction

- **Target:** the look of a polished mobile base-builder.
  - Isometric, 2:1 tiles.
  - Chunky shapes with dark outlines, saturated colors, soft shadows.
  - Glossy beveled buttons, white text with heavy dark outline (Lilita One, OFL licensed, as in the mockup).
- **All art is original.**
- **v1 ships the mockup's code-drawn art, ported to PixiJS and cached as textures,** behind a clear seam: every entity (house per level, structure per agent type and construction stage, builder per type × class × gear × animation, walls, gate, trees, props) is drawn by one replaceable function. That lets a later art pass swap in pre-rendered sprite sheets without touching game logic.
- A higher-fidelity art pass (original 3D models rendered to sprites, or commissioned illustration) is planned **after** v1 works.

## 10. Known risks and open points

- **Several sessions in one folder** (owner decision): sessions **share the folder by default, and the agent decides** whether its task needs its own git worktree.
  - **Telling the agent:** every session's initial instructions include a short note that other agents may be working in the same folder, and that it may create its own git worktree when its task needs isolation. Use an appended system prompt where the agent supports one, otherwise a preface to the task.
  - **Detecting it:** the app notices when a session moves into a worktree, via the process's working directory and the repo's worktree list. The structure stays in the same compound and gets a small "branch" marker showing the branch name.
  - **Review:** for a session in a worktree, review shows that branch's changes against where it started. Otherwise it shows the folder's changes since the session started, noting if other sessions were active.
  - **Closing:** closing a worktree session never merges or deletes anything automatically. The panel shows the branch and offers "Open terminal" so the user (or the agent) can merge. Cleaning up worktrees is the user's choice.
- **Agent integration surfaces change between versions.** Keep adapters small and isolated; verify at build time (§6.3).
- **"Stuck" is heuristic.** Keep thresholds configurable.
- **Token counts** are only shown for agents that report them.
- **Public name** is still to be chosen, before the first public release.

## 11. Left to the builder

- Library choices within the stack: state management, IPC shape, persistence format, test setup.
- Project layout, module boundaries, naming.
- Exact numbers: XP amounts, level curve, timings, thresholds, scrollback size, animation durations.
- The compound auto-placement and expansion algorithm, within the rules in §5.4.
- Adapter details after verification.
- How to split the build into milestones. Suggested order:
  1. PTY + one Claude Code session in a plain panel.
  2. Adapter status events.
  3. Village rendering from real state.
  4. Lifecycle + XP.
  5. Placement and move.
  6. Other adapters.
  7. Polish and budgets.

## 12. Decisions made by Claude, not the owner (please check)

1. Tauri 2 + React + PixiJS + xterm.js + portable-pty.
2. Plain terminals get no structure (badge on the house plus listed in the panel).
3. XP only for sessions that reached Finished; flat amount per session.
4. Walls never shrink automatically.
5. Rules for placing more than four compounds (§5.4).
6. Quitting the app ends sessions, with a warning.
7. How the app tells agents about shared folders and detects worktrees (§10). The policy itself (shared by default, the agent decides) is the owner's.
8. Notifications and dock badge for "needs you" and "finished" while the app is in the background.
9. v1 ships code-drawn art behind a sprite-swappable seam; a real art pass comes after.
10. Model→class mapping per agent as config; effort shown even when the agent can't apply it.
11. Builders are a persistent, uncapped roster of presets; one session per builder at a time (§5.1a).
12. Village level = total shipped sessions, shown top left as in the mockup.
13. Release track details: Tauri updater, DMG, first-run experience (§8).
