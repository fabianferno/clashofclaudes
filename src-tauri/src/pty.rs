use anyhow::{anyhow, bail, Result};
use crate::platform;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// Everything needed to start a process; adapters build this.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
}

/// Set by Claude Code for the commands it runs. An app started from inside a Claude Code session
/// (`pnpm app` run by an agent) inherits them, and its sessions must not: a Claude launched with
/// them runs as that session's child, which saves no transcript (nothing to resume) and talks to
/// the parent's socket.
const PARENT_AGENT_ENV: [&str; 10] = [
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
];

/// The character encoding a session gets when the app has no locale at all, which is how macOS
/// starts an app from the Dock or Finder. Without one, children fall back to the C locale:
/// `pbcopy` (which Claude Code copies a selection with) reads its UTF-8 input as Mac Roman, so
/// `╌│❯` lands on the clipboard as `‚ïå‚îÇ‚ùØ`. Only the encoding is set, as Terminal.app does, so
/// date and number formats stay the system's.
#[cfg(target_os = "macos")]
const FALLBACK_CTYPE: &str = "UTF-8";
#[cfg(not(target_os = "macos"))]
const FALLBACK_CTYPE: &str = "C.UTF-8";

/// `LC_CTYPE` to add when none of the variables that pick the encoding is set.
fn fallback_ctype(get: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<&'static str> {
    let set = |k: &str| get(k).is_some_and(|v| !v.is_empty());
    (!["LC_ALL", "LC_CTYPE", "LANG"].into_iter().any(set)).then_some(FALLBACK_CTYPE)
}

/// The command for `spec`: the app's environment minus `PARENT_AGENT_ENV`, plus the spec's.
fn command(spec: &LaunchSpec) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    cmd.cwd(&spec.cwd);
    for k in PARENT_AGENT_ENV {
        cmd.env_remove(k);
    }
    cmd.env("TERM", "xterm-256color");
    if let Some(ctype) = fallback_ctype(|k| std::env::var_os(k)) {
        cmd.env("LC_CTYPE", ctype);
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    cmd
}

/// Grace between SIGHUP and the SIGKILL escalation in `kill()`.
pub const KILL_GRACE: Duration = Duration::from_secs(2);
pub const REAP_POLL: Duration = Duration::from_millis(20);

struct Shared {
    /// Reaping happens only while this lock is held, so a signal sent under the
    /// lock after checking `exited` can never hit a recycled pid.
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    exited: AtomicBool,
}

/// Unwritten input allowed per session before `write` refuses more.
pub const INPUT_CAP: usize = 4 * 1024 * 1024;

/// A running child attached to a PTY. `Send + Sync`.
///
/// Input goes through a per-handle writer thread fed by a FIFO channel, so `write` never
/// blocks the caller (Tauri runs sync commands on the main thread, and a pty write stalls once
/// a raw-mode child stops reading). The thread exits once the handle is dropped and its last
/// queued write finishes or fails (the child's death closes the pty, failing a stalled write).
pub struct PtyHandle {
    master: Mutex<Box<dyn MasterPty + Send>>,
    input: mpsc::Sender<Vec<u8>>,
    /// Bytes queued for the writer thread but not yet written.
    queued_input: Arc<AtomicUsize>,
    shared: Arc<Shared>,
    pid: Option<u32>,
    #[cfg(test)]
    writer_alive: Arc<AtomicBool>,
}

