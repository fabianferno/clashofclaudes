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
    /// Runs once, while the next call is under way (the worker holds no lock then).
    during: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl FakeCli {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
    fn during(&self, f: impl FnOnce() + Send + 'static) {
        *self.during.lock().unwrap() = Some(Box::new(f));
    }
    fn next(&self, r: Result<&str, CliError>) {
        self.script.lock().unwrap().push_back(r.map(str::to_string));
    }
}

impl BoardCli for FakeCli {
    fn raw(&self, args: &[String]) -> Result<Output, CliError> {
        self.calls.lock().unwrap().push(args.join(" "));
        let during = self.during.lock().unwrap().take();
        if let Some(f) = during {
            f();
        }
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
        answerable: false,
        by: None,
    }
}

fn working(id: &str, since: i64) -> SessionView {
    view(id, SessionState::Working, since)
}
fn decide(id: &str, since: i64) -> SessionView {
    view(id, SessionState::NeedsYou { reason: "permission".into() }, since)
}
fn record(root: &str) -> Published {
    Published { board: "/village".into(), channel: "v/ada/w/api".into(), root: Some(root.into()), state: Wire::Working, wait: None, since: 1, titled: false, unshared: false, block: None }
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
    assert!(calls[1].starts_with("board reply msg_1 Wants a decision: `Bash: npm test`\n\n```json coc\n{"), "{calls:?}");
    assert!(calls[1].contains("\n``` --label coc.since=2 --idempotency-key coc-s1-2-decide"), "{calls:?}");
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

/// Against the real board: `COC_BOARD_VERCEL=/path/to/vercel cargo test real_board -- --ignored --nocapture`.
/// Writes one thread to the board `coc-spike` on the login's default team and prints its root id.
#[test]
#[ignore]
fn real_board_round_trip() {
    use crate::board::cli::VercelCli;
    let program = std::env::var("COC_BOARD_VERCEL").expect("COC_BOARD_VERCEL");
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(VercelCli { program: Some(program.into()), cwd: dir.path().to_path_buf(), timeout: Duration::from_secs(60) });
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let c = clock.clone();
    let path = dir.path().join("board.json");
    let p = Publisher::new(cli, path.clone(), Arc::new(|_| vec!["src/export.rs".to_string(), "README.md".to_string()]), Arc::new(move || c.load(Ordering::SeqCst)));
    let st = crate::board::cli::status(p.cli.as_ref(), &Target { team: None, name: "coc-spike".into() });
    assert_eq!(st.state, "ready", "{st:?}");
    let owner = st.handle.unwrap();
    p.configure(Config { owner: owner.clone(), ..cfg("coc-spike") });
    let id = format!("real-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
    let chan = Some(format!("v/{owner}/w/real-run"));
    let go = |v: SessionView| {
        p.update(SessionView { channel: chan.clone(), ..v });
        clock.fetch_add(SETTLE_MS, Ordering::SeqCst);
        p.step();
        assert_eq!(p.status().0, None, "the board refused a write");
    };
    go(working(&id, 1));
    go(decide(&id, 2));
    go(working(&id, 3));
    let mut done = view(&id, SessionState::Finished, 4);
    done.info.last_message = Some("Export added, tests pass.".into());
    done.info.title = Some("CSV export".into());
    go(done);
    let root = Store::load(&path).sessions[&id].root.clone().unwrap();
    println!("ROOT {root} CHANNEL {}", chan.clone().unwrap());
    p.closed(&id, Some(Outcome::Accepted));
    p.step();
    assert_eq!(p.status().0, None);
    assert!(Store::load(&path).sessions.is_empty());
}

const CLOSED: &str = "board label msg_1 coc.state=closed --as village --json --name village";

#[test]
fn the_managers_removal_arriving_first_does_not_lose_the_outcome() {
    let r = rig();
    r.p.update(decide("s1", 1));
    r.settle();
    r.cli.take();
    r.p.closed("s1", None); // the manager's removal comes before the command knows the outcome
    r.p.step(); // the idle worker looks at once
    r.p.closed("s1", Some(Outcome::Discarded));
    r.p.step();
    assert_eq!(r.cli.take(), ["board label msg_1 coc.state=closed coc.outcome=discarded --unset coc.wait --as village --json --name village"]);
    r.settle();
    assert!(r.cli.calls().is_empty());
}

#[test]
fn a_close_without_an_outcome_is_written_once_it_has_waited_for_one() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.settle();
    r.cli.take();
    r.p.closed("s1", None);
    r.p.step();
    assert!(r.cli.calls().is_empty());
    r.settle();
    assert_eq!(r.cli.calls(), [CLOSED]);
}

#[test]
fn a_busy_builder_still_settles() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.wait(1_500);
    let mut again = working("s1", 1);
    again.info.steps = 7; // a tool step: an update, not a new state
    r.p.update(again);
    r.wait(600);
    assert_eq!(r.cli.calls().len(), 1, "{:?}", r.cli.calls());
}

