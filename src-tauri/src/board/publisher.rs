//! The worker that brings the board up to date with the sessions. Everything that calls `vercel`
//! happens on its thread; the rest of the app only hands it the newest state of a session.
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use super::cli::{args_for_msg, MsgWrite, args_for, message_id, BoardCli, CliError, Target};
use super::store::Store;
use super::{plan, Ctx, Now, Outcome, Published, Wire, Write};
use crate::model::{AgentKind, SessionInfo, SessionState};

#[cfg(test)]
#[path = "publisher_tests.rs"]
mod tests;

/// The names of the files a session changed.
pub type Files = Arc<dyn Fn(&str) -> Vec<String> + Send + Sync>;
/// The time now, in milliseconds.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// A state must have lasted this long before it is written, so a flicker writes once.
pub const SETTLE_MS: i64 = 2_000;
/// After launch, a stored thread whose session has not reported within this time is closed.
pub const LAUNCH_GRACE_MS: i64 = 5_000;
/// A close on a board being left is given up after this many tries.
pub const DRAIN_TRIES: u32 = 5;
const RETRY_FIRST_MS: i64 = 2_000;
const RETRY_MAX_MS: i64 = 300_000;
const IDLE_WAKE: Duration = Duration::from_millis(500);

/// Settings › Team, as the worker needs it.
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub enabled: bool,
    pub target: Target,
    /// The owner's Vercel username.
    pub owner: String,
    pub host_id: String,
    pub share_details: bool,
}

/// A session and what the app knows around it.
#[derive(Debug, Clone)]
pub struct SessionView {
    pub info: SessionInfo,
    /// The builder's display name.
    pub builder: String,
    pub agent: AgentKind,
    /// Its workspace's channel; None when the workspace is not shared.
    pub channel: Option<String>,
    /// The app has the keys for its open permission prompt.
    pub answerable: bool,
}

/// Told the new message's id, or None when the write was given up.
pub type Sent = Box<dyn FnOnce(Option<String>) + Send>;

/// A message write waiting its turn.
struct Msg {
    write: MsgWrite,
    done: Option<Sent>,
    tries: u32,
}

enum Pending {
    Live(Box<SessionView>),
    Paused,
    Closed(Option<Outcome>),
}

/// A thread to close on a board the app is leaving (or for a workspace no longer shared).
struct Drain {
    root: String,
    write: Write,
    target: Target,
    /// Times it failed in a way worth another try.
    tries: u32,
}

#[derive(Default)]
struct Inner {
    cfg: Option<Config>,
    /// The newest thing to publish per session, and when it arrived.
    pending: HashMap<String, (Pending, i64)>,
    drains: VecDeque<Drain>,
    /// Message writes, in the order they were asked for.
    msgs: VecDeque<Msg>,
    store: Store,
    retry_at: i64,
    backoff_ms: i64,
    stopped: Option<CliError>,
    last_error: Option<String>,
    last_write_at: Option<i64>,
    /// Until this time, these stored sessions may still report; after it they are closed.
    launch: Option<(i64, HashSet<String>)>,
    launched: bool,
    quitting: bool,
    /// The session whose writes are under way (the lock is not held meanwhile).
    flying: Option<String>,
    /// Its workspace stopped being shared while its writes were under way.
    flying_unshared: bool,
    /// Counts changes of where the app publishes (on or off, board, owner).
    generation: u64,
}

/// The board a record's `board` names.
fn target_of(key: &str) -> Target {
    let (team, name) = key.split_once('/').unwrap_or(("", key));
    Target { team: Some(team.to_string()).filter(|t| !t.is_empty()), name: name.to_string() }
}

pub struct Publisher {
    inner: Mutex<Inner>,
    wake: Condvar,
    cli: Arc<dyn BoardCli>,
    store_path: PathBuf,
    files: Files,
    now_ms: Clock,
}

/// What one attempt to publish came to.
enum Done {
    Ok,
    /// The board already had it: no call was made.
    Nothing,
    /// Put it back and try later.
    Later(String),
    /// Never: forget it.
    Dropped(String),
    Stop(CliError),
}

impl Publisher {
    /// The publisher without its thread: `step` does the work when called.
    pub fn new(
        cli: Arc<dyn BoardCli>,
        store_path: PathBuf,
        files: Files,
        now_ms: Clock,
    ) -> Arc<Publisher> {
        let inner = Inner { store: Store::load(&store_path), backoff_ms: RETRY_FIRST_MS, ..Default::default() };
        Arc::new(Publisher { inner: Mutex::new(inner), wake: Condvar::new(), cli, store_path, files, now_ms })
    }

