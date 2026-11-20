use super::*;
use crate::board::cli::MsgWrite;
use crate::board::listen::Event;
use crate::board::remote::{b64, check_number, key_id, unb64};
use std::collections::BTreeMap;

const PUB: &str = "BJFoira10seT_4mQCR9cHCW_d571sQbL3La0PctTmwr5P3GDEX_lc0QORs_pqRotn_e4cNgEMUb1Sdclf3Km8E8";
const NOW: i64 = 1_000_000;

/// The code `open()` shows: 12 characters, typed on the phone, never written to the board.
const CODE: &str = "00000000EQK1";

fn request(id: &str, ticket: &str, public: &str, name: &str) -> Event {
    request_with(id, ticket, public, name, CODE)
}

/// A request as a phone that was given `code` makes it.
fn request_with(id: &str, ticket: &str, public: &str, name: &str, code: &str) -> Event {
    let mac = unb64(public).map(|p| proof(code, &p, name)).unwrap_or_default();
    let mut e = bare_request(id, ticket, public, name);
    e.text = serde_json::json!({ "public": public, "name": name, "mac": mac }).to_string();
    e
}

fn bare_request(id: &str, ticket: &str, public: &str, name: &str) -> Event {
    Event {
        cursor: "c".into(),
        kind: "message.posted".into(),
        id: id.into(),
        thread_root: Some(ticket.into()),
        channel: "v/ada/remote".into(),
        text: serde_json::json!({ "public": public, "name": name }).to_string(), // no proof
        labels: BTreeMap::from([("coc.kind".to_string(), "pair".to_string())]),
        principal: "vercel:project:prj_K:production".into(),
        profile: Some("remote".into()),
        person: false,
        handle: "remote".into(),
    }
}

/// A pairing with its ticket posted as `msg_t_1`.
fn open() -> Pairing {
    let mut p = Pairing::default();
    p.start(NOW, 482_913, "h1", "ada");
    p.ticket_posted("msg_t_1".into());
    assert_eq!(p.state(), &PairState::Open { code: CODE.into(), until: NOW + 300_000 });
    p
}

fn json(text: &str) -> serde_json::Value {
    serde_json::from_str(text).unwrap()
}

#[test]
fn the_ticket_carries_the_code_until_and_host() {
    let mut p = Pairing::default();
    let MsgWrite::Post { channel, text, labels, key } = p.start(NOW, u64::MAX, "h1", "ada") else { panic!() };
    let code = "ZZZZZZZZZZZZ";
    assert_eq!(p.state(), &PairState::Open { code: code.into(), until: NOW + 300_000 });
    assert_eq!(channel, "v/ada/remote");
    // the board gets a name for the ticket made from the code, never the code
    let id = ticket_id(code);
    assert_eq!(id.len(), 16);
    assert_eq!(labels, [("coc.kind".to_string(), "pair-open".to_string()), ("coc.code".to_string(), id.clone()), ("coc.host".to_string(), "h1".to_string())]);
    assert_eq!(json(&text), serde_json::json!({ "host": "h1", "id": id, "until": NOW + 300_000, "state": "open" }));
    assert!(!text.contains(code));
    assert_eq!(key, format!("coc-pair-h1-{NOW}"));
}

#[test]
fn the_code_and_its_proof_are_the_ones_the_phone_computes() {
    // remote/lib/crypto.test.ts holds the same values
    assert_eq!(code_of(482_913), CODE);
    assert_eq!(ticket_id(CODE), "24a36f2920d1e732");
    let public = unb64(PUB).unwrap();
    assert_eq!(proof(CODE, &public, "iPhone"), "RR7L_HTGwX1UUSt98KbGmmZ7R4UvObE4fJEXNFlC9oU");
    assert_ne!(proof(CODE, &public, "iPhone"), proof("00000000EQK2", &public, "iPhone"));
    assert_ne!(proof(CODE, &public, "iPhone"), proof(CODE, &public, "iPhonf"));
}

