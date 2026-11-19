use super::*;
use crate::model::{AskOption, AskQuestion, SessionKind};
use std::path::PathBuf;

fn info(state: SessionState) -> SessionInfo {
    SessionInfo {
        id: "s1".into(),
        workspace_id: "w1".into(),
        kind: SessionKind::Agent { builder_id: "b1".into() },
        task: Some("add a CSV export".into()),
        title: None,
        state,
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
        state_since: 100,
        last_message: None,
        asking: None,
        questions: vec![],
        parked: None,
    }
}

fn ctx<'a>(files: &'a [String], details: bool) -> Ctx<'a> {
    Ctx { builder: "Wizard", agent: AgentKind::Claude, channel: "v/ada/w/api", board: "acme/village", host_id: "h1", share_details: details, files }
}

fn needs(reason: &str) -> SessionState {
    SessionState::NeedsYou { reason: reason.into() }
}

fn decide(since: i64) -> SessionInfo {
    let mut i = info(needs("permission"));
    i.awaiting_decision = true;
    i.asking = Some("Bash: npm test".into());
    i.state_since = since;
    i
}

/// The record after `info` was published for the first time, with its root posted as `msg_1`.
fn published(i: &SessionInfo) -> Published {
    let (_, mut p) = plan("s1", None, Now::Live(i), &ctx(&[], true));
    p.root = Some("msg_1".into());
    p
}

fn label<'a>(set: &'a [(String, String)], k: &str) -> Option<&'a str> {
    set.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str())
}

fn ws(id: &str, name: &str) -> Workspace {
    Workspace { id: id.into(), name: name.into(), path: PathBuf::from("/nope"), created_at: 0, missing: false, level: 1, xp: 0, compound: None, color: None, notes: String::new(), board_shared: true }
}

fn valid_profile(p: &str) -> bool {
    let mut c = p.chars();
    c.next().is_some_and(|f| f.is_ascii_lowercase()) && p.len() <= 32 && c.all(|x| x.is_ascii_lowercase() || x.is_ascii_digit() || x == '-')
}

#[test]
fn slug_and_profile_names() {
    assert_eq!(slug("My  Projéct!"), "my-proj-ct");
    assert_eq!(slug("  "), "x");
    assert_eq!(profile_name("Wizard"), "wizard");
    assert_eq!(profile_name(""), "builder-x");
    assert_eq!(profile_name("🧙"), "builder-x");
    assert_eq!(profile_name("9 Lives"), "builder-9-lives");
    assert_eq!(profile_name(&"a".repeat(60)).len(), 32);
    for n in ["Wizard", "", "🧙", "9 Lives", &"a".repeat(60), &"é".repeat(60), "---", "Sir Lancelot-du-Lac the Third of Camelot"] {
        assert!(valid_profile(&profile_name(n)), "{n:?} -> {:?}", profile_name(n));
    }
}

#[test]
fn workspace_slugs_separate_clashes() {
    let m = workspace_slugs(&[ws("aaaaaa11-1", "API"), ws("bbbbbb22-2", "api"), ws("c", "site")]);
    assert_ne!(m["aaaaaa11-1"], m["bbbbbb22-2"]);
    assert!(m["aaaaaa11-1"].starts_with("api") && m["bbbbbb22-2"].starts_with("api"));
    assert_eq!(m["c"], "site");
    assert_eq!(channel("ada", "site"), "v/ada/w/site");
}

#[test]
fn cut_respects_char_boundaries() {
    let long = "é".repeat(10_050);
    let c = cut(&long);
    assert_eq!(c.chars().count(), MAX_TEXT);
    assert!(c.ends_with("… (cut)"));
    assert_eq!(cut("short text"), "short text");
    assert_eq!(cut(&"🙂".repeat(MAX_TEXT)).chars().count(), MAX_TEXT);
}