    /// The publisher with its worker thread running.
    pub fn start(
        cli: Arc<dyn BoardCli>,
        store_path: PathBuf,
        files: Files,
        now_ms: Clock,
    ) -> Arc<Publisher> {
        let p = Publisher::new(cli, store_path, files, now_ms);
        let worker = Arc::downgrade(&p);
        std::thread::Builder::new()
            .name("board".into())
            .spawn(move || {
                while let Some(p) = worker.upgrade() {
                    p.step();
                    let guard = p.lock();
                    let _ = p.wake.wait_timeout(guard, IDLE_WAKE);
                }
            })
            .expect("board worker thread");
        p
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self, inner: &Inner) {
        if let Err(e) = inner.store.save(&self.store_path) {
            eprintln!("board: could not save {}: {e}", self.store_path.display());
        }
    }

    /// Queues a close for `rec`'s thread on `target`.
    fn drain(inner: &mut Inner, id: &str, rec: &Published, target: &Target) {
        let Some(root) = rec.root.clone() else { return };
        let ctx = Ctx { builder: "", agent: AgentKind::Custom, channel: &rec.channel, board: &rec.board, host_id: "", share_details: false, files: &[], answerable: false };
        let (writes, _) = plan(id, Some(rec), Now::Closed(None), &ctx);
        inner.drains.extend(writes.into_iter().map(|write| Drain { root: root.clone(), write, target: target.clone(), tries: 0 }));
    }

    /// Settings or sharing changed.
    pub fn configure(&self, cfg: Config) {
        let mut g = self.lock();
        let inner = &mut *g;
        let old = inner.cfg.take();
        let was_on = old.as_ref().is_some_and(|c| c.enabled);
        if old.as_ref().is_none_or(|o| o.enabled != cfg.enabled || o.target != cfg.target || o.owner != cfg.owner) {
            inner.generation += 1;
            // written for the board the app is leaving
            inner.msgs.clear();
        }
        if let Some(old) = old.as_ref().filter(|_| was_on) {
            let moved = cfg.enabled && (old.target != cfg.target || old.owner != cfg.owner);
            if moved || !cfg.enabled {
                let open: Vec<(String, Published)> =
                    inner.store.sessions.iter().filter(|(_, r)| !r.unshared && r.state != Wire::Closed).map(|(k, r)| (k.clone(), r.clone())).collect();
                for (id, rec) in &open {
                    Self::drain(inner, id, rec, &old.target);
                }
                inner.pending.clear();
                if moved {
                    // Another board: its threads start afresh.
                    inner.store.sessions.clear();
                } else {
                    // Off: the threads stay known, so turning it on again reopens them.
                    for (id, _) in &open {
                        if let Some(r) = inner.store.sessions.get_mut(id) {
                            r.unshared = true;
                            r.state = Wire::Closed;
                            r.wait = None;
                        }
                    }
                }
                self.save(inner);
            }
        }
        if cfg.enabled {
            // Threads this app left on another board (the board was changed while it could not be
            // reached, or before a restart): closed there, and forgotten here.
            let key = cfg.target.key();
            let elsewhere: Vec<(String, Published)> = inner.store.sessions.iter().filter(|(_, r)| r.board != key).map(|(k, r)| (k.clone(), r.clone())).collect();
            for (id, rec) in &elsewhere {
                if !rec.unshared && rec.state != Wire::Closed {
                    Self::drain(inner, id, rec, &target_of(&rec.board));
                }
                inner.store.sessions.remove(id);
            }
            if !elsewhere.is_empty() {
                self.save(inner);
            }
        }
        if cfg.enabled && !inner.launched {
            inner.launched = true;
            let ids: HashSet<String> = inner.store.sessions.keys().cloned().collect();
            inner.launch = Some(((self.now_ms)() + LAUNCH_GRACE_MS, ids));
        }
        inner.cfg = Some(cfg);
        drop(g);
        self.wake.notify_all();
    }

