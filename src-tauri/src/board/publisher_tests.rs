use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use super::*;
use crate::board::cli::Output;
use crate::board::store::Store;
use crate::board::{Published, Wire};
use crate::model::{SessionKind, SessionState};

/// Records every call; answers from a script, or with a fresh message id.
#[derive(Default)]
struct FakeCli {
    calls: Mutex<Vec<String>>,
    script: Mutex<VecDeque<Result<String, CliError>>>,
    next_id: AtomicI64,
}

impl FakeCli {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
    fn next(&self, r: Result<&str, CliError>) {
        self.script.lock().unwrap().push_back(r.map(str::to_string));
    }
}

impl BoardCli for FakeCli {
    fn raw(&self, args: &[String]) -> Result<Output, CliError> {
        self.calls.lock().unwrap().push(args.join(" "));
        let scripted = self.script.lock().unwrap().pop_front();
        let stdout = match scripted {
            Some(r) => r?,
            None => format!(r#"{{"message":{{"id":"msg_{}"}},"outcome":"posted"}}"#, self.next_id.fetch_add(1, Ordering::SeqCst) + 1),
        };
        Ok(Output { ok: true, stdout, stderr: String::new() })
    }
}

struct Rig {
    cli: Arc<FakeCli>,
    clock: Arc<AtomicI64>,
    path: PathBuf,
    p: Arc<Publisher>,
    _dir: tempfile::TempDir,
}

fn rig_with(seed: Option<Store>) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board.json");
    if let Some(s) = seed {
        s.save(&path).unwrap();
    }
    let cli = Arc::new(FakeCli::default());
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let c = clock.clone();
    let p = Publisher::new(cli.clone(), path.clone(), Arc::new(|_| vec!["a.rs".to_string()]), Arc::new(move || c.load(Ordering::SeqCst)));
    Rig { cli, clock, path, p, _dir: dir }
}

fn rig() -> Rig {
    let r = rig_with(None);
    r.p.configure(cfg("village"));
    r
}

impl Rig {
    fn wait(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
        self.p.step();
    }
    /// Past the settle time, and published.
    fn settle(&self) {
        self.wait(SETTLE_MS);
    }
    fn stored(&self) -> Store {
        Store::load(&self.path)
    }
}

fn cfg(name: &str) -> Config {
    Config { enabled: true, target: Target { team: None, name: name.into() }, owner: "ada".into(), host_id: "h1".into(), share_details: true }
}

fn view(id: &str, state: SessionState, since: i64) -> SessionView {
    let awaiting = matches!(&state, SessionState::NeedsYou { reason } if reason == "permission");
    SessionView {
        info: SessionInfo {
            id: id.into(),
            workspace_id: "w1".into(),
            kind: SessionKind::Agent { builder_id: "b1".into() },
            task: Some("add a CSV export".into()),
            title: None,
            state,
            steps: 0,
            started_at: 1,
            last_output_at: 1,
            reached_finished: false,
            worktree: None,
            command_preview: String::new(),
            awaiting_decision: awaiting,
            busy: false,
            rev: 1,
            spot: None,
            paused: false,
            subagents: vec![],
            state_since: since,
            last_message: None,
            asking: awaiting.then(|| "Bash: npm test".to_string()),
            questions: vec![],
            parked: None,
        },
        builder: "Wizard".into(),
        agent: AgentKind::Claude,
        channel: Some("v/ada/w/api".into()),
    }
}

fn working(id: &str, since: i64) -> SessionView {
    view(id, SessionState::Working, since)
}
fn decide(id: &str, since: i64) -> SessionView {
    view(id, SessionState::NeedsYou { reason: "permission".into() }, since)
}
fn record(root: &str) -> Published {
    Published { board: "/village".into(), channel: "v/ada/w/api".into(), root: Some(root.into()), state: Wire::Working, wait: None, since: 1, titled: false, unshared: false }
}

#[test]
fn update_returns_at_once_and_writes_later() {
    let r = rig();
    r.p.update(working("s1", 1));
    assert!(r.cli.calls().is_empty());
    r.p.step();
    assert!(r.cli.calls().is_empty(), "not settled yet");
    r.settle();
    let calls = r.cli.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert!(calls[0].starts_with("board post v/ada/w/api **Wizard** (Claude Code): add a CSV export"), "{calls:?}");
    assert!(calls[0].ends_with("--idempotency-key coc-s1-root --ensure --as village --json --name village"), "{calls:?}");
    assert_eq!(r.stored().sessions["s1"].root.as_deref(), Some("msg_1"));
    assert!(r.p.status().1.is_some());
}

