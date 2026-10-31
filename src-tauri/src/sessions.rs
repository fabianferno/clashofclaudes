//! SessionManager: owns every session's PTY, scrollback and status.
use crate::adapters::{terminal_launch, terminal_policy, AdapterRegistry, AgentAdapter, LaunchRequest, ScreenPrompt};
use crate::git::{self, GitBaseline, Review};
use crate::hooks::HookServer;
use crate::model::{Builder, SessionInfo, SessionKind, SessionState, Tile, Workspace, WorktreeInfo};
use crate::pty::{LaunchSpec, PtyHandle, REAP_POLL};
use crate::scrollback::{Scrollback, SCROLLBACK_CAP};
use crate::status::{is_terminal_report_only, next_state, screen_text, StatusEvent, StatusPolicy};
use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::collections::VecDeque;
use std::sync::mpsc::{self, Sender};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq)]
pub enum ManagerEvent {
    Updated(SessionInfo),
    /// `offset`: stream position (bytes since session start) of the first byte of `data`.
    Output { id: String, offset: u64, data: Vec<u8> },
    Removed { id: String },
    /// Output before `offset` was dropped (the frontend fell too far behind); shown as a marker.
    Skipped { id: String, offset: u64 },
}

pub type Emit = Arc<dyn Fn(ManagerEvent) + Send + Sync>;

/// The facts about a session at the moment it was closed; the XP rules live in `commands::apply_close`.
#[derive(Clone, Debug, PartialEq)]
pub struct ClosedSession {
    pub workspace_id: String,
    pub is_agent: bool,
    pub reached_finished: bool,
    pub stuck: bool,
}

/// Initial PTY size until the UI sends a resize.
const INITIAL_COLS: u16 = 120;
const INITIAL_ROWS: u16 = 32;
/// At most one `Output` event per session per this interval.
const FLUSH_EVERY: Duration = Duration::from_millis(16);
const TICK_EVERY: Duration = Duration::from_secs(1);
/// Screen prompts are looked for in this much of the newest output.
const PROMPT_WINDOW: usize = 8 * 1024;
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
    /// Output not yet sent as a frame; only collected while a terminal is attached.
    pending: VecDeque<u8>,
    /// Total bytes the process has ever written; `pending` is always the stream's newest suffix.
    out_total: u64,
    /// A terminal view is attached: output is sent as frames (otherwise it only goes to scrollback).
    attached: bool,
    /// Stream range `[start, end)` of the one sent frame the frontend has not acked yet.
    in_flight: Option<(u64, u64)>,
    /// Pending bytes were dropped since the last frame (a skip marker precedes the next one).
    skipped: bool,
    last_flush: Instant,
    /// Silence is measured from the latest output or state change.
    quiet_since_ms: i64,
    /// Last hook cwd sent for worktree detection (avoids re-running git per hook).
    checked_cwd: Option<PathBuf>,
    /// The adapter's screen prompts (empty for terminals and most agents: no scanning then).
    prompts: Vec<ScreenPrompt>,
    /// The prompt currently on screen; set while it is armed (and until it leaves the window).
    active_prompt: Option<ScreenPrompt>,
    /// Needle of the prompt seen in the window last time, so one that stays visible after an
    /// answer (old bytes linger in the window) is not armed again.
    prompt_seen: Option<&'static str>,
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
        if matches!(ev, StatusEvent::PermissionRequested { .. }) || !awaiting {
            self.active_prompt = None; // a hook prompt uses the adapter's normal keys
        }
        if awaiting != self.info.awaiting_decision {
            self.info.awaiting_decision = awaiting;
            changed = true;
        }
        changed
    }

    /// Looks for the adapter's screen prompts in the newest output; returns true when `info`
    /// changed. Cheap for sessions without prompts (no work at all).
    fn scan_prompts(&mut self, now: i64) -> bool {
        if self.prompts.is_empty() {
            return false;
        }
        let text = screen_text(&self.scrollback.tail(PROMPT_WINDOW));
        let found = self.prompts.iter().find(|p| text.contains(p.needle)).copied();
        let was_seen = std::mem::replace(&mut self.prompt_seen, found.map(|p| p.needle));
        match found {
            Some(p) if was_seen != Some(p.needle) && self.is_live() && !matches!(self.info.state, SessionState::NeedsYou { .. }) => {
                self.info.state = SessionState::NeedsYou { reason: p.reason.into() };
                self.info.awaiting_decision = true;
                self.active_prompt = Some(p);
                self.quiet_since_ms = now;
                true
            }
            Some(_) => false,
            None => {
                // The prompt is gone: drop it; hooks and output move the state on from here.
                let was_active = self.active_prompt.take().is_some();
                was_active && std::mem::take(&mut self.info.awaiting_decision)
            }
        }
    }

    /// Flow control: at most one un-acked `Output` per session, so the webview (not just this
    /// process) bounds what is buffered. While one is in flight, bytes accumulate in `pending`
    /// (capped in `on_output`) and the flush after the frontend's `ack` sends them.
    fn flush(&mut self, tx: &Sender<ManagerEvent>) {
        if !self.attached || self.in_flight.is_some() {
            return;
        }
        self.last_flush = Instant::now();
        if self.pending.is_empty() {
            return;
        }
        let offset = self.out_total - self.pending.len() as u64;
        if std::mem::take(&mut self.skipped) {
            let _ = tx.send(ManagerEvent::Skipped { id: self.info.id.clone(), offset });
        }
        let data = Vec::from(std::mem::take(&mut self.pending));
        self.in_flight = Some((offset, offset + data.len() as u64));
        let _ = tx.send(ManagerEvent::Output { id: self.info.id.clone(), offset, data });
    }

    /// Stops framing output (no terminal attached, or a new one replaces the old).
    fn reset_stream(&mut self) {
        self.pending.clear();
        self.in_flight = None;
        self.skipped = false;
    }

    fn is_live(&self) -> bool {
        !matches!(self.info.state, SessionState::Ended { .. })
    }
}