#[test]
fn a_request_without_the_codes_proof_is_ignored() {
    // Someone who can post on the board (a teammate, or an agent with the owner's login) answers
    // the ticket with a key of their own: they never saw the code, so they cannot prove it.
    let mut p = open();
    p.on_event(&bare_request("msg_t_2", "msg_t_1", PUB, "x"), NOW);
    p.on_event(&request_with("msg_t_2", "msg_t_1", PUB, "x", "00000000EQK2"), NOW);
    let mut renamed = request("msg_t_2", "msg_t_1", PUB, "mine");
    renamed.text = renamed.text.replace("mine", "theirs");
    p.on_event(&renamed, NOW);
    assert!(matches!(p.state(), PairState::Open { .. }), "{:?}", p.state());
    // and none of them cancels the real phone's pairing
    p.on_event(&request("msg_t_3", "msg_t_1", PUB, "mine"), NOW);
    assert!(matches!(p.state(), PairState::Asking(_)));
    assert_eq!(p.on_event(&bare_request("msg_t_4", "msg_t_1", PUB, "x"), NOW), None);
    assert!(matches!(p.state(), PairState::Asking(_)));
}

#[test]
fn a_request_under_our_ticket_asks_with_the_check_number() {
    let mut p = open();
    assert_eq!(p.on_event(&request("msg_t_2", "msg_t_1", PUB, "  Ada's iPhone  "), NOW + 1), None);
    let PairState::Asking(r) = p.state() else { panic!("{:?}", p.state()) };
    assert_eq!((r.id.as_str(), r.name.as_str()), ("msg_t_2", "Ada's iPhone"));
    assert_eq!(r.check, check_number(&unb64(PUB).unwrap(), "msg_t_1"));
    assert_eq!(r.check, "792 693", "the number the phone shows (scripts/remote-vectors.mjs)");
}

#[test]
fn what_is_not_a_request_for_our_ticket_is_ignored() {
    let mut p = open();
    p.on_event(&request("msg_x_2", "msg_x_1", PUB, "x"), NOW);
    let mut unlabelled = request("msg_t_2", "msg_t_1", PUB, "x");
    unlabelled.labels.clear();
    p.on_event(&unlabelled, NOW);
    let mut edited = request("msg_t_2", "msg_t_1", PUB, "x");
    edited.kind = "message.edited".into();
    p.on_event(&edited, NOW);
    p.on_event(&request("msg_t_2", "msg_t_1", "AAAA", "short key"), NOW);
    p.on_event(&request("msg_t_2", "msg_t_1", &b64(&[5u8; 65]), "not an uncompressed point"), NOW);
    let mut garbage = request("msg_t_2", "msg_t_1", PUB, "x");
    garbage.text = "hello".into();
    p.on_event(&garbage, NOW);
    assert!(matches!(p.state(), PairState::Open { .. }), "{:?}", p.state());
    // before the ticket's id is known, and with no pairing at all
    let mut early = Pairing::default();
    early.start(NOW, 1, "h1", "ada");
    early.on_event(&request("msg_t_2", "msg_t_1", PUB, "x"), NOW);
    assert!(matches!(early.state(), PairState::Open { .. }));
    let mut idle = Pairing::default();
    assert_eq!(idle.on_event(&request("msg_t_2", "msg_t_1", PUB, "x"), NOW), None);
    assert_eq!(idle.state(), &PairState::Idle);
}

#[test]
fn a_second_request_cancels() {
    let mut p = open();
    p.on_event(&request("msg_t_2", "msg_t_1", PUB, "mine"), NOW);
    // the same request heard twice (a restarted tail) is one request
    assert_eq!(p.on_event(&request("msg_t_2", "msg_t_1", PUB, "mine"), NOW), None);
    assert!(matches!(p.state(), PairState::Asking(_)));
    let closed = p.on_event(&request("msg_t_3", "msg_t_1", PUB, "someone else"), NOW).expect("the ticket is closed");
    let MsgWrite::Edit { id, text } = closed else { panic!() };
    assert_eq!((id.as_str(), json(&text)["state"].as_str()), ("msg_t_1", Some("closed")));
    assert!(matches!(p.state(), PairState::Cancelled(_)));
    assert!(p.confirm(NOW).is_none());
}

