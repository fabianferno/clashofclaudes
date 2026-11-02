//! Notifications and the dock badge for agent sessions that need the user or finished.
//!
//! The decision logic here is pure (no Tauri); `lib.rs` wires it to the window and the plugin.

use crate::model::{SessionInfo, SessionKind, SessionState};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

const REASON_MAX_CHARS: usize = 80;

/// The state variants, without their payload (a changing `reason` is not a new entry).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateKind {
    Starting,
    Working,
    NeedsYou,
    Finished,
    Stuck,
    Ended,
}

impl From<&SessionState> for StateKind {
    fn from(s: &SessionState) -> Self {
        match s {
            SessionState::Starting => Self::Starting,
            SessionState::Working => Self::Working,
            SessionState::NeedsYou { .. } => Self::NeedsYou,
            SessionState::Finished => Self::Finished,
            SessionState::Stuck { .. } => Self::Stuck,
            SessionState::Ended { .. } => Self::Ended,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    pub title: String,
    pub body: String,
}

pub struct Notifier {
    focused: AtomicBool,
    /// Minimized or hidden (checked at notify time); counts as unfocused.
    obscured: AtomicBool,
    /// The last state kind seen per session, so a note fires once per entry.
    last: Mutex<HashMap<String, StateKind>>,
}

impl Default for Notifier {
    fn default() -> Self {
        Self::new()
    }
}

impl Notifier {
    /// Starts focused: nothing is notified until the window loses focus.
    pub fn new() -> Self {
        Self::with_focus(true)
    }

    /// Starts from the window's real focus, so a launch in the background notifies at once.
    pub fn with_focus(focused: bool) -> Self {
        Self { focused: AtomicBool::new(focused), obscured: AtomicBool::new(false), last: Mutex::new(HashMap::new()) }
    }

    pub fn set_focused(&self, focused: bool) {
        self.focused.store(focused, Ordering::SeqCst);
    }

    pub fn set_obscured(&self, obscured: bool) {
        self.obscured.store(obscured, Ordering::SeqCst);
    }

    /// Unfocused is `!focused || obscured` (obscured = minimized or not visible).
    pub fn is_focused(&self) -> bool {
        self.focused.load(Ordering::SeqCst) && !self.obscured.load(Ordering::SeqCst)
    }

    /// True when this update would move an agent session into NeedsYou or Finished (a new
    /// entry, compared with the last state seen). Records nothing. Lets the caller skip window
    /// queries and lookups for the many updates that cannot notify.
    pub fn enters_notifiable(&self, info: &SessionInfo) -> bool {
        let now = StateKind::from(&info.state);
        matches!(info.kind, SessionKind::Agent { .. })
            && matches!(now, StateKind::NeedsYou | StateKind::Finished)
            && self.last.lock().unwrap_or_else(|e| e.into_inner()).get(&info.id) != Some(&now)
    }

    /// Records the session's state without notifying (for updates that cannot notify).
    pub fn record(&self, info: &SessionInfo) {
        self.last.lock().unwrap_or_else(|e| e.into_inner()).insert(info.id.clone(), StateKind::from(&info.state));
    }

    /// Forget a removed session.
    pub fn forget(&self, id: &str) {
        self.last.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    /// A note for an agent session entering NeedsYou or Finished while the window is in the
    /// background, once per entry. `prev` is the state before this update; when `None`, the last
    /// state this notifier saw for the session is used. Text never includes the task or output.
    pub fn on_update(&self, prev: Option<&SessionState>, info: &SessionInfo, builder_name: &str) -> Option<Note> {
        let now = StateKind::from(&info.state);
        let seen = self.last.lock().unwrap_or_else(|e| e.into_inner()).insert(info.id.clone(), now);
        if !matches!(info.kind, SessionKind::Agent { .. }) || self.is_focused() {
            return None;
        }
        let before = prev.map(StateKind::from).or(seen);
        if before == Some(now) {
            return None;
        }
        let body = match &info.state {
            SessionState::NeedsYou { reason } => {
                format!("needs you: {}", reason.chars().take(REASON_MAX_CHARS).collect::<String>())
            }
            SessionState::Finished => "finished".to_string(),
            _ => return None,
        };
        Some(Note { title: builder_name.to_string(), body })
    }
}

/// Agent sessions in NeedsYou or Finished. Terminals never count.
pub fn badge_count(sessions: &[SessionInfo]) -> i64 {
    sessions
        .iter()
        .filter(|s| {
            matches!(s.kind, SessionKind::Agent { .. })
                && matches!(s.state, SessionState::NeedsYou { .. } | SessionState::Finished)
        })
        .count() as i64
}

/// The last badge value set, so the dock is only touched when the count changes.
#[derive(Default)]
pub struct BadgeCache(Mutex<Option<i64>>);

impl BadgeCache {
    /// True (and remembers `n`) when `n` differs from the last value; the first call is true.
    pub fn changed(&self, n: i64) -> bool {
        let mut last = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if *last == Some(n) {
            return false;
        }
        *last = Some(n);
        true
    }
}

/// The argument for `set_badge_count`: `None` clears.
pub fn badge_value(n: i64) -> Option<i64> {
    (n > 0).then_some(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str, kind: SessionKind, state: SessionState) -> SessionInfo {
        SessionInfo {
            id: id.into(),
            workspace_id: "w".into(),
            kind,
            task: Some("SECRET TASK TEXT".into()),
            state,
            steps: 0,
            started_at: 0,
            last_output_at: 0,
            reached_finished: false,
            worktree: None,
            command_preview: "SECRET OUTPUT cmd".into(),
            awaiting_decision: false,
            busy: false,
            rev: 1,
            spot: None,
        }
    }
    fn agent(id: &str, state: SessionState) -> SessionInfo {
        info(id, SessionKind::Agent { builder_id: "b".into() }, state)
    }
    fn needs(r: &str) -> SessionState {
        SessionState::NeedsYou { reason: r.into() }
    }

    #[test]
    fn notifies_once_per_entry_only_when_unfocused() {
        let n = Notifier::new();
        // Focused: nothing, but the state is still tracked.
        assert_eq!(n.on_update(None, &agent("a", needs("ok?")), "Bob"), None);
        n.set_focused(false);
        // Still NeedsYou: not a new entry.
        assert_eq!(n.on_update(None, &agent("a", needs("ok?")), "Bob"), None);
        // Working then NeedsYou again: a new entry.
        assert_eq!(n.on_update(None, &agent("a", SessionState::Working), "Bob"), None);
        assert_eq!(
            n.on_update(None, &agent("a", needs("run rm")), "Bob"),
            Some(Note { title: "Bob".into(), body: "needs you: run rm".into() })
        );
        // Reason changes while staying NeedsYou: no repeat.
        assert_eq!(n.on_update(None, &agent("a", needs("other")), "Bob"), None);
        // Finished fires once.
        let fin = agent("a", SessionState::Finished);
        assert_eq!(n.on_update(None, &fin, "Bob").map(|x| x.body), Some("finished".into()));
        assert_eq!(n.on_update(None, &fin, "Bob"), None);
        // An explicit prev wins over the tracked state.
        assert!(n.on_update(Some(&SessionState::Working), &fin, "Bob").is_some());
        assert_eq!(n.on_update(Some(&SessionState::Finished), &fin, "Bob"), None);
        // Other states never notify.
        assert_eq!(n.on_update(None, &agent("a", SessionState::Stuck { reason: "x".into() }), "Bob"), None);
        assert_eq!(n.on_update(None, &agent("a", SessionState::Ended { exit_code: Some(0) }), "Bob"), None);
    }

    #[test]
    fn no_note_for_terminals() {
        let n = Notifier::new();
        n.set_focused(false);
        assert_eq!(n.on_update(None, &info("t", SessionKind::Terminal, SessionState::Finished), "T"), None);
        assert_eq!(n.on_update(None, &info("t", SessionKind::Terminal, needs("x")), "T"), None);
    }

    #[test]
    fn a_background_launch_notifies_before_any_focus_event() {
        let n = Notifier::with_focus(false);
        assert!(n.on_update(None, &agent("a", SessionState::Finished), "B").is_some());
    }

    #[test]
    fn minimized_or_hidden_counts_as_unfocused() {
        let n = Notifier::new();
        n.set_obscured(true);
        assert!(n.on_update(None, &agent("a", SessionState::Finished), "B").is_some());
    }

    #[test]
    fn note_body_never_contains_task_or_output() {
        let n = Notifier::new();
        n.set_focused(false);
        let long = "r".repeat(300);
        let note = n.on_update(None, &agent("a", needs(&long)), "Bob").unwrap();
        assert_eq!(note.body.chars().count(), "needs you: ".len() + 80);
        let fin = n.on_update(None, &agent("b", SessionState::Finished), "Bob").unwrap();
        for t in [&note.title, &note.body, &fin.title, &fin.body] {
            assert!(!t.contains("SECRET"), "{t}");
        }
        assert_eq!(fin.body, "finished");
    }

    #[test]
    fn badge_counts_needs_and_finished() {
        let s = vec![
            agent("1", needs("x")),
            agent("2", SessionState::Finished),
            agent("3", SessionState::Working),
            agent("4", SessionState::Stuck { reason: "s".into() }),
            info("5", SessionKind::Terminal, SessionState::Finished),
        ];
        assert_eq!(badge_count(&s), 2);
    }

    #[test]
    fn enters_notifiable_only_on_a_new_needs_or_finished_entry() {
        let n = Notifier::new();
        let fin = agent("a", SessionState::Finished);
        assert!(!n.enters_notifiable(&agent("a", SessionState::Working)));
        assert!(n.enters_notifiable(&fin), "first sight of Finished");
        assert!(n.enters_notifiable(&fin), "nothing recorded by asking");
        n.record(&fin);
        assert!(!n.enters_notifiable(&fin), "already Finished");
        assert!(n.enters_notifiable(&agent("a", needs("x"))));
        n.record(&agent("a", needs("x")));
        assert!(!n.enters_notifiable(&agent("a", needs("other reason"))), "same entry");
        assert!(!n.enters_notifiable(&info("t", SessionKind::Terminal, SessionState::Finished)));
        // It agrees with on_update: whenever on_update notifies, enters_notifiable said so first.
        n.set_focused(false);
        let w = agent("a", SessionState::Working);
        assert!(!n.enters_notifiable(&w));
        assert_eq!(n.on_update(None, &w, "B"), None);
        assert!(n.enters_notifiable(&fin));
        assert!(n.on_update(None, &fin, "B").is_some());
        assert!(!n.enters_notifiable(&fin));
    }

    #[test]
    fn badge_cache_reports_only_changes() {
        let c = BadgeCache::default();
        assert!(c.changed(0), "first value is always applied");
        assert!(!c.changed(0));
        assert!(c.changed(2));
        assert!(!c.changed(2));
        assert!(c.changed(0));
    }

    #[test]
    fn badge_clears_at_zero() {
        assert_eq!(badge_count(&[]), 0);
        assert_eq!(badge_value(0), None);
        assert_eq!(badge_value(3), Some(3));
    }
}
