//! SessionManager: owns every session's PTY, scrollback and status.
use crate::adapters::{task_with_images, terminal_launch, terminal_policy, AdapterRegistry, AgentAdapter, LaunchRequest, ScreenPrompt};
use crate::attachments;
use crate::git::{self, GitBaseline, Review};
use crate::hooks::HookServer;
use crate::osc::{Osc7501, SUPPORT_REPLY};
use crate::title::TitleScanner;
use crate::model::{Builder, SessionInfo, SessionKind, SessionState, Subagent, Tile, Workspace, WorktreeInfo};
use crate::pty::{LaunchSpec, PtyHandle, REAP_POLL};
use crate::saved::{self, SavedSession};
use crate::scrollback::{Scrollback, SCROLLBACK_CAP};
use crate::status::{is_terminal_report_only, next_state, screen_text, StatusEvent, StatusPolicy};
use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::collections::VecDeque;
use std::sync::mpsc::{self, Sender};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering as AtomicOrdering};
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
    /// An agent session whose conversation is known, as it stood (for the history); None otherwise.
    pub saved: Option<SavedSession>,
}

/// Initial PTY size until the UI sends a resize.
const INITIAL_COLS: u16 = 120;
const INITIAL_ROWS: u16 = 32;
/// At most one `Output` event per session per this interval.
const FLUSH_EVERY: Duration = Duration::from_millis(16);
const TICK_EVERY: Duration = Duration::from_secs(1);
/// Longest agent reply kept for the briefing, in characters (the end is kept).
const LAST_MESSAGE_MAX: usize = 4000;
/// Longest pending tool call kept, in characters.
const ASKING_MAX: usize = 400;
/// Why a session with an open picker (`questions`) needs the owner.
pub const QUESTION_REASON: &str = "Claude asks you a question";

/// `text` trimmed and cut to `max` characters (a long reply keeps its end: that is where the
/// summary and the question are).
fn cap_text(text: &str, max: usize) -> String {
    let t = text.trim();
    let n = t.chars().count();
    if n <= max {
        return t.to_string();
    }
    let tail: String = t.chars().skip(n - (max - 1)).collect();
    format!("…{}", tail.trim_start())
}

/// Screen prompts are looked for in this much of the newest output.
const PROMPT_WINDOW: usize = 8 * 1024;
pub use crate::status::DENIED_REASON;

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
    /// OSC 7501 status-report scanner, for adapters whose agent writes them (`reads_osc_status`).
    osc: Option<Osc7501>,
    /// An OSC 7501 support query arrived before the PTY handle was recorded; answered then.
    osc_reply_owed: bool,
    /// Window-title scanner, for agent sessions (the adapter decides what a title names).
    titles: Option<TitleScanner>,
    /// The agent's own conversation id, saved so a paused session can resume it.
    conversation: Option<String>,
    /// Restored paused, but its process was running when the app last closed: resumed at startup.
    was_running: bool,
    /// Restored paused: its state when the app last saved it running (`info.state` is Ended now).
    saved_state: Option<SessionState>,
}

impl SessionEntry {
    fn new(info: SessionInfo, workspace_path: PathBuf, adapter: Option<Arc<dyn AgentAdapter>>, policy: StatusPolicy, baseline: Option<GitBaseline>, now: i64) -> Self {
        SessionEntry {
            info,
            workspace_path,
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
            osc: adapter.as_ref().filter(|a| a.reads_osc_status()).map(|_| Osc7501::default()),
            osc_reply_owed: false,
            titles: adapter.as_ref().map(|_| TitleScanner::default()),
            adapter,
            conversation: None,
            was_running: false,
            saved_state: None,
        }
    }

    fn saved(&self) -> SavedSession {
        let i = &self.info;
        SavedSession {
            id: i.id.clone(),
            workspace_id: i.workspace_id.clone(),
            kind: i.kind.clone(),
            task: i.task.clone(),
            title: i.title.clone(),
            state: if i.paused { self.saved_state.clone() } else { Some(i.state.clone()) },
            started_at: i.started_at,
            steps: i.steps,
            reached_finished: i.reached_finished,
            spot: i.spot,
            worktree: i.worktree.clone(),
            conversation: self.conversation.clone(),
            rev: i.rev,
            // still owed its resume (restored, not started yet): it picks up at the next launch
            running: (!self.exited && !i.paused) || (i.paused && self.was_running),
            state_since: i.state_since,
            last_message: i.last_message.clone(),
            parked: i.parked.clone(),
        }
    }

