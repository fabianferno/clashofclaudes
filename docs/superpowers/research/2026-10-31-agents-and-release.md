# Plan 3 research (fetched 2026-10-31)

Legend: facts come from the cited page at fetch time. Pages are versionless docs, so no CLI version is pinned unless stated. UNVERIFIED means inferred or from third-party sources only. Page summaries came through a summarizing fetch tool, so verify exact strings against real `--help` output.

## 0. Headline risk: Gemini CLI is being replaced by Antigravity CLI (`agy`)
- Google announced on 2026-05-19 that Gemini CLI is transitioning to Antigravity CLI. On 2026-06-18 Gemini CLI stopped serving Google AI Pro/Ultra and free Code Assist for individuals users. https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- Gemini CLI remains usable with paid Gemini / Gemini Enterprise Agent Platform API keys and with Code Assist Standard/Enterprise licenses (same blog post).
- The repo README says free/Pro/Ultra users moved to Antigravity CLI (`agy`). The repo is described as "Designed for Gemini Code Assist Standard / Enterprise", "Not optimized for Gemini 4+". Install: `npm install -g @google/gemini-cli`, `brew install gemini-cli`, `npx @google/gemini-cli`. License is Apache-2.0. Tags: `@latest`, `@preview`, `@nightly`. https://github.com/google-gemini/gemini-cli
- The blog says Hooks, Skills, Subagents and Extensions (renamed plugins) carry over to Antigravity, but not with 1:1 parity. The blog gives no binary name, config path or hook format. Binary `agy` comes from the README only. https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ and https://github.com/google-gemini/gemini-cli
- Migration docs: antigravity.google/docs/gcli-migration. I did NOT fetch them. Antigravity CLI flags, hooks and config format are UNVERIFIED.
- Plan implication: treat the "gemini" adapter as API-key / enterprise only, and decide whether to add an `agy` adapter. Research `agy` separately.

