use super::*;
use crate::board::borrow::{request_bytes, Lend, Request};
use crate::board::cli::MsgWrite;
use crate::board::listen::Event;
use crate::board::mac_key::{MacKey, MemoryKey};
use crate::board::phones::{MemoryStore, SecretStore, Secrets};
use crate::board::remote::{key_id, Mate, Phone};
use crate::board::remote_app::{Outbox, Remote, Sessions, Village};
use crate::model::Level;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

const NOW: i64 = 1_800_000_000_000;

#[derive(Default)]
struct Board {
    sent: Mutex<Vec<MsgWrite>>,
}

impl Outbox for Board {
    fn send(&self, w: MsgWrite, done: Option<crate::board::publisher::Sent>) {
        let n = {
            let mut s = self.sent.lock().unwrap();
            s.push(w);
            s.len()
        };
        if let Some(f) = done {
            f(Some(format!("msg_sent_{n}")));
        }
    }
    fn open_block(&self, _: &str) -> Option<(String, i64)> {
        None
    }
    fn session_for_root(&self, _: &str) -> Option<String> {
        None
    }
}

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

/// The lender's Mac, as the desk uses it: one builder `b1` (profile `wizard`) and one workspace `w1` (slug `shop`).
#[derive(Default)]
struct FakeYard {
    busy: Mutex<bool>,
    elixir: Mutex<Option<u32>>,
    fail_start: Mutex<Option<String>>,
    fail_push: Mutex<Option<String>>,
    safe: Mutex<bool>,
    log: Mutex<Vec<String>>,
}

impl FakeYard {
    fn log(&self) -> Vec<String> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }
}

impl Yard for FakeYard {
    fn builder(&self, profile: &str) -> Option<YardBuilder> {
        (profile == "wizard").then(|| YardBuilder { id: "b1".into(), name: "Wizard".into(), busy: *self.busy.lock().unwrap(), elixir: *self.elixir.lock().unwrap() })
    }
    fn workspace(&self, slug: &str) -> Option<YardWorkspace> {
        (slug == "shop").then(|| YardWorkspace { id: "w1".into(), name: "shop".into(), lendable: true })
    }
    fn start(&self, builder: &str, workspace: &str, task: &str, branch: &str) -> Result<Started, String> {
        if let Some(e) = self.fail_start.lock().unwrap().clone() {
            return Err(e);
        }
        self.log.lock().unwrap().push(format!("start {builder} {workspace} {branch}: {task}"));
        *self.busy.lock().unwrap() = true;
        Ok(Started { session: "s1".into(), worktree: "/wt/x".into(), repo: "/repo".into() })
    }
    fn push(&self, b: &Borrowed, first: bool) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("push {} first={first}", b.branch));
        match self.fail_push.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
    fn remove_if_safe(&self, b: &Borrowed) -> bool {
        let safe = *self.safe.lock().unwrap();
        self.log.lock().unwrap().push(format!("remove {} safe={safe}", b.branch));
        safe
    }
    fn notify(&self, title: &str, body: &str) {
        self.log.lock().unwrap().push(format!("notify {title} | {body}"));
    }
}

struct Rig {
    desk: Desk,
    board: Arc<Board>,
    yard: Arc<FakeYard>,
    remote: Arc<Remote>,
    key: MemoryKey,
    clock: Arc<AtomicI64>,
    dir: tempfile::TempDir,
}

