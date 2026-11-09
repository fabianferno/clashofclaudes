//! Grok Build adapter (xAI's coding agent CLI, `grok`).
//!
//! Status comes from OSC 7501 program-status reports (see `osc.rs`). Grok's default
//! `program_status = "auto"` reports only to a terminal that answers its support query, and the
//! session answers it (`osc::SUPPORT_REPLY`), so nothing is written anywhere: Grok's hooks and
//! notify commands load only from `~/.grok`, a project's `.grok` or `.claude`, all off limits,
//! and its `GROK_CONFIG` overlay can't add them. Verified against a live Grok Build 1.0.77 run in
//! a PTY that answered the query: the trust screen reports `blocked` (permission, "Trust this
//! folder?"), then `idle`, `working` while a turn runs and `error` with the reason (a usage limit
//! there). A turn's `done`, the tool-permission report and its keys are from Grok's docs
//! (`~/.grok/docs/user-guide`, 03 and 05) only, so answering from the app stays off.
//!
//! The conversation is named up front (`--session-id`, the app's session id): Grok keeps it in
//! `$GROK_HOME/sessions/<encoded cwd>/<id>/` once a prompt was sent, and `--resume` continues it.
use super::claude::SHARED_FOLDER_NOTE;
use super::codex::{common_efforts, parse_version};
use super::{AgentAdapter, Detection, DetectionCache, LaunchRequest, ModelChoice, ScreenPrompt, DETECTION_TTL};
use crate::model::AgentKind;
use crate::pty::LaunchSpec;
use crate::status::StatusPolicy;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub struct GrokAdapter;

/// Every effort Grok names, lowest first: the order the effort slider shows them in.
const EFFORT_ORDER: [&str; 4] = ["low", "medium", "high", "xhigh"];

/// Grok's home: `$GROK_HOME`, else `~/.grok`.
fn grok_home() -> Option<PathBuf> {
    std::env::var_os("GROK_HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".grok")))
}

/// The models in Grok's own cache of the account's model list (`models_cache.json`, written by
/// Grok on each start): the ones it doesn't hide, with their names and reasoning efforts.
fn parse_models_cache(json: &[u8]) -> Vec<ModelChoice> {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(json) else { return vec![] };
    let Some(models) = v.get("models").and_then(|m| m.as_object()) else { return vec![] };
    models
        .iter()
        .filter_map(|(key, m)| {
            let info = m.get("info")?;
            if info.get("hidden").and_then(|h| h.as_bool()) == Some(true) {
                return None;
            }
            let id = info.get("id").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).unwrap_or(key).to_string();
            let name = info.get("name").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&id).to_string();
            let mut efforts: Vec<String> = if info.get("supports_reasoning_effort").and_then(|x| x.as_bool()) == Some(true) {
                info.get("reasoning_efforts")
                    .and_then(|x| x.as_array())
                    .map(|ls| ls.iter().filter_map(|l| l.get("value").or_else(|| l.get("id")).and_then(|e| e.as_str()).map(String::from)).collect())
                    .unwrap_or_default()
            } else {
                vec![]
            };
            efforts.sort_by_key(|e| EFFORT_ORDER.iter().position(|o| o == e).unwrap_or(EFFORT_ORDER.len()));
            efforts.dedup();
            Some(ModelChoice { id, name, efforts })
        })
        .collect()
}

fn catalog() -> Vec<ModelChoice> {
    grok_home().and_then(|h| std::fs::read(h.join("models_cache.json")).ok()).map(|b| parse_models_cache(&b)).unwrap_or_default()
}

/// Whether Grok has saved conversation `id` (under any folder) in `home`.
fn has_conversation(home: &Path, id: &str) -> bool {
    let Ok(dirs) = std::fs::read_dir(home.join("sessions")) else { return false };
    dirs.flatten().any(|d| d.path().join(id).join("summary.json").is_file())
}

fn probe() -> Detection {
    super::probe_program("grok", parse_version)
}

