# Antigravity CLI (`agy` 1.4.6): PTY launch and status events

Date: 2026-10-31. Binary: `~/.local/bin/agy` (Mach-O arm64, Go).
Sources: the strings dump at `scratchpad/agy-strings.txt` (line numbers below, written `S:<line>`), `agy --help`, `agy models`, `agy plugin validate`, the live docs at antigravity.google/docs/cli/reference, and four short observed runs (listed in section 7).

---

## TL;DR recommendation

1. **Main status channel: OSC 7501 (the "Program Status Protocol").** agy 1.4.0 and later emit terminal status reports for *working / waiting for your input / done / failed*. The changelog (S:156932) says: "Added terminal status reporting over OSC 7501 ... the tab or window shows whether the CLI is working, waiting for your input, done, or failed. The CLI checks for support first ... Set `AGY_CLI_OSC7501=off` to turn it off, `AGY_CLI_OSC7501=on` for a terminal that supports it but doesn't answer the check, or `AGY_CLI_OSC7501_MESSAGES=brief` ...". This is the only channel that covers **needs-you**, meaning a permission prompt or a question, because no hook event fires for those. The adapter would launch with `AGY_CLI_OSC7501=on` and parse `ESC ] 7501 ; <body> ST` out of the PTY byte stream in Rust. Alternatively it could answer the `ESC]7501;?ESC\` query, which appears at S:548. Nothing has to be written anywhere. The body format here comes from other implementers (Rho, OpenTUI), **not** from agy: `state=<idle|working|blocked|done|error>:app=<name>[:kind=<permission|question|auth>][:msg=<base64>]`, with clear sent as `state=clear`. **Confidence:** high that agy emits OSC 7501; medium on agy's exact keys and values. Capture one real sample before you write the parser (see section 8).
2. **Optional richer channel: hooks through `--add-dir <session-dir>`.** I verified that a temp dir passed with `--add-dir` and containing `.agents/hooks.json` gets its hooks loaded and fired (observed). This touches no user config. One caveat: the added dir becomes `workspacePaths[0]`, and in my run the model resolved "the current directory" to the hook dir instead of the cwd. Treat this as experimental until the ordering issue is handled.
3. **Never register `PreToolUse`.** It has no pass-through decision. A hook that returns `{}` **denied** the tool call (observed: `"tool call denied by pre-tool hook:"`). The allowed values are `allow|deny|ask|force_ask|deny_unless_prior_grant` (S:649203).
4. **Fallback for needs-you:** screen needles (section 4) plus a silence heuristic, as the Gemini adapter already does.

---

## 1. Hook system

**Confidence: high.** Source: the embedded doc "Lifecycle Hooks (`hooks.json`)" at S:78736–79060, confirmed by observed payloads.

### Events
| Event | When it fires | Matcher | Shape |
|---|---|---|---|
| `SessionStart` | Once, when a new conversation starts | ignored | flat list of handlers |
| `PreToolUse` | Before a tool step runs. Can gate it (allow/deny/ask/force_ask) | tool-name regex | `[{matcher, hooks:[...]}]` |
| `PostToolUse` | After a tool step completes. Payload has `error` if the tool failed | tool-name regex | grouped |
| `PreInvocation` | Before **each** model call (`invocationNum` 0, 1, 2, ...) | ignored | flat |
| `PostInvocation` | After each model call / tool round | ignored | flat |
| `Stop` | When the execution loop terminates, i.e. the turn ends | ignored | flat |

There is **no** Notification, PermissionRequest or UserPromptSubmit event. Matcher syntax: `"*"` or `""` matches all tools, and otherwise it is a regex such as `run_command\|view_file` or `browser_.*`. Tool names are the lowercased step type with `CORTEX_STEP_TYPE_` stripped. In my run the observed tool name was `read_file`.

### hooks.json schema
```json
{
  "coc-status": {                       // named hook; "enabled": false disables it
    "SessionStart":   [{"type":"command","command":"...","timeout":5}],
    "PreInvocation":  [{"type":"command","command":"...","timeout":5}],
    "PostToolUse":    [{"matcher":"*","hooks":[{"type":"command","command":"...","timeout":5}]}],
    "Stop":           [{"type":"command","command":"...","timeout":5}]
  }
}
```
- `type` accepts only `"command"`. The command runs via `sh -c`, `~` is expanded, and **the cwd is the directory containing hooks.json**.
- `timeout` is in **seconds** (default 30), not milliseconds as in the Gemini adapter's `5000`.
- Hooks run **synchronously and block the agent loop**, so keep them fast (`curl -m 2`).
- Hooks from several sources are merged and run in sequence.
- A Claude Code-style top-level `"hooks"` key loads as one hook *named* `hooks` (S:156892). Do not wrap the file in `{"hooks":...}`.
- `agy plugin validate` accepted this exact shape with "hooks 1", which I observed.

### Output contract
- stdout must be JSON, with camelCase keys.
- **PreToolUse:** `decision` is required. As observed, an empty `{}` means deny. Do not use this event.
- **PostToolUse:** expects `{}`. If the hook fails, the failure is logged and the tool keeps its result (changelog, S:157000-range "Fixed a PostToolUse hook that fails to run ... marking the tool call ... failed").
- **PreInvocation / PostInvocation:** `{"injectSteps":[], "terminationBehavior":""}`. `{}` is fine, as observed.
- **Stop:** `{"decision":"continue"}` blocks the stop. Anything else, including `{}`, lets the turn end.
- The hook command should therefore be `curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- '<url>' >/dev/null 2>&1; echo '{}'`, so that stdout always carries valid JSON.

### Payloads (observed verbatim, paths shortened)
Common fields on every event:
```json
{"conversationId":"0840180b-...","workspacePaths":["<added-dir>","<cwd>"],
 "transcriptPath":"~/.gemini/antigravity-cli/brain/<cid>/.system_generated/logs/transcript_full.jsonl",
 "artifactDirectoryPath":"~/.gemini/antigravity-cli/brain/<cid>",
 "modelName":"gemini-3.8-flash-low","lastUserInput":"<the user's prompt>"}