fn rig(ask: bool) -> Rig {
    let key = MemoryKey::new();
    let public = key.public().unwrap();
    let store = Arc::new(MemoryStore::default());
    let phone = Phone { key: key_id(&public), public, name: "bob’s Mac".into(), paired_at: 1, last_used: 0, record: None, level: Some(Level::Helper), who: Some(Mate { email: "bob@acme.com".into(), handle: "bob".into(), user_id: "u_bob".into() }) };
    store.save(&Secrets { phones: vec![phone], lends: vec![Lend { builder: "b1".into(), keys: None, workspaces: None, floor: 10, ask }], ..Default::default() }).unwrap();
    let board = Arc::new(Board::default());
    let clock = Arc::new(AtomicI64::new(NOW));
    let c = clock.clone();
    let now: crate::board::remote_app::Clock = Arc::new(move || c.load(Ordering::SeqCst));
    let dir = tempfile::tempdir().unwrap();
    let remote = Arc::new(Remote::new(board.clone(), Arc::new(NoSessions), store, dir.path().join("r.json"), now.clone(), Arc::new(|| {})));
    remote.configure(Some(Village { host: "h1".into(), owner: "ada".into(), version: "t".into() }), None);
    board.sent.lock().unwrap().clear();
    let yard = Arc::new(FakeYard::default());
    *yard.safe.lock().unwrap() = true;
    let desk = Desk::new(remote.clone(), board.clone(), yard.clone(), dir.path().join("board-borrowed.json"), now, Arc::new(|| {}));
    Rig { desk, board, yard, remote, key, clock, dir }
}

impl Rig {
    fn request(&self, task: &str, nonce: &str) -> Request {
        let mut r = Request { v: 1, builder: "wizard".into(), workspace: "shop".into(), task: task.into(), at: self.clock.load(Ordering::SeqCst) - 1_000, nonce: nonce.into(), key: key_id(&self.key.public().unwrap()), sig: String::new() };
        r.sig = self.key.sign(&request_bytes("h1", &r)).unwrap();
        r
    }
    fn hear(&self, id: &str, channel: &str, r: &Request) {
        self.desk.on_event(&event(id, channel, &serde_json::to_string(r).unwrap()));
    }
    fn sent(&self) -> Vec<MsgWrite> {
        std::mem::take(&mut *self.board.sent.lock().unwrap())
    }
    /// The results written so far, as (message it is on, result, why).
    fn results(&self) -> Vec<(String, String, Option<String>)> {
        self.sent()
            .iter()
            .filter_map(|w| match w {
                MsgWrite::ReplyTo { id, text, .. } | MsgWrite::Edit { id, text } => serde_json::from_str::<serde_json::Value>(text).ok().filter(|v| v["result"].is_string()).map(|v| (id.clone(), v["result"].as_str().unwrap().to_string(), v["why"].as_str().map(str::to_string))),
                _ => None,
            })
            .collect()
    }
}

fn event(id: &str, channel: &str, text: &str) -> Event {
    Event { cursor: "c".into(), kind: "message.posted".into(), id: id.into(), thread_root: Some(id.into()), channel: channel.into(), text: text.into(), labels: BTreeMap::from([("coc.kind".to_string(), "borrow".to_string())]), principal: "vercel:user:u_bob".into(), profile: Some("village".into()), person: true, handle: "bob/village".into() }
}

#[test]
fn a_good_request_starts_and_notifies() {
    let g = rig(false);
    g.hear("msg_q1", "v/ada/w/shop", &g.request("Add a CSV export\nwith headers", "ab12cd3400000000"));
    assert_eq!(g.yard.log(), ["start b1 w1 borrow/bob/add-a-csv-export-with-headers-ab12: Add a CSV export\nwith headers", "notify bob borrowed Wizard in shop | Add a CSV export"]);
    assert_eq!(g.results(), [("msg_q1".to_string(), "started".to_string(), None)]);
    let b = g.desk.borrowed();
    assert_eq!(b.len(), 1);
    assert_eq!((b[0].session.as_str(), b[0].handle.as_str(), b[0].branch.as_str(), b[0].pushed), ("s1", "bob", "borrow/bob/add-a-csv-export-with-headers-ab12", false));
    assert_eq!(g.desk.by("s1").as_deref(), Some(b[0].key.as_str()));
    assert_eq!(g.desk.by("s9"), None);
}

#[test]
fn a_request_heard_twice_starts_once() {
    let g = rig(false);
    let r = g.request("x", "ab12cd3400000000");
    g.hear("msg_q1", "v/ada/w/shop", &r);
    g.yard.log();
    g.sent();
    *g.yard.busy.lock().unwrap() = false;
    // the tail restarted and delivered it again; someone reposted it as a new message
    g.hear("msg_q1", "v/ada/w/shop", &r);
    g.hear("msg_q2", "v/ada/w/shop", &r);
    assert!(g.yard.log().iter().all(|l| !l.starts_with("start")));
    assert_eq!(g.results(), [("msg_q2".to_string(), "refused".to_string(), Some("already taken".to_string()))]);
}

