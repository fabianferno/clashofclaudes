use super::*;
use crate::board::cli::MsgWrite;
use crate::board::listen::Event;
use crate::board::phones::{MemoryStore, SecretStore, Secrets};
use crate::board::remote::{b64, key_id, sha_hex, signed_bytes, Action, Do, Phone};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

const DECIDE: &str = r#"{"v":1,"host":"h1","session":"s1","since":42,"wait":"decide","can":["allow","deny"],"question":"Bash: npm test","options":null}"#;
const PICKER: &str = r#"{"v":1,"host":"h1","session":"s1","since":42,"wait":"answer","can":["answer"],"question":"Which?","options":["a","b"]}"#;
const REVIEW: &str = r#"{"v":1,"host":"h1","session":"s1","since":42,"wait":"review","can":["followup"],"question":null,"options":null}"#;

/// The board, as the remote uses it: one session `s1` whose thread starts at `msg_1`.
struct FakeBoard {
    block: Mutex<Option<(String, i64)>>,
    sent: Mutex<Vec<MsgWrite>>,
}

impl Outbox for FakeBoard {
    fn send(&self, w: MsgWrite, done: Option<Sent>) {
        let n = {
            let mut s = self.sent.lock().unwrap();
            s.push(w);
            s.len()
        };
        if let Some(f) = done {
            f(Some(format!("msg_sent_{n}")));
        }
    }
    fn open_block(&self, id: &str) -> Option<(String, i64)> {
        (id == "s1").then(|| self.block.lock().unwrap().clone()).flatten()
    }
    fn session_for_root(&self, root: &str) -> Option<String> {
        (root == "msg_1").then(|| "s1".to_string())
    }
}

#[derive(Default)]
struct FakeSessions {
    since: AtomicI64,
    calls: Mutex<Vec<String>>,
    fail: Mutex<Option<String>>,
}