#[test]
fn a_session_closed_while_its_first_post_is_under_way_is_closed_on_the_board() {
    let r = rig();
    let p = r.p.clone();
    r.cli.during(move || p.closed("s1", Some(Outcome::Accepted)));
    r.p.update(working("s1", 1));
    r.settle();
    let calls = r.cli.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(calls[0].starts_with("board post"));
    assert_eq!(calls[1], "board label msg_1 coc.state=closed coc.outcome=accepted --as village --json --name village");
    assert!(r.stored().sessions.is_empty());
}

#[test]
fn a_session_closed_while_its_first_post_fails_is_not_posted_later() {
    let r = rig();
    let p = r.p.clone();
    r.cli.during(move || p.closed("s1", None));
    r.cli.next(Err(CliError::Retryable("offline".into())));
    r.p.update(working("s1", 1));
    r.settle();
    r.wait(600_000);
    assert_eq!(r.cli.calls().len(), 1, "{:?}", r.cli.calls());
    assert!(r.stored().sessions.is_empty());
}

#[test]
fn turning_off_while_a_post_is_under_way_closes_what_it_posted() {
    let r = rig();
    let p = r.p.clone();
    r.cli.during(move || p.configure(Config { enabled: false, ..cfg("village") }));
    r.p.update(working("s1", 1));
    r.settle();
    let calls = r.cli.take();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[1], CLOSED);
    assert!(r.stored().sessions["s1"].unshared);
    r.p.update(working("s1", 2));
    r.settle();
    assert!(r.cli.calls().is_empty());
}

#[test]
fn unsharing_while_a_post_is_under_way_closes_what_it_posted() {
    let r = rig();
    let p = r.p.clone();
    r.cli.during(move || p.update(SessionView { channel: None, ..working("s1", 1) }));
    r.p.update(working("s1", 1));
    r.settle();
    let calls = r.cli.take();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[1], CLOSED);
    assert!(r.stored().sessions["s1"].unshared);
}

#[test]
fn changing_the_board_while_a_post_is_under_way_leaves_nothing_open_on_the_old_one() {
    let r = rig();
    let p = r.p.clone();
    r.cli.during(move || p.configure(cfg("ops")));
    r.p.update(working("s1", 1));
    r.settle();
    let calls = r.cli.take();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(calls[0].ends_with("--name village"));
    assert_eq!(calls[1], CLOSED);
    assert!(r.stored().sessions.is_empty(), "the old board's thread is not remembered as the new board's");
}

#[test]
fn threads_from_another_board_are_closed_there_at_launch() {
    let mut seed = Store::default();
    seed.sessions.insert("s1".into(), Published { board: "acme/old".into(), ..record("msg_old") });
    let r = rig_with(Some(seed));
    r.p.configure(cfg("village"));
    r.p.step();
    assert_eq!(r.cli.take(), ["board label msg_old coc.state=closed --as village --json --name old --scope acme"]);
    assert!(r.stored().sessions.is_empty());
    r.p.update(working("s1", 1));
    r.settle();
    assert!(r.cli.calls()[0].starts_with("board post"), "{:?}", r.cli.calls());
}

#[test]
fn a_board_that_keeps_failing_does_not_hold_up_the_new_one_for_good() {
    let r = rig();
    r.p.update(working("s1", 1));
    r.settle();
    r.cli.take();
    for _ in 0..DRAIN_TRIES {
        r.cli.next(Err(CliError::Retryable("old board down".into())));
    }
    r.p.configure(cfg("ops"));
    r.p.update(working("s1", 1));
    for _ in 0..(DRAIN_TRIES + 2) {
        r.wait(400_000);
    }
    let calls = r.cli.calls();
    assert_eq!(calls.iter().filter(|c| c.ends_with("--name village")).count(), DRAIN_TRIES as usize, "{calls:?}");
    assert!(calls.last().unwrap().starts_with("board post") && calls.last().unwrap().ends_with("--name ops"), "{calls:?}");
}

