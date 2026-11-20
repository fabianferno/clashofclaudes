//! The raid report's log: work the owner accepted today (with the lines it changed) and how long
//! sessions waited on the owner. Kept in `raid.json` in the data folder, for the last week only;
//! never sent anywhere. The window asks for one day at a time (`raid_report`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::model::{AgentKind, SessionInfo};
use crate::queue::{queue_reason, waiting_since};

/// Entries older than this are dropped.
const KEEP_MS: i64 = 8 * 24 * 3600 * 1000;

/// A finished session the owner accepted.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ship {
    pub at: i64,
    pub workspace_id: String,
    pub builder_name: String,
    pub agent: AgentKind,
    /// The agent's name for the conversation, else the task's first line.
    pub title: Option<String>,
    /// Lines added and removed in the session's folder since it started (new files count as added).
    pub added: u32,
    pub removed: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    ships: Vec<Ship>,
    /// Spans (start, end ms) a session waited on the owner, one per wait.
    #[serde(default)]
    waits: Vec<(i64, i64)>,
}

/// One day's report.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RaidReport {
    pub ships: Vec<Ship>,
    /// Time sessions spent waiting on the owner in the span, added up over sessions (two waiting
    /// for ten minutes make twenty), ongoing waits included up to now.
    pub waited_ms: i64,
    /// Sessions waiting on the owner right now.
    pub waiting_now: u32,
}

pub struct RaidLog {
    path: Option<PathBuf>,
    file: File,
    /// Sessions waiting right now, since when.
    open: HashMap<String, i64>,
}

impl RaidLog {
    /// The log at `path` (empty when missing or unreadable).
    pub fn load(path: &Path) -> Self {
        let file = std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        RaidLog { path: Some(path.to_path_buf()), file, open: HashMap::new() }
    }

    /// A log that is never saved (tests).
    pub fn in_memory() -> Self {
        RaidLog { path: None, file: File::default(), open: HashMap::new() }
    }

    /// A session changed: a wait on the owner starts or ends.
    pub fn observe(&mut self, s: &SessionInfo, now: i64) {
        let waiting = queue_reason(s).is_some();
        match (waiting, self.open.contains_key(&s.id)) {
            (true, false) => {
                self.open.insert(s.id.clone(), waiting_since(s).clamp(now - KEEP_MS, now));
            }
            (false, true) => self.end(&s.id, now),
            _ => {}
        }
    }

    /// A session closed: its wait (if any) ends.
    pub fn removed(&mut self, id: &str, now: i64) {
        if self.open.contains_key(id) {
            self.end(id, now);
        }
    }

    fn end(&mut self, id: &str, now: i64) {
        if let Some(since) = self.open.remove(id)
            && now > since
        {
            self.file.waits.push((since, now));
            self.save(now);
        }
    }

    pub fn ship(&mut self, ship: Ship) {
        let now = ship.at;
        self.file.ships.push(ship);
        self.save(now);
    }

    fn save(&mut self, now: i64) {
        let cut = now - KEEP_MS;
        self.file.ships.retain(|s| s.at >= cut);
        self.file.waits.retain(|w| w.1 >= cut);
        let Some(path) = &self.path else { return };
        if let Ok(b) = serde_json::to_vec(&self.file) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, b).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }

    /// Every accepted session kept, as (workspace id, ms): seeds the activity houses (`persist::seed_ships`).
    pub fn ship_times(&self) -> Vec<(String, i64)> {
        self.file.ships.iter().map(|s| (s.workspace_id.clone(), s.at)).collect()
    }

    /// What happened between `from` and `to` (ms), as of `now`.
    pub fn report(&self, from: i64, to: i64, now: i64) -> RaidReport {
        let overlap = |a: i64, b: i64| (b.min(to) - a.max(from)).max(0);
        let closed: i64 = self.file.waits.iter().map(|&(a, b)| overlap(a, b)).sum();
        let ongoing: i64 = self.open.values().map(|&a| overlap(a, now)).sum();
        let mut ships: Vec<Ship> = self.file.ships.iter().filter(|s| s.at >= from && s.at < to).cloned().collect();
        ships.sort_by_key(|s| s.at);
        RaidReport { ships, waited_ms: closed + ongoing, waiting_now: self.open.len() as u32 }
    }
}

/// The log, shared by the session events and the commands.
pub struct RaidState(pub Mutex<RaidLog>);

