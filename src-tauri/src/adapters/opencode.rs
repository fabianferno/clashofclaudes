//! OpenCode (sst/opencode) adapter.
//!
//! OpenCode is not installed where this was written: every format below comes from the
//! documentation (docs/superpowers/research/2026-10-31-agents-and-release.md section 3) and is
//! covered by unit tests only. Unverified until an owner check on a real install: the plugin
//! event shapes (`event.properties`, the `tool.execute.after` hook), `--prompt`/`--model` in
//! `=` form, and the permission prompt keys (so `canApprove` stays false).
//!
//! Per session, `<session dir>/opencode/plugins/coc.js` is written and `OPENCODE_CONFIG_DIR`
//! points at `<session dir>/opencode`; nothing in `~/.config/opencode`, `<repo>/.opencode` or
//! `opencode.json` is touched.
use super::claude::{write_private, SHARED_FOLDER_NOTE};
use super::codex::parse_version;
use super::{AgentAdapter, Detection, DetectionCache, LaunchRequest, DETECTION_TTL};
use crate::model::AgentKind;
use crate::platform::which;
use crate::pty::LaunchSpec;
use crate::status::{StatusEvent, StatusPolicy};
use std::time::Instant;

pub struct OpenCodeAdapter;

const PLUGIN_JS: &str = include_str!("opencode_plugin.js");

/// `provider/model` split at the first `/`; both halves must be non-empty.
fn split_model(model: &str) -> Option<(&str, &str)> {
    model.split_once('/').filter(|(p, m)| !p.is_empty() && !m.is_empty())
}

/// `OPENCODE_CONFIG_CONTENT` for a known `provider/model` and an effort.
fn config_content(model: &str, effort: &str) -> Option<String> {
    let (p, m) = split_model(model)?;
    let v = serde_json::json!({ "provider": { p: { "models": { m: { "options": { "reasoningEffort": effort } } } } } });
    serde_json::to_string(&v).ok()
}

/// Creates `path` (and parents) with mode 0700 and tightens it if it already existed.
fn private_dir(path: &std::path::Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(path)?;
    #[cfg(unix)]
    std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    Ok(())
}

