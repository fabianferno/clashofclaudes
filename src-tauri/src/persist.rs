#![allow(dead_code)]

use crate::model::{AppData, Workspace};
use std::time::{SystemTime, UNIX_EPOCH};

/// Ship timestamps older than this are dropped on save.
pub const SHIP_WINDOW_MS: i64 = 48 * 60 * 60 * 1000;
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
    match serde_json::from_str::<AppData>(&text) {
        Ok(mut data) => {
            // Older files get their village defaults from serde; the next save writes v2.
            data.version = data.version.max(2);
            data
        }
        Err(_) => {
            let _ = std::fs::write(sibling(path, ".bak"), &text);
            AppData::default()
        }
    }
}

/// Atomically save: write `<name>.tmp`, then rename over the target.
pub fn save(path: &Path, data: &AppData) -> anyhow::Result<()> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    save_at(path, data, now)
}

/// `save` with an explicit "now": ship times older than 48 h before it are not written.
pub fn save_at(path: &Path, data: &AppData, now_ms: i64) -> anyhow::Result<()> {
    let mut data = data.clone();
    data.stats.recent_ships.retain(|t| now_ms - t <= SHIP_WINDOW_MS);
    let tmp = sibling(path, ".tmp");
    let json = serde_json::to_vec_pretty(&data).context("serialize app data")?;
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

/// Applies freshly checked `missing` flags (workspace id, missing) during a run; returns the
/// workspaces whose flag changed (to save and send). Ids no longer present are ignored.
pub fn apply_missing(data: &mut AppData, checked: &[(String, bool)]) -> Vec<Workspace> {
    let mut changed = Vec::new();
    for w in &mut data.workspaces {
        let Some(&(_, missing)) = checked.iter().find(|(id, _)| *id == w.id) else { continue };
        if missing != w.missing {
            w.missing = missing;
            changed.push(w.clone());
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use std::path::PathBuf;

    fn sample() -> AppData {
        AppData {
            version: 2,
            stats: Stats::default(),
            settings: Settings::default(),
            collector_spots: [(AgentKind::Codex, Tile { x: 9, y: -3 })].into(),
            workspaces: vec![Workspace {
                id: "w1".into(),
                name: "Café".into(),
                path: PathBuf::from("/tmp/my projéct dir"),
                created_at: 42,
                missing: false,
                level: 1,
                xp: 0,
                compound: None,
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
    fn apply_missing_reports_only_changes_both_ways() {
        let mut data = AppData::default();
        data.workspaces.push(Workspace { id: "w".into(), name: "w".into(), path: "/nope".into(), created_at: 0, missing: false, level: 1, xp: 0, compound: None });
        let gone = apply_missing(&mut data, &[("w".into(), true), ("removed".into(), true)]);
        assert_eq!(gone.len(), 1);
        assert!(gone[0].missing && data.workspaces[0].missing);
        assert!(apply_missing(&mut data, &[("w".into(), true)]).is_empty(), "unchanged: nothing to send");
        assert!(apply_missing(&mut data, &[]).is_empty(), "unchecked: left alone");
        let back = apply_missing(&mut data, &[("w".into(), false)]);
        assert_eq!(back.len(), 1);
        assert!(!back[0].missing && !data.workspaces[0].missing);
    }

    #[test]
    fn save_is_atomic_no_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        save(&p, &sample()).unwrap();
        assert!(p.exists());
        assert!(!dir.path().join("state.json.tmp").exists());
    }

    #[test]
    fn load_v1_state_gets_village_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        std::fs::write(&p, r#"{"version":1,"workspaces":[{"id":"w1","name":"a","path":"/tmp","createdAt":1}],"builders":[]}"#).unwrap();
        let d = load(&p);
        let w = &d.workspaces[0];
        assert_eq!((w.level, w.xp, w.compound.clone()), (1, 0, None));
        assert_eq!(d.stats, Stats::default());
        assert!(d.settings.updates_enabled, "old files default to updates on");
        save(&p, &d).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["version"], 2);
    }

    #[test]
    fn recent_ships_pruned_to_48h() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        let now = 1_000_000_000_000i64;
        let h = 3_600_000i64;
        let mut d = sample();
        d.stats = Stats { shipped_total: 3, recent_ships: vec![now - 49 * h, now - 47 * h, now] };
        save_at(&p, &d, now).unwrap();
        let back = load(&p);
        assert_eq!(back.stats.recent_ships, vec![now - 47 * h, now]);
        assert_eq!(back.stats.shipped_total, 3);
    }

    #[test]
    fn compound_is_persisted_in_camel_case() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        let mut d = sample();
        d.workspaces[0].compound = Some(Compound { x0: 1, y0: 2, w: 8, h: 6, house: Tile { x: 3, y: 4 } });
        save(&p, &d).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("\"house\""));
        assert!(!text.contains("spot"), "session spots are not persisted");
        assert_eq!(load(&p), d);
    }
}
