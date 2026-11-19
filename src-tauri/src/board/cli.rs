//! The `vercel` CLI, as the app's only way to the board. Shapes of its answers were measured
//! against CLI 66.4.0 (see "Spike results" in the design).
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};


use serde::Serialize;
use serde_json::Value;

use super::{Write, STATUS_PROFILE};

/// After the child exits, how long its output may still arrive (a helper it left running can hold the pipe open).
const PIPE_GRACE: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq)]
pub enum CliError {
    /// No `vercel` on the PATH.
    Missing,
    /// The installed `vercel` has no `board` command.
    NoBoard,
    /// Not signed in: nothing works until the owner signs in and checks again.
    SignedOut(String),
    /// Worth trying again: the network, a timeout, or the board saying so.
    Retryable(String),
    /// This call can never succeed.
    Fatal(String),
}

/// What a finished `vercel` call printed.
#[derive(Debug, Clone, PartialEq)]
pub struct Output {
    /// It exited with 0.
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

pub trait BoardCli: Send + Sync {
    /// Runs `vercel <args>` to its end.
    fn raw(&self, args: &[String]) -> Result<Output, CliError>;

    /// Runs `vercel <args>` and reads its stdout as the board's JSON answer.
    fn run(&self, args: &[String]) -> Result<Value, CliError> {
        let out = self.raw(args)?;
        classify(out.ok, &out.stdout)
    }
}

/// The user's own `vercel`, with their login.
pub struct VercelCli {
    /// The binary; None looks `vercel` up on the PATH at each call, so a fresh install is found.
    pub program: Option<PathBuf>,
    /// Where it runs: never a workspace, whose `.vercel/project.json` would pick the team.
    pub cwd: PathBuf,
    /// A call still running after this long is killed.
    pub timeout: Duration,
}

impl BoardCli for VercelCli {
    fn raw(&self, args: &[String]) -> Result<Output, CliError> {
        let program = match &self.program {
            Some(p) => crate::platform::which(&p.to_string_lossy()),
            None => crate::platform::which("vercel"),
        }
        .ok_or(CliError::Missing)?;
        let mut child = Command::new(program)
            .args(args)
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| CliError::Retryable(e.to_string()))?;
        // Each pipe is read on its own thread into a shared buffer, so a chatty child never
        // blocks on a full pipe, and a helper the child left running (holding the pipe open)
        // cannot keep this call waiting once the child itself is done.
        let drain = |r: Option<Box<dyn Read + Send>>| {
            let buf = Arc::new(Mutex::new(Vec::new()));
            let into = buf.clone();
            let reader = r.map(|mut r| {
                std::thread::spawn(move || {
                    let mut chunk = [0u8; 8192];
                    while let Ok(n) = r.read(&mut chunk) {
                        if n == 0 {
                            break;
                        }
                        into.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&chunk[..n]);
                    }
                })
            });
            (buf, reader)
        };
        let (out, out_reader) = drain(child.stdout.take().map(|r| Box::new(r) as Box<dyn Read + Send>));
        let (err, err_reader) = drain(child.stderr.take().map(|r| Box::new(r) as Box<dyn Read + Send>));
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() >= self.timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CliError::Retryable("timed out".into()));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => return Err(CliError::Retryable(e.to_string())),
            }
        };
        let exited = Instant::now();
        let reading = |h: &Option<std::thread::JoinHandle<()>>| h.as_ref().is_some_and(|h| !h.is_finished());
        while (reading(&out_reader) || reading(&err_reader)) && exited.elapsed() < PIPE_GRACE {
            std::thread::sleep(Duration::from_millis(10));
        }
        let read = |b: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&b.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
        Ok(Output { ok: status.success(), stdout: read(&out), stderr: read(&err) })
    }
}

/// Which of the team's boards the app writes to.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    /// The team's slug; None is the login's default team.
    pub team: Option<String>,
    pub name: String,
}

impl Target {
    /// "<team or empty>/<board name>", as `Published::board` records it.
    pub fn key(&self) -> String {
        format!("{}/{}", self.team.as_deref().unwrap_or(""), self.name)
    }

    fn tail(&self, args: &mut Vec<String>) {
        args.extend(["--json".to_string(), "--name".to_string(), self.name.clone()]);
        if let Some(team) = &self.team {
            args.extend(["--scope".to_string(), team.clone()]);
        }
    }
}