#[test]
fn first_sight_posts_a_root_with_all_labels() {
    let i = info(SessionState::Working);
    let (w, p) = plan("s1", None, Now::Live(&i), &ctx(&[], true));
    assert_eq!(w.len(), 1);
    let Write::PostRoot { channel, text, labels, key } = &w[0] else { panic!("{w:?}") };
    assert_eq!(channel, "v/ada/w/api");
    assert_eq!(text, "**Wizard** (Claude Code): add a CSV export");
    assert_eq!(key, "coc-s1-root");
    for (k, v) in [("coc.kind", "session"), ("coc.state", "working"), ("coc.agent", "claude"), ("coc.builder", "wizard"), ("coc.host", "h1"), ("coc.session", "s1"), ("coc.since", "100")] {
        assert_eq!(label(labels, k), Some(v), "{k}");
    }
    assert_eq!(label(labels, "coc.wait"), None);
    assert_eq!(p, Published { board: "acme/village".into(), channel: "v/ada/w/api".into(), root: None, state: Wire::Working, wait: None, since: 100, titled: false, unshared: false });
}

#[test]
fn a_session_first_seen_waiting_posts_its_root_and_its_question() {
    let i = decide(100);
    let (w, _) = plan("s1", None, Now::Live(&i), &ctx(&[], true));
    assert!(matches!(&w[0], Write::PostRoot { labels, .. } if label(labels, "coc.wait") == Some("decide")));
    assert!(matches!(&w[1], Write::Reply { text, .. } if text == "Wants a decision: `Bash: npm test`"));
    assert_eq!(w.len(), 2);
}

#[test]
fn no_task_says_so() {
    let mut i = info(SessionState::Working);
    i.task = None;
    let (w, _) = plan("s1", None, Now::Live(&i), &ctx(&[], true));
    assert!(matches!(&w[0], Write::PostRoot { text, .. } if text == "**Wizard** (Claude Code): No task given"));
}

#[test]
fn working_to_decide_labels_and_replies() {
    let prev = published(&info(SessionState::Working));
    let i = decide(250);
    let (w, p) = plan("s1", Some(&prev), Now::Live(&i), &ctx(&[], true));
    assert_eq!(w.len(), 2);
    let Write::Label { set, unset } = &w[0] else { panic!("{w:?}") };
    assert_eq!(label(set, "coc.state"), Some("needs_you"));
    assert_eq!(label(set, "coc.wait"), Some("decide"));
    assert_eq!(label(set, "coc.since"), Some("250"));
    assert!(unset.is_empty());
    let Write::Reply { text, labels, key } = &w[1] else { panic!("{w:?}") };
    assert_eq!(text, "Wants a decision: `Bash: npm test`");
    assert_eq!(key, "coc-s1-250-decide");
    assert_eq!(label(labels, "coc.since"), Some("250"));
    assert_eq!((p.state, p.wait, p.since, p.root.as_deref()), (Wire::NeedsYou, Some(Wait::Decide), 250, Some("msg_1")));
}

#[test]
fn questions_list_their_options_numbered() {
    let prev = published(&info(SessionState::Working));
    let mut i = info(needs("question"));
    i.state_since = 300;
    i.questions = vec![AskQuestion {
        question: "Which separator?".into(),
        header: None,
        options: vec![AskOption { label: "Comma".into(), description: None }, AskOption { label: "Semicolon".into(), description: Some("for Excel".into()) }],
        multi_select: false,
    }];
    let (w, _) = plan("s1", Some(&prev), Now::Live(&i), &ctx(&[], true));
    let Write::Reply { text, key, .. } = &w[1] else { panic!("{w:?}") };
    assert_eq!(text, "Asking you: Which separator?\n1. Comma\n2. Semicolon: for Excel");
    assert_eq!(key, "coc-s1-300-answer");

    // No picker: the reason the agent gave.
    let mut bare = info(needs("Waiting in the terminal"));
    bare.state_since = 301;
    let (w, _) = plan("s1", Some(&prev), Now::Live(&bare), &ctx(&[], true));
    assert!(matches!(&w[1], Write::Reply { text, .. } if text == "Asking you: Waiting in the terminal"));
}

