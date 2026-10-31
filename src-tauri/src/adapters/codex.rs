//! OpenAI Codex CLI adapter.
//!
//! Codex is not installed where this was written: every format below comes from the
//! documentation (docs/superpowers/research/2026-10-31-agents-and-release.md section 1) and is
//! covered by unit tests only. Unverified until an owner check on a real install: the exact
//! `-c notify=[...]` behavior, the trust/approval screen wording, and the argument order.
//!
//! Nothing is written to disk: the `notify` command and the developer instructions travel as
//! `-c` overrides, so `~/.codex`, `<repo>/.codex` and `CODEX_HOME` are never touched.
use super::claude::SHARED_FOLDER_NOTE;
use super::{AgentAdapter, Detection, DetectionCache, LaunchRequest, ScreenPrompt, DETECTION_TTL};
use crate::model::AgentKind;
use crate::platform::which;
use crate::pty::LaunchSpec;
use crate::status::{StatusEvent, StatusPolicy};
use std::time::Instant;

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

/// First `\d+\.\d+\.\d+` in `s` (`codex-cli 0.137.0`).
fn parse_version(s: &str) -> Option<String> {
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
    let Some(path) = which("codex") else {
        return Detection { installed: false, path: None, version: None };
    };
    let version = std::process::Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| parse_version(&String::from_utf8_lossy(&o.stdout)));
    Detection { installed: true, path: Some(path), version }
}

/// One `codex --version` per minute at most.
pub static DETECTION: DetectionCache = DetectionCache::new(DETECTION_TTL);

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
    fn models(&self) -> Vec<String> {
        vec![]
    }
    fn efforts(&self) -> Vec<String> {
        ["low", "medium", "high", "xhigh", "max"].map(String::from).to_vec()
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
        ]);
        if let Some(t) = req.task.filter(|t| !t.is_empty()) {
            args.push(t.into());
        }
        Ok(LaunchSpec { program: "codex".into(), args, env: vec![], cwd: req.cwd.to_path_buf() })
    }
    fn policy(&self) -> StatusPolicy {
        // `notify` only reports turn-complete, so there is no prompt-submitted hook: typing
        // resumes work (`uses_hooks: false`). Silence finishes it only until the first notify.
        StatusPolicy {
            uses_hooks: false,
            finished_after_silence_secs: Some(30),
            stuck_after_silence_secs: Some(900),
            any_exit_ends: false,
            silence_finishes_until_first_event: true,
        }
    }
    fn parse_hook(&self, body: &serde_json::Value) -> Vec<StatusEvent> {
        match body.get("type").and_then(|v| v.as_str()) {
            Some("agent-turn-complete") => vec![StatusEvent::TurnFinished],
            _ => vec![],
        }
    }
    fn screen_prompts(&self) -> Vec<ScreenPrompt> {
        // Empty keys: the user answers in the terminal (canApprove is false).
        vec![
            ScreenPrompt { needle: "allowCodextoworkinthisfolder", reason: "Trust this folder?", approve: b"", deny: b"" },
            ScreenPrompt { needle: "Yesproceed", reason: "Codex wants approval", approve: b"", deny: b"" },
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
            task.into(),
        ];
        assert_eq!(spec.args, expected);
    }

    use std::path::PathBuf;

    #[test]
    fn codex_optional_args_omitted() {
        let d = tempfile::tempdir().unwrap();
        let spec = CodexAdapter.launch(&req(d.path(), None, None, None)).unwrap();
        assert_eq!(spec.args.len(), 4);
        let spec = CodexAdapter.launch(&req(d.path(), None, None, Some(""))).unwrap();
        assert_eq!(spec.args.len(), 4, "an empty task is not passed");
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
    }

    #[test]
    fn codex_parse_turn_complete() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex/agent-turn-complete.json");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        assert_eq!(CodexAdapter.parse_hook(&v), vec![StatusEvent::TurnFinished]);
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

    #[test]
    fn codex_writes_only_inside_session_dir() {
        let d = tempfile::tempdir().unwrap();
        CodexAdapter.launch(&req(d.path(), Some("m"), Some("high"), Some("t"))).unwrap();
        // Launch writes nothing at all: no data-dir entries, hence none outside the session dir.
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0);
    }

    #[test]
    fn codex_detect_parses_version() {
        assert_eq!(parse_version("codex-cli 0.137.0\n").as_deref(), Some("0.137.0"));
        assert_eq!(parse_version("codex-cli 10.2.33-beta").as_deref(), Some("10.2.33"));
        assert_eq!(parse_version("codex-cli"), None);
        assert_eq!(parse_version("v1.2"), None);
    }

    #[test]
    fn codex_screen_prompts_are_terminal_only() {
        let ps = CodexAdapter.screen_prompts();
        assert_eq!(ps.len(), 2);
        assert!(ps.iter().all(|p| p.approve.is_empty() && p.deny.is_empty()));
        assert_eq!(CodexAdapter.approve_keys(), None);
        assert_eq!(CodexAdapter.deny_keys(), None);
        let text = crate::status::screen_text(b"\x1b[1m Yes,\x1b[0m allow Codex to work in this folder without asking");
        assert!(text.contains(ps[0].needle));
        assert!(crate::status::screen_text(b"1. Yes, proceed (y)").contains(ps[1].needle));
    }

    #[test]
    fn codex_silence_finishes_before_first_notify() {
        use crate::model::SessionState::*;
        let p = CodexAdapter.policy();
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::Silence { secs: 29 }, &p), Working);
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::Silence { secs: 30 }, &p), Finished);
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
    fn codex_efforts_and_models() {
        assert!(CodexAdapter.models().is_empty());
        assert_eq!(CodexAdapter.efforts(), vec!["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(CodexAdapter.label(), "Codex");
    }
}
