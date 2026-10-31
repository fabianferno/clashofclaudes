//! Antigravity CLI adapter (`agy`; it replaced Gemini CLI for Google's consumer plans).
//!
//! Status comes from OSC 7501 reports that agy writes into the terminal stream when launched
//! with `AGY_CLI_OSC7501=on` (see `osc.rs`): working, blocked (permission, question, sign-in),
//! done and error. Nothing is written anywhere: agy's hooks can only be injected through a
//! workspace folder or `~/.gemini/config`, both off limits, and a HOME override breaks its
//! keychain login (docs/superpowers/research/2026-10-31-antigravity.md). The permission prompt
//! is also matched on screen as a fallback. Verified so far against agy 1.4.6's help, model list
//! and embedded docs; the exact report body and the prompt keys await an owner run, so
//! `canApprove` stays false (answer in the terminal).
use super::claude::SHARED_FOLDER_NOTE;
use super::codex::parse_version;
use super::{AgentAdapter, Detection, DetectionCache, LaunchRequest, ScreenPrompt, DETECTION_TTL};
use crate::model::AgentKind;
use crate::pty::LaunchSpec;
use crate::status::StatusPolicy;
use std::time::Instant;

pub struct AntigravityAdapter;

fn probe() -> Detection {
    super::probe_program("agy", parse_version)
}

/// One `agy --version` per minute at most.
pub static DETECTION: DetectionCache = DetectionCache::new(DETECTION_TTL);

/// Model ids as `agy models` lists them (account-dependent; each embeds its effort level).
/// Ordered roughly from fastest to most capable (the model slider runs in this order).
const MODELS: [&str; 8] = [
    "gpt-oss-120b-medium",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-high",
    "claude-sonnet-5-5-medium",
    "claude-sonnet-5-5-high",
    "gemini-4-argon-medium",
    "gemini-4-argon-high",
    "claude-opus-5-5-high",
];

impl AgentAdapter for AntigravityAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Antigravity
    }
    fn label(&self) -> &'static str {
        "Antigravity CLI"
    }
    fn detect(&self) -> Detection {
        DETECTION.get(Instant::now(), probe)
    }
    fn invalidate_detection(&self) {
        DETECTION.invalidate();
    }
    fn models(&self) -> Vec<String> {
        MODELS.map(String::from).to_vec()
    }
    fn efforts(&self) -> Vec<String> {
        vec![] // part of the model id
    }
    fn launch(&self, req: &LaunchRequest) -> anyhow::Result<LaunchSpec> {
        let mut args: Vec<String> = vec![];
        if let Some(m) = req.model {
            args.push(format!("--model={m}"));
        }
        if let Some(t) = req.task.filter(|t| !t.is_empty()) {
            // `=` form in one argument: a task starting with `-` can never be read as an option.
            args.push(format!("--prompt-interactive={SHARED_FOLDER_NOTE}\n\n{t}"));
        }
        let env = vec![("AGY_CLI_OSC7501".to_string(), "on".to_string())];
        Ok(LaunchSpec { program: "agy".into(), args, env, cwd: req.cwd.to_path_buf() })
    }
    fn policy(&self) -> StatusPolicy {
        // Before the first report (a sign-in or trust screen, or reports not arriving) silence
        // means NeedsYou "Waiting in the terminal", never Finished; afterwards agy's reports decide.
        StatusPolicy {
            uses_hooks: false,
            finished_after_silence_secs: Some(30),
            stuck_after_silence_secs: Some(900),
            any_exit_ends: false,
            silence_needs_you_until_first_event: true,
        }
    }
    fn reads_osc_status(&self) -> bool {
        true
    }
    fn screen_prompts(&self) -> Vec<ScreenPrompt> {
        // `status::screen_text` keeps letters and digits only. Keys per agy's docs (y / n);
        // unused until `canApprove` is turned on.
        vec![
            ScreenPrompt { needle: "Yesandalwaysallow", reason: "Antigravity wants permission", approve: b"y", deny: b"n" },
            ScreenPrompt { needle: "Doyoutrustthecontentsofthisproject", reason: "Asks whether you trust this folder", approve: b"y", deny: b"n" },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn req<'a>(model: Option<&'a str>, task: Option<&'a str>) -> LaunchRequest<'a> {
        LaunchRequest { session_id: "sid", cwd: Path::new("/tmp"), model, effort: Some("high"), task, hook_url: "http://x", data_dir: Path::new("/nonexistent"), custom_command: None }
    }

    #[test]
    fn launch_is_agy_with_osc_reports_on_and_writes_nothing() {
        let spec = AntigravityAdapter.launch(&req(Some("gemini-3.8-flash-medium"), Some("-rf: fix it"))).unwrap();
        assert_eq!(spec.program, "agy");
        assert_eq!(spec.cwd, PathBuf::from("/tmp"));
        assert_eq!(spec.args[0], "--model=gemini-3.8-flash-medium");
        assert_eq!(spec.args.len(), 2, "effort is part of the model id, never a flag");
        assert!(spec.args[1].starts_with("--prompt-interactive=") && spec.args[1].ends_with("\n\n-rf: fix it"));
        assert_eq!(spec.env, vec![("AGY_CLI_OSC7501".to_string(), "on".to_string())]);
        // data_dir does not exist: launching created nothing there (or anywhere).
        assert!(!Path::new("/nonexistent").exists());
    }

    #[test]
    fn bare_launch_and_status_policy() {
        let spec = AntigravityAdapter.launch(&req(None, Some(""))).unwrap();
        assert!(spec.args.is_empty());
        let p = AntigravityAdapter.policy();
        assert!(p.silence_needs_you_until_first_event && p.finished_after_silence_secs.is_some());
        assert!(AntigravityAdapter.reads_osc_status());
        assert!(AntigravityAdapter.approve_keys().is_none(), "canApprove stays off until verified");
    }

    #[test]
    fn permission_prompt_matches_on_screen() {
        let text = crate::status::screen_text(b"\x1b[1m> Yes, and always allow tool 'run_command' in this conversation\x1b[0m");
        assert!(AntigravityAdapter.screen_prompts().iter().any(|p| text.contains(p.needle)));
    }
}