#[test]
fn a_refused_request_says_why_without_starting() {
    let g = rig(false);
    g.hear("msg_q1", "v/ada/w/api", &g.request("x", "ab12cd3400000000"));
    assert!(g.yard.log().is_empty());
    assert_eq!(g.results(), [("msg_q1".to_string(), "refused".to_string(), Some("posted in another workspace's channel".to_string()))]);
    // noise labelled as a request gets no answer
    g.desk.on_event(&event("msg_q2", "v/ada/w/shop", "borrow wizard please"));
    let mut reply = event("msg_q3", "v/ada/w/shop", &serde_json::to_string(&g.request("x", "ffffcd3400000000")).unwrap());
    reply.thread_root = Some("msg_other".into());
    g.desk.on_event(&reply);
    assert!(g.sent().is_empty() && g.yard.log().is_empty());
}

#[test]
fn busy_low_and_a_failed_start_are_said() {
    let g = rig(false);
    *g.yard.busy.lock().unwrap() = true;
    g.hear("msg_q1", "v/ada/w/shop", &g.request("x", "0001cd3400000000"));
    *g.yard.busy.lock().unwrap() = false;
    *g.yard.elixir.lock().unwrap() = Some(4);
    g.hear("msg_q2", "v/ada/w/shop", &g.request("x", "0002cd3400000000"));
    *g.yard.elixir.lock().unwrap() = None;
    *g.yard.fail_start.lock().unwrap() = Some("origin could not be reached".into());
    g.hear("msg_q3", "v/ada/w/shop", &g.request("x", "0003cd3400000000"));
    assert_eq!(g.results(), [("msg_q1".to_string(), "busy".to_string(), None), ("msg_q2".to_string(), "low".to_string(), None), ("msg_q3".to_string(), "failed".to_string(), Some("origin could not be reached".to_string()))]);
    assert!(g.desk.borrowed().is_empty());
    // busy and low can be asked again with a new request; they were not "taken"
    g.hear("msg_q4", "v/ada/w/shop", &g.request("x", "0001cd3400000000"));
    assert_eq!(g.results()[0].1, "failed", "the same nonce as the busy one is still good");
}

