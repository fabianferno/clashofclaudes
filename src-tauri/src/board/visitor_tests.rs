use super::*;
use crate::board::cli::MsgWrite;
use crate::board::listen::Event;
use crate::board::mac_key::{MacKey, MemoryKey};
use crate::board::pairing::{code_of, ticket_id, MateFor, PairState, Pairing};
use crate::board::remote::{judge, key_id, parse_action, sha_hex, Do, Open, Phone, Verdict};
use crate::board::visits::visited_builder;
use crate::model::Level;
use std::collections::{BTreeMap, HashSet};

const NOW: i64 = 1_800_000_000_000;

fn msg(id: &str, re: Option<&str>, text: &str, principal: &str, handle: &str, labels: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "id": id, "channel": "v/ada/pair", "text": text, "re": re, "labels": labels, "by": { "principal": principal }, "author": { "handle": handle, "verified": true } })
}

fn ticket(id: &str, code: &str, until: i64, state: &str, handle: &str, principal: &str) -> serde_json::Value {
    let text = serde_json::json!({ "host": "h1", "id": ticket_id(code), "until": until, "state": state }).to_string();
    serde_json::json!({ "message": msg(id, None, &text, principal, handle, serde_json::json!({ "coc.kind": "pair-open", "coc.code": ticket_id(code) })), "replies": 0 })
}

#[test]
fn the_ticket_is_found_by_the_codes_name_among_owner_written_roots() {
    let code = code_of(42);
    let read = |threads: Vec<serde_json::Value>| serde_json::json!({ "threads": threads });
    let mine = ticket("msg_t", &code, NOW + 60_000, "open", "ada/village", "vercel:user:u_ada");
    assert_eq!(find_ticket(&read(vec![ticket("msg_o", &code_of(7), NOW + 60_000, "open", "ada/village", "vercel:user:u_ada"), mine.clone()]), "ada", &code, NOW).as_deref(), Some("msg_t"));
    // a look-alike planted by someone else, an expired one, a closed one: none of them
    for other in [
        ticket("msg_x", &code, NOW + 60_000, "open", "bob", "vercel:user:u_bob"),
        ticket("msg_x", &code, NOW + 60_000, "open", "ada", "vercel:project:prj:production"),
        ticket("msg_x", &code, NOW - 1, "open", "ada/village", "vercel:user:u_ada"),
        ticket("msg_x", &code, NOW + 60_000, "closed", "ada/village", "vercel:user:u_ada"),
    ] {
        assert_eq!(find_ticket(&read(vec![other]), "ada", &code, NOW), None);
    }
    assert_eq!(find_ticket(&read(vec![mine]), "ada", &code_of(43), NOW), None, "another code");
}

/// The request, as the owner's listener hears it once bob's Mac posted it.
fn heard(w: &MsgWrite, id: &str, principal: &str, handle: &str) -> Event {
    let MsgWrite::ReplyTo { id: ticket, text, labels, .. } = w else { panic!("{w:?}") };
    Event { cursor: "c".into(), kind: "message.posted".into(), id: id.into(), thread_root: Some(ticket.clone()), channel: "v/ada/pair".into(), text: text.clone(), labels: labels.iter().cloned().collect::<BTreeMap<_, _>>(), principal: principal.into(), profile: Some("village".into()), person: true, handle: handle.into() }
}

#[test]
fn the_request_carries_the_proof_the_owner_checks() {
    let key = MemoryKey::new();
    let mut owner = Pairing::default();
    owner.start_mate(NOW, 42, "h1", "ada", MateFor { email: "bob@acme.com".into(), user_id: "u_bob".into(), level: Level::Trusted });
    owner.ticket_posted("msg_t".into());
    let (write, check) = pair_request("msg_t", &code_of(42), &key, "bob").unwrap();
    owner.on_event(&heard(&write, "msg_r", "vercel:user:u_bob", "bob/village"), NOW);
    let PairState::Asking(r) = owner.state() else { panic!("{:?}", owner.state()) };
    assert_eq!((r.check.as_str(), r.name.as_str()), (check.as_str(), "bob’s Mac"));
    let (phone, _) = owner.confirm(NOW).unwrap();
    assert_eq!((phone.key.clone(), phone.level), (key_id(&key.public().unwrap()), Some(Level::Trusted)));
    // made with another code, it proves nothing
    let mut again = Pairing::default();
    again.start_mate(NOW, 42, "h1", "ada", MateFor { email: "bob@acme.com".into(), user_id: "u_bob".into(), level: Level::Trusted });
    again.ticket_posted("msg_t".into());
    let (wrong, _) = pair_request("msg_t", &code_of(43), &key, "bob").unwrap();
    again.on_event(&heard(&wrong, "msg_r", "vercel:user:u_bob", "bob/village"), NOW);
    assert!(matches!(again.state(), PairState::Open { .. }));
}