/// The `vercel` arguments for one write. `root` is the session's root message, for all but a `PostRoot`.
pub fn args_for(w: &Write, root: Option<&str>, t: &Target) -> Vec<String> {
    let root = root.unwrap_or_default().to_string();
    let mut a: Vec<String> = vec!["board".into()];
    let labels = |a: &mut Vec<String>, labels: &[(String, String)]| {
        for (k, v) in labels {
            a.extend(["--label".to_string(), format!("{k}={v}")]);
        }
    };
    match w {
        Write::PostRoot { channel, text, labels: l, key } => {
            a.extend(["post".to_string(), channel.clone(), text.clone()]);
            labels(&mut a, l);
            a.extend(["--idempotency-key".to_string(), key.clone(), "--ensure".to_string()]);
        }
        Write::Reply { text, labels: l, key } => {
            a.extend(["reply".to_string(), root, text.clone()]);
            labels(&mut a, l);
            a.extend(["--idempotency-key".to_string(), key.clone()]);
        }
        Write::Label { set, unset } => {
            a.extend(["label".to_string(), root]);
            a.extend(set.iter().map(|(k, v)| format!("{k}={v}")));
            for k in unset {
                a.extend(["--unset".to_string(), k.clone()]);
            }
        }
        Write::EditRoot { text } => a.extend(["edit".to_string(), root, text.clone()]),
    }
    a.extend(["--as".to_string(), STATUS_PROFILE.to_string()]);
    t.tail(&mut a);
    a
}

/// Reads a call's stdout: the board's answer, or why it failed.
pub fn classify(exit_ok: bool, stdout: &str) -> Result<Value, CliError> {
    let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) else {
        let first = stdout.lines().find(|l| !l.trim().is_empty()).unwrap_or("no answer");
        return Err(CliError::Retryable(first.chars().take(200).collect()));
    };
    if exit_ok && v["status"] != "error" {
        return Ok(v);
    }
    let message = v["message"].as_str().unwrap_or("The board refused").to_string();
    let reason = v["reason"].as_str().unwrap_or_default();
    if v["retryable"] == true {
        Err(CliError::Retryable(message))
    } else if v["data"]["error"]["status"] == 401 || ["auth", "login", "credential", "token"].iter().any(|w| reason.contains(w)) {
        Err(CliError::SignedOut(message))
    } else {
        Err(CliError::Fatal(message))
    }
}

/// The id of the message a `post` or `reply` answered with.
pub fn message_id(v: &Value) -> Option<String> {
    v["message"]["id"].as_str().map(str::to_string)
}

/// What Settings › Team shows about the connection.
#[derive(Clone, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BoardStatus {
    /// "off" | "noCli" | "oldCli" | "signedOut" | "ready" | "error"
    pub state: String,
    /// The owner's Vercel username: the `<owner>` of their channels.
    pub handle: Option<String>,
    /// The board's URL, for sessions' `BOARD_URL`.
    pub board_url: Option<String>,
    /// The login's team slugs; empty when they could not be listed.
    pub teams: Vec<String>,
    pub last_error: Option<String>,
    pub last_write_at: Option<i64>,
}

/// The first column of each row of `vercel teams ls`: the team slugs.
fn team_slugs(table: &str) -> Vec<String> {
    table
        .lines()
        .skip_while(|l| !l.trim_start().starts_with("id "))
        .skip(1)
        .filter_map(|l| l.split_whitespace().next())
        .filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .map(str::to_string)
        .collect()
}