    /// Feeds one status event; returns true when `info` changed.
    fn apply(&mut self, ev: &StatusEvent, now: i64) -> bool {
        let mut changed = false;
        // An open picker waits on the owner; it is answered with its options, not Allow/Deny
        // (Allow's key would pick the first option): its permission prompt arms nothing.
        let asked = StatusEvent::AskedInTerminal { message: QUESTION_REASON.into() };
        let ev = match ev {
            StatusEvent::PermissionRequested { .. } if !self.info.questions.is_empty() => &asked,
            StatusEvent::ToolPending { summary, questions } => {
                let summary = cap_text(summary, ASKING_MAX);
                if self.info.asking.as_ref() != Some(&summary) || &self.info.questions != questions {
                    self.info.asking = Some(summary);
                    self.info.questions = questions.clone();
                    changed = true;
                }
                if questions.is_empty() || !self.is_live() {
                    return changed;
                }
                &asked
            }
            _ => ev,
        };
        let subs = &mut self.info.subagents;
        match ev {
            StatusEvent::SubagentStarted { id, agent_type } if !subs.iter().any(|s| &s.id == id) => {
                subs.push(Subagent { id: id.clone(), agent_type: agent_type.clone() });
                return true;
            }
            StatusEvent::SubagentStopped { id } => {
                let n = subs.len();
                subs.retain(|s| &s.id != id);
                return subs.len() != n;
            }
            StatusEvent::SubagentsDone => return !std::mem::take(subs).is_empty(),
            StatusEvent::SubagentStarted { .. } => return false,
            StatusEvent::AssistantMessage { text } => {
                let text = cap_text(text, LAST_MESSAGE_MAX);
                if text.is_empty() || self.info.last_message.as_ref() == Some(&text) {
                    return false;
                }
                self.info.last_message = Some(text);
                return true;
            }
            // the agent is gone, and its subagents with it
            StatusEvent::Exited { .. } => changed |= !std::mem::take(subs).is_empty(),
            _ => {}
        }
        if matches!(ev, StatusEvent::ToolUsed) && !matches!(self.info.state, SessionState::Ended { .. }) {
            self.info.steps += 1;
            changed = true;
        }
        // the call it was waiting on ran, or the turn moved on: nothing pending any more
        if matches!(ev, StatusEvent::ToolUsed | StatusEvent::TurnFinished | StatusEvent::PromptSubmitted | StatusEvent::Exited { .. })
            && (self.info.asking.take().is_some() | !std::mem::take(&mut self.info.questions).is_empty())
        {
            changed = true;
        }
        let next = next_state(&self.info.state, ev, &self.policy);
        if next != self.info.state {
            self.info.reached_finished |= next == SessionState::Finished;
            self.info.state = next;
            self.info.state_since = now;
            self.info.parked = None; // put aside until something changed: it has
            self.quiet_since_ms = now;
            changed = true;
        }
        // A permission prompt arms Allow/Deny; leaving NeedsYou disarms them.
        let needs_you = matches!(self.info.state, SessionState::NeedsYou { .. });
        let awaiting = match ev {
            StatusEvent::PermissionRequested { .. } => needs_you,
            // Nothing left to answer from the app: the agent waits for typing.
            StatusEvent::AskedInTerminal { .. } | StatusEvent::Idle => false,
            _ => self.info.awaiting_decision && needs_you,
        };
        if matches!(ev, StatusEvent::PermissionRequested { .. }) || !awaiting {
            self.active_prompt = None; // a hook prompt uses the adapter's normal keys
        }
        if awaiting != self.info.awaiting_decision {
            // A newly armed prompt is a new wait, even with the same text as one answered in the
            // terminal: `state_since` tells prompts apart (a notification's Allow, `approve_if`).
            if awaiting {
                self.info.state_since = now;
            }
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
                self.info.state_since = now;
                self.info.parked = None;
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
    /// Set by `shutdown`: no new session starts, and a spawn that finishes after its entry was
    /// closed SIGKILLs its group at once (the app is about to exit, so no grace can run).
    quitting: AtomicBool,
    /// Spawns between inserting their entry and recording their PTY; `shutdown` waits for them.
    spawning: AtomicUsize,
    /// `<data>/sessions.json` (see `saved`); `save_lock` keeps writes in order.
    saved_path: PathBuf,
    save_lock: Mutex<()>,
    /// An update was sent since the last save (steps, finished): the next tick saves.
    unsaved: AtomicBool,
}

/// Counts a spawn in flight for as long as it lives.
struct SpawnGuard<'a>(&'a AtomicUsize);
impl<'a> SpawnGuard<'a> {
    fn new(n: &'a AtomicUsize) -> Self {
        n.fetch_add(1, AtomicOrdering::SeqCst);
        SpawnGuard(n)
    }
}
impl Drop for SpawnGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, AtomicOrdering::SeqCst);
    }
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
            sessions: Mutex::new(HashMap::new()),
            tx,
            weak: weak.clone(),
            flusher: Arc::default(),
            quitting: AtomicBool::new(false),
            spawning: AtomicUsize::new(0),
            saved_path: data_dir.join("sessions.json"),
            save_lock: Mutex::new(()),
            unsaved: AtomicBool::new(false),
            data_dir,
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
        self.unsaved.store(true, AtomicOrdering::Relaxed);
        let _ = self.tx.send(ManagerEvent::Updated(e.info.clone()));
    }

    /// `images`: attachment names (see `attachments`); they are copied into the session's dir and
    /// the originals removed once the session started.
    pub fn start_agent(&self, ws: &Workspace, builder: &Builder, task: Option<&str>, images: &[String]) -> Result<SessionInfo> {
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
        let res = attachments::copy_into(&self.data_dir, images, &self.data_dir.join("sessions").join(&id).join("images")).and_then(|paths| {
            let prompt = task_with_images(task, &paths);
            let req = LaunchRequest {
                session_id: &id,
                cwd: &ws.path,
                model: builder.model.as_deref(),
                effort: builder.effort.as_deref(),
                task: prompt.as_deref(),
                hook_url: &hook_url,
                data_dir: &self.data_dir,
                custom_command: builder.custom_command.as_deref(),
                images: &paths,
                resume: None,
            };
            // the session shows the owner's text, not the image paths
            adapter.launch(&req).and_then(|spec| self.spawn_agent(ws, builder, task, id.clone(), spec, adapter))
        });
        match &res {
            Ok(_) => attachments::remove(&self.data_dir, images),
            Err(_) => {
                self.hooks.unregister(&id);
                self.remove_session_dir(&id);
            }
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
        self.spawn(ws, kind, task, id, spec, Some(adapter), policy, None)
    }

    pub fn start_terminal(&self, ws: &Workspace) -> Result<SessionInfo> {
        let id = Uuid::new_v4().to_string();
        self.spawn(ws, SessionKind::Terminal, None, id, terminal_launch(&ws.path), None, terminal_policy(), None)
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

    /// `prior`: a paused session being resumed; it keeps its task, place, progress and conversation.
    #[allow(clippy::too_many_arguments)]
    fn spawn(&self, ws: &Workspace, kind: SessionKind, task: Option<&str>, id: String, spec: LaunchSpec, adapter: Option<Arc<dyn AgentAdapter>>, policy: StatusPolicy, prior: Option<SavedSession>) -> Result<SessionInfo> {
        ensure_present(ws)?;
        let baseline = git::baseline(&ws.path);
        let now = now_ms();
        let mut info = SessionInfo {
            id: id.clone(),
            workspace_id: ws.id.clone(),
            kind,
            task: task.map(str::to_string),
            title: None,
            state: SessionState::Starting,
            steps: 0,
            started_at: now,
            last_output_at: now,
            reached_finished: false,
            worktree: None,
            command_preview: command_preview(&spec),
            awaiting_decision: false,
            busy: false,
            rev: 0,
            spot: None,
            paused: false,
            subagents: vec![],
            state_since: now,
            last_message: None,
            asking: None,
            questions: vec![],
            parked: None,
        };
        if adapter.is_some()
            && let Some(p) = &prior
        {
            // reopened at its prompt, with no task sent: not at work until it says so
            info.state = crate::status::reopened_state(p.state.as_ref());
        }
        let conversation = prior.and_then(|p| {
            info.task = p.task;
            info.title = p.title;
            info.started_at = p.started_at;
            info.steps = p.steps;
            info.reached_finished = p.reached_finished;
            info.worktree = p.worktree;
            info.spot = p.spot;
            info.rev = p.rev; // the frontend drops updates whose rev is not newer
            info.last_message = p.last_message;
            p.conversation
        });
        let _spawning = SpawnGuard::new(&self.spawning);
        {
            // Check and insert atomically so two starts can't share a builder.
            let mut g = self.lock();
            if self.quitting.load(AtomicOrdering::SeqCst) {
                bail!("the app is quitting");
            }
            if let SessionKind::Agent { builder_id } = &info.kind {
                self.ensure_builder_free(&g, builder_id)?;
            }
            let mut e = SessionEntry::new(info, ws.path.clone(), adapter, policy, baseline, now);
            e.conversation = conversation;
            g.insert(id.clone(), e);
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
            // Closed while starting. Quitting leaves no time for kill()'s grace, so SIGKILL now.
            if self.quitting.load(AtomicOrdering::SeqCst) {
                handle.kill_now();
            } else {
                let _ = handle.kill();
            }
            bail!("session was closed while starting");
        };
        // If it already exited, `handle` just drops below, releasing its fds.
        let stop_now = !e.exited && e.stop_requested; // stop() raced the spawn
        if !e.exited {
            if std::mem::take(&mut e.osc_reply_owed) {
                let _ = handle.write(SUPPORT_REPLY);
            }
            e.pty = Some(handle.clone());
        }
        self.send_updated(e);
        let info = e.info.clone();
        drop(g);
        if self.quitting.load(AtomicOrdering::SeqCst) {
            // Recorded after `shutdown` collected its PTYs: its final SIGKILL can't reach this one.
            handle.kill_now();
        } else if stop_now {
            let _ = handle.kill();
        }
        self.save_sessions();
        Ok(info)
    }

    fn on_output(&self, id: &str, data: &[u8]) {
        let mut g = self.lock();
        let Some(e) = g.get_mut(id) else { return };
        let now = now_ms();
        e.scrollback.push(data);
        e.info.last_output_at = now;
        e.quiet_since_ms = now;
        let mut changed = e.apply(&StatusEvent::Output, now);
        if let (Some(scan), Some(adapter)) = (e.titles.as_mut(), e.adapter.as_ref())
            && let Some(title) = scan.feed(data).and_then(|raw| adapter.task_title(&raw))
            && e.info.title.as_ref() != Some(&title)
        {
            e.info.title = Some(title);
            changed = true;
        }
        // In-band status reports: the agent's own word, like a hook event.
        let events: Vec<StatusEvent> = match e.osc.as_mut() {
            Some(p) => {
                let events = p.feed(data).iter().flat_map(|r| p.events(r)).collect();
                if p.take_queries() > 0 {
                    // Answered here, before this output reaches the frontend's terminal, so the
                    // reply beats that terminal's answer to the query's trailing `CSI c`.
                    match e.pty.as_ref() {
                        Some(pty) => drop(pty.write(SUPPORT_REPLY)),
                        None => e.osc_reply_owed = true,
                    }
                }
                events
            }
            None => vec![],
        };
        if !events.is_empty() {
            e.policy = e.policy.after_first_event();
        }
        for ev in &events {
            changed |= e.apply(ev, now);
        }
        if e.scan_prompts(now) || changed {
            self.send_updated(e);
        }
        if events.contains(&StatusEvent::TurnFinished) {
            self.look_up_conversation(e);
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
                if was_live {
                    e.info.state_since = now_ms();
                    e.info.asking = None;
                    e.info.questions.clear();
                }
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
        self.save_sessions();
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
        let reply_adapter;
        let job = {
            let mut g = self.lock();
            let Some(e) = g.get_mut(session_id) else { return };
            // A hook that arrives after the process exited (a slow curl) is stale: the exit
            // already decided the final state.
            if e.exited {
                return;
            }
            let Some(adapter) = e.adapter.clone() else { return };
            reply_adapter = Some(adapter.clone());
            let now = now_ms();
            let mut changed = false;
            let mut job = None;
            let events = adapter.parse_hook(&body);
            if !events.is_empty() {
                e.policy = e.policy.after_first_event();
            }
            if let Some(c) = adapter.conversation_of(&body).filter(|c| e.conversation.as_ref() != Some(c)) {
                e.conversation = Some(c);
                self.unsaved.store(true, AtomicOrdering::Relaxed);
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
        // a reply the payload lacks may be in the agent's own files (Claude's transcript): read off the lock
        if let Some(adapter) = reply_adapter
            && let Some(file) = adapter.reply_file(&body)
        {
            let (weak, id) = (self.weak.clone(), session_id.to_string());
            std::thread::spawn(move || {
                if let Some(text) = adapter.read_reply(&file)
                    && let Some(m) = weak.upgrade()
                {
                    m.set_last_message(&id, &text);
                }
            });
        }
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

    fn set_last_message(&self, id: &str, text: &str) {
        let mut g = self.lock();
        if let Some(e) = g.get_mut(id)
            && e.apply(&StatusEvent::AssistantMessage { text: text.to_string() }, now_ms())
        {
            self.unsaved.store(true, AtomicOrdering::Relaxed);
            self.send_updated(e);
        }
    }

    /// Puts the session aside (out of the owner's queue) with a note, or (None) takes it back.
    /// It comes back by itself once its state changes.
    pub fn set_parked(&self, id: &str, note: Option<String>) -> Result<SessionInfo> {
        let mut g = self.lock();
        let e = g.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
        let note = note.map(|n| cap_text(&n, 500));
        if e.info.parked != note {
            e.info.parked = note;
            self.unsaved.store(true, AtomicOrdering::Relaxed);
            self.send_updated(e);
        }
        Ok(e.info.clone())
    }

    pub(crate) fn set_worktree(&self, id: &str, wt: WorktreeInfo) {
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

    /// Approves the prompt only if it is the one that was open at `since` (its `state_since`): a
    /// notification's Allow, which may be clicked long after a newer prompt replaced its own.
    pub fn approve_if(&self, id: &str, since: i64) -> Result<()> {
        self.answer_if(id, true, Some(since))
    }

    /// Whether the session's open prompt can be answered from the app (Allow / Deny keys known).
    pub fn answerable(&self, id: &str) -> bool {
        let g = self.lock();
        g.get(id).is_some_and(|e| {
            e.info.awaiting_decision
                && matches!(e.info.state, SessionState::NeedsYou { .. })
                && answer_keys(e, true).is_some()
                && answer_keys(e, false).is_some()
        })
    }

    /// One answer per prompt: a second approve/deny errs until a new `PermissionRequested`.
    fn answer(&self, id: &str, approve: bool) -> Result<()> {
        self.answer_if(id, approve, None)
    }

    fn answer_if(&self, id: &str, approve: bool, since: Option<i64>) -> Result<()> {
        let mut g = self.lock();
        let e = g.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
        let keys = answer_keys(e, approve)
            .ok_or_else(|| anyhow!("this agent can't be answered from the app; open the terminal"))?;
        if !e.info.awaiting_decision || !matches!(e.info.state, SessionState::NeedsYou { .. }) {
            bail!("session is not waiting for approval");
        }
        if since.is_some_and(|s| s != e.info.state_since) {
            bail!("that prompt was already answered; a newer one is open");
        }
        let pty = e.pty.clone().ok_or_else(|| anyhow!("session is not running"))?;
        pty.write(keys)?; // only enqueues, so it is fine under the lock
        e.info.awaiting_decision = false;
        let screen_prompt = e.active_prompt.take().is_some();
        if approve {
            e.info.state = SessionState::Working;
        } else if !screen_prompt {
            e.info.state = SessionState::NeedsYou { reason: DENIED_REASON.into() };
            e.info.asking = None;
            e.info.questions.clear();
        } // denying a screen prompt (trust menu) exits the agent: the exit moves the state on
        e.quiet_since_ms = now_ms();
        e.info.state_since = e.quiet_since_ms;
        e.info.parked = None;
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
            saved: Some(entry.saved()).filter(|s| matches!(s.kind, SessionKind::Agent { .. }) && s.conversation.is_some()),
        };
        if let Some(p) = &entry.pty {
            let _ = p.kill();
        }
        self.hooks.unregister(id);
        // Quitting keeps the session saved (and its images) to come back paused.
        if !self.quitting.load(AtomicOrdering::SeqCst) {
            self.remove_session_dir(id);
            self.save_sessions();
        }
        drop(entry); // releases the PTY fds
        Ok(closed)
    }

    /// Records where the session's builder stands; emitted like any other update.
    pub fn set_spot(&self, id: &str, spot: Tile) -> Result<SessionInfo> {
        let mut g = self.lock();
        let e = g.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
        e.info.spot = Some(spot);
        self.send_updated(e);
        let info = e.info.clone();
        drop(g);
        self.save_sessions();
        Ok(info)
    }

    /// Shifts the spot of every session in `workspace_id` by (dx, dy), as its compound moves; returns those sessions.
    pub fn shift_spots(&self, workspace_id: &str, dx: i32, dy: i32) -> Vec<SessionInfo> {
        let mut g = self.lock();
        let mut out = Vec::new();
        for e in g.values_mut() {
            if e.info.workspace_id != workspace_id {
                continue;
            }
            let Some(t) = e.info.spot else { continue };
            e.info.spot = Some(Tile { x: t.x + dx, y: t.y + dy });
            self.send_updated(e);
            out.push(e.info.clone());
        }
        drop(g);
        if !out.is_empty() {
            self.save_sessions();
        }
        out
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
            let mut changed = e.apply(&StatusEvent::Silence { secs }, now_ms);
            if e.info.kind == SessionKind::Terminal {
                let busy = e.pty.as_ref().is_some_and(|p| p.foreground_busy());
                changed |= std::mem::replace(&mut e.info.busy, busy) != busy;
            }
            if changed {
                self.send_updated(e);
            }
        }
        drop(g);
        if self.unsaved.load(AtomicOrdering::Relaxed) {
            self.save_sessions();
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
    /// the groups to empty, then SIGKILLs every recorded process group that still has a member,
    /// whether or not its leader was reaped (a child that ignores SIGHUP must not outlive the
    /// app). Only groups recorded while their leader still ran are signalled, seconds later at
    /// most, so a recycled group id is never hit. Blocks for about `grace` at most (less when
    /// everything exits on SIGHUP); keep it off the UI thread. No session starts afterwards, and
    /// one still starting is SIGKILLed as soon as its spawn returns (waited for, within `grace`).
    pub fn shutdown(&self, grace: Duration) {
        self.save_sessions(); // the latest steps; nothing is saved once quitting
        let ptys: Vec<Arc<PtyHandle>> = {
            let g = self.lock();
            self.quitting.store(true, AtomicOrdering::SeqCst); // under the lock: no insert slips past
            g.values().filter_map(|e| e.pty.clone()).collect()
        };
        for s in self.list() {
            let _ = self.close(&s.id);
        }
        let end = Instant::now() + grace;
        while Instant::now() < end && (self.spawning.load(AtomicOrdering::SeqCst) > 0 || ptys.iter().any(|p| p.group_alive())) {
            std::thread::sleep(REAP_POLL);
        }
        for p in &ptys {
            p.kill_now();
        }
    }

    /// Lists the sessions saved when the app last ran, paused (state `Ended`, no process), so the
    /// village looks as it did; `resume` starts one again. Sessions whose workspace or builder is
    /// gone are dropped. Run at startup, before `sweep_stale_session_dirs` (which then keeps their
    /// dirs). Returns how many came back.
    pub fn restore(&self, workspaces: &[Workspace], builders: &[Builder]) -> usize {
        let now = now_ms();
        let n = {
            let mut g = self.lock();
            for s in saved::load(&self.saved_path) {
                let Some(ws) = workspaces.iter().find(|w| w.id == s.workspace_id) else { continue };
                if let SessionKind::Agent { builder_id } = &s.kind
                    && !builders.iter().any(|b| &b.id == builder_id)
                {
                    continue;
                }
                let info = SessionInfo {
                    id: s.id.clone(),
                    workspace_id: s.workspace_id,
                    kind: s.kind,
                    task: s.task,
                    title: s.title,
                    state: SessionState::Ended { exit_code: None },
                    steps: s.steps,
                    started_at: s.started_at,
                    last_output_at: s.started_at,
                    reached_finished: s.reached_finished,
                    worktree: s.worktree,
                    command_preview: String::new(),
                    awaiting_decision: false,
                    busy: false,
                    rev: s.rev,
                    spot: s.spot,
                    paused: true,
                    subagents: vec![],
                    state_since: if s.state_since > 0 { s.state_since } else { s.started_at },
                    last_message: s.last_message,
                    asking: None,
                    questions: vec![],
                    parked: s.parked,
                };
                let mut e = SessionEntry::new(info, ws.path.clone(), None, terminal_policy(), None, now);
                e.exited = true;
                e.conversation = s.conversation;
                e.was_running = s.running;
                e.saved_state = s.state;
                g.insert(s.id, e);
            }
            g.len()
        };
        self.save_sessions(); // forgets the dropped ones
        n
    }

    /// Resumes the restored sessions that were running when the app last closed (a quit, a crash
    /// or a dev rebuild), oldest first; the ones that were paused stay paused. A failed resume
    /// leaves that session paused for the owner to retry. Returns each attempt's outcome.
    pub fn resume_was_running(&self, workspaces: &[Workspace], builders: &[Builder]) -> Vec<(String, Result<SessionInfo>)> {
        let ids: Vec<(String, String, Option<String>)> = {
            let mut list: Vec<_> = self.lock().values().filter(|e| e.info.paused && e.was_running).map(|e| e.info.clone()).collect();
            list.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id)));
            list.into_iter()
                .map(|i| {
                    let builder = match &i.kind {
                        SessionKind::Agent { builder_id } => Some(builder_id.clone()),
                        SessionKind::Terminal => None,
                    };
                    (i.id, i.workspace_id, builder)
                })
                .collect()
        };
        ids.into_iter()
            .map(|(id, ws_id, builder_id)| {
                let res = (|| {
                    let ws = workspaces.iter().find(|w| w.id == ws_id).ok_or_else(|| anyhow!("this session's workspace is gone"))?;
                    let builder = builder_id.as_ref().and_then(|b| builders.iter().find(|x| &x.id == b));
                    self.resume(ws, builder, &id)
                })();
                (id, res)
            })
            .collect()
    }

    /// Starts a paused session again under its id, keeping its task, place and progress: an agent
    /// continues its saved conversation (or starts a new one when it has none or can't resume), a
    /// terminal opens a new shell. A failed start leaves it paused. `builder`: the agent session's.
    pub fn resume(&self, ws: &Workspace, builder: Option<&Builder>, id: &str) -> Result<SessionInfo> {
        ensure_present(ws)?;
        let old = {
            let mut g = self.lock();
            let e = g.get(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
            if !e.info.paused {
                bail!("this session is not paused");
            }
            if let SessionKind::Agent { builder_id } = &e.info.kind {
                self.ensure_builder_free(&g, builder_id)?;
            }
            g.remove(id).expect("found above")
        };
        let in_worktree = self.in_own_worktree(ws, old.info.worktree.as_ref());
        let ws = in_worktree.as_ref().unwrap_or(ws);
        let res = match (&old.info.kind, builder) {
            (SessionKind::Terminal, _) => {
                self.spawn(ws, SessionKind::Terminal, None, id.to_string(), terminal_launch(&ws.path), None, terminal_policy(), Some(old.saved()))
            }
            (SessionKind::Agent { .. }, Some(b)) => self.resume_agent(ws, b, id, old.saved()),
            (SessionKind::Agent { .. }, None) => Err(anyhow!("this session's builder was deleted")),
        };
        if res.is_err() {
            self.lock().insert(id.to_string(), old);
        }
        res
    }

    /// A session the app started in its own worktree carries on there (its conversation lives
    /// there) while that folder exists: the workspace as seen from it.
    fn in_own_worktree(&self, ws: &Workspace, wt: Option<&WorktreeInfo>) -> Option<Workspace> {
        let wt = wt.filter(|wt| wt.path.starts_with(self.data_dir.join("worktrees")) && wt.path.exists())?;
        Some(Workspace { path: git::matching_folder(&ws.path, &wt.path), ..ws.clone() })
    }

    /// Opens a closed session's conversation again as a new session (from the history), with
    /// `builder` (of the same agent), keeping its task, title, progress and last reply. It rests
    /// at the agent's prompt until the owner types.
    pub fn continue_conversation(&self, ws: &Workspace, builder: &Builder, mut prior: SavedSession) -> Result<SessionInfo> {
        ensure_present(ws)?;
        if prior.conversation.is_none() {
            bail!("this session has no conversation to continue");
        }
        self.ensure_builder_free(&self.lock(), &builder.id)?;
        let id = Uuid::new_v4().to_string();
        prior.id = id.clone();
        prior.kind = SessionKind::Agent { builder_id: builder.id.clone() };
        prior.spot = None; // its old place may be taken; it gets a new one
        prior.rev = 0;
        prior.parked = None;
        prior.state = Some(SessionState::Finished);
        prior.reached_finished = false; // XP again only for new work
        prior.started_at = now_ms();
        prior.state_since = prior.started_at;
        let in_worktree = self.in_own_worktree(ws, prior.worktree.as_ref());
        if in_worktree.is_none() {
            prior.worktree = None;
        }
        self.resume_agent(in_worktree.as_ref().unwrap_or(ws), builder, &id, prior)
    }

    fn resume_agent(&self, ws: &Workspace, builder: &Builder, id: &str, prior: SavedSession) -> Result<SessionInfo> {
        let adapter = self
            .registry
            .get(builder.agent.clone())
            .ok_or_else(|| anyhow!("no adapter for {:?}", builder.agent))?;
        if !adapter.detect().installed {
            bail!("{} is not installed", adapter.label());
        }
        let hook_url = self.hooks.register(id);
        // the task's images stay readable (Claude and agy are allowed their folder)
        let images = files_in(&self.data_dir.join("sessions").join(id).join("images"));
        let conversation = prior.conversation.clone();
        let req = LaunchRequest {
            session_id: id,
            cwd: &ws.path,
            model: builder.model.as_deref(),
            effort: builder.effort.as_deref(),
            task: None,
            hook_url: &hook_url,
            data_dir: &self.data_dir,
            custom_command: builder.custom_command.as_deref(),
            images: &images,
            resume: conversation.as_deref(),
        };
        let res = adapter.launch(&req).and_then(|spec| {
            let kind = SessionKind::Agent { builder_id: builder.id.clone() };
            let policy = adapter.policy();
            self.spawn(ws, kind, None, id.to_string(), spec, Some(adapter.clone()), policy, Some(prior))
        });
        if res.is_err() {
            self.hooks.unregister(id);
        }
        res
    }

    /// For agents whose hooks don't name their conversation: asks the adapter in a thread (it
    /// reads the agent's files).
    fn look_up_conversation(&self, e: &SessionEntry) {
        let Some(adapter) = e.adapter.clone() else { return };
        let (weak, id, cwd, since) = (self.weak.clone(), e.info.id.clone(), e.workspace_path.clone(), e.info.started_at);
        std::thread::spawn(move || {
            if let Some(c) = adapter.find_conversation(&cwd, since, &id)
                && let Some(m) = weak.upgrade()
            {
                m.set_conversation(&id, c);
            }
        });
    }

    /// Records the session's conversation, unless another session already has it (two sessions
    /// of one agent in one folder look alike on disk).
    fn set_conversation(&self, id: &str, c: String) {
        {
            let mut g = self.lock();
            if g.values().any(|o| o.conversation.as_ref() == Some(&c)) {
                return;
            }
            let Some(e) = g.get_mut(id) else { return };
            e.conversation = Some(c);
        }
        self.save_sessions();
    }

    /// Writes every listed session to `sessions.json`. Skipped once quitting: what is saved then
    /// comes back paused on the next launch.
    fn save_sessions(&self) {
        if self.quitting.load(AtomicOrdering::SeqCst) {
            return;
        }
        let _order = self.save_lock.lock().unwrap_or_else(|e| e.into_inner());
        self.unsaved.store(false, AtomicOrdering::Relaxed);
        let mut list: Vec<SavedSession> = self.lock().values().map(SessionEntry::saved).collect();
        list.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id)));
        if let Err(err) = saved::save(&self.saved_path, &list) {
            eprintln!("could not save sessions: {err:#}");
        }
    }

    /// Removes `<data>/sessions/<id>` dirs that no session owns (paused ones do): left behind by a
    /// crash or a forced quit. Only real directories whose name is a
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
/// The keys that answer the session's open prompt: a screen prompt's own (e.g. the trust menu),
/// otherwise the adapter's. None when the prompt is answered in the terminal (no keys).
fn answer_keys(e: &SessionEntry, approve: bool) -> Option<&'static [u8]> {
    match (&e.active_prompt, e.adapter.as_deref()) {
        (Some(p), _) => Some(if approve { p.approve } else { p.deny }),
        (None, Some(a)) => if approve { a.approve_keys() } else { a.deny_keys() },
        (None, None) => None,
    }
    .filter(|k| !k.is_empty())
}

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

/// The files in `dir`, sorted; none when it doesn't exist.
fn files_in(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    v.sort();
    v
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
        let ws = Workspace { id: "w1".into(), name: "ws".into(), path: ws_path, created_at: 0, missing: false, level: 1, xp: 0, compound: None, color: None };
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
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf ok; sleep 0.2"), None, &[]).unwrap();
        assert_eq!(s.state, SessionState::Starting);
        assert!(uuid::Uuid::parse_str(&s.id).is_ok());
        assert!(wait_until(|| fx.events.lock().unwrap().iter().any(
            |e| matches!(e, ManagerEvent::Updated(i) if i.id == s.id && i.state == SessionState::Working))));
        assert!(wait_until(|| scrollback(&fx, &s.id).contains("ok")));
    }

    #[test]
    fn attached_images_are_moved_into_the_session_and_named_in_the_task() {
        let fx = fixture();
        let img = attachments::save(&fx.data_dir, b"\x89PNG\r\n\x1a\n..").unwrap();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf '[%s]' \"$1\"; sleep 5"), Some("fix the header"), &[img.clone()]).unwrap();
        assert_eq!(s.task.as_deref(), Some("fix the header"), "the session shows the owner's text");
        let copy = fx.data_dir.join("sessions").join(&s.id).join("images/image-1.png");
        assert!(copy.is_file());
        assert!(!attachments::dir(&fx.data_dir).join(&img).exists(), "the original is removed");
        assert!(wait_until(|| screen_text(scrollback(&fx, &s.id).as_bytes()).contains("Imageattachedtothistask")));
        assert!(wait_until(|| scrollback(&fx, &s.id).replace(['\r', '\n'], "").contains("image-1.png]")));
        fx.mgr.close(&s.id).unwrap();
        assert!(!copy.exists());

        // a missing image fails the start and leaves nothing behind
        let gone = format!("{}.png", uuid::Uuid::new_v4());
        assert!(fx.mgr.start_agent(&fx.ws, &custom("b1", "true"), None, &[gone]).is_err());
        assert!(std::fs::read_dir(fx.data_dir.join("sessions")).unwrap().next().is_none());
    }

    #[test]
    fn immediate_nonzero_exit_goes_stuck() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf boom; exit 7"), None, &[]).unwrap();
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
        assert!(fx.mgr.start_agent(&ws, &custom("b1", "true"), None, &[]).is_err());
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
        let err = fx.mgr.start_agent(&ws, &custom("b1", "true"), None, &[]).unwrap_err();
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
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "stty raw -echo; printf ready; sleep 5"), None, &[]).unwrap();
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
        let a = fx.mgr.start_agent(&fx.ws, &custom("b1", "exit 4"), None, &[]).unwrap();
        fx.mgr.start_agent(&fx.ws, &custom("b2", "sleep 5"), None, &[]).unwrap();
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
    fn terminal_is_busy_only_while_a_command_runs() {
        let fx = fixture();
        let s = fx.mgr.start_terminal(&fx.ws).unwrap();
        let busy = |fx: &Fx| {
            fx.mgr.tick(now_ms());
            info(fx, &s.id).busy
        };
        // the shell at its prompt (its start-up may run commands of its own first)
        assert!(wait_until(|| !busy(&fx)), "an idle shell is not busy");
        fx.mgr.write(&s.id, b"sleep 2\r").unwrap();
        assert!(wait_until(|| busy(&fx)), "a foreground command makes the terminal busy");
        assert!(wait_until(|| !busy(&fx)), "and it is idle again once the command returns");
    }

    #[test]
    fn one_session_per_builder() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "sleep 5"), None, &[]).unwrap();
        assert!(fx.mgr.start_agent(&fx.ws, &custom("b1", "sleep 5"), None, &[]).is_err());
        assert_eq!(fx.mgr.live_count(), 1);
        // Once stopped (Ended), the builder is free again.
        fx.mgr.stop(&s.id).unwrap();
        assert!(wait_until(|| matches!(state(&fx, &s.id), SessionState::Ended { .. })));
        assert_eq!(fx.mgr.live_count(), 0);
        assert!(fx.mgr.start_agent(&fx.ws, &custom("b1", "sleep 5"), None, &[]).is_ok());
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

    #[test]
    fn a_question_picker_waits_on_the_owner_without_allow() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        let q = serde_json::json!({"questions": [{"question": "Pick a fruit", "header": "Fruit", "multiSelect": false,
            "options": [{"label": "Apple", "description": "crisp"}, {"label": "Banana"}]}]});
        fx.mgr.on_hook(&s.id, serde_json::json!({"hook_event_name": "PreToolUse", "cwd": "/x", "tool_name": "AskUserQuestion", "tool_input": q}));
        let i = info(&fx, &s.id);
        assert_eq!(i.state, SessionState::NeedsYou { reason: QUESTION_REASON.into() }, "a picker waits on the owner by itself");
        assert_eq!(i.questions.len(), 1);
        assert_eq!(i.questions[0].options[1].label, "Banana");
        // its permission prompt follows: still the question, and Allow ("1") is not offered
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        let i = info(&fx, &s.id);
        assert_eq!((i.state.clone(), i.awaiting_decision), (SessionState::NeedsYou { reason: QUESTION_REASON.into() }, false));
        assert!(fx.mgr.approve(&s.id).is_err());
        // answered (in the app or the terminal): the tool ran, the picker is gone
        fx.mgr.on_hook(&s.id, fixture_json("post_tool_use.json"));
        let i = info(&fx, &s.id);
        assert_eq!((i.state.clone(), i.questions.len(), i.asking.clone()), (SessionState::Working, 0, None));
        // a later ordinary prompt arms Allow again
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        assert!(info(&fx, &s.id).awaiting_decision);
    }

    #[test]
    fn the_briefing_follows_the_hooks_and_parking_lasts_until_the_state_changes() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        let pre = serde_json::json!({"hook_event_name": "PreToolUse", "cwd": "/x", "tool_name": "Bash", "tool_input": {"command": "rm -rf build"}});
        fx.mgr.on_hook(&s.id, pre);
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        let i = info(&fx, &s.id);
        assert!(matches!(i.state, SessionState::NeedsYou { .. }));
        assert_eq!(i.asking.as_deref(), Some("Bash: rm -rf build"), "what it waits on");
        let since = i.state_since;
        assert!(since >= i.started_at);
        // parked: out of the queue, still waiting; the same state keeps it parked
        assert_eq!(fx.mgr.set_parked(&s.id, Some("after lunch".into())).unwrap().parked.as_deref(), Some("after lunch"));
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        assert_eq!(info(&fx, &s.id).parked.as_deref(), Some("after lunch"));
        fx.mgr.on_hook(&s.id, fixture_json("post_tool_use.json"));
        let i = info(&fx, &s.id);
        assert_eq!((i.state.clone(), i.asking.clone(), i.parked.clone()), (SessionState::Working, None, None), "it ran: back in play");
        fx.mgr.on_hook(&s.id, fixture_json("stop.json"));
        let i = info(&fx, &s.id);
        assert_eq!(i.state, SessionState::Finished);
        assert!(i.last_message.as_deref().is_some_and(|m| m.starts_with("I created `hello.txt`")));
        assert!(i.state_since >= since);
        assert!(fx.mgr.set_parked("nope", None).is_err());
    }

    #[test]
    fn long_replies_keep_their_end() {
        assert_eq!(cap_text("  short  ", 10), "short");
        let long = format!("{}THE END", "x".repeat(50));
        let c = cap_text(&long, 12);
        assert_eq!(c.chars().count(), 12);
        assert!(c.starts_with('…') && c.ends_with("THE END"));
    }

    #[test]
    fn subagents_come_and_go_with_their_hooks() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        fx.mgr.on_hook(&s.id, fixture_json("post_tool_use.json"));
        let started = |id: &str| serde_json::json!({"hook_event_name": "SubagentStart", "agent_id": id, "agent_type": "Explore"});
        fx.mgr.on_hook(&s.id, started("a1"));
        fx.mgr.on_hook(&s.id, started("a2"));
        fx.mgr.on_hook(&s.id, started("a2")); // a repeat is one subagent
        let ids = |fx: &Fx| info(fx, &s.id).subagents.into_iter().map(|a| a.id).collect::<Vec<_>>();
        assert_eq!(ids(&fx), ["a1", "a2"]);
        assert_eq!(info(&fx, &s.id).subagents[0].agent_type.as_deref(), Some("Explore"));
        assert_eq!((state(&fx, &s.id), info(&fx, &s.id).steps), (SessionState::Working, 1), "state and steps untouched");
        fx.mgr.on_hook(&s.id, serde_json::json!({"hook_event_name": "SubagentStop", "agent_id": "a1"}));
        assert_eq!(ids(&fx), ["a2"]);
        assert!(wait_until(|| last_update(&fx, &s.id).is_some_and(|i| i.subagents.len() == 1)), "the change is sent");
        // a turn ending with no background tasks clears any minion whose stop hook went missing
        fx.mgr.on_hook(&s.id, fixture_json("stop.json"));
        assert!(ids(&fx).is_empty());
    }

    #[test]
    fn late_hooks_after_exit_are_ignored() {
        let fx = fixture();
        // Exit-stuck: a hook arriving after the crash must not revive the session.
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sh(&fx, "exit 3"), Arc::new(ClaudeAdapter)).unwrap();
        assert!(wait_until(|| fx.mgr.running_process_count() == 0));
        let stuck = state(&fx, &s.id);
        assert_eq!(stuck, SessionState::Stuck { reason: "exited with code 3".into() });
        let steps = info(&fx, &s.id).steps;
        for f in ["post_tool_use.json", "stop.json", "notification_permission.json"] {
            fx.mgr.on_hook(&s.id, fixture_json(f));
        }
        assert_eq!((state(&fx, &s.id), info(&fx, &s.id).steps), (stuck, steps));
        // Ended (clean exit): unchanged too.
        let e = fx.mgr.start_with_spec(&fx.ws, &claude("b2"), sh(&fx, "exit 0"), Arc::new(ClaudeAdapter)).unwrap();
        assert!(wait_until(|| fx.mgr.running_process_count() == 0));
        assert_eq!(state(&fx, &e.id), SessionState::Ended { exit_code: Some(0) });
        fx.mgr.on_hook(&e.id, fixture_json("post_tool_use.json"));
        assert_eq!((state(&fx, &e.id), info(&fx, &e.id).steps), (SessionState::Ended { exit_code: Some(0) }, 0));
        assert!(!info(&fx, &e.id).awaiting_decision);
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
    fn approve_if_answers_only_the_prompt_it_was_shown_for() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        assert!(!fx.mgr.answerable(&s.id), "nothing open yet");
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        assert!(fx.mgr.answerable(&s.id));
        let first = info(&fx, &s.id).state_since;
        // Answered in the app, then a new prompt opens later: the old notification must not approve it.
        fx.mgr.deny(&s.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        fx.mgr.on_hook(&s.id, fixture_json("notification_permission.json"));
        let second = info(&fx, &s.id).state_since;
        assert_ne!(first, second);
        assert!(fx.mgr.approve_if(&s.id, first).is_err(), "stale prompt");
        assert!(info(&fx, &s.id).awaiting_decision, "still open after the refused click");
        fx.mgr.approve_if(&s.id, second).unwrap();
        assert_eq!(state(&fx, &s.id), SessionState::Working);
        assert!(!fx.mgr.answerable(&s.id));
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
        let mut closed = fx.mgr.close(&a.id).unwrap();
        let saved = closed.saved.take().expect("a conversation it named: kept for the history");
        assert_eq!(saved.conversation.as_deref(), fixture_json("stop.json")["session_id"].as_str());
        assert_eq!(closed, ClosedSession { workspace_id: "w1".into(), is_agent: true, reached_finished: true, stuck: false, saved: None });
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
    fn shift_spots_moves_only_that_workspace() {
        let fx = fixture();
        let a = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        let b = fx.mgr.start_with_spec(&fx.ws, &claude("b2"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        fx.mgr.set_spot(&a.id, Tile { x: 3, y: 4 }).unwrap();
        let moved = fx.mgr.shift_spots(&fx.ws.id, 10, -2);
        assert_eq!(moved.len(), 1, "a session without a spot stays without one");
        assert_eq!(info(&fx, &a.id).spot, Some(Tile { x: 13, y: 2 }));
        assert_eq!(info(&fx, &b.id).spot, None);
        assert!(fx.mgr.shift_spots("other", 1, 1).is_empty());
    }

    #[test]
    fn output_is_batched() {
        let fx = fixture();
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "yes | head -c 2000000"), None, &[]).unwrap();
        fx.mgr.attach(&s.id).unwrap();
        std::thread::sleep(Duration::from_secs(1));
        let n = fx.events.lock().unwrap().iter().filter(|e| matches!(e, ManagerEvent::Output { id, .. } if *id == s.id)).count();
        assert!(n > 0 && n < 100, "{n} output events");
        assert!(fx.mgr.attach(&s.id).unwrap().0.len() <= SCROLLBACK_CAP);
    }

    #[test]
    fn slow_emit_bounds_queued_output() {
        let fx = fixture_with(Duration::from_millis(50), true);
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "yes | head -c 20000000"), None, &[]).unwrap();
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
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf aaaa; sleep 0.1; printf bbbb; sleep 0.1; printf cccc; sleep 0.4; printf dddd; sleep 5"), None, &[]).unwrap();
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
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf hello; sleep 5"), None, &[]).unwrap();
        assert!(wait_until(|| scrollback(&fx, &s.id).contains("hello")));
        std::thread::sleep(FLUSH_EVERY * 4);
        assert!(frames(&fx, &s.id).is_empty(), "output only goes to scrollback");
        assert_eq!(fx.mgr.queued_output_bytes(&s.id), 0);
    }

    #[test]
    fn unacked_frame_holds_back_output_until_ack() {
        let fx = fixture_with(Duration::ZERO, false);
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf start; sleep 0.3; yes | head -c 8000000; printf END; sleep 5"), None, &[]).unwrap();
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
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf one; sleep 0.3; printf two; sleep 5"), None, &[]).unwrap();
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
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf hi; sleep 30"), None, &[]).unwrap();
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
    fn codex_notify_switches_off_silence_needs_you() {
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
        assert_eq!(
            state(&fx, &a.id),
            SessionState::NeedsYou { reason: crate::status::WAITING_IN_TERMINAL.into() },
            "no notify yet: silence waits for the user (a login screen?), never Finished"
        );
        assert!(!info(&fx, &a.id).awaiting_decision, "nothing to approve from the app");
        assert_eq!(state(&fx, &b.id), SessionState::Working, "after a notify, silence changes nothing");
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
    fn no_session_starts_after_shutdown() {
        let fx = fixture();
        fx.mgr.shutdown(Duration::from_millis(50));
        let err = fx.mgr.start_terminal(&fx.ws).unwrap_err();
        assert!(err.to_string().contains("quitting"), "{err}");
        assert!(fx.mgr.list().is_empty());
    }

    #[test]
    fn quit_kills_a_trapping_child_whose_leader_died_on_sighup() {
        let fx = fixture();
        // The leader dies on SIGHUP at once (and is reaped); its child ignores SIGHUP.
        let script = r#"sh -c 'trap "" HUP; echo pid:$$; exec sleep 30' & wait"#;
        let s = fx.mgr.start_with_spec(&fx.ws, &custom("b1", ""), sh(&fx, script), Arc::new(crate::adapters::CustomAdapter)).unwrap();
        let child = printed_pid(&fx, &s.id);
        let started = Instant::now();
        fx.mgr.shutdown(Duration::from_millis(500));
        let took = started.elapsed();
        let end = Instant::now() + Duration::from_millis(500);
        while alive(child) && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        let survived = alive(child);
        if survived {
            unsafe { libc::kill(child, libc::SIGKILL); }
        }
        assert!(!survived, "the child outlived shutdown because its leader had been reaped");
        assert!(took >= Duration::from_millis(450), "waited the grace for the group, not just the leader: {took:?}");
    }

    #[test]
    fn quit_returns_early_when_everything_exits_on_sighup() {
        let fx = fixture();
        fx.mgr.start_agent(&fx.ws, &custom("b1", "sleep 30"), None, &[]).unwrap();
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
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf hi; sleep 0.3"), None, &[]).unwrap();
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
        let s = fx.mgr.start_agent(&fx.ws, &custom("b1", "printf one; sleep 0.2; printf two; sleep 5"), None, &[]).unwrap();
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
    fn osc_status_reports_drive_an_antigravity_session() {
        let fx = fixture();
        let b = Builder { id: "b1".into(), name: "b1".into(), agent: AgentKind::Antigravity, model: None, effort: None, custom_command: None };
        // Reports split mid-sequence across writes, as a TUI may flush them.
        let script = r#"printf '\033]7501;state=work'; sleep 0.2; printf 'ing:app=agy\033\\'; read a; printf '\033]7501;state=blocked:app=agy:kind=permission\007'; read b; printf '\033]7501;state=done:app=agy\033\\'; sleep 5"#;
        let spec = LaunchSpec { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()], env: vec![], cwd: fx.ws.path.clone() };
        let s = fx.mgr.start_with_spec(&fx.ws, &b, spec, Arc::new(crate::adapters::AntigravityAdapter)).unwrap();
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::Working));
        fx.mgr.write(&s.id, b"\n").unwrap();
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::NeedsYou { reason: "Wants permission".into() }));
        fx.mgr.write(&s.id, b"\n").unwrap();
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::Finished));
        // After a report, silence no longer reads as "Waiting in the terminal".
        fx.mgr.tick(info(&fx, &s.id).started_at + 120_000);
        assert_eq!(state(&fx, &s.id), SessionState::Finished);
    }

    #[test]
    fn the_agent_s_terminal_title_names_the_session_and_is_saved() {
        let fx = fixture();
        // As Claude Code 2.1 does: its launch title, then the conversation's name behind a spinner glyph.
        let script = r#"printf '\033]0;\342\234\263 Claude Code\007'; sleep 0.2; printf '\033]0;\342\227\221 Local voice'; sleep 0.2; printf ' agent startup\007 hi'; sleep 5"#;
        let spec = LaunchSpec { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()], env: vec![], cwd: fx.ws.path.clone() };
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), spec, Arc::new(ClaudeAdapter)).unwrap();
        assert_eq!(s.title, None);
        assert!(wait_until(|| info(&fx, &s.id).title.as_deref() == Some("Local voice agent startup")), "got {:?}", info(&fx, &s.id).title);
        fx.mgr.tick(now_ms()); // saves what changed
        let saved = saved::load(&fx.data_dir.join("sessions.json"));
        assert_eq!(saved.iter().find(|x| x.id == s.id).and_then(|x| x.title.as_deref()), Some("Local voice agent startup"));
    }

    #[test]
    fn grok_reports_once_the_session_answers_its_support_query() {
        let fx = fixture();
        let b = Builder { id: "b1".into(), name: "b1".into(), agent: AgentKind::Grok, model: None, effort: None, custom_command: None };
        // As Grok 1.0.77 starts under `program_status = "auto"`: the query, then `CSI c`; it
        // reports only if the 7501 reply (ESC ] 7501 ; ? ESC \, 10 bytes) comes back.
        let script = r#"stty -icanon -icrnl -echo min 1
printf '\033]7501;?\033\\\033[c'
[ "$(dd bs=1 count=10 2>/dev/null | od -An -tx1 | tr -d ' \n')" = 1b5d373530313b3f1b5c ] || exit 3
printf '\033]7501;state=blocked:kind=question:app=grok:msg=UGljayBvbmU=\033\\'
dd bs=1 count=1 2>/dev/null >/dev/null
printf '\033]7501;state=working:app=grok\033\\\033]7501;state=done:id=s1/sub:app=grok\033\\'
dd bs=1 count=1 2>/dev/null >/dev/null
printf '\033]7501;state=done:app=grok\033\\'; sleep 5"#;
        let spec = LaunchSpec { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()], env: vec![], cwd: fx.ws.path.clone() };
        let s = fx.mgr.start_with_spec(&fx.ws, &b, spec, Arc::new(crate::adapters::GrokAdapter)).unwrap();
        // Only a report gets here: without the reply the script exits.
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::NeedsYou { reason: "Pick one".into() }), "got {:?}", state(&fx, &s.id));
        fx.mgr.write(&s.id, b"1").unwrap();
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::Working));
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(state(&fx, &s.id), SessionState::Working, "a subagent's `done` is not the session's");
        fx.mgr.write(&s.id, b"\n").unwrap();
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::Finished));
    }

    #[test]
    fn antigravity_answers_from_the_app_with_enter_and_esc() {
        let fx = fixture();
        let b = Builder { id: "b1".into(), name: "b1".into(), agent: AgentKind::Antigravity, model: None, effort: None, custom_command: None };
        // agy 1.4.12's sequence: a tool prompt (Enter approves), work, another prompt (Esc
        // denies), then `idle`. Single raw bytes are read so the Esc arrives on its own.
        let script = r#"stty -icanon -icrnl -echo min 1; key() { dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'; }
printf '\033]7501;state=blocked:kind=permission:app=antigravity:msg=QXBwcm92ZSBSdW5Db21tYW5kOiBwd2Q=\033\\'
[ "$(key)" = 0d ] || exit 3
printf '\033]7501;state=working:app=antigravity\033\\'
printf '\033]7501;state=blocked:kind=permission:app=antigravity:msg=V3JpdGUgaGVsbG8udHh0\033\\'
[ "$(key)" = 1b ] || exit 4
printf '\033]7501;state=idle:app=antigravity\033\\'; sleep 5"#;
        let spec = LaunchSpec { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()], env: vec![], cwd: fx.ws.path.clone() };
        let s = fx.mgr.start_with_spec(&fx.ws, &b, spec, Arc::new(crate::adapters::AntigravityAdapter)).unwrap();
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::NeedsYou { reason: "Approve RunCommand: pwd".into() }));
        assert!(info(&fx, &s.id).awaiting_decision);
        fx.mgr.approve(&s.id).unwrap();
        assert!(wait_until(|| state(&fx, &s.id) == SessionState::NeedsYou { reason: "Write hello.txt".into() }));
        assert_eq!(info(&fx, &s.id).steps, 1, "each working report is a step");
        fx.mgr.deny(&s.id).unwrap();
        // The `idle` after the Esc keeps the denial's reason and arms no buttons.
        std::thread::sleep(Duration::from_millis(600));
        let i = info(&fx, &s.id);
        assert_eq!(i.state, SessionState::NeedsYou { reason: DENIED_REASON.into() }, "script exits non-zero on a wrong key");
        assert!(!i.awaiting_decision);
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

    fn saved_ids(fx: &Fx) -> Vec<String> {
        saved::load(&fx.data_dir.join("sessions.json")).into_iter().map(|s| s.id).collect()
    }

    /// A second manager on the same data dir: the app after a relaunch.
    fn relaunch(fx: &Fx) -> Arc<SessionManager> {
        SessionManager::new(AdapterRegistry::new(), fx.mgr.hooks.clone(), fx.data_dir.clone(), Arc::new(|_| {}))
    }

    #[test]
    fn listed_sessions_are_saved_and_a_close_forgets_one() {
        let fx = fixture();
        let t = fx.mgr.start_terminal(&fx.ws).unwrap();
        let a = fx.mgr.start_agent(&fx.ws, &custom("b1", "sleep 5"), Some("fix it"), &[]).unwrap();
        assert_eq!(saved_ids(&fx).len(), 2);
        fx.mgr.close(&t.id).unwrap();
        assert_eq!(saved_ids(&fx), vec![a.id]);
    }

    #[test]
    fn after_a_quit_sessions_come_back_paused_where_they_stood() {
        let fx = fixture();
        let b = custom("b1", "sleep 5");
        let a = fx.mgr.start_agent(&fx.ws, &b, Some("fix it"), &[]).unwrap();
        fx.mgr.set_spot(&a.id, Tile { x: 3, y: -1 }).unwrap();
        let t = fx.mgr.start_terminal(&fx.ws).unwrap();
        let gone = fx.mgr.start_agent(&fx.ws, &custom("b2", "sleep 5"), None, &[]).unwrap();
        let rev = fx.mgr.list().into_iter().find(|s| s.id == a.id).unwrap().rev;
        fx.mgr.shutdown(KILL_GRACE);
        assert_eq!(saved_ids(&fx).len(), 3, "quitting keeps them");

        let m = relaunch(&fx);
        assert_eq!(m.restore(std::slice::from_ref(&fx.ws), &[b]), 2, "b2 was deleted: its session is dropped");
        let list = m.list();
        let p = list.iter().find(|s| s.id == a.id).unwrap();
        assert!(p.paused);
        assert_eq!(p.state, SessionState::Ended { exit_code: None });
        assert_eq!((p.task.as_deref(), p.spot, p.rev), (Some("fix it"), Some(Tile { x: 3, y: -1 }), rev));
        assert!(list.iter().any(|s| s.id == t.id && s.paused));
        assert!(!list.iter().any(|s| s.id == gone.id));
        assert_eq!(m.running_process_count(), 0, "nothing runs until resumed");
        assert_eq!(saved::load(&fx.data_dir.join("sessions.json")).len(), 2);
    }

    #[test]
    fn a_closed_conversation_continues_as_a_new_session() {
        let fx = fixture();
        let b = custom("b1", "sleep 5");
        let a = fx.mgr.start_agent(&fx.ws, &b, Some("fix it"), &[]).unwrap();
        fx.mgr.set_spot(&a.id, Tile { x: 2, y: 2 }).unwrap();
        let mut prior = fx.mgr.lock().get(&a.id).unwrap().saved();
        fx.mgr.close(&a.id).unwrap();
        assert!(fx.mgr.continue_conversation(&fx.ws, &b, prior.clone()).is_err(), "no conversation to continue");
        prior.conversation = Some("conv-1".into());
        prior.reached_finished = true;
        let r = fx.mgr.continue_conversation(&fx.ws, &b, prior.clone()).unwrap();
        assert_ne!(r.id, a.id);
        assert_eq!((r.task.as_deref(), r.spot, r.reached_finished), (Some("fix it"), None, false));
        assert_eq!(fx.mgr.lock().get(&r.id).unwrap().conversation.as_deref(), Some("conv-1"));
        assert!(fx.mgr.continue_conversation(&fx.ws, &b, prior).is_err(), "the builder is busy");
        fx.mgr.shutdown(KILL_GRACE);
    }

    #[test]
    fn resume_starts_a_paused_session_under_its_id() {
        let fx = fixture();
        let b = custom("b1", "sleep 5");
        let a = fx.mgr.start_agent(&fx.ws, &b, Some("fix it"), &[]).unwrap();
        fx.mgr.set_spot(&a.id, Tile { x: 2, y: 2 }).unwrap();
        let t = fx.mgr.start_terminal(&fx.ws).unwrap();
        fx.mgr.shutdown(KILL_GRACE);
        let m = relaunch(&fx);
        m.restore(std::slice::from_ref(&fx.ws), std::slice::from_ref(&b));
        let before = m.list().into_iter().find(|s| s.id == a.id).unwrap();

        let r = m.resume(&fx.ws, Some(&b), &a.id).unwrap();
        assert_eq!(r.id, a.id);
        assert!(!r.paused && r.state != SessionState::Ended { exit_code: None });
        assert_eq!((r.task.as_deref(), r.spot), (Some("fix it"), Some(Tile { x: 2, y: 2 })));
        assert!(r.rev > before.rev, "updates after a resume are newer");
        assert!(m.resume(&fx.ws, Some(&b), &a.id).is_err(), "only a paused session resumes");
        assert!(m.resume(&fx.ws, None, &t.id).is_ok(), "a terminal opens a new shell");
        assert_eq!(m.running_process_count(), 2);
        m.shutdown(KILL_GRACE);
    }

    #[test]
    fn what_was_running_resumes_at_the_next_launch_and_the_rest_stays_paused() {
        let fx = fixture();
        let b = custom("b1", "sleep 30");
        let done = custom("b2", "true");
        let a = fx.mgr.start_agent(&fx.ws, &b, None, &[]).unwrap();
        let t = fx.mgr.start_terminal(&fx.ws).unwrap();
        let ended = fx.mgr.start_agent(&fx.ws, &done, None, &[]).unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        while fx.mgr.lock().get(&ended.id).is_some_and(|e| !e.exited) && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(fx.mgr.lock().get(&ended.id).is_some_and(|e| e.exited), "`true` exited");
        fx.mgr.shutdown(KILL_GRACE); // a quit; a crash leaves the file as last saved, the same

        let m = relaunch(&fx);
        m.restore(std::slice::from_ref(&fx.ws), &[b.clone(), done.clone()]);
        let out = m.resume_was_running(std::slice::from_ref(&fx.ws), &[b.clone(), done.clone()]);
        let mut resumed: Vec<&str> = out.iter().filter(|(_, r)| r.is_ok()).map(|(id, _)| id.as_str()).collect();
        resumed.sort();
        let mut want = vec![a.id.as_str(), t.id.as_str()];
        want.sort();
        assert_eq!(resumed, want, "the agent and the shell were running; the exited one was not");
        let list = m.list();
        assert!(list.iter().any(|s| s.id == ended.id && s.paused));
        assert!(list.iter().any(|s| s.id == a.id && !s.paused));

        // the one left paused is not running either: it stays paused through the next relaunch too
        m.shutdown(KILL_GRACE);
        let m2 = relaunch(&fx);
        m2.restore(std::slice::from_ref(&fx.ws), &[b.clone(), done.clone()]);
        let again: Vec<String> = m2.resume_was_running(std::slice::from_ref(&fx.ws), &[b, done]).into_iter().map(|(id, _)| id).collect();
        assert!(!again.contains(&ended.id));
        assert_eq!(again.len(), 2);
        m2.shutdown(KILL_GRACE);
    }

    #[test]
    fn a_reopened_agent_waits_at_its_prompt_instead_of_reading_as_at_work() {
        let fx = fixture();
        // prints as an agent's TUI does when it comes up, then waits
        let b = custom("b1", "printf 'welcome back'; sleep 30");
        let a = fx.mgr.start_agent(&fx.ws, &b, None, &[]).unwrap(); // a task would be appended to the command
        assert!(wait_until(|| state(&fx, &a.id) == SessionState::Working), "at work when the app quits");
        fx.mgr.shutdown(KILL_GRACE);

        let m = relaunch(&fx);
        m.restore(std::slice::from_ref(&fx.ws), std::slice::from_ref(&b));
        // a session restored but not resumed keeps the state it was saved with
        m.shutdown(KILL_GRACE);
        let m = relaunch(&fx);
        m.restore(std::slice::from_ref(&fx.ws), std::slice::from_ref(&b));
        let out = m.resume_was_running(std::slice::from_ref(&fx.ws), std::slice::from_ref(&b));
        assert!(out.iter().all(|(_, r)| r.is_ok()));
        let reopened = SessionState::NeedsYou { reason: crate::status::REOPENED_REASON.into() };
        let now = || m.list().into_iter().find(|s| s.id == a.id).unwrap();
        assert_eq!(now().state, reopened);
        // its output (the agent coming back up) is no turn
        let end = Instant::now() + Duration::from_secs(5);
        while now().last_output_at == now().started_at && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(now().state, reopened);
        m.shutdown(KILL_GRACE);
    }

    #[test]
    fn reopened_agents_rest_by_how_they_were_left() {
        use crate::status::{reopened_state, REOPENED_REASON};
        let waits = SessionState::NeedsYou { reason: REOPENED_REASON.into() };
        assert_eq!(reopened_state(Some(&SessionState::Working)), waits);
        assert_eq!(reopened_state(Some(&SessionState::NeedsYou { reason: "Wants permission".into() })), waits, "the prompt it asked is gone");
        assert_eq!(reopened_state(Some(&SessionState::Finished)), SessionState::Finished);
        assert_eq!(reopened_state(None), SessionState::Finished, "saved before states were kept");
        // agy and Grok report idle as they come up: still the same wait
        let p = crate::adapters::AntigravityAdapter.policy();
        assert_eq!(crate::status::next_state(&waits, &crate::status::StatusEvent::Idle, &p), waits);
        assert_eq!(crate::status::next_state(&waits, &crate::status::StatusEvent::Output, &p), waits);
        assert_eq!(crate::status::next_state(&waits, &crate::status::StatusEvent::PromptSubmitted, &p), SessionState::Working);
    }

    #[test]
    fn a_failed_resume_leaves_the_session_paused() {
        let fx = fixture();
        let b = custom("b1", "sleep 5");
        let a = fx.mgr.start_agent(&fx.ws, &b, None, &[]).unwrap();
        fx.mgr.shutdown(KILL_GRACE);
        let m = relaunch(&fx);
        m.restore(std::slice::from_ref(&fx.ws), std::slice::from_ref(&b));
        assert!(m.resume(&fx.ws, None, &a.id).is_err(), "no builder");
        let gone = Workspace { missing: true, ..fx.ws.clone() };
        assert!(m.resume(&gone, Some(&b), &a.id).is_err(), "no folder");
        assert!(m.list().iter().any(|s| s.id == a.id && s.paused));
    }

    #[test]
    fn hooks_name_the_conversation_to_resume() {
        let fx = fixture();
        let s = fx.mgr.start_with_spec(&fx.ws, &claude("b1"), sleeper(&fx), Arc::new(ClaudeAdapter)).unwrap();
        let body = fixture_json("user_prompt_submit.json");
        fx.mgr.on_hook(&s.id, body.clone());
        assert_eq!(fx.mgr.lock().get(&s.id).unwrap().conversation.as_deref(), body["session_id"].as_str());
        fx.mgr.tick(now_ms());
        let saved = saved::load(&fx.data_dir.join("sessions.json"));
        assert_eq!(saved[0].conversation.as_deref(), body["session_id"].as_str());
    }

    #[test]
    fn paused_sessions_keep_their_dirs_through_the_sweep() {
        let fx = fixture();
        let b = custom("b1", "sleep 5");
        let a = fx.mgr.start_agent(&fx.ws, &b, None, &[]).unwrap();
        let dir = fx.data_dir.join("sessions").join(&a.id).join("images");
        std::fs::create_dir_all(&dir).unwrap();
        fx.mgr.shutdown(KILL_GRACE);
        assert!(dir.is_dir(), "quitting keeps the dir");
        let m = relaunch(&fx);
        m.restore(std::slice::from_ref(&fx.ws), std::slice::from_ref(&b));
        assert!(m.sweep_stale_session_dirs().is_empty());
        assert!(dir.is_dir());
    }
}
