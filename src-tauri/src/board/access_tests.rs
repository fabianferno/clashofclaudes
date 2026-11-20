use super::*;
use crate::board::cli::Target;
use crate::model::{AccessSettings, Invite, Level};
use std::collections::BTreeMap;

// `vercel board grants list --json`, as recorded on the scratch board (CLI 66.5.0) with a closed village.
const LIST: &str = r#"{"grants":[
 {"id":"g1","principals":[{"kind":"all-users"}],"can":{"*":"all"},"capped":true,"by":null,"at":null},
 {"id":"g2","principals":[{"environments":["preview","production"],"kind":"all-projects"}],"can":{"*":["read","post","react","label","sync"]},"capped":false},
 {"id":"g3","principals":[{"kind":"all-apps"}],"can":{"*":["read","post","react","label"]},"capped":true},
 {"id":"g4","principals":[{"kind":"user","userId":"u_ada","email":"ada@acme.com"}],"can":{"v/ada/":"all"},"capped":true},
 {"id":"g6","principals":[{"kind":"project","projectId":"prj_1","environments":["production"],"name":"village-remote"}],"can":{"v/ada/":["read","post","label"]}},
 {"id":"g7","principals":[{"kind":"user","userId":"u_bob","email":"bob@acme.com"}],"can":{"v/ada/village":["read"],"v/ada/w/":["read"]}},
 {"id":"g5","principals":[{"kind":"everyone"}],"can":{"v/ada/":[]}}]}"#;

fn grants() -> Vec<Grant> {
    parse_grants(&serde_json::from_str(LIST).unwrap())
}

fn open_grants() -> Vec<Grant> {
    grants().into_iter().filter(|g| ["g1", "g2", "g3"].contains(&g.id.as_str())).collect()
}

fn invite(level: Level, workspaces: Option<Vec<&str>>) -> Invite {
    Invite { email: "bob@acme.com".into(), level, workspaces: workspaces.map(|w| w.into_iter().map(String::from).collect()), grant: None, user_id: None }
}

fn slugs() -> BTreeMap<String, String> {
    BTreeMap::from([("w1".to_string(), "api".to_string()), ("w2".to_string(), "shop".to_string())])
}

