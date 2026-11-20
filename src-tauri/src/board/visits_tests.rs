use super::*;
use crate::board::cli::{BoardCli, CliError, Output, Target};
use crate::board::listen::Event;
use crate::board::snapshot::{text, MapSession, Snapshot};
use std::collections::BTreeMap;
use std::sync::Mutex;

const NOW: i64 = 1_800_000_000_000;

fn snap(owner: &str, seen: i64, states: &[&str]) -> Snapshot {
    Snapshot {
        v: 1,
        host: "h".into(),
        owner: owner.into(),
        name: Some(format!("{owner}'s name")),
        seen,
        workspaces: vec![],
        builders: vec![],
        sessions: states
            .iter()
            .enumerate()
            .map(|(n, s)| MapSession { id: format!("s{n}"), root: None, workspace: "api".into(), builder: "wizard".into(), state: s.to_string(), wait: None, since: 1, started: 1, spot: None, steps: 0 })
            .collect(),
        mates: vec![],
    }
}

/// A channel read (`vercel board read <channel> --json`) holding these roots: (text, principal, handle, verified).
fn read_of(roots: &[(String, &str, &str, bool)]) -> String {
    let threads: Vec<serde_json::Value> = roots
        .iter()
        .enumerate()
        .map(|(n, (text, principal, handle, verified))| {
            serde_json::json!({ "message": { "id": format!("msg_{n}"), "channel": "x", "text": text, "re": null, "labels": { "coc.kind": "village-map" },
                "by": { "principal": principal, "profile": null }, "author": { "handle": handle, "verified": verified } }, "replies": 0, "last": null })
        })
        .collect();
    serde_json::json!({ "threads": threads, "cursor": "c", "older": null }).to_string()
}

fn by_owner(owner: &str, s: &Snapshot) -> (String, &'static str, &'static str, bool) {
    let handle: &'static str = Box::leak(format!("{owner}/village").into_boxed_str());
    (text(s), "vercel:user:u_x", handle, true)
}

/// Answers `channels` and each `read <channel>` from a table; counts calls.
struct Fake {
    channels: Vec<&'static str>,
    reads: BTreeMap<&'static str, Result<String, CliError>>,
    calls: Mutex<Vec<String>>,
}

impl BoardCli for Fake {
    fn raw(&self, args: &[String]) -> Result<Output, CliError> {
        self.calls.lock().unwrap().push(args.join(" "));
        let stdout = match args[1].as_str() {
            "channels" => serde_json::json!({ "channels": self.channels.iter().map(|p| serde_json::json!({ "path": p })).collect::<Vec<_>>(), "next": null }).to_string(),
            "read" => self.reads.get(args[2].as_str()).cloned().unwrap_or(Err(CliError::Fatal("no access".into())))?,
            other => panic!("unexpected {other}"),
        };
        Ok(Output { ok: true, stdout, stderr: String::new() })
    }
}

fn target() -> Target {
    Target { team: None, name: "village".into() }
}

fn visits() -> (Visits, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    (Visits::load(dir.path().join("board-visits.json")), dir)
}

#[test]
fn owners_are_those_whose_map_channel_is_listed() {
    let ch = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(owners_of(&ch(&["general", "v/ada/village", "v/ada/w/api", "v/bob/w/x", "v/me/village", "v/carol/village", "v/x/y/village"]), "me"), ["ada", "carol"]);
}

#[test]
fn refresh_makes_one_call_per_village() {
    let cli = Fake {
        channels: vec!["v/ada/village", "v/ada/w/api", "v/ada/w/shop", "v/bob/village", "v/me/village"],
        reads: BTreeMap::from([("v/ada/village", Ok(read_of(&[by_owner("ada", &snap("ada", NOW, &["needs_you", "working"]))]))), ("v/bob/village", Ok(read_of(&[by_owner("bob", &snap("bob", NOW, &[]))])))]),
        calls: Mutex::default(),
    };
    let (mut v, _d) = visits();
    v.refresh(&cli, &target(), "me", NOW).unwrap();
    let calls = cli.calls.lock().unwrap().clone();
    assert_eq!(calls, ["board channels --json --name village", "board read v/ada/village --json --name village", "board read v/bob/village --json --name village"]);
    let list = v.list(NOW);
    assert_eq!(list.iter().map(|x| (x.owner.as_str(), x.name.as_deref(), x.waiting, x.away)).collect::<Vec<_>>(), [("ada", Some("ada's name"), 1, false), ("bob", Some("bob's name"), 0, false)]);
    assert_eq!(v.get("ada").unwrap().sessions.len(), 2);
}