impl PtyHandle {
    pub fn spawn(
        spec: &LaunchSpec,
        cols: u16,
        rows: u16,
        on_output: Box<dyn Fn(&[u8]) + Send>,
        on_exit: Box<dyn FnOnce(Option<i32>) + Send>,
    ) -> Result<PtyHandle> {
        let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        // Acquire fallible resources before spawning so a failure can't leak a child.
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let child = pair.slave.spawn_command(command(spec))?;
        drop(pair.slave); // so the reader sees EOF once the child exits
        let pid = child.process_id();
        let shared = Arc::new(Shared { child: Mutex::new(Some(child)), exited: AtomicBool::new(false) });

        let (done_tx, done_rx) = mpsc::channel::<()>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_output(&buf[..n]),
                }
            }
            let _ = done_tx.send(());
        });
        let (input, input_rx) = mpsc::channel::<Vec<u8>>();
        let queued_input = Arc::new(AtomicUsize::new(0));
        let queued = queued_input.clone();
        #[cfg(test)]
        let writer_alive = Arc::new(AtomicBool::new(true));
        #[cfg(test)]
        let alive = writer_alive.clone();
        std::thread::spawn(move || {
            for chunk in input_rx {
                let ok = writer.write_all(&chunk).and_then(|_| writer.flush()).is_ok();
                queued.fetch_sub(chunk.len(), Ordering::SeqCst);
                if !ok {
                    break; // the pty is gone; later input has nowhere to go
                }
            }
            #[cfg(test)]
            alive.store(false, Ordering::SeqCst);
        });

        let sh = shared.clone();
        std::thread::spawn(move || {
            let code = loop {
                {
                    let mut g = sh.child.lock().unwrap_or_else(|e| e.into_inner());
                    let Some(c) = g.as_mut() else { break None };
                    match c.try_wait() {
                        Ok(Some(st)) => {
                            *g = None;
                            sh.exited.store(true, Ordering::SeqCst);
                            break Some(st.exit_code() as i32);
                        }
                        Ok(None) => {}
                        Err(_) => {
                            *g = None;
                            sh.exited.store(true, Ordering::SeqCst);
                            break None;
                        }
                    }
                }
                std::thread::sleep(REAP_POLL);
            };
            // Let the reader drain trailing output; don't hang if a grandchild holds the PTY.
            let _ = done_rx.recv_timeout(Duration::from_millis(500));
            on_exit(code);
        });

        Ok(PtyHandle {
            master: Mutex::new(pair.master),
            input,
            queued_input,
            shared,
            pid,
            #[cfg(test)]
            writer_alive,
        })
    }

    /// Queues `data` for the child, in call order; returns immediately.
    pub fn write(&self, data: &[u8]) -> Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        if self.queued_input.load(Ordering::SeqCst) + data.len() > INPUT_CAP {
            bail!("the terminal is not reading input; try again later");
        }
        self.queued_input.fetch_add(data.len(), Ordering::SeqCst);
        if self.input.send(data.to_vec()).is_err() {
            self.queued_input.fetch_sub(data.len(), Ordering::SeqCst);
            bail!("the terminal no longer accepts input");
        }
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .map_err(|_| anyhow!("master poisoned"))?
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        Ok(())
    }

    /// The child has exited and been reaped.
    pub fn has_exited(&self) -> bool {
        self.shared.exited.load(Ordering::SeqCst)
    }

    /// The child's process group id (its pid: a PTY child is a session leader).
    pub fn pgid(&self) -> Option<u32> {
        self.pid
    }

    /// A command, not the shell, holds the terminal: the foreground process group is not the leader's.
    pub fn foreground_busy(&self) -> bool {
        let fg = self.master.lock().unwrap_or_else(|e| e.into_inner()).process_group_leader();
        matches!((fg, self.pid), (Some(fg), Some(pid)) if fg as u32 != pid)
    }

    /// The leader is unreaped, or some process it left behind is still in its group.
    pub fn group_alive(&self) -> bool {
        self.pid.is_some_and(|pid| !self.has_exited() || platform::group_exists(pid))
    }

    /// SIGKILL to the child's whole process group now, whether or not the leader was reaped:
    /// commands it forked may outlive it. The group id cannot be recycled while any member
    /// lives, and an empty group is skipped (checked just before), so this never hits a
    /// recycled group in practice.
    pub fn kill_now(&self) {
        if let Some(pid) = self.pid {
            kill_group_if_alive(pid);
        }
    }

    /// SIGHUP to the process group now; SIGKILL after `KILL_GRACE` (on a background thread) if
    /// anything in the group is still alive, even when the leader itself already exited (a
    /// child that ignores SIGHUP must not survive it). Returns Ok when nothing is left to stop.
    pub fn kill(&self) -> Result<()> {
        let Some(pid) = self.pid else { return Ok(()) };
        {
            let _g = self.shared.child.lock().unwrap_or_else(|e| e.into_inner());
            if !self.shared.exited.load(Ordering::SeqCst) {
                platform::signal_group_hup(pid)?;
            } else if platform::group_exists(pid) {
                let _ = platform::signal_group_hup(pid); // orphans of an exited leader
            } else {
                return Ok(());
            }
        }
        std::thread::spawn(move || {
            let end = Instant::now() + KILL_GRACE;
            while Instant::now() < end {
                if !platform::group_exists(pid) {
                    return;
                }
                std::thread::sleep(REAP_POLL);
            }
            kill_group_if_alive(pid);
        });
        Ok(())
    }
}

