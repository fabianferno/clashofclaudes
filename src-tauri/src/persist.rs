#![allow(dead_code)]

use crate::model::AppData;
use anyhow::Context;
use std::path::{Path, PathBuf};

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// Load app data. A missing file yields the default; an unparseable file is
/// copied to `<name>.bak` and the default is returned.
pub fn load(path: &Path) -> AppData {
    let Ok(text) = std::fs::read_to_string(path) else {
        if path.exists() {
            let _ = std::fs::copy(path, sibling(path, ".bak"));
        }
        return AppData::default();
    };
    match serde_json::from_str(&text) {
        Ok(data) => data,
        Err(_) => {
            let _ = std::fs::write(sibling(path, ".bak"), &text);
            AppData::default()
        }
    }
}

/// Atomically save: write `<name>.tmp`, then rename over the target.
pub fn save(path: &Path, data: &AppData) -> anyhow::Result<()> {
    let tmp = sibling(path, ".tmp");
    let json = serde_json::to_vec_pretty(data).context("serialize app data")?;
    std::fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

/// Recompute `missing` for every workspace from the filesystem.
pub fn mark_missing(data: &mut AppData) {
    for w in &mut data.workspaces {
        w.missing = !w.path.is_dir();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use std::path::PathBuf;

    fn sample() -> AppData {
        AppData {
            version: 1,
            workspaces: vec![Workspace {
                id: "w1".into(),
                name: "Café".into(),
                path: PathBuf::from("/tmp/my projéct dir"),
                created_at: 42,
                missing: false,
            }],
            builders: vec![Builder {
                id: "b1".into(),
                name: "Fast".into(),
                agent: AgentKind::Claude,
                model: Some("sonnet".into()),
                effort: None,
                custom_command: None,
            }],
        }
    }

    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        let saved = sample();
        save(&p, &saved).unwrap();
        assert_eq!(load(&p), saved);
    }

    #[test]
    fn missing_file_gives_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&dir.path().join("nope.json")), AppData::default());
    }

    #[test]
    fn corrupt_file_is_backed_up_and_default_returned() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        std::fs::write(&p, "{not json").unwrap();
        assert_eq!(load(&p), AppData::default());
        let bak = std::fs::read_to_string(dir.path().join("state.json.bak")).unwrap();
        assert_eq!(bak, "{not json");
    }

    #[test]
    fn load_marks_missing_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let mut data = sample();
        data.workspaces[0].path = dir.path().join("gone");
        mark_missing(&mut data);
        assert!(data.workspaces[0].missing);
        data.workspaces[0].path = dir.path().to_path_buf();
        mark_missing(&mut data);
        assert!(!data.workspaces[0].missing);
    }

    #[test]
    fn save_is_atomic_no_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        save(&p, &sample()).unwrap();
        assert!(p.exists());
        assert!(!dir.path().join("state.json.tmp").exists());
    }
}