#[test]
fn finished_lists_twenty_files_then_counts_the_rest() {
    let prev = published(&info(SessionState::Working));
    let mut i = info(SessionState::Finished);
    i.state_since = 400;
    i.last_message = Some("Export added.".into());
    let files: Vec<String> = (1..=25).map(|n| format!("f{n}.rs")).collect();
    let (w, p) = plan("s1", Some(&prev), Now::Live(&i), &ctx(&files, true));
    let Write::Reply { text, key, .. } = &w[1] else { panic!("{w:?}") };
    assert!(text.starts_with("Finished.\n\nExport added.\n\nChanged: f1.rs, f2.rs"), "{text}");
    assert!(text.ends_with("f20.rs and 5 more"), "{text}");
    assert!(!text.contains("f21.rs"));
    assert_eq!(key, "coc-s1-400-review");
    assert_eq!(p.wait, Some(Wait::Review));

    let (w, _) = plan("s1", Some(&prev), Now::Live(&i), &ctx(&[], true));
    assert!(matches!(&w[1], Write::Reply { text, .. } if text == "Finished.\n\nExport added."));
}

#[test]
fn stuck_gives_its_reason() {
    let prev = published(&info(SessionState::Working));
    let mut i = info(SessionState::Stuck { reason: "usage limit".into() });
    i.state_since = 500;
    let (w, _) = plan("s1", Some(&prev), Now::Live(&i), &ctx(&[], true));
    assert!(matches!(&w[1], Write::Reply { text, key, .. } if text == "Stuck: usage limit" && key == "coc-s1-500-stuck"));
}

#[test]
fn back_to_working_unsets_wait_and_does_not_reply() {
    let prev = published(&decide(250));
    let mut i = info(SessionState::Working);
    i.state_since = 600;
    let (w, p) = plan("s1", Some(&prev), Now::Live(&i), &ctx(&[], true));
    assert_eq!(w.len(), 1);
    let Write::Label { set, unset } = &w[0] else { panic!("{w:?}") };
    assert_eq!(label(set, "coc.state"), Some("working"));
    assert_eq!(unset, &vec!["coc.wait".to_string()]);
    assert_eq!(p.wait, None);
}

#[test]
fn no_change_no_writes() {
    let i = decide(250);
    let prev = published(&i);
    let (w, p) = plan("s1", Some(&prev), Now::Live(&i), &ctx(&[], true));
    assert!(w.is_empty(), "{w:?}");
    assert_eq!(p, prev);
}

#[test]
fn title_edits_the_root_once() {
    let mut i = info(SessionState::Working);
    let prev = published(&i);
    i.title = Some("CSV export".into());
    let (w, p) = plan("s1", Some(&prev), Now::Live(&i), &ctx(&[], true));
    assert_eq!(w, vec![Write::EditRoot { text: "**Wizard** (Claude Code): CSV export\n\nadd a CSV export".into() }]);
    assert!(p.titled);
    let (w, _) = plan("s1", Some(&p), Now::Live(&i), &ctx(&[], true));
    assert!(w.is_empty());
}

#[test]
fn without_details_nothing_of_the_task_appears() {
    let mut i = decide(250);
    i.title = Some("CSV export".into());
    i.last_message = Some("secret reply".into());
    let files = vec!["secret.rs".to_string()];
    let c = ctx(&files, false);
    let (first, p0) = plan("s1", None, Now::Live(&i), &c);
    let mut fin = info(SessionState::Finished);
    fin.state_since = 400;
    fin.last_message = Some("secret reply".into());
    let mut p0 = p0;
    p0.root = Some("msg_1".into());
    let (second, _) = plan("s1", Some(&p0), Now::Live(&fin), &c);
    let texts: Vec<String> = first
        .iter()
        .chain(second.iter())
        .filter_map(|w| match w {
            Write::PostRoot { text, .. } | Write::Reply { text, .. } | Write::EditRoot { text } => Some(text.clone()),
            Write::Label { .. } => None,
        })
        .collect();
    assert_eq!(texts, ["**Wizard** (Claude Code)", "Wants a decision", "Finished"]);
}