#[test]
fn confirm_gives_the_phone_and_its_record() {
    let mut p = open();
    assert!(p.confirm(NOW).is_none(), "nothing to confirm yet");
    p.on_event(&request("msg_t_2", "msg_t_1", PUB, "iPhone"), NOW);
    let (phone, writes) = p.confirm(NOW + 9).unwrap();
    let public = unb64(PUB).unwrap();
    assert_eq!((phone.key.clone(), phone.public.clone(), phone.name.as_str(), phone.paired_at, phone.record.clone()), (key_id(&public), public, "iPhone", NOW + 9, None));
    let [MsgWrite::Post { channel, text, labels, .. }, MsgWrite::Edit { id, text: closed }] = writes.as_slice() else { panic!("{writes:?}") };
    assert_eq!(channel, "v/ada/remote");
    assert_eq!(labels, &[("coc.kind".to_string(), "phone".to_string()), ("coc.key".to_string(), phone.key.clone()), ("coc.host".to_string(), "h1".to_string())]);
    assert_eq!(json(text), serde_json::json!({ "key": phone.key, "public": PUB, "name": "iPhone", "state": "paired", "host": "h1" }));
    assert_eq!((id.as_str(), json(closed)["state"].as_str()), ("msg_t_1", Some("closed")));
    assert_eq!(p.state(), &PairState::Idle);
    assert_eq!(json(&phone_record(&phone, "removed", "h1"))["state"], "removed");
}

#[test]
fn it_expires_after_five_minutes_and_can_be_cancelled() {
    let mut p = open();
    assert_eq!(p.tick(NOW + 299_999), None);
    let Some(MsgWrite::Edit { id, .. }) = p.tick(NOW + 300_000) else { panic!() };
    assert_eq!(id, "msg_t_1");
    assert!(matches!(p.state(), PairState::Cancelled(_)));
    assert_eq!(p.tick(NOW + 400_000), None, "closed once");
    // a request that comes late finds nothing open
    p.on_event(&request("msg_t_2", "msg_t_1", PUB, "late"), NOW + 400_000);
    assert!(matches!(p.state(), PairState::Cancelled(_)));

    let mut asking = open();
    asking.on_event(&request("msg_t_2", "msg_t_1", PUB, "iPhone"), NOW);
    assert!(matches!(asking.cancel(), Some(MsgWrite::Edit { .. })));
    assert_eq!(asking.state(), &PairState::Idle);
    assert_eq!(asking.cancel(), None);
    // starting again replaces whatever was there
    asking.start(NOW, 7, "h1", "ada");
    assert_eq!(asking.state(), &PairState::Open { code: "000000000007".into(), until: NOW + 300_000 });
}

#[test]
fn the_village_root_says_when_the_mac_was_last_seen() {
    assert_eq!(json(&village_text("h1", "0.9.0", 77)), serde_json::json!({ "host": "h1", "version": "0.9.0", "seen": 77 }));
}

mod phones {
    use crate::board::phones::*;
    use crate::board::remote::Phone;

    fn secrets() -> Secrets {
        Secrets { phones: vec![Phone { key: "k1".into(), public: vec![4, 1, 2], name: "iPhone".into(), paired_at: 1, last_used: 2, record: Some("msg_1".into()), level: None, who: None }], setup_secret: Some("s".into()), ..Default::default() }
    }

    #[test]
    fn secrets_round_trip_in_memory() {
        let store = MemoryStore::default();
        assert_eq!(store.load().unwrap(), Secrets::default());
        store.save(&secrets()).unwrap();
        assert_eq!(store.load().unwrap(), secrets());
    }

    #[test]
    fn lends_and_borrow_nonces_are_kept_with_the_phones_and_old_blobs_still_read() {
        use crate::board::borrow::Lend;
        let mut s = secrets();
        s.lends = vec![Lend { builder: "b1".into(), keys: Some(vec!["k1".into()]), workspaces: None, floor: 10, ask: true }];
        s.borrow_nonces = vec![("n1".into(), 5)];
        assert_eq!(decode(&encode(&s)).unwrap(), s);
        // an item saved before lending existed
        let old = decode(br#"{"phones":[],"setupSecret":null}"#).unwrap();
        assert!(old.lends.is_empty() && old.borrow_nonces.is_empty());
    }

    #[test]
    fn secrets_are_one_json_blob() {
        let bytes = encode(&secrets());
        assert_eq!(decode(&bytes).unwrap(), secrets());
        assert!(decode(b"not json").is_err(), "a damaged item is an error, never an empty list");
    }

    /// The real Keychain, under a service name of its own. Run by hand:
    /// `cargo test --lib keychain_round_trip -- --ignored`
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        let k = Keychain { service: format!("dev.clashofclaudes.test.{}", uuid::Uuid::new_v4()) };
        assert_eq!(k.load().unwrap(), Secrets::default(), "no item yet");
        k.save(&secrets()).unwrap();
        assert_eq!(k.load().unwrap(), secrets());
        k.save(&Secrets::default()).unwrap();
        assert_eq!(k.load().unwrap(), Secrets::default());
        k.delete().unwrap();
    }
}

