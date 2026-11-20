//! Hears what happens in the village on the board: one long-running `vercel board tail`, read
//! line by line, on its own thread. Nothing waits on it. The phone remote's actions and pairing
//! requests arrive this way (`remote_app.rs` decides what they mean).
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::cli::{BoardCli, CliError, Target};

/// With nothing heard for this long the child is restarted: the Mac's own heartbeat (every 5
/// minutes) shows up on its tail, so silence means a dead connection (sleep, a network change).
pub const SILENCE: Duration = Duration::from_secs(7 * 60);
const RETRY_FIRST_MS: u64 = 2_000;
const RETRY_MAX_MS: u64 = 300_000;

/// One event of the board's log, as far as the app reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub cursor: String,
    /// `message.posted`, `labels.changed`, …
    pub kind: String,
    /// The message it concerns; empty when it concerns none.
    pub id: String,
    /// The root of that message's thread (itself, for a root).
    pub thread_root: Option<String>,
    pub channel: String,
    pub text: String,
    pub labels: BTreeMap<String, String>,
    /// Who wrote the message, as the board verified it: `vercel:user:…` or `vercel:project:…`.
    pub principal: String,
    pub profile: Option<String>,
    /// Written with a person's login (possibly by one of their agents).
    pub person: bool,
    /// The author's handle on the board: `ada`, or `ada/village` for one of ada's profiles.
    pub handle: String,
}

impl Event {
    /// Whether the message was written with `owner`'s own login: by them or one of their profiles.
    pub fn by_owner(&self, owner: &str) -> bool {
        self.person && (self.handle == owner || self.handle.strip_prefix(owner).is_some_and(|rest| rest.starts_with('/')))
    }
}

/// One line of `vercel board tail --json`; None for anything else the CLI prints.
pub fn parse(line: &str) -> Option<Event> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let cursor = v.get("cursor")?.as_str()?.to_string();
    let kind = v.get("type")?.as_str()?.to_string();
    let m = v.get("message").filter(|m| m.is_object());
    let s = |k: &str| m.and_then(|m| m.get(k)).and_then(Value::as_str).unwrap_or_default().to_string();
    let id = s("id");
    let re = m.and_then(|m| m.get("re")).and_then(Value::as_str).map(str::to_string);
    let by = |k: &str| m.and_then(|m| m.get("by")).and_then(|b| b.get(k)).and_then(Value::as_str).map(str::to_string);
    let principal = by("principal").unwrap_or_default();
    let labels = m
        .and_then(|m| m.get("labels"))
        .and_then(Value::as_object)
        .map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
        .unwrap_or_default();
    Some(Event {
        cursor,
        kind,
        thread_root: re.or_else(|| (!id.is_empty()).then(|| id.clone())),
        channel: s("channel"),
        text: s("text"),
        labels,
        person: principal.starts_with("vercel:user:"),
        handle: m.and_then(|m| m.get("author")).and_then(|a| a.get("handle")).and_then(Value::as_str).unwrap_or_default().to_string(),
        profile: by("profile"),
        principal,
        id,
    })
}

/// Whose village to follow, and on which board.
#[derive(Clone, Debug, PartialEq)]
pub struct Following {
    pub target: Target,
    /// The owner's Vercel username.
    pub owner: String,
}

impl Following {
    /// One place per board: the listener follows every village the login may read there.
    fn key(&self) -> String {
        self.target.key()
    }
}

/// `vercel board tail` for every village the login may read (its own, and the ones it was
/// invited to), from `after` on (None: from the newest event).
pub fn tail_args(after: Option<&str>, t: &Target) -> Vec<String> {
    let mut a = vec!["board".to_string(), "tail".to_string(), "v/".to_string()];
    if let Some(c) = after {
        a.extend(["--after".to_string(), c.to_string()]);
    }
    a.extend(["--json".to_string(), "--name".to_string(), t.name.clone()]);
    if let Some(team) = &t.team {
        a.extend(["--scope".to_string(), team.clone()]);
    }
    a
}

/// Where the listener got to (`board-listen.json`): a place in one village's log on one board.
#[derive(Default, Serialize, Deserialize)]
struct Place {
    key: String,
    cursor: String,
}

fn load_cursor(path: &Path, f: &Following) -> Option<String> {
    let p: Place = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (p.key == f.key() && !p.cursor.is_empty()).then_some(p.cursor)
}