#[test]
fn a_flicker_writes_once() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.settle();
    r.cli.take();
    r.p.update(decide("s1", 2));
    r.wait(400);
    r.p.update(working("s1", 3));
    r.wait(400);
    assert!(r.cli.calls().is_empty());
    r.settle();
    assert_eq!(r.cli.calls(), ["board label msg_1 coc.since=3 --as village --json --name village"]);
}

#[test]
fn a_waiting_session_gets_its_label_then_its_reply() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.settle();
    r.cli.take();
    r.p.update(decide("s1", 2));
    r.settle();
    let calls = r.cli.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(calls[0].starts_with("board label msg_1 coc.state=needs_you coc.wait=decide coc.since=2"));
    assert!(calls[1].starts_with("board reply msg_1 Wants a decision: `Bash: npm test` --label coc.since=2 --idempotency-key coc-s1-2-decide"));
}

#[test]
fn a_finished_session_lists_its_files() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.settle();
    r.p.update(view("s1", SessionState::Finished, 9));
    r.settle();
    assert!(r.cli.calls().iter().any(|c| c.contains("Changed: a.rs")), "{:?}", r.cli.calls());
}

#[test]
fn retry_keeps_only_the_newest() {
    let r = rig();
    r.cli.next(Err(CliError::Retryable("offline".into())));
    r.p.update(working("s1", 1));
    r.settle();
    assert_eq!(r.cli.take().len(), 1);
    assert_eq!(r.p.status().0.as_deref(), Some("offline"));
    r.p.update(decide("s1", 2));
    r.p.update(view("s1", SessionState::Stuck { reason: "limit".into() }, 3));
    r.wait(500);
    assert!(r.cli.calls().is_empty(), "waits before trying again");
    r.settle();
    let calls = r.cli.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(calls[0].starts_with("board post") && calls[0].contains("coc.state=stuck"), "{calls:?}");
    assert!(calls[1].starts_with("board reply msg_1 Stuck: limit"), "{calls:?}");
    assert_eq!(r.p.status().0, None);
}

#[test]
fn the_wait_between_retries_grows() {
    let r = rig();
    for _ in 0..3 {
        r.cli.next(Err(CliError::Retryable("offline".into())));
    }
    r.p.update(working("s1", 1));
    r.settle(); // 1st failure: wait 2 s
    r.wait(2_000); // 2nd failure: wait 4 s
    assert_eq!(r.cli.take().len(), 2);
    r.wait(2_000);
    assert!(r.cli.calls().is_empty(), "still inside the 4 s wait");
    r.wait(2_000); // 3rd failure
    assert_eq!(r.cli.take().len(), 1);
}

#[test]
fn fatal_drops_the_write_and_records_the_error() {
    let r = rig();
    r.cli.next(Err(CliError::Fatal("no access".into())));
    r.p.update(working("s1", 1));
    r.settle();
    assert_eq!(r.cli.take().len(), 1);
    assert_eq!(r.p.status().0.as_deref(), Some("no access"));
    r.wait(600_000);
    assert!(r.cli.calls().is_empty());
    assert_eq!(r.p.stopped_reason(), None);
}

#[test]
fn signed_out_stops_until_check_again() {
    let r = rig();
    r.cli.next(Err(CliError::SignedOut("Run vercel login.".into())));
    r.p.update(working("s1", 1));
    r.settle();
    assert_eq!(r.cli.take().len(), 1);
    assert_eq!(r.p.stopped_reason(), Some(CliError::SignedOut("Run vercel login.".into())));
    r.wait(600_000);
    assert!(r.cli.calls().is_empty());
    r.p.check_again();
    r.p.step();
    assert!(r.cli.calls()[0].starts_with("board post"));
    assert_eq!(r.p.stopped_reason(), None);
}

#[test]
fn turning_off_closes_once_and_posts_nothing_after() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.settle();
    r.cli.take();
    r.p.update(decide("s1", 2)); // queued, not settled
    r.p.configure(Config { enabled: false, ..cfg("village") });
    r.settle();
    assert_eq!(r.cli.take(), ["board label msg_1 coc.state=closed --as village --json --name village"]);
    r.p.update(working("s1", 3));
    r.settle();
    assert!(r.cli.calls().is_empty());
    // Turning it on again reopens the same thread.
    r.p.configure(cfg("village"));
    r.p.update(working("s1", 3));
    r.settle();
    let calls = r.cli.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert!(calls[0].starts_with("board label msg_1 coc.state=working coc.since=3"), "{calls:?}");
}

#[test]
fn unsharing_a_workspace_closes_its_thread_and_sharing_again_reopens_it() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.settle();
    r.cli.take();
    r.p.update(SessionView { channel: None, ..working("s1", 1) });
    r.p.step();
    assert_eq!(r.cli.take(), ["board label msg_1 coc.state=closed --as village --json --name village"]);
    assert!(r.stored().sessions["s1"].unshared);
    r.p.update(SessionView { channel: None, ..decide("s1", 2) });
    r.settle();
    assert!(r.cli.calls().is_empty());
    r.p.update(decide("s1", 2));
    r.settle();
    let calls = r.cli.calls();
    assert!(calls[0].starts_with("board label msg_1 coc.state=needs_you"), "{calls:?}");
    assert!(!calls.iter().any(|c| c.starts_with("board post")), "{calls:?}");
}

