//! Agent quota ("elixir"): what each provider says is left, in one shape.
//!
//! Sources (read only; see docs/superpowers/specs/2026-11-01-quota-collectors-design.md):
//!   * Claude Code pipes JSON to the status-line command; app-launched sessions post it to the
//!     hook server. `rate_limits.<window>.used_percentage` (0-100) and `resets_at` (epoch seconds
//!     on some versions, ISO-8601 on others); any window may be absent.
//!   * Codex writes `token_count` events carrying `rate_limits.{primary,secondary}` into
//!     `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
//!   * Antigravity answers `agy -p /usage` locally: `group \t label \t NN% \t ISO reset` rows of
//!     what is *left*.
use crate::model::AgentKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    /// Stable within an agent, e.g. `five_hour` or `gemini-models:five-hour`.
    pub id: String,
    pub label: String,
    /// Model group the window applies to (Antigravity), if any.
    pub group: Option<String>,
    /// Percent left, 0-100.
    pub left_pct: f64,
    /// Epoch ms; past means the window has refilled.
    pub resets_at: Option<i64>,
    pub window_mins: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuota {
    pub agent: AgentKind,
    pub windows: Vec<QuotaWindow>,
    /// Epoch ms of the reading.
    pub updated_at: i64,
    /// Where the reading came from, for the panel.
    pub source: String,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn clamp_pct(p: f64) -> f64 {
    p.clamp(0.0, 100.0)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-MM-DDTHH:MM:SS[.frac][Z|±HH:MM]` to epoch ms; no zone means UTC.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    if s.len() < 19 || !matches!(s.as_bytes()[10], b'T' | b't' | b' ') {
        return None;
    }
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut ms = 0i64;
    if let Some(r) = rest.strip_prefix('.') {
        let digits: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
        let padded = format!("{:0<3}", &digits[..digits.len().min(3)]);
        ms = padded.parse().ok()?;
        rest = &r[digits.len()..];
    }
    let offset_min = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let hh: i64 = rest.get(1..3)?.parse().ok()?;
            let mm: i64 = rest.get(rest.len() - 2..)?.parse().ok()?;
            sign * (hh * 60 + mm)
        }
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - offset_min * 60;
    Some(secs * 1000 + ms)
}

/// Epoch seconds (number or numeric string) or an ISO-8601 string, to epoch ms.
fn time_ms(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_f64().map(|s| (s * 1000.0) as i64),
        Value::String(s) => s.trim().parse::<f64>().ok().map(|s| (s * 1000.0) as i64).or_else(|| parse_iso_ms(s)),
        _ => None,
    }
}

/// Claude's status-line windows: (key, label, window minutes). Unknown `seven_day_*` keys are
/// shown too, named after their suffix.
const CLAUDE_WINDOWS: [(&str, &str, u32); 4] = [
    ("five_hour", "5-hour limit", 300),
    ("seven_day", "Weekly limit", 10_080),
    ("seven_day_opus", "Weekly Opus limit", 10_080),
    ("seven_day_sonnet", "Weekly Sonnet limit", 10_080),
];

/// Windows from a Claude status-line payload; None when it carries no usable `rate_limits`.
pub fn parse_claude_status(body: &Value) -> Option<Vec<QuotaWindow>> {
    let rl = body.get("rate_limits")?.as_object()?;
    let mut out = Vec::new();
    for (key, w) in rl {
        let Some(used) = w.get("used_percentage").and_then(Value::as_f64) else { continue };
        let known = CLAUDE_WINDOWS.iter().find(|(k, ..)| k == key);
        let (label, mins) = match known {
            Some((_, l, m)) => (l.to_string(), Some(*m)),
            None if key.starts_with("seven_day_") => {
                let name = key["seven_day_".len()..].replace('_', " ");
                (format!("Weekly {name} limit"), Some(10_080))
            }
            None => continue, // spend limits and the like are not windows
        };
        out.push(QuotaWindow {
            id: key.clone(),
            label,
            group: None,
            left_pct: clamp_pct(100.0 - used),
            resets_at: w.get("resets_at").and_then(time_ms),
            window_mins: mins,
        });
    }
    let order = |id: &str| CLAUDE_WINDOWS.iter().position(|(k, ..)| *k == id).unwrap_or(CLAUDE_WINDOWS.len());
    out.sort_by_key(|w| order(&w.id));
    (!out.is_empty()).then_some(out)
}

fn window_label(mins: Option<u32>) -> String {
    match mins {
        Some(300) => "5-hour limit".into(),
        Some(10_080) => "Weekly limit".into(),
        Some(m) if m >= 40_000 => "Monthly limit".into(),
        Some(m) if m % 1440 == 0 => format!("{}-day limit", m / 1440),
        Some(m) if m % 60 == 0 => format!("{}-hour limit", m / 60),
        Some(m) => format!("{m}-minute limit"),
        None => "Limit".into(),
    }
}

/// Windows from one Codex rollout line; None unless it carries `rate_limits`.
pub fn parse_codex_line(line: &str) -> Option<Vec<QuotaWindow>> {
    if !line.contains("\"rate_limits\"") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let rl = v.pointer("/payload/rate_limits").or_else(|| v.get("rate_limits"))?;
    let at = v.get("timestamp").and_then(time_ms);
    let mut out = Vec::new();
    for slot in ["primary", "secondary"] {
        let Some(w) = rl.get(slot).filter(|w| w.is_object()) else { continue };
        let Some(used) = w.get("used_percent").and_then(Value::as_f64) else { continue };
        let mins = w.get("window_minutes").and_then(Value::as_u64).map(|m| m as u32);
        let resets_at = w.get("resets_at").and_then(time_ms).or_else(|| {
            let secs = w.get("resets_in_seconds").and_then(Value::as_f64)?;
            Some(at? + (secs * 1000.0) as i64)
        });
        out.push(QuotaWindow { id: slot.into(), label: window_label(mins), group: None, left_pct: clamp_pct(100.0 - used), resets_at, window_mins: mins });
    }
    (!out.is_empty()).then_some(out)
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// Windows from `agy -p /usage` output; None when no row parses.
pub fn parse_agy_usage(text: &str) -> Option<Vec<QuotaWindow>> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split('\t').map(str::trim).collect();
        if cols.len() < 4 {
            continue;
        }
        let Some(left) = cols[2].strip_suffix('%').and_then(|p| p.trim().parse::<f64>().ok()) else { continue };
        let (group, raw) = (cols[0], cols[1]);
        let lower = raw.to_ascii_lowercase();
        let mins = if lower.contains("five hour") || lower.contains("5 hour") {
            Some(300)
        } else if lower.contains("weekly") {
            Some(10_080)
        } else if lower.contains("daily") {
            Some(1440)
        } else {
            None
        };
        // "Weekly Limit Remaining" -> "Weekly limit"; "Gemini 4 Argon Weekly Limit" keeps the model.
        let label = raw.replace(" Remaining", "").replace("Five Hour", "5-hour").replace(" Limit", " limit");
        out.push(QuotaWindow {
            id: format!("{}:{}", slug(group), slug(&label)),
            label,
            group: Some(group.to_string()),
            left_pct: clamp_pct(left),
            resets_at: parse_iso_ms(cols[3]),
            window_mins: mins,
        });
    }
    (!out.is_empty()).then_some(out)
}

/// The most recently modified `rollout-*.jsonl` under `root` (Codex's sessions dir).
pub fn latest_codex_rollout(root: &Path) -> Option<PathBuf> {
    fn walk(dir: &Path, depth: u8, best: &mut Option<(SystemTime, PathBuf)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() && depth < 4 {
                walk(&p, depth + 1, best);
            } else if ft.is_file() {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) {
                    continue;
                }
                let Ok(m) = e.metadata().and_then(|m| m.modified()) else { continue };
                if best.as_ref().is_none_or(|(t, _)| m > *t) {
                    *best = Some((m, p));
                }
            }
        }
    }
    let mut best = None;
    walk(root, 0, &mut best);
    best.map(|(_, p)| p)
}

/// The last rate-limit reading in a Codex rollout file, with when Codex wrote it (epoch ms).
pub fn read_codex_rollout(path: &Path) -> Option<(Vec<QuotaWindow>, Option<i64>)> {
    let text = std::fs::read_to_string(path).ok()?;
    text.lines().rev().find_map(|l| {
        let w = parse_codex_line(l)?;
        let at = serde_json::from_str::<Value>(l).ok().and_then(|v| v.get("timestamp").and_then(time_ms));
        Some((w, at))
    })
}

/// Runs `agy -p /usage` in `cwd` and parses it; None on a missing binary, error or timeout.
pub fn read_agy_usage(cwd: &Path, timeout: Duration) -> Option<Vec<QuotaWindow>> {
    use std::process::{Command, Stdio};
    let mut child = Command::new("agy")
        .args(["-p", "/usage"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    parse_agy_usage(&reader.join().ok()?)
}

pub type QuotaEmit = Arc<dyn Fn(&AgentQuota) + Send + Sync>;

/// Latest reading per agent, persisted to `quota.json` in the app's data dir.
pub struct QuotaStore {
    path: PathBuf,
    map: Mutex<HashMap<String, AgentQuota>>,
    emit: QuotaEmit,
}

fn key(a: &AgentKind) -> String {
    serde_json::to_value(a).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

impl QuotaStore {
    pub fn new(path: PathBuf, emit: QuotaEmit) -> QuotaStore {
        let saved: Vec<AgentQuota> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let map = saved.into_iter().map(|q| (key(&q.agent), q)).collect();
        QuotaStore { path, map: Mutex::new(map), emit }
    }

    pub fn all(&self) -> Vec<AgentQuota> {
        let mut v: Vec<AgentQuota> = self.map.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
        v.sort_by_key(|q| key(&q.agent));
        v
    }

    /// Stores a reading taken at `at` (epoch ms; None: now). Emits and persists only when it
    /// changed (the status line posts several times a second while Claude streams).
    pub fn set(&self, agent: AgentKind, windows: Vec<QuotaWindow>, source: &str, at: Option<i64>) {
        self.store(agent, windows, source, at, false);
    }

    /// Like `set`, but keeps earlier windows missing from this reading once their reset time has
    /// passed: Claude drops a window from its status JSON when it resets, and a reset window is a
    /// full one (the tank must not switch to the weekly window at every 5-hour reset).
    pub fn set_keeping_reset(&self, agent: AgentKind, windows: Vec<QuotaWindow>, source: &str) {
        self.store(agent, windows, source, None, true);
    }

    fn store(&self, agent: AgentKind, mut windows: Vec<QuotaWindow>, source: &str, at: Option<i64>, keep_reset: bool) {
        let now = now_ms();
        let mut m = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let k = key(&agent);
        if keep_reset && let Some(old) = m.get(&k) {
            for w in &old.windows {
                if w.resets_at.is_some_and(|r| r <= now) && !windows.iter().any(|n| n.id == w.id) {
                    windows.push(w.clone());
                }
            }
        }
        let q = AgentQuota { agent, windows, updated_at: at.unwrap_or(now), source: source.into() };
        let same = m.get(&k).is_some_and(|old| {
            old.windows == q.windows && if at.is_some() { old.updated_at == q.updated_at } else { q.updated_at - old.updated_at < 60_000 }
        });
        if same {
            return;
        }
        m.insert(k, q.clone());
        let mut all: Vec<AgentQuota> = m.values().cloned().collect();
        all.sort_by_key(|q| key(&q.agent));
        // Written under the lock: the hook server and the poller both store readings.
        if let Ok(bytes) = serde_json::to_vec_pretty(&all) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
        drop(m);
        (self.emit)(&q);
    }
}

/// Codex's sessions dir: `$CODEX_HOME/sessions`, else `~/.codex/sessions`.
pub fn codex_sessions_dir() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")))
        .map(|d| d.join("sessions"))
}

pub const CODEX_EVERY: Duration = Duration::from_secs(60);
pub const AGY_EVERY: Duration = Duration::from_secs(300);
const AGY_TIMEOUT: Duration = Duration::from_secs(20);

/// Polls the file and process sources (Claude's readings arrive through the hook server).
pub struct Poller {
    store: Arc<QuotaStore>,
    /// `agy` runs here so it never touches a project folder.
    cwd: PathBuf,
    codex_dir: Option<PathBuf>,
    agy_installed: Box<dyn Fn() -> bool + Send + Sync>,
    last: Mutex<PollMarks>,
}

#[derive(Default)]
struct PollMarks {
    codex_file: Option<(PathBuf, SystemTime)>,
    agy_at: Option<std::time::Instant>,
}

impl Poller {
    pub fn new(store: Arc<QuotaStore>, cwd: PathBuf, codex_dir: Option<PathBuf>, agy_installed: Box<dyn Fn() -> bool + Send + Sync>) -> Poller {
        Poller { store, cwd, codex_dir, agy_installed, last: Mutex::default() }
    }

    /// Reads Codex when its newest rollout changed (or `force`), and agy when due (or `force`).
    pub fn poll(&self, force: bool) {
        if let Some(path) = self.codex_dir.as_deref().and_then(latest_codex_rollout) {
            let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
            let mark = mtime.map(|t| (path.clone(), t));
            let changed = { self.last.lock().unwrap_or_else(|e| e.into_inner()).codex_file != mark };
            if (changed || force)
                && let Some((w, at)) = read_codex_rollout(&path)
            {
                self.store.set(AgentKind::Codex, w, "Codex session log", at);
                self.last.lock().unwrap_or_else(|e| e.into_inner()).codex_file = mark;
            }
        }
        let due = {
            let mut l = self.last.lock().unwrap_or_else(|e| e.into_inner());
            let due = force || l.agy_at.is_none_or(|t| t.elapsed() >= AGY_EVERY);
            if due {
                l.agy_at = Some(std::time::Instant::now());
            }
            due
        };
        if due
            && (self.agy_installed)()
            && let Some(w) = read_agy_usage(&self.cwd, AGY_TIMEOUT)
        {
            self.store.set(AgentKind::Antigravity, w, "agy /usage", None);
        }
    }

    /// Polls forever on a background thread.
    pub fn spawn(self: Arc<Self>) {
        std::thread::spawn(move || loop {
            self.poll(false);
            std::thread::sleep(CODEX_EVERY);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Captured from agy 1.4.12 on 2026-10-31.
    const AGY: &str = "Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-07T05:56:55Z\n\
Gemini Models\tFive Hour Limit Remaining\t100%\t2026-10-31T21:00:11Z\n\
Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-07T16:00:11Z\n\
Claude and GPT models\tFive Hour Limit Remaining\t37%\t2026-10-31T21:00:11Z\n\
Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-07T16:00:11Z\n";

    #[test]
    fn iso_times_parse_with_zones_and_fractions() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-10-31T21:00:11Z"), Some(1_793_480_411_000));
        assert_eq!(parse_iso_ms("2026-10-31T21:00:11.5Z"), Some(1_793_480_411_500));
        assert_eq!(parse_iso_ms("2026-10-31T23:00:11+02:00"), Some(1_793_480_411_000));
        assert_eq!(parse_iso_ms("not a date"), None);
    }

    #[test]
    fn claude_status_reads_epoch_and_iso_resets() {
        let body = json!({ "session_id": "x", "rate_limits": {
            "five_hour": { "used_percentage": 38, "resets_at": 1_793_480_411 },
            "seven_day": { "used_percentage": 12.5, "resets_at": "2026-11-07T16:00:11Z" },
            "spend_limit": { "used_percentage": 3, "limit_usd": 50 },
        }});
        let w = parse_claude_status(&body).unwrap();
        assert_eq!(w.len(), 2, "spend limits are not windows");
        assert_eq!((w[0].id.as_str(), w[0].left_pct, w[0].resets_at, w[0].window_mins), ("five_hour", 62.0, Some(1_793_480_411_000), Some(300)));
        assert_eq!((w[1].label.as_str(), w[1].left_pct, w[1].resets_at), ("Weekly limit", 87.5, Some(1_794_067_211_000)));
    }

    #[test]
    fn claude_status_keeps_the_windows_it_has() {
        let only_week = json!({ "rate_limits": { "seven_day": { "used_percentage": 40 }, "seven_day_omelette": { "used_percentage": 1 } } });
        let w = parse_claude_status(&only_week).unwrap();
        assert_eq!(w.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["seven_day", "seven_day_omelette"]);
        assert_eq!(w[0].resets_at, None);
        assert_eq!(w[1].label, "Weekly omelette limit");
        assert_eq!(parse_claude_status(&json!({ "model": {} })), None);
        assert_eq!(parse_claude_status(&json!({ "rate_limits": {} })), None);
    }

    #[test]
    fn codex_lines_read_primary_and_secondary() {
        let line = r#"{"timestamp":"2026-08-17T10:52:51.096Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":95.0,"window_minutes":300,"resets_at":1789555965},"secondary":{"used_percent":20.0,"window_minutes":10080,"resets_in_seconds":60},"credits":null}}}"#;
        let w = parse_codex_line(line).unwrap();
        assert_eq!((w[0].label.as_str(), w[0].left_pct, w[0].resets_at), ("5-hour limit", 5.0, Some(1_789_555_965_000)));
        let at = parse_iso_ms("2026-08-17T10:52:51.096Z").unwrap();
        assert_eq!((w[1].label.as_str(), w[1].left_pct, w[1].resets_at), ("Weekly limit", 80.0, Some(at + 60_000)));
        let monthly = r#"{"payload":{"rate_limits":{"primary":{"used_percent":0.0,"window_minutes":43200,"resets_at":1},"secondary":null}}}"#;
        assert_eq!(parse_codex_line(monthly).unwrap()[0].label, "Monthly limit");
        assert_eq!(parse_codex_line(r#"{"payload":{"type":"agent_message"}}"#), None);
    }

    #[test]
    fn agy_usage_parses_groups_and_ignores_noise() {
        let w = parse_agy_usage(&format!("Fetching...\n{AGY}some error\n")).unwrap();
        assert_eq!(w.len(), 5);
        let five = &w[3];
        assert_eq!(five.group.as_deref(), Some("Claude and GPT models"));
        assert_eq!((five.label.as_str(), five.left_pct, five.window_mins), ("5-hour limit", 37.0, Some(300)));
        assert_eq!(five.id, "claude-and-gpt-models:5-hour-limit");
        assert_eq!(five.resets_at, parse_iso_ms("2026-10-31T21:00:11Z"));
        assert_eq!((w[4].label.as_str(), w[4].window_mins), ("Gemini 4 Argon Weekly limit", Some(10_080)));
        assert_eq!(parse_agy_usage("agy: not signed in\n"), None);
    }

    #[test]
    fn latest_rollout_is_the_newest_file_and_its_last_reading_wins() {
        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("2026/08/17");
        std::fs::create_dir_all(&day).unwrap();
        let old = day.join("rollout-a.jsonl");
        std::fs::write(&old, "{}\n").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        let new = day.join("rollout-b.jsonl");
        let l = |u: f64| format!(r#"{{"payload":{{"rate_limits":{{"primary":{{"used_percent":{u},"window_minutes":300}}}}}}}}"#);
        std::fs::write(&new, format!("{}\n{}\n{{\"payload\":{{}}}}\n", l(10.0), l(30.0))).unwrap();
        std::fs::write(day.join("notes.txt"), "x").unwrap();
        assert_eq!(latest_codex_rollout(dir.path()), Some(new.clone()));
        assert_eq!(read_codex_rollout(&new).unwrap().0[0].left_pct, 70.0);
    }

    #[test]
    fn poller_reads_codex_once_per_change_and_skips_agy_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions/2026/11/01");
        std::fs::create_dir_all(&sessions).unwrap();
        let line = r#"{"payload":{"rate_limits":{"primary":{"used_percent":25,"window_minutes":300}}}}"#;
        std::fs::write(sessions.join("rollout-x.jsonl"), format!("{line}\n")).unwrap();
        let hits = Arc::new(Mutex::new(0));
        let h = hits.clone();
        let store = Arc::new(QuotaStore::new(dir.path().join("quota.json"), Arc::new(move |_| *h.lock().unwrap() += 1)));
        let asked = Arc::new(Mutex::new(0));
        let a = asked.clone();
        let p = Poller::new(store.clone(), dir.path().into(), Some(dir.path().join("sessions")), Box::new(move || {
            *a.lock().unwrap() += 1;
            false
        }));
        p.poll(false);
        p.poll(false);
        assert_eq!(*hits.lock().unwrap(), 1);
        assert_eq!(store.all()[0].windows[0].left_pct, 75.0);
        assert_eq!(*asked.lock().unwrap(), 1, "agy is checked once per 5 minutes");
        p.poll(true);
        assert_eq!(*asked.lock().unwrap(), 2, "a refresh checks agy now");
    }

    #[test]
    fn codex_readings_keep_the_time_codex_wrote_them() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("rollout-a.jsonl");
        std::fs::write(&f, r#"{"timestamp":"2026-08-17T10:52:51.096Z","payload":{"rate_limits":{"primary":{"used_percent":5,"window_minutes":300}}}}"#).unwrap();
        let (w, at) = read_codex_rollout(&f).unwrap();
        assert_eq!(at, parse_iso_ms("2026-08-17T10:52:51.096Z"));
        let hits = Arc::new(Mutex::new(0));
        let h = hits.clone();
        let store = QuotaStore::new(dir.path().join("quota.json"), Arc::new(move |_| *h.lock().unwrap() += 1));
        store.set(AgentKind::Codex, w.clone(), "codex", at);
        store.set(AgentKind::Codex, w, "codex", at); // re-read after a restart: same reading
        assert_eq!(*hits.lock().unwrap(), 1);
        assert_eq!(store.all()[0].updated_at, at.unwrap());
    }

    #[test]
    fn claude_keeps_a_reset_window_it_stopped_reporting() {
        let dir = tempfile::tempdir().unwrap();
        let store = QuotaStore::new(dir.path().join("quota.json"), Arc::new(|_| {}));
        let w = |id: &str, left: f64, resets_at: i64| QuotaWindow { id: id.into(), label: id.into(), group: None, left_pct: left, resets_at: Some(resets_at), window_mins: None };
        let past = now_ms() - 1000;
        let later = now_ms() + 3_600_000;
        store.set_keeping_reset(AgentKind::Claude, vec![w("five_hour", 3.0, past), w("seven_day", 80.0, later)], "claude");
        store.set_keeping_reset(AgentKind::Claude, vec![w("seven_day", 79.0, later)], "claude");
        let ids: Vec<String> = store.all()[0].windows.iter().map(|w| w.id.clone()).collect();
        assert_eq!(ids, ["seven_day", "five_hour"], "the reset 5-hour window stays (it reads as full)");
        // a window that has not reset yet and goes missing is dropped
        store.set_keeping_reset(AgentKind::Claude, vec![w("five_hour", 50.0, later)], "claude");
        assert_eq!(store.all()[0].windows.len(), 1);
    }

    #[test]
    fn store_persists_and_skips_repeats() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("quota.json");
        let hits = Arc::new(Mutex::new(0));
        let h = hits.clone();
        let store = QuotaStore::new(path.clone(), Arc::new(move |_| *h.lock().unwrap() += 1));
        let w = parse_agy_usage(AGY).unwrap();
        store.set(AgentKind::Antigravity, w.clone(), "agy", None);
        store.set(AgentKind::Antigravity, w.clone(), "agy", None);
        assert_eq!(*hits.lock().unwrap(), 1, "an unchanged reading is not re-emitted");
        let again = QuotaStore::new(path, Arc::new(|_| {}));
        assert_eq!(again.all().len(), 1);
        assert_eq!(again.all()[0].windows, w);
    }
}
