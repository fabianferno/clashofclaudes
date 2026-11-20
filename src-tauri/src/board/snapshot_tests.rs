use super::*;
use crate::model::{AgentKind, AppData, Builder, Compound, SessionInfo, SessionKind, SessionState, Tile, Workspace};
use std::path::PathBuf;

fn ws(id: &str, name: &str, shared: bool) -> Workspace {
    Workspace {
        id: id.into(),
        name: name.into(),
        path: PathBuf::from(format!("/Users/ada/secret/{name}")),
        created_at: 0,
        missing: false,
        ships: vec![5_000],
        compound: Some(Compound { x0: 4, y0: 5, w: 6, h: 7, house: Tile { x: 5, y: 6 } }),
        color: Some("#3d6fd6".into()),
        notes: "remember the password".into(),
        board_shared: shared,
    }
}

fn builder(id: &str, name: &str) -> Builder {
    Builder { id: id.into(), name: name.into(), agent: AgentKind::Claude, model: None, effort: None, custom_command: None }
}

fn session(id: &str, ws: &str, state: SessionState, since: i64) -> SessionInfo {
    SessionInfo {
        id: id.into(),
        workspace_id: ws.into(),
        kind: SessionKind::Agent { builder_id: "b1".into() },
        task: Some("rotate the API token".into()),
        title: None,
        state,
        steps: 3,
        started_at: 10,
        last_output_at: 1,
        reached_finished: false,
        worktree: None,
        command_preview: String::new(),
        awaiting_decision: false,
        busy: false,
        rev: 1,
        spot: Some(Tile { x: 7, y: 8 }),
        paused: false,
        subagents: vec![],
        state_since: since,
        last_message: None,
        asking: None,
        questions: vec![],
        parked: None,
    }
}

fn data() -> AppData {
    let mut d = AppData::default();
    d.workspaces = vec![ws("w1", "API", true), ws("w2", "Private notes", false)];
    d.builders = vec![builder("b1", "Wizard"), builder("b2", "Archer")];
    d.settings.player_name = Some("Ada".into());
    d
}

fn snap(sessions: &[SessionInfo]) -> Snapshot {
    build(&data(), "ada", "h1", sessions, &|id| Some(format!("msg_{id}")), 5_000)
}

#[test]
fn only_shared_workspaces_and_their_agent_sessions() {
    let mut term = session("t1", "w1", SessionState::Working, 1);
    term.kind = SessionKind::Terminal;
    let s = snap(&[session("s1", "w1", SessionState::Working, 1), session("s2", "w2", SessionState::Working, 1), term]);
    assert_eq!((s.v, s.host.as_str(), s.owner.as_str(), s.name.as_deref(), s.seen), (1, "h1", "ada", Some("Ada"), 5_000));
    assert_eq!(s.workspaces.len(), 1);
    let w = &s.workspaces[0];
    assert_eq!((w.slug.as_str(), w.name.as_str(), w.activity, w.level, w.color.as_deref()), ("api", "API", Some(1), 2, Some("#3d6fd6")));
    assert_eq!(w.compound, Some(Compound { x0: 4, y0: 5, w: 6, h: 7, house: Tile { x: 5, y: 6 } }));
    assert_eq!(s.sessions.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["s1"]);
    // only builders with a session shown
    assert_eq!(s.builders.iter().map(|b| (b.profile.as_str(), b.name.as_str(), b.agent.as_str())).collect::<Vec<_>>(), [("wizard", "Wizard", "claude")]);
}

#[test]
fn no_paths_notes_or_tasks() {
    let t = text(&snap(&[session("s1", "w1", SessionState::Working, 1)]));
    for secret in ["secret", "password", "rotate", "Private notes", "/Users"] {
        assert!(!t.contains(secret), "{secret} in {t}");
    }
}

#[test]
fn sessions_carry_state_wait_spot_and_root() {
    let mut decide = session("s1", "w1", SessionState::NeedsYou { reason: "permission".into() }, 77);
    decide.awaiting_decision = true;
    let s = snap(&[decide, session("s2", "w1", SessionState::Finished, 80)]);
    let a = &s.sessions[0];
    assert_eq!((a.root.as_deref(), a.workspace.as_str(), a.builder.as_str(), a.state.as_str(), a.wait.as_deref(), a.since, a.started, a.steps), (Some("msg_s1"), "api", "wizard", "needs_you", Some("decide"), 77, 10, 3));
    assert_eq!(a.spot, Some(Tile { x: 7, y: 8 }));
    assert_eq!((s.sessions[1].state.as_str(), s.sessions[1].wait.as_deref()), ("finished", Some("review")));
    assert_eq!(parse(&text(&s)).unwrap(), s);
}