```
- `PreInvocation` and `PostInvocation` add `"invocationNum":0,"initialNumSteps":1`.
- `PreToolUse` and `PostToolUse` add `"stepIdx":2,"toolCall":{"name":"read_file","args":{"Path":"..."}}`, and PostToolUse also carries `"error"` when the tool failed.
- `Stop` adds `"executionNum":0,"terminationReason":"NO_TOOL_CALL","error":"","fullyIdle":true`. `terminationReason` takes these values: NO_TOOL_CALL (normal), MAX_INVOCATIONS, MAX_FORCED_INVOCATIONS, MAX_TOKEN_BUDGET_EXCEEDED, ERROR, USER_CANCELED, TERMINAL_STEP_TYPE, TERMINAL_CUSTOM_HOOK, INJECTED_RESPONSE.
- None of the payloads contain a cwd field or a session token. Put the token in the hook URL or command line, as the existing adapters do. agy also sets `ANTIGRAVITY_CONVERSATION_ID=%s` in the environment of child commands (S:2063).

Observed firing order for one turn with one tool call: SessionStart, PreInvocation(0), PreToolUse, PostInvocation(0), PreInvocation(1), PostInvocation(1), Stop(NO_TOOL_CALL).

### Mapping to app states
| App state | Source |
|---|---|
| working | `PreInvocation` (any invocationNum), or OSC 7501 `state=working` |
| tool used | `PostToolUse` (`toolCall.name`, `error`) |
| needs-you (permission / question) | **no hook.** OSC 7501 `state=blocked` (kind permission/question), or the screen needles in section 4 |
| finished | `Stop` with `terminationReason` NO_TOOL_CALL / TERMINAL_STEP_TYPE / INJECTED_RESPONSE / TERMINAL_CUSTOM_HOOK, or OSC `state=done` |
| failed | `Stop` with `terminationReason` ERROR / MAX_* or a non-empty `error`, or OSC `state=error` |
| idle after cancel | `Stop` with USER_CANCELED |

---

## 2. Injecting hooks for one session without touching user config

Discovery roots, per the customization guide at S:45192–45260:
1. Workspace `.agents/`, `.agent/`, `_agents/` or `_agent/`, found by walking up from the cwd to the repo root. **Forbidden**, because it is project config.
2. Declared configs `skills.json` / `plugins.json` in the workspace `.agents/`.
3. Global `~/.gemini/config/` (`hooks.json`, `plugins/<name>/hooks.json`). **Forbidden.**
4. Built-ins.

| Mechanism | Result | Evidence | Confidence |
|---|---|---|---|
| `--settings '<json or path>'` (session-only, "never saved") | **Cannot carry hooks.** `--settings '{"hooks":...}'` produced `Error: --settings: unknown setting "hooks"` | observed | high |
| `ANTIGRAVITY_GEMINI_DIR=<tmp>` with `config/hooks.json` | Not honored by the CLI: `/hooks` listed nothing | observed | high |
| `ANTIGRAVITY_CONFIG_REL_DIR=<rel path to tmp>` | Not honored, nothing listed | observed | medium |
| `HOME=<tmp>` with `.gemini/config/hooks.json` | **Breaks auth.** The keychain lookup fails and agy starts a Google OAuth sign-in. Do not use. | observed | high |
| **`--add-dir <tmp>`** where `<tmp>/.agents/hooks.json` exists | **Works.** `-p "/hooks"` listed all 6 handlers, and a real `-p` run fired them | observed | high |
| Custom agent (`--agent name`) with `hooks:` frontmatter listing paths (S:157022, yaml `hooks` tag at S:583784) | Plausible, but the agent file must itself be discoverable (workspace `.agents/agents/` or global), so it still needs `--add-dir` | strings only | low |

**Auth is not in the config dir.** The logs show `keyringAuth: loaded token` and `ChainedAuth: authenticated via keyring` (`~/.gemini/antigravity-cli/log/*.log`), which is the macOS Keychain, and `/logout` "purge[s] authentication tokens from the secure keyring" (docs). Even so, overriding HOME breaks the keychain lookup, so it is not an option.

**`--add-dir` caveats (must be handled):**
- The added dir is listed **first** in `workspacePaths` (observed `[added, cwd]`). The model then resolved "notes.txt in the current directory" to `<added>/notes.txt`. Two mitigations, neither tested: (a) also pass `--add-dir <cwd>` before the hook dir; (b) add `<tmp>/.agents/rules/AGENTS.md` saying the folder is internal plumbing and naming the real project root.
- The hook dir sits inside the agent's workspace, so the agent can read and edit it. That is minor, and the token is per session.
- Workspace trust: in `-p` mode the untrusted `/private/tmp` dir's hooks loaded. Interactive mode may show "Do you trust the contents of this project?" / "Trust this folder?" (S:2385, S:1587) for an untrusted cwd. The changelog notes that workspace hooks reload "after trusting a folder" (S:157615). `trustedWorkspaces` is a valid settings key, so `--settings '{"trustedWorkspaces":["<cwd>","<hookdir>"]}'` might pre-trust both for the session only. Untested, and it may replace rather than merge the user's list for that session.
- The dir needs only `.agents/hooks.json`. Make it private (0700), as the other adapters do.

---

## 3. Interactive launch flags

**Confidence: high for the flags themselves, medium for `--`.**
- `-i` / `--prompt-interactive <text>`: "Run an initial prompt interactively and continue the session". Combining it with `-p` exits with status 2 (changelog, S:157000s).
- Go `flag`-style parsing (`Usage of agy:`). Use `--prompt-interactive=<task>` in a single argv element, so that a task starting with `-` cannot be read as a flag. Go's `flag` package stops at `--`, but agy has no positional prompt in `--help`, so **do not rely on `--` plus a positional**. The `=` form is the safe one.
- `--model <id>`, values from `agy models` (observed): `gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}`, `gpt-oss-120b-medium`. The list is account-dependent, so fetch it at runtime (`agy models` prints `id<TAB>label` and needs auth).
- `--effort low|medium|high|xhigh|max` (help). There is an error string `invalid model selection (--model %q --effort %q)` (S:2536), so some model/effort pairs are rejected. Model ids already embed an effort suffix, so prefer passing only `--model`.
- Other useful flags: `--mode accept-edits|auto|plan`, `--conversation <id>` / `-c` to resume, `--log-file` (it does not move the rest of `~/.gemini`), and `--dangerously-skip-permissions`.
- Headless alternative: `-p ... --output-format stream-json` gives NDJSON `init`, `step_update` (state ACTIVE/DONE/ERROR, tool_name, error) and `result` events (observed). That is a good fit for non-PTY use, but tool prompts are soft-denied in headless mode ("headless soft-deny tool confirmation", S:2222).

## 4. Permission prompt on screen

**Confidence: medium.** These come from strings and docs. I did not see a live render.
- Option labels (S:2356, S:2448, S:2536): `Yes, and always allow tool '%s' in this conversation`, `Yes, and always allow '%s' in this conversation`, `Yes, and always allow tool '%s' (Persist to %s)`, `Yes, and always allow '%s' (Persist to %s)`, `Yes, and always allow access to '%s' (Persist to %s)`, `Yes, and always allow non-workspace access`, `Yes, grant permission for %s (Persist to %s)`, `No, and always deny for %s in this conversation`, `No, and always deny for %s (Persist to %s)`. A `Reason:` line appears when approval is not obvious (changelog).
- Good needles: `Yes, and always allow`, `always deny for`, `Persist to`, `Answer question` (S:1409), and `Do you trust the contents of this project?`.
- Keys (docs): `y` approves the proposed tool/command/artifact, `n` rejects, `Enter` submits the menu selection, `Esc` cancels. `Ctrl+K` approves a pending subagent action and `Alt+J` jumps to the next subagent awaiting confirmation. Strings also show `shift+y`, `shift+n`, `n / esc` and `d / c / y` near the prompt UI (S:418, S:548).

## 5. GUI-launch pitfalls

- **PATH:** agy lives in `~/.local/bin`, which a Finder-launched app's PATH usually lacks. Resolve it to an absolute path, or use the login-shell PATH as the other adapters do. agy also ships a bundled node (`Using bundled agy-nodefs`, `~/.gemini/antigravity-cli/bin`).
- **Auth:** keychain-based. It works from a GUI app in the same user session as long as **HOME is the real home**. With a temp HOME, agy prints an OAuth URL and starts a browser sign-in (observed). If the user is not logged in, interactive agy shows the sign-in flow ("Open this URL in your local browser to sign in:"), and `agy models` errors with "Please sign in ... Launch the CLI without arguments to sign in."
- **TTY:** the interactive TUI needs a real PTY. It uses alt-screen and probes the terminal with OSC 10/11/12 colour queries, OSC 52, `ESC]7501;?` and a version probe. Unanswered probes time out harmlessly (log: `terminal version probe: set read deadline: file type does not support deadline`). Exit is `Ctrl+D Ctrl+D` or `/exit`. Set `TERM=xterm-256color`.
- **Trust dialog** for a new cwd in interactive mode (see section 2).
- Every run writes logs and conversation state to `~/.gemini/antigravity-cli/` (`log/`, `conversations/`, `brain/<cid>/`, `implicit/`, caches). This is normal agy behaviour and does not change settings.
- Hooks block the agent loop, so the localhost endpoint must answer fast. Use `curl -m 2` and a hook `timeout` of a few seconds.

## 6. OSC 7501 details

- agy queries support with `ESC ] 7501 ; ? ST` (S:548, next to the OSC 52 queries). `AGY_CLI_OSC7501=on` forces reports even if the terminal does not answer, and `AGY_CLI_OSC7501_MESSAGES=brief` strips details "such as the pending command or question" (S:156932).
- Spec as implemented by Rho (docs.rs rho-coding-agent `program_status.rs`): the query is `\x1b]7501;?\x1b\\` and a supporting terminal echoes `7501;?`. A report is `\x1b]7501;state=<s>:app=<app>[:kind=<k>][:msg=<base64>]\x1b\\`. States are idle/working/blocked/done/error, kinds (blocked only) are permission/question/auth, and clear is `state=clear`. OpenTUI uses `{state:"blocked", kind:"permission", message:"Allow bash?"}`. The protocol was proposed by Mitchell Hashimoto, and Crush, cmux, Claude Code 2.1.295 and Pi reportedly emit or consume it.
- Implementation in the app:
  - Option 1: in the Rust PTY reader, scan for `ESC]7501;` up to `ESC\` or BEL. The existing `status.rs` already strips OSC for its needle matching.
  - Option 2: in xterm.js, use `term.parser.registerOscHandler(7501, data => ...)`. Reply to `?` by writing `\x1b]7501;?\x1b\\` back to the PTY, or simply set `AGY_CLI_OSC7501=on`.
  - Accept both ST and BEL terminators, and treat unknown keys leniently.

## 7. Commands run and their effect on the user's agy setup (full disclosure)

All runs used cwd under `scratchpad/agy/` and the real HOME unless noted. None wrote to `~/.gemini/config`, `settings.json`, `config.json`, `oauth_creds.json` or `jetski-standalone-oauth-token`; all mtimes are unchanged (checked after the runs).
1. `agy --help`, `agy models`, `agy agents`, `agy plugin list --json`, `agy help plugin|agents`, and `agy plugin validate scratchpad/agy/plug/coc`. All read-only.
2. `agy -p "/hooks"` in `proj/` and in `hookdir/`, then `agy -p "/hooks" --add-dir hookdir`, then `agy -p "/hooks" --settings '{"hooks":...}'` (rejected). These are local slash commands with no model call. They wrote logs, `implicit/*.pb` and `cache/onboarding.json` under `~/.gemini/antigravity-cli/`.
3. **One model run:** `agy -p "Read the file notes.txt ..." --add-dir scratchpad/agy/hookdir --model gemini-3.8-flash-low --output-format stream-json`. It created conversation `0840180b-4116-4828-8923-3ae6a55d4786` in the user's agy history (`~/.gemini/antigravity-cli/conversations/`, `brain/`, `annotations/`, `presence/`) and used a few thousand tokens of the user's quota.
4. `ANTIGRAVITY_GEMINI_DIR=scratchpad/agy/gdir agy -p "/hooks"`. No effect, and nothing was written to the temp dir.
5. **`HOME=scratchpad/agy/home agy -p "/hooks"` and `HOME=scratchpad/agy/home agy models`.** With a temp HOME the keychain token was not found, so agy printed a Google OAuth URL and **this is what opened the browser sign-in**. agy wrote a fresh `.gemini/` skeleton only inside the temp HOME. The sign-in was never completed, so no new token was stored, and the user's real keychain login was not modified. Later runs with the real HOME were already done and authenticated ("Auth succeeded" in logs) before this step. The user can simply close the sign-in tab.
6. `ANTIGRAVITY_CONFIG_REL_DIR=../..<scratchpad>/agy/gdir2 agy -p "/hooks"`. No effect, nothing written.
No agy processes remain running (checked with `pgrep`).

## 8. Still to verify (needs one interactive run, with user consent)

- agy's exact OSC 7501 body: key names, whether `msg` is base64, and the terminator. Launch `AGY_CLI_OSC7501=on agy --prompt-interactive="run: echo hi"` in a PTY, record the raw bytes, and deny the prompt.
- What the live permission prompt renders and which key selects each option.
- Whether `--add-dir <cwd> --add-dir <hookdir>` keeps the cwd as `workspacePaths[0]`, and whether interactive mode needs a trust answer before workspace hooks load.