type Sessions = HashMap<String, SessionEntry>;

/// Locking: one mutex over all sessions. Events are sent into a channel while the lock is
/// held (so their order matches the state order) and a dedicated thread calls `emit`, so
/// `emit` never runs under the lock. PTY kills, git and file IO run outside the lock; PTY
/// writes only enqueue (see `PtyHandle`), so they may happen under it.
/// Queued output per session is bounded: one un-acked `Output` plus `pending`, each at most
/// `SCROLLBACK_CAP` bytes.
pub struct SessionManager {
    registry: AdapterRegistry,
    hooks: Arc<HookServer>,
    data_dir: PathBuf,
    sessions: Mutex<Sessions>,
    tx: Sender<ManagerEvent>,
    weak: Weak<SessionManager>,
    flusher: Arc<FlushWake>,
}

/// Parks the flush loop while no session can produce output, so a hidden, idle app uses no CPU.
/// Shared with the loop's thread, which holds only a `Weak` manager: a parked loop keeps
/// nothing alive. Lock order: the sessions lock, then `state`.
#[derive(Default)]
struct FlushWake {
    state: Mutex<FlushState>,
    cv: Condvar,
    /// Loop iterations run (tests check that a parked loop stays flat).
    iterations: AtomicU64,
}

#[derive(Default)]
struct FlushState {
    active: bool,
    /// The manager is gone: the loop ends.
    closed: bool,
}

impl FlushWake {
    fn lock(&self) -> MutexGuard<'_, FlushState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wake(&self) {
        let mut st = self.lock();
        if !st.active {
            st.active = true;
            self.cv.notify_one();
        }
    }

    /// Blocks while parked; false once the manager is gone.
    fn wait_active(&self) -> bool {
        let mut st = self.lock();
        while !st.active && !st.closed {
            st = self.cv.wait(st).unwrap_or_else(|e| e.into_inner());
        }
        !st.closed
    }
}

impl SessionManager {
    pub fn new(registry: AdapterRegistry, hooks: Arc<HookServer>, data_dir: PathBuf, emit: Emit) -> Arc<SessionManager> {
        let (tx, rx) = mpsc::channel::<ManagerEvent>();
        // Ends when the manager (the only sender) is dropped.
        std::thread::spawn(move || {
            for ev in rx {
                emit(ev);
            }
        });
        let mgr = Arc::new_cyclic(|weak| SessionManager {
            registry,
            hooks,
            data_dir,
            sessions: Mutex::new(HashMap::new()),
            tx,
            weak: weak.clone(),
            flusher: Arc::default(),
        });
        // Output flushes every 16 ms and the 1 s silence tick, parked while no session has a
        // process or unsent output (see `park_if_idle`); ends once the manager is gone.
        let weak = Arc::downgrade(&mgr);
        let flusher = mgr.flusher.clone();
        std::thread::spawn(move || {
            let mut last_tick = Instant::now();
            while flusher.wait_active() {
                std::thread::sleep(FLUSH_EVERY);
                let Some(m) = weak.upgrade() else { break };
                flusher.iterations.fetch_add(1, AtomicOrdering::Relaxed);
                m.flush_due();
                if last_tick.elapsed() >= TICK_EVERY {
                    last_tick = Instant::now();
                    m.tick(now_ms());
                }
                m.park_if_idle();
            }
        });
        mgr
    }

