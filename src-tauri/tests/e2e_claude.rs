//! End-to-end tests below the UI: real HookServer, real SessionManager, real adapters.
use clash_of_claudes_lib::adapters::AdapterRegistry;
use clash_of_claudes_lib::git;
use clash_of_claudes_lib::hooks::HookServer;
use clash_of_claudes_lib::model::{AgentKind, Builder, SessionState, Workspace};
use clash_of_claudes_lib::sessions::{ManagerEvent, SessionManager};
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

struct Rig {
    mgr: Arc<SessionManager>,
    events: Arc<Mutex<Vec<ManagerEvent>>>,
    data: tempfile::TempDir,
    _repo: tempfile::TempDir,
    ws: Workspace,
}

async fn rig() -> Rig {
    let cell: Arc<OnceLock<Weak<SessionManager>>> = Arc::default();
    let c = cell.clone();
    let hooks = HookServer::start(Arc::new(move |id, body| {
        if let Some(m) = c.get().and_then(Weak::upgrade) {
            m.on_hook(&id, body);
        }
    }))
    .await
    .unwrap();
    let events: Arc<Mutex<Vec<ManagerEvent>>> = Arc::default();
    let ev = events.clone();
    let data = tempfile::tempdir().unwrap();
    let mgr = SessionManager::new(
        AdapterRegistry::new(),
        Arc::new(hooks),
        data.path().to_path_buf(),
        Arc::new(move |e| ev.lock().unwrap().push(e)),
    );
    let _ = cell.set(Arc::downgrade(&mgr));
    let repo = tempfile::tempdir().unwrap();
    // Canonicalize: macOS temp dirs live behind the /var -> /private/var symlink.
    let path = repo.path().canonicalize().unwrap();
    git::init_repo(&path).unwrap();
    let g = |args: &[&str]| {
        assert!(Command::new("git").arg("-C").arg(&path).args(args).status().unwrap().success());
    };
    std::fs::write(path.join("README.md"), "seed\n").unwrap();
    g(&["add", "-A"]);
    g(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"]);
    let ws = Workspace { id: "w1".into(), name: "e2e".into(), path, created_at: 0, missing: false };
    Rig { mgr, events, data, _repo: repo, ws }
}

impl Drop for Rig {
    /// Best-effort: never leave a real `claude` behind, even when an assert panics.
    fn drop(&mut self) {
        for s in self.mgr.list() {
            let _ = self.mgr.close(&s.id);
        }
    }
}

/// Terminal text with ANSI escapes removed and everything but letters/digits dropped, so matching
/// survives cursor-move sequences that replace spaces.
fn plain(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut chars = String::from_utf8_lossy(bytes).chars().collect::<Vec<_>>().into_iter().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    for n in chars.by_ref() {
                        if n == '\x07' || n == '\\' {
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if c.is_alphanumeric() {
            out.push(c);
        }
    }
    out
}

fn builder(agent: AgentKind, cmd: Option<&str>) -> Builder {
    Builder {
        id: "b1".into(),
        name: "Ada".into(),
        agent,
        model: Some("haiku".into()),
        effort: Some("low".into()),
        custom_command: cmd.map(String::from),
    }
}

fn wait_for(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("timed out after {secs}s waiting for: {what}");
}

/// Like `wait_for`, but on timeout closes the session (no leaked `claude`) and shows its tail output.
fn wait_session(r: &Rig, id: &str, what: &str, secs: u64, f: impl FnMut() -> bool) {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| wait_for(what, secs, f)));
    if let Err(e) = res {
        let out = r.mgr.attach(id).map(|(b, _)| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        let tail: String = out.chars().rev().take(3000).collect::<Vec<_>>().into_iter().rev().collect();
        eprintln!("state: {:?}\n--- terminal tail ---\n{tail}", r.mgr.list().first().map(|s| s.state.clone()));
        let _ = r.mgr.close(id);
        std::panic::resume_unwind(e);
    }
}

fn state(r: &Rig, id: &str) -> SessionState {
    r.mgr.list().into_iter().find(|s| s.id == id).map(|s| s.state).expect("session listed")
}

fn claude_procs(session_id: &str) -> usize {
    let out = Command::new("pgrep").args(["-f", session_id]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.trim().is_empty()).count()
}

#[tokio::test(flavor = "multi_thread")]
async fn custom_builder_exit_3_goes_stuck_with_output_retained() {
    let r = rig().await;
    let s = r.mgr.start_agent(&r.ws, &builder(AgentKind::Custom, Some("printf partial; exit 3")), None).unwrap();
    wait_for("Stuck exited with code 3", 15, || state(&r, &s.id) == SessionState::Stuck { reason: "exited with code 3".into() });
    assert!(String::from_utf8_lossy(&r.mgr.attach(&s.id).unwrap().0).contains("partial"));
    assert!(!r.mgr.close(&s.id).unwrap().earned_xp);
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_workspace_start_errors() {
    let r = rig().await;
    let mut ws = r.ws.clone();
    ws.path = Path::new("/definitely/not/here").to_path_buf();
    ws.missing = true;
    let err = r.mgr.start_agent(&ws, &builder(AgentKind::Custom, Some("true")), None).unwrap_err();
    assert!(!err.to_string().is_empty());
    assert!(r.mgr.start_terminal(&ws).is_err());
    assert!(r.mgr.list().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs claude CLI + login + network; run with --ignored"]
async fn real_claude_full_lifecycle() {
    let r = rig().await;
    // Force a Bash permission prompt using a project-level settings file in the TEMP repo only.
    let cdir = r.ws.path.join(".claude");
    std::fs::create_dir_all(&cdir).unwrap();
    std::fs::write(cdir.join("settings.json"), r#"{"permissions":{"ask":["Bash"]}}"#).unwrap();

    let task = "Using the Bash tool, run: echo hi > hello2.txt . Then reply done.";
    let s = r.mgr.start_agent(&r.ws, &builder(AgentKind::Claude, None), Some(task)).unwrap();
    let id = s.id.clone();
    let session_dir = r.data.path().join("sessions").join(&id);
    assert!(session_dir.exists());

    // 1. Working. The trust step is optional: a never-trusted folder shows Claude's first-run
    //    trust menu (hooks stay silent until it is answered); a trusted one goes straight on.
    //    Race: trust menu text vs hook-driven progress (NeedsYou/Finished or a counted tool use).
    let hook_progress = || {
        r.mgr.list().iter().any(|s| {
            s.id == id && (matches!(s.state, SessionState::NeedsYou { .. } | SessionState::Finished) || s.steps > 0)
        })
    };
    let menu_shown = || plain(&r.mgr.attach(&id).unwrap().0).contains("YesItrustthisfolder");
    let mut trust_menu_seen = false;
    wait_session(&r, &id, "trust menu or hook progress", 90, || {
        trust_menu_seen = menu_shown();
        trust_menu_seen || hook_progress()
    });
    if trust_menu_seen && !hook_progress() {
        // Default selection is "No, exit": Down moves to "Yes, I trust this folder", Enter accepts.
        std::thread::sleep(Duration::from_secs(1)); // let the menu finish drawing and start reading keys
        for attempt in 1..=2 {
            r.mgr.write(&id, b"\x1b[B").unwrap();
            std::thread::sleep(Duration::from_millis(300));
            r.mgr.write(&id, b"\r").unwrap();
            let end = Instant::now() + Duration::from_secs(30);
            while Instant::now() < end && !hook_progress() {
                std::thread::sleep(Duration::from_millis(200));
            }
            if hook_progress() {
                break;
            }
            assert!(attempt < 2, "trust menu did not go away after two attempts");
        }
    }
    eprintln!("trust menu seen: {trust_menu_seen}");
    wait_session(&r, &id, "Working", 120, || {
        r.events.lock().unwrap().iter().any(|e| matches!(e, ManagerEvent::Updated(i) if i.id == id && i.state == SessionState::Working))
    });

    // 2. NeedsYou on the Bash permission request.
    wait_session(&r, &id, "NeedsYou", 120, || matches!(state(&r, &id), SessionState::NeedsYou { .. }));
    assert!(!r.ws.path.join("hello2.txt").exists(), "tool must not run before approval");

    // 3. approve -> Working, and the tool runs.
    r.mgr.approve(&id).unwrap();
    wait_session(&r, &id, "hello2.txt created", 120, || r.ws.path.join("hello2.txt").exists());

    // 4. Finished.
    wait_session(&r, &id, "Finished", 120, || state(&r, &id) == SessionState::Finished);
    let info = r.mgr.list().into_iter().find(|s| s.id == id).unwrap();
    assert!(info.reached_finished);
    assert!(info.steps >= 1);
    // The Working transition after approval must have been observed.
    let saw_working_after_needs = {
        let ev = r.events.lock().unwrap();
        let mut seen_needs = false;
        ev.iter().any(|e| match e {
            ManagerEvent::Updated(i) if i.id == id => {
                if matches!(i.state, SessionState::NeedsYou { .. }) {
                    seen_needs = true;
                }
                seen_needs && i.state == SessionState::Working
            }
            _ => false,
        })
    };
    assert!(saw_working_after_needs, "NeedsYou -> Working after approve");

    // 5. Review lists the new file as untracked.
    let review = r.mgr.review(&id).unwrap();
    assert!(review.is_git);
    assert!(review.untracked.iter().any(|p| p == "hello2.txt"), "review: {review:?}");

    // 6. Close.
    assert!(claude_procs(&id) >= 1, "claude should be running before close");
    let out = r.mgr.close(&id).unwrap();
    assert!(out.earned_xp);
    assert!(r.mgr.list().is_empty());
    assert!(!session_dir.exists(), "per-session settings dir removed");
    wait_for("no claude child left", 10, || claude_procs(&id) == 0);
}