fn can(g: &GrantSpec) -> Vec<(String, String)> {
    g.can.iter().map(|(p, perms)| (p.clone(), perms.join(","))).collect()
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[test]
fn closing_names_the_owner_first_and_everyone_last() {
    let g = closing("ada", "ada@acme.com", true);
    assert_eq!(g.len(), 3);
    assert_eq!((&g[0].who, can(&g[0])), (&Who::User("ada@acme.com".into()), vec![("v/ada/".to_string(), "all".to_string())]));
    assert_eq!((&g[1].who, can(&g[1])), (&Who::Project("village-remote".into()), vec![("v/ada/".to_string(), "read,post,label".to_string())]));
    assert_eq!((&g[2].who, can(&g[2])), (&Who::Everyone, vec![("v/ada/".to_string(), String::new())]));
}

#[test]
fn closing_adds_the_remote_only_when_set_up() {
    let g = closing("ada", "ada@acme.com", false);
    assert_eq!(g.iter().map(|g| &g.who).collect::<Vec<_>>(), [&Who::User("ada@acme.com".into()), &Who::Everyone]);
}

#[test]
fn an_invite_reads_the_map_and_its_workspaces() {
    let all = invite_spec("ada", &invite(Level::Visitor, None), &slugs());
    assert_eq!(all.who, Who::User("bob@acme.com".into()));
    assert_eq!(can(&all), [("v/ada/village".to_string(), "read".to_string()), ("v/ada/w/".to_string(), "read".to_string())]);
    // some workspaces; one that is no longer shared (not in the slugs) is left out
    let some = invite_spec("ada", &invite(Level::Visitor, Some(vec!["w2", "gone"])), &slugs());
    assert_eq!(can(&some), [("v/ada/village".to_string(), "read".to_string()), ("v/ada/w/shop".to_string(), "read".to_string())]);
}

#[test]
fn helper_and_trusted_also_post_and_never_label_or_touch_remote() {
    for level in [Level::Helper, Level::Trusted] {
        let g = invite_spec("ada", &invite(level, Some(vec!["w1"])), &slugs());
        assert_eq!(can(&g), [("v/ada/pair".to_string(), "read,post".to_string()), ("v/ada/village".to_string(), "read".to_string()), ("v/ada/w/api".to_string(), "read,post".to_string())]);
        for (pattern, perms) in &g.can {
            assert!(!perms.contains(&"label") && !perms.contains(&"manage") && !pattern.contains("remote"), "{pattern} {perms:?}");
        }
    }
}

#[test]
fn create_update_and_revoke_args() {
    let team = Target { team: Some("acme".into()), name: "village".into() };
    let none = Target { team: None, name: "village".into() };
    let g = closing("ada", "ada@acme.com", true);
    assert_eq!(create_args(&g[0], &team), s(&["board", "grants", "create", "--user", "ada@acme.com", "--can", "v/ada/=all", "--json", "--name", "village", "--scope", "acme"]));
    assert_eq!(create_args(&g[1], &none), s(&["board", "grants", "create", "--project", "village-remote", "--can", "v/ada/=read,post,label", "--json", "--name", "village"]));
    assert_eq!(create_args(&g[2], &none), s(&["board", "grants", "create", "--everyone", "--can", "v/ada/=none", "--json", "--name", "village"]));
    let inv = invite_spec("ada", &invite(Level::Helper, None), &slugs());
    assert_eq!(
        update_args("g7", &inv, &none),
        s(&["board", "grants", "update", "g7", "--can", "v/ada/pair=read,post", "--can", "v/ada/village=read", "--can", "v/ada/w/=read,post", "--json", "--name", "village"])
    );
    assert_eq!(revoke_args("g7", &team), s(&["board", "grants", "revoke", "g7", "--json", "--name", "village", "--scope", "acme"]));
    assert_eq!(list_args(&none), s(&["board", "grants", "list", "--json", "--name", "village"]));
    for args in [create_args(&g[2], &none), update_args("g7", &inv, &none)] {
        assert!(!args.iter().any(|a| a == "--lock-me-out"));
    }
}

#[test]
fn parse_grants_reads_the_recorded_list() {
    let g = grants();
    assert_eq!(g.len(), 7);
    let mine = g.iter().find(|g| g.id == "g4").unwrap();
    assert_eq!((mine.user_id.as_deref(), mine.email.as_deref(), mine.can.get("v/ada/")), (Some("u_ada"), Some("ada@acme.com"), Some(&s(&["all"]))));
    let everyone = g.iter().find(|g| g.id == "g5").unwrap();
    assert!(everyone.everyone && everyone.can["v/ada/"].is_empty());
    assert_eq!(g.iter().find(|g| g.id == "g6").unwrap().project.as_deref(), Some("village-remote"));
    assert!(g.iter().find(|g| g.id == "g1").unwrap().all_users);
    assert!(parse_grants(&serde_json::json!({"status": "error"})).is_empty());
}

#[test]
fn village_state_closed_open() {
    assert_eq!(village_state(&grants(), "ada"), Seen::Closed);
    assert_eq!(village_state(&open_grants(), "ada"), Seen::Open);
    // someone else's village being closed says nothing about this one
    assert_eq!(village_state(&grants(), "bob"), Seen::Open);
    assert_eq!(village_state(&[], "ada"), Seen::Unknown, "no list was read");
}

#[test]
fn who_can_see_names_people_remote_and_team() {
    assert_eq!(who_can_see(&grants(), "ada", "u_ada"), ["You", "bob@acme.com", "The phone remote, and whoever can deploy it"]);
    assert_eq!(who_can_see(&open_grants(), "ada", "u_ada"), ["Everyone on your Vercel team, and every project's deployments"]);
}

/// Grants nobody of ours made: another project, and everyone let into one workspace.
fn with_strangers() -> Vec<Grant> {
    let mut g = grants();
    g.push(Grant { id: "g8".into(), project: Some("other-app".into()), can: BTreeMap::from([("v/ada/w/".to_string(), s(&["read"]))]), ..Default::default() });
    g.push(Grant { id: "g9".into(), everyone: true, can: BTreeMap::from([("v/ada/w/api".to_string(), s(&["read", "post"]))]), ..Default::default() });
    g.push(Grant { id: "g10".into(), all_users: true, can: BTreeMap::from([("v/ada/village".to_string(), s(&["all"]))]), ..Default::default() });
    // someone else's village: nothing to do with this one
    g.push(Grant { id: "g11".into(), project: Some("x".into()), can: BTreeMap::from([("v/adam/w/".to_string(), s(&["read"]))]), ..Default::default() });
    g
}

#[test]
fn who_can_see_names_every_grant_that_reaches_the_village() {
    assert_eq!(
        who_can_see(&with_strangers(), "ada", "u_ada"),
        ["You", "bob@acme.com", "The phone remote, and whoever can deploy it", "The project other-app, and whoever can deploy it", "Everyone on your Vercel team, in v/ada/w/api", "Everyone on your Vercel team, in v/ada/village"]
    );
}

#[test]
fn drift_names_anything_let_in_that_the_owner_did_not_set() {
    let set = AccessSettings { private: true, grants: vec!["g4".into(), "g6".into(), "g5".into()], invites: vec![Invite { grant: Some("g7".into()), ..invite(Level::Visitor, None) }], ..Default::default() };
    assert_eq!(drift(&set, &with_strangers(), "ada").as_deref(), Some("The project other-app can see your village, and you did not let it in."));
    let only_everyone: Vec<Grant> = with_strangers().into_iter().filter(|g| g.id != "g8").collect();
    assert_eq!(drift(&set, &only_everyone, "ada").as_deref(), Some("Everyone on your Vercel team can see v/ada/w/api."));
}

#[test]
fn drift_notices_an_opened_village_and_a_missing_invite() {
    let mut set = AccessSettings { private: true, grants: vec!["g4".into(), "g6".into(), "g5".into()], invites: vec![Invite { grant: Some("g7".into()), ..invite(Level::Visitor, None) }], asked: true, ..Default::default() };
    assert_eq!(drift(&set, &grants(), "ada"), None);
    assert_eq!(drift(&set, &open_grants(), "ada").as_deref(), Some("Your village is open to the team again."));
    let without_bob: Vec<Grant> = grants().into_iter().filter(|g| g.id != "g7").collect();
    assert_eq!(drift(&set, &without_bob, "ada").as_deref(), Some("The invite for bob@acme.com is gone from the board."));
    // someone was let in whom the owner did not invite
    let mut extra = grants();
    extra.push(Grant { id: "g9".into(), user_id: Some("u_eve".into()), email: Some("eve@acme.com".into()), can: BTreeMap::from([("v/ada/w/".to_string(), s(&["read"]))]), ..Default::default() });
    assert_eq!(drift(&set, &extra, "ada").as_deref(), Some("eve@acme.com can see your village, and you did not invite them."));
    // an open village the owner wants open is no drift
    set.private = false;
    set.invites.clear();
    assert_eq!(drift(&set, &open_grants(), "ada"), None);
    assert_eq!(drift(&set, &[], "ada"), None, "nothing read: nothing to say");
}
