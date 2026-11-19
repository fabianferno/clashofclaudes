//! Claude Code adapter.
//!
//! Approval keys, confirmed against Claude Code 2.1.314 by driving a real TUI session
//! through `expect` (haiku, settings with `permissions.ask: ["Bash"]`):
//!   * `1` at the "Do you want to proceed?" Bash permission menu ("1. Yes") approved it:
//!     a `PostToolUse` hook for Bash followed and hello.txt was created.
//!   * `Esc` (0x1b) at the same menu denied it: the TUI showed "Interrupted - What should
//!     Claude do instead?" and no `PostToolUse` hook fired for that command.
//!
//! Hook payload shape (see tests/fixtures/claude-hooks/): every payload has `session_id`,
//! `cwd` and `hook_event_name`. `Notification` carries `notification_type`
//! (`permission_prompt` | `idle_prompt` observed) and a `message`. `SubagentStart` and
//! `SubagentStop` carry the subagent's `agent_id` and `agent_type`; `Stop` lists the turn's
//! `background_tasks` (observed on 2.1.318 with two parallel Agent-tool subagents).
//! The AskUserQuestion picker, confirmed against 2.1.328 the same way (haiku, a pty): a
//! single-select question takes the option's digit and moves on; its "Type something" row
//! (digit n+1 for n options) takes typed text and Enter. A multi-select question toggles an
//! option per digit without moving the cursor (row 1); Down moves to "Type something" (typing
//! there checks it) and on to its "Submit"/"Next" row, where Enter moves on (Tab inside the
//! text row only moves down a row). Several questions, or any multi-select one, end on a
//! "Review your answers" screen whose `1` is "Submit answers". Keys sent too fast in one write
//! may be read as one input: the app sends them one at a time (`src/panels/askKeys.ts`).
//! Fixture paths: `/Users/<name>/` was rewritten to `/home/user/` to avoid leaking a username.
use super::{AgentAdapter, Detection, DetectionCache, LaunchRequest, ScreenPrompt, DETECTION_TTL};
use crate::model::{AgentKind, AskOption, AskQuestion};
use crate::pty::LaunchSpec;
use crate::status::{StatusEvent, StatusPolicy};
use std::path::PathBuf;
use std::time::Instant;

/// Appended to every agent session's system prompt.
pub const SHARED_FOLDER_NOTE: &str = "Other coding agents may be working in this same folder at the same time. If your task needs isolation from their changes, you may create your own git worktree and work there.";

const HOOK_EVENTS: [&str; 9] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
];

/// A tool call in a few words for the briefing: the tool and what it acts on (`Bash: npm test`,
/// `Edit: src/app.ts`). Paths under `cwd` are shown relative to it.
pub(crate) fn tool_summary(tool: &str, input: Option<&serde_json::Value>, cwd: Option<&str>) -> String {
    let field = |k: &str| input.and_then(|i| i.get(k)).and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty());
    let what = ["command", "file_path", "notebook_path", "url", "pattern", "query", "path", "description", "prompt"]
        .iter()
        .find_map(|k| field(k))
        .map(|v| match cwd.map(|c| format!("{}/", c.trim_end_matches('/'))) {
            Some(prefix) if v.starts_with(&prefix) => v[prefix.len()..].to_string(),
            _ => v.to_string(),
        });
    match what {
        Some(w) => format!("{tool}: {}", w.split_whitespace().collect::<Vec<_>>().join(" ")),
        None => tool.to_string(),
    }
}

