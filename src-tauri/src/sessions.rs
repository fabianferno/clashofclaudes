//! SessionManager: owns every session's PTY, scrollback and status.
use crate::adapters::{terminal_launch, terminal_policy, AdapterRegistry, AgentAdapter, LaunchRequest};
use crate::git::{self, GitBaseline, Review};
use crate::hooks::HookServer;
use crate::model::{Builder, SessionInfo, SessionKind, SessionState, Workspace, WorktreeInfo};
use crate::pty::{LaunchSpec, PtyHandle};
use crate::scrollback::{Scrollback, SCROLLBACK_CAP};
use crate::status::{next_state, StatusEvent, StatusPolicy};
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq)]
pub enum ManagerEvent {
    Updated(SessionInfo),
    /// `offset`: stream position (bytes since session start) of the first byte of `data`.
    Output { id: String, offset: u64, data: Vec<u8> },
    Removed { id: String },
}

pub type Emit = Arc<dyn Fn(ManagerEvent) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseOutcome {
    pub earned_xp: bool,
}

/// Initial PTY size until the UI sends a resize.
const INITIAL_COLS: u16 = 120;
const INITIAL_ROWS: u16 = 32;
/// At most one `Output` event per session per this interval.
const FLUSH_EVERY: Duration = Duration::from_millis(16);
const TICK_EVERY: Duration = Duration::from_secs(1);
/// Shown after Deny: the agent now waits for typed instructions.
pub const DENIED_REASON: &str = "Denied — tell Claude what to do in the terminal";

struct SessionEntry {
    info: SessionInfo,
    workspace_path: PathBuf,
    /// `None` until spawned and again once the process has exited (fds released).
    pty: Option<Arc<PtyHandle>>,
    exited: bool,
    stop_requested: bool,
    scrollback: Scrollback,
    adapter: Option<Arc<dyn AgentAdapter>>,
    policy: StatusPolicy,
    baseline: Option<GitBaseline>,
    pending: VecDeque<u8>,
    /// Total bytes the process has ever written; `pending` is always the stream's newest suffix.
    out_total: u64,
    /// Bytes of this session's queued-but-undelivered `Output` (cleared by the emitter thread).
    in_flight: Arc<AtomicUsize>,
    last_flush: Instant,
    /// Silence is measured from the latest output or state change.
    quiet_since_ms: i64,
    /// Last hook cwd sent for worktree detection (avoids re-running git per hook).
    checked_cwd: Option<PathBuf>,
}

impl SessionEntry {
    /// Feeds one status event; returns true when `info` changed.
    fn apply(&mut self, ev: &StatusEvent, now: i64) -> bool {
        let mut changed = false;
        if matches!(ev, StatusEvent::ToolUsed) && !matches!(self.info.state, SessionState::Ended { .. }) {
            self.info.steps += 1;
            changed = true;
        }
        let next = next_state(&self.info.state, ev, &self.policy);
        if next != self.info.state {
            self.info.reached_finished |= next == SessionState::Finished;
            self.info.state = next;
            self.quiet_since_ms = now;
            changed = true;
        }
        // A permission prompt arms Allow/Deny; leaving NeedsYou disarms them.
        let needs_you = matches!(self.info.state, SessionState::NeedsYou { .. });
        let awaiting = match ev {
            StatusEvent::PermissionRequested { .. } => needs_you,
            _ => self.info.awaiting_decision && needs_you,
        };
        if awaiting != self.info.awaiting_decision {
            self.info.awaiting_decision = awaiting;
            changed = true;
        }
        changed
    }

    /// Backpressure: at most one undelivered `Output` per session. While one is in flight,
    /// bytes keep accumulating in `pending` (capped in `on_output`) and a later flush sends them.
    fn flush(&mut self, tx: &Sender<Queued>) {
        if self.in_flight.load(Ordering::SeqCst) > 0 {
            return;
        }
        self.last_flush = Instant::now();
        if !self.pending.is_empty() {
            let offset = self.out_total - self.pending.len() as u64;
            let data = Vec::from(std::mem::take(&mut self.pending));
            self.in_flight.fetch_add(data.len(), Ordering::SeqCst);
            let ev = ManagerEvent::Output { id: self.info.id.clone(), offset, data };
            let _ = tx.send(Queued { ev, in_flight: Some(self.in_flight.clone()) });
        }
    }

    fn is_live(&self) -> bool {
        !matches!(self.info.state, SessionState::Ended { .. })
    }
}

type Sessions = HashMap<String, SessionEntry>;

/// An event on its way to the emitter thread; `Output` carries its session's in-flight counter.
struct Queued {
    ev: ManagerEvent,
    in_flight: Option<Arc<AtomicUsize>>,
}