// Pairing a teammate's Mac: the same code and proof, in `v/<owner>/pair`, and only from the
// invited person's own Vercel login.
fn bob() -> MateFor {
    MateFor { email: "bob@acme.com".into(), user_id: "u_bob".into(), level: crate::model::Level::Helper }
}

fn open_for_bob() -> Pairing {
    let mut p = Pairing::default();
    let MsgWrite::Post { channel, .. } = p.start_mate(NOW, 482_913, "h1", "ada", bob()) else { panic!() };
    assert_eq!(channel, "v/ada/pair", "a teammate cannot post in `remote`, where the owner's phones are");
    p.ticket_posted("msg_t_1".into());
    p
}

fn from_bob(mut e: Event) -> Event {
    e.principal = "vercel:user:u_bob".into();
    e.person = true;
    e.handle = "bob/village".into();
    e.channel = "v/ada/pair".into();
    e
}

#[test]
fn a_mates_request_must_come_from_the_invited_login() {
    // the right code, posted by someone else: a teammate who was shown it, the remote's project, another person's agent
    let mut p = open_for_bob();
    p.on_event(&request("msg_t_2", "msg_t_1", PUB, "x"), NOW);
    let mut eve = from_bob(request("msg_t_3", "msg_t_1", PUB, "x"));
    eve.principal = "vercel:user:u_eve".into();
    p.on_event(&eve, NOW);
    let mut unverified = from_bob(request("msg_t_4", "msg_t_1", PUB, "x"));
    unverified.person = false;
    p.on_event(&unverified, NOW);
    assert!(matches!(p.state(), PairState::Open { .. }), "{:?}", p.state());
    // bob's login without the code's proof is not enough either
    p.on_event(&from_bob(bare_request("msg_t_5", "msg_t_1", PUB, "x")), NOW);
    assert!(matches!(p.state(), PairState::Open { .. }));
    // bob, with the code
    p.on_event(&from_bob(request("msg_t_6", "msg_t_1", PUB, "Bob's Mac")), NOW);
    let PairState::Asking(r) = p.state() else { panic!("{:?}", p.state()) };
    assert_eq!((r.name.as_str(), r.for_email.as_deref()), ("Bob's Mac", Some("bob@acme.com")));
}

#[test]
fn confirming_a_mate_keeps_the_key_with_its_level_and_posts_no_record() {
    let mut p = open_for_bob();
    p.on_event(&from_bob(request("msg_t_2", "msg_t_1", PUB, "Bob's Mac")), NOW);
    let (phone, writes) = p.confirm(NOW + 5).unwrap();
    assert_eq!(phone.level, Some(crate::model::Level::Helper));
    assert_eq!(phone.who, Some(crate::board::remote::Mate { email: "bob@acme.com".into(), handle: "bob".into(), user_id: "u_bob".into() }));
    // a record would let the key into the phone remote's API: only the ticket is closed
    assert!(matches!(writes.as_slice(), [MsgWrite::Edit { id, .. }] if id == "msg_t_1"), "{writes:?}");
}

#[test]
fn a_phones_ticket_is_still_answered_by_the_remote() {
    let mut p = open();
    p.on_event(&request("msg_t_2", "msg_t_1", PUB, "iPhone"), NOW);
    let PairState::Asking(r) = p.state() else { panic!() };
    assert_eq!(r.for_email, None);
    let (phone, writes) = p.confirm(NOW).unwrap();
    assert_eq!((phone.level, phone.who, writes.len()), (None, None, 2));
}
