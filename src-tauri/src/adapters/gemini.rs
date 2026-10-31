//! Gemini CLI adapter (API key / enterprise users).
//!
//! Gemini CLI is not installed where this was written: every format below comes from the
//! documentation (docs/superpowers/research/2026-10-31-agents-and-release.md sections 0 and 2)
//! and is covered by unit tests only. Unverified until an owner check on a real install: the
//! hook payload shape (`hook_event_name`, `notification_type`), `--model=`/`--prompt-interactive=`
//! in `=` form, and the permission prompt keys (so `canApprove` stays false).
//!
//! Per session, `<session dir>/gemini-settings.json` is written and
//! `GEMINI_CLI_SYSTEM_SETTINGS_PATH` points at it; nothing in `~/.gemini` or `<repo>/.gemini`
//! is touched. Because the system-settings file can carry enterprise policy, an existing one is
//! copied into ours with our hooks appended (the original is never modified).
use super::claude::{hook_command, write_private, SHARED_FOLDER_NOTE};
use super::codex::parse_version;
use super::{AgentAdapter, Detection, DetectionCache, LaunchRequest, DETECTION_TTL};
use crate::model::AgentKind;
use crate::platform::which;
use crate::pty::LaunchSpec;
use crate::status::{StatusEvent, StatusPolicy};
use std::path::Path;
use std::time::Instant;

pub struct GeminiAdapter;

/// Default macOS system-settings location (where enterprise policy lives).
const SYSTEM_SETTINGS_PATH: &str = "/Library/Application Support/GeminiCli/settings.json";

const HOOK_EVENTS: [&str; 4] = ["AfterAgent", "Notification", "AfterTool", "SessionEnd"];

