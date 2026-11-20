use super::*;
use crate::board::mac_key::{MacKey, MemoryKey};
use crate::board::remote::{key_id, sha_hex, Phone};
use crate::model::Level;
use std::collections::HashSet;

const NOW: i64 = 1_800_000_000_000;

struct World {
    key: MemoryKey,
    phones: Vec<Phone>,
    lends: Vec<Lend>,
    seen: HashSet<String>,
}

fn world(level: Option<Level>) -> World {
    let key = MemoryKey::new();
    let public = key.public().unwrap();
    let phones = vec![Phone { key: key_id(&public), public, name: "bob’s Mac".into(), paired_at: 1, last_used: 0, record: None, level, who: None }];
    let lends = vec![Lend { builder: "b1".into(), keys: None, workspaces: None, floor: 10, ask: false }];
    World { key, phones, lends, seen: HashSet::new() }
}

impl World {
    fn request(&self, task: &str) -> Request {
        let mut r = Request { v: 1, builder: "wizard".into(), workspace: "shop".into(), task: task.into(), at: NOW - 1_000, nonce: "00112233445566778899aabbccddeeff".into(), key: self.phones[0].key.clone(), sig: String::new() };
        self.sign(&mut r, "h1");
        r
    }
    fn sign(&self, r: &mut Request, host: &str) {
        r.sig = self.key.sign(&request_bytes(host, r)).unwrap();
    }
    fn facts(&self) -> Facts<'_> {
        Facts { host: "h1", channel: "v/ada/w/shop", owner: "ada", now: NOW, phones: &self.phones, lends: &self.lends, seen: &self.seen, builder: Some(("b1", false, Some(60))), workspace: Some(("w1", true)) }
    }
}

#[test]
fn the_signed_bytes_are_the_seven_lines() {
    let w = world(Some(Level::Helper));
    let r = w.request("add a CSV export");
    let s = String::from_utf8(request_bytes("h1", &r)).unwrap();
    assert_eq!(s, format!("coc-borrow-1\nh1\nwizard\nshop\n{}\n{}\n00112233445566778899aabbccddeeff", sha_hex(b"add a CSV export"), NOW - 1_000));
}

#[test]
fn parse_reads_a_request_and_refuses_the_rest() {
    let w = world(Some(Level::Helper));
    let r = w.request("add a CSV export");
    assert_eq!(parse_request(&serde_json::to_string(&r).unwrap()), Some(r.clone()));
    assert_eq!(parse_request("borrow wizard please"), None);
    assert_eq!(parse_request(&serde_json::to_string(&Request { v: 2, ..r.clone() }).unwrap()), None);
    assert_eq!(parse_request(&serde_json::to_string(&Request { task: "x".repeat(9_000), ..r.clone() }).unwrap()), None, "longer than the board would take");
    assert_eq!(parse_request(&serde_json::to_string(&Request { task: "  ".into(), ..r }).unwrap()), None, "no task");
}

#[test]
fn take_starts_a_good_request_and_asks_when_the_builder_is_ask_first() {
    let mut w = world(Some(Level::Helper));
    let r = w.request("add a CSV export");
    assert_eq!(take(&r, &w.facts()), Take::Start);
    assert_eq!(take(&r, &World { phones: world(Some(Level::Trusted)).phones, ..world(None) }.facts()), Take::Refused("not a paired Mac"));
    w.lends[0].ask = true;
    assert_eq!(take(&r, &w.facts()), Take::Ask);
}

#[test]
fn only_a_paired_helper_or_trusted_mac_may_ask() {
    for (level, expect) in [(Some(Level::Visitor), Take::Refused("a Visitor cannot borrow")), (None, Take::Refused("a phone cannot borrow")), (Some(Level::Trusted), Take::Start)] {
        let w = world(level);
        assert_eq!(take(&w.request("x"), &w.facts()), expect, "{level:?}");
    }
    let w = world(Some(Level::Helper));
    let mut stranger = w.request("x");
    stranger.key = "deadbeefdeadbeef".into();
    assert_eq!(take(&stranger, &w.facts()), Take::Refused("not a paired Mac"));
}

#[test]
fn a_request_changed_after_signing_or_signed_for_another_village_is_refused() {
    let w = world(Some(Level::Helper));
    let good = w.request("add a CSV export");
    for change in [
        |r: &mut Request| r.task = "delete everything".into(),
        |r: &mut Request| r.builder = "giant".into(),
        |r: &mut Request| r.workspace = "api".into(),
        |r: &mut Request| r.at += 1,
        |r: &mut Request| r.nonce = "ffeeddccbbaa99887766554433221100".into(),
    ] {
        let mut r = good.clone();
        change(&mut r);
        let mut f = w.facts();
        // let the altered names resolve, so only the signature stands in the way
        f.channel = if r.workspace == "api" { "v/ada/w/api" } else { "v/ada/w/shop" };
        assert_eq!(take(&r, &f), Take::Refused("the signature does not match"));
    }
    let mut elsewhere = good.clone();
    w.sign(&mut elsewhere, "another-host");
    assert_eq!(take(&elsewhere, &w.facts()), Take::Refused("the signature does not match"), "signed for another village");
}