#[test]
fn closed_sets_outcome() {
    let prev = published(&decide(250));
    let (w, p) = plan("s1", Some(&prev), Now::Closed(Some(Outcome::Accepted)), &ctx(&[], true));
    assert_eq!(
        w,
        vec![Write::Label { set: vec![("coc.state".into(), "closed".into()), ("coc.outcome".into(), "accepted".into())], unset: vec!["coc.wait".into()] }]
    );
    assert_eq!((p.state, p.wait), (Wire::Closed, None));

    let (w, _) = plan("s1", Some(&published(&info(SessionState::Working))), Now::Closed(None), &ctx(&[], true));
    assert_eq!(w, vec![Write::Label { set: vec![("coc.state".into(), "closed".into())], unset: vec![] }]);

    // Never published: nothing to close.
    assert!(plan("s1", None, Now::Closed(None), &ctx(&[], true)).0.is_empty());
    // Already closed: nothing again.
    assert!(plan("s1", Some(&p), Now::Closed(None), &ctx(&[], true)).0.is_empty());
}

#[test]
fn paused_on_quit() {
    let prev = published(&info(SessionState::Working));
    let (w, p) = plan("s1", Some(&prev), Now::Paused, &ctx(&[], true));
    assert_eq!(w, vec![Write::Label { set: vec![("coc.state".into(), "paused".into())], unset: vec![] }]);
    assert_eq!(p.state, Wire::Paused);
    // A restored session reports itself ended and paused: the same thing, so nothing more.
    let mut restored = info(SessionState::Ended { exit_code: None });
    restored.paused = true;
    assert!(plan("s1", Some(&p), Now::Live(&restored), &ctx(&[], true)).0.is_empty());
    // One that ended on its own is stuck.
    let mut dead = info(SessionState::Ended { exit_code: Some(1) });
    dead.state_since = 700;
    let (w, _) = plan("s1", Some(&prev), Now::Live(&dead), &ctx(&[], true));
    assert!(matches!(&w[0], Write::Label { set, .. } if label(set, "coc.state") == Some("stuck")));
}

#[test]
fn resharing_reuses_the_root() {
    let i = decide(250);
    let mut prev = published(&i);
    prev.state = Wire::Closed;
    prev.wait = None;
    prev.unshared = true;
    let (w, p) = plan("s1", Some(&prev), Now::Live(&i), &ctx(&[], true));
    assert!(!w.iter().any(|x| matches!(x, Write::PostRoot { .. })), "{w:?}");
    let Write::Label { set, .. } = &w[0] else { panic!("{w:?}") };
    assert_eq!(label(set, "coc.state"), Some("needs_you"));
    assert_eq!(label(set, "coc.wait"), Some("decide"));
    assert_eq!(label(set, "coc.since"), Some("250"));
    assert!(!p.unshared);
    assert_eq!(p.root.as_deref(), Some("msg_1"));
}

#[test]
fn a_thread_keeps_its_channel_when_the_workspace_is_renamed() {
    let prev = published(&info(SessionState::Working));
    let mut c = ctx(&[], true);
    c.channel = "v/ada/w/renamed";
    let (_, p) = plan("s1", Some(&prev), Now::Live(&decide(250)), &c);
    assert_eq!(p.channel, "v/ada/w/api");
}

#[test]
fn long_replies_are_cut() {
    let prev = published(&info(SessionState::Working));
    let mut i = info(SessionState::Finished);
    i.state_since = 400;
    i.last_message = Some("é".repeat(20_000));
    let (w, _) = plan("s1", Some(&prev), Now::Live(&i), &ctx(&[], true));
    assert!(matches!(&w[1], Write::Reply { text, .. } if text.chars().count() == MAX_TEXT));
}
