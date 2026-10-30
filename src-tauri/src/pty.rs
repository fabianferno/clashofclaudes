use anyhow::{anyhow, Result};
use crate::platform;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Grace between SIGHUP and the SIGKILL escalation in `kill()`.
pub const KILL_GRACE: Duration = Duration::from_secs(2);
const REAP_POLL: Duration = Duration::from_millis(20);

struct Shared {
    /// Reaping happens only while this lock is held, so a signal sent under the
    /// lock after checking `exited` can never hit a recycled pid.
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    exited: AtomicBool,
}

/// A running child attached to a PTY. `Send + Sync`.
pub struct PtyHandle {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    shared: Arc<Shared>,
    pid: Option<u32>,
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
        let writer = pair.master.take_writer()?;
        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        cmd.env("TERM", "xterm-256color");
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let child = pair.slave.spawn_command(cmd)?;
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

        Ok(PtyHandle { master: Mutex::new(pair.master), writer: Mutex::new(writer), shared, pid })
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock().map_err(|_| anyhow!("writer poisoned"))?;
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .map_err(|_| anyhow!("master poisoned"))?
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        Ok(())
    }

    /// SIGHUP now; SIGKILL after `KILL_GRACE` if still alive (on a background thread).
    /// Both go to the child's whole process group, so commands it forked die too.
    /// Returns Ok if the child has already exited.
    pub fn kill(&self) -> Result<()> {
        let Some(pid) = self.pid else { return Ok(()) };
        {
            let _g = self.shared.child.lock().unwrap_or_else(|e| e.into_inner());
            if self.shared.exited.load(Ordering::SeqCst) {
                return Ok(());
            }
            platform::signal_group_hup(pid)?;
        }
        let sh = self.shared.clone();
        std::thread::spawn(move || {
            let end = Instant::now() + KILL_GRACE;
            while Instant::now() < end {
                if sh.exited.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(REAP_POLL);
            }
            let _g = sh.child.lock().unwrap_or_else(|e| e.into_inner());
            if !sh.exited.load(Ordering::SeqCst) {
                let _ = platform::signal_group_kill(pid);
            }
        });
        Ok(())
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