// Writes addressed to a message (the phone remote's results, tickets, records, heartbeat).
fn msg(n: u32) -> MsgWrite {
    MsgWrite::ReplyTo { id: format!("msg_a{n}"), text: format!("r{n}"), labels: vec![], key: format!("k{n}") }
}

#[test]
fn message_writes_go_in_order_and_survive_a_retry() {
    let r = rig();
    let got = Arc::new(Mutex::new(Vec::new()));
    for n in 1..=3 {
        let got = got.clone();
        r.p.send(msg(n), Some(Box::new(move |id| got.lock().unwrap().push((n, id)))));
    }
    r.cli.next(Ok(r#"{"message":{"id":"msg_r1"},"outcome":"posted"}"#));
    r.cli.next(Err(CliError::Retryable("busy".into())));
    r.p.step();
    assert_eq!(r.cli.take().len(), 2, "the second failed: the third waits behind it");
    r.wait(2_000);
    let calls = r.cli.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(calls[0].starts_with("board reply msg_a2 r2 --idempotency-key k2 --as village"), "{calls:?}");
    assert!(calls[1].starts_with("board reply msg_a3 r3"), "{calls:?}");
    let got = got.lock().unwrap().clone();
    assert_eq!(got.iter().map(|(n, _)| *n).collect::<Vec<_>>(), [1, 2, 3]);
    assert_eq!(got[0].1.as_deref(), Some("msg_r1"));
}

#[test]
fn a_message_write_is_dropped_after_five_tries() {
    let r = rig();
    let got = Arc::new(Mutex::new(Vec::new()));
    let g = got.clone();
    r.p.send(msg(1), Some(Box::new(move |id| g.lock().unwrap().push(id))));
    for _ in 0..DRAIN_TRIES {
        r.cli.next(Err(CliError::Retryable("down".into())));
    }
    r.p.step();
    for _ in 0..DRAIN_TRIES {
        r.wait(RETRY_MAX_MS);
    }
    assert_eq!(r.cli.take().len(), DRAIN_TRIES as usize);
    assert_eq!(*got.lock().unwrap(), [None], "told it was not delivered");
    r.wait(RETRY_MAX_MS);
    assert!(r.cli.calls().is_empty());
}

#[test]
fn message_writes_wait_while_the_worker_is_stopped_or_off() {
    let r = rig();
    r.cli.next(Err(CliError::SignedOut("no login".into())));
    r.p.send(msg(1), None);
    r.p.step();
    assert_eq!(r.cli.take().len(), 1);
    r.wait(RETRY_MAX_MS);
    assert!(r.cli.calls().is_empty(), "stopped: nothing is tried");
    r.p.check_again();
    r.p.step();
    assert_eq!(r.cli.take().len(), 1, "kept, and sent once the login is back");

    let off = rig_with(None);
    off.p.send(msg(1), None);
    off.p.step();
    assert!(off.cli.calls().is_empty(), "no board is set up");
}

#[test]
fn turning_the_board_off_forgets_queued_message_writes() {
    let r = rig();
    r.cli.next(Err(CliError::Retryable("busy".into())));
    r.p.send(msg(1), None);
    r.p.step();
    r.p.configure(Config { enabled: false, ..cfg("village") });
    r.cli.take();
    r.wait(RETRY_MAX_MS);
    assert!(r.cli.calls().iter().all(|c| !c.contains("msg_a1")), "{:?}", r.cli.calls());
}

#[test]
fn a_message_write_forgotten_with_its_board_is_told_so() {
    let r = rig();
    let got = Arc::new(Mutex::new(Vec::new()));
    let g = got.clone();
    r.cli.next(Err(CliError::Retryable("busy".into())));
    r.p.send(msg(1), Some(Box::new(move |id| g.lock().unwrap().push(id))));
    r.p.step();
    r.p.configure(cfg("another-board"));
    assert_eq!(*got.lock().unwrap(), [None], "its sender is not left waiting for ever");
}

#[test]
fn open_block_and_root_lookup() {
    let r = rig();
    r.p.update(SessionView { answerable: true, ..decide("s1", 2) });
    r.settle();
    let (block, since) = r.p.open_block("s1").expect("the block of the open wait");
    assert_eq!(since, 2);
    assert!(block.contains(r#""can":["allow","deny"]"#), "{block}");
    assert_eq!(r.p.session_for_root("msg_1").as_deref(), Some("s1"));
    assert_eq!(r.p.session_for_root("msg_9"), None);
    r.p.update(working("s1", 3));
    r.settle();
    assert_eq!(r.p.open_block("s1"), None);
}