#[test]
fn a_request_must_be_posted_where_it_says_and_be_fresh_and_new() {
    let mut w = world(Some(Level::Helper));
    let r = w.request("x");
    let mut f = w.facts();
    f.channel = "v/ada/w/api";
    assert_eq!(take(&r, &f), Take::Refused("posted in another workspace's channel"));
    let mut f = w.facts();
    f.channel = "v/bob/w/shop";
    assert_eq!(take(&r, &f), Take::Refused("posted in another workspace's channel"));

    let mut old = w.request("x");
    old.at = NOW - 24 * 3_600_000 - 1;
    w.sign(&mut old, "h1");
    assert_eq!(take(&old, &w.facts()), Take::Refused("asked more than a day ago"));
    let mut ahead = w.request("x");
    ahead.at = NOW + 5 * 60_000 + 1;
    w.sign(&mut ahead, "h1");
    assert_eq!(take(&ahead, &w.facts()), Take::Refused("its clock is ahead"));

    w.seen.insert(r.nonce.clone());
    assert_eq!(take(&r, &w.facts()), Take::Refused("already taken"));
}

#[test]
fn the_lending_record_decides_what_is_lent() {
    let mut w = world(Some(Level::Helper));
    let r = w.request("x");
    w.lends.clear();
    assert_eq!(take(&r, &w.facts()), Take::Refused("that builder is not lent"));
    w.lends = vec![Lend { builder: "b1".into(), keys: Some(vec!["someone-else".into()]), workspaces: None, floor: 10, ask: false }];
    assert_eq!(take(&r, &w.facts()), Take::Refused("that builder is not lent to you"));
    w.lends[0].keys = Some(vec![w.phones[0].key.clone()]);
    w.lends[0].workspaces = Some(vec!["w2".into()]);
    assert_eq!(take(&r, &w.facts()), Take::Refused("that builder is not lent for this workspace"));
    w.lends[0].workspaces = Some(vec!["w1".into()]);
    assert_eq!(take(&r, &w.facts()), Take::Start);
}

#[test]
fn an_unknown_builder_or_a_workspace_that_cannot_be_lent_is_refused() {
    let w = world(Some(Level::Helper));
    let r = w.request("x");
    let mut f = w.facts();
    f.builder = None;
    assert_eq!(take(&r, &f), Take::Refused("no such builder"));
    let mut f = w.facts();
    f.workspace = None;
    assert_eq!(take(&r, &f), Take::Refused("no such workspace"));
    let mut f = w.facts();
    f.workspace = Some(("w1", false));
    assert_eq!(take(&r, &f), Take::Refused("that workspace cannot be lent"));
}

#[test]
fn busy_and_low_are_said_as_such() {
    let w = world(Some(Level::Helper));
    let r = w.request("x");
    let mut f = w.facts();
    f.builder = Some(("b1", true, Some(60)));
    assert_eq!(take(&r, &f), Take::Busy);
    let mut f = w.facts();
    f.builder = Some(("b1", false, Some(9)));
    assert_eq!(take(&r, &f), Take::Low);
    let mut f = w.facts();
    f.builder = Some(("b1", false, Some(10)));
    assert_eq!(take(&r, &f), Take::Start, "at the floor is enough");
    let mut f = w.facts();
    f.builder = Some(("b1", false, None));
    assert_eq!(take(&r, &f), Take::Start, "no reading counts as enough");
}

#[test]
fn branch_names_are_safe() {
    assert_eq!(branch_name("Bob!", "Add a CSV export", "ab12cd34"), "borrow/bob/add-a-csv-export-ab12");
    assert_eq!(branch_name("bob", "--force ../x; rm -rf /", "ab12cd34"), "borrow/bob/force-x-rm-rf-ab12");
    assert_eq!(branch_name("///", "  ", "ab12cd34"), "borrow/task/task-ab12");
    assert_eq!(branch_name("bob", "x", "!!"), "borrow/bob/x-0000");
    let long = branch_name("bob", &"very long task ".repeat(40), "ab12cd34");
    assert!(long.len() <= 80, "{long}");
    for b in [branch_name("-x", "-y", "ab12"), branch_name("a..b", "c..d", "ab12"), long] {
        assert!(!b.contains("..") && !b.contains(' ') && !b.contains("/-") && !b.starts_with('-') && !b.ends_with('/') && !b.ends_with(".lock"), "{b}");
    }
}

#[test]
fn a_result_names_its_request() {
    assert_eq!(serde_json::from_str::<serde_json::Value>(&result_text("msg_1", "started", None)).unwrap(), serde_json::json!({ "re": "msg_1", "result": "started" }));
    assert_eq!(serde_json::from_str::<serde_json::Value>(&result_text("msg_1", "refused", Some("already taken"))).unwrap(), serde_json::json!({ "re": "msg_1", "result": "refused", "why": "already taken" }));
}