/// Locking: one mutex over all sessions. Events are sent into a channel while the lock is
/// held (so their order matches the state order) and a dedicated thread calls `emit`, so
/// `emit` never runs under the lock. PTY kills, git and file IO run outside the lock; PTY
/// writes only enqueue (see `PtyHandle`), so they may happen under it.
/// Queued output per session is bounded: one in-flight `Output` plus `pending`, each at most
/// `SCROLLBACK_CAP` bytes.
pub struct SessionManager {
    registry: AdapterRegistry,
    hooks: Arc<HookServer>,
    data_dir: PathBuf,
    sessions: Mutex<Sessions>,
    tx: Sender<Queued>,
    weak: Weak<SessionManager>,
}

impl SessionManager {
    pub fn new(registry: AdapterRegistry, hooks: Arc<HookServer>, data_dir: PathBuf, emit: Emit) -> Arc<SessionManager> {
        let (tx, rx) = mpsc::channel::<Queued>();
        // Ends when the manager (the only sender) is dropped.
        std::thread::spawn(move || {
            for Queued { ev, in_flight } in rx {
                let n = match &ev {
                    ManagerEvent::Output { data, .. } => data.len(),
                    _ => 0,
                };
                emit(ev);
                if let Some(c) = in_flight {
                    c.fetch_sub(n, Ordering::SeqCst);
                }
            }
        });
        let mgr = Arc::new_cyclic(|weak| SessionManager {
            registry,
            hooks,
            data_dir,
            sessions: Mutex::new(HashMap::new()),
            tx,
            weak: weak.clone(),
        });
        // Output flushes every 16 ms and the 1 s silence tick; ends once the manager is gone.
        let weak = Arc::downgrade(&mgr);
        std::thread::spawn(move || {
            let mut last_tick = Instant::now();
            loop {
                std::thread::sleep(FLUSH_EVERY);
                let Some(m) = weak.upgrade() else { break };
                m.flush_due();
                if last_tick.elapsed() >= TICK_EVERY {
                    last_tick = Instant::now();
                    m.tick(now_ms());
                }
            }
        });
        mgr
    }

    fn lock(&self) -> MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn send_updated(&self, e: &SessionEntry) {
        let _ = self.tx.send(Queued { ev: ManagerEvent::Updated(e.info.clone()), in_flight: None });
    }

    pub fn start_agent(&self, ws: &Workspace, builder: &Builder, task: Option<&str>) -> Result<SessionInfo> {
        ensure_present(ws)?;
        let adapter = self
            .registry
            .get(builder.agent.clone())
            .ok_or_else(|| anyhow!("no adapter for {:?}", builder.agent))?;
        if !adapter.detect().installed {
            bail!("{} is not installed", adapter.label());
        }
        self.ensure_builder_free(&self.lock(), &builder.id)?;
        let id = Uuid::new_v4().to_string();
        let hook_url = self.hooks.register(&id);
        let req = LaunchRequest {
            session_id: &id,
            cwd: &ws.path,
            model: builder.model.as_deref(),
            effort: builder.effort.as_deref(),
            task,
            hook_url: &hook_url,
            data_dir: &self.data_dir,
            custom_command: builder.custom_command.as_deref(),
        };
        let res = adapter.launch(&req).and_then(|spec| self.spawn_agent(ws, builder, task, id.clone(), spec, adapter));
        if res.is_err() {
            self.hooks.unregister(&id);
            self.remove_session_dir(&id);
        }
        res
    }

    /// Test hook: start an agent session with an injected launch spec and adapter.
    #[cfg(test)]
    pub(crate) fn start_with_spec(&self, ws: &Workspace, builder: &Builder, spec: LaunchSpec, adapter: Arc<dyn AgentAdapter>) -> Result<SessionInfo> {
        let id = Uuid::new_v4().to_string();
        self.hooks.register(&id);
        let res = self.spawn_agent(ws, builder, None, id.clone(), spec, adapter);
        if res.is_err() {
            self.hooks.unregister(&id);
        }
        res
    }

    fn spawn_agent(&self, ws: &Workspace, builder: &Builder, task: Option<&str>, id: String, spec: LaunchSpec, adapter: Arc<dyn AgentAdapter>) -> Result<SessionInfo> {
        let kind = SessionKind::Agent { builder_id: builder.id.clone() };
        let policy = adapter.policy();
        self.spawn(ws, kind, task, id, spec, Some(adapter), policy)
    }

    pub fn start_terminal(&self, ws: &Workspace) -> Result<SessionInfo> {
        let id = Uuid::new_v4().to_string();
        self.spawn(ws, SessionKind::Terminal, None, id, terminal_launch(&ws.path), None, terminal_policy())
    }