/// The questions of an AskUserQuestion call (`{questions: [{question, header, options: [{label,
/// description}], multiSelect}]}`); empty when the input has none the app could offer as buttons.
/// The picker numbers options from 1 and takes a digit per option, so at most 8 are kept (the
/// next numbers are its own "Type something" and "Chat about this" rows).
pub(crate) fn ask_questions(input: Option<&serde_json::Value>) -> Vec<AskQuestion> {
    const MAX_QUESTIONS: usize = 4;
    const MAX_OPTIONS: usize = 8;
    const MAX_TEXT: usize = 400;
    let text = |v: Option<&serde_json::Value>| {
        v.and_then(|v| v.as_str()).map(str::trim).filter(|t| !t.is_empty()).map(|t| t.chars().take(MAX_TEXT).collect::<String>())
    };
    let Some(qs) = input.and_then(|i| i.get("questions")).and_then(|q| q.as_array()) else { return vec![] };
    let parsed: Option<Vec<AskQuestion>> = qs
        .iter()
        .take(MAX_QUESTIONS)
        .map(|q| {
            let options: Vec<AskOption> = q
                .get("options")?
                .as_array()?
                .iter()
                .map(|o| Some(AskOption { label: text(o.get("label"))?, description: text(o.get("description")) }))
                .collect::<Option<_>>()?;
            (!options.is_empty() && options.len() <= MAX_OPTIONS).then_some(AskQuestion {
                question: text(q.get("question"))?,
                header: text(q.get("header")),
                options,
                multi_select: q.get("multiSelect").and_then(|m| m.as_bool()).unwrap_or(false),
            })
        })
        .collect();
    // all or nothing: a picker the app can't fully mirror is answered in the terminal
    match parsed {
        Some(p) if p.len() == qs.len() => p,
        _ => vec![],
    }
}

/// The text of the last assistant message in a Claude transcript (JSONL; one line per content
/// block, blocks of one message share `message.id`). Reads only the file's last 512 KB.
pub(crate) fn last_reply_in_transcript(path: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 512 * 1024;
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<serde_json::Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let texts_of = |v: &serde_json::Value| -> Vec<String> {
        v.pointer("/message/content")
            .and_then(|c| c.as_array())
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    let is_reply = |v: &serde_json::Value| v.get("type").and_then(|t| t.as_str()) == Some("assistant") && v.get("isSidechain").and_then(|s| s.as_bool()) != Some(true);
    let last = lines.iter().rposition(|v| is_reply(v) && !texts_of(v).is_empty())?;
    let id = lines[last].pointer("/message/id").cloned();
    let parts: Vec<String> = lines
        .iter()
        .filter(|v| is_reply(v) && id.is_some() && v.pointer("/message/id") == id.as_ref())
        .flat_map(texts_of)
        .collect();
    let joined = if parts.is_empty() { texts_of(&lines[last]) } else { parts }.join("\n\n");
    let t = joined.trim();
    (!t.is_empty()).then(|| t.to_string())
}

pub struct ClaudeAdapter;

/// Shell command run by Claude for each hook: posts the JSON payload (stdin) to the app.
pub(super) fn hook_command(hook_url: &str) -> String {
    // The URL is app-generated; still quote it safely for `sh`.
    let quoted = hook_url.replace('\'', "'\\''");
    format!("curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- '{quoted}'")
}

/// Status-line command: copies Claude's status JSON (it carries `rate_limits`, read by
/// `quota`) to the app in the background, then shows the user's own status line, fed the same
/// JSON. The user's command replaces this shell (`exec`, under bash when Claude runs us with
/// bash), so when Claude cancels a slow update the signal reaches it, as it would without us.
/// Without one, shows the model name: any status line hides Claude's footer hints, and a blank
/// row would show nothing in their place.
pub(super) fn status_command(hook_url: &str, user_cmd: Option<&str>) -> String {
    let post = format!("input=$(cat); printf '%s' \"$input\" | {} >/dev/null 2>&1 &", hook_command(hook_url));
    match user_cmd.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => {
            let quoted = c.replace('\'', "'\\''");
            format!("{post}\nexec \"${{BASH:-/bin/sh}}\" -c '{quoted}' <<COC_STATUS_JSON\n$input\nCOC_STATUS_JSON")
        }
        None => format!(
            "{post}\nprintf '%s' \"$input\" | sed -n 's/.*\"display_name\" *: *\"\\([^\"]*\\)\".*/\\1/p' | head -n 1"
        ),
    }
}

