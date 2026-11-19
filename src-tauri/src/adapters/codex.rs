//! OpenAI Codex CLI adapter.
//!
//! Nothing is written to disk: the `notify` command, the hooks and the developer instructions
//! travel as `-c` overrides, so `~/.codex`, `<repo>/.codex` and `CODEX_HOME` are never touched.
//!
//! Verified against codex-cli 0.166.0 in a pty (gpt-5.6-luna):
//!   * `notify` reports only `agent-turn-complete`, also for Codex's own side threads: a title
//!     thread finishes first, with its own `thread-id` and a reply like `{"title":"…"}`.
//!   * Hooks given with `-c hooks={…}` run once trusted, and their trust can come the same way:
//!     `hooks.state."/<session-flags>/config.toml:<event>:<group>:<handler>".trusted_hash` is
//!     the hash of the hook's normalized config (see `hook_trust_hash`), so no `/hooks` review.
//!     Payloads (stdin JSON) carry `session_id` (the thread), `hook_event_name`, `tool_name`,
//!     `tool_input`. `PermissionRequest` fires only when an approval prompt is really shown.
//!   * Approval menus (commands and file edits) read "1. Yes, proceed (y)" … "3. No, and tell
//!     Codex what to do differently (esc)": `y` approves, Esc declines.
//!   * `request_user_input` (plan mode, or the `default_mode_request_user_input` feature) asks
//!     1–3 single-choice questions `{id, header, question, options: [{label, description}]}`.
//!     Its menu adds "None of the above" (row n+1): a digit answers and moves on (the last one
//!     submits all); typed words go Down to that row, Tab ("add notes"), the words, Enter.
use super::claude::SHARED_FOLDER_NOTE;
use super::{AgentAdapter, Detection, DetectionCache, LaunchRequest, ModelChoice, ScreenPrompt, DETECTION_TTL};
use crate::model::AgentKind;
use crate::platform::{output_within, RunOutcome};
use crate::pty::LaunchSpec;
use crate::status::{StatusEvent, StatusPolicy};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct CodexAdapter;

/// `s` as a TOML basic string (quoted, with `\`, `"` and control characters escaped).
fn toml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The `notify` program: Codex appends the event JSON as the last argv (`$1` here).
fn notify_array(hook_url: &str) -> String {
    let script = format!(
        "printf '%s' \"$1\" | curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- '{hook_url}'"
    );
    format!("[{}]", ["sh", "-c", &script, "coc-notify"].map(toml_string).join(","))
}

/// The hook events the app listens to, as Codex names them in config and in trust keys, and
/// whether they take a tool matcher (`*`: every tool). Codex drops a matcher on prompt events,
/// and the trust hash with it, so none is given there.
const HOOK_EVENTS: [(&str, &str, bool); 4] = [
    ("UserPromptSubmit", "user_prompt_submit", false),
    ("PreToolUse", "pre_tool_use", true),
    ("PermissionRequest", "permission_request", true),
    ("PostToolUse", "post_tool_use", true),
];