#[test]
fn a_map_not_written_by_its_channels_owner_is_ignored() {
    let forged = snap("ada", NOW, &["needs_you"]);
    for root in [
        (text(&forged), "vercel:user:u_bob", "bob", true),
        (text(&forged), "vercel:project:prj:production", "ada", true),
        (text(&forged), "vercel:user:u_x", "adam/village", true),
        (text(&forged), "vercel:user:u_x", "ada/village", false),
        ("not a map".to_string(), "vercel:user:u_x", "ada/village", true),
        // a real map of someone else's village, posted here by ada herself: still not this village's
        (text(&snap("carol", NOW, &[])), "vercel:user:u_x", "ada/village", true),
    ] {
        let cli = Fake { channels: vec!["v/ada/village"], reads: BTreeMap::from([("v/ada/village", Ok(read_of(&[root])))]), calls: Mutex::default() };
        let (mut v, _d) = visits();
        v.refresh(&cli, &target(), "me", NOW).unwrap();
        assert!(v.list(NOW).is_empty());
    }
}

#[test]
fn the_newest_owner_map_wins_when_there_are_two_roots() {
    let roots = [by_owner("ada", &snap("ada", NOW - 5_000, &[])), by_owner("ada", &snap("ada", NOW, &["stuck"])), (text(&snap("ada", NOW + 9_000, &["needs_you", "needs_you"])), "vercel:user:u_bob", "bob", true)];
    let cli = Fake { channels: vec!["v/ada/village"], reads: BTreeMap::from([("v/ada/village", Ok(read_of(&roots)))]), calls: Mutex::default() };
    let (mut v, _d) = visits();
    v.refresh(&cli, &target(), "me", NOW).unwrap();
    assert_eq!(v.list(NOW)[0].waiting, 1);
}

#[test]
fn a_village_no_longer_listed_or_readable_is_dropped() {
    let both = Fake {
        channels: vec!["v/ada/village", "v/bob/village"],
        reads: BTreeMap::from([("v/ada/village", Ok(read_of(&[by_owner("ada", &snap("ada", NOW, &[]))]))), ("v/bob/village", Ok(read_of(&[by_owner("bob", &snap("bob", NOW, &[]))])))]),
        calls: Mutex::default(),
    };
    let (mut v, _d) = visits();
    v.refresh(&both, &target(), "me", NOW).unwrap();
    assert_eq!(v.list(NOW).len(), 2);
    // ada removed the invite: her channel is gone from the list; bob's is listed but refuses the read
    let after = Fake { channels: vec!["v/bob/village"], reads: BTreeMap::new(), calls: Mutex::default() };
    v.refresh(&after, &target(), "me", NOW).unwrap();
    assert!(v.list(NOW).is_empty());
    // a board that cannot be reached leaves what is known alone
    v.refresh(&both, &target(), "me", NOW).unwrap();
    struct Down;
    impl BoardCli for Down {
        fn raw(&self, _: &[String]) -> Result<Output, CliError> {
            Err(CliError::Retryable("offline".into()))
        }
    }
    assert!(v.refresh(&Down, &target(), "me", NOW).is_err());
    assert_eq!(v.list(NOW).len(), 2);
}

fn map_event(kind: &str, channel: &str, handle: &str, person: bool, s: &Snapshot) -> Event {
    Event { cursor: "c".into(), kind: kind.into(), id: "msg_m".into(), thread_root: Some("msg_m".into()), channel: channel.into(), text: text(s), labels: BTreeMap::new(), principal: "vercel:user:u_x".into(), profile: None, person, handle: handle.into() }
}