const BLOCK: &str = r#"{"v":1,"host":"h1","session":"s1","since":42,"wait":"decide","can":["allow","deny"],"question":"Bash: npm test"}"#;

#[test]
fn an_action_signed_by_this_mac_is_one_the_owner_takes() {
    let key = MemoryKey::new();
    let a = action(&key, Do::Allow, None, None, &sha_hex(BLOCK.as_bytes()), "00112233445566778899aabbccddeeff").unwrap();
    let write = action_write("msg_1", &a);
    let MsgWrite::ReplyTo { id, text, labels, key: idem } = &write else { panic!() };
    assert_eq!((id.as_str(), idem.as_str()), ("msg_1", "coc-act-00112233445566778899aabbccddeeff"));
    assert_eq!(labels, &[("coc.do".to_string(), "allow".to_string())]);
    // what the owner's Mac reads back and judges
    let read = parse_action(text).unwrap();
    assert_eq!(read, a);
    let public = key.public().unwrap();
    let phones = |level| vec![Phone { key: key_id(&public), public: public.clone(), name: "bob’s Mac".into(), paired_at: 1, last_used: 0, record: None, level: Some(level), who: None }];
    let open = || Some(Open { block_json: BLOCK, since: 42, current_since: 42 });
    assert_eq!(judge(&read, &phones(Level::Trusted), open(), &HashSet::new(), true), Verdict::Apply);
    assert_eq!(judge(&read, &phones(Level::Helper), open(), &HashSet::new(), false), Verdict::Refused);
    // typed words are part of what is signed
    let mut said = action(&key, Do::Followup, None, Some("also add tests"), &sha_hex(BLOCK.as_bytes()), "00112233445566778899aabbccddeeff").unwrap();
    said.text = Some("delete everything".into());
    assert_eq!(judge(&said, &phones(Level::Trusted), open(), &HashSet::new(), false), Verdict::Refused);
}