/// The status line Claude would show without the app: the first `statusLine` among the
/// project's local and shared settings, then the user's (all read only).
fn user_status_line(cwd: &std::path::Path) -> Option<serde_json::Value> {
    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")));
    let mut files = vec![cwd.join(".claude/settings.local.json"), cwd.join(".claude/settings.json")];
    files.extend(config.map(|c| c.join("settings.json")));
    files.iter().find_map(|f| {
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(f).ok()?).ok()?;
        v.get("statusLine").filter(|s| s.is_object()).cloned()
    })
}

fn settings_json(hook_url: &str, user_status: Option<&serde_json::Value>) -> serde_json::Value {
    let cmd = hook_command(hook_url);
    let mut hooks = serde_json::Map::new();
    for ev in HOOK_EVENTS {
        let mut group = serde_json::json!({ "hooks": [{ "type": "command", "command": cmd }] });
        if ev == "PostToolUse" {
            group["matcher"] = "*".into();
        }
        hooks.insert(ev.to_string(), serde_json::json!([group]));
    }
    // Keep the user's other status-line options (padding); only a command line can be chained.
    let mut status = user_status.cloned().filter(|s| s["type"] == "command").unwrap_or_else(|| serde_json::json!({}));
    let user_cmd = status.get("command").and_then(|c| c.as_str()).map(String::from);
    status["type"] = "command".into();
    status["command"] = status_command(hook_url, user_cmd.as_deref()).into();
    serde_json::json!({ "hooks": hooks, "statusLine": status })
}

/// Writes `bytes` readable by the owner only (the settings carry the hook token).
pub(super) fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut f = opts.open(path)?;
    // `mode` applies only on create; tighten a file left from before.
    #[cfg(unix)]
    f.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    f.write_all(bytes)
}

/// Runs `claude --version` (time-limited); `detect` caches the result.
fn probe() -> Detection {
    super::probe_program("claude", |out| out.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()))
}

/// One `claude --version` per minute at most, shared by every `ClaudeAdapter` in the app.
pub static DETECTION: DetectionCache = DetectionCache::new(DETECTION_TTL);