    /// A session's newest state. Never blocks and never calls the board.
    pub fn update(&self, view: SessionView) {
        let mut g = self.lock();
        let inner = &mut *g;
        let Some(cfg) = inner.cfg.as_ref().filter(|c| c.enabled && !inner.quitting) else { return };
        let id = view.info.id.clone();
        if let Some((_, waiting)) = inner.launch.as_mut() {
            waiting.remove(&id);
        }
        if view.channel.is_none() {
            // Its workspace is not shared: close the thread it had, once.
            inner.pending.remove(&id);
            if let Some(rec) = inner.store.sessions.get(&id).filter(|r| !r.unshared).cloned() {
                let target = cfg.target.clone();
                Self::drain(inner, &id, &rec, &target);
                if let Some(r) = inner.store.sessions.get_mut(&id) {
                    r.unshared = true;
                    r.state = Wire::Closed;
                    r.wait = None;
                }
                self.save(inner);
                drop(g);
                self.wake.notify_all();
            } else if inner.flying.as_deref() == Some(id.as_str()) {
                inner.flying_unshared = true;
            }
            return;
        }
        // The same state again (a tool step, a new reply) keeps its place in line: the settle
        // time runs from when the state began, or a busy builder would never be published.
        let at = match inner.pending.get(&id) {
            Some((Pending::Closed(_), _)) => return,
            Some((Pending::Live(old), at)) if old.info.state == view.info.state && old.info.state_since == view.info.state_since && old.info.awaiting_decision == view.info.awaiting_decision => *at,
            _ => (self.now_ms)(),
        };
        inner.pending.insert(id, (Pending::Live(Box::new(view)), at));
        drop(g);
        self.wake.notify_all();
    }

    /// The session was closed. A second call for the same session changes nothing.
    pub fn closed(&self, session_id: &str, outcome: Option<Outcome>) {
        let mut g = self.lock();
        let inner = &mut *g;
        let on_board = inner.store.sessions.get(session_id).is_some_and(|r| r.root.is_some() && !r.unshared);
        // Its first post may be under way right now: then the close waits for it.
        let flying = inner.flying.as_deref() == Some(session_id);
        if !on_board && !flying {
            inner.pending.remove(session_id);
            if inner.store.sessions.remove(session_id).is_some() {
                self.save(inner);
            }
            return;
        }
        if let Some((Pending::Closed(first), _)) = inner.pending.get(session_id)
            && (first.is_some() || outcome.is_none())
        {
            return;
        }
        inner.pending.insert(session_id.to_string(), (Pending::Closed(outcome), (self.now_ms)()));
        drop(g);
        self.wake.notify_all();
    }