/// SIGKILL to group `pgid` if any process is still in it.
pub fn kill_group_if_alive(pgid: u32) {
    if platform::group_exists(pgid) {
        let _ = platform::signal_group_kill(pgid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    fn collect() -> (Arc<Mutex<Vec<u8>>>, Box<dyn Fn(&[u8]) + Send>) {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let b2 = buf.clone();
        (buf, Box::new(move |d| b2.lock().unwrap().extend_from_slice(d)))
    }
    fn wait_for(buf: &Arc<Mutex<Vec<u8>>>, needle: &str) -> bool {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if String::from_utf8_lossy(&buf.lock().unwrap()).contains(needle) { return true; }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
    fn spec(program: &str, args: &[&str], cwd: std::path::PathBuf) -> LaunchSpec {
        LaunchSpec { program: program.into(), args: args.iter().map(|s| s.to_string()).collect(), env: vec![], cwd }
    }

    #[test]
    fn sessions_do_not_inherit_a_parent_claude_session() {
        let mut s = spec("/bin/sh", &[], std::env::temp_dir());
        s.env = vec![("AGY_CLI_OSC7501".into(), "on".into())];
        let cmd = command(&s);
        for k in PARENT_AGENT_ENV {
            assert!(cmd.get_env(k).is_none(), "{k} is passed on");
        }
        assert_eq!(cmd.get_env("AGY_CLI_OSC7501").and_then(|v| v.to_str()), Some("on"));
        assert!(cmd.get_env("PATH").is_some(), "the rest of the environment is kept");
    }

    #[test]
    fn sessions_get_utf8_only_when_the_app_has_no_locale() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.into())
        };
        assert_eq!(fallback_ctype(env(&[])), Some(FALLBACK_CTYPE), "a Dock launch has no locale");
        assert_eq!(fallback_ctype(env(&[("LANG", "")])), Some(FALLBACK_CTYPE), "empty counts as unset");
        assert_eq!(fallback_ctype(env(&[("LANG", "en_GB.UTF-8")])), None);
        assert_eq!(fallback_ctype(env(&[("LC_CTYPE", "UTF-8")])), None);
        assert_eq!(fallback_ctype(env(&[("LC_ALL", "fr_FR.ISO8859-1")])), None, "a chosen locale is left alone");
    }

    #[test]
    fn spawn_captures_output_and_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let (buf, on_out) = collect();
        let (tx, rx) = mpsc::channel();
        let _h = PtyHandle::spawn(&spec("/bin/sh", &["-c", "printf hello; exit 3"], dir.path().to_path_buf()), 80, 24, on_out,
            Box::new(move |c| { let _ = tx.send(c); })).unwrap();
        let code = rx.recv_timeout(Duration::from_secs(5)).expect("exit");
        assert_eq!(code, Some(3));
        assert!(wait_for(&buf, "hello"));
    }

    #[test]
    fn write_reaches_child() {
        let dir = tempfile::tempdir().unwrap();
        let (buf, on_out) = collect();
        let (tx, rx) = mpsc::channel();
        let h = PtyHandle::spawn(&spec("/bin/cat", &[], dir.path().to_path_buf()), 80, 24, on_out,
            Box::new(move |c| { let _ = tx.send(c); })).unwrap();
        h.write(b"ping\n").unwrap();
        assert!(wait_for(&buf, "ping"));
        h.resize(100, 30).unwrap();
        h.kill().unwrap();
        rx.recv_timeout(Duration::from_secs(5)).expect("exit observed");
    }

    #[test]
    fn write_never_blocks_on_a_child_that_does_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let (_b, on_out) = collect();
        let (tx, rx) = mpsc::channel();
        let h = PtyHandle::spawn(&spec("/bin/sh", &["-c", "stty raw -echo; echo ready; sleep 5"], dir.path().to_path_buf()), 80, 24, on_out,
            Box::new(move |c| { let _ = tx.send(c); })).unwrap();
        // Raw mode, like any TUI: unread input fills the pty queue and a blocking write stalls.
        assert!(wait_for(&_b, "ready"));
        let t = Instant::now();
        for _ in 0..4 {
            h.write(&[b'x'; 32 * 1024]).unwrap();
        }
        assert!(t.elapsed() < Duration::from_millis(100), "write blocked for {:?}", t.elapsed());
        assert!(h.write(&vec![b'y'; INPUT_CAP]).is_err(), "unread input is capped");
        h.kill().unwrap();
        rx.recv_timeout(Duration::from_secs(5)).expect("exit");
        let alive = h.writer_alive.clone();
        drop(h);
        let end = Instant::now() + Duration::from_secs(5);
        while alive.load(Ordering::SeqCst) && Instant::now() < end { std::thread::sleep(Duration::from_millis(20)); }
        assert!(!alive.load(Ordering::SeqCst), "writer thread outlived the session");
    }

    #[test]
    fn writes_arrive_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let (buf, on_out) = collect();
        let (tx, rx) = mpsc::channel();
        let h = PtyHandle::spawn(&spec("/bin/cat", &[], dir.path().to_path_buf()), 80, 24, on_out,
            Box::new(move |c| { let _ = tx.send(c); })).unwrap();
        for i in 0..50 {
            h.write(format!("{i},").as_bytes()).unwrap();
        }
        h.write(b"end\n").unwrap();
        let want: String = (0..50).map(|i| format!("{i},")).collect::<String>() + "end";
        assert!(wait_for(&buf, &want));
        h.kill().unwrap();
        rx.recv_timeout(Duration::from_secs(5)).expect("exit");
    }

    #[test]
    fn cwd_with_spaces_is_respected() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("my dir");
        std::fs::create_dir(&cwd).unwrap();
        let (buf, on_out) = collect();
        let (tx, rx) = mpsc::channel();
        let _h = PtyHandle::spawn(&spec("/bin/pwd", &[], cwd), 80, 24, on_out,
            Box::new(move |c| { let _ = tx.send(c); })).unwrap();
        rx.recv_timeout(Duration::from_secs(5)).expect("exit");
        assert!(wait_for(&buf, "my dir"));
    }

    #[test]
    fn kill_after_exit_is_ok_and_on_exit_fires_once() {
        let dir = tempfile::tempdir().unwrap();
        let (_b, on_out) = collect();
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c2 = count.clone();
        let (tx, rx) = mpsc::channel();
        let h = PtyHandle::spawn(&spec("/bin/sh", &["-c", "exit 0"], dir.path().to_path_buf()), 80, 24, on_out,
            Box::new(move |c| { c2.fetch_add(1, std::sync::atomic::Ordering::SeqCst); let _ = tx.send(c); })).unwrap();
        rx.recv_timeout(Duration::from_secs(5)).expect("exit");
        h.kill().unwrap();
        h.kill().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn kill_reaches_grandchildren() {
        // The grandchild inherits the ignored SIGHUP, so only a group SIGKILL ends it.
        let dir = tempfile::tempdir().unwrap();
        let (buf, on_out) = collect();
        let (tx, rx) = mpsc::channel();
        let h = PtyHandle::spawn(&spec("/bin/sh", &["-c", "trap '' HUP; sleep 30 & echo pid:$!; wait"], dir.path().to_path_buf()), 80, 24, on_out,
            Box::new(move |c| { let _ = tx.send(c); })).unwrap();
        assert!(wait_for(&buf, "pid:"));
        assert!(wait_for(&buf, "\n"));
        let text = String::from_utf8_lossy(&buf.lock().unwrap()).into_owned();
        let pid: i32 = text.split("pid:").nth(1).unwrap().split_whitespace().next().unwrap().parse().unwrap();
        h.kill().unwrap();
        rx.recv_timeout(KILL_GRACE + Duration::from_secs(3)).expect("exit");
        let end = Instant::now() + Duration::from_secs(2);
        // SAFETY: signal 0 only probes for existence.
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < end { std::thread::sleep(Duration::from_millis(20)); }
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        if alive { unsafe { libc::kill(pid, libc::SIGKILL); } } // don't leak it from a failing run
        assert!(!alive, "grandchild survived kill()");
    }

    fn pid_after(buf: &Arc<Mutex<Vec<u8>>>) -> i32 {
        assert!(wait_for(buf, "pid:"));
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            let text = String::from_utf8_lossy(&buf.lock().unwrap()).into_owned();
            let tail = text.split("pid:").nth(1).unwrap();
            if tail.contains('\n') || Instant::now() > end {
                return tail.split_whitespace().next().unwrap().parse().unwrap();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Waits up to `within` for `pid` to disappear; kills it if it did not (no leaks).
    fn gone_within(pid: i32, within: Duration) -> bool {
        let end = Instant::now() + within;
        // SAFETY: signal 0 only probes for existence.
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < end { std::thread::sleep(Duration::from_millis(20)); }
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        if alive { unsafe { libc::kill(pid, libc::SIGKILL); } }
        !alive
    }

    /// The leader dies on SIGHUP at once; its child ignores SIGHUP (and stays in the group).
    const HUP_LEADER_TRAPPING_CHILD: &str = r#"sh -c 'trap "" HUP; echo pid:$$; exec sleep 30' & wait"#;

    #[test]
    fn kill_reaches_a_child_that_outlives_its_sighup_dead_leader() {
        let dir = tempfile::tempdir().unwrap();
        let (buf, on_out) = collect();
        let (tx, rx) = mpsc::channel();
        let h = PtyHandle::spawn(&spec("/bin/sh", &["-c", HUP_LEADER_TRAPPING_CHILD], dir.path().to_path_buf()), 80, 24, on_out,
            Box::new(move |c| { let _ = tx.send(c); })).unwrap();
        let child = pid_after(&buf);
        h.kill().unwrap();
        rx.recv_timeout(Duration::from_secs(3)).expect("leader exits on SIGHUP");
        assert!(h.has_exited());
        assert!(gone_within(child, KILL_GRACE + Duration::from_secs(3)), "child survived kill() after its leader was reaped");
        assert!(!h.group_alive());
    }

    #[test]
    fn kill_now_reaches_the_group_after_the_leader_was_reaped() {
        let dir = tempfile::tempdir().unwrap();
        let (buf, on_out) = collect();
        let (tx, rx) = mpsc::channel();
        // The leader exits on its own, leaving a SIGHUP-proof child behind in its group.
        let h = PtyHandle::spawn(&spec("/bin/sh", &["-c", r#"sh -c 'trap "" HUP; echo pid:$$; exec sleep 30' & sleep 0.3"#], dir.path().to_path_buf()), 80, 24, on_out,
            Box::new(move |c| { let _ = tx.send(c); })).unwrap();
        let child = pid_after(&buf);
        rx.recv_timeout(Duration::from_secs(5)).expect("leader exits");
        assert!(h.has_exited());
        assert!(h.group_alive(), "the child is still in the group");
        h.kill_now();
        assert!(gone_within(child, Duration::from_secs(2)), "child survived kill_now()");
        assert!(!h.group_alive());
    }

    #[test]
    fn kill_escalates_when_sighup_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let (buf, on_out) = collect();
        let (tx, rx) = mpsc::channel();
        let h = PtyHandle::spawn(&spec("/bin/sh", &["-c", "trap '' HUP; echo ready; sleep 30"], dir.path().to_path_buf()), 80, 24, on_out,
            Box::new(move |c| { let _ = tx.send(c); })).unwrap();
        assert!(wait_for(&buf, "ready"));
        h.kill().unwrap();
        rx.recv_timeout(KILL_GRACE + Duration::from_secs(3)).expect("child gone after escalation");
    }
}