fn save_cursor(path: &Path, f: &Following, cursor: &str) {
    let tmp = path.with_extension("json.tmp");
    let place = Place { key: f.key(), cursor: cursor.to_string() };
    if let Ok(bytes) = serde_json::to_vec(&place)
        && std::fs::write(&tmp, bytes).is_ok()
    {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// How one run of the tail ended.
#[derive(Debug, PartialEq)]
pub enum Ended {
    /// Told to stop.
    Off,
    /// The child ended or went silent: start it again. `heard`: it delivered events first.
    Again { heard: bool },
    /// It cannot work until something changes (no CLI, no login, no board).
    Stopped(CliError),
}

/// Runs the tail once, handing each event to `on_event` and saving its cursor after it.
pub fn follow_once(cli: &dyn BoardCli, place: &Path, f: &Following, on_event: &dyn Fn(Event), off: &dyn Fn() -> bool) -> Ended {
    if off() {
        return Ended::Off;
    }
    let after = load_cursor(place, f);
    let mut heard = false;
    let mut stopped = false;
    let res = cli.stream(
        &tail_args(after.as_deref(), &f.target),
        &mut |line| {
            if off() {
                stopped = true;
                return false;
            }
            if let Some(e) = line.and_then(parse) {
                heard = true;
                let cursor = e.cursor.clone();
                on_event(e);
                // after it was handled: a crash in between hears it again, and actions are taken once
                save_cursor(place, f, &cursor);
            }
            true
        },
        SILENCE,
    );
    match res {
        _ if stopped => Ended::Off,
        Ok(()) | Err(CliError::Retryable(_)) | Err(CliError::Fatal(_)) => Ended::Again { heard },
        Err(e) => Ended::Stopped(e),
    }
}

/// How long to wait before try number `tries` (from 0): 2 s, doubling to 5 minutes.
pub fn retry_ms(tries: u32) -> u64 {
    RETRY_FIRST_MS.checked_shl(tries).unwrap_or(RETRY_MAX_MS).min(RETRY_MAX_MS)
}

#[derive(Default)]
struct State {
    following: Option<Following>,
    /// Counts changes of `following`, so a running tail knows it is no longer wanted.
    generation: u64,
    stopped: Option<CliError>,
    listening: bool,
    quit: bool,
}

/// The listener thread and its switch.
pub struct Listener {
    state: Mutex<State>,
    wake: Condvar,
}

impl Listener {
    /// Starts the thread; it does nothing until `configure(Some(..))`.
    pub fn start(cli: Arc<dyn BoardCli>, place: PathBuf, on_event: Box<dyn Fn(Event) + Send>) -> Arc<Listener> {
        let l = Arc::new(Listener { state: Mutex::default(), wake: Condvar::new() });
        let me = l.clone();
        std::thread::Builder::new()
            .name("board-listen".into())
            .spawn(move || me.run(cli.as_ref(), &place, on_event.as_ref()))
            .expect("board listener thread");
        l
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whom to follow; None turns listening off. Also clears a stop (no login) so it tries again.
    pub fn configure(&self, following: Option<Following>) {
        let mut g = self.lock();
        if g.following != following {
            g.following = following;
            g.generation += 1;
        }
        g.stopped = None;
        drop(g);
        self.wake.notify_all();
    }

    /// The app is quitting: the child is killed within a tick.
    pub fn stop(&self) {
        let mut g = self.lock();
        g.quit = true;
        g.generation += 1;
        drop(g);
        self.wake.notify_all();
    }

    /// Whether a tail is running, and why it stopped if it did.
    pub fn status(&self) -> (bool, Option<CliError>) {
        let g = self.lock();
        (g.listening, g.stopped.clone())
    }

    fn run(&self, cli: &dyn BoardCli, place: &Path, on_event: &dyn Fn(Event)) {
        let mut tries = 0u32;
        loop {
            let (following, generation) = {
                let mut g = self.lock();
                loop {
                    if g.quit {
                        return;
                    }
                    if g.stopped.is_none()
                        && let Some(f) = g.following.clone()
                    {
                        g.listening = true;
                        break (f, g.generation);
                    }
                    g = self.wake.wait(g).unwrap_or_else(|e| e.into_inner());
                }
            };
            let off = || self.lock().generation != generation;
            let ended = follow_once(cli, place, &following, on_event, &off);
            let mut g = self.lock();
            g.listening = false;
            match ended {
                Ended::Off => tries = 0,
                Ended::Stopped(e) => {
                    if g.generation == generation {
                        g.stopped = Some(e);
                    }
                    tries = 0;
                }
                Ended::Again { heard } => {
                    if heard {
                        tries = 0;
                    }
                    let wait = Duration::from_millis(retry_ms(tries));
                    tries += 1;
                    // woken early by a change of whom to follow, or by quitting
                    let _ = self.wake.wait_timeout_while(g, wait, |s| s.generation == generation && !s.quit);
                }
            }
        }
    }
}

#[cfg(test)]
use super::cli::VercelCli;
#[cfg(test)]
#[path = "listen_tests.rs"]
mod tests;
