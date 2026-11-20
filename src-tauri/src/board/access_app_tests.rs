use super::*;
use crate::board::cli::{BoardCli, CliError, Output, Target};
use crate::model::{AccessSettings, Invite, Level};
use std::collections::BTreeMap;
use std::sync::Mutex;

/// A board that keeps grants: `create` answers with the next id, `revoke` removes, `list` lists.
/// `refuse`: a call starting with this fails as the board does for someone who may not do it.
#[derive(Default)]
struct Board {
    calls: Mutex<Vec<String>>,
    grants: Mutex<Vec<serde_json::Value>>,
    next: Mutex<u32>,
    refuse: Mutex<Option<&'static str>>,
}

impl Board {
    fn calls(&self) -> Vec<String> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
    fn ids(&self) -> Vec<String> {
        self.grants.lock().unwrap().iter().map(|g| g["id"].as_str().unwrap().to_string()).collect()
    }
}

impl BoardCli for Board {
    fn raw(&self, args: &[String]) -> Result<Output, CliError> {
        let line = args.join(" ");
        self.calls.lock().unwrap().push(line.clone());
        let ok = |v: serde_json::Value| Ok(Output { ok: true, stdout: v.to_string(), stderr: String::new() });
        if self.refuse.lock().unwrap().is_some_and(|r| line.starts_with(r)) {
            return ok(serde_json::json!({ "status": "error", "reason": "forbidden", "message": "Only a team owner can close a channel to everyone." }));
        }
        let flag = |name: &str| args.iter().position(|a| a == name).map(|i| args[i + 1].clone());
        let cans = || -> serde_json::Map<String, serde_json::Value> {
            args.iter()
                .enumerate()
                .filter(|(_, a)| *a == "--can")
                .map(|(i, _)| {
                    let (pattern, perms) = args[i + 1].split_once('=').unwrap();
                    let perms: Vec<&str> = if perms == "none" { vec![] } else { perms.split(',').collect() };
                    (pattern.to_string(), serde_json::json!(perms))
                })
                .collect()
        };
        match (args[1].as_str(), args[2].as_str()) {
            ("grants", "list") => {
                // every board has its own first grant: every person on the team, everything
                let mut all = vec![serde_json::json!({ "id": "g1", "principals": [{ "kind": "all-users" }], "can": { "*": "all" } })];
                all.extend(self.grants.lock().unwrap().iter().cloned());
                ok(serde_json::json!({ "grants": all }))
            }
            ("grants", "create") => {
                let mut n = self.next.lock().unwrap();
                *n += 1;
                let id = format!("g{}", *n + 3);
                let principal = if let Some(e) = flag("--user") {
                    serde_json::json!({ "kind": "user", "email": e, "userId": format!("u_{}", e.split('@').next().unwrap()) })
                } else if let Some(p) = flag("--project") {
                    serde_json::json!({ "kind": "project", "name": p })
                } else {
                    serde_json::json!({ "kind": "everyone" })
                };
                let g = serde_json::json!({ "id": id, "principals": [principal], "can": cans() });
                self.grants.lock().unwrap().push(g.clone());
                ok(serde_json::json!({ "grant": g, "outcome": "created" }))
            }
            ("grants", "update") => {
                let mut gs = self.grants.lock().unwrap();
                let g = gs.iter_mut().find(|g| g["id"] == args[3].as_str()).expect("the grant");
                g["can"] = serde_json::Value::Object(cans());
                ok(serde_json::json!({ "grant": g.clone(), "outcome": "updated" }))
            }
            ("grants", "revoke") => {
                self.grants.lock().unwrap().retain(|g| g["id"] != args[3].as_str());
                ok(serde_json::json!({ "grant": args[3], "outcome": "revoked" }))
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}

fn t() -> Target {
    Target { team: None, name: "village".into() }
}

fn me() -> Me {
    Me { owner: "ada".into(), email: "ada@acme.com".into() }
}

fn slugs() -> BTreeMap<String, String> {
    BTreeMap::from([("w1".to_string(), "api".to_string())])
}

#[test]
fn closing_runs_the_creates_in_order_and_keeps_their_ids() {
    let b = Board::default();
    let mut set = AccessSettings::default();
    close(&b, &t(), &me(), true, &mut set).unwrap();
    let calls = b.calls();
    assert_eq!(calls.len(), 3);
    assert!(calls[0].starts_with("board grants create --user ada@acme.com --can v/ada/=all"), "{calls:?}");
    assert!(calls[1].starts_with("board grants create --project village-remote --can v/ada/=read,post,label"), "{calls:?}");
    assert!(calls[2].starts_with("board grants create --everyone --can v/ada/=none"), "{calls:?}");
    assert_eq!((set.private, set.grants.clone()), (true, vec!["g4".to_string(), "g5".to_string(), "g6".to_string()]));
    // closing again changes nothing
    close(&b, &t(), &me(), true, &mut set).unwrap();
    assert!(b.calls().is_empty());
    let st = status(&b, &t(), &me(), &set, &slugs());
    assert_eq!((st.state.as_str(), st.can_close, st.drift.clone()), ("closed", true, None));
    assert_eq!(st.who, ["You", "The phone remote, and whoever can deploy it"]);
}

#[test]
fn a_refusal_on_the_last_step_takes_back_what_was_made_and_names_the_way_out() {
    let b = Board::default();
    *b.refuse.lock().unwrap() = Some("board grants create --everyone");
    let mut set = AccessSettings::default();
    let e = close(&b, &t(), &me(), false, &mut set).unwrap_err();
    assert!(e.contains("Only a team owner"), "{e}");
    assert!(b.ids().is_empty(), "the owner's own grant was revoked again: {:?}", b.ids());
    assert_eq!((set.private, set.grants.len()), (false, 0));
    let st = status(&b, &t(), &me(), &set, &slugs());
    assert_eq!(st.state, "open");
    let cmd = owner_command(&t(), &me(), false);
    assert_eq!(cmd, "vercel board grants create --user ada@acme.com --can 'v/ada/=all' --name village && vercel board grants create --everyone --can 'v/ada/=none' --name village");
    assert!(owner_command(&Target { team: Some("acme".into()), name: "village".into() }, &me(), true).contains("--project village-remote --can 'v/ada/=read,post,label' --name village --scope acme"));
}

#[test]
fn opening_revokes_everyone_first() {
    let b = Board::default();
    let mut set = AccessSettings::default();
    close(&b, &t(), &me(), true, &mut set).unwrap();
    b.calls();
    open(&b, &t(), &mut set).unwrap();
    let calls = b.calls();
    assert!(calls[0].starts_with("board grants list"), "{calls:?}");
    assert!(calls[1].starts_with("board grants revoke g6"), "everyone-none goes first: {calls:?}");
    assert_eq!(calls.len(), 4);
    assert!(b.ids().is_empty());
    assert_eq!((set.private, set.grants.len()), (false, 0));
}

#[test]
fn opening_skips_grants_that_are_no_longer_there() {
    let b = Board::default();
    let mut set = AccessSettings::default();
    close(&b, &t(), &me(), false, &mut set).unwrap();
    // one of ours was revoked by someone else; an id from long ago lingers
    b.grants.lock().unwrap().retain(|g| g["id"] != "g4");
    set.grants.insert(0, "g99".into());
    b.calls();
    open(&b, &t(), &mut set).unwrap();
    assert_eq!(b.calls().iter().filter(|c| c.starts_with("board grants revoke")).count(), 1, "only the one that exists");
    assert!(b.ids().is_empty() && set.grants.is_empty() && !set.private);
}

#[test]
fn ids_kept_for_another_board_are_not_this_boards() {
    let b = Board::default();
    let mut set = AccessSettings { private: true, grants: vec!["g4".into(), "g5".into()], board: Some("acme/other#ada".into()), invites: vec![Invite { email: "bob@acme.com".into(), level: Level::Visitor, workspaces: None, grant: Some("g7".into()), user_id: None }], ..Default::default() };
    put_back(&b, &t(), &me(), false, &mut set, &slugs()).unwrap();
    let st = status(&b, &t(), &me(), &set, &slugs());
    assert_eq!((st.state.as_str(), st.drift.clone()), ("closed", None));
    assert_eq!(set.board.as_deref(), Some("/village#ada"));
    assert_eq!(set.grants.len(), 2);
    assert!(st.invites[0].on_board, "the invite was made again on this board");
}

#[test]
fn the_remote_is_let_in_when_it_is_set_up_later() {
    let b = Board::default();
    let mut set = AccessSettings::default();
    close(&b, &t(), &me(), false, &mut set).unwrap();
    b.calls();
    close(&b, &t(), &me(), true, &mut set).unwrap();
    let calls = b.calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].starts_with("board grants create --project village-remote"), "{calls:?}");
    assert_eq!(set.grants.len(), 3);
}

#[test]
fn adding_changing_and_removing_an_invite() {
    let b = Board::default();
    let mut set = AccessSettings::default();
    invite_put(&b, &t(), &me(), &mut set, &slugs(), "Bob@Acme.com ", Level::Visitor, None).unwrap();
    assert_eq!(set.invites.len(), 1);
    let inv = set.invites[0].clone();
    assert_eq!((inv.email.as_str(), inv.level, inv.grant.as_deref(), inv.user_id.as_deref()), ("bob@acme.com", Level::Visitor, Some("g4"), Some("u_bob")));
    assert!(b.calls()[0].starts_with("board grants create --user bob@acme.com --can v/ada/village=read --can v/ada/w/=read"));
    // the same person again: their grant is changed, not doubled
    invite_put(&b, &t(), &me(), &mut set, &slugs(), "bob@acme.com", Level::Helper, Some(vec!["w1".into()])).unwrap();
    assert_eq!((set.invites.len(), set.invites[0].level, set.invites[0].workspaces.clone()), (1, Level::Helper, Some(vec!["w1".to_string()])));
    assert!(b.calls()[0].starts_with("board grants update g4 --can v/ada/pair=read,post --can v/ada/village=read --can v/ada/w/api=read,post"));
    let st = status(&b, &t(), &me(), &set, &slugs());
    assert_eq!(st.invites.iter().map(|i| (i.email.as_str(), i.level, i.on_board)).collect::<Vec<_>>(), [("bob@acme.com", Level::Helper, true)]);
    invite_remove(&b, &t(), &mut set, "bob@acme.com").unwrap();
    assert!(set.invites.is_empty() && b.ids().is_empty());
    assert!(invite_remove(&b, &t(), &mut set, "nobody@acme.com").is_err());
    assert!(invite_put(&b, &t(), &me(), &mut set, &slugs(), "not an email", Level::Visitor, None).is_err());
    assert!(invite_put(&b, &t(), &me(), &mut set, &slugs(), "ada@acme.com", Level::Visitor, None).is_err(), "inviting yourself");
}

#[test]
fn an_invite_the_board_refuses_is_not_kept() {
    let b = Board::default();
    *b.refuse.lock().unwrap() = Some("board grants create --user");
    let mut set = AccessSettings::default();
    assert!(invite_put(&b, &t(), &me(), &mut set, &slugs(), "bob@acme.com", Level::Visitor, None).is_err());
    assert!(set.invites.is_empty());
}

#[test]
fn put_back_recloses_and_recreates_missing_invites() {
    let b = Board::default();
    let mut set = AccessSettings::default();
    close(&b, &t(), &me(), false, &mut set).unwrap();
    invite_put(&b, &t(), &me(), &mut set, &slugs(), "bob@acme.com", Level::Visitor, None).unwrap();
    // someone revoked the closing grant and bob's invite behind the owner's back
    b.grants.lock().unwrap().retain(|g| g["principals"][0]["kind"] == "user" && g["principals"][0]["email"] == "ada@acme.com");
    let st = status(&b, &t(), &me(), &set, &slugs());
    assert_eq!((st.state.as_str(), st.drift.as_deref()), ("open", Some("Your village is open to the team again.")));
    b.calls();
    put_back(&b, &t(), &me(), false, &mut set, &slugs()).unwrap();
    let st = status(&b, &t(), &me(), &set, &slugs());
    assert_eq!((st.state.as_str(), st.drift), ("closed", None));
    assert!(st.invites[0].on_board);
    assert_eq!(st.who, ["You", "bob@acme.com"]);
}

#[test]
fn the_window_cannot_change_what_the_app_owns() {
    let old = AccessSettings { private: true, grants: vec!["g4".into()], invites: vec![Invite { email: "bob@acme.com".into(), level: Level::Trusted, workspaces: None, grant: Some("g7".into()), user_id: None }], asked: true, ..Default::default() };
    let from_window = AccessSettings::default();
    assert_eq!(keep_app_owned(&old, &from_window), old);
}

/// With the real `vercel` on the PATH, on the scratch board `coc-spike` of the login's default
/// team: closes the login's village there, reads it back, publishes a map, builds a visit from
/// it as another person would, and opens the village again. Leaves no grant behind.
/// `cargo test --lib real_village_closes_and_is_visited -- --ignored --nocapture`
#[test]
#[ignore]
fn real_village_closes_and_is_visited() {
    use crate::board::cli::{args_for_msg, status as board_status, MsgWrite, VercelCli};
    use crate::board::snapshot::{text, Snapshot};
    use crate::board::visits::Visits;
    let cli = VercelCli { program: None, cwd: std::env::temp_dir(), timeout: std::time::Duration::from_secs(60) };
    let target = Target { team: None, name: "coc-spike".into() };
    let st = board_status(&cli, &target);
    assert_eq!(st.state, "ready", "{st:?}");
    let owner = st.handle.unwrap();
    let who: serde_json::Value = serde_json::from_str(cli.raw(&["whoami".to_string(), "--json".to_string()]).unwrap().stdout.trim()).unwrap();
    let me = Me { owner: owner.clone(), email: who["email"].as_str().unwrap().to_string() };
    let slugs = BTreeMap::new();
    let mut set = AccessSettings::default();

    let before = status(&cli, &target, &me, &set, &slugs);
    println!("BEFORE {} who {:?}", before.state, before.who);
    assert_eq!(before.state, "open");

    close(&cli, &target, &me, true, &mut set).unwrap();
    let closed = status(&cli, &target, &me, &set, &slugs);
    println!("CLOSED {} who {:?} grants {:?} drift {:?}", closed.state, closed.who, set.grants, closed.drift);
    assert_eq!(closed.state, "closed");
    assert_eq!(closed.who, ["You", "The phone remote, and whoever can deploy it"]);
    assert_eq!(closed.drift, None);

    // the owner still writes inside: the village's map
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let snap = Snapshot { v: 1, host: "realvisit".into(), owner: owner.clone(), name: Some("Real run".into()), seen: now, workspaces: vec![], builders: vec![], sessions: vec![], mates: vec![] };
    let post = MsgWrite::Post { channel: format!("v/{owner}/village"), text: text(&snap), labels: vec![("coc.kind".into(), "village-map".into())], key: format!("coc-map-realvisit-{now}") };
    let posted = cli.run(&args_for_msg(&post, &target)).unwrap();
    println!("MAP posted as {}", posted["message"]["id"]);

    // someone else's app, with this login's access: the village is one to visit, and its map is the owner's
    let dir = tempfile::tempdir().unwrap();
    let mut visits = Visits::load(dir.path().join("v.json"));
    visits.refresh(&cli, &target, "someone-else", now).unwrap();
    let list = visits.list(now);
    println!("VISITS {:?}", list.iter().map(|v| (v.owner.clone(), v.name.clone(), v.away)).collect::<Vec<_>>());
    let mine = list.iter().find(|v| v.owner == owner).expect("the village is listed");
    assert_eq!((mine.name.as_deref(), mine.away), (Some("Real run"), false));

    open(&cli, &target, &mut set).unwrap();
    let after = status(&cli, &target, &me, &set, &slugs);
    println!("AFTER {} who {:?} grants {:?}", after.state, after.who, set.grants);
    assert_eq!(after.state, "open");
    assert!(set.grants.is_empty());
}