/// Codex's trust hash for a `-c` hook `{matcher = "*", hooks = [{type = "command", command}]}`
/// (no matcher when `tools` is false) under `event` (`pre_tool_use`): `sha256:` + hex SHA-256 of
/// the hook's normalized config as
/// compact JSON with sorted keys (codex-rs `hooks/src/discovery.rs` `hook_hash` and
/// `config/src/fingerprint.rs` `version_for_toml`; normalizing adds `async = false` and
/// `timeout = 600`). Matched the hash Codex 0.166.0 reports in `hooks/list`. Should a later
/// Codex hash differently, it skips the hooks as untrusted and the app falls back to `notify`.
pub(super) fn hook_trust_hash(event: &str, command: &str, tools: bool) -> String {
    let mut identity = serde_json::json!({
        "event_name": event,
        "hooks": [{"async": false, "command": command, "timeout": 600, "type": "command"}],
    });
    if tools {
        identity["matcher"] = "*".into();
    }
    let canonical = canonical_json(&identity);
    let digest = Sha256::digest(canonical.as_bytes());
    format!("sha256:{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// `v` as compact JSON with every object's keys sorted, whatever serde_json's map order.
fn canonical_json(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let fields: Vec<String> = keys.iter().map(|k| format!("{}:{}", serde_json::Value::from(k.as_str()), canonical_json(&m[*k]))).collect();
            format!("{{{}}}", fields.join(","))
        }
        serde_json::Value::Array(a) => format!("[{}]", a.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

/// The `-c hooks={…}` value: each event posts its payload to the app, already trusted.
fn hooks_table(hook_url: &str) -> String {
    let command = super::claude::hook_command(hook_url);
    let state: Vec<String> = HOOK_EVENTS
        .iter()
        .map(|(_, key, tools)| {
            let id = toml_string(&format!("/<session-flags>/config.toml:{key}:0:0"));
            format!("{id}={{trusted_hash={}}}", toml_string(&hook_trust_hash(key, &command, *tools)))
        })
        .collect();
    let events = HOOK_EVENTS.iter().map(|(name, _, tools)| {
        let matcher = if *tools { "matcher=\"*\"," } else { "" };
        format!("{name}=[{{{matcher}hooks=[{{type=\"command\",command={}}}]}}]", toml_string(&command))
    });
    format!("hooks={{state={{{}}},{}}}", state.join(","), events.collect::<Vec<_>>().join(","))
}

/// Codex's own title thread (`{"title": "…"}` as its whole reply), which reports through `notify`
/// like the conversation does: not the session's turn, nor its conversation.
fn is_title_thread(body: &serde_json::Value) -> bool {
    body.get("last-assistant-message")
        .and_then(|v| v.as_str())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .and_then(|v| v.as_object().map(|o| o.len() == 1 && o.contains_key("title")))
        .unwrap_or(false)
}

/// First `\d+\.\d+\.\d+` in `s` (`codex-cli 0.137.0`).
pub(super) fn parse_version(s: &str) -> Option<String> {
    let b = s.as_bytes();
    (0..b.len()).filter(|&i| b[i].is_ascii_digit() && (i == 0 || !b[i - 1].is_ascii_digit() && b[i - 1] != b'.')).find_map(|i| {
        let mut j = i;
        let mut parts = 0;
        loop {
            let st = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j == st {
                return None;
            }
            parts += 1;
            if parts == 3 {
                return Some(s[i..j].to_string());
            }
            if b.get(j) != Some(&b'.') {
                return None;
            }
            j += 1;
        }
    })
}

fn probe() -> Detection {
    super::probe_program("codex", parse_version)
}

/// One `codex --version` per minute at most.
pub static DETECTION: DetectionCache = DetectionCache::new(DETECTION_TTL);

/// Efforts when Codex can't list its models (an older Codex, or the catalog could not be read).
const FALLBACK_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
/// Every effort Codex names, lowest first: the order the effort slider shows them in.
const EFFORT_ORDER: [&str; 8] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/// How long a read catalog is reused; one that came back empty is retried after DETECTION_TTL.
const CATALOG_TTL: Duration = Duration::from_secs(10 * 60);
/// Longest `codex debug models` may take (it may refresh the list from OpenAI first).
const CATALOG_TIMEOUT: Duration = Duration::from_secs(8);

static CATALOG: Mutex<Option<(Instant, Vec<ModelChoice>)>> = Mutex::new(None);

/// The models a `codex debug models` catalog lists for the picker: the ones Codex itself shows
/// (`visibility: "list"`), from the least to the most preferred (its `priority`, lower is
/// preferred), so Codex's top pick is the last step of the slider, as Claude's most capable is.
pub(super) fn parse_catalog(json: &[u8]) -> Vec<ModelChoice> {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(json) else { return vec![] };
    let Some(models) = v.get("models").and_then(|m| m.as_array()) else { return vec![] };
    let mut listed: Vec<(i64, ModelChoice)> = models
        .iter()
        .filter(|m| m.get("visibility").and_then(|x| x.as_str()).unwrap_or("list") == "list")
        .filter_map(|m| {
            let id = m.get("slug").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty())?.to_string();
            let name = m.get("display_name").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&id).to_string();
            let mut efforts: Vec<String> = m
                .get("supported_reasoning_levels")
                .and_then(|x| x.as_array())
                .map(|ls| ls.iter().filter_map(|l| l.get("effort").and_then(|e| e.as_str()).map(String::from)).collect())
                .unwrap_or_default();
            efforts.sort_by_key(|e| EFFORT_ORDER.iter().position(|o| o == e).unwrap_or(EFFORT_ORDER.len()));
            efforts.dedup();
            let priority = m.get("priority").and_then(|x| x.as_i64()).unwrap_or(i64::MAX);
            Some((priority, ModelChoice { id, name, efforts }))
        })
        .collect();
    listed.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
    listed.dedup_by(|a, b| a.1.id == b.1.id);
    listed.into_iter().map(|(_, m)| m).collect()
}

/// The catalog from the Codex at `path`: its live list (`debug models`), else the one built into
/// it (`debug models --bundled`); empty when neither can be read (a Codex without `debug models`).
pub(super) fn catalog_from(path: &Path, timeout: Duration) -> Vec<ModelChoice> {
    let run = |bundled: bool| {
        let mut cmd = std::process::Command::new(path);
        cmd.args(["debug", "models"]);
        if bundled {
            cmd.arg("--bundled");
        }
        match output_within(cmd, timeout) {
            RunOutcome::Exited { success: true, stdout } => parse_catalog(&stdout),
            _ => vec![],
        }
    };
    let live = run(false);
    if live.is_empty() { run(true) } else { live }
}

/// Codex's models, read at most every CATALOG_TTL (Re-check reads it again).
fn catalog() -> Vec<ModelChoice> {
    let mut cached = CATALOG.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, models)) = cached.as_ref() {
        let ttl = if models.is_empty() { DETECTION_TTL } else { CATALOG_TTL };
        if at.elapsed() < ttl {
            return models.clone();
        }
    }
    let models = CodexAdapter.detect().path.map(|p| catalog_from(&p, CATALOG_TIMEOUT)).unwrap_or_default();
    *cached = Some((Instant::now(), models.clone()));
    models
}

