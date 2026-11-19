//! The owner's queue, on the Rust side: what the menu bar lists and the Dock badge counts.
//! Mirrors `src/state/queue.ts` (the queue the window shows): change both, and both tests.
use crate::model::{SessionInfo, SessionKind, SessionState};

/// Why a session waits on the owner. Declared in queue order: a decision the app can take first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum QueueReason {
    Decide,
    Answer,
    Stuck,
    Review,
}

impl QueueReason {
    /// The window's `QUEUE_LABEL`.
    pub fn label(self) -> &'static str {
        match self {
            QueueReason::Decide => "Wants a decision",
            QueueReason::Answer => "Asking you",
            QueueReason::Stuck => "Stuck",
            QueueReason::Review => "Ready to review",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct QueueItem {
    pub reason: QueueReason,
    pub session: SessionInfo,
}

/// Why the session waits on the owner, or None when it does not (`queueReason`).
pub fn queue_reason(s: &SessionInfo) -> Option<QueueReason> {
    if !matches!(s.kind, SessionKind::Agent { .. }) || s.paused || s.parked.is_some() {
        return None;
    }
    match s.state {
        SessionState::NeedsYou { .. } if s.awaiting_decision => Some(QueueReason::Decide),
        SessionState::NeedsYou { .. } => Some(QueueReason::Answer),
        SessionState::Stuck { .. } => Some(QueueReason::Stuck),
        SessionState::Finished => Some(QueueReason::Review),
        _ => None,
    }
}

/// Since when it has waited: its last state change, else its last output, else its start (`waitingSince`).
pub fn waiting_since(s: &SessionInfo) -> i64 {
    [s.state_since, s.last_output_at].into_iter().find(|&t| t != 0).unwrap_or(s.started_at)
}

/// Every agent session waiting on the owner, in the order they take them (`ownerQueue`).
pub fn owner_queue(sessions: &[SessionInfo], workspace_ids: &[String]) -> Vec<QueueItem> {
    let mut out: Vec<QueueItem> = sessions
        .iter()
        .filter(|s| workspace_ids.contains(&s.workspace_id))
        .filter_map(|s| queue_reason(s).map(|reason| QueueItem { reason, session: s.clone() }))
        .collect();
    out.sort_by(|a, b| {
        a.reason
            .cmp(&b.reason)
            .then(waiting_since(&a.session).cmp(&waiting_since(&b.session)))
            .then_with(|| a.session.id.cmp(&b.session.id))
    });
    out
}

/// "4m", "1h 20m": how long something has waited (`waitedLabel`).
pub fn waited_label(ms: i64) -> String {
    let m = ms.max(0) / 60_000;
    match (m / 60, m % 60) {
        (0, 0) => "just now".to_string(),
        (0, m) => format!("{m}m"),
        (h, m) => format!("{h}h {m}m"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sess(id: &str, state: SessionState, f: impl FnOnce(&mut SessionInfo)) -> SessionInfo {
        let mut s = SessionInfo {
            id: id.into(),
            workspace_id: "w1".into(),
            kind: SessionKind::Agent { builder_id: format!("b-{id}") },
            task: None,
            title: None,
            state,
            steps: 0,
            started_at: 0,
            last_output_at: 0,
            reached_finished: false,
            worktree: None,
            command_preview: String::new(),
            awaiting_decision: false,
            busy: false,
            rev: 1,
            spot: None,
            paused: false,
            subagents: vec![],
            state_since: 0,
            last_message: None,
            asking: None,
            questions: vec![],
            parked: None,
        };
        f(&mut s);
        s
    }
    fn needs(r: &str) -> SessionState {
        SessionState::NeedsYou { reason: r.into() }
    }
    fn ws() -> Vec<String> {
        vec!["w1".to_string()]
    }

    #[test]
    fn order_decide_answer_stuck_review_oldest_first() {
        let sessions = vec![
            sess("review-old", SessionState::Finished, |s| s.state_since = 10),
            sess("review-new", SessionState::Finished, |s| s.state_since = 50),
            sess("stuck", SessionState::Stuck { reason: "no output".into() }, |s| s.state_since = 5),
            sess("ask", needs("which db?"), |s| s.state_since = 40),
            sess("decide-new", needs("Bash"), |s| { s.awaiting_decision = true; s.state_since = 30 }),
            sess("decide-old", needs("Bash"), |s| { s.awaiting_decision = true; s.state_since = 20 }),
            sess("working", SessionState::Working, |_| {}),
        ];
        let got: Vec<(String, QueueReason)> = owner_queue(&sessions, &ws()).into_iter().map(|q| (q.session.id, q.reason)).collect();
        let want: Vec<(String, QueueReason)> = [
            ("decide-old", QueueReason::Decide),
            ("decide-new", QueueReason::Decide),
            ("ask", QueueReason::Answer),
            ("stuck", QueueReason::Stuck),
            ("review-old", QueueReason::Review),
            ("review-new", QueueReason::Review),
        ]
        .into_iter()
        .map(|(i, r)| (i.to_string(), r))
        .collect();
        assert_eq!(got, want);
    }

    #[test]
    fn parked_paused_terminal_orphaned_stay_out() {
        let sessions = vec![
            sess("parked", SessionState::Finished, |s| s.parked = Some(String::new())),
            sess("paused", SessionState::Ended { exit_code: None }, |s| s.paused = true),
            sess("paused-fin", SessionState::Finished, |s| s.paused = true),
            sess("term", SessionState::Finished, |s| s.kind = SessionKind::Terminal),
            sess("orphan", SessionState::Finished, |s| s.workspace_id = "gone".into()),
        ];
        assert!(owner_queue(&sessions, &ws()).is_empty());
    }

    #[test]
    fn ties_break_by_id_and_waiting_since_falls_back() {
        let sessions = vec![
            sess("b", SessionState::Finished, |s| s.started_at = 7),
            sess("a", SessionState::Finished, |s| s.last_output_at = 7),
            sess("c", SessionState::Finished, |s| { s.state_since = 3; s.started_at = 99 }),
        ];
        let ids: Vec<String> = owner_queue(&sessions, &ws()).into_iter().map(|q| q.session.id).collect();
        assert_eq!(ids, ["c", "a", "b"]);
    }

    #[test]
    fn labels_match_the_window() {
        assert_eq!(QueueReason::Decide.label(), "Wants a decision");
        assert_eq!(QueueReason::Answer.label(), "Asking you");
        assert_eq!(QueueReason::Stuck.label(), "Stuck");
        assert_eq!(QueueReason::Review.label(), "Ready to review");
    }

    #[test]
    fn waited_label_formats() {
        assert_eq!(waited_label(0), "just now");
        assert_eq!(waited_label(59_999), "just now");
        assert_eq!(waited_label(240_000), "4m");
        assert_eq!(waited_label(4_800_000), "1h 20m");
        assert_eq!(waited_label(-5), "just now");
    }
}