impl AgentAdapter for ClaudeAdapter {
    fn task_title(&self, raw: &str) -> Option<String> {
        crate::title::claude(raw)
    }
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
    }
    fn label(&self) -> &'static str {
        "Claude Code"
    }
    fn detect(&self) -> Detection {
        DETECTION.get(Instant::now(), probe)
    }
    fn invalidate_detection(&self) {
        DETECTION.invalidate();
    }
    fn models(&self) -> Vec<String> {
        ["haiku", "sonnet", "opus", "fable"].map(String::from).to_vec()
    }
    fn efforts(&self) -> Vec<String> {
        ["low", "medium", "high", "xhigh", "max"].map(String::from).to_vec()
    }
    fn launch(&self, req: &LaunchRequest) -> anyhow::Result<LaunchSpec> {
        let dir = req.data_dir.join("sessions").join(req.session_id);
        std::fs::create_dir_all(&dir)?;
        let settings_path = dir.join("claude-settings.json");
        write_private(&settings_path, &serde_json::to_vec_pretty(&settings_json(req.hook_url, user_status_line(req.cwd).as_ref()))?)?;

        // A new conversation takes the session's id; a resumed one keeps its own.
        let mut args: Vec<String> = match req.resume {
            Some(c) => vec!["--resume".into(), c.into()],
            None => vec!["--session-id".into(), req.session_id.into()],
        };
        args.extend([
            "--settings".into(),
            settings_path.to_string_lossy().into_owned(),
            "--append-system-prompt".into(),
            SHARED_FOLDER_NOTE.into(),
        ]);
        if let Some(m) = req.model {
            args.extend(["--model".into(), m.into()]);
        }
        if let Some(e) = req.effort {
            args.extend(["--effort".into(), e.into()]);
        }
        if let Some(d) = super::images_dir(req.images) {
            // reading the attached images needs no permission prompt
            args.push(format!("--add-dir={}", d.to_string_lossy()));
        }
        if let Some(t) = req.task {
            args.extend(["--".into(), t.into()]); // a task like `--help` is not an option
        }
        Ok(LaunchSpec { program: "claude".into(), args, env: vec![], cwd: req.cwd.to_path_buf() })
    }
    fn policy(&self) -> StatusPolicy {
        StatusPolicy { uses_hooks: true, finished_after_silence_secs: None, stuck_after_silence_secs: Some(900), any_exit_ends: false, silence_needs_you_until_first_event: false }
    }
    fn parse_hook(&self, body: &serde_json::Value) -> Vec<StatusEvent> {
        let mut out = Vec::new();
        match body.get("hook_event_name").and_then(|v| v.as_str()) {
            Some("UserPromptSubmit") => out.push(StatusEvent::PromptSubmitted),
            Some("PreToolUse") => {
                let Some(tool) = body.get("tool_name").and_then(|v| v.as_str()) else { return vec![] };
                let cwd = body.get("cwd").and_then(|v| v.as_str());
                // a CwdChanged here too would re-check worktrees before every tool: not needed
                let questions = if tool == "AskUserQuestion" { ask_questions(body.get("tool_input")) } else { vec![] };
                return vec![StatusEvent::ToolPending { summary: tool_summary(tool, body.get("tool_input"), cwd), questions }];
            }
            Some("PostToolUse") => out.push(StatusEvent::ToolUsed),
            Some("Stop") => {
                if let Some(text) = body.get("last_assistant_message").and_then(|v| v.as_str()).filter(|t| !t.trim().is_empty()) {
                    out.push(StatusEvent::AssistantMessage { text: text.to_string() });
                }
                out.push(StatusEvent::TurnFinished);
                // a turn can end with subagents still running in the background; with none left,
                // any minion whose stop hook went missing goes too
                if body.get("background_tasks").and_then(|v| v.as_array()).is_some_and(|t| t.is_empty()) {
                    out.push(StatusEvent::SubagentsDone);
                }
            }
            Some("SubagentStart") => {
                let Some(id) = body.get("agent_id").and_then(|v| v.as_str()) else { return vec![] };
                let agent_type = body.get("agent_type").and_then(|v| v.as_str()).map(String::from);
                return vec![StatusEvent::SubagentStarted { id: id.into(), agent_type }];
            }
            Some("SubagentStop") => {
                let Some(id) = body.get("agent_id").and_then(|v| v.as_str()) else { return vec![] };
                return vec![StatusEvent::SubagentStopped { id: id.into() }];
            }
            Some("Notification") => match body.get("notification_type").and_then(|v| v.as_str()) {
                Some("permission_prompt") => {
                    let message = body.get("message").and_then(|v| v.as_str()).unwrap_or("Claude needs your permission");
                    out.push(StatusEvent::PermissionRequested { message: message.to_string() });
                }
                Some("idle_prompt") => out.push(StatusEvent::WaitingForInput),
                _ => {}
            },
            Some("SessionStart" | "SessionEnd") => {}
            _ => return vec![],
        }
        if let Some(cwd) = body.get("cwd").and_then(|v| v.as_str()) {
            out.push(StatusEvent::CwdChanged { cwd: PathBuf::from(cwd) });
        }
        out
    }
    fn conversation_of(&self, body: &serde_json::Value) -> Option<String> {
        // a transcript exists once a prompt was sent (`/clear` starts a new one)
        match body.get("hook_event_name").and_then(|v| v.as_str()) {
            Some("UserPromptSubmit" | "PostToolUse" | "Stop") => body.get("session_id").and_then(|v| v.as_str()).map(String::from),
            _ => None,
        }
    }
    fn reply_file(&self, body: &serde_json::Value) -> Option<PathBuf> {
        if body.get("hook_event_name").and_then(|v| v.as_str()) != Some("Stop") || body.get("last_assistant_message").and_then(|v| v.as_str()).is_some() {
            return None;
        }
        body.get("transcript_path").and_then(|v| v.as_str()).filter(|p| p.ends_with(".jsonl")).map(PathBuf::from)
    }
    fn read_reply(&self, file: &std::path::Path) -> Option<String> {
        last_reply_in_transcript(file)
    }
    fn approve_keys(&self) -> Option<&'static [u8]> {
        Some(b"1")
    }
    fn deny_keys(&self) -> Option<&'static [u8]> {
        Some(b"\x1b")
    }
    fn screen_prompts(&self) -> Vec<ScreenPrompt> {
        // First-run trust menu; hooks stay silent until it is answered. The default selection
        // is "No, exit": approve moves Down to "Yes, I trust this folder" and presses Enter;
        // deny presses Enter on "No, exit", so Claude quits and the session ends.
        vec![ScreenPrompt { needle: "YesItrustthisfolder", reason: "Trust this folder?", approve: b"\x1b[B\r", deny: b"\r" }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;
    use StatusEvent::*;

    fn req<'a>(
        id: &'a str,
        dir: &'a Path,
        model: Option<&'a str>,
        effort: Option<&'a str>,
        task: Option<&'a str>,
    ) -> LaunchRequest<'a> {
        LaunchRequest {
            session_id: id,
            cwd: Path::new("/tmp"),
            model,
            effort,
            task,
            hook_url: "http://127.0.0.1:4242/hook/tok/sid",
            data_dir: dir,
            custom_command: None,
            images: &[],
            resume: None,
        }
    }

    fn fixture(name: &str) -> serde_json::Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-hooks").join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn parse(name: &str) -> Vec<StatusEvent> {
        ClaudeAdapter.parse_hook(&fixture(name))
    }

    fn cwd_ev() -> StatusEvent {
        CwdChanged { cwd: PathBuf::from("/private/tmp/coc-hooks") }
    }

    #[test]
    fn launch_args_in_order() {
        let d = tempfile::tempdir().unwrap();
        let spec = ClaudeAdapter.launch(&req("sid-1", d.path(), Some("opus"), Some("max"), Some("fix bug"))).unwrap();
        assert_eq!(spec.program, "claude");
        assert_eq!(&spec.args[0..2], &["--session-id", "sid-1"]);
        assert_eq!(spec.args[2], "--settings");
        assert_eq!(&spec.args[4..6], &["--append-system-prompt", SHARED_FOLDER_NOTE]);
        assert_eq!(&spec.args[6..], &["--model", "opus", "--effort", "max", "--", "fix bug"]);
        assert_eq!(spec.cwd, PathBuf::from("/tmp"));
    }

    #[test]
    fn resume_continues_its_own_conversation() {
        let d = tempfile::tempdir().unwrap();
        let mut r = req("sid-2", d.path(), Some("opus"), None, None);
        r.resume = Some("conv-1");
        let spec = ClaudeAdapter.launch(&r).unwrap();
        assert_eq!(&spec.args[0..2], &["--resume", "conv-1"]);
        assert!(!spec.args.iter().any(|a| a == "--session-id" || a == "--"));
    }

    #[test]
    fn conversation_is_named_once_a_prompt_was_sent() {
        let body = |ev: &str| json!({"hook_event_name": ev, "session_id": "c-9"});
        assert_eq!(ClaudeAdapter.conversation_of(&body("UserPromptSubmit")).as_deref(), Some("c-9"));
        assert_eq!(ClaudeAdapter.conversation_of(&body("Stop")).as_deref(), Some("c-9"));
        assert_eq!(ClaudeAdapter.conversation_of(&body("SessionStart")), None);
        assert_eq!(ClaudeAdapter.conversation_of(&json!({"hook_event_name": "Stop"})), None);
    }

    #[test]
    fn optional_args_omitted() {
        let d = tempfile::tempdir().unwrap();
        let spec = ClaudeAdapter.launch(&req("s", d.path(), None, None, None)).unwrap();
        assert_eq!(spec.args.len(), 6);
    }

    #[test]
    fn task_prompt_is_single_verbatim_arg() {
        let d = tempfile::tempdir().unwrap();
        let t = "say \"hi\" && $(whoami)\nline2 🚀";
        let spec = ClaudeAdapter.launch(&req("s", d.path(), None, None, Some(t))).unwrap();
        assert_eq!(spec.args.last().unwrap(), t);
    }

    #[test]
    fn task_starting_with_dash_is_not_an_option() {
        let d = tempfile::tempdir().unwrap();
        let spec = ClaudeAdapter.launch(&req("s", d.path(), None, None, Some("--help -c x=y"))).unwrap();
        assert_eq!(&spec.args[spec.args.len() - 2..], &["--", "--help -c x=y"]);
    }

    #[test]
    fn settings_file_has_all_hooks_pointing_at_url() {
        let d = tempfile::tempdir().unwrap();
        let spec = ClaudeAdapter.launch(&req("sid-9", d.path(), None, None, None)).unwrap();
        let path = PathBuf::from(&spec.args[3]);
        assert_eq!(path, d.path().join("sessions/sid-9/claude-settings.json"));
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for ev in HOOK_EVENTS {
            let h = &v["hooks"][ev][0]["hooks"][0];
            assert_eq!(h["type"], "command", "{ev}");
            let cmd = h["command"].as_str().unwrap();
            assert!(cmd.contains("http://127.0.0.1:4242/hook/tok/sid"), "{ev}");
            assert!(cmd.contains("--data-binary @-"), "{ev}");
        }
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], "*");
    }

    #[test]
    fn status_line_keeps_the_users_options_and_chains_their_command() {
        let user = json!({ "type": "command", "command": "~/bin/line.sh # mine", "padding": 2 });
        let v = settings_json("http://127.0.0.1:1/hook/a/b", Some(&user));
        assert_eq!(v["statusLine"]["padding"], 2);
        let cmd = v["statusLine"]["command"].as_str().unwrap();
        assert!(cmd.contains("'http://127.0.0.1:1/hook/a/b'") && cmd.contains("-c '~/bin/line.sh # mine' <<"), "{cmd}");
        let none = settings_json("http://x", None);
        assert_eq!(none["statusLine"]["command"], status_command("http://x", None));
        // a non-command status line cannot be chained: ours replaces it
        let other = settings_json("http://x", Some(&json!({ "type": "static", "text": "hi" })));
        assert_eq!(other["statusLine"], json!({ "type": "command", "command": status_command("http://x", None) }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn status_command_posts_the_json_and_prints_the_users_line() {
        use std::sync::{Arc, Mutex};
        let got = Arc::new(Mutex::new(vec![]));
        let g = got.clone();
        let srv = crate::hooks::HookServer::start(Arc::new(move |_, v| g.lock().unwrap().push(v))).await.unwrap();
        let url = srv.register("s1");
        let body = r#"{"model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},"rate_limits":{"five_hour":{"used_percentage":40}}}"#;
        let run = |cmd: String| {
            let mut child = std::process::Command::new("sh")
                .args(["-c", &cmd])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            std::io::Write::write_all(child.stdin.as_mut().unwrap(), body.as_bytes()).unwrap();
            drop(child.stdin.take());
            String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
        };
        let out = tokio::task::spawn_blocking({
            let url = url.clone();
            move || run(status_command(&url, Some("jq -r '.rate_limits.five_hour.used_percentage' 2>/dev/null || cat # it's mine")))
        })
        .await
        .unwrap();
        assert!(out.trim() == "40" || out.trim() == body, "the user's line sees the same JSON: {out:?}");
        let plain = tokio::task::spawn_blocking(move || run(status_command(&url, None))).await.unwrap();
        assert_eq!(plain.trim_end(), "Opus 5.5", "without a status line of their own: the model name");
        for _ in 0..50 {
            if got.lock().unwrap().len() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let got = got.lock().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["rate_limits"]["five_hour"]["used_percentage"], 40);
    }

    #[cfg(unix)]
    #[test]
    fn settings_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let spec = ClaudeAdapter.launch(&req("sid-p", d.path(), None, None, None)).unwrap();
        let mode = std::fs::metadata(&spec.args[3]).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "settings carry the hook token: {mode:o}");
    }

    #[test]
    fn parses_fixtures() {
        let reply = "I created `hello.txt` in `/private/tmp/coc-hooks` containing `hi`, and reading it back printed `hi`. The file ends with a trailing newline because `echo` adds one.";
        assert_eq!(parse("stop.json"), vec![AssistantMessage { text: reply.into() }, TurnFinished, SubagentsDone, cwd_ev()]);
        assert_eq!(ClaudeAdapter.reply_file(&fixture("stop.json")), None, "the reply came with the hook");
        assert!(matches!(parse("notification_permission.json")[0], PermissionRequested { .. }));
        assert_eq!(parse("notification_idle.json")[0], WaitingForInput);
        assert_eq!(parse("post_tool_use.json")[0], ToolUsed);
        assert_eq!(parse("user_prompt_submit.json")[0], PromptSubmitted);
    }

    #[test]
    fn pre_tool_use_names_the_pending_call() {
        let ev = |tool: &str, input: serde_json::Value| ClaudeAdapter.parse_hook(&json!({"hook_event_name": "PreToolUse", "cwd": "/w", "tool_name": tool, "tool_input": input}));
        assert_eq!(ev("Bash", json!({"command": "npm  test\n -- --watch"})), vec![ToolPending { summary: "Bash: npm test -- --watch".into(), questions: vec![] }]);
        assert_eq!(ev("Edit", json!({"file_path": "/w/src/app.ts"})), vec![ToolPending { summary: "Edit: src/app.ts".into(), questions: vec![] }]);
        assert_eq!(ev("Edit", json!({"file_path": "/elsewhere/x.ts"})), vec![ToolPending { summary: "Edit: /elsewhere/x.ts".into(), questions: vec![] }]);
        assert_eq!(ev("TodoWrite", json!({"todos": []})), vec![ToolPending { summary: "TodoWrite".into(), questions: vec![] }]);
        assert_eq!(ClaudeAdapter.parse_hook(&json!({"hook_event_name": "PreToolUse"})), vec![], "no tool name");
    }

    #[test]
    fn a_stop_without_its_reply_reads_the_transcript() {
        let d = tempfile::tempdir().unwrap();
        let t = d.path().join("c.jsonl");
        let line = |v: serde_json::Value| format!("{v}\n");
        let body = [
            line(json!({"type": "user", "message": {"role": "user", "content": "hi"}})),
            line(json!({"type": "assistant", "message": {"id": "m1", "content": [{"type": "text", "text": "old reply"}]}})),
            line(json!({"type": "assistant", "message": {"id": "m2", "content": [{"type": "text", "text": "First part."}]}})),
            line(json!({"type": "assistant", "message": {"id": "m2", "content": [{"type": "tool_use", "name": "Bash"}]}})),
            line(json!({"type": "assistant", "message": {"id": "m2", "content": [{"type": "text", "text": "Done."}]}})),
            line(json!({"type": "assistant", "isSidechain": true, "message": {"id": "s", "content": [{"type": "text", "text": "subagent"}]}})),
            "not json\n".to_string(),
        ]
        .concat();
        std::fs::write(&t, body).unwrap();
        let stop = json!({"hook_event_name": "Stop", "transcript_path": t.to_string_lossy()});
        let file = ClaudeAdapter.reply_file(&stop).expect("no reply in the hook: read the transcript");
        assert_eq!(ClaudeAdapter.read_reply(&file).as_deref(), Some("First part.\n\nDone."));
        assert_eq!(ClaudeAdapter.reply_file(&json!({"hook_event_name": "PostToolUse", "transcript_path": "/x.jsonl"})), None);
        assert_eq!(last_reply_in_transcript(&d.path().join("missing.jsonl")), None);
    }

    #[test]
    fn subagent_hooks_name_the_subagent() {
        let id = "aedeadf4ae87e474e".to_string();
        assert_eq!(parse("subagent_start.json"), vec![SubagentStarted { id: id.clone(), agent_type: Some("general-purpose".into()) }]);
        assert_eq!(parse("subagent_stop.json"), vec![SubagentStopped { id }]);
        assert_eq!(ClaudeAdapter.parse_hook(&json!({"hook_event_name": "SubagentStart"})), vec![], "no agent_id");
        // a turn that leaves background tasks running keeps its minions
        let busy = json!({"hook_event_name": "Stop", "background_tasks": [{"id": "x"}]});
        assert_eq!(ClaudeAdapter.parse_hook(&busy), vec![TurnFinished]);
    }

    #[test]
    fn an_ask_user_question_call_carries_its_options() {
        let input = json!({"questions": [
            {"question": " Pick colors ", "header": "Colors", "multiSelect": true, "options": [{"label": "Red", "description": "warm"}, {"label": "Blue"}]},
            {"question": "Pick a fruit", "options": [{"label": "Apple"}]}
        ]});
        let ev = ClaudeAdapter.parse_hook(&json!({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_input": input}));
        let StatusEvent::ToolPending { summary, questions } = &ev[0] else { panic!("{ev:?}") };
        assert_eq!(summary, "AskUserQuestion");
        assert_eq!(questions, &vec![
            AskQuestion {
                question: "Pick colors".into(), header: Some("Colors".into()), multi_select: true,
                options: vec![AskOption { label: "Red".into(), description: Some("warm".into()) }, AskOption { label: "Blue".into(), description: None }],
            },
            AskQuestion { question: "Pick a fruit".into(), header: None, multi_select: false, options: vec![AskOption { label: "Apple".into(), description: None }] },
        ]);
        // one question the app can't mirror (no options, an option without a label): the terminal answers it
        assert_eq!(ask_questions(Some(&json!({"questions": [{"question": "a", "options": []}]}))), vec![]);
        assert_eq!(ask_questions(Some(&json!({"questions": [{"question": "a", "options": [{"label": "x"}]}, {"question": "b", "options": [{}]}]}))), vec![]);
        assert_eq!(ask_questions(None), vec![]);
    }

    #[test]
    fn permission_message_is_carried() {
        assert_eq!(
            parse("notification_permission.json")[0],
            PermissionRequested { message: "Claude needs your permission".into() }
        );
    }

    #[test]
    fn session_end_only_reports_cwd() {
        assert_eq!(parse("session_end.json"), vec![cwd_ev()]);
    }

    #[test]
    fn unknown_notification_kind_is_ignored() {
        let v = json!({"hook_event_name":"Notification","notification_type":"auth_success","message":"x"});
        assert_eq!(ClaudeAdapter.parse_hook(&v), vec![]);
    }

    #[test]
    fn unknown_event_is_ignored() {
        assert_eq!(ClaudeAdapter.parse_hook(&json!({"hook_event_name":"Nope"})), vec![]);
    }

    #[test]
    fn detection_is_cached() {
        // Other tests may detect concurrently: two calls here probe at most once between them.
        let before = DETECTION.probes();
        let a = ClaudeAdapter.detect();
        let b = ClaudeAdapter.detect();
        assert!(DETECTION.probes() - before <= 1, "claude --version ran {} times", DETECTION.probes() - before);
        assert_eq!(a, b);
    }

    #[test]
    fn policy_and_keys() {
        let p = ClaudeAdapter.policy();
        assert!(p.uses_hooks);
        assert_eq!(p.finished_after_silence_secs, None);
        assert_eq!(p.stuck_after_silence_secs, Some(900));
        assert_eq!(ClaudeAdapter.approve_keys(), Some(&b"1"[..]));
        assert_eq!(ClaudeAdapter.deny_keys(), Some(&b"\x1b"[..]));
        assert_eq!(ClaudeAdapter.models(), vec!["haiku", "sonnet", "opus", "fable"]);
        assert_eq!(ClaudeAdapter.efforts(), vec!["low", "medium", "high", "xhigh", "max"]);
    }
}
