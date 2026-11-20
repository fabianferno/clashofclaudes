use super::*;
use crate::board::cli::{CliError, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

// Shapes recorded from `vercel board tail --json` (CLI 66.4.0), trimmed of fields the app does not read.
const REPLY: &str = r#"{"cursor":"mwny0p5e.jcgvkiwr","type":"message.posted","createdAt":"2026-11-19T22:23:40.958Z","payload":{"channel":"v/ada/w/api","re":"msg_2f7d_1"},"message":{"id":"msg_2f7d_4","channel":"v/ada/w/api","text":"{\"v\":1}","re":"msg_2f7d_1","thread":"thr_2f7d","labels":{"coc.do":"allow"},"by":{"actor":"vercel:project:prj_K:production+remote","principal":"vercel:project:prj_K:production","profile":"remote"},"author":{"kind":"agent","handle":"remote","verified":true}},"actor":{"id":"vercel:project:prj_K:production+remote"}}"#;
const ROOT: &str = r#"{"cursor":"c2","type":"message.posted","payload":{},"message":{"id":"msg_9_1","channel":"v/ada/remote","text":"hi","re":null,"labels":{},"by":{"actor":"vercel:user:u1","principal":"vercel:user:u1","profile":null}}}"#;
const LABELS: &str = r#"{"cursor":"c3","type":"labels.changed","payload":{"id":"msg_2f7d_1","set":{"coc.state":"working"},"unset":[]},"message":{"id":"msg_2f7d_1","channel":"v/ada/w/api","text":"x","re":null,"labels":{"coc.state":"working"},"by":{"actor":"vercel:user:u1+village","principal":"vercel:user:u1","profile":"village"}}}"#;
const NO_MESSAGE: &str = r#"{"cursor":"c4","type":"channel.created","payload":{"channel":"v/ada/w/new"}}"#;

#[test]
fn parse_reads_a_posted_reply() {
    let e = parse(REPLY).unwrap();
    assert_eq!((e.cursor.as_str(), e.kind.as_str(), e.id.as_str()), ("mwny0p5e.jcgvkiwr", "message.posted", "msg_2f7d_4"));
    assert_eq!(e.thread_root.as_deref(), Some("msg_2f7d_1"));
    assert_eq!(e.channel, "v/ada/w/api");
    assert_eq!(e.text, r#"{"v":1}"#);
    assert_eq!(e.labels.get("coc.do").map(String::as_str), Some("allow"));
    assert_eq!((e.principal.as_str(), e.profile.as_deref(), e.person), ("vercel:project:prj_K:production", Some("remote"), false));
}

#[test]
fn parse_reads_roots_and_other_events() {
    let root = parse(ROOT).unwrap();
    assert_eq!((root.thread_root.as_deref(), root.profile.as_deref(), root.person), (Some("msg_9_1"), None, true));
    assert_eq!(parse(LABELS).unwrap().kind, "labels.changed");
    let bare = parse(NO_MESSAGE).unwrap();
    assert_eq!((bare.cursor.as_str(), bare.id.as_str(), bare.thread_root), ("c4", "", None));
}

#[test]
fn parse_skips_garbage() {
    assert!(parse("").is_none());
    assert!(parse("Vercel CLI 66.4.0").is_none());
    assert!(parse(r#"{"type":"message.posted"}"#).is_none(), "no cursor: nothing to continue from");
}

/// A `tail` that prints its script, then ends as told.
struct FakeTail {
    calls: Mutex<Vec<Vec<String>>>,
    lines: Vec<&'static str>,
    end: Result<(), CliError>,
}

impl FakeTail {
    fn new(lines: &[&'static str], end: Result<(), CliError>) -> FakeTail {
        FakeTail { calls: Mutex::default(), lines: lines.to_vec(), end }
    }
}

impl BoardCli for FakeTail {
    fn raw(&self, _: &[String]) -> Result<Output, CliError> {
        Err(CliError::Fatal("not used".into()))
    }
    fn stream(&self, args: &[String], on_line: &mut dyn FnMut(Option<&str>) -> bool, _idle: Duration) -> Result<(), CliError> {
        self.calls.lock().unwrap().push(args.to_vec());
        for l in &self.lines {
            if !on_line(Some(l)) {
                return Ok(());
            }
        }
        if !on_line(None) {
            return Ok(());
        }
        self.end.clone()
    }
}

fn target() -> Target {
    Target { team: Some("acme".into()), name: "village".into() }
}

fn on() -> Following {
    Following { target: target(), owner: "ada".into() }
}

fn run(cli: &FakeTail, dir: &std::path::Path, f: &Following, stop: &AtomicBool) -> (Ended, Vec<String>) {
    let got = Mutex::new(Vec::new());
    let ended = follow_once(cli, &dir.join("board-listen.json"), f, &|e| got.lock().unwrap().push(e.id), &|| stop.load(Ordering::SeqCst));
    (ended, got.into_inner().unwrap())
}

#[test]
fn tail_args_name_the_village_and_the_place_to_go_on_from() {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    assert_eq!(tail_args("ada", None, &target()), s(&["board", "tail", "v/ada/", "--json", "--name", "village", "--scope", "acme"]));
    assert_eq!(
        tail_args("ada", Some("c9"), &Target { team: None, name: "village".into() }),
        s(&["board", "tail", "v/ada/", "--after", "c9", "--json", "--name", "village"])
    );
}

#[test]
fn the_cursor_is_saved_and_used() {
    let dir = tempfile::tempdir().unwrap();
    let stop = AtomicBool::new(false);
    let cli = FakeTail::new(&[REPLY, "noise", ROOT], Ok(()));
    let (ended, got) = run(&cli, dir.path(), &on(), &stop);
    assert_eq!(got, ["msg_2f7d_4", "msg_9_1"]);
    assert_eq!(ended, Ended::Again { heard: true });
    assert!(!cli.calls.lock().unwrap()[0].contains(&"--after".to_string()), "the first time it starts at the newest event");
    let cli = FakeTail::new(&[], Ok(()));
    run(&cli, dir.path(), &on(), &stop);
    let args = cli.calls.lock().unwrap()[0].clone();
    let at = args.iter().position(|a| a == "--after").expect("--after");
    assert_eq!(args[at + 1], "c2");
}

#[test]
fn a_cursor_from_another_board_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let stop = AtomicBool::new(false);
    run(&FakeTail::new(&[REPLY], Ok(())), dir.path(), &on(), &stop);
    for other in [Following { target: Target { team: None, name: "village".into() }, owner: "ada".into() }, Following { target: target(), owner: "bob".into() }] {
        let cli = FakeTail::new(&[], Ok(()));
        run(&cli, dir.path(), &other, &stop);
        assert!(!cli.calls.lock().unwrap()[0].contains(&"--after".to_string()), "{other:?}");
    }
}

#[test]
fn silence_and_a_dead_child_are_tried_again_and_a_missing_login_is_not() {
    let dir = tempfile::tempdir().unwrap();
    let stop = AtomicBool::new(false);
    assert_eq!(run(&FakeTail::new(&[], Err(CliError::Retryable("silent".into()))), dir.path(), &on(), &stop).0, Ended::Again { heard: false });
    assert_eq!(run(&FakeTail::new(&[], Ok(())), dir.path(), &on(), &stop).0, Ended::Again { heard: false });
    assert_eq!(run(&FakeTail::new(&[], Err(CliError::SignedOut("x".into()))), dir.path(), &on(), &stop).0, Ended::Stopped(CliError::SignedOut("x".into())));
    assert_eq!(run(&FakeTail::new(&[], Err(CliError::Missing)), dir.path(), &on(), &stop).0, Ended::Stopped(CliError::Missing));
}

#[test]
fn turning_it_off_stops_at_once_and_handles_nothing_more() {
    let dir = tempfile::tempdir().unwrap();
    let stop = AtomicBool::new(true);
    let (ended, got) = run(&FakeTail::new(&[REPLY, ROOT], Ok(())), dir.path(), &on(), &stop);
    assert_eq!((ended, got.len()), (Ended::Off, 0));
}

#[test]
fn the_wait_before_another_try_doubles_to_five_minutes() {
    assert_eq!([0, 1, 2, 3, 20].map(retry_ms), [2_000, 4_000, 8_000, 16_000, 300_000]);
}

fn sh(script: &str) -> (VercelCli, Vec<String>) {
    let cli = VercelCli { program: Some("/bin/sh".into()), cwd: std::env::temp_dir(), timeout: Duration::from_secs(30) };
    (cli, vec!["-c".to_string(), script.to_string()])
}

#[test]
fn a_real_child_is_read_line_by_line_and_killed() {
    let (cli, args) = sh("echo a; echo b; sleep 30");
    let mut got = Vec::new();
    let started = std::time::Instant::now();
    let r = cli.stream(
        &args,
        &mut |l| {
            if let Some(l) = l {
                got.push(l.to_string());
            }
            got.len() < 2
        },
        Duration::from_secs(60),
    );
    assert_eq!((r, got), (Ok(()), vec!["a".to_string(), "b".to_string()]));
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
}

#[test]
fn a_silent_child_is_killed_after_the_idle_time() {
    let (cli, args) = sh("echo a; sleep 30");
    let started = std::time::Instant::now();
    let r = cli.stream(&args, &mut |_| true, Duration::from_millis(600));
    assert!(matches!(r, Err(CliError::Retryable(_))), "{r:?}");
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
}

#[test]
fn a_child_that_ends_is_reported_with_its_lines() {
    let (cli, args) = sh("echo a; echo b");
    let mut got = 0;
    let r = cli.stream(
        &args,
        &mut |l| {
            got += l.is_some() as usize;
            true
        },
        Duration::from_secs(60),
    );
    assert_eq!((r, got), (Ok(()), 2));
}