    fn ensure_builder_free(&self, sessions: &Sessions, builder_id: &str) -> Result<()> {
        let busy = sessions.values().any(|e| {
            e.is_live() && matches!(&e.info.kind, SessionKind::Agent { builder_id: b } if b == builder_id)
        });
        if busy {
            bail!("this builder already has a session");
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn(&self, ws: &Workspace, kind: SessionKind, task: Option<&str>, id: String, spec: LaunchSpec, adapter: Option<Arc<dyn AgentAdapter>>, policy: StatusPolicy) -> Result<SessionInfo> {
        ensure_present(ws)?;
        let baseline = git::baseline(&ws.path);
        let now = now_ms();
        let info = SessionInfo {
            id: id.clone(),
            workspace_id: ws.id.clone(),
            kind,
            task: task.map(str::to_string),
            state: SessionState::Starting,
            steps: 0,
            started_at: now,
            last_output_at: now,
            reached_finished: false,
            worktree: None,
            command_preview: command_preview(&spec),
            awaiting_decision: false,
        };
        {
            // Check and insert atomically so two starts can't share a builder.
            let mut g = self.lock();
            if let SessionKind::Agent { builder_id } = &info.kind {
                self.ensure_builder_free(&g, builder_id)?;
            }
            g.insert(id.clone(), SessionEntry {
                info,
                workspace_path: ws.path.clone(),
                pty: None,
                exited: false,
                stop_requested: false,
                scrollback: Scrollback::new(SCROLLBACK_CAP),
                adapter,
                policy,
                baseline,
                pending: VecDeque::new(),
                out_total: 0,
                in_flight: Arc::default(),
                last_flush: Instant::now(),
                quiet_since_ms: now,
                checked_cwd: None,
            });
        }
        // The entry exists before the child does, so early output and exit find it.
        let (w_out, w_exit) = (self.weak.clone(), self.weak.clone());
        let (id_out, id_exit) = (id.clone(), id.clone());
        let spawned = PtyHandle::spawn(
            &spec,
            INITIAL_COLS,
            INITIAL_ROWS,
            Box::new(move |d| {
                if let Some(m) = w_out.upgrade() {
                    m.on_output(&id_out, d);
                }
            }),
            Box::new(move |code| {
                if let Some(m) = w_exit.upgrade() {
                    m.on_exit(&id_exit, code);
                }
            }),
        );
        let handle = match spawned {
            Ok(h) => Arc::new(h),
            Err(err) => {
                self.lock().remove(&id);
                return Err(err.context(format!("failed to start {}", spec.program)));
            }
        };
        let mut g = self.lock();
        let Some(e) = g.get_mut(&id) else {
            drop(g);
            let _ = handle.kill(); // closed while starting
            bail!("session was closed while starting");
        };
        // If it already exited, `handle` just drops below, releasing its fds.
        let stop_now = !e.exited && e.stop_requested; // stop() raced the spawn
        if !e.exited {
            e.pty = Some(handle.clone());
        }
        self.send_updated(e);
        let info = e.info.clone();
        drop(g);
        if stop_now {
            let _ = handle.kill();
        }
        Ok(info)
    }

    fn on_output(&self, id: &str, data: &[u8]) {
        let mut g = self.lock();
        let Some(e) = g.get_mut(id) else { return };
        let now = now_ms();
        e.scrollback.push(data);
        e.info.last_output_at = now;
        e.quiet_since_ms = now;
        if e.apply(&StatusEvent::Output, now) {
            self.send_updated(e);
        }
        e.out_total += data.len() as u64;
        e.pending.extend(data);
        // A frontend this far behind loses the oldest bytes; re-attaching replays scrollback.
        let over = e.pending.len().saturating_sub(SCROLLBACK_CAP);
        e.pending.drain(..over);
        if e.last_flush.elapsed() >= FLUSH_EVERY {
            e.flush(&self.tx);
        }
    }

    fn on_exit(&self, id: &str, code: Option<i32>) {
        let pty = {
            let mut g = self.lock();
            let Some(e) = g.get_mut(id) else { return };
            e.exited = true;
            e.flush(&self.tx);
            let changed = if e.stop_requested {
                // A user stop ends the session (with the real exit code) instead of reading as a crash.
                let was_live = e.is_live();
                e.info.state = SessionState::Ended { exit_code: code };
                was_live
            } else {
                e.apply(&StatusEvent::Exited { code }, now_ms())
            };
            if changed {
                self.send_updated(e);
            }
            e.pty.take()
        };
        drop(pty);
    }

    fn flush_due(&self) {
        let mut g = self.lock();
        for e in g.values_mut() {
            if !e.pending.is_empty() && e.last_flush.elapsed() >= FLUSH_EVERY {
                e.flush(&self.tx);
            }
        }
    }

    /// Must stay quick: runs inline on a tokio worker. Git work is offloaded to a thread.
    pub fn on_hook(&self, session_id: &str, body: serde_json::Value) {
        let job = {
            let mut g = self.lock();
            let Some(e) = g.get_mut(session_id) else { return };
            let Some(adapter) = e.adapter.clone() else { return };
            let now = now_ms();
            let mut changed = false;
            let mut job = None;
            for ev in adapter.parse_hook(&body) {
                match ev {
                    StatusEvent::CwdChanged { cwd } => {
                        if e.checked_cwd.as_ref() != Some(&cwd) {
                            e.checked_cwd = Some(cwd.clone());
                            job = Some((e.workspace_path.clone(), cwd));
                        }
                    }
                    other => changed |= e.apply(&other, now),
                }
            }
            if changed {
                self.send_updated(e);
            }
            job
        };
        if let Some((ws_path, cwd)) = job {
            let (weak, id) = (self.weak.clone(), session_id.to_string());
            std::thread::spawn(move || {
                if let Some(wt) = git::worktree_of(&ws_path, &cwd) {
                    if let Some(m) = weak.upgrade() {
                        m.set_worktree(&id, wt);
                    }
                }
            });
        }
    }

    fn set_worktree(&self, id: &str, wt: WorktreeInfo) {
        let mut g = self.lock();
        if let Some(e) = g.get_mut(id) {
            if e.info.worktree.as_ref() != Some(&wt) {
                e.info.worktree = Some(wt);
                self.send_updated(e);
            }
        }
    }

    fn running_pty(&self, id: &str) -> Result<Arc<PtyHandle>> {
        let g = self.lock();
        let e = g.get(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
        e.pty.clone().ok_or_else(|| anyhow!("session is not running"))
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        self.running_pty(id)?.write(data)?;
        if data.contains(&b'\r') {
            let mut g = self.lock();
            if let Some(e) = g.get_mut(id) {
                if e.apply(&StatusEvent::UserInput, now_ms()) {
                    self.send_updated(e);
                }
            }
        }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        self.running_pty(id)?.resize(cols, rows)
    }

    /// Answers the open permission prompt with yes; the session reads as `Working` at once
    /// (the tool runs with no further hook until it finishes).
    pub fn approve(&self, id: &str) -> Result<()> {
        self.answer(id, |a| a.approve_keys(), SessionState::Working)
    }

    /// Answers the open permission prompt with no. The agent then waits for typed
    /// instructions and no hook fires, so the session stays `NeedsYou` with `DENIED_REASON`.
    pub fn deny(&self, id: &str) -> Result<()> {
        self.answer(id, |a| a.deny_keys(), SessionState::NeedsYou { reason: DENIED_REASON.into() })
    }

    /// One answer per prompt: a second approve/deny errs until a new `PermissionRequested`.
    fn answer(&self, id: &str, pick: fn(&dyn AgentAdapter) -> Option<&'static [u8]>, then: SessionState) -> Result<()> {
        let mut g = self.lock();
        let e = g.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
        let keys = e
            .adapter
            .as_deref()
            .and_then(pick)
            .ok_or_else(|| anyhow!("this agent can't be answered from the app; open the terminal"))?;
        if !e.info.awaiting_decision || !matches!(e.info.state, SessionState::NeedsYou { .. }) {
            bail!("session is not waiting for approval");
        }
        let pty = e.pty.clone().ok_or_else(|| anyhow!("session is not running"))?;
        pty.write(keys)?; // only enqueues, so it is fine under the lock
        e.info.awaiting_decision = false;
        e.info.state = then;
        e.quiet_since_ms = now_ms();
        self.send_updated(e);
        Ok(())
    }

    /// Kills the process; the session stays listed and ends as `Ended`.
    pub fn stop(&self, id: &str) -> Result<()> {
        let pty = {
            let mut g = self.lock();
            let e = g.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
            if e.exited {
                return Ok(());
            }
            e.stop_requested = true;
            e.pty.clone()
        };
        match pty {
            Some(p) => p.kill(),
            None => Ok(()), // still spawning; on_exit will see stop_requested once it exits
        }
    }

    pub fn close(&self, id: &str) -> Result<CloseOutcome> {
        let entry = {
            let mut g = self.lock();
            let e = g.remove(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
            let _ = self.tx.send(Queued { ev: ManagerEvent::Removed { id: id.to_string() }, in_flight: None });
            e
        };
        let earned_xp = entry.info.reached_finished && !matches!(entry.info.state, SessionState::Stuck { .. });
        if let Some(p) = &entry.pty {
            let _ = p.kill();
        }
        self.hooks.unregister(id);
        self.remove_session_dir(id);
        drop(entry); // releases the PTY fds
        Ok(CloseOutcome { earned_xp })
    }

    /// Scrollback snapshot plus the stream offset of its first byte. Bytes not yet emitted are
    /// dropped from the pending batch, since the snapshot already contains them; the next
    /// `Output` starts at `start + snapshot.len()`. An `Output` already queued may overlap the
    /// snapshot, so consumers drop bytes at stream positions they have already written.
    pub fn attach(&self, id: &str) -> Result<(Vec<u8>, u64)> {
        let mut g = self.lock();
        let e = g.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
        e.pending.clear();
        let snap = e.scrollback.snapshot();
        let start = e.out_total - snap.len() as u64;
        Ok((snap, start))
    }

    /// Output bytes buffered or queued for `emit` but not yet delivered.
    #[cfg(test)]
    fn queued_output_bytes(&self, id: &str) -> usize {
        let g = self.lock();
        g.get(id).map_or(0, |e| e.pending.len() + e.in_flight.load(Ordering::SeqCst))
    }

    pub fn review(&self, id: &str) -> Result<Review> {
        let (dir, base, wt_branch, others) = {
            let g = self.lock();
            let e = g.get(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
            let others = g
                .values()
                .any(|o| o.info.id != id && o.info.workspace_id == e.info.workspace_id && o.is_live());
            let (dir, branch) = match &e.info.worktree {
                Some(wt) => (wt.path.clone(), wt.branch.clone()),
                None => (e.workspace_path.clone(), None),
            };
            (dir, e.baseline.clone(), branch, others)
        };
        let mut r = git::review_since(&dir, base.as_ref())?;
        if wt_branch.is_some() {
            r.branch = wt_branch;
        }
        r.other_sessions_active = others;
        Ok(r)
    }

    pub fn tick(&self, now_ms: i64) {
        let mut g = self.lock();
        for e in g.values_mut().filter(|e| !e.exited) {
            let secs = (now_ms - e.quiet_since_ms).max(0) as u64 / 1000;
            if e.apply(&StatusEvent::Silence { secs }, now_ms) {
                self.send_updated(e);
            }
        }
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let mut v: Vec<SessionInfo> = self.lock().values().map(|e| e.info.clone()).collect();
        v.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id)));
        v
    }

    /// Sessions not `Ended`.
    pub fn live_count(&self) -> usize {
        self.lock().values().filter(|e| e.is_live()).count()
    }

    fn remove_session_dir(&self, id: &str) {
        let _ = std::fs::remove_dir_all(self.data_dir.join("sessions").join(id));
    }
}

impl Drop for SessionManager {
    /// No child outlives the manager.
    fn drop(&mut self) {
        let sessions = self.sessions.get_mut().unwrap_or_else(|e| e.into_inner());
        for (id, e) in sessions.drain() {
            if let Some(p) = &e.pty {
                let _ = p.kill();
            }
            self.hooks.unregister(&id);
        }
    }
}

/// Starting failed because the workspace folder is gone (deleted or moved).
#[derive(Debug)]
pub struct WorkspaceMissing(pub PathBuf);

impl std::fmt::Display for WorkspaceMissing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Workspace folder not found: {}", self.0.display())
    }
}