## 1. OpenAI Codex CLI
Docs moved from developers.openai.com/codex/* to https://learn.chatgpt.com/docs/* (308 redirects).

### Launch flags
Source: https://learn.chatgpt.com/docs/developer-commands?surface=cli
- Initial prompt: positional `PROMPT`. "Optional text instruction to start the session. Omit to launch the TUI without a pre-filled message." This starts interactive mode (not `codex exec`).
- Model: `--model` / `-m <string>`.
- Config override: `--config` / `-c key=value`. Values parse as TOML, falling back to a literal string.
- Working dir: `--cd` / `-C <path>`.
- Sandbox: `--sandbox` / `-s read-only|workspace-write|danger-full-access`.
- Approval: `--ask-for-approval` / `-a on-request|never`.
- Profile: `--profile` / `-p <name>`. Layers `$CODEX_HOME/<name>.config.toml` over the base user config.
- `--dangerously-bypass-approvals-and-sandbox` exists.
- `--version` is not on this page. Unverified from docs. Hidden-from-page flags such as `--full-auto` and `--enable` are UNVERIFIED.
- No instructions flag on the page. Use the `-c` keys below.

### Config keys (https://learn.chatgpt.com/docs/config-file/config-reference, first 100k chars of ~157k read)
- `model_reasoning_effort` (string). Examples listed: low, medium, high, xhigh, max, ultra. "Available levels depend on the model and client." So use `-c model_reasoning_effort="high"`.
- `developer_instructions` (string). "Additional developer instructions injected into the session." This is the best fit for append, via `-c developer_instructions="..."`. Quoting of multi-line values via `-c` is UNVERIFIED.
- `model_instructions_file` (path). Replaces the built-in instructions instead of `AGENTS.md`. Use with care.
- `approval_policy`: `on-request | never | { granular = {...} }`. `untrusted` is unsupported and `on-failure` is deprecated.
- `projects.<path>.trust_level` = "trusted"|"untrusted". Setting it via `-c 'projects."/abs/path".trust_level="trusted"'` to skip the trust prompt is UNVERIFIED (inferred).
- `check_for_update_on_startup` (bool).
- `suppress_unstable_features_warning` (bool).
- `tui.notification_method` auto|osc9|bel.
- `tui.notification_condition` unfocused|always.
- `-c` examples from https://learn.chatgpt.com/docs/config-file/config-advanced: `codex --config model='"gpt-6.1-sol"'`, `codex --config 'shell_environment_policy.include_only=["PATH","HOME"]'`. Dotted keys are supported. Quote values so the shell does not split them.

### notify
Source: https://learn.chatgpt.com/docs/config-file/config-advanced
- Config form: `notify = ["python3", "/path/to/notify.py"]` (TOML array of strings). Via CLI: `-c 'notify=["/path/to/script","arg"]'`. TOML array parsing is documented for `-c`, but this exact notify usage is UNVERIFIED.
- Docs say "currently only `agent-turn-complete`".
- Payload: "The script receives a single JSON argument", so it is appended as the last argv, NOT stdin.
- Fields: `type` ("agent-turn-complete"), `thread-id`, `turn-id`, `cwd`, `input-messages`, `last-assistant-message`. Key naming (hyphens) is as the docs print them.
- `approval-requested` does NOT fire through `notify`. It is only an event type for the built-in `tui.notifications` filter (terminal OSC9/BEL).
- Implication: `notify` gives only turn-complete. Approval detection needs hooks (below) or PTY scraping.

### Hooks
Source: https://learn.chatgpt.com/docs/hooks
- Hooks are enabled by default (`[features] hooks = false` disables them). `codex_hooks` is a deprecated alias.
- Defined in `hooks.json` or inline `[hooks]` in `config.toml` at `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`. Project-local hooks load only if the project `.codex/` layer is trusted.
- Events: `SessionStart, SessionEnd, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt`.
- Hooks get one JSON object on stdin. Shared fields: `session_id, transcript_path, cwd, hook_event_name, model`. Event fields include `turn_id, permission_mode, tool_name, tool_use_id, tool_input, tool_response, prompt, source, reason, trigger, agent_id, agent_type, agent_transcript_path, last_assistant_message, stop_hook_active`.
- `PermissionRequest` runs "when Codex is about to ask for approval". A hook can allow or deny via `hookSpecificOutput.decision.behavior` = "allow"|"deny" (+ `message`). If no decision is returned, the normal prompt continues. Any deny wins.
- Per-session supply method: NOT documented. The config reference lists `hooks.<Event>[].hooks[]` keys, so passing them via `-c 'hooks.Stop=[...]'` is plausible but UNVERIFIED. The exact hook entry schema (e.g. `command`, `type`) was not retrieved. Alternatives: a per-session `CODEX_HOME` (UNVERIFIED but standard) or `--profile`. Test empirically.
- Caveat: the hooks doc mentions "session" hook sources in `allow_managed_hooks_only`, so a session layer exists, but its mechanism is undocumented.

### Approval UI and first run (third-party, version-dependent, UNVERIFIED)
Source: GitHub issues https://github.com/openai/codex/issues/9696 and https://github.com/openai/codex/issues/7744, reports from 0.65.0 and 0.130.0.
- Command approval menu labels: "Yes, proceed (y)", "Yes, and don't ask again for this command (a)", "No, and tell Codex what to do differently (esc)". A "p" shortcut appears in 0.130.0.
- Typing y/a while the agent works can auto-approve a pending prompt (0.65.0 report). Be careful sending stray keystrokes.
- The trust screen has existed at first run in a directory. Older wording: "Yes, allow Codex to work in this folder without asking for approval" / "No, ask me to approve edits and commands". Trust is stored per directory in `~/.codex/config.toml` as `trust_level`. Source: GitHub issues above plus an MIT AI Agent Index entry (https://aiagentindex.mit.edu/2025/codex).
- Login screen: not researched. Assume a first-run login/onboarding when unauthenticated. UNVERIFIED.

### Version
- `codex --version` prints `codex-cli X.Y.Z`. Reported examples: `codex-cli 0.97.0`, `codex-cli 0.137.0`. Pre-release builds may print extra build info. Source: https://github.com/openai/codex/issues/12107 (secondary). Not in official docs. Parse with a regex for `\d+\.\d+\.\d+`.

## 2. Google Gemini CLI (legacy but still available with API keys; see section 0)
### Flags
Source: https://geminicli.com/docs/cli/cli-reference/
- `-i` / `--prompt-interactive <string>`: "Execute prompt and continue in interactive mode".
- `-m` / `--model` (default `auto`).
- `-p` / `--prompt`: non-interactive. Do not use.
- `--approval-mode default|auto_edit|yolo|plan`.
- `--include-directories`.
- Working dir: no `--cd` flag found. Set the PTY cwd (UNVERIFIED that there is no flag).
- No effort flag. Thinking is set inside settings via `modelConfigs.aliases.<alias>.generateContentConfig.thinkingConfig` (`thinkingBudget` for 2.5-series, `thinkingLevel` e.g. "HIGH" for Gemini 3). Source: https://geminicli.com/docs/reference/configuration/

### System prompt
Source: https://geminicli.com/docs/cli/system-prompt/
- `GEMINI_SYSTEM_MD=<path>|true|1` is a FULL REPLACEMENT of the system prompt, not an append. `true/1` loads `./.gemini/system.md`. A missing file is an error.
- `GEMINI_WRITE_SYSTEM_MD` writes the default prompt to a file. The placeholders `${AgentSkills}`, `${SubAgents}`, `${AvailableTools}` are available.
- No append mode documented. Cheapest "append" is to put the instructions at the start of the `-i` prompt, or use a project `GEMINI.md` (not researched).

### Hooks
Sources: https://geminicli.com/docs/hooks/ and https://geminicli.com/docs/hooks/reference/
- Events: `SessionStart, SessionEnd, BeforeAgent, AfterAgent, BeforeModel, AfterModel, BeforeToolSelection, BeforeTool, AfterTool, PreCompress, Notification`.
- Format in settings.json:
```json
{"hooks":{"AfterAgent":[{"matcher":"*","hooks":[{"name":"x","type":"command","command":"/path/cmd","timeout":5000}]}]}}
```
- Hook fields: `type` (only "command"), `command`, `name`, `timeout` (ms, default 60000), `description`.
- Stdin JSON, common: `session_id, transcript_path, cwd, hook_event_name, timestamp`.
- `Notification`: `notification_type` (only "ToolPermission" listed), `message`, `details`. This is the permission-requested signal.
- `AfterAgent` (turn finished): `prompt, prompt_response, stop_hook_active`.
- `AfterTool`: `tool_name, tool_input, tool_response`.
- `BeforeTool`: `tool_name, tool_input, ...`.
- Exit 0 = stdout parsed as JSON. Exit 2 = block (stderr is the reason). Other = warning.
- Hook env: `GEMINI_PROJECT_DIR, GEMINI_PLANS_DIR, GEMINI_SESSION_ID, GEMINI_CWD, CLAUDE_PROJECT_DIR`.
- Related settings: `hooksConfig.enabled` (default true), `hooksConfig.disabled`, `hooksConfig.notifications`.

### Per-session config without touching ~/.gemini
Source: https://geminicli.com/docs/reference/configuration/ (first 100k chars of ~117k read)
- Precedence, low to high: defaults, system-defaults, user, project, SYSTEM settings, env vars, CLI args.
- `GEMINI_CLI_SYSTEM_SETTINGS_PATH` overrides the system settings file location (macOS default `/Library/Application Support/GeminiCli/settings.json`). `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` overrides the defaults file.
- Setting `GEMINI_CLI_SYSTEM_SETTINGS_PATH` to a per-session file is the recommended approach.
- Caveat: system settings sit ABOVE user and project settings in precedence. Whether `hooks` arrays merge or replace across layers is UNVERIFIED. The user's own hooks may be shadowed.
- Alternative: write `<cwd>/.gemini/settings.json`. That modifies the project, so it is not preferred.
- Folder trust: `security.folderTrust.enabled` (default true). Env `GEMINI_CLI_TRUST_WORKSPACE` trusts the current workspace for the session and bypasses the check.
- First-run screens (theme/auth/trust): not found in official docs. UNVERIFIED. Pre-seeded settings (`security.auth.selectedType`, theme) not verified.

### Approvals
- https://geminicli.com/docs/cli/tutorials/shell-commands/ says prompts offer Allow once / Allow always / Deny, and shows `Allow command 'npm test'? [y/N]`, so `y` approves.
- The main tool-confirmation UI is a numbered menu per community write-ups ("Yes, allow once" / "Yes, allow always..." / "No, suggest changes (esc)"). Source: deepwiki.com/waywardgeek/gemini-cli/7.5-approval-modes-and-confirmation and zenn.dev. UNVERIFIED. Exact keys: Enter on the highlighted default, Esc to deny. `Ctrl+Y` toggles YOLO (third-party, UNVERIFIED).

### Version
- `gemini --version`: format not retrieved. UNVERIFIED (expected a bare semver like `0.x.y`).

## 3. OpenCode (sst/opencode, opencode.ai)
### CLI
Source: https://opencode.ai/docs/cli/
- TUI: `opencode [project]`. The project path is positional, which gives the working dir.
- `--prompt <text>` (initial prompt), `--model` / `-m provider/model`, `--agent`, `--continue` / `-c`.
- `--version` / `-v`.
- Env vars: `OPENCODE_CONFIG` (config file path), `OPENCODE_CONFIG_CONTENT` (inline JSON), `OPENCODE_CONFIG_DIR` (directory with agents/commands/modes/plugins), `OPENCODE_PERMISSION` (inline JSON permissions).
- Effort/variants (https://opencode.ai/docs/models/): `variants` per model. Anthropic has `high` (default) and `max`. OpenAI has `none, minimal, low, medium, high, xhigh` (varies by model). Google has `low, high`. Option keys include `reasoningEffort`, `textVerbosity`. No `--variant` CLI flag is documented. Switch with the `variant_cycle` keybind `ctrl+t` (https://opencode.ai/docs/keybinds/). To fix effort per session, set `provider.<p>.models.<m>.options.reasoningEffort` in the per-session config (via `OPENCODE_CONFIG_CONTENT`). A `--variant` flag is UNVERIFIED.

### Plugins and events
Source: https://opencode.ai/docs/plugins/
- Plugins are JS/TS modules exporting async functions. Each receives `{project, directory, worktree, client, $}` and returns a hooks object.
- Load sources: `.opencode/plugins/`, `~/.config/opencode/plugins/`, the `"plugin": [...]` array of npm names in opencode.json, and `OPENCODE_CONFIG_DIR/plugins` (https://opencode.ai/docs/config/).
- Event handler form: `event: async ({ event }) => { if (event.type === "session.idle") {...} }`.
- Events:
  - Session: `session.created, session.compacted, session.deleted, session.diff, session.error, session.idle, session.status, session.updated`.
  - Permission: `permission.asked, permission.replied`.
  - Tool: `tool.execute.before, tool.execute.after`. Documented hook shape is `"tool.execute.before": async (input, output)` with `input.tool` and `output.args`.
  - Others: `message.*, todo.updated, tui.toast.show, server.connected`.
- `event.properties` shape was not documented in the fetched page (UNVERIFIED). `tool.execute.after` signature is UNVERIFIED. No `permission.ask` hook is documented.
- Per-session loading without touching global config: set `OPENCODE_CONFIG_DIR=<tmpdir>` with `<tmpdir>/plugins/notify.js` (the plugin posts to the localhost server with the token read from env). Or set `OPENCODE_CONFIG_CONTENT='{"plugin":[...]}'`. The first is documented as searched for plugins. Combining it with global config is additive ("all hooks run in sequence").
- Config precedence (https://opencode.ai/docs/config/): remote, global, `OPENCODE_CONFIG`, project `opencode.json`, `.opencode` dirs, `OPENCODE_CONFIG_CONTENT`, managed files, then macOS MDM.
- An alternative that can avoid plugin files: `opencode serve` HTTP/SSE API. NOT researched, UNVERIFIED.

### Permissions and UI
Source: https://opencode.ai/docs/permissions/
- Config: `"permission": {"*":"ask","bash":{"*":"ask","git *":"allow"},"edit":"deny"}`. Actions are allow|ask|deny, and the last match wins.
- The TUI prompt offers three outcomes: once / always / reject. The exact keys are not documented. Navigation is up/down (or ctrl+p/ctrl+n) with Enter to submit (`dialog.select.*`). `permission.prompt.fullscreen` = ctrl+f. Esc = `session_interrupt`. Hotkeys are UNVERIFIED, so test in the PTY.
- Leader key is `ctrl+x`, with a 2000ms timeout.
- Updates: `autoupdate: false` disables update checks. Default is notify-only (https://opencode.ai/docs/config/).
- First-run screens: none documented. A provider-auth step (`opencode auth login`) is likely needed. UNVERIFIED.
- Version: `opencode --version` / `-v` prints the version. The exact format is not retrieved (likely bare semver, UNVERIFIED).

## 4. Tauri 2 plugins and core
Latest core crate seen: tauri 2.12.5 (docs.rs/tauri/latest, 2026-10-31).

### Notification
Sources: https://v2.tauri.app/plugin/notification/ and https://github.com/tauri-apps/plugins-workspace/releases/tag/notification-v2.6.0
- Requires Rust >= 1.90.
- Install: `cargo add tauri-plugin-notification`, `npm i @tauri-apps/plugin-notification`, register `.plugin(tauri_plugin_notification::init())`.
- Permission: `notification:default`. It includes `allow-is-permission-granted, allow-request-permission, allow-notify, allow-show, allow-register-action-types, allow-create-channel, ...`.
- Rust: `use tauri_plugin_notification::NotificationExt; app.notification().builder().title("T").body("B").show()?;`
- JS: `isPermissionGranted()` / `requestPermission()` (returns 'granted') / `sendNotification({title, body})`.
- Docs have no macOS-specific notes and no focus behaviour. The plugin does not auto-suppress when focused, so gate it in your own code.
- Click handling: notification plugin v2.6.0 release notes say desktop now reports actions: "a click on a notification (`tap`) or on one of the actions of its action type reaches `onAction`", plus Rust `Notification::on_action`. Before 2.6.0 the action commands failed on desktop. The main docs page still says the Actions API is "only available on mobile". The release notes are the more recent source. The behaviour on macOS in practice is UNVERIFIED. The `onAction` payload type is `ActionPerformed` (breaking change in 2.6.0).
- Windows needs an installed app. macOS unsigned/dev builds may not show notifications reliably (UNVERIFIED, test with a bundled app).

### Dock badge (core API, no plugin)
Sources: https://docs.rs/tauri/latest/tauri/window/struct.Window.html and https://github.com/tauri-apps/tauri/commit/020ea05561348dcd6d2a7df358f8a5190f661ba2. Added in Tauri 2.2.0 (via tauri-runtime release notes).
- `Window::set_badge_count(&self, count: Option<i64>) -> Result<()>`. Desktop (macOS/Linux) and iOS. Not supported on Windows (use `set_overlay_icon`) or Android. `0` or `None` clears it.
- `Window::set_badge_label(label: Option<String>)`. macOS only. A stub elsewhere. `None` clears it.
- Permissions: `core:window:allow-set-badge-count`, `core:window:allow-set-badge-label`. They are not in the default set (UNVERIFIED, check `core:window:default`) and are only needed for JS calls. Rust calls need no capability.
- JS: `getCurrentWindow().setBadgeCount(n)` / `.setBadgeLabel(str)` (see the kotlin-wrappers mirror and Tauri JS API).

### Updater
Source: https://v2.tauri.app/plugin/updater/
- Install: `cargo add tauri-plugin-updater`, `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process` for relaunch. Register in `lib.rs` under `#[cfg(desktop)]` as `.plugin(tauri_plugin_updater::Builder::new().build())` (the exact builder call is not shown in the fetched text, UNVERIFIED).
- Keys: `tauri signer generate -w ~/.tauri/myapp.key`. Put the public key content (not a path) in tauri.conf.json `plugins.updater.pubkey`.
- Env: `TAURI_SIGNING_PRIVATE_KEY` (path or content) and optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. ".env files do not work".
- `bundle.createUpdaterArtifacts: true` (or "v1Compatible"). macOS output: `.app.tar.gz` + `.sig`.
- `plugins.updater.endpoints`: array of URLs. TLS is enforced (`dangerousInsecureTransportProtocol` overrides). Variables: `{{current_version}}`, `{{target}}` (linux|windows|darwin), `{{arch}}` (x86_64|i686|aarch64|armv7). The next endpoint is tried only on a non-2xx.
- Static `latest.json`: required `version`, `platforms.<os>-<arch>.{url, signature}`. Optional `notes`, `pub_date` (RFC 3339). Keys are like `darwin-aarch64`, `darwin-x86_64`. Every platform entry must be complete. `signature` is the content of the `.sig` file.
- Dynamic server: 204 for no update. 200 with `{url, version, signature, notes?, pub_date?}`.
- JS: `const update = await check(); await update?.downloadAndInstall(ev => ...)` (events Started/Progress/Finished); then `relaunch()`.
- Rust: `app.updater()?.check().await?`, `update.download_and_install(on_chunk, on_done).await?`, `app.restart()`.
- Capability: `"updater:default"` (check/download/install/download-and-install).
- Universal macOS build: set a custom target such as `macos-universal` at runtime, otherwise the target is `darwin-aarch64`/`darwin-x86_64`. For a universal binary, both platform keys in `latest.json` may point at the same tar.gz. This is inferred, UNVERIFIED.
- macOS needs a bundled `.app`. Updating does not work in `tauri dev`.

### macOS signing and notarization
Sources: https://v2.tauri.app/distribute/sign/macos/, https://v2.tauri.app/distribute/dmg/, https://v2.tauri.app/distribute/macos-application-bundle/
- Env: `APPLE_SIGNING_IDENTITY` (or `bundle.macOS.signingIdentity`; "-" = ad-hoc), `APPLE_CERTIFICATE` (base64 .p12) + `APPLE_CERTIFICATE_PASSWORD` (CI).
- Notarization with Apple ID: `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`.
- Notarization with API key: `APPLE_API_ISSUER`, `APPLE_API_KEY` (key ID), `APPLE_API_KEY_PATH` (.p8).
- Notarization is required for Developer ID. `--skip-stapling` is available.
- Universal: `rustup target add aarch64-apple-darwin x86_64-apple-darwin` then `tauri build --target universal-apple-darwin`. Sources are the Tauri CLI reference https://v2.tauri.app/references/cli/ plus secondary sources (github.com/tauri-apps/tauri commit 83f52fd; a Chinese docs mirror). The official distribute page didn't mention it.
- Entitlements: `bundle.macOS.entitlements` → `./Entitlements.plist` in src-tauri. `bundle.macOS.minimumSystemVersion` (default 10.13). The `hardenedRuntime` page had no content (UNVERIFIED).
- DMG: `tauri build --bundles dmg`. Config under `bundle.macOS.dmg`: `background, windowSize {width,height} (default 660x400), windowPosition, appPosition, applicationFolderPosition`. Icon positions are ignored on CI/headless (tauri#1731).
- Sandbox caveat: this app launches CLIs in PTYs, so do NOT enable `com.apple.security.app-sandbox`. Hardened-runtime exceptions (e.g. JIT/unsigned memory) may be needed only if bundled helpers require them (UNVERIFIED).

## 5. Window focus detection in Tauri 2
Sources: https://docs.rs/tauri/latest/tauri/enum.WindowEvent.html and https://docs.rs/tauri/latest/tauri/window/struct.Window.html
- `WindowEvent::Focused(bool)`: true = gained, false = lost.
- Poll: `window.is_focused() -> Result<bool>`.
- Listener: `window.on_window_event(|e| if let WindowEvent::Focused(f) = e {...})`. Or `Builder::on_window_event(|window, event| ...)`.
- Maintain an `AtomicBool` updated from the events and read it before notifying. Also treat minimized/hidden as "background" via `is_minimized()` / `is_visible()`.
- Per-session pty focus (session in a non-selected tab) is app-level state, not window focus.