/// Asks the CLI who the owner is and whether the board can be reached.
pub fn status(cli: &dyn BoardCli, t: &Target) -> BoardStatus {
    let state = |s: &str, e: Option<String>| BoardStatus { state: s.into(), last_error: e, ..Default::default() };
    let of = |e: CliError| match e {
        CliError::Missing => state("noCli", None),
        CliError::NoBoard => state("oldCli", None),
        CliError::SignedOut(m) => state("signedOut", Some(m)),
        CliError::Retryable(m) | CliError::Fatal(m) => state("error", Some(m)),
    };
    match cli.raw(&["board".to_string(), "--help".to_string()]) {
        Err(e) => return of(e),
        // An older CLI takes `board` for a folder to deploy and prints the deploy help.
        Ok(o) if !format!("{}{}", o.stdout, o.stderr).contains("vercel board") => return of(CliError::NoBoard),
        Ok(_) => {}
    }
    let mut args = vec!["board".to_string(), "whoami".to_string(), "--ensure".to_string()];
    t.tail(&mut args);
    let who = match cli.run(&args) {
        Ok(v) => v,
        Err(e) => return of(e),
    };
    let teams = cli.raw(&["teams".to_string(), "ls".to_string()]).map(|o| team_slugs(&format!("{}\n{}", o.stdout, o.stderr))).unwrap_or_default();
    BoardStatus {
        state: "ready".into(),
        handle: who["handle"].as_str().map(str::to_string),
        board_url: who["board"].as_str().map(str::to_string),
        teams,
        last_error: None,
        last_write_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Instant;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    const POSTED: &str = r#"{"message":{"id":"msg_77ae_1","channel":"v/fabianferno/w/spike","text":"x","re":null,"thread":"thr_77ae","labels":{"coc.kind":"session"},"by":{"actor":"vercel:user:u+village","principal":"vercel:user:u","profile":"village"}},"outcome":"posted"}"#;
    const NOT_OWNED: &str = r#"{"hint":"Check that the selected team is correct.","retryable":false,"userActionRequired":true,"scope":"acme","status":"error","reason":"permission_denied","message":"You can't edit #msg_77ae_1.","data":{"error":{"code":"message_not_owned","status":403}}}"#;
    const NOT_SUPPORTED: &str = r#"{"status":"error","reason":"not_supported","message":"Can't read v/. This board doesn't support it.","data":{"error":{"code":"not_supported","message":"not yet","status":501}},"cliVersion":"66.4.0"}"#;

    #[test]
    fn args_for_each_write() {
        let team = Target { team: Some("acme".into()), name: "village".into() };
        let none = Target { team: None, name: "village".into() };
        let post = Write::PostRoot { channel: "v/ada/w/api".into(), text: "hello".into(), labels: vec![("coc.kind".into(), "session".into()), ("coc.state".into(), "working".into())], key: "coc-s1-root".into() };
        assert_eq!(
            args_for(&post, None, &team),
            s(&["board", "post", "v/ada/w/api", "hello", "--label", "coc.kind=session", "--label", "coc.state=working", "--idempotency-key", "coc-s1-root", "--ensure", "--as", "village", "--json", "--name", "village", "--scope", "acme"])
        );
        let reply = Write::Reply { text: "Stuck: x".into(), labels: vec![("coc.since".into(), "5".into())], key: "coc-s1-5-stuck".into() };
        assert_eq!(
            args_for(&reply, Some("msg_1"), &none),
            s(&["board", "reply", "msg_1", "Stuck: x", "--label", "coc.since=5", "--idempotency-key", "coc-s1-5-stuck", "--as", "village", "--json", "--name", "village"])
        );
        let label = Write::Label { set: vec![("coc.state".into(), "working".into())], unset: vec!["coc.wait".into()] };
        assert_eq!(args_for(&label, Some("msg_1"), &none), s(&["board", "label", "msg_1", "coc.state=working", "--unset", "coc.wait", "--as", "village", "--json", "--name", "village"]));
        let edit = Write::EditRoot { text: "new".into() };
        assert_eq!(args_for(&edit, Some("msg_1"), &team), s(&["board", "edit", "msg_1", "new", "--as", "village", "--json", "--name", "village", "--scope", "acme"]));
    }

    #[test]
    fn classify_success_and_the_measured_errors() {
        assert_eq!(classify(true, POSTED).unwrap()["outcome"], json!("posted"));
        assert_eq!(classify(false, NOT_OWNED), Err(CliError::Fatal("You can't edit #msg_77ae_1.".into())));
        assert_eq!(classify(false, NOT_SUPPORTED), Err(CliError::Fatal("Can't read v/. This board doesn't support it.".into())));
        assert_eq!(classify(false, r#"{"status":"error","reason":"x","message":"m","retryable":true}"#), Err(CliError::Retryable("m".into())));
        assert_eq!(classify(false, r#"{"status":"error","reason":"not_authenticated","message":"m"}"#), Err(CliError::SignedOut("m".into())));
        assert_eq!(classify(false, r#"{"status":"error","reason":"x","message":"m","data":{"error":{"status":401}}}"#), Err(CliError::SignedOut("m".into())));
        assert!(matches!(classify(false, "<html>"), Err(CliError::Retryable(_))));
        assert!(matches!(classify(true, ""), Err(CliError::Retryable(_))));
        // An error document wins over a zero exit code.
        assert!(matches!(classify(true, NOT_OWNED), Err(CliError::Fatal(_))));
    }

    #[test]
    fn message_id_reads_the_post_shape() {
        let v = classify(true, POSTED).unwrap();
        assert_eq!(message_id(&v).as_deref(), Some("msg_77ae_1"));
        assert_eq!(message_id(&json!({"outcome":"labeled"})), None);
    }

    #[test]
    fn a_hanging_child_is_killed_at_the_timeout() {
        let cli = VercelCli { program: Some("/bin/sleep".into()), cwd: std::env::temp_dir(), timeout: Duration::from_millis(300) };
        let t = Instant::now();
        assert_eq!(cli.run(&s(&["5"])), Err(CliError::Retryable("timed out".into())));
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    }

    #[test]
    fn a_missing_program_is_missing() {
        let cli = VercelCli { program: Some("/nope/vercel".into()), cwd: std::env::temp_dir(), timeout: Duration::from_secs(1) };
        assert_eq!(cli.run(&s(&["board"])), Err(CliError::Missing));
    }

    #[test]
    fn a_real_child_gives_its_stdout_only() {
        let cli = VercelCli { program: Some("/bin/sh".into()), cwd: std::env::temp_dir(), timeout: Duration::from_secs(5) };
        let out = cli.raw(&s(&["-c", "echo '<hint/>' >&2; echo '{\"outcome\":\"posted\"}'"])).unwrap();
        assert!(out.ok);
        assert_eq!(out.stdout.trim(), r#"{"outcome":"posted"}"#);
        assert!(out.stderr.contains("<hint/>"));
    }

    #[test]
    fn a_helper_left_holding_the_pipe_does_not_hang_the_call() {
        // like a CLI that leaves an update check running behind it
        let cli = VercelCli { program: Some("/bin/sh".into()), cwd: std::env::temp_dir(), timeout: Duration::from_secs(20) };
        let t = Instant::now();
        let out = cli.raw(&s(&["-c", "echo '{\"outcome\":\"posted\"}'; sleep 8 &"])).unwrap();
        assert!(t.elapsed() < Duration::from_secs(4), "{:?}", t.elapsed());
        assert_eq!(out.stdout.trim(), r#"{"outcome":"posted"}"#);
    }

    /// Answers by the first words of the command.
    struct Fake(Vec<(&'static str, Result<Output, CliError>)>);
    impl BoardCli for Fake {
        fn raw(&self, args: &[String]) -> Result<Output, CliError> {
            let line = args.join(" ");
            self.0.iter().find(|(k, _)| line.starts_with(k)).map(|(_, r)| r.clone()).unwrap_or(Err(CliError::Fatal(format!("unexpected: {line}"))))
        }
    }
    fn out(ok: bool, stdout: &str) -> Result<Output, CliError> {
        Ok(Output { ok, stdout: stdout.into(), stderr: String::new() })
    }
    const HELP: &str = "Vercel CLI 66.4.0\n\n  ▲ vercel board [subcommand]\n\n  Read and write your team's Board";
    const OLD_HELP: &str = "Vercel CLI 50.18.2\n\n  ▲ vercel deploy [project-path] [options]";
    const WHOAMI: &str = r#"{"actor":"vercel:user:u","handle":"ada","profile":null,"board":"https://api.vercel.com/v1/messageboard/boards/brd_1?teamId=team_1"}"#;
    const TEAMS: &str = "Vercel CLI 66.4.0\n\nid                 Team name                      Plan     \nacme               Acme Inc                       pro      \nada-personal       Ada's Projects                 hobby    \n";

    #[test]
    fn status_tells_the_states_apart() {
        let t = Target { team: None, name: "village".into() };
        let ready = status(&Fake(vec![("board --help", out(true, HELP)), ("board whoami", out(true, WHOAMI)), ("teams ls", out(true, TEAMS))]), &t);
        assert_eq!(ready.state, "ready");
        assert_eq!(ready.handle.as_deref(), Some("ada"));
        assert_eq!(ready.board_url.as_deref(), Some("https://api.vercel.com/v1/messageboard/boards/brd_1?teamId=team_1"));
        assert_eq!(ready.teams, ["acme", "ada-personal"]);

        assert_eq!(status(&Fake(vec![("board --help", Err(CliError::Missing))]), &t).state, "noCli");
        assert_eq!(status(&Fake(vec![("board --help", out(true, OLD_HELP))]), &t).state, "oldCli");
        let signed_out = status(&Fake(vec![("board --help", out(true, HELP)), ("board whoami", out(false, r#"{"status":"error","reason":"not_authenticated","message":"Run vercel login."}"#))]), &t);
        assert_eq!(signed_out.state, "signedOut");
        let broken = status(&Fake(vec![("board --help", out(true, HELP)), ("board whoami", out(false, NOT_SUPPORTED))]), &t);
        assert_eq!((broken.state.as_str(), broken.last_error.as_deref()), ("error", Some("Can't read v/. This board doesn't support it.")));
        // No team list is not a failure.
        let no_teams = status(&Fake(vec![("board --help", out(true, HELP)), ("board whoami", out(true, WHOAMI)), ("teams ls", out(false, "boom"))]), &t);
        assert_eq!((no_teams.state.as_str(), no_teams.teams.len()), ("ready", 0));
    }

    #[test]
    fn whoami_names_the_board_and_team() {
        struct Rec(std::sync::Mutex<Vec<String>>);
        impl BoardCli for Rec {
            fn raw(&self, args: &[String]) -> Result<Output, CliError> {
                self.0.lock().unwrap().push(args.join(" "));
                out(true, if args[1] == "--help" { HELP } else { WHOAMI })
            }
        }
        let rec = Rec(Default::default());
        status(&rec, &Target { team: Some("acme".into()), name: "ops".into() });
        assert!(rec.0.lock().unwrap().contains(&"board whoami --ensure --json --name ops --scope acme".to_string()));
    }
}