impl std::error::Error for WorkspaceMissing {}

/// The folder can vanish while the app runs, so check the filesystem, not just the load-time
/// `missing` flag (a PTY spawned in a missing cwd silently falls back to `$HOME`).
fn ensure_present(ws: &Workspace) -> Result<()> {
    if ws.missing || !ws.path.is_dir() {
        return Err(WorkspaceMissing(ws.path.clone()).into());
    }
    Ok(())
}

/// Display-only: POSIX-shell quoting of one word.
fn shell_quote(s: &str) -> String {
    let safe = |c: char| c.is_ascii_alphanumeric() || "-_./=:,+@%".contains(c);
    if !s.is_empty() && s.chars().all(safe) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

fn command_preview(spec: &LaunchSpec) -> String {
    std::iter::once(&spec.program).chain(&spec.args).map(|s| shell_quote(s)).collect::<Vec<_>>().join(" ")
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::ClaudeAdapter;
    use crate::model::AgentKind;

    type Events = Arc<Mutex<Vec<ManagerEvent>>>;

    struct Fx {
        mgr: Arc<SessionManager>,
        events: Events,
        ws: Workspace,
        data_dir: PathBuf,
        _dir: tempfile::TempDir,
        _rt: tokio::runtime::Runtime,
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            for s in self.mgr.list() {
                let _ = self.mgr.close(&s.id);
            }
        }
    }

    fn fixture() -> Fx {
        fixture_with(Duration::ZERO)
    }

    /// `output_delay`: how long the recording `emit` blocks on each `Output` (a slow frontend).
    fn fixture_with(output_delay: Duration) -> Fx {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let hooks = Arc::new(rt.block_on(HookServer::start(Arc::new(|_, _| {}))).unwrap());
        let events: Events = Arc::default();
        let e2 = events.clone();
        let emit: Emit = Arc::new(move |ev| {
            if matches!(ev, ManagerEvent::Output { .. }) {
                std::thread::sleep(output_delay);
            }
            e2.lock().unwrap().push(ev)
        });
        let dir = tempfile::tempdir().unwrap();
        let ws_path = dir.path().join("ws");
        std::fs::create_dir(&ws_path).unwrap();
        let data_dir = dir.path().join("data");
        let mgr = SessionManager::new(AdapterRegistry::new(), hooks, data_dir.clone(), emit);
        let ws = Workspace { id: "w1".into(), name: "ws".into(), path: ws_path, created_at: 0, missing: false };
        Fx { mgr, events, ws, data_dir, _dir: dir, _rt: rt }
    }

    fn custom(id: &str, cmd: &str) -> Builder {
        Builder { id: id.into(), name: id.into(), agent: AgentKind::Custom, model: None, effort: None, custom_command: Some(cmd.into()) }
    }

    fn claude(id: &str) -> Builder {
        Builder { id: id.into(), name: id.into(), agent: AgentKind::Claude, model: None, effort: None, custom_command: None }
    }

    fn sleeper(fx: &Fx) -> LaunchSpec {
        LaunchSpec { program: "/bin/sh".into(), args: vec!["-c".into(), "sleep 5".into()], env: vec![], cwd: fx.ws.path.clone() }
    }

    fn wait_until(f: impl Fn() -> bool) -> bool {
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn state(fx: &Fx, id: &str) -> SessionState {
        fx.mgr.list().into_iter().find(|s| s.id == id).unwrap().state
    }

    fn output(fx: &Fx, id: &str) -> String {
        let ev = fx.events.lock().unwrap();
        let bytes: Vec<u8> = ev
            .iter()
            .filter_map(|e| match e {
                ManagerEvent::Output { id: i, data, .. } if i == id => Some(data.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn scrollback(fx: &Fx, id: &str) -> String {
        String::from_utf8_lossy(&fx.mgr.lock().get(id).unwrap().scrollback.snapshot()).into_owned()
    }

    fn fixture_json(name: &str) -> serde_json::Value {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-hooks").join(name);
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    #[test]
    fn start_custom_session_runs_and_updates() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf ok; sleep 0.2"), None).unwrap();
        assert_eq!(s.state, SessionState::Starting);
        assert!(uuid::Uuid::parse_str(&s.id).is_ok());
        assert!(wait_until(|| fx.events.lock().unwrap().iter().any(
            |e| matches!(e, ManagerEvent::Updated(i) if i.id == s.id && i.state == SessionState::Working))));
        assert!(wait_until(|| output(&fx, &s.id).contains("ok")));
    }

    #[test]
    fn immediate_nonzero_exit_goes_stuck() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf boom; exit 7"), None).unwrap();
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::Stuck { reason: "exited with code 7".into() }));
        assert!(String::from_utf8_lossy(&fx.mgr.attach(&s.id).unwrap().0).contains("boom"));
        assert!(fx.mgr.write(&s.id, b"x").is_err(), "no process to write to");
    }

    #[test]
    fn start_in_missing_workspace_errors() {
        let fx = fixture();
        let mut ws = fx.ws.clone();
        ws.missing = true;
        assert!(fx.mgr.start_agent(&ws, &custom("b1", "true"), None).is_err());
        assert!(fx.mgr.start_terminal(&ws).is_err());
        assert!(fx.mgr.list().is_empty());
    }

    #[test]
    fn start_in_vanished_workspace_errors() {
        let fx = fixture();
        let dir = fx.ws.path.parent().unwrap().join("gone");
        std::fs::create_dir(&dir).unwrap();
        let ws = Workspace { path: dir.clone(), ..fx.ws.clone() };
        std::fs::remove_dir(&dir).unwrap(); // deleted while the app runs; `missing` is stale
        let err = fx.mgr.start_agent(&ws, &custom("b1", "true"), None).unwrap_err();
        assert!(err.downcast_ref::<WorkspaceMissing>().is_some(), "{err:#}");
        assert_eq!(err.to_string(), format!("Workspace folder not found: {}", dir.display()));
        let err = fx.mgr.start_terminal(&ws).unwrap_err();
        assert!(err.downcast_ref::<WorkspaceMissing>().is_some(), "{err:#}");
        assert!(fx.mgr.list().is_empty());
    }

    #[test]
    fn write_returns_fast_when_child_ignores_stdin() {
        let fx = fixture();
        // Raw mode, like any TUI: unread input fills the pty queue.
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "stty raw -echo; printf ready; sleep 5"), None).unwrap();
        assert!(wait_until(|| scrollback(&fx, &s.id).contains("ready")));
        let t = Instant::now();
        fx.mgr.write(&s.id, &[b'x'; 128 * 1024]).unwrap();
        fx.mgr.approve(&s.id).unwrap_err(); // not waiting; must not block either
        fx.mgr.write(&s.id, b"\r").unwrap();
        assert!(t.elapsed() < Duration::from_millis(100), "write blocked for {:?}", t.elapsed());
    }

    #[test]
    fn one_session_per_builder() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "sleep 5"), None).unwrap();
        assert!(fx.mgr.start_agent(&fx.ws, &custom("b1", "sleep 5"), None).is_err());
        assert_eq!(fx.mgr.live_count(), 1);
        // Once stopped (Ended), the builder is free again.
        fx.mgr.stop(&s.id).unwrap();
        assert!(wait_until(|| matches!(state(&fx, &s.id), SessionState::Ended { .. })));
        assert_eq!(fx.mgr.live_count(), 0);
        assert!(fx.mgr.start_agent(&fx.ws, &custom("b1", "sleep 5"), None).is_ok());
    }

    #[test]
    fn hook_events_drive_state() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        fx.mgr.on_hook(&s.id, fixture_json("post_tool_use.json"));
        let info = fx.mgr.list().into_iter().find(|i| i.id == s.id).unwrap();
        assert_eq!((info.state, info.steps), (SessionState::Working, 1));
        fx.mgr.on_hook(&s.id, fixture_json("stop.json"));
        let info = fx.mgr.list().into_iter().find(|i| i.id == s.id).unwrap();
        assert_eq!(info.state, SessionState::Finished);
        assert!(info.reached_finished);
        assert!(fx.mgr.approve(&s.id).is_err(), "not waiting for approval");
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        assert!(matches!(state(&fx, &s.id), SessionState::NeedsYou { .. }));
        fx.mgr.approve(&s.id).unwrap();
        // Hooks for unknown sessions are ignored.
        fx.mgr.on_hook("nope", fixture_json("stop.json"));
    }

    fn info(fx: &Fx, id: &str) -> SessionInfo {
        fx.mgr.list().into_iter().find(|s| s.id == id).unwrap()
    }

    fn last_update(fx: &Fx, id: &str) -> SessionInfo {
        fx.events.lock().unwrap().iter().rev().find_map(|e| match e {
            ManagerEvent::Updated(i) if i.id == id => Some(i.clone()),
            _ => None,
        }).unwrap()
    }

    #[test]
    fn approve_resumes_working_and_answers_once() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        let i = info(&fx, &s.id);
        assert!(matches!(i.state, SessionState::NeedsYou { .. }) && i.awaiting_decision);
        fx.mgr.approve(&s.id).unwrap();
        let i = info(&fx, &s.id);
        assert_eq!((i.state.clone(), i.awaiting_decision), (SessionState::Working, false));
        assert!(wait_until(|| last_update(&fx, &s.id) == i), "Updated(Working) emitted");
        assert!(fx.mgr.approve(&s.id).is_err(), "already answered");
        assert!(fx.mgr.deny(&s.id).is_err(), "already answered");
    }

    #[test]
    fn deny_needs_typed_answer_until_asked_again() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        fx.mgr.deny(&s.id).unwrap();
        let i = info(&fx, &s.id);
        assert_eq!(i.state, SessionState::NeedsYou { reason: DENIED_REASON.into() });
        assert!(!i.awaiting_decision, "no live Allow/Deny after a deny");
        assert!(wait_until(|| last_update(&fx, &s.id) == i), "Updated emitted");
        assert!(fx.mgr.deny(&s.id).is_err());
        assert!(fx.mgr.approve(&s.id).is_err());
        // A new permission prompt re-arms the decision.
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        assert!(info(&fx, &s.id).awaiting_decision);
        fx.mgr.approve(&s.id).unwrap();
        assert_eq!(state(&fx, &s.id), SessionState::Working);
    }

    #[test]
    fn close_reports_xp_only_after_finished() {
        let fx = fixture();
        let a = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        fx.mgr.on_hook(&a.id, fixture_json("stop.json"));
        assert_eq!(fx.mgr.close(&a.id).unwrap(), CloseOutcome { earned_xp: true });
        let b = fx.mgr.start_with_spec(&fx.ws, &claude("b2"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        assert_eq!(fx.mgr.close(&b.id).unwrap(), CloseOutcome { earned_xp: false });
        assert!(fx.mgr.list().is_empty());
        assert!(fx.events.lock().unwrap().iter().any(|e| *e == ManagerEvent::Removed { id: a.id.clone() }));
        assert!(fx.mgr.close(&a.id).is_err());
        assert!(!fx.data_dir.join("sessions").join(&a.id).exists());
    }

    #[test]
    fn output_is_batched() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "yes | head -c 2000000"), None).unwrap();
        std::thread::sleep(Duration::from_secs(1));
        let n = fx.events.lock().unwrap().iter().filter(|e| matches!(e, ManagerEvent::Output { id, .. } if *id == s.id)).count();
        assert!(n > 0 && n < 100, "{n} output events");
        assert!(fx.mgr.attach(&s.id).unwrap().0.len() <= SCROLLBACK_CAP);
    }

    #[test]
    fn slow_emit_bounds_queued_output() {
        let fx = fixture_with(Duration::from_millis(50));
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "yes | head -c 20000000"), None).unwrap();
        let mut peak = 0;
        let end = Instant::now() + Duration::from_secs(60);
        while Instant::now() < end && !matches!(state(&fx, &s.id), SessionState::Ended { .. }) {
            peak = peak.max(fx.mgr.queued_output_bytes(&s.id));
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(state(&fx, &s.id), SessionState::Ended { exit_code: Some(0) });
        assert!(peak <= 2 * SCROLLBACK_CAP, "peak queued output {peak} bytes");
        assert!(peak > 0);
    }

    #[test]
    fn output_offsets_are_contiguous() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf aaaa; sleep 0.1; printf bbbb; sleep 0.1; printf cccc; sleep 0.4; printf dddd; sleep 5"), None).unwrap();
        assert!(wait_until(|| output(&fx, &s.id).contains("aaaa")));
        // Attach mid-stream: the snapshot ends exactly where the next Output begins.
        let (snap, start) = fx.mgr.attach(&s.id).unwrap();
        let end = start + snap.len() as u64;
        assert!(wait_until(|| output(&fx, &s.id).contains("dddd")));
        let evs: Vec<(u64, usize)> = fx.events.lock().unwrap().iter().filter_map(|e| match e {
            ManagerEvent::Output { id, offset, data } if *id == s.id => Some((*offset, data.len())),
            _ => None,
        }).collect();
        assert!(evs.len() >= 2, "{evs:?}");
        assert_eq!(evs[0].0, 0);
        for w in evs.windows(2) {
            assert_eq!(w[1].0, w[0].0 + w[0].1 as u64, "{evs:?}");
        }
        assert!(evs.iter().any(|(o, _)| *o == end), "attach end {end} not an Output boundary: {evs:?}");
    }

    #[test]
    fn silence_tick_finishes_plain_agent() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf hi; sleep 30"), None).unwrap();
        assert!(wait_until(|| output(&fx, &s.id).contains("hi") && state(&fx, &s.id) == SessionState::Working));
        fx.mgr.tick(now_ms() + 21_000);
        assert_eq!(state(&fx, &s.id), SessionState::Finished);
    }

    #[test]
    fn hook_cwd_in_worktree_sets_branch() {
        let fx = fixture();
        crate::git::test_util::repo_with_commit(&fx.ws.path);
        let wt = fx.ws.path.parent().unwrap().join("wt");
        crate::git::test_util::git(&fx.ws.path, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "feature"]);
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        std::fs::write(wt.join("a.txt"), "1\n2\n3\n").unwrap();
        fx.mgr.on_hook(&s.id, serde_json::json!({"hook_event_name": "PostToolUse", "cwd": wt}));
        assert!(wait_until(|| fx.mgr.list()[0].worktree.as_ref().and_then(|w| w.branch.clone()).as_deref() == Some("feature")));
        let r = fx.mgr.review(&s.id).unwrap();
        assert_eq!(r.branch.as_deref(), Some("feature"));
        assert_eq!(r.files.len(), 1);
        assert_eq!((r.files[0].added, r.files[0].removed), (2, 0));
        assert!(!r.other_sessions_active);
        let t = fx.mgr.start_with_spec(&fx.ws, &claude("b2"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        assert!(fx.mgr.review(&s.id).unwrap().other_sessions_active);
        fx.mgr.close(&t.id).unwrap();
    }

    #[test]
    fn command_preview_quotes_args() {
        let spec = LaunchSpec {
            program: "/bin/sh".into(),
            args: vec!["-lc".into(), "echo \"$@\"".into(), "it's".into()],
            env: vec![],
            cwd: PathBuf::from("/"),
        };
        assert_eq!(command_preview(&spec), r#"/bin/sh -lc 'echo "$@"' 'it'\''s'"#);
    }
}