fn probe() -> Detection {
    let Some(path) = which("gemini") else {
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

/// One `gemini --version` per minute at most.
pub static DETECTION: DetectionCache = DetectionCache::new(DETECTION_TTL);

/// Our hook entry for one event, in the documented shape.
fn hook_entry(hook_url: &str) -> serde_json::Value {
    serde_json::json!({
        "matcher": "*",
        "hooks": [{ "name": "coc", "type": "command", "command": hook_command(hook_url), "timeout": 5000 }]
    })
}

/// The per-session settings: the system settings at `system_path` (when it parses as a JSON
/// object) with our hooks appended to each event's array; otherwise just our hooks.
fn settings_json(hook_url: &str, system_path: &Path) -> serde_json::Value {
    let mut root = match std::fs::read_to_string(system_path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(v @ serde_json::Value::Object(_)) => v,
            _ => {
                eprintln!("gemini: {} is not a JSON object; not copying it", system_path.display());
                serde_json::json!({})
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => {
            eprintln!("gemini: could not read {}: {e}; not copying it", system_path.display());
            serde_json::json!({})
        }
    };
    let obj = root.as_object_mut().expect("object");
    if !obj.get("hooks").is_some_and(|h| h.is_object()) {
        if obj.contains_key("hooks") {
            eprintln!("gemini: system settings `hooks` is not an object; replacing it in the session copy");
        }
        obj.insert("hooks".into(), serde_json::json!({}));
    }
    let hooks = obj.get_mut("hooks").and_then(|h| h.as_object_mut()).expect("object");
    for ev in HOOK_EVENTS {
        let slot = hooks.entry(ev).or_insert_with(|| serde_json::json!([]));
        if !slot.is_array() {
            eprintln!("gemini: system settings hooks.{ev} is not an array; replacing it in the session copy");
            *slot = serde_json::json!([]);
        }
        slot.as_array_mut().expect("array").push(hook_entry(hook_url));
    }
    root
}

/// Creates `path` (and parents) with mode 0700 and tightens it if it already existed.
fn private_dir(path: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(path)?;
    #[cfg(unix)]
    std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    Ok(())
}

impl GeminiAdapter {
    /// `launch` with the system-settings source path injectable.
    fn launch_with(&self, req: &LaunchRequest, system_path: &Path) -> anyhow::Result<LaunchSpec> {
        let dir = req.data_dir.join("sessions").join(req.session_id);
        private_dir(&dir)?;
        let settings_path = dir.join("gemini-settings.json");
        write_private(&settings_path, &serde_json::to_vec_pretty(&settings_json(req.hook_url, system_path))?)?;

        let mut args: Vec<String> = vec![];
        if let Some(m) = req.model {
            args.push(format!("--model={m}"));
        }
        if let Some(t) = req.task.filter(|t| !t.is_empty()) {
            // `=` form: a task starting with `-` can never be read as an option.
            args.push(format!("--prompt-interactive={SHARED_FOLDER_NOTE}\n\n{t}"));
        }
        let env = vec![("GEMINI_CLI_SYSTEM_SETTINGS_PATH".to_string(), settings_path.to_string_lossy().into_owned())];
        Ok(LaunchSpec { program: "gemini".into(), args, env, cwd: req.cwd.to_path_buf() })
    }
}

impl AgentAdapter for GeminiAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Gemini
    }
    fn label(&self) -> &'static str {
        "Gemini CLI (API key)"
    }
    fn detect(&self) -> Detection {
        DETECTION.get(Instant::now(), probe)
    }
    fn models(&self) -> Vec<String> {
        ["flash", "pro"].map(String::from).to_vec()
    }
    fn efforts(&self) -> Vec<String> {
        vec![]
    }
    fn launch(&self, req: &LaunchRequest) -> anyhow::Result<LaunchSpec> {
        self.launch_with(req, Path::new(SYSTEM_SETTINGS_PATH))
    }
    fn policy(&self) -> StatusPolicy {
        // Before the first hook event (settings not honoured?) silence finishes; afterwards the
        // AfterAgent hook is authoritative and silence alone never finishes.
        StatusPolicy {
            uses_hooks: false,
            finished_after_silence_secs: Some(30),
            stuck_after_silence_secs: Some(900),
            any_exit_ends: false,
            silence_finishes_until_first_event: true,
        }
    }
    fn parse_hook(&self, body: &serde_json::Value) -> Vec<StatusEvent> {
        match body.get("hook_event_name").and_then(|v| v.as_str()) {
            Some("AfterAgent") => vec![StatusEvent::TurnFinished],
            Some("Notification") if body.get("notification_type").and_then(|v| v.as_str()) == Some("ToolPermission") => {
                vec![StatusEvent::PermissionRequested { message: "Gemini wants permission".into() }]
            }
            Some("AfterTool") => vec![StatusEvent::ToolUsed],
            // SessionEnd maps to nothing, as for Claude: the process exit ends the session.
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    const URL: &str = "http://127.0.0.1:4242/hook/tok/sid";

    fn req<'a>(dir: &'a Path, model: Option<&'a str>, effort: Option<&'a str>, task: Option<&'a str>) -> LaunchRequest<'a> {
        LaunchRequest { session_id: "sid", cwd: Path::new("/tmp"), model, effort, task, hook_url: URL, data_dir: dir, custom_command: None }
    }

    fn env_of<'a>(spec: &'a LaunchSpec, k: &str) -> Option<&'a str> {
        spec.env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    fn none(d: &Path) -> PathBuf {
        d.join("no-such-system-settings.json")
    }

    fn settings_of(d: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(d.join("sessions/sid/gemini-settings.json")).unwrap()).unwrap()
    }

    #[test]
    fn gemini_launch_exact() {
        let d = tempfile::tempdir().unwrap();
        let spec = GeminiAdapter.launch_with(&req(d.path(), Some("flash"), None, Some("fix it")), &none(d.path())).unwrap();
        assert_eq!(spec.program, "gemini");
        assert_eq!(spec.cwd, PathBuf::from("/tmp"));
        assert_eq!(spec.args, vec!["--model=flash".to_string(), format!("--prompt-interactive={SHARED_FOLDER_NOTE}\n\nfix it")]);
        let settings = d.path().join("sessions/sid/gemini-settings.json");
        assert_eq!(env_of(&spec, "GEMINI_CLI_SYSTEM_SETTINGS_PATH"), Some(settings.to_str().unwrap()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&settings), 0o600);
            assert_eq!(mode(settings.parent().unwrap()), 0o700);
        }
    }

    #[test]
    fn gemini_optional_args_omitted() {
        let d = tempfile::tempdir().unwrap();
        assert!(GeminiAdapter.launch_with(&req(d.path(), None, Some("high"), None), &none(d.path())).unwrap().args.is_empty());
        assert!(GeminiAdapter.launch_with(&req(d.path(), None, None, Some("")), &none(d.path())).unwrap().args.is_empty());
    }

    #[test]
    fn task_starting_with_dash_is_not_an_option() {
        let d = tempfile::tempdir().unwrap();
        let spec = GeminiAdapter.launch_with(&req(d.path(), Some("-x"), None, Some("--help -m evil")), &none(d.path())).unwrap();
        assert_eq!(spec.args[0], "--model=-x");
        assert_eq!(spec.args[1], format!("--prompt-interactive={SHARED_FOLDER_NOTE}\n\n--help -m evil"));
        assert!(spec.args.iter().all(|a| a.starts_with("--model=") || a.starts_with("--prompt-interactive=")));
    }

    #[test]
    fn gemini_settings_file_hooks_shape() {
        let d = tempfile::tempdir().unwrap();
        GeminiAdapter.launch_with(&req(d.path(), None, None, None), &none(d.path())).unwrap();
        let v = settings_of(d.path());
        assert_eq!(v["hooks"].as_object().unwrap().len(), 4);
        for ev in ["AfterAgent", "Notification", "AfterTool", "SessionEnd"] {
            let arr = v["hooks"][ev].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{ev}");
            assert_eq!(arr[0]["matcher"], "*", "{ev}");
            let h = &arr[0]["hooks"][0];
            assert_eq!(h["name"], "coc");
            assert_eq!(h["type"], "command");
            assert_eq!(h["timeout"], 5000);
            let cmd = h["command"].as_str().unwrap();
            assert!(cmd.starts_with("curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- "), "{cmd}");
            assert!(cmd.ends_with(&format!("'{URL}'")), "{cmd}");
        }
    }

    #[test]
    fn gemini_merges_existing_system_settings() {
        let d = tempfile::tempdir().unwrap();
        let sys = d.path().join("system.json");
        let original = json!({
            "security": {"auth": {"enforcedType": "gemini-api-key"}},
            "hooks": {
                "AfterAgent": [{"matcher": "*", "hooks": [{"type": "command", "command": "audit.sh"}]}],
                "BeforeTool": [{"matcher": "*", "hooks": [{"type": "command", "command": "guard.sh"}]}]
            }
        });
        let text = serde_json::to_string_pretty(&original).unwrap();
        std::fs::write(&sys, &text).unwrap();
        GeminiAdapter.launch_with(&req(d.path(), None, None, None), &sys).unwrap();
        let v = settings_of(d.path());
        assert_eq!(v["security"], original["security"]);
        assert_eq!(v["hooks"]["BeforeTool"], original["hooks"]["BeforeTool"]);
        let after = v["hooks"]["AfterAgent"].as_array().unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after[0], original["hooks"]["AfterAgent"][0], "existing entry kept first");
        assert_eq!(after[1]["hooks"][0]["name"], "coc");
        for ev in ["Notification", "AfterTool", "SessionEnd"] {
            assert_eq!(v["hooks"][ev].as_array().unwrap().len(), 1, "{ev}");
        }
        assert_eq!(std::fs::read_to_string(&sys).unwrap(), text, "the original is never modified");
    }

    #[test]
    fn gemini_unparseable_system_settings_are_not_copied() {
        let d = tempfile::tempdir().unwrap();
        for (i, bad) in ["{ not json", "[1,2]", "\"str\"", ""].into_iter().enumerate() {
            let sys = d.path().join(format!("bad{i}.json"));
            std::fs::write(&sys, bad).unwrap();
            GeminiAdapter.launch_with(&req(d.path(), None, None, None), &sys).unwrap();
            let v = settings_of(d.path());
            assert_eq!(v.as_object().unwrap().keys().collect::<Vec<_>>(), vec!["hooks"], "{bad:?}");
            assert_eq!(v["hooks"]["AfterAgent"].as_array().unwrap().len(), 1);
            assert_eq!(std::fs::read_to_string(&sys).unwrap(), bad);
        }
    }

    #[test]
    fn gemini_malformed_hooks_in_system_settings_do_not_drop_other_keys() {
        let d = tempfile::tempdir().unwrap();
        let sys = d.path().join("s.json");
        std::fs::write(&sys, r#"{"theme":"x","hooks":{"AfterTool":"oops"}}"#).unwrap();
        GeminiAdapter.launch_with(&req(d.path(), None, None, None), &sys).unwrap();
        let v = settings_of(d.path());
        assert_eq!(v["theme"], "x");
        assert_eq!(v["hooks"]["AfterTool"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn gemini_parse_events() {
        let p = |b: serde_json::Value| GeminiAdapter.parse_hook(&b);
        assert_eq!(p(json!({"hook_event_name": "AfterAgent", "prompt": "x"})), vec![StatusEvent::TurnFinished]);
        assert_eq!(
            p(json!({"hook_event_name": "Notification", "notification_type": "ToolPermission", "message": "x"})),
            vec![StatusEvent::PermissionRequested { message: "Gemini wants permission".into() }]
        );
        assert_eq!(p(json!({"hook_event_name": "Notification", "notification_type": "Other"})), vec![]);
        assert_eq!(p(json!({"hook_event_name": "Notification"})), vec![]);
        assert_eq!(p(json!({"hook_event_name": "AfterTool", "tool_name": "x"})), vec![StatusEvent::ToolUsed]);
        assert_eq!(p(json!({"hook_event_name": "SessionEnd"})), vec![]);
        assert_eq!(p(json!({"hook_event_name": "BeforeModel"})), vec![]);
    }

    #[test]
    fn gemini_parse_ignores_garbage() {
        for v in [
            json!("nope"),
            json!({}),
            json!({"tool_name": "x"}),
            json!({"hook_event_name": 7}),
            json!([1, 2]),
            json!(null),
            json!({"hook_event_name": "x".repeat(2 * 1024 * 1024)}),
        ] {
            assert_eq!(GeminiAdapter.parse_hook(&v), vec![]);
        }
    }

    #[test]
    fn gemini_writes_only_inside_session_dir() {
        let d = tempfile::tempdir().unwrap();
        GeminiAdapter.launch_with(&req(d.path(), Some("pro"), Some("low"), Some("t")), &none(d.path())).unwrap();
        let ls = |p: PathBuf| -> Vec<_> { std::fs::read_dir(p).unwrap().map(|e| e.unwrap().file_name()).collect() };
        assert_eq!(ls(d.path().to_path_buf()), vec![std::ffi::OsString::from("sessions")]);
        assert_eq!(ls(d.path().join("sessions")), vec![std::ffi::OsString::from("sid")]);
        assert_eq!(ls(d.path().join("sessions/sid")), vec![std::ffi::OsString::from("gemini-settings.json")]);
    }

    #[test]
    fn gemini_no_events_falls_back_to_silence_policy() {
        use crate::model::SessionState::*;
        let p = GeminiAdapter.policy();
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::Silence { secs: 29 }, &p), Working);
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::Silence { secs: 30 }, &p), Finished);
        let p = p.after_first_event();
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::Silence { secs: 600 }, &p), Working);
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::TurnFinished, &p), Finished);
        assert_eq!(crate::status::next_state(&Finished, &StatusEvent::UserInput, &p), Working);
    }

    #[test]
    fn gemini_cannot_approve() {
        assert_eq!(GeminiAdapter.approve_keys(), None);
        assert_eq!(GeminiAdapter.deny_keys(), None);
        assert!(GeminiAdapter.screen_prompts().is_empty());
    }

    #[test]
    fn gemini_metadata() {
        assert_eq!(GeminiAdapter.kind(), AgentKind::Gemini);
        assert_eq!(GeminiAdapter.models(), vec!["flash", "pro"]);
        assert!(GeminiAdapter.efforts().is_empty());
        assert_eq!(GeminiAdapter.label(), "Gemini CLI (API key)");
        assert_eq!(parse_version("0.9.1\n").as_deref(), Some("0.9.1"));
    }
}