/// One `grok --version` per minute at most.
pub static DETECTION: DetectionCache = DetectionCache::new(DETECTION_TTL);

impl AgentAdapter for GrokAdapter {
    fn task_title(&self, raw: &str) -> Option<String> {
        crate::title::grok(raw)
    }
    fn kind(&self) -> AgentKind {
        AgentKind::Grok
    }
    fn label(&self) -> &'static str {
        "Grok Build"
    }
    fn detect(&self) -> Detection {
        DETECTION.get(Instant::now(), probe)
    }
    fn invalidate_detection(&self) {
        DETECTION.invalidate();
    }
    fn models(&self) -> Vec<String> {
        catalog().into_iter().map(|m| m.id).collect()
    }
    fn model_choices(&self) -> Vec<ModelChoice> {
        catalog()
    }
    fn efforts(&self) -> Vec<String> {
        let models = catalog();
        if models.is_empty() {
            return EFFORT_ORDER.map(String::from).to_vec();
        }
        common_efforts(&models)
    }
    fn launch(&self, req: &LaunchRequest) -> anyhow::Result<LaunchSpec> {
        // `=` forms in one argument each, and `--` before the task: a task (or a model) starting
        // with `-` can never be read as an option.
        // A session paused before its first turn ended has no conversation recorded, yet Grok may
        // have saved one under the session's id, which `--session-id` would then refuse.
        let saved = || grok_home().is_some_and(|h| has_conversation(&h, req.session_id));
        let mut args: Vec<String> = vec![match req.resume {
            Some(c) => format!("--resume={c}"),
            None if saved() => format!("--resume={}", req.session_id),
            None => format!("--session-id={}", req.session_id),
        }];
        args.push(format!("--rules={SHARED_FOLDER_NOTE}"));
        if let Some(m) = req.model {
            args.push(format!("--model={m}"));
        }
        if let Some(e) = req.effort {
            args.push(format!("--reasoning-effort={e}"));
        }
        if let Some(d) = super::images_dir(req.images) {
            args.push(format!("--add-dir={}", d.to_string_lossy()));
        }
        if let Some(t) = req.task.filter(|t| !t.is_empty()) {
            args.extend(["--".into(), t.into()]);
        }
        Ok(LaunchSpec { program: "grok".into(), args, env: vec![], cwd: req.cwd.to_path_buf() })
    }
    fn find_conversation(&self, _cwd: &Path, _since_ms: i64, session_id: &str) -> Option<String> {
        has_conversation(&grok_home()?, session_id).then(|| session_id.to_string())
    }
    fn policy(&self) -> StatusPolicy {
        // Before the first report (a sign-in screen, or a Grok that didn't get the support reply)
        // silence means NeedsYou "Waiting in the terminal", never Finished; afterwards Grok's
        // reports decide.
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
        // `status::screen_text` keeps letters and digits only. As Grok 1.0.77 draws its trust
        // screen: "Do you trust the contents of this directory? … Yes, proceed y  No, quit n".
        vec![ScreenPrompt { needle: "Doyoutrustthecontentsofthisdirectory", reason: "Asks whether you trust this folder", approve: b"y", deny: b"n" }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn req<'a>(model: Option<&'a str>, effort: Option<&'a str>, task: Option<&'a str>) -> LaunchRequest<'a> {
        LaunchRequest { session_id: "sid", cwd: Path::new("/tmp"), model, effort, task, hook_url: "http://x", data_dir: Path::new("/nonexistent"), custom_command: None, images: &[], resume: None }
    }

    #[test]
    fn launch_names_the_conversation_and_writes_nothing() {
        let spec = GrokAdapter.launch(&req(Some("grok-4.7"), Some("high"), Some("-rf: fix it"))).unwrap();
        assert_eq!(spec.program, "grok");
        assert_eq!(spec.cwd, PathBuf::from("/tmp"));
        assert_eq!(
            spec.args,
            [
                "--session-id=sid".to_string(),
                format!("--rules={SHARED_FOLDER_NOTE}"),
                "--model=grok-4.7".into(),
                "--reasoning-effort=high".into(),
                "--".into(),
                "-rf: fix it".into(),
            ]
        );
        assert!(spec.env.is_empty());
        assert!(!Path::new("/nonexistent").exists(), "launching created nothing");
    }

    #[test]
    fn bare_launch_resume_and_images() {
        let bare = GrokAdapter.launch(&req(None, None, Some(""))).unwrap();
        assert_eq!(bare.args, ["--session-id=sid".to_string(), format!("--rules={SHARED_FOLDER_NOTE}")]);
        let mut r = req(None, None, None);
        r.resume = Some("conv-1");
        let imgs = [PathBuf::from("/d/images/image-1.png")];
        r.images = &imgs;
        let spec = GrokAdapter.launch(&r).unwrap();
        assert_eq!(spec.args, ["--resume=conv-1".to_string(), format!("--rules={SHARED_FOLDER_NOTE}"), "--add-dir=/d/images".into()]);
    }

    #[test]
    fn models_come_from_groks_cache() {
        // Shape of Grok 1.0.77's models_cache.json (trimmed), plus a hidden and a plain model.
        let json = br#"{"grok_version":"1.0.77","models":{
            "grok-4.7":{"info":{"id":"grok-4.7","name":"Grok 4.7","hidden":false,"supports_reasoning_effort":true,
              "reasoning_efforts":[{"id":"xhigh","value":"xhigh"},{"id":"high","value":"high","default":true},{"id":"medium","value":"medium"},{"id":"low","value":"low"}]}},
            "grok-4.6":{"info":{"id":"grok-4.6","name":"","supports_reasoning_effort":false}},
            "secret":{"info":{"id":"secret","hidden":true}}}}"#;
        let ms = parse_models_cache(json);
        assert_eq!(
            ms,
            [
                ModelChoice { id: "grok-4.6".into(), name: "grok-4.6".into(), efforts: vec![] },
                ModelChoice { id: "grok-4.7".into(), name: "Grok 4.7".into(), efforts: ["low", "medium", "high", "xhigh"].map(String::from).to_vec() },
            ]
        );
        assert!(parse_models_cache(b"not json").is_empty());
        assert!(parse_models_cache(b"{}").is_empty());
    }

    #[test]
    fn a_conversation_counts_once_grok_saved_it() {
        let home = tempfile::tempdir().unwrap();
        assert!(!has_conversation(home.path(), "sid"), "no sessions dir");
        let dir = home.path().join("sessions/%2Ftmp%2Fw/sid");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!has_conversation(home.path(), "sid"), "no summary yet: nothing to resume");
        std::fs::write(dir.join("summary.json"), "{}").unwrap();
        assert!(has_conversation(home.path(), "sid"));
        assert!(!has_conversation(home.path(), "other"));
    }

    #[test]
    fn status_comes_from_reports_and_the_trust_screen() {
        let p = GrokAdapter.policy();
        assert!(p.silence_needs_you_until_first_event && p.finished_after_silence_secs.is_some());
        assert!(GrokAdapter.reads_osc_status());
        assert_eq!((GrokAdapter.approve_keys(), GrokAdapter.deny_keys()), (None, None), "tool prompts are answered in the terminal");
        // As Grok 1.0.77 draws its trust screen.
        let trust = crate::status::screen_text("Do you trust the contents of this directory?\r\n /tmp/w\r\n Grok Build may run or modify contents in this directory, posing security risks.\r\n Yes, proceed  y\r\n No, quit  n".as_bytes());
        let prompts = GrokAdapter.screen_prompts();
        let p = prompts.iter().find(|p| trust.contains(p.needle)).unwrap();
        assert_eq!((p.reason, p.approve, p.deny), ("Asks whether you trust this folder", &b"y"[..], &b"n"[..]));
    }

    #[test]
    fn version_is_the_semver() {
        assert_eq!(parse_version("grok 1.0.77 (50ca579fa996)\n").as_deref(), Some("1.0.77"));
    }
}