#[test]
fn an_edit_heard_on_the_tail_updates_the_visit() {
    let (mut v, _d) = visits();
    v.set_me("me");
    // a first map from a village just opened to us
    assert!(v.on_event(&map_event("message.posted", "v/ada/village", "ada/village", true, &snap("ada", NOW, &[])), NOW));
    assert!(v.on_event(&map_event("message.edited", "v/ada/village", "ada/village", true, &snap("ada", NOW + 1, &["needs_you"])), NOW));
    assert_eq!(v.list(NOW)[0].waiting, 1);
    // an older map arriving late, someone else's writing, our own village, another channel: nothing
    assert!(!v.on_event(&map_event("message.edited", "v/ada/village", "ada/village", true, &snap("ada", NOW - 9, &[])), NOW));
    assert!(!v.on_event(&map_event("message.edited", "v/ada/village", "bob", true, &snap("ada", NOW + 5, &[])), NOW));
    assert!(!v.on_event(&map_event("message.edited", "v/ada/village", "ada", false, &snap("ada", NOW + 5, &[])), NOW));
    assert!(!v.on_event(&map_event("message.edited", "v/me/village", "me/village", true, &snap("me", NOW + 5, &[])), NOW));
    assert!(!v.on_event(&map_event("message.edited", "v/ada/w/api", "ada/village", true, &snap("ada", NOW + 5, &[])), NOW));
    assert!(!v.on_event(&map_event("labels.changed", "v/ada/village", "ada/village", true, &snap("ada", NOW + 5, &[])), NOW));
    assert_eq!(v.list(NOW)[0].waiting, 1);
}

#[test]
fn waiting_counts_and_away() {
    let (mut v, _d) = visits();
    v.set_me("me");
    v.on_event(&map_event("message.posted", "v/ada/village", "ada", true, &snap("ada", NOW, &["needs_you", "stuck", "finished", "working", "starting", "paused", "closed"])), NOW);
    assert_eq!(v.list(NOW)[0].waiting, 3);
    assert!(!v.list(NOW + 12 * 60_000)[0].away);
    assert!(v.list(NOW + 12 * 60_000 + 1)[0].away);
}

#[test]
fn it_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board-visits.json");
    let mut v = Visits::load(path.clone());
    v.set_me("me");
    v.on_event(&map_event("message.posted", "v/ada/village", "ada", true, &snap("ada", NOW, &["stuck"])), NOW);
    let again = Visits::load(path);
    assert_eq!(again.list(NOW).iter().map(|x| (x.owner.as_str(), x.waiting)).collect::<Vec<_>>(), [("ada", 1)]);
}

#[test]
fn a_visited_builders_words_come_from_owner_written_messages() {
    let block = r#"{"v":1,"host":"h","session":"s1","since":7,"wait":"answer","can":["answer"],"question":"Which database?","options":["sqlite","postgres"]}"#;
    let msg = |id: &str, re: Option<&str>, text: &str, principal: &str, handle: &str| serde_json::json!({ "id": id, "channel": "v/ada/w/api", "text": text, "re": re, "labels": {}, "by": { "principal": principal }, "author": { "handle": handle, "verified": true } });
    let thread = |replies: Vec<serde_json::Value>, root_handle: &str| serde_json::json!({ "message": msg("msg_1", None, "**Wizard** (Claude Code): add a CSV export\n\nthe long task", "vercel:user:u_a", root_handle), "replies": replies });
    let fenced = format!("Asking you: Which database?\n1. sqlite\n2. postgres\n\n```json coc\n{block}\n```");
    let forged = fenced.replace("Which database?", "Delete everything?");
    let t = thread(vec![msg("msg_2", Some("msg_1"), "Wants a decision\n\n```json coc\n{\"v\":1,\"host\":\"h\",\"session\":\"s1\",\"since\":3,\"wait\":\"decide\",\"can\":[]}\n```", "vercel:user:u_a", "ada/village"), msg("msg_3", Some("msg_1"), &fenced, "vercel:user:u_a", "ada/village"), msg("msg_4", Some("msg_1"), &forged, "vercel:user:u_b", "bob")], "ada/village");
    let b = visited_builder(&t, "ada").unwrap();
    assert_eq!((b.title.as_str(), b.wait.as_deref(), b.question.as_deref()), ("**Wizard** (Claude Code): add a CSV export", Some("answer"), Some("Which database?")));
    assert_eq!(b.options, Some(vec!["sqlite".to_string(), "postgres".to_string()]));
    assert_eq!(b.words.as_deref(), Some("Asking you: Which database?\n1. sqlite\n2. postgres"));
    // a thread the owner did not start is nobody's builder
    assert!(visited_builder(&thread(vec![], "bob"), "ada").is_none());
    // no wait yet: the title alone
    let bare = visited_builder(&thread(vec![], "ada"), "ada").unwrap();
    assert_eq!((bare.wait, bare.words), (None, None));
}