    fn lock(&self) -> MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Stamps the next `rev` and queues the update; every emitted info goes through here.
    fn send_updated(&self, e: &mut SessionEntry) {
        e.info.rev += 1;
        let _ = self.tx.send(ManagerEvent::Updated(e.info.clone()));
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
            rev: 0,
            spot: None,
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
                policy,
                baseline,
                pending: VecDeque::new(),
                out_total: 0,
                attached: false,
                in_flight: None,
                skipped: false,
                last_flush: Instant::now(),
                quiet_since_ms: now,
                checked_cwd: None,
                prompts: adapter.as_ref().map(|a| a.screen_prompts()).unwrap_or_default(),
                active_prompt: None,
                prompt_seen: None,
                adapter,
            });
            self.flusher.wake(); // under the sessions lock, so `park_if_idle` can't miss it
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
        let changed = e.apply(&StatusEvent::Output, now);
        if e.scan_prompts(now) || changed {
            self.send_updated(e);
        }
        e.out_total += data.len() as u64;
        if !e.attached {
            return;
        }
        e.pending.extend(data);
        // A frontend this far behind loses the oldest bytes (marked in-band); re-attaching
        // replays scrollback.
        let over = e.pending.len().saturating_sub(SCROLLBACK_CAP);
        if over > 0 {
            e.pending.drain(..over);
            e.skipped = true;
        }
        if e.last_flush.elapsed() >= FLUSH_EVERY {
            e.flush(&self.tx);
        }
        if !e.pending.is_empty() {
            self.flusher.wake(); // e.g. output drained after the exit, while the loop is parked
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

    /// Parks the flush loop when nothing can need it: no session has a running (or starting)
    /// process or unsent output. Spawning, output and acks wake it again.
    fn park_if_idle(&self) {
        let g = self.lock();
        if g.values().all(|e| e.exited && e.pending.is_empty()) {
            self.flusher.lock().active = false;
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
            let events = adapter.parse_hook(&body);
            if !events.is_empty() {
                e.policy = e.policy.after_first_event();
            }
            for ev in events {
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
        let mut g = self.lock();
        if let Some(e) = g.get_mut(id) {
            let mut changed = data.contains(&b'\r') && e.apply(&StatusEvent::UserInput, now_ms());
            // Typing (not xterm's automatic query replies) means the user is answering in the terminal; the panel stops offering Allow/Deny.
            if !is_terminal_report_only(data) && std::mem::take(&mut e.info.awaiting_decision) {
                e.active_prompt = None;
                changed = true;
            }
            if changed {
                self.send_updated(e);
            }
        }
        Ok(())
    }

    /// A no-op once the process has exited: a read-only view of a finished session is not an error.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let pty = {
            let g = self.lock();
            g.get(id).ok_or_else(|| anyhow!("unknown session {id}"))?.pty.clone()
        };
        match pty {
            Some(p) => p.resize(cols, rows),
            None => Ok(()),
        }
    }

    /// Answers the open permission prompt with yes; the session reads as `Working` at once
    /// (the tool runs with no further hook until it finishes).
    pub fn approve(&self, id: &str) -> Result<()> {
        self.answer(id, true)
    }

    /// Answers the open permission prompt with no. The agent then waits for typed
    /// instructions and no hook fires, so the session stays `NeedsYou` with `DENIED_REASON`.
    pub fn deny(&self, id: &str) -> Result<()> {
        self.answer(id, false)
    }

    /// One answer per prompt: a second approve/deny errs until a new `PermissionRequested`.
    fn answer(&self, id: &str, approve: bool) -> Result<()> {
        let mut g = self.lock();
        let e = g.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
        // A screen prompt (e.g. the trust menu) has its own keys; otherwise the adapter's.
        let keys = match (&e.active_prompt, e.adapter.as_deref()) {
            (Some(p), _) => Some(if approve { p.approve } else { p.deny }),
            (None, Some(a)) => if approve { a.approve_keys() } else { a.deny_keys() },
            (None, None) => None,
        }
        .filter(|k| !k.is_empty()) // a prompt with no keys is answered in the terminal
        .ok_or_else(|| anyhow!("this agent can't be answered from the app; open the terminal"))?;
        if !e.info.awaiting_decision || !matches!(e.info.state, SessionState::NeedsYou { .. }) {
            bail!("session is not waiting for approval");
        }
        let pty = e.pty.clone().ok_or_else(|| anyhow!("session is not running"))?;
        pty.write(keys)?; // only enqueues, so it is fine under the lock
        e.info.awaiting_decision = false;
        let screen_prompt = e.active_prompt.take().is_some();
        if approve {
            e.info.state = SessionState::Working;
        } else if !screen_prompt {
            e.info.state = SessionState::NeedsYou { reason: DENIED_REASON.into() };
        } // denying a screen prompt (trust menu) exits the agent: the exit moves the state on
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

    pub fn close(&self, id: &str) -> Result<ClosedSession> {
        let entry = {
            let mut g = self.lock();
            let e = g.remove(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
            let _ = self.tx.send(ManagerEvent::Removed { id: id.to_string() });
            e
        };
        let closed = ClosedSession {
            workspace_id: entry.info.workspace_id.clone(),
            is_agent: matches!(entry.info.kind, SessionKind::Agent { .. }),
            reached_finished: entry.info.reached_finished,
            stuck: matches!(entry.info.state, SessionState::Stuck { .. }),
        };
        if let Some(p) = &entry.pty {
            let _ = p.kill();
        }
        self.hooks.unregister(id);
        self.remove_session_dir(id);
        drop(entry); // releases the PTY fds
        Ok(closed)
    }

    /// Records where the session's builder stands; emitted like any other update.
    pub fn set_spot(&self, id: &str, spot: Tile) -> Result<SessionInfo> {
        let mut g = self.lock();
        let e = g.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
        e.info.spot = Some(spot);
        self.send_updated(e);
        Ok(e.info.clone())
    }

    /// Starts framing output for a terminal view: returns the scrollback snapshot plus the
    /// stream offset of its first byte; the next `Output` starts at `start + snapshot.len()`.
    /// Replaces any earlier attachment: pending bytes (already in the snapshot) are dropped and
    /// an un-acked frame no longer holds output back. A frame queued before this call may
    /// overlap the snapshot, so consumers drop bytes at stream positions already written.
    pub fn attach(&self, id: &str) -> Result<(Vec<u8>, u64)> {
        let mut g = self.lock();
        let e = g.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
        e.reset_stream();
        e.attached = true;
        let snap = e.scrollback.snapshot();
        let start = e.out_total - snap.len() as u64;
        Ok((snap, start))
    }

    /// The terminal view finished writing output up to stream position `offset`: once that
    /// covers the in-flight frame, the next frame may be sent. Acks from an older attachment
    /// can't release a newer frame, since stream offsets only grow.
    pub fn ack(&self, id: &str, offset: u64) -> Result<()> {
        let mut g = self.lock();
        let e = g.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
        if e.in_flight.is_some_and(|(_, end)| offset >= end) {
            e.in_flight = None;
            if !e.pending.is_empty() && e.last_flush.elapsed() >= FLUSH_EVERY {
                e.flush(&self.tx);
            }
            if !e.pending.is_empty() {
                self.flusher.wake();
            }
        }
        Ok(())
    }

    /// No terminal view shows this session any more: output only goes to scrollback.
    pub fn detach(&self, id: &str) -> Result<()> {
        let mut g = self.lock();
        let e = g.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
        e.reset_stream();
        e.attached = false;
        Ok(())
    }

    /// Output bytes buffered or queued for `emit` but not yet delivered.
    #[cfg(test)]
    fn queued_output_bytes(&self, id: &str) -> usize {
        let g = self.lock();
        g.get(id).map_or(0, |e| e.pending.len() + e.in_flight.map_or(0, |(a, b)| (b - a) as usize))
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

    /// Sessions whose process is still running (or starting); what quitting would kill.
    pub fn running_process_count(&self) -> usize {
        self.lock().values().filter(|e| !e.exited).count()
    }

    /// Quitting: closes every session (SIGHUP to each process group), waits up to `grace` for
    /// the processes to exit, then SIGKILLs the groups whose leader is still alive. Blocks for
    /// about `grace` at most (less when everything exits on SIGHUP); keep it off the UI thread.
    pub fn shutdown(&self, grace: Duration) {
        let ptys: Vec<Arc<PtyHandle>> = self.lock().values().filter_map(|e| e.pty.clone()).collect();
        for s in self.list() {
            let _ = self.close(&s.id);
        }
        let end = Instant::now() + grace;
        while Instant::now() < end && ptys.iter().any(|p| !p.has_exited()) {
            std::thread::sleep(REAP_POLL);
        }
        for p in &ptys {
            p.kill_now();
        }
    }

    /// Removes `<data>/sessions/<id>` dirs that no session owns: left behind by a crash or a
    /// forced quit (sessions never outlive the app). Only real directories whose name is a
    /// session id (a lowercase hyphenated UUID) are touched; symlinks are never followed.
    /// Returns what was removed. Run at startup.
    pub fn sweep_stale_session_dirs(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(self.data_dir.join("sessions")) else { return vec![] };
        let mut removed = Vec::new();
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else { continue };
            let is_id = Uuid::try_parse(&name).is_ok_and(|u| u.hyphenated().to_string() == name);
            // `DirEntry::file_type` does not follow symlinks.
            let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
            if !is_id || !is_dir || self.lock().contains_key(&name) {
                continue;
            }
            let path = entry.path();
            match std::fs::remove_dir_all(&path) {
                Ok(()) => {
                    eprintln!("removed stale session dir {}", path.display());
                    removed.push(path);
                }
                Err(err) => eprintln!("could not remove stale session dir {}: {err}", path.display()),
            }
        }
        removed.sort();
        removed
    }

    #[cfg(test)]
    fn flush_loop_iterations(&self) -> u64 {
        self.flusher.iterations.load(AtomicOrdering::Relaxed)
    }

    fn remove_session_dir(&self, id: &str) {
        let _ = std::fs::remove_dir_all(self.data_dir.join("sessions").join(id));
    }
}

impl Drop for SessionManager {
    /// No child outlives the manager.
    fn drop(&mut self) {
        self.flusher.lock().closed = true;
        self.flusher.cv.notify_one();
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
    use crate::pty::KILL_GRACE;

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
        fixture_with(Duration::ZERO, true)
    }

    /// A recording `emit` standing in for an attached terminal. `output_delay`: how long it
    /// blocks on each `Output` (a slow frontend); `auto_ack`: whether it then acks the frame.
    fn fixture_with(output_delay: Duration, auto_ack: bool) -> Fx {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let hooks = Arc::new(rt.block_on(HookServer::start(Arc::new(|_, _| {}))).unwrap());
        let events: Events = Arc::default();
        let e2 = events.clone();
        let cell: Arc<std::sync::OnceLock<Weak<SessionManager>>> = Arc::default();
        let c2 = cell.clone();
        let emit: Emit = Arc::new(move |ev| {
            let ack = match &ev {
                ManagerEvent::Output { id, offset, data } => {
                    std::thread::sleep(output_delay);
                    auto_ack.then(|| (id.clone(), offset + data.len() as u64))
                }
                _ => None,
            };
            e2.lock().unwrap().push(ev);
            if let Some((id, end)) = ack {
                if let Some(m) = c2.get().and_then(Weak::upgrade) {
                    let _ = m.ack(&id, end);
                }
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let ws_path = dir.path().join("ws");
        std::fs::create_dir(&ws_path).unwrap();
        let data_dir = dir.path().join("data");
        let mgr = SessionManager::new(AdapterRegistry::new(), hooks, data_dir.clone(), emit);
        let _ = cell.set(Arc::downgrade(&mgr));
        let ws = Workspace { id: "w1".into(), name: "ws".into(), path: ws_path, created_at: 0, missing: false, level: 1, xp: 0, compound: None };
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

    /// (offset, len) of every `Output` for `id`, in emit order.
    fn frames(fx: &Fx, id: &str) -> Vec<(u64, usize)> {
        fx.events.lock().unwrap().iter().filter_map(|e| match e {
            ManagerEvent::Output { id: i, offset, data } if i == id => Some((*offset, data.len())),
            _ => None,
        }).collect()
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
        assert!(wait_until(|| scrollback(&fx, &s.id).contains("ok")));
    }

    #[test]
    fn immediate_nonzero_exit_goes_stuck() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf boom; exit 7"), None).unwrap();
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::Stuck { reason: "exited with code 7".into() }));
        assert!(String::from_utf8_lossy(&fx.mgr.attach(&s.id).unwrap().0).contains("boom"));
        assert!(fx.mgr.write(&s.id, b"x").is_err(), "no process to write to");
        assert!(fx.mgr.resize(&s.id, 100, 30).is_ok(), "viewing an exited session resizes nothing, quietly");
        assert!(fx.mgr.resize("nope", 100, 30).is_err());
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
    fn quit_guard_counts_only_running_processes() {
        let fx = fixture();
        let a = fx.mgr.start_agent(&fx.ws, &custom("b1", "exit 4"), None).unwrap();
        fx.mgr.start_agent(&fx.ws, &custom("b2", "sleep 5"), None).unwrap();
        assert!(wait_until(|| matches!(state(&fx, &a.id), SessionState::Stuck { .. })));
        assert_eq!(fx.mgr.live_count(), 2, "a crashed session is still listed as live");
        assert_eq!(fx.mgr.running_process_count(), 1, "but quitting would only kill one process");
    }

    #[test]
    fn terminal_ends_on_any_exit() {
        let fx = fixture();
        let s = fx.mgr.start_terminal(&fx.ws).unwrap();
        fx.mgr.write(&s.id, b"exit 3\r").unwrap();
        assert!(wait_until(|| fx.mgr.running_process_count() == 0));
        assert_eq!(state(&fx, &s.id), SessionState::Ended { exit_code: Some(3) });
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

    fn last_update(fx: &Fx, id: &str) -> Option<SessionInfo> {
        fx.events.lock().unwrap().iter().rev().find_map(|e| match e {
            ManagerEvent::Updated(i) if i.id == id => Some(i.clone()),
            _ => None,
        })
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
        assert!(wait_until(|| last_update(&fx, &s.id).as_ref() == Some(&i)), "Updated(Working) emitted");
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
        assert!(wait_until(|| last_update(&fx, &s.id).as_ref() == Some(&i)), "Updated emitted");
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
        let closed = fx.mgr.close(&a.id).unwrap();
        assert_eq!(closed, ClosedSession { workspace_id: "w1".into(), is_agent: true, reached_finished: true, stuck: false });
        let b = fx.mgr.start_with_spec(&fx.ws, &claude("b2"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        let closed = fx.mgr.close(&b.id).unwrap();
        assert!(closed.is_agent && !closed.reached_finished);
        assert!(fx.mgr.list().is_empty());
        assert!(fx.events.lock().unwrap().iter().any(|e| *e == ManagerEvent::Removed { id: a.id.clone() }));
        assert!(fx.mgr.close(&a.id).is_err());
        assert!(!fx.data_dir.join("sessions").join(&a.id).exists());
    }

    #[test]
    fn set_spot_emits_an_update_and_rejects_unknown() {
        let fx = fixture();
        let a = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        let before = info(&fx, &a.id).rev;
        let got = fx.mgr.set_spot(&a.id, Tile { x: 3, y: 4 }).unwrap();
        assert_eq!(got.spot, Some(Tile { x: 3, y: 4 }));
        assert!(got.rev > before);
        assert!(wait_until(|| info(&fx, &a.id).spot == Some(Tile { x: 3, y: 4 })), "Updated emitted");
        assert!(fx.mgr.set_spot("nope", Tile { x: 0, y: 0 }).is_err());
    }

    #[test]
    fn output_is_batched() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "yes | head -c 2000000"), None).unwrap();
        fx.mgr.attach(&s.id).unwrap();
        std::thread::sleep(Duration::from_secs(1));
        let n = fx.events.lock().unwrap().iter().filter(|e| matches!(e, ManagerEvent::Output { id, .. } if *id == s.id)).count();
        assert!(n > 0 && n < 100, "{n} output events");
        assert!(fx.mgr.attach(&s.id).unwrap().0.len() <= SCROLLBACK_CAP);
    }

    #[test]
    fn slow_emit_bounds_queued_output() {
        let fx = fixture_with(Duration::from_millis(50), true);
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "yes | head -c 20000000"), None).unwrap();
        fx.mgr.attach(&s.id).unwrap();
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
        let (snap, start) = fx.mgr.attach(&s.id).unwrap();
        assert!(wait_until(|| (String::from_utf8_lossy(&snap).into_owned() + &output(&fx, &s.id)).ends_with("dddd")));
        // Frames continue exactly where the snapshot ends, with no gaps.
        let evs = frames(&fx, &s.id);
        let mut at = start + snap.len() as u64;
        for (o, n) in &evs {
            assert_eq!(*o, at, "{evs:?}");
            at += *n as u64;
        }
        let all = String::from_utf8_lossy(&snap).into_owned() + &output(&fx, &s.id);
        assert_eq!(all, "aaaabbbbccccdddd");
        // Re-attaching mid-stream: the new snapshot ends where the stream is.
        let (snap2, start2) = fx.mgr.attach(&s.id).unwrap();
        assert_eq!((start2, snap2.len()), (0, 16));
    }

    #[test]
    fn detached_session_emits_no_frames() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf hello; sleep 5"), None).unwrap();
        assert!(wait_until(|| scrollback(&fx, &s.id).contains("hello")));
        std::thread::sleep(FLUSH_EVERY * 4);
        assert!(frames(&fx, &s.id).is_empty(), "output only goes to scrollback");
        assert_eq!(fx.mgr.queued_output_bytes(&s.id), 0);
    }

    #[test]
    fn unacked_frame_holds_back_output_until_ack() {
        let fx = fixture_with(Duration::ZERO, false);
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf start; sleep 0.3; yes | head -c 8000000; printf END; sleep 5"), None).unwrap();
        fx.mgr.attach(&s.id).unwrap();
        assert!(wait_until(|| !frames(&fx, &s.id).is_empty()));
        let mut peak = 0;
        let end = Instant::now() + Duration::from_secs(60);
        while Instant::now() < end && !scrollback(&fx, &s.id).ends_with("END") {
            peak = peak.max(fx.mgr.queued_output_bytes(&s.id));
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(scrollback(&fx, &s.id).ends_with("END"), "producer finished");
        std::thread::sleep(FLUSH_EVERY * 4);
        peak = peak.max(fx.mgr.queued_output_bytes(&s.id));
        assert!(peak <= 2 * SCROLLBACK_CAP, "peak queued output {peak} bytes");
        let evs = frames(&fx, &s.id);
        assert_eq!(evs.len(), 1, "only one frame outstanding without an ack: {:?}", &evs[..evs.len().min(5)]);
        // Acking the frame lets the next one through, preceded by one skip marker at its offset.
        fx.mgr.ack(&s.id, evs[0].0 + evs[0].1 as u64).unwrap();
        assert!(wait_until(|| frames(&fx, &s.id).len() == 2));
        let ev = fx.events.lock().unwrap();
        let out: Vec<&ManagerEvent> = ev.iter().filter(|e| matches!(e, ManagerEvent::Output { .. } | ManagerEvent::Skipped { .. })).collect();
        assert_eq!(out.len(), 3, "{:?}", out.iter().map(|e| std::mem::discriminant(*e)).collect::<Vec<_>>());
        let ManagerEvent::Skipped { offset: skip_at, .. } = out[1] else { panic!("expected a skip marker before the next frame") };
        let ManagerEvent::Output { offset, data, .. } = out[2] else { panic!("expected the next frame") };
        assert_eq!(skip_at, offset);
        assert!(String::from_utf8_lossy(data).ends_with("END"), "the newest output survives the drop");
    }

    #[test]
    fn detach_clears_the_outstanding_frame() {
        let fx = fixture_with(Duration::ZERO, false);
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf one; sleep 0.3; printf two; sleep 5"), None).unwrap();
        fx.mgr.attach(&s.id).unwrap();
        assert!(wait_until(|| scrollback(&fx, &s.id).contains("two")));
        std::thread::sleep(FLUSH_EVERY * 4);
        assert!(fx.mgr.queued_output_bytes(&s.id) > 0);
        fx.mgr.detach(&s.id).unwrap();
        assert_eq!(fx.mgr.queued_output_bytes(&s.id), 0);
        // Re-attaching starts a fresh window: the next output flows without an ack.
        fx.mgr.attach(&s.id).unwrap();
        let before = frames(&fx, &s.id).len();
        fx.mgr.on_output(&s.id, b"three");
        assert!(wait_until(|| frames(&fx, &s.id).len() == before + 1));
    }

    #[test]
    fn silence_tick_finishes_plain_agent() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf hi; sleep 30"), None).unwrap();
        assert!(wait_until(|| scrollback(&fx, &s.id).contains("hi") && state(&fx, &s.id) == SessionState::Working));
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

    fn codex_builder(id: &str) -> Builder {
        Builder { id: id.into(), name: id.into(), agent: AgentKind::Codex, model: None, effort: None, custom_command: None }
    }

    #[test]
    fn codex_notify_switches_off_silence_finish() {
        use crate::adapters::CodexAdapter;
        let fx = fixture();
        let a = fx.mgr.start_with_spec(&fx.ws, &codex_builder("c1"), sh(&fx, "printf hi; sleep 5"), Arc::new(CodexAdapter)).unwrap();
        let b = fx.mgr.start_with_spec(&fx.ws, &codex_builder("c2"), sh(&fx, "printf hi; sleep 5"), Arc::new(CodexAdapter)).unwrap();
        assert!(wait_until(|| state(&fx, &a.id) == SessionState::Working && state(&fx, &b.id) == SessionState::Working));
        // A notify for b arrives, then the turn is over and the user starts another one.
        fx.mgr.on_hook(&b.id, serde_json::json!({"type": "agent-turn-complete"}));
        assert_eq!(state(&fx, &b.id), SessionState::Finished);
        fx.mgr.write(&b.id, b"go\r").unwrap();
        assert_eq!(state(&fx, &b.id), SessionState::Working);
        let later = now_ms() + 120_000;
        fx.mgr.tick(later);
        assert_eq!(state(&fx, &a.id), SessionState::Finished, "no notify yet: silence finishes");
        assert_eq!(state(&fx, &b.id), SessionState::Working, "after a notify, silence never finishes");
    }

    #[test]
    fn empty_key_prompt_cannot_be_answered_from_the_app() {
        use crate::adapters::CodexAdapter;
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &codex_builder("c1"), sh(&fx, "printf 'Yes, allow Codex to work in this folder'; sleep 5"), Arc::new(CodexAdapter)).unwrap();
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::NeedsYou { reason: "Trust this folder?".into() }));
        fx.mgr.approve(&s.id).unwrap_err();
        fx.mgr.deny(&s.id).unwrap_err();
        assert!(matches!(state(&fx, &s.id), SessionState::NeedsYou { .. }), "still waiting for the terminal");
    }

    /// Claude's launch/policy/prompts, but launched through an injected spec.
    struct PromptAdapter;
    impl AgentAdapter for PromptAdapter {
        fn kind(&self) -> AgentKind { AgentKind::Claude }
        fn label(&self) -> &'static str { "prompt-test" }
        fn detect(&self) -> crate::adapters::Detection { ClaudeAdapter.detect() }
        fn models(&self) -> Vec<String> { vec![] }
        fn efforts(&self) -> Vec<String> { vec![] }
        fn launch(&self, _: &LaunchRequest) -> Result<LaunchSpec> { unreachable!() }
        fn policy(&self) -> StatusPolicy { ClaudeAdapter.policy() }
        fn approve_keys(&self) -> Option<&'static [u8]> { ClaudeAdapter.approve_keys() }
        fn deny_keys(&self) -> Option<&'static [u8]> { ClaudeAdapter.deny_keys() }
        fn screen_prompts(&self) -> Vec<crate::adapters::ScreenPrompt> { ClaudeAdapter.screen_prompts() }
    }

    fn sh(fx: &Fx, script: &str) -> LaunchSpec {
        LaunchSpec { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()], env: vec![], cwd: fx.ws.path.clone() }
    }

    const TRUST_PRINT: &str = r"printf '\033[1m Yes,\033[0m I  trust\033[1C this folder'";

    #[test]
    fn rev_increments_on_each_update() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sh(&fx, "printf a; sleep 0.2; exit 3"), Arc::new(ClaudeAdapter)).unwrap();
        assert_eq!(s.rev, 1, "the first emitted info starts at 1");
        fx.mgr.on_hook(&s.id, fixture_json("post_tool_use.json"));
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        fx.mgr.write(&s.id, b"x").ok();
        assert!(wait_until(|| matches!(state(&fx, &s.id), SessionState::Stuck { .. })));
        assert!(wait_until(|| last_update(&fx, &s.id).is_some_and(|i| i.state == info(&fx, &s.id).state)));
        let revs: Vec<u64> = fx.events.lock().unwrap().iter().filter_map(|e| match e {
            ManagerEvent::Updated(i) if i.id == s.id => Some(i.rev),
            _ => None,
        }).collect();
        assert!(revs.len() >= 4, "{revs:?}");
        assert_eq!(revs[0], 1);
        assert!(revs.windows(2).all(|w| w[0] < w[1]), "{revs:?}");
        assert_eq!(info(&fx, &s.id).rev, *revs.last().unwrap());
    }

    #[test]
    fn trust_screen_prompt_goes_needs_you() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sh(&fx, &format!("{TRUST_PRINT}; sleep 5")), Arc::new(PromptAdapter)).unwrap();
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::NeedsYou { reason: "Trust this folder?".into() }));
        assert!(info(&fx, &s.id).awaiting_decision);
        assert!(wait_until(|| last_update(&fx, &s.id).is_some_and(|i| i.awaiting_decision)), "update emitted");
    }

    #[test]
    fn trust_prompt_approve_sends_down_enter() {
        let fx = fixture();
        let out = fx.ws.path.parent().unwrap().join("keys.txt");
        let script = format!("stty raw -echo; {TRUST_PRINT}; head -c 4 | cat -v > '{}'; sleep 5", out.display());
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sh(&fx, &script), Arc::new(PromptAdapter)).unwrap();
        assert!(wait_until(|| info(&fx, &s.id).awaiting_decision));
        fx.mgr.approve(&s.id).unwrap();
        assert_eq!(state(&fx, &s.id), SessionState::Working);
        assert!(wait_until(|| std::fs::read_to_string(&out).unwrap_or_default().contains("^[[B^M")),
            "got {:?}", std::fs::read_to_string(&out));
        // The old menu text is still in the tail; it must not re-arm.
        std::thread::sleep(Duration::from_millis(100));
        assert!(!info(&fx, &s.id).awaiting_decision);
        assert_eq!(state(&fx, &s.id), SessionState::Working);
    }

    #[test]
    fn typing_disarms_awaiting_decision() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        assert!(info(&fx, &s.id).awaiting_decision);
        fx.mgr.write(&s.id, b"1").unwrap();
        let i = info(&fx, &s.id);
        assert!(!i.awaiting_decision);
        assert!(matches!(i.state, SessionState::NeedsYou { .. }));
        assert!(wait_until(|| last_update(&fx, &s.id).as_ref() == Some(&i)), "Updated emitted");
        assert!(fx.mgr.approve(&s.id).is_err());
    }

    #[test]
    fn terminal_reports_do_not_disarm() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        fx.mgr.write(&s.id, b"\x1b[5;1R").unwrap();
        assert!(info(&fx, &s.id).awaiting_decision, "a cursor report is not the user answering");
        fx.mgr.write(&s.id, b"\x1b[B").unwrap();
        assert!(!info(&fx, &s.id).awaiting_decision);
    }

    /// pid printed as `pid:<n>` by a test script.
    fn printed_pid(fx: &Fx, id: &str) -> i32 {
        assert!(wait_until(|| scrollback(fx, id).contains("pid:") && scrollback(fx, id).split("pid:").nth(1).is_some_and(|t| t.contains('\n'))));
        scrollback(fx, id).split("pid:").nth(1).unwrap().split_whitespace().next().unwrap().parse().unwrap()
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only probes for existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn quit_kills_survivors_after_grace() {
        let fx = fixture();
        // Both the shell (the group leader) and its child ignore SIGHUP.
        let s = fx.mgr.start_with_spec(&fx.ws, &custom("b1", ""), sh(&fx, "trap '' HUP; sleep 30 & echo pid:$!; wait"), Arc::new(crate::adapters::CustomAdapter)).unwrap();
        let t = fx.mgr.start_terminal(&fx.ws).unwrap(); // exits on SIGHUP at once
        let grandchild = printed_pid(&fx, &s.id);
        let _ = t;
        let started = Instant::now();
        fx.mgr.shutdown(Duration::from_millis(500));
        let took = started.elapsed();
        // Reparented to launchd once its shell dies; give the reaper a moment.
        let end = Instant::now() + Duration::from_millis(500);
        while alive(grandchild) && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        let survived = alive(grandchild);
        if survived {
            unsafe { libc::kill(grandchild, libc::SIGKILL); }
        }
        assert!(!survived, "a SIGHUP-ignoring process survived shutdown");
        assert!(took >= Duration::from_millis(450), "waited the grace for the survivor: {took:?}");
        assert!(took < Duration::from_millis(1500), "then killed it promptly: {took:?}");
        assert!(fx.mgr.list().is_empty());
    }

    #[test]
    fn quit_returns_early_when_everything_exits_on_sighup() {
        let fx = fixture();
        fx.mgr.start_agent(&fx.ws, &custom("b1", "sleep 30"), None).unwrap();
        fx.mgr.start_terminal(&fx.ws).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        fx.mgr.shutdown(KILL_GRACE);
        assert!(started.elapsed() < Duration::from_secs(1), "no survivor, no full grace: {:?}", started.elapsed());
    }

    #[test]
    fn flush_loop_parks_without_sessions() {
        let fx = fixture();
        std::thread::sleep(Duration::from_millis(100));
        let a = fx.mgr.flush_loop_iterations();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(fx.mgr.flush_loop_iterations(), a, "the loop ran with no sessions");
        // The next start wakes it.
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf hi; sleep 0.3"), None).unwrap();
        assert!(wait_until(|| fx.mgr.flush_loop_iterations() > a + 5), "the loop woke for the session");
        // Once the only process has exited it parks again, even though the session is still listed.
        assert!(wait_until(|| fx.mgr.running_process_count() == 0));
        std::thread::sleep(Duration::from_millis(100));
        let b = fx.mgr.flush_loop_iterations();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(fx.mgr.flush_loop_iterations(), b, "the loop ran with only an exited session");
        assert_eq!(fx.mgr.list().len(), 1);
        fx.mgr.close(&s.id).unwrap();
        // And wakes again for the next one.
        fx.mgr.start_terminal(&fx.ws).unwrap();
        assert!(wait_until(|| fx.mgr.flush_loop_iterations() > b + 5));
    }

    #[test]
    fn parked_loop_still_flushes_output_after_wake() {
        let fx = fixture();
        std::thread::sleep(Duration::from_millis(100));
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf one; sleep 0.2; printf two; sleep 5"), None).unwrap();
        let (snap, _) = fx.mgr.attach(&s.id).unwrap();
        let snap = String::from_utf8_lossy(&snap).into_owned();
        assert!(wait_until(|| snap.clone() + &output(&fx, &s.id) == "onetwo"), "got {:?}", snap + &output(&fx, &s.id));
    }

    #[test]
    fn silent_custom_agent_finishes_after_20s() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &custom("b1", ""), sh(&fx, "sleep 30"), Arc::new(crate::adapters::CustomAdapter)).unwrap();
        let t0 = info(&fx, &s.id).started_at;
        fx.mgr.tick(t0 + 19_000);
        assert_eq!(state(&fx, &s.id), SessionState::Starting, "not yet");
        fx.mgr.tick(t0 + 20_000);
        assert_eq!(state(&fx, &s.id), SessionState::Finished);
        assert!(info(&fx, &s.id).reached_finished);
        assert!(wait_until(|| last_update(&fx, &s.id).is_some_and(|i| i.state == SessionState::Finished)), "Updated emitted");
    }

    #[test]
    fn silent_claude_session_stays_starting() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        fx.mgr.tick(info(&fx, &s.id).started_at + 60_000);
        assert_eq!(state(&fx, &s.id), SessionState::Starting, "hook agents wait for their hooks");
    }

    #[test]
    fn startup_sweeps_stale_session_dirs() {
        let fx = fixture();
        let sessions = fx.data_dir.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let live = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        let live_dir = sessions.join(&live.id);
        std::fs::create_dir(&live_dir).unwrap();
        std::fs::write(live_dir.join("claude-settings.json"), "{}").unwrap();
        let stale = sessions.join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(stale.join("nested")).unwrap();
        std::fs::write(stale.join("nested/claude-settings.json"), "{}").unwrap();
        let not_uuid = sessions.join("keep-me");
        std::fs::create_dir(&not_uuid).unwrap();
        let upper = sessions.join(Uuid::new_v4().to_string().to_uppercase());
        std::fs::create_dir(&upper).unwrap();
        let file = sessions.join(Uuid::new_v4().to_string());
        std::fs::write(&file, "x").unwrap();
        // A symlink named like a session must not be followed (its target is outside).
        let outside = fx.data_dir.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("precious"), "x").unwrap();
        let link = sessions.join(Uuid::new_v4().to_string());
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let removed = fx.mgr.sweep_stale_session_dirs();

        assert_eq!(removed, vec![stale.clone()]);
        assert!(!stale.exists());
        assert!(live_dir.join("claude-settings.json").exists(), "a live session keeps its dir");
        assert!(not_uuid.exists() && upper.exists() && file.exists());
        assert!(link.symlink_metadata().is_ok() && outside.join("precious").exists(), "symlink and its target untouched");
    }

    #[test]
    fn sweep_without_sessions_dir_is_a_no_op() {
        let fx = fixture();
        assert!(fx.mgr.sweep_stale_session_dirs().is_empty());
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