    /// Quitting: marks every live thread paused and waits at most `wait` for the board to have it.
    pub fn pause_all(&self, wait: Duration) {
        let mut g = self.lock();
        g.quitting = true;
        // States that had not settled, and sessions the board never saw, are not worth a quit's time.
        g.pending.retain(|_, (p, _)| !matches!(p, Pending::Live(_)));
        let now = (self.now_ms)();
        let live: Vec<String> = g.store.sessions.iter().filter(|(_, r)| r.root.is_some() && !r.unshared && !matches!(r.state, Wire::Closed | Wire::Paused)).map(|(k, _)| k.clone()).collect();
        for id in live {
            if !matches!(g.pending.get(&id), Some((Pending::Closed(_), _))) {
                g.pending.insert(id, (Pending::Paused, now));
            }
        }
        self.wake.notify_all();
        let until = std::time::Instant::now() + wait;
        while !g.pending.is_empty() && g.stopped.is_none() {
            let left = until.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                break;
            }
            g = self.wake.wait_timeout(g, left.min(Duration::from_millis(50))).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    /// The last problem, and when the board was last written.
    pub fn status(&self) -> (Option<String>, Option<i64>) {
        let g = self.lock();
        (g.last_error.clone(), g.last_write_at)
    }

    /// Why the worker stopped calling the board, if it did.
    pub fn stopped_reason(&self) -> Option<CliError> {
        self.lock().stopped.clone()
    }

    /// The owner fixed what stopped the worker (installed, updated or signed in).
    pub fn check_again(&self) {
        let mut g = self.lock();
        g.stopped = None;
        g.retry_at = 0;
        g.backoff_ms = RETRY_FIRST_MS;
        drop(g);
        self.wake.notify_all();
    }

    /// Queues a write addressed to a message or channel. They go out in order, one at a time,
    /// before session states; one that keeps failing is given up after `DRAIN_TRIES`.
    pub fn send(&self, write: MsgWrite, done: Option<Sent>) {
        self.lock().msgs.push_back(Msg { write, done, tries: 0 });
        self.wake.notify_all();
    }

    /// The prompt block last written for the session's open wait, and its `since`.
    pub fn open_block(&self, session_id: &str) -> Option<(String, i64)> {
        let g = self.lock();
        let board = g.cfg.as_ref().filter(|c| c.enabled)?.target.key();
        let rec = g.store.sessions.get(session_id).filter(|r| r.board == board && !r.unshared)?;
        rec.block.clone().map(|b| (b, rec.since))
    }

    /// The session whose thread starts at `root`, on the board the app publishes to.
    pub fn session_for_root(&self, root: &str) -> Option<String> {
        let g = self.lock();
        let board = g.cfg.as_ref().filter(|c| c.enabled)?.target.key();
        g.store.sessions.iter().find(|(_, r)| r.board == board && r.root.as_deref() == Some(root)).map(|(id, _)| id.clone())
    }

    fn call(&self, write: &Write, root: Option<&str>, target: &Target) -> Result<Option<String>, Done> {
        match self.cli.run(&args_for(write, root, target)) {
            Ok(v) => Ok(message_id(&v)),
            Err(CliError::Retryable(m)) => Err(Done::Later(m)),
            Err(CliError::Fatal(m)) => Err(Done::Dropped(m)),
            Err(e) => Err(Done::Stop(e)),
        }
    }

    /// Records how an attempt ended; false when the worker must stop for now.
    fn settle(&self, inner: &mut Inner, done: &Done) -> bool {
        match done {
            Done::Ok => {
                inner.last_error = None;
                inner.last_write_at = Some((self.now_ms)());
                inner.backoff_ms = RETRY_FIRST_MS;
                true
            }
            Done::Nothing => true,
            Done::Dropped(m) => {
                inner.last_error = Some(m.clone());
                true
            }
            Done::Later(m) => {
                inner.last_error = Some(m.clone());
                inner.retry_at = (self.now_ms)() + inner.backoff_ms;
                inner.backoff_ms = (inner.backoff_ms * 2).min(RETRY_MAX_MS);
                false
            }
            Done::Stop(e) => {
                inner.stopped = Some(e.clone());
                false
            }
        }
    }

    /// Publishes everything that is due. The worker thread calls this; so do the tests.
    pub fn step(&self) {
        loop {
            let now = (self.now_ms)();
            let mut g = self.lock();
            let inner = &mut *g;
            if inner.stopped.is_some() || now < inner.retry_at {
                return;
            }
            // Launch: stored threads whose session never reported are closed.
            if let Some((deadline, _)) = inner.launch.as_ref()
                && now >= *deadline
                && let Some(cfg) = inner.cfg.clone()
            {
                let (_, gone) = inner.launch.take().unwrap_or_default();
                for id in gone {
                    if let Some(rec) = inner.store.sessions.remove(&id)
                        && !rec.unshared
                        && rec.state != Wire::Closed
                    {
                        Self::drain(inner, &id, &rec, &cfg.target);
                    }
                }
                self.save(inner);
            }

            if let Some(d) = inner.drains.pop_front() {
                drop(g);
                let done = self.call(&d.write, Some(&d.root), &d.target).map(|_| Done::Ok).unwrap_or_else(|e| e);
                let mut g = self.lock();
                let mut d = d;
                let done = match done {
                    Done::Later(m) => {
                        d.tries += 1;
                        // A board that never answers must not hold up the others for good.
                        if d.tries >= DRAIN_TRIES { Done::Dropped(m) } else { Done::Later(m) }
                    }
                    other => other,
                };
                if matches!(done, Done::Later(_) | Done::Stop(_)) {
                    g.drains.push_front(d);
                }
                if !self.settle(&mut g, &done) {
                    return;
                }
                continue;
            }

            let Some(cfg) = inner.cfg.clone() else { return };
            if cfg.enabled
                && let Some(m) = inner.msgs.pop_front()
            {
                let generation = inner.generation;
                drop(g);
                let res = match self.cli.run(&args_for_msg(&m.write, &cfg.target)) {
                    Ok(v) => Ok(message_id(&v)),
                    Err(CliError::Retryable(e)) => Err(Done::Later(e)),
                    Err(CliError::Fatal(e)) => Err(Done::Dropped(e)),
                    Err(e) => Err(Done::Stop(e)),
                };
                let mut g = self.lock();
                let mut m = m;
                let (done, id) = match res {
                    Ok(id) => (Done::Ok, id),
                    Err(Done::Later(e)) => {
                        m.tries += 1;
                        (if m.tries >= DRAIN_TRIES { Done::Dropped(e) } else { Done::Later(e) }, None)
                    }
                    Err(other) => (other, None),
                };
                let keep = matches!(done, Done::Later(_) | Done::Stop(_)) && g.generation == generation;
                let told = if keep {
                    g.msgs.push_front(m);
                    None
                } else {
                    m.done.take()
                };
                let go_on = self.settle(&mut g, &done);
                drop(g);
                // outside the lock: it may queue more
                if let Some(f) = told {
                    f(id);
                }
                if !go_on {
                    return;
                }
                continue;
            }
            let due = inner
                .pending
                .iter()
                // A close without an outcome waits too: the outcome may be a moment behind it.
                .filter(|(_, (p, at))| matches!(p, Pending::Paused | Pending::Closed(Some(_))) || now - at >= SETTLE_MS)
                .min_by_key(|(_, (_, at))| *at)
                .map(|(id, _)| id.clone());
            let Some(id) = due else { return };
            let Some((entry, at)) = inner.pending.remove(&id) else { return };
            let prev = inner.store.sessions.get(&id).cloned();
            let generation = inner.generation;
            inner.flying = Some(id.clone());
            inner.flying_unshared = false;
            drop(g);

            let (done, record) = self.publish(&id, &entry, prev.as_ref(), &cfg);
            let mut g = self.lock();
            let inner = &mut *g;
            inner.flying = None;
            let unshared = std::mem::take(&mut inner.flying_unshared);
            let moved = inner.generation != generation;
            if moved || unshared {
                // Where the app publishes changed while these writes were under way, so their
                // result is not kept as it is. A thread that existed before was dealt with when
                // the change came; one posted just now is closed where it was posted.
                let had_root = prev.as_ref().is_some_and(|p| p.root.is_some());
                if let Some(rec) = record.filter(|r| r.root.is_some() && !had_root) {
                    Self::drain(inner, &id, &rec, &cfg.target);
                    let same_board = inner.cfg.as_ref().is_some_and(|c| c.target == cfg.target && c.owner == cfg.owner);
                    if same_board && !matches!(entry, Pending::Closed(_)) {
                        // Off, or no longer shared: sharing again reopens this thread.
                        inner.store.sessions.insert(id.clone(), Published { unshared: true, state: Wire::Closed, wait: None, ..rec });
                    }
                    self.save(inner);
                }
                let go_on = self.settle(inner, &done);
                drop(g);
                self.wake.notify_all();
                if !go_on {
                    return;
                }
                continue;
            }
            match record {
                Some(_) if matches!(entry, Pending::Closed(_)) && matches!(done, Done::Ok | Done::Nothing) => {
                    inner.store.sessions.remove(&id);
                    self.save(inner);
                }
                Some(rec) => {
                    inner.store.sessions.insert(id.clone(), rec);
                    self.save(inner);
                }
                None => {}
            }
            if matches!(done, Done::Later(_) | Done::Stop(_)) {
                // Keep it unless something newer arrived meanwhile.
                inner.pending.entry(id).or_insert((entry, at));
            }
            let go_on = self.settle(inner, &done);
            drop(g);
            self.wake.notify_all();
            if !go_on {
                return;
            }
        }
    }

    /// Runs the writes for one session. Returns how it went and the record to store (None: leave
    /// the stored one as it is).
    fn publish(&self, id: &str, entry: &Pending, prev: Option<&Published>, cfg: &Config) -> (Done, Option<Published>) {
        let files = match entry {
            Pending::Live(v) if matches!(v.info.state, SessionState::Finished) && cfg.share_details => (self.files)(id),
            _ => vec![],
        };
        let board = cfg.target.key();
        // A record from another board is no record here.
        let prev = prev.filter(|p| p.board == board);
        let (now, builder, agent, channel) = match entry {
            Pending::Live(v) => (Now::Live(&v.info), v.builder.as_str(), v.agent.clone(), v.channel.as_deref().unwrap_or_default()),
            Pending::Paused => (Now::Paused, "", AgentKind::Custom, ""),
            Pending::Closed(o) => (Now::Closed(*o), "", AgentKind::Custom, ""),
        };
        let answerable = matches!(entry, Pending::Live(v) if v.answerable);
        let ctx = Ctx { builder, agent, channel, board: &board, host_id: &cfg.host_id, share_details: cfg.share_details, files: &files, answerable };
        let (writes, planned) = plan(id, prev, now, &ctx);
        let mut root = prev.and_then(|p| p.root.clone());
        for w in &writes {
            match self.call(w, root.as_deref(), &cfg.target) {
                Ok(posted) => {
                    if matches!(w, Write::PostRoot { .. }) {
                        root = posted;
                    }
                }
                Err(done) => {
                    // A root that was posted is remembered, with a state that makes the rest be sent again.
                    let partial = (root.is_some() && prev.is_none_or(|p| p.root.is_none())).then(|| Published { root: root.clone(), wait: None, since: i64::MIN, ..planned.clone() });
                    return (done, partial);
                }
            }
        }
        if writes.is_empty() {
            let unchanged = prev.is_some_and(|p| *p == planned);
            return (Done::Nothing, (!unchanged).then_some(Published { root, ..planned }));
        }
        (Done::Ok, Some(Published { root, ..planned }))
    }
}
