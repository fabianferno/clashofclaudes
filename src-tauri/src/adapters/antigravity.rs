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
use super::{AgentAdapter, Detection, DetectionCache, LaunchRequest, ModelChoice, ScreenPrompt, DETECTION_TTL};
use crate::model::AgentKind;
use crate::platform::{output_within, RunOutcome};
use crate::pty::LaunchSpec;
use crate::status::StatusPolicy;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

/// Models offered when `agy models` can't be read (signed out, offline, an agy without it).
/// Ordered roughly from fastest to most capable (the model slider runs in this order).
const FALLBACK_MODELS: [&str; 8] = [
    "gpt-oss-120b-medium",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-high",
    "claude-sonnet-5-5-medium",
    "claude-sonnet-5-5-high",
    "gemini-4-argon-medium",
    "gemini-4-argon-high",
    "claude-opus-5-5-high",
];
/// The effort suffixes agy model ids end in, lowest first.
const EFFORT_ORDER: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
/// How long a read list is reused; one that came back empty is retried after DETECTION_TTL.
const CATALOG_TTL: Duration = Duration::from_secs(10 * 60);
/// Longest `agy models` may take (it fetches the account's list from Google).
const CATALOG_TIMEOUT: Duration = Duration::from_secs(8);

static CATALOG: Mutex<Option<(Instant, Vec<ModelChoice>)>> = Mutex::new(None);

/// A model id split into its family and effort rank: "gemini-4-neon-xhigh" is ("gemini-4-neon", 3);
/// an id without an effort suffix is its own family.
fn family_and_effort(id: &str) -> (&str, usize) {
    id.rsplit_once('-')
        .and_then(|(fam, e)| EFFORT_ORDER.iter().position(|o| *o == e).map(|r| (fam, r)))
        .unwrap_or((id, 0))
}

/// The models `agy models` prints (`id<TAB>label` per line, other lines ignored) for the slider:
/// agy lists its top families first, so families run in reverse of that (agy's top pick last, as
/// Claude's most capable is), each from its lowest effort to its highest.
fn parse_models(out: &[u8]) -> Vec<ModelChoice> {
    let text = String::from_utf8_lossy(out);
    let mut listed: Vec<ModelChoice> = vec![];
    for line in text.lines() {
        let Some((id, name)) = line.split_once('\t') else { continue };
        let id = id.trim();
        if id.is_empty() || id.contains(char::is_whitespace) || listed.iter().any(|m| m.id == id) {
            continue;
        }
        let name = Some(name.trim()).filter(|n| !n.is_empty()).unwrap_or(id);
        listed.push(ModelChoice { id: id.to_string(), name: name.to_string(), efforts: vec![] });
    }
    let mut families: Vec<&str> = vec![];
    for m in &listed {
        let fam = family_and_effort(&m.id).0;
        if !families.contains(&fam) {
            families.push(fam);
        }
    }
    let rank = |id: &str| {
        let (fam, effort) = family_and_effort(id);
        (families.len() - families.iter().position(|f| *f == fam).unwrap_or(0), effort)
    };
    let mut ordered = listed.clone();
    ordered.sort_by_key(|m| rank(&m.id));
    ordered
}

/// The account's models from the agy at `path`; empty when it can't say (e.g. signed out).
fn catalog_from(path: &Path, timeout: Duration) -> Vec<ModelChoice> {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("models");
    match output_within(cmd, timeout) {
        RunOutcome::Exited { success: true, stdout } => parse_models(&stdout),
        _ => vec![],
    }
}

/// agy's models, read at most every CATALOG_TTL (Re-check reads them again); the built-in list
/// when they can't be read.
fn catalog() -> Vec<ModelChoice> {
    let mut cached = CATALOG.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = cached.as_ref().filter(|(at, models)| at.elapsed() < if models.is_empty() { DETECTION_TTL } else { CATALOG_TTL });
    let models = match fresh {
        Some((_, models)) => models.clone(),
        None => {
            let models = AntigravityAdapter.detect().path.map(|p| catalog_from(&p, CATALOG_TIMEOUT)).unwrap_or_default();
            *cached = Some((Instant::now(), models.clone()));
            models
        }
    };
    if models.is_empty() {
        FALLBACK_MODELS.iter().map(|m| ModelChoice { id: m.to_string(), name: m.to_string(), efforts: vec![] }).collect()
    } else {
        models
    }
}

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
        *CATALOG.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    fn models(&self) -> Vec<String> {
        catalog().into_iter().map(|m| m.id).collect()
    }
    fn model_choices(&self) -> Vec<ModelChoice> {
        catalog()
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
    fn models_list_runs_agys_top_family_last_each_from_low_to_high_effort() {
        let out = b"Fetching available models...\n\
gemini-4-neon-high\tGemini 4 Neon (High)\n\
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\n\
gemini-4-neon-low\tGemini 4 Neon (Low)\n\
gemini-pro-orchestrator\tOrchestrator (Carbon)\n\
gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\
gemini-3.8-flash-low\tduplicate\n\
gpt-oss-120b-medium\t\n";
        let ids: Vec<String> = parse_models(out).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, [
            "gpt-oss-120b-medium",
            "gemini-3.8-flash-low",
            "gemini-3.8-flash-high",
            "gemini-pro-orchestrator",
            "gemini-4-neon-low",
            "gemini-4-neon-high",
            "gemini-4-neon-xhigh",
        ]);
        let m = parse_models(out);
        assert_eq!(m.iter().find(|m| m.id == "gemini-4-neon-xhigh").unwrap().name, "Gemini 4 Neon (XHigh)");
        assert_eq!(m.iter().find(|m| m.id == "gpt-oss-120b-medium").unwrap().name, "gpt-oss-120b-medium", "no label: the id");
        assert!(parse_models(b"Please sign in ... Launch the CLI without arguments to sign in.").is_empty());
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
