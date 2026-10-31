# Clash of Claudes

A macOS desktop app for people who run several coding agents at once. Every project folder is a walled compound in an isometric village, and every running agent session is a builder raising a structure inside it. You see at a glance which agents are working, which need you, which are stuck and which have finished. The real terminal is always one click away.

Working name. v1 is Mac only (macOS 13 or later, Apple Silicon and Intel).

## Install

1. Download the latest `Clash of Claudes_<version>_universal.dmg` from the project's Releases page.
2. Open the DMG and drag **Clash of Claudes** onto **Applications**.
3. Launch it from Applications.

Signed and notarized releases open normally and need none of this. An unsigned build (made from source without Apple credentials) is not notarized, so macOS blocks it. Try to open it once, then go to **System Settings > Privacy & Security**, scroll to the blocked-app message and click **Open Anyway**. (Right-click > Open no longer reliably works on recent macOS.) For technical users, the fallback is `xattr -dr com.apple.quarantine "/Applications/Clash of Claudes.app"`.

To build it yourself, see [docs/release.md](docs/release.md).

## First run

- The window opens on an empty village with a welcome card. Click **Open folder** (or use the Town Hall) and pick a project folder. It becomes a compound.
- Open the **Town Hall** to see which agent CLIs were found on your Mac, their versions, and a copyable install command for the ones that are missing. **Re-check** re-detects after you install one.
- Click a compound to open its Workspace panel, then **+ New session**. Pick a builder, an agent, and optionally a model, effort and a first task. The agent starts in a real terminal in that folder.
- Click any builder or structure to open its live terminal in the side panel. The terminal can be popped out to a larger view.
- **+ Terminal** in the same panel opens a plain shell in the folder.

The app does not install agents, log in for you, or manage API keys. Each agent uses the login you already set up for it.

## Supported agents

| Agent | What the app can report | Approve / deny from the app |
|---|---|---|
| Claude Code | Working, needs you (permission request), finished, tool-step count. Also detects the first-run "trust this folder" menu. | Yes |
| Codex | Working, finished (turn complete). Needs you is detected from the on-screen approval and trust prompts. **For app sessions, Codex's `notify` and `developer_instructions` settings are overridden** (`-c notify=…`, `-c developer_instructions=…`): a `notify` program or developer instructions you set in `~/.codex/config.toml` do not apply in sessions started from the app (your file is never edited). | No: answer in the terminal |
| OpenCode | Working, needs you (permission request), finished, stuck on error. The shared-folder note is only delivered when you give a task (it is prefixed to the first prompt). | No: answer in the terminal |
| Antigravity CLI (`agy`) | Working, needs you (permission, question or sign-in), finished, failed, read from the status reports agy writes into its own terminal output (no settings files at all). The shared-folder note is only delivered when you give a task. | Yes (Enter / Esc) |
| Custom command | Working while it prints, finished after quiet time, stuck if it exits non-zero or is silent for long. | n/a |

For Codex, OpenCode and Antigravity, a session that goes quiet before the agent has reported anything (typically a login, auth or first-run screen) shows **Needs you: "Waiting in the terminal"**, never Finished. Codex and OpenCode have no model list: type a model id in the picker (OpenCode takes `provider/model`), or leave it empty for the agent's default.

Claude Code and Antigravity CLI have been verified against real runs. Codex and OpenCode support was written from their documentation and is waiting for real-world confirmation; if one misbehaves the terminal always works. Model and effort are passed only where the agent documents a way to do it. Elsewhere they are recorded on the builder for display.

Antigravity CLI replaced Gemini CLI for Google's plans; the app supports Antigravity and no longer Gemini CLI (builders saved for Gemini CLI become Antigravity builders).

## Notifications

When the app is in the background, it shows a macOS notification when a session needs you or finishes (title: the builder's name, body: "needs you: ..." or "finished"), and the Dock icon shows how many sessions are waiting. Clicking a notification brings the app forward and selects that session. Notifications never include your task text or terminal output.

## Privacy

- The app makes **no network connections** except one optional check for updates, which you can turn off in the Town Hall ("Check for updates automatically"). Builds whose update key or GitHub repository is not configured (the source ships placeholders for both) never check at all.
- Agent output, prompts, file names and folders never leave your machine.
- The app **never edits your agent configuration**: nothing under `~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode`, or a project's `.claude`, `.codex`, `.gemini` or `.opencode`. To get status events it hands each agent a private per-session settings file stored in the app's own data folder (`~/Library/Application Support/dev.clashofclaudes.app/sessions/`), and deletes it when the session closes.
- Status events arrive on a localhost-only server protected by a random per-session token.
- Quitting the app ends your agent sessions. It asks first if any are running.
- macOS may ask whether Clash of Claudes can read your Downloads, Desktop or Documents folder. That is an agent or terminal running inside the app (macOS asks on behalf of the app that started it), the same prompt iTerm or VS Code shows the first time. Allow it for folders that hold your workspaces; saying no elsewhere is safe. Change it later in **System Settings > Privacy & Security > Files & Folders**.

## Development

Three ways to run it, fastest first:

- `pnpm app`: development mode. Frontend edits show up instantly, and Rust edits rebuild and relaunch the window by themselves. It keeps its own data (`~/Library/Application Support/dev.clashofclaudes.app.dev`), so experiments never touch your real workspaces; `COC_DATA_DIR= pnpm app` uses the real data (quit the installed app first).
- `pnpm app:install`: a real installed app for this Mac only, in `/Applications`, about 40 s from scratch and seconds after a small change. Use it for what only an installed app does: launching from the Dock, notifications, macOS permission prompts. If the app is open, it waits for you to quit it.
- `pnpm release`: the universal (Intel + Apple Silicon) DMG for other people. Slow (full optimization, both architectures); only for shipping.

```
pnpm install
cargo test --manifest-path src-tauri/Cargo.toml
pnpm vitest run && pnpm exec tsc --noEmit
node --test scripts/*.test.mjs
```

Design and plans are in `docs/superpowers/`. Verification results and the owner checklist are in `docs/verification/plan-3-v1.md`.