#[test]
fn it_stays_under_the_boards_limit_dropping_the_oldest_finished_first() {
    let mut d = data();
    // ids and roots as long as the real ones (a uuid; a board message id)
    d.workspaces = (0..20).map(|n| ws(&format!("w{n}"), &format!("Workspace number {n}"), true)).collect();
    let mut sessions: Vec<SessionInfo> = (0..30).map(|n| session(&format!("0f8fad5b-d9cb-469f-a165-7086768{n:05}"), &format!("w{}", n % 20), SessionState::Working, 1_795_000_000_000 + n)).collect();
    let fits = build(&d, "ada", "h1", &sessions, &|_| Some("msg_a7a22612-92ec-406b-90f2-2dd0c20e46a4_1".to_string()), 1);
    let t = text(&fits);
    assert!(t.chars().count() <= 10_000, "{}", t.chars().count());
    assert_eq!(parse(&t).unwrap().sessions.len(), 30, "20 workspaces and 30 sessions fit whole");
    // far too many: the finished go first, oldest first, and what waits stays
    sessions.extend((0..200).map(|n| session(&format!("old-finished-{n:04}"), "w1", SessionState::Finished, n)));
    sessions.push(session("waiting", "w1", SessionState::NeedsYou { reason: "x".into() }, 5));
    let cut = parse(&text(&build(&d, "ada", "h1", &sessions, &|_| None, 1))).unwrap();
    assert!(text(&cut).chars().count() <= 10_000);
    assert!(cut.sessions.iter().any(|s| s.id == "waiting"));
    assert!(cut.sessions.iter().filter(|s| s.state == "working").count() == 30);
    let kept: Vec<i64> = cut.sessions.iter().filter(|s| s.state == "finished").map(|s| s.since).collect();
    assert!(kept.len() < 200 && kept.iter().all(|since| *since >= 200 - kept.len() as i64), "the newest finished are the ones kept: {kept:?}");
}

#[test]
fn parse_refuses_other_versions_and_garbage() {
    assert!(parse("").is_none());
    assert!(parse("hello").is_none());
    assert!(parse(r#"{"v":2,"host":"h","owner":"ada","seen":1,"workspaces":[],"builders":[],"sessions":[],"mates":[]}"#).is_none());
    assert!(parse(r#"{"v":1,"host":"h","owner":"ada","seen":1,"workspaces":[],"builders":[],"sessions":[],"mates":[]}"#).is_some());
}

#[test]
fn same_but_seen_ignores_only_the_heartbeat() {
    let a = snap(&[session("s1", "w1", SessionState::Working, 1)]);
    let mut b = a.clone();
    b.seen += 60_000;
    assert!(same_but_seen(&a, &b));
    b.sessions[0].state = "finished".into();
    assert!(!same_but_seen(&a, &b));
}

#[test]
fn a_map_without_activity_still_parses() {
    let w: MapWorkspace = serde_json::from_str(r#"{"s":"api","n":"API","l":6}"#).unwrap();
    assert_eq!((w.activity, w.level), (None, 6));
}

#[test]
fn an_older_apps_map_reaches_the_visitor_without_a_made_up_activity() {
    // `visit` hands the frontend the parsed map re-serialized: a missing "a" must stay missing,
    // so the visitor falls back to "l" (an absent stage is not Quiet)
    let old = r#"{"v":1,"host":"h","owner":"ada","seen":1,"workspaces":[{"s":"api","n":"API","l":6}],"builders":[],"sessions":[]}"#;
    let v = serde_json::to_value(parse(old).unwrap()).unwrap();
    assert!(v["workspaces"][0].get("a").is_none(), "got {v}");
    assert_eq!(v["workspaces"][0]["l"], 6);
}

#[test]
fn the_map_names_what_is_lent_and_marks_borrowed_sessions() {
    let mut s = snap(&[session("s1", "w1", SessionState::Finished, 5), session("s2", "w1", SessionState::Finished, 9)]);
    s.lend = vec![MapLend { profile: "wizard".into(), name: "Wizard".into(), workspaces: Some(vec!["api".into()]), keys: None }];
    s.sessions[0].by = Some("k_bob".into());
    let back = parse(&text(&s)).unwrap();
    assert_eq!(back, s);
    assert!(text(&s).contains(r#""lend":[{"b":"wizard","n":"Wizard","w":["api"]}]"#), "{}", text(&s));
    // an old map without the new fields still reads
    let old = parse(r#"{"v":1,"host":"h","owner":"ada","seen":1,"workspaces":[],"builders":[],"sessions":[{"i":"s","w":"api","b":"wizard","s":"working","n":1,"a":1,"k":0}]}"#).unwrap();
    assert!(old.lend.is_empty() && old.sessions[0].by.is_none());
}

#[test]
fn a_borrowed_session_is_the_last_to_be_dropped() {
    let mut d = data();
    d.workspaces = vec![ws("w1", "API", true)];
    let mut sessions: Vec<SessionInfo> = (0..400).map(|n| session(&format!("0f8fad5b-d9cb-469f-a165-7086768{n:05}"), "w1", SessionState::Finished, 1_000 + n)).collect();
    sessions.push(session("the-borrowed-one", "w1", SessionState::Finished, 1));
    let mut s = build(&d, "ada", "h1", &sessions, &|_| None, 1);
    s.sessions.iter_mut().find(|x| x.id == "the-borrowed-one").unwrap().by = Some("k_bob".into());
    let cut = parse(&text(&s)).unwrap();
    assert!(cut.sessions.len() < 401);
    assert!(cut.sessions.iter().any(|x| x.id == "the-borrowed-one"), "the oldest finished, and still there: its borrower needs it to press Done");
}
