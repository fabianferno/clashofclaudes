//! Antigravity CLI adapter (`agy`; it replaced Gemini CLI for Google's consumer plans).
//!
//! Status comes from OSC 7501 reports that agy writes into the terminal stream when launched
//! with `AGY_CLI_OSC7501=on` (see `osc.rs`): working, blocked (permission, question, sign-in),
//! done and error. Nothing is written anywhere: agy's hooks can only be injected through a
//! workspace folder or `~/.gemini/config`, both off limits, and a HOME override breaks its
//! keychain login (docs/superpowers/research/2026-10-31-antigravity.md). The permission prompt
//! is also matched on screen as a fallback. Verified against a live agy 1.4.12 run: its trust and
//! permission prompts are arrow-key menus with the cursor on "Yes", so Enter approves; Esc
//! cancels (a tool prompt interrupts the turn, the trust menu exits agy).
use super::claude::SHARED_FOLDER_NOTE;
use super::codex::parse_version;
use super::{AgentAdapter, Detection, DetectionCache, LaunchRequest, ScreenPrompt, DETECTION_TTL};
use crate::model::AgentKind;
use crate::pty::LaunchSpec;
use crate::status::StatusPolicy;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub struct AntigravityAdapter;

/// agy's prompt history under HOME: one JSON line per prompt, naming its workspace and conversation.
const HISTORY: &str = ".gemini/antigravity-cli/history.jsonl";

/// The conversation of the newest prompt sent in `cwd` at or after `since_ms`.
fn conversation_in_history(history: &[u8], cwd: &Path, since_ms: i64) -> Option<String> {
    String::from_utf8_lossy(history).lines().rev().find_map(|l| {
        let v: serde_json::Value = serde_json::from_str(l).ok()?;
        let here = v.get("workspace")?.as_str().map(Path::new)? == cwd;
        let recent = v.get("timestamp")?.as_i64()? >= since_ms;
        (here && recent).then(|| v.get("conversationId")?.as_str().map(String::from)).flatten()
    })
}

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
        if let Some(d) = super::images_dir(req.images) {
            args.push(format!("--add-dir={}", d.to_string_lossy()));
        }
        if let Some(c) = req.resume {
            args.push(format!("--conversation={c}"));
        }
        if let Some(t) = req.task.filter(|t| !t.is_empty()) {
            // `=` form in one argument: a task starting with `-` can never be read as an option.
            args.push(format!("--prompt-interactive={SHARED_FOLDER_NOTE}\n\n{t}"));
        }
        let env = vec![("AGY_CLI_OSC7501".to_string(), "on".to_string())];
        Ok(LaunchSpec { program: "agy".into(), args, env, cwd: req.cwd.to_path_buf() })
    }
    fn find_conversation(&self, cwd: &Path, since_ms: i64, _session_id: &str) -> Option<String> {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        conversation_in_history(&std::fs::read(home.join(HISTORY)).ok()?, cwd, since_ms)
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
    fn approve_keys(&self) -> Option<&'static [u8]> {
        Some(b"\r")
    }
    fn deny_keys(&self) -> Option<&'static [u8]> {
        Some(b"\x1b")
    }
    fn screen_prompts(&self) -> Vec<ScreenPrompt> {
        // `status::screen_text` keeps letters and digits only. Tool prompts (run a command, create
        // or edit a file) all end in "↑/↓ Navigate · tab Amend"; the trust menu has its own text.
        vec![
            ScreenPrompt { needle: "NavigatetabAmend", reason: "Antigravity wants permission", approve: b"\r", deny: b"\x1b" },
            ScreenPrompt { needle: "Doyoutrustthecontentsofthisproject", reason: "Asks whether you trust this folder", approve: b"\r", deny: b"\x1b" },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn req<'a>(model: Option<&'a str>, task: Option<&'a str>) -> LaunchRequest<'a> {
        LaunchRequest { session_id: "sid", cwd: Path::new("/tmp"), model, effort: Some("high"), task, hook_url: "http://x", data_dir: Path::new("/nonexistent"), custom_command: None, images: &[], resume: None }
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
    fn resume_continues_the_conversation_without_a_prompt() {
        let mut r = req(Some("gemini-3.8-flash-medium"), None);
        r.resume = Some("conv-1");
        let spec = AntigravityAdapter.launch(&r).unwrap();
        assert_eq!(spec.args, ["--model=gemini-3.8-flash-medium", "--conversation=conv-1"]);
    }

    #[test]
    fn conversation_is_the_newest_prompt_in_the_folder_since_the_start() {
        let h = br#"{"display":"a","timestamp":100,"workspace":"/w","conversationId":"old"}
{"display":"b","timestamp":200,"workspace":"/other","conversationId":"elsewhere"}
not json
{"display":"c","timestamp":300,"workspace":"/w","conversationId":"mine"}
{"display":"d","timestamp":400,"workspace":"/x","conversationId":"later"}"#;
        assert_eq!(conversation_in_history(h, Path::new("/w"), 150).as_deref(), Some("mine"));
        assert_eq!(conversation_in_history(h, Path::new("/w"), 350), None);
        assert_eq!(conversation_in_history(b"", Path::new("/w"), 0), None);
    }

    #[test]
    fn bare_launch_and_status_policy() {
        let spec = AntigravityAdapter.launch(&req(None, Some(""))).unwrap();
        assert!(spec.args.is_empty());
        let p = AntigravityAdapter.policy();
        assert!(p.silence_needs_you_until_first_event && p.finished_after_silence_secs.is_some());
        assert!(AntigravityAdapter.reads_osc_status());
        assert_eq!(AntigravityAdapter.approve_keys(), Some(&b"\r"[..]), "Enter takes the default Yes");
        assert_eq!(AntigravityAdapter.deny_keys(), Some(&b"\x1b"[..]), "Esc cancels");
    }

    #[test]
    fn permission_prompt_matches_on_screen() {
        // As agy 1.4.12 draws a file prompt and the trust menu.
        let file = crate::status::screen_text("Allow creation of this file?\r\n> 1. Yes, allow creation\r\n  2. No, deny creation\r\n\r\n  ↑/↓ Navigate · tab Amend · f full diff".as_bytes());
        let trust = crate::status::screen_text(b"Do you trust the contents of this project?\r\n\r\n> Yes, I trust this folder");
        let prompts = AntigravityAdapter.screen_prompts();
        assert_eq!(prompts.iter().find(|p| file.contains(p.needle)).unwrap().reason, "Antigravity wants permission");
        assert_eq!(prompts.iter().find(|p| trust.contains(p.needle)).unwrap().reason, "Asks whether you trust this folder");
    }
}
