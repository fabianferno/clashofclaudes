//! `<data>/sessions.json`: the sessions listed in the village, kept up to date as they change, so
//! a quit, a crash or a dev rebuild brings them back: the ones that were running resume on their
//! own, the rest come back paused (see `SessionManager::restore` and `resume_was_running`).
use crate::model::{SessionKind, SessionState, Tile, WorktreeInfo};
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: String,
    pub workspace_id: String,
    pub kind: SessionKind,
    pub task: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Its state when last saved while it ran; a reopened agent rests by it (`status::reopened_state`).
    #[serde(default)]
    pub state: Option<SessionState>,
    pub started_at: i64,
    #[serde(default)]
    pub steps: u32,
    #[serde(default)]
    pub reached_finished: bool,
    #[serde(default)]
    pub spot: Option<Tile>,
    #[serde(default)]
    pub worktree: Option<WorktreeInfo>,
    /// The agent's own conversation id, for resuming it (`claude --resume`, `codex resume`,
    /// `agy --conversation`). None until the agent has one, or for agents that can't resume.
    #[serde(default)]
    pub conversation: Option<String>,
    /// The `rev` of the last update sent, so updates after a resume keep increasing.
    #[serde(default)]
    pub rev: u64,
    /// Its process was running when last saved (quitting saves first, then stops them): it
    /// resumes on its own at the next launch. False for one that had exited or was still paused.
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub state_since: i64,
    #[serde(default)]
    pub last_message: Option<String>,
    #[serde(default)]
    pub parked: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    sessions: Vec<SavedSession>,
}

/// The saved sessions; none when the file is missing or unreadable.
pub fn load(path: &Path) -> Vec<SavedSession> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<File>(&b).ok())
        .map(|f| f.sessions)
        .unwrap_or_default()
}

/// Atomically replaces the file (write `.tmp`, rename).
pub fn save(path: &Path, sessions: &[SavedSession]) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(&File { version: 1, sessions: sessions.to_vec() })?;
    std::fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_missing_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("sessions.json");
        assert!(load(&p).is_empty());
        let s = SavedSession {
            id: "a".into(),
            workspace_id: "w".into(),
            kind: SessionKind::Agent { builder_id: "b".into() },
            task: Some("fix it".into()),
            title: None,
            state: None,
            started_at: 5,
            steps: 3,
            reached_finished: true,
            spot: Some(Tile { x: 1, y: -2 }),
            worktree: None,
            conversation: Some("c".into()),
            rev: 9,
            running: true,
            state_since: 4,
            last_message: Some("done".into()),
            parked: Some("later".into()),
        };
        save(&p, std::slice::from_ref(&s)).unwrap();
        assert_eq!(load(&p), vec![s]);
        std::fs::write(&p, "not json").unwrap();
        assert!(load(&p).is_empty());
    }
}
