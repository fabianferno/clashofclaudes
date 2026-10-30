#![allow(dead_code)] // API consumed by the session manager (Task 8)

use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::Duration;

/// Everything needed to start a process; adapters build this.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
}

/// A running child attached to a PTY. `Send + Sync`.
pub struct PtyHandle {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
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
        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        cmd.env("TERM", "xterm-256color");
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave); // so the reader sees EOF once the child exits
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

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
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            // Let the reader drain trailing output; don't hang if a grandchild holds the PTY.
            let _ = done_rx.recv_timeout(Duration::from_millis(500));
            on_exit(code);
        });

        Ok(PtyHandle { master: Mutex::new(pair.master), writer: Mutex::new(writer), killer: Mutex::new(killer) })
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

    pub fn kill(&self) -> Result<()> {
        self.killer.lock().map_err(|_| anyhow!("killer poisoned"))?.kill()?;
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
}
