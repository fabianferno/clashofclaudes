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

/// Data files before version 3 had XP levels: each workspace's ships are seeded, once, from the
/// raid report's log (`(workspace id, ms)`, the last 8 days), within `activity::KEEP_MS` of `now`.
/// Returns whether it changed `data` (to save).
pub fn seed_ships(data: &mut AppData, raid: &[(String, i64)], now: i64) -> bool {
    if data.version >= 3 {
        return false;
    }
    for w in &mut data.workspaces {
        let mut ships: Vec<i64> = raid.iter().filter(|(id, at)| *id == w.id && now - at < crate::activity::KEEP_MS).map(|(_, at)| *at).collect();
        ships.sort_unstable();
        w.ships = ships;
    }
    data.version = 3;
    true
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
            mini_window: Some(crate::model::MiniWindow { x: -300.5, y: 16.0, w: 360.0, h: 240.0, open: true }),
            todos: vec![Todo { id: "t1".into(), workspace_id: "w1".into(), text: "Fix the login page".into(), images: vec![], created_at: 7, auto: false, builder_id: None, worktree: false }],
            workspaces: vec![Workspace {
                id: "w1".into(),
                name: "Café".into(),
                path: PathBuf::from("/tmp/my projéct dir"),
                created_at: 42,
                missing: false,
                ships: vec![],
                compound: None,
                color: Some("#3fa34d".into()),
                notes: "Add export later\nLook at the flaky test".into(),
                board_shared: false,
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
        data.workspaces.push(Workspace { id: "w".into(), name: "w".into(), path: "/nope".into(), created_at: 0, missing: false, ships: vec![], compound: None, color: None, notes: String::new(), board_shared: false });
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
    fn settings_saved_before_the_notification_toggles_keep_updates_off() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        std::fs::write(&p, r#"{"version":2,"workspaces":[],"builders":[],"settings":{"updatesEnabled":false}}"#).unwrap();
        let s = load(&p).settings;
        assert!(!s.updates_enabled && s.notify_needs_you && s.notify_finished && s.dock_badge);
        assert_eq!((s.player_name, s.onboarded), (None, false), "files from before onboarding get the welcome");
        assert!(!s.spots_tidied, "villages from before padding get spaced out once");
        assert_eq!(s.spots_tidy, 0, "and tidied again to the newest spacing rules");
    }

    #[test]
    fn player_name_and_onboarded_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        let mut d = sample();
        d.settings.player_name = Some("Fabian".into());
        d.settings.onboarded = true;
        save(&p, &d).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!((v["settings"]["playerName"].as_str(), v["settings"]["onboarded"].as_bool()), (Some("Fabian"), Some(true)));
        let s = load(&p).settings;
        assert_eq!((s.player_name.as_deref(), s.onboarded), (Some("Fabian"), true));
    }

    #[test]
    fn load_v1_state_gets_village_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        std::fs::write(&p, r#"{"version":1,"workspaces":[{"id":"w1","name":"a","path":"/tmp","createdAt":1}],"builders":[]}"#).unwrap();
        let d = load(&p);
        let w = &d.workspaces[0];
        assert_eq!((w.ships.clone(), w.compound.clone()), (vec![], None));
        assert_eq!(d.stats, Stats::default());
        assert!(d.settings.updates_enabled, "old files default to updates on");
        assert_eq!(d.settings, Settings::default(), "and to notifications and the Dock badge on");
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
        assert!(!text.contains("\"spot\""), "session spots are saved with the sessions (sessions.json)");
        assert_eq!(load(&p), d);
    }

    fn v2_village() -> AppData {
        let w = |id: &str| Workspace { id: id.into(), name: id.into(), path: PathBuf::from("/nope"), created_at: 0, missing: false, ships: vec![], compound: None, color: None, notes: String::new(), board_shared: false };
        AppData { version: 2, workspaces: vec![w("w1"), w("w2")], ..AppData::default() }
    }

    #[test]
    fn seed_ships_from_raid() {
        let mut d = v2_village();
        let raid = vec![("w1".to_string(), 6), ("w1".to_string(), 5), ("gone".to_string(), 7)];
        assert!(seed_ships(&mut d, &raid, 10));
        assert_eq!((d.workspaces[0].ships.clone(), d.workspaces[1].ships.clone(), d.version), (vec![5, 6], vec![], 3));
    }

    #[test]
    fn seed_runs_only_below_version_3() {
        let mut d = v2_village();
        d.version = 3;
        d.workspaces[0].ships = vec![5];
        assert!(!seed_ships(&mut d, &[("w1".to_string(), 6)], 10));
        assert_eq!(d.workspaces[0].ships, vec![5]);
    }

    #[test]
    fn seed_with_no_raid_ships_still_bumps_version() {
        let mut d = v2_village();
        assert!(seed_ships(&mut d, &[], 10));
        assert_eq!((d.version, d.workspaces[0].ships.clone()), (3, vec![]));
    }

    #[test]
    fn seed_skips_raid_ships_past_the_keep_window() {
        let mut d = v2_village();
        let now = crate::activity::KEEP_MS + 100;
        assert!(seed_ships(&mut d, &[("w1".to_string(), 50), ("w1".to_string(), 200)], now));
        assert_eq!(d.workspaces[0].ships, vec![200]);
    }
}
