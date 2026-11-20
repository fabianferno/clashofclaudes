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
        self.publisher.update(SessionView { info, builder: "Wizard".into(), agent: AgentKind::Claude, channel: Some(self.channel.clone()), answerable: step < 2, by: None });
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
    let code = remote.pair_start(now() as u64 ^ 0x5eed_c0de_1234_5678).unwrap();
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

/// A teammate acting in a village, on the real board, with one login playing both sides: the
/// owner's Mac (a `Remote` with the invite and the Keychain list in memory) and the visitor's
/// (a key in memory, posting through the same CLI). Pairs through `v/<owner>/pair`, allows a
/// prompt as Trusted, then is lowered to Helper and refused.
/// `COC_BOARD_VERCEL=/path/to/vercel cargo test --lib real_mate_run -- --ignored --nocapture`
#[test]
#[ignore]
fn real_mate_run() {
    use super::cli::{args_for_msg, BoardCli};
    use super::mac_key::{MacKey, MemoryKey};
    use super::pairing::MateFor;
    use super::remote::{key_id, Do};
    use super::visitor::{action, action_write, find_ticket, pair_request};
    use super::visits::{thread_args, visited_builder};
    use crate::model::Level;

    let program = std::env::var("COC_BOARD_VERCEL").expect("COC_BOARD_VERCEL");
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(VercelCli { program: Some(program.into()), cwd: dir.path().to_path_buf(), timeout: Duration::from_secs(60) });
    let target = Target { team: None, name: "coc-spike".into() };
    let st = status(cli.as_ref(), &target);
    assert_eq!(st.state, "ready", "{st:?}");
    let owner = st.handle.unwrap();
    let who = cli.run(&["board".to_string(), "whoami".to_string(), "--json".to_string(), "--name".to_string(), "coc-spike".to_string()]).unwrap();
    let user_id = who["principal"].as_str().unwrap().trim_start_matches("vercel:user:").to_string();
    let host = format!("materun{}", now() / 1000);
    let wait_for = |what: &str, f: &dyn Fn() -> bool| {
        let started = Instant::now();
        while !f() {
            assert!(started.elapsed() < Duration::from_secs(90), "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(500));
        }
        println!("OK {what} ({:.0?})", started.elapsed());
    };

    // the owner's Mac
    let publisher = Publisher::start(cli.clone(), dir.path().join("board.json"), Arc::new(|_| vec![]), Arc::new(now));
    publisher.configure(Config { enabled: true, target: target.clone(), owner: owner.clone(), host_id: host.clone(), share_details: true });
    let sim = Arc::new(Sim { publisher: publisher.clone(), channel: format!("v/{owner}/w/real-mate"), id: format!("mate-{}", now() / 1000), step: AtomicUsize::new(0), since: Mutex::new(0) });
    let remote = Arc::new(Remote::new(publisher.clone(), sim.clone(), Arc::new(MemoryStore::default()), dir.path().join("board-remote.json"), Arc::new(now), Arc::new(|| {})));
    remote.configure(Some(Village { host: host.clone(), owner: owner.clone(), version: "test".into() }), None);
    remote.set_phones_on(false); // the phone remote is off: this is about a teammate
    let hears = remote.clone();
    let listener = Listener::start(
        cli.clone(),
        dir.path().join("board-listen.json"),
        Box::new(move |e| {
            println!("MAC heard {} {} in {} by {} ({}) labels {:?}", e.kind, e.id, e.channel, e.principal, e.handle, e.labels.keys().collect::<Vec<_>>());
            hears.handle(e);
        }),
    );
    listener.configure(Some(Following { target: target.clone(), owner: owner.clone() }));
    std::thread::sleep(Duration::from_secs(8));

    // pairing: the owner opens it, the visitor answers with the code, the owner confirms
    let code = remote.pair_start_mate(now() as u64 ^ 0x0bad_cafe, MateFor { email: "mate@example.com".into(), user_id: user_id.clone(), level: Level::Trusted }).unwrap();
    println!("OWNER opened a pairing for a Trusted teammate");
    let visitor = MemoryKey::new();
    let my_key = key_id(&visitor.public().unwrap());
    let read_pair = || {
        let mut args = vec!["board".to_string(), "read".to_string(), format!("v/{owner}/pair")];
        args.extend(thread_args("", &target).into_iter().skip(3));
        cli.run(&args).ok()
    };
    let ticket = std::cell::RefCell::new(None);
    wait_for("the ticket to be on the board", &|| {
        *ticket.borrow_mut() = read_pair().and_then(|r| find_ticket(&r, &owner, &code, now()));
        ticket.borrow().is_some()
    });
    let ticket = ticket.into_inner().unwrap();
    let (request, check) = pair_request(&ticket, &code, &visitor, &owner).unwrap();
    cli.run(&args_for_msg(&request, &target)).unwrap();
    println!("VISITOR asked to be paired; shows {check}");
    wait_for("the owner's Mac to hear the request", &|| remote.status().pairing.state == "asking");
    assert_eq!(remote.status().pairing.check.as_deref(), Some(check.as_str()), "both sides show the same number");
    remote.pair_confirm().unwrap();
    assert_eq!(remote.mates().iter().map(|m| (m.key.clone(), m.level.clone())).collect::<Vec<_>>(), [(my_key.clone(), "trusted".to_string())]);
    println!("OWNER confirmed; the map names the key as trusted");

    // a builder waits on a decision; the visitor allows it
    sim.publish();
    wait_for("the session's wait to be on the board", &|| publisher.open_block(&sim.id).is_some());
    let root = publisher.root_of(&sim.id).unwrap();
    let panel = || visited_builder(&cli.run(&thread_args(&root, &target)).unwrap(), &owner, Some(&my_key)).unwrap();
    let shown = panel();
    println!("VISITOR sees: {:?} can {:?}", shown.question, shown.can);
    let allow = action(&visitor, Do::Allow, None, None, shown.prompt.as_deref().unwrap(), &format!("{:032x}", now())).unwrap();
    cli.run(&args_for_msg(&action_write(&root, &allow), &target)).unwrap();
    wait_for("the owner's Mac to apply the Allow", &|| sim.step.load(Ordering::SeqCst) == 1);
    wait_for("the visitor's panel to show the result", &|| panel().sent);
    println!("OWNER notes: {:?}", remote.acted().map(|a| format!("{} {}", a.who, a.what)));

    // lowered to Helper: the next Allow is refused, and nothing is applied
    remote.set_mate_level("mate@example.com", Level::Helper).unwrap();
    wait_for("the next wait to be on the board", &|| publisher.open_block(&sim.id).is_some_and(|(_, since)| since == *sim.since.lock().unwrap()) && panel().prompt != shown.prompt);
    let again = panel();
    let allow = action(&visitor, Do::Allow, None, None, again.prompt.as_deref().unwrap(), &format!("{:032x}", now() + 1)).unwrap();
    cli.run(&args_for_msg(&action_write(&root, &allow), &target)).unwrap();
    wait_for("the owner's Mac to refuse a Helper's Allow", &|| panel().result.as_deref() == Some("refused"));
    assert_eq!(sim.step.load(Ordering::SeqCst), 1, "nothing was applied");
    println!("DONE: paired, allowed as Trusted, refused as Helper");
    publisher.closed(&sim.id, None);
    std::thread::sleep(Duration::from_secs(6));
    listener.stop();
}

/// Borrowing a builder on the real board, with one login playing both sides and a throwaway
/// repository with a local bare `origin`: the visitor signs and posts a request; the lender's
/// listener hears it, the desk takes it and cuts a worktree from origin; a commit stands in for
/// the agent's work; finishing pushes the branch; closing removes the worktree and keeps the
/// branch. Then a replayed request and one posted in another workspace's channel start nothing.
/// `COC_BOARD_VERCEL=/path/to/vercel cargo test --lib real_borrow_run -- --ignored --nocapture`
#[test]
#[ignore]
fn real_borrow_run() {
    use super::borrow::Lend;
    use super::cli::{args_for_msg, message_id, BoardCli, MsgWrite};
    use super::desk::{Borrowed, Desk, Started, Yard, YardBuilder, YardWorkspace};
    use super::mac_key::{MacKey, MemoryKey};
    use super::phones::{SecretStore, Secrets};
    use super::remote::{key_id, Mate, Phone};
    use super::visitor::{borrow_request, borrow_result};
    use super::visits::thread_args;
    use crate::git::test_util::{git, repo_with_commit};
    use crate::model::Level;
    use std::path::{Path, PathBuf};

    let program = std::env::var("COC_BOARD_VERCEL").expect("COC_BOARD_VERCEL");
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(VercelCli { program: Some(program.into()), cwd: dir.path().to_path_buf(), timeout: Duration::from_secs(60) });
    let target = Target { team: None, name: "coc-spike".into() };
    let st = status(cli.as_ref(), &target);
    assert_eq!(st.state, "ready", "{st:?}");
    let owner = st.handle.unwrap();
    let host = format!("borrowrun{}", now() / 1000);
    let wait_for = |what: &str, f: &dyn Fn() -> bool| {
        let started = Instant::now();
        while !f() {
            assert!(started.elapsed() < Duration::from_secs(90), "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(500));
        }
        println!("OK {what} ({:.0?})", started.elapsed());
    };

    // the lender's repository, cloned from a bare origin
    let seed = dir.path().join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    repo_with_commit(&seed);
    git(&seed, &["branch", "-M", "main"]);
    let origin = dir.path().join("origin.git");
    git(dir.path(), &["clone", "-q", "--bare", &seed.to_string_lossy(), &origin.to_string_lossy()]);
    let repo = dir.path().join("repo");
    git(dir.path(), &["clone", "-q", &origin.to_string_lossy(), &repo.to_string_lossy()]);
    std::fs::write(repo.join("local.txt"), "the lender's own unpushed work\n").unwrap();
    git(&repo, &["add", "local.txt"]);
    git(&repo, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "local"]);

    // the visitor's key, paired with the lender as a Helper, and the builder lent to every paired Mac
    let visitor = MemoryKey::new();
    let public = visitor.public().unwrap();
    let store = Arc::new(MemoryStore::default());
    store
        .save(&Secrets {
            phones: vec![Phone { key: key_id(&public), public, name: "visitor".into(), paired_at: 1, last_used: 0, record: None, level: Some(Level::Helper), who: Some(Mate { email: "mate@example.com".into(), handle: "mate".into(), user_id: "u".into() }) }],
            lends: vec![Lend { builder: "b1".into(), keys: None, workspaces: None, floor: 0, ask: false }],
            ..Default::default()
        })
        .unwrap();

    /// The lender's Mac with real git; "starting the session" stands in for an agent.
    struct GitYard {
        repo: PathBuf,
        worktrees: PathBuf,
        started: Mutex<Vec<String>>,
    }
    impl Yard for GitYard {
        fn builder(&self, profile: &str) -> Option<YardBuilder> {
            (profile == "wizard").then(|| YardBuilder { id: "b1".into(), name: "Wizard".into(), busy: !self.started.lock().unwrap().is_empty(), elixir: None })
        }
        fn workspace(&self, slug: &str) -> Option<YardWorkspace> {
            (slug == "real-borrow").then(|| YardWorkspace { id: "w1".into(), name: "real-borrow".into(), lendable: crate::git::lendable(&self.repo) })
        }
        fn start(&self, _: &str, _: &str, task: &str, branch: &str) -> Result<Started, String> {
            crate::git::fetch_origin(&self.repo).map_err(|e| e.to_string())?;
            let base = crate::git::default_branch(&self.repo).ok_or("no default branch")?;
            let at = self.worktrees.join(branch.replace('/', "-"));
            crate::git::add_worktree_from(&self.repo, &at, branch, &format!("origin/{base}")).map_err(|e| e.to_string())?;
            self.started.lock().unwrap().push(task.to_string());
            Ok(Started { session: "s-borrowed".into(), worktree: at, repo: self.repo.clone() })
        }
        fn push(&self, b: &Borrowed, first: bool) -> Result<(), String> {
            crate::git::push_branch(&b.worktree, &b.branch, first).map_err(|e| e.to_string())
        }
        fn remove_if_safe(&self, b: &Borrowed) -> bool {
            crate::git::safe_to_remove(&b.worktree, &b.branch) && crate::git::remove_worktree_keep_branch(&b.repo, &crate::model::WorktreeInfo { path: b.worktree.clone(), branch: Some(b.branch.clone()) }).is_ok()
        }
        fn notify(&self, title: &str, body: &str) {
            println!("NOTIFY {title} | {body}");
        }
    }
    let yard = Arc::new(GitYard { repo: repo.clone(), worktrees: dir.path().join("worktrees"), started: Mutex::default() });

    // the lender's Mac: publisher, remote (for the record), desk, listener
    let publisher = Publisher::start(cli.clone(), dir.path().join("board.json"), Arc::new(|_| vec![]), Arc::new(now));
    publisher.configure(Config { enabled: true, target: target.clone(), owner: owner.clone(), host_id: host.clone(), share_details: true });
    struct NoSessions;
    impl Sessions for NoSessions {
        fn since(&self, _: &str) -> Option<i64> {
            None
        }
        fn approve_if(&self, _: &str, _: i64) -> Result<(), String> {
            Ok(())
        }
        fn deny_if(&self, _: &str, _: i64) -> Result<(), String> {
            Ok(())
        }
        fn prompt_if(&self, _: &str, _: i64, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn pick_if(&self, _: &str, _: i64, _: Option<usize>, _: &str) -> Result<(), String> {
            Ok(())
        }
    }
    let remote = Arc::new(Remote::new(publisher.clone(), Arc::new(NoSessions), store, dir.path().join("r.json"), Arc::new(now), Arc::new(|| {})));
    remote.configure(Some(Village { host: host.clone(), owner: owner.clone(), version: "test".into() }), None);
    let desk = Arc::new(Desk::new(remote.clone(), publisher.clone(), yard.clone(), dir.path().join("borrowed.json"), Arc::new(now), Arc::new(|| {})));
    let asks = desk.clone();
    let listener = Listener::start(cli.clone(), dir.path().join("listen.json"), Box::new(move |e| asks.on_event(&e)));
    listener.configure(Some(Following { target: target.clone(), owner: owner.clone() }));
    std::thread::sleep(Duration::from_secs(8));

    // the visitor asks
    let post = |w: &MsgWrite| message_id(&cli.run(&args_for_msg(w, &target)).unwrap()).unwrap();
    let result_of = |id: &str| borrow_result(&cli.run(&thread_args(id, &target)).unwrap(), &owner, id);
    let (request, write) = borrow_request(&visitor, &owner, &host, "wizard", "real-borrow", "Add an export module", now(), &format!("{:032x}", now())).unwrap();
    let asked = post(&write);
    println!("VISITOR asked {asked}");
    wait_for("the desk to start the borrowed work", &|| !desk.borrowed().is_empty());
    let b = desk.borrowed().remove(0);
    println!("LENDER started on {} in {}", b.branch, b.worktree.display());
    assert!(b.worktree.join("a.txt").is_file());
    assert!(!b.worktree.join("local.txt").exists(), "the lender's unpushed commit is not in the borrower's worktree");
    wait_for("the visitor to read `started`", &|| result_of(&asked).is_some_and(|(r, _)| r == "started"));

    // the agent's work, then Finished: the branch is pushed, and only it
    std::fs::write(b.worktree.join("export.rs"), "pub fn export() {}\n").unwrap();
    git(&b.worktree, &["add", "export.rs"]);
    git(&b.worktree, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "export"]);
    desk.on_finished(&b.session, Some(&asked));
    let heads = std::process::Command::new("git").arg("-C").arg(&origin).args(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).output().unwrap();
    let heads = String::from_utf8_lossy(&heads.stdout).to_string();
    println!("ORIGIN has: {}", heads.split_whitespace().collect::<Vec<_>>().join(", "));
    assert!(heads.contains(&b.branch) && !heads.contains("local"), "{heads}");
    assert!(desk.borrowed()[0].pushed);

    // a replayed request, and a fresh one posted in another workspace's channel: nothing starts
    yard.started.lock().unwrap().clear();
    let replay = post(&MsgWrite::Post { channel: format!("v/{owner}/w/real-borrow"), text: serde_json::to_string(&request).unwrap(), labels: vec![("coc.kind".into(), "borrow".into())], key: format!("replay-{}", now()) });
    let (_, elsewhere) = borrow_request(&visitor, &owner, &host, "wizard", "real-borrow", "Something else", now(), &format!("{:032x}", now() + 7)).unwrap();
    let MsgWrite::Post { text, labels, key, .. } = elsewhere else { unreachable!() };
    let moved = post(&MsgWrite::Post { channel: format!("v/{owner}/w/other-place"), text, labels, key });
    wait_for("the replay to be refused", &|| result_of(&replay).is_some_and(|(r, w)| r == "refused" && w.as_deref() == Some("already taken")));
    wait_for("the moved request to be refused", &|| result_of(&moved).is_some_and(|(r, w)| r == "refused" && w.as_deref() == Some("posted in another workspace's channel")));
    assert!(yard.started.lock().unwrap().is_empty(), "nothing started");

    // Done: the worktree goes (clean, pushed), the branch stays
    assert_eq!(desk.on_closed(&b.session), None);
    assert!(!b.worktree.exists());
    assert!(Path::new(&origin).exists());
    println!("DONE: borrowed, pushed only its branch, refused a replay and a moved request, closed cleanly");
    std::thread::sleep(Duration::from_secs(4));
    listener.stop();
}