fn probe() -> Detection {
    let Some(path) = which("opencode") else {
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

/// One `opencode --version` per minute at most.
pub static DETECTION: DetectionCache = DetectionCache::new(DETECTION_TTL);

impl AgentAdapter for OpenCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::OpenCode
    }
    fn label(&self) -> &'static str {
        "OpenCode"
    }
    fn detect(&self) -> Detection {
        DETECTION.get(Instant::now(), probe)
    }
    fn invalidate_detection(&self) {
        DETECTION.invalidate();
    }
    fn models(&self) -> Vec<String> {
        vec![]
    }
    fn efforts(&self) -> Vec<String> {
        ["low", "medium", "high", "xhigh", "max"].map(String::from).to_vec()
    }
    fn launch(&self, req: &LaunchRequest) -> anyhow::Result<LaunchSpec> {
        // The project path is the first positional: it must not be readable as an option.
        anyhow::ensure!(req.cwd.is_absolute(), "cwd must be absolute");
        let cfg_dir = req.data_dir.join("sessions").join(req.session_id).join("opencode");
        let plugins = cfg_dir.join("plugins");
        private_dir(&plugins)?;
        private_dir(&cfg_dir)?;
        write_private(&plugins.join("coc.js"), PLUGIN_JS.as_bytes())?;

        let mut args: Vec<String> = vec![req.cwd.to_string_lossy().into_owned()];
        if let Some(m) = req.model {
            args.push(format!("--model={m}"));
        }
        if let Some(t) = req.task.filter(|t| !t.is_empty()) {
            // `=` form: a task starting with `-` can never be read as an option.
            args.push(format!("--prompt={SHARED_FOLDER_NOTE}\n\n{t}"));
        }
        let mut env = vec![
            ("OPENCODE_CONFIG_DIR".to_string(), cfg_dir.to_string_lossy().into_owned()),
            ("COC_HOOK_URL".to_string(), req.hook_url.to_string()),
        ];
        if let Some(c) = req.model.zip(req.effort).and_then(|(m, e)| config_content(m, e)) {
            env.push(("OPENCODE_CONFIG_CONTENT".to_string(), c));
        }
        Ok(LaunchSpec { program: "opencode".into(), args, env, cwd: req.cwd.to_path_buf() })
    }
    fn policy(&self) -> StatusPolicy {
        // Before the first plugin event (plugin not loaded?) silence finishes; afterwards the
        // plugin's session.idle is authoritative and silence alone never finishes.
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
            Some("session.idle") => vec![StatusEvent::TurnFinished],
            Some("permission.asked") => vec![StatusEvent::PermissionRequested { message: "OpenCode wants permission".into() }],
            Some("tool.execute.after") => vec![StatusEvent::ToolUsed],
            Some("session.error") => vec![StatusEvent::Failed { reason: "OpenCode reported an error".into() }],
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::{Path, PathBuf};

    const URL: &str = "http://127.0.0.1:4242/hook/tok/sid";

    fn req<'a>(dir: &'a Path, model: Option<&'a str>, effort: Option<&'a str>, task: Option<&'a str>) -> LaunchRequest<'a> {
        LaunchRequest { session_id: "sid", cwd: Path::new("/tmp"), model, effort, task, hook_url: URL, data_dir: dir, custom_command: None }
    }

    fn env_of<'a>(spec: &'a LaunchSpec, k: &str) -> Option<&'a str> {
        spec.env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    #[test]
    fn opencode_launch_exact() {
        let d = tempfile::tempdir().unwrap();
        let spec = OpenCodeAdapter.launch(&req(d.path(), Some("anthropic/claude-x"), None, Some("fix it"))).unwrap();
        assert_eq!(spec.program, "opencode");
        assert_eq!(spec.cwd, PathBuf::from("/tmp"));
        assert_eq!(
            spec.args,
            vec!["/tmp".to_string(), "--model=anthropic/claude-x".into(), format!("--prompt={SHARED_FOLDER_NOTE}\n\nfix it")]
        );
        let cfg = d.path().join("sessions/sid/opencode");
        assert_eq!(env_of(&spec, "OPENCODE_CONFIG_DIR"), Some(cfg.to_str().unwrap()));
        assert_eq!(env_of(&spec, "COC_HOOK_URL"), Some(URL));
        assert_eq!(env_of(&spec, "OPENCODE_CONFIG_CONTENT"), None, "no effort, no config content");
        let plugin = cfg.join("plugins/coc.js");
        assert_eq!(std::fs::read_to_string(&plugin).unwrap(), PLUGIN_JS);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&plugin), 0o600);
            assert_eq!(mode(&cfg), 0o700);
            assert_eq!(mode(&cfg.join("plugins")), 0o700);
        }
    }

    #[test]
    fn opencode_optional_args_omitted() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(OpenCodeAdapter.launch(&req(d.path(), None, None, None)).unwrap().args, vec!["/tmp"]);
        assert_eq!(OpenCodeAdapter.launch(&req(d.path(), None, None, Some(""))).unwrap().args, vec!["/tmp"]);
    }

    #[test]
    fn task_starting_with_dash_is_not_an_option() {
        let d = tempfile::tempdir().unwrap();
        let spec = OpenCodeAdapter.launch(&req(d.path(), Some("-x/-y"), None, Some("--help -m evil"))).unwrap();
        assert_eq!(spec.args[1], "--model=-x/-y");
        assert_eq!(spec.args[2], format!("--prompt={SHARED_FOLDER_NOTE}\n\n--help -m evil"));
        assert!(spec.args[1..].iter().all(|a| a.starts_with("--model=") || a.starts_with("--prompt=")));
    }

    #[test]
    fn relative_cwd_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        let mut r = req(d.path(), None, None, None);
        r.cwd = Path::new("-rf");
        assert!(OpenCodeAdapter.launch(&r).is_err());
    }

    #[test]
    fn opencode_effort_config_content_json() {
        let d = tempfile::tempdir().unwrap();
        let spec = OpenCodeAdapter.launch(&req(d.path(), Some("openai/gpt-\"5\""), Some("high"), None)).unwrap();
        let v: serde_json::Value = serde_json::from_str(env_of(&spec, "OPENCODE_CONFIG_CONTENT").unwrap()).unwrap();
        assert_eq!(v, json!({"provider": {"openai": {"models": {"gpt-\"5\"": {"options": {"reasoningEffort": "high"}}}}}}));
        // Not applicable: effort without a model, or a model without `provider/model` form.
        for m in [None, Some("gpt-5"), Some("/x"), Some("x/")] {
            let spec = OpenCodeAdapter.launch(&req(d.path(), m, Some("high"), None)).unwrap();
            assert_eq!(env_of(&spec, "OPENCODE_CONFIG_CONTENT"), None, "{m:?}");
        }
        // A model without an effort sets no config either.
        let spec = OpenCodeAdapter.launch(&req(d.path(), Some("a/b"), None, None)).unwrap();
        assert_eq!(env_of(&spec, "OPENCODE_CONFIG_CONTENT"), None);
    }

    #[test]
    fn opencode_parse_events() {
        let p = |t: &str| OpenCodeAdapter.parse_hook(&json!({"type": t, "properties": {"x": 1}}));
        assert_eq!(p("session.idle"), vec![StatusEvent::TurnFinished]);
        assert_eq!(p("permission.asked"), vec![StatusEvent::PermissionRequested { message: "OpenCode wants permission".into() }]);
        assert_eq!(p("tool.execute.after"), vec![StatusEvent::ToolUsed]);
        assert_eq!(p("session.error"), vec![StatusEvent::Failed { reason: "OpenCode reported an error".into() }]);
        assert_eq!(p("message.updated"), vec![]);
    }

    #[test]
    fn opencode_parse_ignores_garbage() {
        for v in [
            json!("nope"),
            json!({}),
            json!({"properties": {}}),
            json!({"type": 7}),
            json!({"type": "something.new"}),
            json!([1, 2]),
            json!(null),
            json!({"type": "x".repeat(2 * 1024 * 1024)}),
        ] {
            assert_eq!(OpenCodeAdapter.parse_hook(&v), vec![]);
        }
    }

    #[test]
    fn opencode_writes_only_inside_session_dir() {
        let d = tempfile::tempdir().unwrap();
        OpenCodeAdapter.launch(&req(d.path(), Some("a/b"), Some("low"), Some("t"))).unwrap();
        let top: Vec<_> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(top, vec![std::ffi::OsString::from("sessions")]);
        let sess: Vec<_> = std::fs::read_dir(d.path().join("sessions")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(sess, vec![std::ffi::OsString::from("sid")]);
        let inner: Vec<_> = std::fs::read_dir(d.path().join("sessions/sid")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(inner, vec![std::ffi::OsString::from("opencode")]);
    }

    #[test]
    fn opencode_no_events_falls_back_to_silence_policy() {
        use crate::model::SessionState::*;
        let p = OpenCodeAdapter.policy();
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::Silence { secs: 29 }, &p), Working);
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::Silence { secs: 30 }, &p), Finished);
        let p = p.after_first_event();
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::Silence { secs: 600 }, &p), Working);
        assert_eq!(crate::status::next_state(&Working, &StatusEvent::TurnFinished, &p), Finished);
        assert_eq!(crate::status::next_state(&Finished, &StatusEvent::UserInput, &p), Working);
    }

    #[test]
    fn opencode_cannot_approve() {
        assert_eq!(OpenCodeAdapter.approve_keys(), None);
        assert_eq!(OpenCodeAdapter.deny_keys(), None);
        assert!(OpenCodeAdapter.screen_prompts().is_empty());
    }

    #[test]
    fn opencode_metadata_and_version() {
        assert!(OpenCodeAdapter.models().is_empty());
        assert_eq!(OpenCodeAdapter.efforts(), vec!["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(OpenCodeAdapter.label(), "OpenCode");
        assert_eq!(parse_version("0.15.3\n").as_deref(), Some("0.15.3"));
    }

    #[test]
    fn plugin_js_has_required_shape() {
        for needle in ["process.env.COC_HOOK_URL", "AbortSignal.timeout(2000)", "JSON.stringify", "session.idle", "permission.asked", "tool.execute.after", "session.error"] {
            assert!(PLUGIN_JS.contains(needle), "{needle}");
        }
    }

    #[test]
    fn plugin_js_is_syntax_valid() {
        let Some(node) = which("node") else {
            eprintln!("skipping plugin_js_is_syntax_valid: node not on PATH");
            return;
        };
        let d = tempfile::tempdir().unwrap();
        // `.mjs` so node parses it as an ES module (the plugin uses `export`).
        let f = d.path().join("coc.mjs");
        std::fs::write(&f, PLUGIN_JS).unwrap();
        let out = std::process::Command::new(node).arg("--check").arg(&f).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn plugin_js_posts_only_whitelisted_and_never_throws() {
        let Some(node) = which("node") else {
            eprintln!("skipping: node not on PATH");
            return;
        };
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("coc.mjs");
        std::fs::write(&f, PLUGIN_JS).unwrap();
        let driver = d.path().join("run.mjs");
        std::fs::write(
            &driver,
            r#"import { CocStatusPlugin } from "./coc.mjs";
const sent = [];
globalThis.fetch = async (u, o) => { sent.push(JSON.parse(o.body)); if (sent.length === 1) throw new Error("boom"); };
const h = await CocStatusPlugin({});
await h.event({ event: { type: "message.updated", properties: { text: "SECRET" } } });
await h.event({ event: { type: "session.idle", properties: { text: "SECRET" } } });
await h.event({ event: { type: "permission.asked", properties: { title: "Run ls", type: "bash", args: "SECRET" } } });
await h.event(undefined);
await h["tool.execute.after"]({ tool: "bash" }, { args: "SECRET" });
console.log(JSON.stringify(sent));"#,
        )
        .unwrap();
        let out = std::process::Command::new(node).arg(&driver).env("COC_HOOK_URL", URL).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let s = String::from_utf8_lossy(&out.stdout);
        assert!(!s.contains("SECRET"));
        let sent: serde_json::Value = serde_json::from_str(s.trim()).unwrap();
        assert_eq!(
            sent,
            json!([{"type": "session.idle"}, {"type": "permission.asked", "properties": {"title": "Run ls", "type": "bash"}}, {"type": "tool.execute.after"}])
        );
    }
}