impl RaidState {
    pub fn lock(&self) -> std::sync::MutexGuard<'_, RaidLog> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Writes an exported card into `dir` as "Raid report <day>.png" (a number added when that name is
/// taken); returns its path. Only a PNG is written.
pub fn save_card(dir: &Path, day: &str, png: &[u8]) -> anyhow::Result<PathBuf> {
    const MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !png.starts_with(MAGIC) {
        anyhow::bail!("not a PNG image");
    }
    // the day as the window wrote it, kept to a safe file name
    let day: String = day.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(20).collect();
    std::fs::create_dir_all(dir)?;
    let mut path = dir.join(format!("Raid report {day}.png"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("Raid report {day} {n}.png"));
        n += 1;
    }
    std::fs::write(&path, png)?;
    Ok(path)
}

/// Lines in a new file, for a session's lines changed: none for a binary or very large file.
pub fn count_lines(path: &Path) -> u32 {
    const MAX: u64 = 2 * 1024 * 1024;
    let Ok(meta) = std::fs::metadata(path) else { return 0 };
    if !meta.is_file() || meta.len() > MAX {
        return 0;
    }
    let Ok(bytes) = std::fs::read(path) else { return 0 };
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return 0;
    }
    let n = bytes.iter().filter(|&&b| b == b'\n').count();
    (n + usize::from(!bytes.is_empty() && !bytes.ends_with(b"\n"))) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SessionKind, SessionState};

    fn sess(id: &str, state: SessionState, since: i64) -> SessionInfo {
        let mut s: SessionInfo = serde_json::from_value(serde_json::json!({
            "id": id, "workspaceId": "w1", "kind": { "kind": "agent", "builderId": "b" }, "task": null,
            "state": { "kind": "working" }, "steps": 0, "startedAt": 0, "lastOutputAt": 0, "reachedFinished": false,
            "worktree": null, "commandPreview": "", "awaitingDecision": false, "busy": false, "rev": 1, "spot": null,
        }))
        .unwrap();
        s.state = state;
        s.state_since = since;
        s
    }

    const MIN: i64 = 60_000;

    #[test]
    fn waits_are_timed_from_when_the_session_stopped_until_it_moves_on() {
        let mut log = RaidLog::in_memory();
        let t0 = 10 * KEEP_MS;
        log.observe(&sess("a", SessionState::Working, t0), t0);
        log.observe(&sess("a", SessionState::Finished, t0 + MIN), t0 + MIN + 5);
        log.observe(&sess("a", SessionState::Working, t0 + 11 * MIN), t0 + 11 * MIN);
        assert_eq!(log.report(t0, t0 + 60 * MIN, t0 + 60 * MIN).waited_ms, 10 * MIN);
        // a second one still waiting counts up to now
        log.observe(&sess("b", SessionState::Stuck { reason: "x".into() }, t0 + 20 * MIN), t0 + 20 * MIN);
        let r = log.report(t0, t0 + 60 * MIN, t0 + 25 * MIN);
        assert_eq!(r.waited_ms, 15 * MIN);
        assert_eq!(r.waiting_now, 1);
        // closing it ends the wait
        log.removed("b", t0 + 30 * MIN);
        assert_eq!(log.report(t0, t0 + 60 * MIN, t0 + 60 * MIN).waited_ms, 20 * MIN);
    }

    #[test]
    fn a_day_counts_only_its_part_of_a_wait() {
        let mut log = RaidLog::in_memory();
        let t0 = 10 * KEEP_MS;
        log.observe(&sess("a", SessionState::Finished, t0), t0);
        log.observe(&sess("a", SessionState::Working, t0 + 10 * MIN), t0 + 10 * MIN);
        assert_eq!(log.report(t0 + 4 * MIN, t0 + 60 * MIN, t0 + 60 * MIN).waited_ms, 6 * MIN);
        assert_eq!(log.report(t0 + 20 * MIN, t0 + 60 * MIN, t0 + 60 * MIN).waited_ms, 0);
    }

    #[test]
    fn parked_and_terminal_sessions_do_not_wait_on_the_owner() {
        let mut log = RaidLog::in_memory();
        let mut parked = sess("a", SessionState::Finished, 0);
        parked.parked = Some(String::new());
        log.observe(&parked, 1000);
        let mut term = sess("t", SessionState::Finished, 0);
        term.kind = SessionKind::Terminal;
        log.observe(&term, 1000);
        assert_eq!(log.report(0, 2000, 2000).waiting_now, 0);
    }

    #[test]
    fn ships_are_reported_for_their_day_and_kept_on_disk_for_a_week() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("raid.json");
        let ship = |at: i64| Ship { at, workspace_id: "w1".into(), builder_name: "Pete".into(), agent: AgentKind::Claude, title: Some("Dark mode".into()), added: 40, removed: 3 };
        let day = 24 * 3600 * 1000;
        let t0 = 100 * day;
        {
            let mut log = RaidLog::load(&path);
            log.ship(ship(t0 - 9 * day)); // dropped on the next save
            log.ship(ship(t0 + 5));
            log.ship(ship(t0 + day + 5)); // tomorrow
        }
        let log = RaidLog::load(&path);
        let r = log.report(t0, t0 + day, t0 + day);
        assert_eq!(r.ships, vec![ship(t0 + 5)]);
        assert_eq!(log.file.ships.len(), 2);
    }

    #[test]
    fn a_card_is_saved_as_a_png_under_a_free_name() {
        let dir = tempfile::tempdir().unwrap();
        let png = b"\x89PNG\r\n\x1a\nrest";
        let a = save_card(dir.path(), "2026-11-20", png).unwrap();
        let b = save_card(dir.path(), "2026-11-20", png).unwrap();
        assert_eq!(a.file_name().unwrap(), "Raid report 2026-11-20.png");
        assert_eq!(b.file_name().unwrap(), "Raid report 2026-11-20 2.png");
        assert_eq!(std::fs::read(&a).unwrap(), png);
        assert!(save_card(dir.path(), "2026-11-20", b"<html>").is_err());
        let odd = save_card(dir.path(), "../../etc/x", png).unwrap();
        assert_eq!(odd.parent().unwrap(), dir.path());
    }

    #[test]
    fn new_files_count_their_lines_but_not_binaries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "one\ntwo\nthree").unwrap();
        std::fs::write(dir.path().join("b.ts"), "one\n").unwrap();
        std::fs::write(dir.path().join("c.png"), [0x89, b'P', 0, 0, b'\n']).unwrap();
        assert_eq!(count_lines(&dir.path().join("a.ts")), 3);
        assert_eq!(count_lines(&dir.path().join("b.ts")), 1);
        assert_eq!(count_lines(&dir.path().join("c.png")), 0);
        assert_eq!(count_lines(&dir.path().join("missing")), 0);
    }
}
