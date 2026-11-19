//! `<data>/history.json`: agent sessions the owner closed, newest first, each with the agent's own
//! conversation id, so a past chat can be opened again and carried on (`claude --resume`,
//! `codex resume`, `agy --conversation`). Only sessions whose conversation is known are kept.
use crate::model::{AgentKind, WorktreeInfo};
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The oldest entries past this many are forgotten.
pub const HISTORY_MAX: usize = 300;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// The closed session's id (an entry's own id).
    pub id: String,
    pub workspace_id: String,
    pub builder_id: String,
    /// Kept so the entry still says which agent it was after its builder is deleted.
    pub agent: AgentKind,
    pub builder_name: String,
    pub task: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub last_message: Option<String>,
    pub conversation: String,
    pub started_at: i64,
    pub closed_at: i64,
    #[serde(default)]
    pub steps: u32,
    #[serde(default)]
    pub reached_finished: bool,
    /// The app's own worktree it ran in; it carries on there while that folder exists.
    #[serde(default)]
    pub worktree: Option<WorktreeInfo>,
}

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    entries: Vec<HistoryEntry>,
}

/// The entries, newest first; none when the file is missing or unreadable.
pub fn load(path: &Path) -> Vec<HistoryEntry> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<File>(&b).ok())
        .map(|f| f.entries)
        .unwrap_or_default()
}

/// Atomically replaces the file (write `.tmp`, rename).
pub fn save(path: &Path, entries: &[HistoryEntry]) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(&File { version: 1, entries: entries.to_vec() })?;
    std::fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

/// Puts `e` first; an older entry for the same conversation is replaced (a chat carried on and
/// closed again shows once, with its latest state). Keeps at most `HISTORY_MAX`.
pub fn push(list: &mut Vec<HistoryEntry>, e: HistoryEntry) {
    list.retain(|x| x.conversation != e.conversation && x.id != e.id);
    list.insert(0, e);
    list.truncate(HISTORY_MAX);
}

/// Removes the entry; returns it.
pub fn take(list: &mut Vec<HistoryEntry>, id: &str) -> Option<HistoryEntry> {
    let i = list.iter().position(|x| x.id == id)?;
    Some(list.remove(i))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, conv: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            workspace_id: "w".into(),
            builder_id: "b".into(),
            agent: AgentKind::Claude,
            builder_name: "Bob".into(),
            task: Some("fix it".into()),
            title: None,
            last_message: None,
            conversation: conv.into(),
            started_at: 1,
            closed_at: 2,
            steps: 3,
            reached_finished: true,
            worktree: None,
        }
    }

    #[test]
    fn newest_first_one_per_conversation_capped() {
        let mut l = vec![];
        push(&mut l, entry("a", "c1"));
        push(&mut l, entry("b", "c2"));
        push(&mut l, entry("c", "c1"));
        assert_eq!(l.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["c", "b"]);
        for i in 0..HISTORY_MAX + 5 {
            push(&mut l, entry(&format!("x{i}"), &format!("k{i}")));
        }
        assert_eq!(l.len(), HISTORY_MAX);
        assert_eq!(l[0].id, format!("x{}", HISTORY_MAX + 4));
    }

    #[test]
    fn take_removes_by_id() {
        let mut l = vec![entry("a", "c1"), entry("b", "c2")];
        assert_eq!(take(&mut l, "b").unwrap().conversation, "c2");
        assert!(take(&mut l, "b").is_none());
        assert_eq!(l.len(), 1);
    }

    #[test]
    fn saves_and_loads() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("history.json");
        assert!(load(&p).is_empty());
        save(&p, &[entry("a", "c1")]).unwrap();
        assert_eq!(load(&p), vec![entry("a", "c1")]);
    }
}