/// Efforts every listed model takes (the slider before a model is chosen), in EFFORT_ORDER.
pub(super) fn common_efforts(models: &[ModelChoice]) -> Vec<String> {
    let Some(first) = models.first() else { return FALLBACK_EFFORTS.map(String::from).to_vec() };
    first.efforts.iter().filter(|e| models.iter().all(|m| m.efforts.contains(e))).cloned().collect()
}

impl AgentAdapter for CodexAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }
    fn label(&self) -> &'static str {
        "Codex"
    }
    fn detect(&self) -> Detection {
        DETECTION.get(Instant::now(), probe)
    }
    fn invalidate_detection(&self) {
        DETECTION.invalidate();
        *CATALOG.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    fn models(&self) -> Vec<String> {
        catalog().into_iter().map(|m| m.id).collect()
    }
    fn model_choices(&self) -> Vec<ModelChoice> {
        catalog()
    }
    fn efforts(&self) -> Vec<String> {
        common_efforts(&catalog())
    }
    fn launch(&self, req: &LaunchRequest) -> anyhow::Result<LaunchSpec> {
        // The URL is app-generated; it is single-quoted inside the notify script.
        anyhow::ensure!(!req.hook_url.contains('\''), "hook url must not contain a quote");
        let mut args: Vec<String> = vec![];
        if let Some(m) = req.model {
            args.extend(["-m".into(), m.into()]);
        }
        if let Some(e) = req.effort {
            args.extend(["-c".into(), format!("model_reasoning_effort={}", toml_string(e))]);
        }
        args.extend([
            "-c".into(),
            format!("developer_instructions={}", toml_string(SHARED_FOLDER_NOTE)),
            "-c".into(),
            format!("notify={}", notify_array(req.hook_url)),
            "-c".into(),
            hooks_table(req.hook_url),
        ]);
        if let Some(c) = req.resume {
            // the options above are the root command's; `resume` takes them on
            args.extend(["resume".into(), c.into()]);
        } else {
            for p in req.images {
                // attached to the first prompt as images, not only named in its text
                args.push(format!("--image={}", p.to_string_lossy()));
            }
            if let Some(t) = req.task.filter(|t| !t.is_empty()) {
                args.extend(["--".into(), t.into()]); // a task like `--help` is not an option
            }
        }
        Ok(LaunchSpec { program: "codex".into(), args, env: vec![], cwd: req.cwd.to_path_buf() })
    }
    fn policy(&self) -> StatusPolicy {
        // `notify` only reports turn-complete, so there is no prompt-submitted hook: typing
        // resumes work (`uses_hooks: false`). Until the first notify, silence means NeedsYou
        // ("Waiting in the terminal": a login or trust screen), never Finished.
        StatusPolicy {
            uses_hooks: false,
            finished_after_silence_secs: Some(30),
            stuck_after_silence_secs: Some(900),
            any_exit_ends: false,
            silence_needs_you_until_first_event: true,
        }
    }
    fn parse_hook(&self, body: &serde_json::Value) -> Vec<StatusEvent> {
        if let Some(event) = body.get("hook_event_name").and_then(|v| v.as_str()) {
            let tool = body.get("tool_name").and_then(|v| v.as_str());
            let input = body.get("tool_input");
            let pending = |tool: &str| StatusEvent::ToolPending {
                summary: super::claude::tool_summary(tool, input, body.get("cwd").and_then(|v| v.as_str())),
                questions: if tool == "request_user_input" { super::claude::ask_questions(input) } else { vec![] },
            };
            return match (event, tool) {
                ("UserPromptSubmit", _) => vec![StatusEvent::PromptSubmitted],
                ("PreToolUse", Some(t)) => vec![pending(t)],
                ("PermissionRequest", Some(t)) => vec![pending(t), StatusEvent::PermissionRequested { message: "Codex wants your approval".into() }],
                ("PostToolUse", _) => vec![StatusEvent::ToolUsed],
                _ => vec![],
            };
        }
        match body.get("type").and_then(|v| v.as_str()) {
            Some("agent-turn-complete") if is_title_thread(body) => vec![],
            Some("agent-turn-complete") => {
                let reply = body.get("last-assistant-message").and_then(|v| v.as_str()).filter(|t| !t.trim().is_empty());
                reply.map(|t| StatusEvent::AssistantMessage { text: t.to_string() }).into_iter().chain([StatusEvent::TurnFinished]).collect()
            }
            _ => vec![],
        }
    }
    fn conversation_of(&self, body: &serde_json::Value) -> Option<String> {
        // hooks name the conversation's thread; a notify may come from a side thread (the title)
        let id = if body.get("hook_event_name").is_some() { body.get("session_id") } else { body.get("thread-id") };
        id.and_then(|v| v.as_str()).filter(|_| !is_title_thread(body)).map(String::from)
    }
    fn from_other_conversation(&self, body: &serde_json::Value, conversation: Option<&str>) -> bool {
        // a turn of another thread (Codex's side threads) is not the session's
        let thread = body.get("thread-id").and_then(|v| v.as_str());
        body.get("type").is_some() && matches!((thread, conversation), (Some(t), Some(c)) if t != c)
    }
    fn approve_keys(&self) -> Option<&'static [u8]> {
        Some(b"y")
    }
    fn deny_keys(&self) -> Option<&'static [u8]> {
        Some(b"\x1b")
    }
    fn screen_prompts(&self) -> Vec<ScreenPrompt> {
        // The approval menu (its hook may be untrusted: the screen still finds it) takes the
        // adapter's keys; the folder-trust menu's keys are unverified: answered in the terminal.
        vec![
            ScreenPrompt { needle: "allowCodextoworkinthisfolder", reason: "Trust this folder?", approve: b"", deny: b"" },
            ScreenPrompt { needle: "Yesproceed", reason: "Codex wants your approval", approve: b"y", deny: b"\x1b" },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    fn req<'a>(dir: &'a Path, model: Option<&'a str>, effort: Option<&'a str>, task: Option<&'a str>) -> LaunchRequest<'a> {
        LaunchRequest {
            session_id: "sid",
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

    const URL: &str = "http://127.0.0.1:4242/hook/tok/sid";

    fn expected_notify() -> String {
        format!(
            r#"notify=["sh","-c","printf '%s' \"$1\" | curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- '{URL}'","coc-notify"]"#
        )
    }

    #[test]
    fn codex_launch_args_exact() {
        let d = tempfile::tempdir().unwrap();
        let task = "fix \"x\" $(y)";
        let spec = CodexAdapter.launch(&req(d.path(), Some("gpt-6.1"), Some("high"), Some(task))).unwrap();
        assert_eq!(spec.program, "codex");
        assert_eq!(spec.cwd, PathBuf::from("/tmp"));
        let expected: Vec<String> = vec![
            "-m".into(),
            "gpt-6.1".into(),
            "-c".into(),
            r#"model_reasoning_effort="high""#.into(),
            "-c".into(),
            format!("developer_instructions=\"{SHARED_FOLDER_NOTE}\""),
            "-c".into(),
            expected_notify(),
            "-c".into(),
            hooks_table(URL),
            "--".into(),
            task.into(),
        ];
        assert_eq!(spec.args, expected);
    }

    use std::path::PathBuf;

    #[test]
    fn codex_resume_takes_the_options_and_no_task() {
        let d = tempfile::tempdir().unwrap();
        let imgs = [PathBuf::from("/d/images/image-1.png")];
        let mut r = req(d.path(), Some("gpt-6.1"), None, None);
        r.images = &imgs;
        r.resume = Some("thread-1");
        let spec = CodexAdapter.launch(&r).unwrap();
        assert_eq!(&spec.args[..2], &["-m", "gpt-6.1"]);
        assert_eq!(&spec.args[spec.args.len() - 2..], &["resume", "thread-1"]);
        assert!(!spec.args.iter().any(|a| a.starts_with("--image")), "images went with the first prompt");
    }

    #[test]
    fn codex_conversation_is_the_thread_id() {
        let body = json!({"type": "agent-turn-complete", "thread-id": "t-1"});
        assert_eq!(CodexAdapter.conversation_of(&body).as_deref(), Some("t-1"));
        assert_eq!(CodexAdapter.conversation_of(&json!({})), None);
        // hooks name it as `session_id`
        let hook = json!({"hook_event_name": "UserPromptSubmit", "session_id": "t-2", "prompt": "hi"});
        assert_eq!(CodexAdapter.conversation_of(&hook).as_deref(), Some("t-2"));
    }

    /// Codex's title thread, as notify reported it on 0.166.0 (before the conversation's turn).
    fn title_turn() -> serde_json::Value {
        json!({"type": "agent-turn-complete", "thread-id": "title-thread", "turn-id": "u", "client": "codex-tui",
            "input-messages": ["Generate a concise, single-line task title …"], "last-assistant-message": "{\"title\":\"Choose a preferred color\"}"})
    }

    #[test]
    fn codex_side_threads_are_not_the_session() {
        assert_eq!(CodexAdapter.parse_hook(&title_turn()), vec![], "the title thread's turn is not the session's");
        assert_eq!(CodexAdapter.conversation_of(&title_turn()), None, "nor its conversation");
        let other = json!({"type": "agent-turn-complete", "thread-id": "t-9", "last-assistant-message": "done"});
        assert!(CodexAdapter.from_other_conversation(&other, Some("t-1")));
        assert!(!CodexAdapter.from_other_conversation(&other, Some("t-9")));
        assert!(!CodexAdapter.from_other_conversation(&other, None), "no conversation known yet");
        let hook = json!({"hook_event_name": "PostToolUse", "session_id": "t-3"});
        assert!(!CodexAdapter.from_other_conversation(&hook, Some("t-1")), "hooks name the conversation itself");
        // a reply that merely mentions a title is a reply
        let reply = json!({"type": "agent-turn-complete", "thread-id": "t-1", "last-assistant-message": "{\"title\":\"x\",\"body\":1}"});
        assert_eq!(CodexAdapter.parse_hook(&reply).last(), Some(&StatusEvent::TurnFinished));
    }

    #[test]
    fn codex_hook_trust_hash_matches_codex() {
        // the hash Codex 0.166.0's `hooks/list` reported for this command under PreToolUse
        let cmd = "/private/tmp/claude-502/-Users-fabianferno-Documents-clashofclaudes/3b88b361-cf03-4e6a-9044-ebdb2e16df1f/scratchpad/hook.sh";
        assert_eq!(hook_trust_hash("pre_tool_use", cmd, true), "sha256:21d5c65bb08719ac8fc7743f332d1f79f6573eb45551c23e4fe2cdc0d2f8f4c5");
        assert_eq!(hook_trust_hash("permission_request", cmd, true), "sha256:83c02d2b253c3f8931390007d42b7df20a08df84d90354f1b9dfbff97d291bf5");
        // a prompt event's hook has no matcher (Codex drops it): reported for the app's own command
        let app = crate::adapters::claude::hook_command("http://127.0.0.1:47123/hook/tok/sid");
        assert_eq!(hook_trust_hash("user_prompt_submit", &app, false), "sha256:568876c50c27f60622ca4307186306df8704a28a96ace119da2aa2220bde904c");
    }

    #[test]
    fn codex_hooks_table_parses_back_trusted() {
        let v: toml::Table = toml::from_str(&hooks_table(URL)).unwrap();
        let hooks = v["hooks"].as_table().unwrap();
        let cmd = crate::adapters::claude::hook_command(URL);
        for (name, key, tools) in HOOK_EVENTS {
            let group = &hooks[name].as_array().unwrap()[0];
            assert_eq!(group.get("matcher").and_then(|m| m.as_str()), tools.then_some("*"));
            assert_eq!(group["hooks"].as_array().unwrap()[0]["command"].as_str(), Some(cmd.as_str()));
            let state = &hooks["state"][&format!("/<session-flags>/config.toml:{key}:0:0")];
            assert_eq!(state["trusted_hash"].as_str(), Some(hook_trust_hash(key, &cmd, tools).as_str()));
        }
    }

    #[test]
    fn codex_hooks_report_prompts_tools_approvals_and_questions() {
        assert_eq!(CodexAdapter.parse_hook(&json!({"hook_event_name": "UserPromptSubmit", "prompt": "hi"})), vec![StatusEvent::PromptSubmitted]);
        let bash = json!({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "cwd": "/w",
            "tool_input": {"command": "echo Green > color.txt", "description": "May I write it?"}});
        assert_eq!(CodexAdapter.parse_hook(&bash), vec![
            StatusEvent::ToolPending { summary: "Bash: echo Green > color.txt".into(), questions: vec![] },
            StatusEvent::PermissionRequested { message: "Codex wants your approval".into() },
        ]);
        assert_eq!(CodexAdapter.parse_hook(&json!({"hook_event_name": "PostToolUse", "tool_name": "Bash"})), vec![StatusEvent::ToolUsed]);
        // as observed on 0.166.0
        let ask = json!({"hook_event_name": "PreToolUse", "tool_name": "request_user_input", "tool_input": {"questions": [
            {"header": "Color", "id": "preferred_color", "question": "Which color do you prefer?",
             "options": [{"label": "Red", "description": "Choose red."}, {"label": "Green", "description": "Choose green."}]}]}});
        let ev = CodexAdapter.parse_hook(&ask);
        let StatusEvent::ToolPending { questions, .. } = &ev[0] else { panic!("{ev:?}") };
        assert_eq!((questions.len(), questions[0].header.as_deref(), questions[0].options[1].label.as_str(), questions[0].multi_select),
            (1, Some("Color"), "Green", false));
        assert_eq!(CodexAdapter.parse_hook(&json!({"hook_event_name": "PreToolUse"})), vec![], "no tool name");
    }

    #[test]
    fn codex_optional_args_omitted() {
        let d = tempfile::tempdir().unwrap();
        let spec = CodexAdapter.launch(&req(d.path(), None, None, None)).unwrap();
        assert_eq!(spec.args.len(), 6);
        let spec = CodexAdapter.launch(&req(d.path(), None, None, Some(""))).unwrap();
        assert_eq!(spec.args.len(), 6, "an empty task is not passed");
    }

    #[test]
    fn codex_notify_array_is_valid_toml_and_embeds_only_hook_url() {
        let d = tempfile::tempdir().unwrap();
        let spec = CodexAdapter.launch(&req(d.path(), Some("gpt-zzz"), Some("low"), Some("T-A-S-K"))).unwrap();
        let notify = spec.args.iter().find(|a| a.starts_with("notify=")).unwrap();
        let v: toml::Table = toml::from_str(notify).unwrap();
        let arr: Vec<&str> = v["notify"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        assert_eq!(arr[0..2], ["sh", "-c"]);
        assert_eq!(arr[3], "coc-notify");
        assert!(arr[2].ends_with(&format!("--data-binary @- '{URL}'")));
        assert!(!URL.contains('\''));
        // Neither the model, the effort nor the task reaches the notify script.
        for user in ["T-A-S-K", "low", "gpt-zzz"] {
            assert!(!notify.contains(user), "{user}");
        }
        assert_eq!(arr[2].matches(URL).count(), 1);
    }

    #[test]
    fn codex_rejects_hook_url_with_quote() {
        let d = tempfile::tempdir().unwrap();
        let mut r = req(d.path(), None, None, None);
        r.hook_url = "http://x/'; rm -rf ~ #";
        assert!(CodexAdapter.launch(&r).is_err());
    }

    #[test]
    fn codex_developer_instructions_parse_back() {
        let d = tempfile::tempdir().unwrap();
        let spec = CodexAdapter.launch(&req(d.path(), None, None, None)).unwrap();
        let di = spec.args.iter().find(|a| a.starts_with("developer_instructions=")).unwrap();
        let v: toml::Table = toml::from_str(di).unwrap();
        assert_eq!(v["developer_instructions"].as_str().unwrap(), SHARED_FOLDER_NOTE);
        // Escaping round-trips quotes, backslashes and control characters.
        let nasty = "a\"b\\c\nd\te\u{1}f";
        let v: toml::Table = toml::from_str(&format!("k={}", toml_string(nasty))).unwrap();
        assert_eq!(v["k"].as_str().unwrap(), nasty);
    }

    #[test]
    fn codex_task_is_last_verbatim() {
        let d = tempfile::tempdir().unwrap();
        let t = "say \"hi\" && $(whoami)\nline2 🚀";
        let spec = CodexAdapter.launch(&req(d.path(), None, None, Some(t))).unwrap();
        assert_eq!(spec.args.last().unwrap(), t);
        assert_eq!(spec.args[spec.args.len() - 2], "--");
    }

    #[test]
    fn task_starting_with_dash_is_not_an_option() {
        let d = tempfile::tempdir().unwrap();
        let spec = CodexAdapter.launch(&req(d.path(), None, None, Some("--help -c x=y"))).unwrap();
        assert_eq!(&spec.args[spec.args.len() - 2..], &["--", "--help -c x=y"]);
    }

    #[test]
    fn codex_parse_turn_complete() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex/agent-turn-complete.json");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        assert_eq!(
            CodexAdapter.parse_hook(&v),
            vec![StatusEvent::AssistantMessage { text: "Renamed foo to bar.".into() }, StatusEvent::TurnFinished]
        );
        assert_eq!(CodexAdapter.parse_hook(&json!({"type": "agent-turn-complete"})), vec![StatusEvent::TurnFinished], "no reply in it");
    }

    #[test]
    fn codex_parse_ignores_garbage() {
        for v in [
            json!("not json at all"),
            json!({}),
            json!({"cwd": "/x"}),
            json!({"type": "something-new"}),
            json!({"type": 7}),
            json!([1, 2]),
            json!(null),
            json!({"type": "x".repeat(2 * 1024 * 1024)}),
            json!({"junk": "x".repeat(2 * 1024 * 1024)}),
        ] {
            assert_eq!(CodexAdapter.parse_hook(&v), vec![]);
        }
    }

    fn launch_writes_nothing() {
        let d = tempfile::tempdir().unwrap();
        CodexAdapter.launch(&req(d.path(), Some("m"), Some("high"), Some("t"))).unwrap();
        // Launch writes nothing at all: no data-dir entries, hence none outside the session dir.
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0);
    }

    #[test]
    fn codex_writes_only_inside_session_dir() {
        launch_writes_nothing();
        // And nothing under HOME / XDG_CONFIG_HOME / CODEX_HOME (run with those faked).
        crate::adapters::fake_home::run("adapters::codex::tests::codex_launch_in_fake_home");
    }

    #[test]
    #[ignore = "run by codex_writes_only_inside_session_dir with a fake HOME"]
    fn codex_launch_in_fake_home() {
        if crate::adapters::fake_home::is_child() {
            launch_writes_nothing();
        }
    }

    #[test]
    fn codex_detect_parses_version() {
        assert_eq!(parse_version("codex-cli 0.137.0\n").as_deref(), Some("0.137.0"));
        assert_eq!(parse_version("codex-cli 10.2.33-beta").as_deref(), Some("10.2.33"));
        assert_eq!(parse_version("codex-cli"), None);
        assert_eq!(parse_version("v1.2"), None);
    }

    #[test]
    fn codex_approvals_take_y_and_esc() {
        let ps = CodexAdapter.screen_prompts();
        assert_eq!(ps.len(), 2);
        assert!(ps[0].approve.is_empty() && ps[0].deny.is_empty(), "the folder-trust menu is answered in the terminal");
        assert_eq!((ps[1].approve, ps[1].deny), (&b"y"[..], &b"\x1b"[..]));
        assert_eq!(CodexAdapter.approve_keys(), Some(&b"y"[..]));
        assert_eq!(CodexAdapter.deny_keys(), Some(&b"\x1b"[..]));
        let text = crate::status::screen_text(b"\x1b[1m Yes,\x1b[0m allow Codex to work in this folder without asking");
        assert!(text.contains(ps[0].needle));
        assert!(crate::status::screen_text(b"1. Yes, proceed (y)").contains(ps[1].needle));
    }

    #[test]
    fn codex_silence_before_first_notify_needs_you() {
        use crate::model::SessionState::*;
        let p = CodexAdapter.policy();
        let waiting = NeedsYou { reason: crate::status::WAITING_IN_TERMINAL.into() };
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::Silence { secs: 29 }, &p), Working);
        // A login or first-run screen before any notify is never Finished.
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::Silence { secs: 30 }, &p), waiting);
        assert_eq!(crate::status::next_state(&waiting, &StatusEvent::UserInput, &p), Working);
    }

    #[test]
    fn codex_silence_does_not_finish_after_notify() {
        use crate::model::SessionState::*;
        let p = CodexAdapter.policy().after_first_event();
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::Silence { secs: 600 }, &p), Working);
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::TurnFinished, &p), Finished);
        assert_eq!(crate::status::next_state(&Finished, &StatusEvent::UserInput, &p), Working);
        assert_eq!(crate::status::next_state(&NeedsYou { reason: "x".into() }, &StatusEvent::UserInput, &p), Working);
    }

    #[test]
    fn codex_label() {
        assert_eq!(CodexAdapter.label(), "Codex");
    }

    const CATALOG_JSON: &str = r#"{"models":[
        {"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide","priority":4,
         "supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"}]},
        {"slug":"gpt-6-luna","display_name":"GPT-6-Luna","visibility":"list","priority":5,
         "supported_reasoning_levels":[{"effort":"max"},{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"}]},
        {"slug":"gpt-5.6-terra","display_name":"GPT-5.6-Terra","visibility":"list","priority":8,
         "supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"},{"effort":"max"},{"effort":"ultra"}]},
        {"slug":"gpt-5.6-luna","visibility":"list","priority":9,"supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"}]},
        {"slug":"codex-auto-review","display_name":"Codex Auto Review","visibility":"hide","priority":43}
    ]}"#;

    #[test]
    fn catalog_lists_only_shown_models_with_codexs_top_pick_last() {
        let ms = parse_catalog(CATALOG_JSON.as_bytes());
        let ids: Vec<_> = ms.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-luna"]);
        assert_eq!(ms[0].name, "gpt-5.6-luna", "no display name: the id");
        assert_eq!(ms[2].name, "GPT-6-Luna");
        assert_eq!(ms[2].efforts, ["low", "medium", "high", "xhigh", "max"], "lowest effort first");
        assert_eq!(ms[1].efforts.last().map(String::as_str), Some("ultra"));
        assert_eq!(common_efforts(&ms), ["low", "medium", "high"], "what every listed model takes");
    }

    #[test]
    fn unreadable_catalogs_list_nothing_and_efforts_fall_back() {
        assert!(parse_catalog(b"not json").is_empty());
        assert!(parse_catalog(br#"{"models":"x"}"#).is_empty());
        assert!(parse_catalog(br#"{"models":[{"display_name":"no slug"}]}"#).is_empty());
        assert_eq!(common_efforts(&[]), FALLBACK_EFFORTS);
    }

    #[test]
    fn catalog_from_reads_the_live_list_else_the_bundled_one() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let script = |name: &str, body: &str| {
            let p = d.path().join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        };
        let one = r#"{"models":[{"slug":"m1","visibility":"list"}]}"#;
        let live = script("live", &format!("[ \"$1 $2\" = 'debug models' ] && [ -z \"$3\" ] && echo '{one}'"));
        assert_eq!(catalog_from(&live, Duration::from_secs(5)).iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m1"]);
        let bundled = script("bundled", &format!("[ \"$3\" = '--bundled' ] && echo '{one}' || exit 1"));
        assert_eq!(catalog_from(&bundled, Duration::from_secs(5)).len(), 1, "offline: the list built into Codex");
        let old = script("old", "echo 'error: unrecognized subcommand' >&2; exit 2");
        assert!(catalog_from(&old, Duration::from_secs(5)).is_empty(), "an older Codex: the picker falls back to typing");
    }
}
