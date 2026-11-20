//! The phone remote against the real board and the deployed remote. This test plays the Mac: it
//! publishes one session, opens a pairing, confirms the phone that answers, and takes that
//! phone's actions. A browser on the deployed remote plays the phone (by hand, or `/browse`).
//!
//! `COC_BOARD_VERCEL=/path/to/vercel cargo test --lib real_remote_run -- --ignored --nocapture`
//! Board `coc-spike` on the login's default team; runs for `COC_RUN_SECS` (default 300).
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::cli::{status, Target, VercelCli};
use super::listen::{Following, Listener};
use super::phones::MemoryStore;
use super::publisher::{Config, Publisher, SessionView};
use super::remote_app::{Remote, Sessions, Village};
use crate::model::{AgentKind, AskOption, AskQuestion, SessionInfo, SessionKind, SessionState};

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A session that moves on each time the phone answers: decide, decide, a picker, finished, working.
struct Sim {
    publisher: Arc<Publisher>,
    channel: String,
    id: String,
    step: AtomicUsize,
    since: Mutex<i64>,
}

impl Sim {
    fn publish(&self) {
        let step = self.step.load(Ordering::SeqCst);
        let since = now();
        *self.since.lock().unwrap() = since;
        let mut info = SessionInfo {
            id: self.id.clone(),
            workspace_id: "w1".into(),
            kind: SessionKind::Agent { builder_id: "b1".into() },
            task: Some("add a CSV export".into()),
            title: None,
            state: SessionState::Working,
            steps: 0,
            started_at: 1,
            last_output_at: 1,
            reached_finished: false,
            worktree: None,
            command_preview: String::new(),
            awaiting_decision: false,
            busy: false,
            rev: 1,
            spot: None,
            paused: false,
            subagents: vec![],
            state_since: since,
            last_message: None,
            asking: None,
            questions: vec![],
            parked: None,
        };
        match step {
            0 | 1 => {
                info.state = SessionState::NeedsYou { reason: "permission".into() };
                info.awaiting_decision = true;
                info.asking = Some(if step == 0 { "Bash: rm -rf build".into() } else { "Bash: npm test".into() });
            }
            2 => {
                info.state = SessionState::NeedsYou { reason: "question".into() };
                info.questions = vec![AskQuestion {
                    question: "Which separator should the export use?".into(),
                    header: None,
                    options: vec![AskOption { label: "Comma".into(), description: None }, AskOption { label: "Semicolon".into(), description: None }],
                    multi_select: false,
                }];
            }
            3 => {
                info.state = SessionState::Finished;
                info.last_message = Some("Export added, tests pass.".into());
            }
            _ => {}
        }
        println!("MAC step {step}: published {:?} since {since}", info.state);
        self.publisher.update(SessionView { info, builder: "Wizard".into(), agent: AgentKind::Claude, channel: Some(self.channel.clone()), answerable: step < 2 });
    }

    fn took(&self, what: String, since: i64) -> Result<(), String> {
        if since != *self.since.lock().unwrap() {
            println!("MAC refused as stale: {what}");
            return Err("stale: that wait is over".into());
        }
        println!("MAC applied: {what}");
        self.step.fetch_add(1, Ordering::SeqCst);
        self.publish();
        Ok(())
    }
}

impl Sessions for Sim {
    fn since(&self, id: &str) -> Option<i64> {
        (id == self.id).then(|| *self.since.lock().unwrap())
    }
    fn approve_if(&self, _: &str, since: i64) -> Result<(), String> {
        self.took("ALLOW".into(), since)
    }
    fn deny_if(&self, _: &str, since: i64) -> Result<(), String> {
        self.took("DENY".into(), since)
    }
    fn prompt_if(&self, _: &str, since: i64, text: &str) -> Result<(), String> {
        self.took(format!("PROMPT {text:?}"), since)
    }
    fn pick_if(&self, _: &str, since: i64, pick: Option<usize>, text: &str) -> Result<(), String> {
        self.took(format!("PICK {pick:?} {text:?}"), since)
    }
}

#[test]
#[ignore]
fn real_remote_run() {
    let program = std::env::var("COC_BOARD_VERCEL").expect("COC_BOARD_VERCEL");
    let secs: u64 = std::env::var("COC_RUN_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(300);
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(VercelCli { program: Some(program.into()), cwd: dir.path().to_path_buf(), timeout: Duration::from_secs(60) });
    let target = Target { team: None, name: "coc-spike".into() };
    let st = status(cli.as_ref(), &target);
    assert_eq!(st.state, "ready", "{st:?}");
    let owner = st.handle.unwrap();
    let host = format!("realrun{}", now() / 1000);

    let publisher = Publisher::start(cli.clone(), dir.path().join("board.json"), Arc::new(|_| vec!["src/export.rs".to_string()]), Arc::new(now));
    publisher.configure(Config { enabled: true, target: target.clone(), owner: owner.clone(), host_id: host.clone(), share_details: true });
    let sim = Arc::new(Sim { publisher: publisher.clone(), channel: format!("v/{owner}/w/real-remote"), id: format!("remote-{}", now() / 1000), step: AtomicUsize::new(0), since: Mutex::new(0) });
    let remote = Arc::new(Remote::new(publisher.clone(), sim.clone(), Arc::new(MemoryStore::default()), dir.path().join("board-remote.json"), Arc::new(now), Arc::new(|| {})));
    remote.configure(Some(Village { host: host.clone(), owner: owner.clone(), version: "test".into() }), None);
    let hears = remote.clone();
    let listener = Listener::start(
        cli.clone(),
        dir.path().join("board-listen.json"),
        Box::new(move |e| {
            if e.labels.contains_key("coc.do") || e.labels.get("coc.kind").is_some_and(|k| k == "pair") {
                println!("MAC heard {} by {} {:?}: {}", e.id, e.principal, e.profile, e.text.chars().take(90).collect::<String>());
            }
            hears.handle(e);
        }),
    );
    listener.configure(Some(Following { target, owner: owner.clone() }));
    // the tail starts at the newest event: give it a moment before anything it must hear
    std::thread::sleep(Duration::from_secs(8));

    sim.publish();
    let code = remote.pair_start(482_913).unwrap();
    println!("MAC pairing code {code} (owner {owner}, host {host})");

    let started = Instant::now();
    let mut confirmed = false;
    while started.elapsed() < Duration::from_secs(secs) && sim.step.load(Ordering::SeqCst) < 4 {
        remote.tick();
        let s = remote.status();
        if s.pairing.state == "asking" && !confirmed {
            println!("MAC {} wants to pair, check number {}: confirming", s.pairing.name.clone().unwrap_or_default(), s.pairing.check.clone().unwrap_or_default());
            remote.pair_confirm().unwrap();
            confirmed = true;
        }
        if s.pairing.state == "cancelled" {
            println!("MAC pairing ended: {:?}", s.pairing.why);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    // let the last results reach the board
    std::thread::sleep(Duration::from_secs(8));
    println!("MAC finished at step {} with {} phone(s); last error {:?}", sim.step.load(Ordering::SeqCst), remote.status().phones.len(), publisher.status().0);
    publisher.closed(&sim.id, None);
    std::thread::sleep(Duration::from_secs(6));
    listener.stop();
}