#[test]
fn ask_first_waits_then_accept_starts() {
    let g = rig(true);
    g.hear("msg_q1", "v/ada/w/shop", &g.request("Add a CSV export", "ab12cd3400000000"));
    assert_eq!(g.yard.log(), ["notify bob asks to borrow Wizard in shop | Add a CSV export"]);
    assert_eq!(g.results(), [("msg_q1".to_string(), "waiting".to_string(), None)]);
    let asked = g.desk.requests();
    assert_eq!(asked.iter().map(|r| (r.id.as_str(), r.who.as_str(), r.builder.as_str(), r.workspace.as_str(), r.task.as_str())).collect::<Vec<_>>(), [("msg_q1", "bob", "Wizard", "shop", "Add a CSV export")]);
    g.desk.accept("msg_q1").unwrap();
    assert!(g.yard.log()[0].starts_with("start b1 w1 borrow/bob/add-a-csv-export-ab12"));
    // the one result message is edited, not answered again
    let sent = g.sent();
    assert!(matches!(sent.as_slice(), [MsgWrite::Edit { id, text }] if id == "msg_sent_1" && text.contains(r#""result":"started""#)), "{sent:?}");
    assert!(g.desk.requests().is_empty());
    assert!(g.desk.accept("msg_q1").is_err(), "answered once");
}

#[test]
fn decline_expiry_and_accept_after_the_builder_got_busy() {
    let g = rig(true);
    g.hear("msg_q1", "v/ada/w/shop", &g.request("a", "0001cd3400000000"));
    g.hear("msg_q2", "v/ada/w/shop", &g.request("b", "0002cd3400000000"));
    g.hear("msg_q3", "v/ada/w/shop", &g.request("c", "0003cd3400000000"));
    g.sent();
    g.desk.decline("msg_q1").unwrap();
    *g.yard.busy.lock().unwrap() = true;
    g.desk.accept("msg_q2").unwrap();
    g.clock.fetch_add(30 * 60_000, Ordering::SeqCst);
    g.desk.tick();
    let edits: Vec<String> = g.sent().iter().filter_map(|w| if let MsgWrite::Edit { text, .. } = w { Some(serde_json::from_str::<serde_json::Value>(text).unwrap()["result"].as_str().unwrap().to_string()) } else { None }).collect();
    assert_eq!(edits, ["declined", "busy", "expired"]);
    assert!(g.desk.requests().is_empty());
    assert!(g.yard.log().iter().all(|l| !l.starts_with("start")));
}

#[test]
fn finishing_pushes_the_recorded_branch_and_says_so() {
    let g = rig(false);
    g.hear("msg_q1", "v/ada/w/shop", &g.request("x", "ab12cd3400000000"));
    g.yard.log();
    g.sent();
    g.desk.on_finished("s1", Some("msg_root"));
    assert_eq!(g.yard.log(), ["push borrow/bob/x-ab12 first=true"]);
    let sent = g.sent();
    assert!(matches!(sent.as_slice(), [MsgWrite::ReplyTo { id, text, .. }] if id == "msg_root" && text == "Pushed to origin as `borrow/bob/x-ab12`."), "{sent:?}");
    assert!(g.desk.borrowed()[0].pushed);
    // it worked on after a follow-up and finished again: a later push, not a first one
    g.desk.on_finished("s1", Some("msg_root"));
    assert_eq!(g.yard.log(), ["push borrow/bob/x-ab12 first=false"]);
    // a session that is nobody's borrow is not pushed
    g.desk.on_finished("s9", Some("msg_root"));
    assert!(g.yard.log().is_empty());
}

#[test]
fn a_failed_push_is_said_and_tried_again() {
    let g = rig(false);
    g.hear("msg_q1", "v/ada/w/shop", &g.request("x", "ab12cd3400000000"));
    g.yard.log();
    g.sent();
    *g.yard.fail_push.lock().unwrap() = Some("a branch named borrow/bob/x-ab12 is already on origin".into());
    g.desk.on_finished("s1", Some("msg_root"));
    let sent = g.sent();
    assert!(matches!(sent.as_slice(), [MsgWrite::ReplyTo { text, .. }] if text.starts_with("Not pushed: a branch named")), "{sent:?}");
    let b = &g.desk.borrowed()[0];
    assert_eq!((b.pushed, b.push_error.is_some()), (false, true));
    *g.yard.fail_push.lock().unwrap() = None;
    g.desk.retry_push("s1", Some("msg_root"));
    assert_eq!(g.yard.log(), ["push borrow/bob/x-ab12 first=true", "push borrow/bob/x-ab12 first=true"], "still a first push: nothing of ours is there yet");
    assert!(g.desk.borrowed()[0].pushed);
}

#[test]
fn closing_removes_the_worktree_only_when_that_loses_nothing_and_survives_a_restart() {
    let g = rig(false);
    g.hear("msg_q1", "v/ada/w/shop", &g.request("x", "ab12cd3400000000"));
    g.yard.log();
    // the app restarts: who the session works for is still known
    let again = Desk::new(g.remote.clone(), g.board.clone(), g.yard.clone(), g.dir.path().join("board-borrowed.json"), Arc::new(|| NOW), Arc::new(|| {}));
    assert_eq!(again.by("s1"), g.desk.by("s1"));
    *g.yard.safe.lock().unwrap() = false;
    assert_eq!(again.on_closed("s1").as_deref(), Some("/wt/x"), "kept, and the lender is told where");
    assert_eq!(g.yard.log(), ["remove borrow/bob/x-ab12 safe=false"]);
    assert!(again.borrowed().is_empty(), "the session is gone either way");
    assert_eq!(again.on_closed("s1"), None);
}