#[test]
fn a_visited_builder_says_what_can_be_done_and_how_our_action_ended() {
    let key = MemoryKey::new();
    let mine = key_id(&key.public().unwrap());
    let owner = |id: &str, re: Option<&str>, text: &str| msg(id, re, text, "vercel:user:u_ada", "ada/village", serde_json::json!({}));
    let wait = format!("Wants a decision: `Bash: npm test`\n\n```json coc\n{BLOCK}\n```");
    let a = action(&key, Do::Allow, None, None, &sha_hex(BLOCK.as_bytes()), "00112233445566778899aabbccddeeff").unwrap();
    let act = |id: &str, a: &crate::board::remote::Action| msg(id, Some("msg_1"), &serde_json::to_string(a).unwrap(), "vercel:user:u_bob", "bob/village", serde_json::json!({ "coc.do": "allow" }));
    let thread = |replies: Vec<serde_json::Value>| serde_json::json!({ "message": owner("msg_1", None, "**Wizard** (Claude Code): add a CSV export"), "replies": replies });

    let b = visited_builder(&thread(vec![owner("msg_2", Some("msg_1"), &wait)]), "ada", Some(&mine)).unwrap();
    assert_eq!((b.can.clone(), b.prompt.clone(), b.sent, b.result.clone()), (vec!["allow".to_string(), "deny".to_string()], Some(sha_hex(BLOCK.as_bytes())), false, None));

    let sent = visited_builder(&thread(vec![owner("msg_2", Some("msg_1"), &wait), act("msg_3", &a)]), "ada", Some(&mine)).unwrap();
    assert_eq!((sent.sent, sent.result.clone()), (true, None));
    // someone else's action is not ours, and a result written by someone else is not the owner's
    let other = MemoryKey::new();
    let theirs = action(&other, Do::Allow, None, None, &sha_hex(BLOCK.as_bytes()), "ffeeddccbbaa99887766554433221100").unwrap();
    let forged = msg("msg_4", Some("msg_1"), r#"{"re":"msg_3","result":"applied"}"#, "vercel:user:u_bob", "bob", serde_json::json!({}));
    let b = visited_builder(&thread(vec![owner("msg_2", Some("msg_1"), &wait), act("msg_3", &theirs), forged.clone()]), "ada", Some(&mine)).unwrap();
    assert_eq!((b.sent, b.result), (false, None));
    let done = visited_builder(&thread(vec![owner("msg_2", Some("msg_1"), &wait), act("msg_3", &a), forged, owner("msg_5", Some("msg_1"), r#"{"re":"msg_3","result":"stale"}"#)]), "ada", Some(&mine)).unwrap();
    assert_eq!((done.sent, done.result.as_deref()), (true, Some("stale")));
    // with no key of our own (never paired anywhere), nothing is ours
    let none = visited_builder(&thread(vec![owner("msg_2", Some("msg_1"), &wait), act("msg_3", &a)]), "ada", None).unwrap();
    assert!(!none.sent);
}

// Borrowing a builder from a visit.
fn lender_map(my_key: &str) -> crate::board::snapshot::Snapshot {
    use crate::board::snapshot::{MapBuilder, MapLend, MapSession, Snapshot};
    let session = |id: &str, by: Option<&str>, state: &str, wait: Option<&str>| MapSession { id: id.into(), root: Some(format!("msg_{id}")), workspace: "shop".into(), builder: "wizard".into(), state: state.into(), wait: wait.map(str::to_string), since: 1, started: 1, spot: None, steps: 0, by: by.map(str::to_string) };
    Snapshot {
        v: 1,
        host: "h1".into(),
        owner: "ada".into(),
        name: None,
        seen: NOW,
        workspaces: vec![],
        builders: vec![MapBuilder { profile: "wizard".into(), name: "Wizard".into(), agent: "claude".into() }],
        sessions: vec![session("s1", Some(my_key), "needs_you", Some("answer")), session("s2", Some("someone-else"), "working", None), session("s3", None, "finished", Some("review"))],
        mates: vec![],
        lend: vec![
            MapLend { profile: "wizard".into(), name: "Wizard".into(), workspaces: None, keys: None },
            MapLend { profile: "archer".into(), name: "Archer".into(), workspaces: Some(vec!["api".into()]), keys: Some(vec![my_key.to_string()]) },
            MapLend { profile: "giant".into(), name: "Giant".into(), workspaces: None, keys: Some(vec!["someone-else".into()]) },
        ],
    }
}

#[test]
fn the_builders_lent_to_this_mac_for_a_workspace() {
    let map = lender_map("k_me");
    let names = |ws: &str| lent_here(&map, "k_me", ws).iter().map(|l| l.name.clone()).collect::<Vec<_>>();
    assert_eq!(names("shop"), ["Wizard"]);
    assert_eq!(names("api"), ["Wizard", "Archer"]);
    assert!(lent_here(&map, "k_other", "shop").iter().all(|l| l.name == "Wizard"), "lent to every paired Mac");
}

#[test]
fn borrowed_sessions_are_the_ones_whose_by_is_this_mac() {
    let mine = borrowed_in(&lender_map("k_me"), "k_me");
    assert_eq!(mine.iter().map(|b| (b.owner.as_str(), b.session.as_str(), b.root.as_deref(), b.builder.as_str(), b.workspace.as_str(), b.state.as_str(), b.wait.as_deref())).collect::<Vec<_>>(), [("ada", "s1", Some("msg_s1"), "Wizard", "shop", "needs_you", Some("answer"))]);
    assert!(borrowed_in(&lender_map("k_me"), "k_nobody").is_empty());
}

#[test]
fn a_request_signed_here_is_one_the_lender_takes() {
    use crate::board::borrow::{parse_request, take, Facts, Lend, Take};
    let key = MemoryKey::new();
    let public = key.public().unwrap();
    let (request, write) = borrow_request(&key, "ada", "h1", "wizard", "shop", "  Add a CSV export  ", NOW, "00112233445566778899aabbccddeeff").unwrap();
    let MsgWrite::Post { channel, text, labels, key: idem } = &write else { panic!("{write:?}") };
    assert_eq!((channel.as_str(), idem.as_str()), ("v/ada/w/shop", "coc-borrow-00112233445566778899aabbccddeeff"));
    assert_eq!(labels, &[("coc.kind".to_string(), "borrow".to_string())]);
    assert_eq!(parse_request(text), Some(request.clone()));
    assert_eq!(request.task, "Add a CSV export");
    let phones = vec![Phone { key: key_id(&public), public, name: "x".into(), paired_at: 1, last_used: 0, record: None, level: Some(Level::Helper), who: None }];
    let lends = vec![Lend { builder: "b1".into(), keys: None, workspaces: None, floor: 0, ask: false }];
    let seen = HashSet::new();
    let facts = Facts { host: "h1", channel, owner: "ada", now: NOW + 500, phones: &phones, lends: &lends, seen: &seen, builder: Some(("b1", false, None)), workspace: Some(("w1", true)) };
    assert_eq!(take(&request, &facts), Take::Start);
    assert!(borrow_request(&key, "ada", "h1", "wizard", "shop", "   ", NOW, "00").is_err(), "no task");
    assert!(borrow_request(&key, "ada", "h1", "wizard", "shop", &"x".repeat(9_000), NOW, "00").is_err(), "too long for the board");
}

#[test]
fn the_result_is_read_from_the_owners_reply_only() {
    let reply = |id: &str, text: &str, principal: &str, handle: &str| msg(id, Some("msg_q"), text, principal, handle, serde_json::json!({}));
    let thread = |replies: Vec<serde_json::Value>| serde_json::json!({ "message": msg("msg_q", None, "{}", "vercel:user:u_me", "me/village", serde_json::json!({ "coc.kind": "borrow" })), "replies": replies });
    assert_eq!(borrow_result(&thread(vec![]), "ada", "msg_q"), None);
    let forged = reply("msg_1", r#"{"re":"msg_q","result":"started"}"#, "vercel:user:u_bob", "bob");
    assert_eq!(borrow_result(&thread(vec![forged.clone()]), "ada", "msg_q"), None);
    let real = reply("msg_2", r#"{"re":"msg_q","result":"refused","why":"that builder is not lent"}"#, "vercel:user:u_ada", "ada/village");
    assert_eq!(borrow_result(&thread(vec![forged, real]), "ada", "msg_q"), Some(("refused".to_string(), Some("that builder is not lent".to_string()))));
    let other = reply("msg_3", r#"{"re":"msg_other","result":"started"}"#, "vercel:user:u_ada", "ada/village");
    assert_eq!(borrow_result(&thread(vec![other]), "ada", "msg_q"), None, "a result for another request");
}

#[test]
fn sent_requests_and_their_results_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board-borrows.json");
    let mut s = SentRequests::load(path.clone());
    s.add(SentRequest { owner: "ada".into(), request: "msg_q".into(), builder: "Wizard".into(), workspace: "shop".into(), task: "Add a CSV export".into(), at: NOW, result: None, why: None });
    assert_eq!(s.waiting().iter().map(|r| r.request.as_str()).collect::<Vec<_>>(), ["msg_q"]);
    s.set_result("msg_q", "waiting", None);
    assert_eq!(s.waiting().len(), 1, "waiting for the lender is not an answer yet");
    s.set_result("msg_q", "started", None);
    assert!(s.waiting().is_empty());
    let again = SentRequests::load(path);
    assert_eq!(again.list().iter().map(|r| (r.request.as_str(), r.result.as_deref())).collect::<Vec<_>>(), [("msg_q", Some("started"))]);
    // only the last twenty are kept
    let mut many = again;
    for n in 0..30 {
        many.add(SentRequest { owner: "ada".into(), request: format!("msg_{n}"), builder: "W".into(), workspace: "s".into(), task: "t".into(), at: NOW + n, result: None, why: None });
    }
    assert_eq!(many.list().len(), 20);
}
