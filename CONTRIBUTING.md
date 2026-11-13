# Contributing

Thanks for helping build the village. Bug reports, agent-support fixes and art are all welcome.

## Setup

You need macOS 13+, [Rust](https://rustup.rs) (stable), Node 22 and pnpm.

```sh
pnpm install
pnpm app          # dev mode: hot-reloads the frontend, rebuilds on Rust changes
```

`pnpm app` keeps its own data in `~/Library/Application Support/dev.clashofclaudes.app.dev`, so experiments never touch your real workspaces. `pnpm app:install` builds a real app into `/Applications` (seconds after a small change) for checking things only an installed app does: Dock launch, notifications, macOS permission prompts.

## Before you open a PR

```sh
pnpm exec tsc --noEmit && pnpm test                     # types + frontend tests
cargo test --manifest-path src-tauri/Cargo.toml --lib    # Rust core
pnpm test:scripts                                        # release scripts
```

CI runs the same on every pull request. For visual changes, attach a screenshot.

## Where things live

| Path | What |
|---|---|
| `src-tauri/src/sessions.rs`, `status.rs` | Session manager and the status state machine (pure, table-tested) |
| `src-tauri/src/adapters/` | One file per agent: launch command, status policy, prompt keys |
| `src-tauri/src/osc.rs` | OSC 7501 status reports (Antigravity) |
| `src/village/` | The isometric village: layout, walls, walkers, Canvas2D-baked art drawn with PixiJS |
| `src/panels/`, `src/hud/` | React UI |
| `docs/superpowers/` | Design spec and implementation plans |

## Ground rules

These are product promises, not style preferences. PRs that break them can't be merged.

- **Never write to an agent's own configuration**: nothing under `~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode`, `~/.grok`, or a project's `.claude`, `.codex`, `.gemini`, `.opencode`, `.grok`. Per-session settings go in the app's data folder and are deleted when the session closes.
- **No new network connections.** The only ones are the optional update check, reports the user chooses to send, and opt-in anonymous usage counts (README › Privacy). Agent output, prompts, file names and folders never leave the machine.
- **Never automate an agent's sign-in** or handle its credentials.
- Tests must not touch the real app data: use `COC_DATA_DIR` with a temporary folder.

## Licensing of contributions

The code is under the [GPL 3.0 or later](LICENSE). **By opening a pull request you agree that your code
is licensed to Fabian Ferno and to everyone else under the MIT License**, and that you have the right
to contribute it (it's your own work, or you may share it under MIT). The project ships it under the
GPL with the rest; MIT inbound keeps the door open to offering the project under other terms later.

Art is different: see [ASSETS-LICENSE.md](ASSETS-LICENSE.md) › "Art you contribute".

## Adding or fixing an agent

Agent support lives in one adapter file. The README's "Supported agents" table says which ones were verified against a real run. If you use Codex or OpenCode, a short report of how their prompts and status really behave (with the CLI version) is one of the most useful contributions right now. Debug builds log every OSC status report as `osc7501: …`.