#[test]
fn a_session_never_shared_writes_nothing() {
    let r = rig();
    r.p.update(SessionView { channel: None, ..working("s1", 1) });
    r.settle();
    r.p.closed("s1", Some(Outcome::Accepted));
    r.settle();
    assert!(r.cli.calls().is_empty());
}

#[test]
fn a_lost_store_reuses_the_thread() {
    let r = rig();
    // The board answers the root's idempotency key with the thread that already exists.
    r.cli.next(Ok(r#"{"message":{"id":"msg_existing"},"outcome":"posted"}"#));
    r.p.update(working("s1", 1));
    r.settle();
    assert_eq!(r.stored().sessions["s1"].root.as_deref(), Some("msg_existing"));
    r.cli.take();
    r.p.update(working("s1", 2));
    r.settle();
    assert_eq!(r.cli.calls(), ["board label msg_existing coc.since=2 --as village --json --name village"]);
}

#[test]
fn changing_the_board_closes_old_threads_then_starts_fresh() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.settle();
    r.cli.take();
    r.p.configure(cfg("ops"));
    r.p.step();
    assert_eq!(r.cli.take(), ["board label msg_1 coc.state=closed --as village --json --name village"]);
    assert!(r.stored().sessions.is_empty());
    r.p.update(working("s1", 1));
    r.settle();
    let calls = r.cli.calls();
    assert!(calls[0].starts_with("board post") && calls[0].ends_with("--name ops"), "{calls:?}");
}

#[test]
fn launch_closes_threads_whose_session_is_gone() {
    let mut seed = Store::default();
    seed.sessions.insert("gone".into(), record("msg_gone"));
    seed.sessions.insert("here".into(), record("msg_here"));
    let r = rig_with(Some(seed));
    r.p.configure(cfg("village"));
    r.p.update(working("here", 1));
    r.wait(LAUNCH_GRACE_MS - 1);
    assert!(r.cli.calls().is_empty(), "{:?}", r.cli.calls());
    r.wait(1);
    assert_eq!(r.cli.calls(), ["board label msg_gone coc.state=closed --as village --json --name village"]);
    assert_eq!(r.stored().sessions.keys().collect::<Vec<_>>(), ["here"]);
}

#[test]
fn closing_sets_the_outcome_once() {
    let r = rig();
    r.p.update(decide("s1", 1));
    r.settle();
    r.cli.take();
    r.p.closed("s1", Some(Outcome::Accepted));
    r.p.closed("s1", None); // the manager's own removal follows the command's
    r.p.step();
    assert_eq!(r.cli.take(), ["board label msg_1 coc.state=closed coc.outcome=accepted --unset coc.wait --as village --json --name village"]);
    assert!(r.stored().sessions.is_empty());
    r.p.closed("s1", None);
    r.settle();
    assert!(r.cli.calls().is_empty());
}

#[test]
fn pause_all_marks_live_threads_paused() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.settle();
    r.cli.take();
    r.p.pause_all(Duration::ZERO);
    // Quitting ends the processes, which reports them ended: that must not reach the board.
    r.p.update(view("s1", SessionState::Ended { exit_code: None }, 5));
    r.settle();
    assert_eq!(r.cli.calls(), ["board label msg_1 coc.state=paused --as village --json --name village"]);
    assert_eq!(r.stored().sessions["s1"].state, Wire::Paused);
}

#[test]
fn nothing_is_written_while_the_feature_is_off() {
    let r = rig_with(None);
    r.p.update(working("s1", 1));
    r.settle();
    r.p.configure(Config { enabled: false, ..cfg("village") });
    r.p.update(working("s1", 1));
    r.settle();
    assert!(r.cli.calls().is_empty());
}

#[test]
fn an_unchanged_state_is_not_a_write() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.settle();
    let first = r.p.status().1;
    r.p.update(working("s1", 1));
    r.settle();
    assert_eq!(r.cli.calls().len(), 1);
    assert_eq!(r.p.status().1, first);
}

#[test]
fn quitting_forgets_states_that_had_not_settled() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.settle();
    r.cli.take();
    r.p.update(decide("s1", 2));
    r.p.update(working("s2", 1)); // never reached the board
    r.p.pause_all(Duration::ZERO);
    r.settle();
    assert_eq!(r.cli.calls(), ["board label msg_1 coc.state=paused --as village --json --name village"]);
}