impl FakeSessions {
    fn call(&self, what: String) -> Result<(), String> {
        self.calls.lock().unwrap().push(what);
        match self.fail.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

impl Sessions for FakeSessions {
    fn since(&self, id: &str) -> Option<i64> {
        (id == "s1").then(|| self.since.load(Ordering::SeqCst))
    }
    fn approve_if(&self, id: &str, since: i64) -> Result<(), String> {
        self.call(format!("approve {id} {since}"))
    }
    fn deny_if(&self, id: &str, since: i64) -> Result<(), String> {
        self.call(format!("deny {id} {since}"))
    }
    fn prompt_if(&self, id: &str, since: i64, text: &str) -> Result<(), String> {
        self.call(format!("prompt {id} {since} {text}"))
    }
    fn pick_if(&self, id: &str, since: i64, pick: Option<usize>, text: &str) -> Result<(), String> {
        self.call(format!("pick {id} {since} {pick:?} {text}"))
    }
}

struct Rig {
    r: Remote,
    board: Arc<FakeBoard>,
    sessions: Arc<FakeSessions>,
    store: Arc<MemoryStore>,
    clock: Arc<AtomicI64>,
    sign: Box<dyn Fn(&mut Action)>,
    _dir: tempfile::TempDir,
}

fn rig(block: &str) -> Rig {
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap();
    let public = pair.public_key().as_ref().to_vec();
    let key = key_id(&public);
    let store = Arc::new(MemoryStore::default());
    store.save(&Secrets { phones: vec![Phone { key: key.clone(), public, name: "iPhone".into(), paired_at: 1, last_used: 0, record: Some("msg_rec".into()), level: None, who: None }], setup_secret: None }).unwrap();
    let sign = Box::new(move |a: &mut Action| {
        a.key = key.clone();
        loop {
            a.sig = b64(pair.sign(&rng, &signed_bytes(a)).unwrap().as_ref());
            if crate::board::remote::low_s(&crate::board::remote::unb64(&a.sig).unwrap()) {
                break;
            }
        }
    });
    let board = Arc::new(FakeBoard { block: Mutex::new(Some((block.to_string(), 42))), sent: Mutex::default() });
    let sessions = Arc::new(FakeSessions::default());
    sessions.since.store(42, Ordering::SeqCst);
    let clock = Arc::new(AtomicI64::new(5_000));
    let c = clock.clone();
    let dir = tempfile::tempdir().unwrap();
    let r = Remote::new(board.clone(), sessions.clone(), store.clone(), dir.path().join("board-remote.json"), Arc::new(move || c.load(Ordering::SeqCst)), Arc::new(|| {}));
    r.configure(Some(Village { host: "h1".into(), owner: "ada".into(), version: "0.9.0".into() }), None);
    board.sent.lock().unwrap().clear();
    Rig { r, board, sessions, store, clock, sign, _dir: dir }
}

impl Rig {
    fn action(&self, r#do: Do, block: &str, nonce: &str) -> Action {
        let mut a = Action { v: 1, r#do, pick: None, text: None, nonce: nonce.into(), key: String::new(), prompt: sha_hex(block.as_bytes()), sig: String::new() };
        (self.sign)(&mut a);
        a
    }
    fn hear(&self, id: &str, root: &str, a: &Action) {
        self.r.handle(event(id, root, &serde_json::to_string(a).unwrap()));
    }
    fn sent(&self) -> Vec<MsgWrite> {
        std::mem::take(&mut *self.board.sent.lock().unwrap())
    }
    fn calls(&self) -> Vec<String> {
        self.sessions.calls.lock().unwrap().clone()
    }
    /// The result the Mac wrote for action `id`.
    fn result(&self, id: &str) -> String {
        let sent = self.sent();
        let [MsgWrite::ReplyTo { id: to, text, labels, key }] = sent.as_slice() else { panic!("{sent:?}") };
        assert_eq!((to.as_str(), key.as_str()), (id, format!("coc-res-{id}").as_str()));
        assert_eq!(labels, &[("coc.kind".to_string(), "result".to_string())]);
        let v: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(v["re"], id);
        v["result"].as_str().unwrap().to_string()
    }
}

fn event(id: &str, root: &str, text: &str) -> Event {
    Event {
        cursor: "c".into(),
        kind: "message.posted".into(),
        id: id.into(),
        thread_root: Some(root.into()),
        channel: "v/ada/w/api".into(),
        text: text.into(),
        labels: BTreeMap::from([("coc.do".to_string(), "x".to_string())]),
        principal: "vercel:project:prj_K:production".into(),
        profile: Some("remote".into()),
        person: false,
        handle: "remote".into(),
    }
}

#[test]
fn an_allow_from_a_paired_phone_is_applied_and_answered() {
    let g = rig(DECIDE);
    g.hear("msg_a1", "msg_1", &g.action(Do::Allow, DECIDE, "n1"));
    assert_eq!(g.calls(), ["approve s1 42"]);
    assert_eq!(g.result("msg_a1"), "applied");
    assert_eq!(g.store.load().unwrap().phones[0].last_used, 5_000, "last used is saved");
    let deny = rig(DECIDE);
    deny.hear("msg_a1", "msg_1", &deny.action(Do::Deny, DECIDE, "n1"));
    assert_eq!(deny.calls(), ["deny s1 42"]);
}

#[test]
fn the_same_action_twice_is_stale_the_second_time() {
    let g = rig(DECIDE);
    let a = g.action(Do::Allow, DECIDE, "n1");
    g.hear("msg_a1", "msg_1", &a);
    g.sent();
    // reposted by someone else as a new message, the prompt still looking open
    g.hear("msg_a2", "msg_1", &a);
    assert_eq!(g.calls().len(), 1);
    assert_eq!(g.result("msg_a2"), "stale");
    // and still after a restart
    let again = Remote::new(g.board.clone(), g.sessions.clone(), g.store.clone(), g._dir.path().join("board-remote.json"), Arc::new(|| 0), Arc::new(|| {}));
    again.configure(Some(Village { host: "h1".into(), owner: "ada".into(), version: "0.9.0".into() }), None);
    g.sent();
    again.handle(event("msg_a3", "msg_1", &serde_json::to_string(&a).unwrap()));
    assert_eq!(g.calls().len(), 1);
}

#[test]
fn a_followup_types_the_text_and_a_pick_uses_pick_if() {
    let g = rig(REVIEW);
    let mut a = g.action(Do::Followup, REVIEW, "n1");
    a.text = Some("also add tests".into());
    (g.sign)(&mut a);
    g.hear("msg_a1", "msg_1", &a);
    assert_eq!(g.calls(), ["prompt s1 42 also add tests"]);
    assert_eq!(g.result("msg_a1"), "applied");

    let p = rig(PICKER);
    let mut a = p.action(Do::Answer, PICKER, "n1");
    a.pick = Some(1);
    (p.sign)(&mut a);
    p.hear("msg_a1", "msg_1", &a);
    assert_eq!(p.calls(), ["pick s1 42 Some(1) "]);

    // asking with no picker: the words are typed as a prompt
    const ASK: &str = r#"{"v":1,"host":"h1","session":"s1","since":42,"wait":"answer","can":["answer"],"question":null,"options":null}"#;
    let q = rig(ASK);
    let mut a = q.action(Do::Answer, ASK, "n1");
    a.text = Some("yes".into());
    (q.sign)(&mut a);
    q.hear("msg_a1", "msg_1", &a);
    assert_eq!(q.calls(), ["prompt s1 42 yes"]);
}

#[test]
fn an_unknown_phone_is_refused_and_noted() {
    let g = rig(DECIDE);
    let a = g.action(Do::Allow, DECIDE, "n1");
    g.store.save(&Secrets::default()).unwrap();
    g.r.reload();
    g.hear("msg_a1", "msg_1", &a);
    assert!(g.calls().is_empty());
    assert_eq!(g.result("msg_a1"), "refused");
    assert_eq!(g.r.status().last_refused_at, Some(5_000));
    // not an action at all: someone's noise gets no reply and raises no alarm
    let before = g.r.status().last_refused_at;
    g.r.handle(event("msg_a2", "msg_1", "allow please"));
    assert!(g.sent().is_empty());
    assert_eq!(g.r.status().last_refused_at, before);
}

#[test]
fn a_paused_remote_refuses_everything() {
    let g = rig(DECIDE);
    g.r.configure(Some(Village { host: "h1".into(), owner: "ada".into(), version: "0.9.0".into() }), Some("redeployed".into()));
    g.sent();
    g.hear("msg_a1", "msg_1", &g.action(Do::Allow, DECIDE, "n1"));
    assert!(g.calls().is_empty());
    assert_eq!(g.result("msg_a1"), "refused");
}

#[test]
fn a_session_error_is_failed_and_a_stale_one_is_stale() {
    let g = rig(DECIDE);
    *g.sessions.fail.lock().unwrap() = Some("session is not running".into());
    g.hear("msg_a1", "msg_1", &g.action(Do::Allow, DECIDE, "n1"));
    assert_eq!(g.result("msg_a1"), "failed");
    *g.sessions.fail.lock().unwrap() = Some("stale: that wait is over".into());
    g.hear("msg_a2", "msg_1", &g.action(Do::Allow, DECIDE, "n2"));
    assert_eq!(g.result("msg_a2"), "stale");
    // the session moved on since the block was written
    *g.sessions.fail.lock().unwrap() = None;
    g.sessions.since.store(43, Ordering::SeqCst);
    g.hear("msg_a3", "msg_1", &g.action(Do::Allow, DECIDE, "n3"));
    assert_eq!(g.result("msg_a3"), "stale");
    assert_eq!(g.calls().len(), 2, "not tried");
}

#[test]
fn what_is_not_ours_is_left_alone() {
    let g = rig(DECIDE);
    let a = g.action(Do::Allow, DECIDE, "n1");
    g.hear("msg_x2", "msg_x1", &a);
    let mut unlabelled = event("msg_a1", "msg_1", &serde_json::to_string(&a).unwrap());
    unlabelled.labels.clear();
    g.r.handle(unlabelled);
    let mut edited = event("msg_a1", "msg_1", &serde_json::to_string(&a).unwrap());
    edited.kind = "labels.changed".into();
    g.r.handle(edited);
    // the root itself carrying coc.do
    g.r.handle(event("msg_1", "msg_1", &serde_json::to_string(&a).unwrap()));
    assert!(g.calls().is_empty());
    assert!(g.sent().is_empty(), "no reply at all");
    // off: nothing is taken
    g.r.configure(None, None);
    g.hear("msg_a1", "msg_1", &a);
    assert!(g.calls().is_empty() && g.sent().is_empty());
}

#[test]
fn seen_hashes_are_capped_at_500() {
    let g = rig(DECIDE);
    for n in 0..505 {
        g.hear(&format!("msg_a{n}"), "msg_1", &g.action(Do::Allow, DECIDE, &format!("n{n}")));
    }
    assert_eq!(g.r.seen_len(), 500);
}

fn pair_request(id: &str, ticket: &str) -> Event {
    const PUB: &str = "BJFoira10seT_4mQCR9cHCW_d571sQbL3La0PctTmwr5P3GDEX_lc0QORs_pqRotn_e4cNgEMUb1Sdclf3Km8E8";
    let mac = crate::board::pairing::proof(&crate::board::pairing::code_of(123_456), &crate::board::remote::unb64(PUB).unwrap(), "Pixel");
    let mut e = event(id, ticket, &serde_json::json!({ "public": PUB, "name": "Pixel", "mac": mac }).to_string());
    e.labels = BTreeMap::from([("coc.kind".to_string(), "pair".to_string())]);
    e.channel = "v/ada/remote".into();
    e
}

#[test]
fn pairing_adds_a_phone_and_removing_takes_it_away() {
    let g = rig(DECIDE);
    let code = g.r.pair_start(123_456).unwrap();
    assert_eq!(code, crate::board::pairing::code_of(123_456));
    let sent = g.sent();
    assert!(matches!(sent.as_slice(), [MsgWrite::Post { channel, .. }] if channel == "v/ada/remote"), "{sent:?}");
    // the fake board named the ticket msg_sent_1
    g.r.handle(pair_request("msg_p1", "msg_sent_1"));
    let st = g.r.status();
    assert_eq!((st.pairing.state.as_str(), st.pairing.name.as_deref(), st.pairing.check.as_deref()), ("asking", Some("Pixel"), Some(crate::board::remote::check_number(&crate::board::remote::unb64("BJFoira10seT_4mQCR9cHCW_d571sQbL3La0PctTmwr5P3GDEX_lc0QORs_pqRotn_e4cNgEMUb1Sdclf3Km8E8").unwrap(), "msg_sent_1").as_str())));
    g.r.pair_confirm().unwrap();
    let phones = g.store.load().unwrap().phones;
    assert_eq!(phones.len(), 2);
    assert_eq!((phones[1].name.as_str(), phones[1].paired_at), ("Pixel", 5_000));
    assert!(phones[1].record.is_some(), "its record's id is kept once the board has it");
    assert_eq!(g.r.status().phones.len(), 2);
    g.sent();

    let key = phones[1].key.clone();
    g.r.remove_phone(&key).unwrap();
    assert_eq!(g.store.load().unwrap().phones.len(), 1);
    let sent = g.sent();
    let [MsgWrite::Edit { id, text }] = sent.as_slice() else { panic!("{sent:?}") };
    assert_eq!(id, phones[1].record.as_deref().unwrap());
    assert!(text.contains(r#""state":"removed""#), "{text}");
    assert!(g.r.remove_phone("nope").is_err());
}

#[test]
fn pairing_needs_the_village_and_expires() {
    let g = rig(DECIDE);
    g.r.pair_start(1).unwrap();
    g.clock.store(5_000 + 300_000, Ordering::SeqCst);
    g.r.tick();
    assert_eq!(g.r.status().pairing.state, "cancelled");
    assert!(g.r.pair_confirm().is_err());
    g.r.configure(None, None);
    assert!(g.r.pair_start(1).is_err());
}

#[test]
fn the_heartbeat_posts_the_village_root_then_edits_it_every_five_minutes() {
    let g = rig(DECIDE);
    g.r.tick();
    let sent = g.sent();
    let [MsgWrite::Post { channel, text, labels, key }] = sent.as_slice() else { panic!("{sent:?}") };
    assert_eq!((channel.as_str(), key.as_str()), ("v/ada/remote", "coc-village-h1"));
    assert_eq!(labels, &[("coc.kind".to_string(), "village".to_string()), ("coc.host".to_string(), "h1".to_string())]);
    assert!(text.contains(r#""seen":5000"#), "{text}");
    // a repeated post would not change the text, so the first beat is followed by an edit too
    g.clock.fetch_add(1_000, Ordering::SeqCst);
    g.r.tick();
    assert!(matches!(g.sent().as_slice(), [MsgWrite::Edit { id, .. }] if id == "msg_sent_1"));
    g.clock.fetch_add(299_000, Ordering::SeqCst);
    g.r.tick();
    assert!(g.sent().is_empty(), "not yet");
    g.clock.fetch_add(1_000, Ordering::SeqCst);
    g.r.tick();
    let sent = g.sent();
    assert!(matches!(sent.as_slice(), [MsgWrite::Edit { text, .. }] if text.contains(r#""seen":306000"#)), "{sent:?}");
}

#[test]
fn a_keychain_that_cannot_be_read_pairs_no_one_and_says_so() {
    struct Broken;
    impl SecretStore for Broken {
        fn load(&self) -> Result<Secrets, String> {
            Err("the Keychain is locked".into())
        }
        fn save(&self, _: &Secrets) -> Result<(), String> {
            Err("the Keychain is locked".into())
        }
    }
    let g = rig(DECIDE);
    let r = Remote::new(g.board.clone(), g.sessions.clone(), Arc::new(Broken), g._dir.path().join("x.json"), Arc::new(|| 0), Arc::new(|| {}));
    r.configure(Some(Village { host: "h1".into(), owner: "ada".into(), version: "0.9.0".into() }), None);
    let st = r.status();
    assert_eq!((st.phones.len(), st.keychain_error.as_deref()), (0, Some("the Keychain is locked")));
    g.sent();
    r.handle(event("msg_a1", "msg_1", &serde_json::to_string(&g.action(Do::Allow, DECIDE, "n1")).unwrap()));
    assert_eq!(g.result("msg_a1"), "refused");
}

#[test]
fn a_teammates_key_acts_by_its_level_even_with_the_phone_remote_off() {
    use crate::model::Level;
    let g = rig(DECIDE);
    let key = g.store.load().unwrap().phones[0].key.clone();
    // the paired key is a teammate's, and the owner's phone remote is switched off
    let mut s = g.store.load().unwrap();
    s.phones[0].level = Some(Level::Helper);
    s.phones[0].who = Some(crate::board::remote::Mate { email: "bob@acme.com".into(), handle: "bob".into(), user_id: "u_bob".into() });
    g.store.save(&s).unwrap();
    g.r.reload();
    g.r.set_phones_on(false);
    g.sent();
    g.hear("msg_a1", "msg_1", &g.action(Do::Allow, DECIDE, "n1"));
    assert!(g.calls().is_empty());
    assert_eq!(g.result("msg_a1"), "refused", "a Helper may not allow");
    // the owner raises them to Trusted
    g.r.set_mate_level("bob@acme.com", Level::Trusted).unwrap();
    assert_eq!(g.store.load().unwrap().phones[0].level, Some(Level::Trusted));
    g.hear("msg_a2", "msg_1", &g.action(Do::Allow, DECIDE, "n2"));
    assert_eq!(g.calls(), ["approve s1 42"]);
    assert_eq!(g.result("msg_a2"), "applied");
    assert_eq!(g.r.acted().map(|a| (a.who, a.what)), Some(("bob".to_string(), "allowed `Bash: npm test`".to_string())));
    // removed: at once nobody
    g.r.remove_mate("bob@acme.com").unwrap();
    assert!(g.store.load().unwrap().phones.iter().all(|p| p.key != key));
    g.hear("msg_a3", "msg_1", &g.action(Do::Allow, DECIDE, "n3"));
    assert_eq!(g.result("msg_a3"), "refused");
    assert!(g.r.set_mate_level("bob@acme.com", Level::Helper).is_ok(), "no key yet: nothing to change");
}

#[test]
fn with_the_phone_remote_off_the_owners_phone_is_refused_and_no_heartbeat_is_written() {
    let g = rig(DECIDE);
    g.r.set_phones_on(false);
    g.sent();
    g.hear("msg_a1", "msg_1", &g.action(Do::Allow, DECIDE, "n1"));
    assert_eq!(g.result("msg_a1"), "refused");
    g.r.tick();
    assert!(g.sent().is_empty());
    assert!(g.r.pair_start(1).is_err(), "no phone is paired while the phone remote is off");
}

fn bob_request(id: &str, ticket: &str, rng: u64) -> Event {
    const PUB: &str = "BJFoira10seT_4mQCR9cHCW_d571sQbL3La0PctTmwr5P3GDEX_lc0QORs_pqRotn_e4cNgEMUb1Sdclf3Km8E8";
    let mac = crate::board::pairing::proof(&crate::board::pairing::code_of(rng), &crate::board::remote::unb64(PUB).unwrap(), "Bob's Mac");
    let mut e = event(id, ticket, &serde_json::json!({ "public": PUB, "name": "Bob's Mac", "mac": mac }).to_string());
    e.labels = BTreeMap::from([("coc.kind".to_string(), "pair".to_string())]);
    e.channel = "v/ada/pair".into();
    e.principal = "vercel:user:u_bob".into();
    e.person = true;
    e.handle = "bob".into();
    e
}

#[test]
fn pairing_a_teammates_mac_gives_it_the_invites_level() {
    use crate::board::pairing::MateFor;
    use crate::model::Level;
    let g = rig(DECIDE);
    // it works with the phone remote off: it is not about phones
    g.r.set_phones_on(false);
    g.r.pair_start_mate(77, MateFor { email: "bob@acme.com".into(), user_id: "u_bob".into(), level: Level::Trusted }).unwrap();
    let sent = g.sent();
    assert!(matches!(sent.as_slice(), [MsgWrite::Post { channel, .. }] if channel == "v/ada/pair"), "{sent:?}");
    assert_eq!((g.r.status().pairing.state.as_str(), g.r.status().pairing.for_email.as_deref()), ("open", Some("bob@acme.com")));
    g.r.handle(bob_request("msg_p1", "msg_sent_1", 77));
    let st = g.r.status();
    assert_eq!((st.pairing.state.as_str(), st.pairing.for_email.as_deref(), st.pairing.name.as_deref()), ("asking", Some("bob@acme.com"), Some("Bob's Mac")));
    g.r.pair_confirm().unwrap();
    let phones = g.store.load().unwrap().phones;
    let mate = phones.iter().find(|p| p.who.is_some()).unwrap();
    assert_eq!((mate.level, mate.who.as_ref().map(|w| w.handle.as_str())), (Some(Level::Trusted), Some("bob")));
    // only the ticket's closing edit: no phone record for a teammate
    let sent = g.sent();
    assert!(matches!(sent.as_slice(), [MsgWrite::Edit { .. }]), "{sent:?}");
    // the owner's phone list in Settings is phones only; the map names the paired teammates
    assert_eq!(g.r.status().phones.len(), 1);
    assert_eq!(g.r.mates().iter().map(|m| (m.key.clone(), m.handle.as_str(), m.level.as_str())).collect::<Vec<_>>(), [(mate.key.clone(), "bob", "trusted")]);
    assert_eq!(g.r.paired_mates(), ["bob@acme.com"]);
    // pairing their Mac again (a new Mac) replaces the old key
    g.r.pair_start_mate(78, MateFor { email: "bob@acme.com".into(), user_id: "u_bob".into(), level: Level::Helper }).unwrap();
    g.sent();
    g.r.handle(bob_request("msg_p2", "msg_sent_1", 78));
    g.r.pair_confirm().unwrap();
    assert_eq!(g.store.load().unwrap().phones.iter().filter(|p| p.who.is_some()).count(), 1);
}

#[test]
fn lowering_never_raises_and_a_visitor_has_no_key() {
    use crate::model::Level;
    let g = rig(DECIDE);
    let mut s = g.store.load().unwrap();
    s.phones[0].level = Some(Level::Helper);
    s.phones[0].who = Some(crate::board::remote::Mate { email: "bob@acme.com".into(), handle: "bob".into(), user_id: "u_bob".into() });
    g.store.save(&s).unwrap();
    g.r.reload();
    // what the settings file says is never a reason to give more
    g.r.lower_mate("bob@acme.com", Level::Trusted).unwrap();
    assert_eq!(g.store.load().unwrap().phones[0].level, Some(Level::Helper));
    g.r.lower_mate("bob@acme.com", Level::Helper).unwrap();
    assert_eq!(g.store.load().unwrap().phones.len(), 1);
    // made a Visitor: nothing left to act with
    g.r.lower_mate("bob@acme.com", Level::Visitor).unwrap();
    assert!(g.store.load().unwrap().phones.is_empty());
    assert!(g.r.lower_mate("nobody@acme.com", Level::Visitor).is_ok());
}
