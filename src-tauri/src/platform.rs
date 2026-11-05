//! OS-specific helpers (macOS for v1).
use std::path::PathBuf;

/// Default login shell from `$SHELL`, falling back to `/bin/zsh`.
pub fn default_shell() -> String {
    match std::env::var("SHELL") {
        Ok(s) if !s.trim().is_empty() => s,
        _ => "/bin/zsh".to_string(),
    }
}

/// Find an executable by searching `$PATH` (or use it directly if it contains a `/`).
pub fn which(program: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let is_exec = |p: &PathBuf| p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false);
    if program.contains('/') {
        let p = PathBuf::from(program);
        return is_exec(&p).then_some(p);
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(program))
        .find(is_exec)
}

/// A firm tap from a Force Touch trackpad (AppKit's "level change", the strongest of its patterns).
/// Felt only while a finger rests on such a trackpad; a no-op with a mouse.
#[cfg(target_os = "macos")]
pub fn haptic_tap() {
    use objc2_app_kit::{NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime, NSHapticFeedbackPerformer};
    NSHapticFeedbackManager::defaultPerformer()
        .performFeedbackPattern_performanceTime(NSHapticFeedbackPattern::LevelChange, NSHapticFeedbackPerformanceTime::Now);
}
#[cfg(not(target_os = "macos"))]
pub fn haptic_tap() {}

/// Signals the process group led by `pgid` (a PTY child is a session leader, so its
/// pgid is its pid), reaching grandchildren such as the commands a shell forked.
fn signal_group(pgid: u32, sig: libc::c_int) -> std::io::Result<()> {
    // SAFETY: plain killpg(2) on a group whose leader the caller has verified is not yet reaped.
    if unsafe { libc::killpg(pgid as libc::pid_t, sig) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}
pub fn signal_group_hup(pgid: u32) -> std::io::Result<()> { signal_group(pgid, libc::SIGHUP) }
pub fn signal_group_kill(pgid: u32) -> std::io::Result<()> { signal_group(pgid, libc::SIGKILL) }

/// Some process is still in group `pgid` (only "no such group" counts as gone).
pub fn group_exists(pgid: u32) -> bool {
    // SAFETY: signal 0 only probes; nothing is delivered.
    let ok = unsafe { libc::killpg(pgid as libc::pid_t, 0) } == 0;
    ok || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

// ---- Login-shell PATH import -------------------------------------------------------------
//
// An app started from the Dock or Finder gets launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
// so agent CLIs in `~/.local/bin`, Homebrew or an npm prefix are not found, and npm CLIs
// (`#!/usr/bin/env node`) need the full PATH to find `node`. At startup the PATH of the user's
// login shell is imported; if that fails, well-known install dirs are prepended instead.

const PATH_MARK: &str = "__COC_PATH__";
/// Constant script: no user data is ever interpolated into it.
const PATH_SCRIPT: &str = r#"printf "__COC_PATH__%s__COC_PATH__" "$PATH""#;
pub const PATH_IMPORT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// The PATH printed between the two markers in `out`, ignoring anything rc files print around
/// it. `None` when the markers are missing or the PATH is empty.
pub fn parse_marked_path(out: &str) -> Option<String> {
    let start = out.find(PATH_MARK)? + PATH_MARK.len();
    let len = out[start..].find(PATH_MARK)?;
    let p = out[start..start + len].trim();
    (!p.is_empty() && !p.contains('\n')).then(|| p.to_string())
}

/// `first`'s entries, then `rest`'s, without duplicates or empty entries (order kept).
pub fn merge_paths<'a>(first: impl IntoIterator<Item = &'a str>, rest: impl IntoIterator<Item = &'a str>) -> String {
    let mut seen = std::collections::HashSet::new();
    first
        .into_iter()
        .chain(rest)
        .filter(|d| !d.is_empty() && seen.insert(*d))
        .collect::<Vec<_>>()
        .join(":")
}

/// Fallback when the login shell gave nothing: the well-known install dirs under `home` (and
/// Homebrew's) that `exists`, prepended to `current`.
pub fn fallback_path(current: &str, home: Option<&std::path::Path>, exists: impl Fn(&std::path::Path) -> bool) -> String {
    let mut dirs: Vec<PathBuf> = vec![];
    let in_home = |rel: &str| home.map(|h| h.join(rel));
    dirs.extend(in_home(".local/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.extend(in_home(".bun/bin"));
    dirs.extend(in_home(".npm-global/bin"));
    dirs.extend(in_home(".volta/bin"));
    let found: Vec<String> = dirs.into_iter().filter(|d| exists(d)).filter_map(|d| d.to_str().map(String::from)).collect();
    merge_paths(found.iter().map(String::as_str), current.split(':'))
}

/// The user's login shell: `$SHELL` when it is an absolute path, else the passwd entry, else
/// `/bin/zsh`.
fn login_shell() -> String {
    if let Ok(s) = std::env::var("SHELL")
        && s.starts_with('/')
    {
        return s;
    }
    // SAFETY: getpwuid returns a pointer into static storage (or null); it is read at once.
    let pw = unsafe { libc::getpwuid(libc::getuid()) };
    if !pw.is_null() {
        let sh = unsafe { std::ffi::CStr::from_ptr((*pw).pw_shell) }.to_string_lossy().into_owned();
        if sh.starts_with('/') {
            return sh;
        }
    }
    "/bin/zsh".to_string()
}

/// How a command run by `output_within` ended.
#[derive(Debug, PartialEq)]
pub enum RunOutcome {
    /// It exited in time: success flag and everything it printed on stdout.
    Exited { success: bool, stdout: Vec<u8> },
    /// Still running at the deadline: its whole process group was killed.
    TimedOut,
    SpawnFailed,
}

/// Runs `cmd` (stdin from /dev/null, stderr discarded, in its own process group) for at most
/// `timeout`. Stdout is read on a helper thread, so a background job that inherited it cannot
/// block the caller; after the exit, output still arriving is waited for briefly only.
pub fn output_within(mut cmd: std::process::Command, timeout: std::time::Duration) -> RunOutcome {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let Ok(mut child) = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0).spawn() else {
        return RunOutcome::SpawnFailed;
    };
    let Some(mut out) = child.stdout.take() else { return RunOutcome::SpawnFailed };
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut all = Vec::new();
        let _ = out.read_to_end(&mut all);
        let _ = tx.send(all);
    });
    let end = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(20)),
            _ => break None,
        }
    };
    let Some(status) = status else {
        // Unreaped, so the pid (and group id) cannot have been recycled.
        let _ = signal_group_kill(child.id());
        let _ = child.kill();
        let _ = child.wait();
        return RunOutcome::TimedOut;
    };
    let stdout = rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default();
    RunOutcome::Exited { success: status.success(), stdout }
}

/// Runs `shell -ilc PATH_SCRIPT` for at most `timeout` and returns the marked PATH.
pub fn login_shell_path(shell: &str, timeout: std::time::Duration) -> Option<String> {
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-ilc", PATH_SCRIPT]);
    match output_within(cmd, timeout) {
        RunOutcome::Exited { stdout, .. } => parse_marked_path(&String::from_utf8_lossy(&stdout)),
        _ => None,
    }
}

/// The PATH the app should use: the login shell's (followed by any current entries it lacks),
/// or the fallback dirs prepended to `current`.
pub fn resolve_app_path(current: &str, login: Option<String>, home: Option<&std::path::Path>) -> String {
    match login {
        Some(l) => merge_paths(l.split(':'), current.split(':')),
        None => fallback_path(current, home, |p| p.is_dir()),
    }
}

/// Sets this process's PATH from the login shell (see above). macOS only; a no-op elsewhere.
///
/// # Safety
/// Must run before any other thread that may read the environment exists (start of `run`).
pub unsafe fn import_login_path() {
    #[cfg(target_os = "macos")]
    {
        let current = std::env::var("PATH").unwrap_or_default();
        let shell = login_shell();
        let login = login_shell_path(&shell, PATH_IMPORT_TIMEOUT);
        match &login {
            Some(p) => eprintln!("PATH imported from login shell {shell} ({} entries)", p.split(':').count()),
            None => eprintln!("could not read PATH from login shell {shell}; adding well-known install dirs"),
        }
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let path = resolve_app_path(&current, login, home.as_deref());
        // SAFETY: the caller guarantees no other thread reads the environment yet.
        unsafe { std::env::set_var("PATH", path) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn which_finds_sh() { assert!(which("sh").is_some()); assert!(which("definitely-not-a-real-binary-xyz").is_none()); }
    #[test] fn default_shell_nonempty() { assert!(!default_shell().is_empty()); }

    #[test]
    fn marked_path_ignores_rc_noise() {
        let out = "Welcome to zsh!\n\x1b[1mnvm\x1b[0m loaded\n__COC_PATH__/a/bin:/usr/bin__COC_PATH__trailing junk\n";
        assert_eq!(parse_marked_path(out).as_deref(), Some("/a/bin:/usr/bin"));
        assert_eq!(parse_marked_path("no markers here"), None);
        assert_eq!(parse_marked_path("__COC_PATH__/only/one/marker"), None);
        assert_eq!(parse_marked_path("__COC_PATH____COC_PATH__"), None, "empty PATH");
        assert_eq!(parse_marked_path("__COC_PATH__/a\n/b__COC_PATH__"), None, "not a PATH");
    }

    #[test]
    fn merge_paths_dedupes_in_order() {
        assert_eq!(merge_paths("/x:/usr/bin:/x".split(':'), "/usr/bin:/bin::/y".split(':')), "/x:/usr/bin:/bin:/y");
    }

    #[test]
    fn fallback_prepends_existing_install_dirs() {
        let home = std::path::Path::new("/Users/u");
        let present = ["/Users/u/.local/bin", "/opt/homebrew/bin", "/Users/u/.volta/bin", "/usr/bin"];
        let p = fallback_path("/usr/bin:/bin:/usr/sbin:/sbin", Some(home), |d| present.iter().any(|x| std::path::Path::new(x) == d));
        assert_eq!(p, "/Users/u/.local/bin:/opt/homebrew/bin:/Users/u/.volta/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        // Already present dirs are not repeated; no home means only the absolute dirs.
        let p = fallback_path("/opt/homebrew/bin:/usr/bin", None, |_| true);
        assert_eq!(p, "/opt/homebrew/bin:/usr/local/bin:/usr/bin");
    }

    #[test]
    fn resolve_prefers_login_path_and_keeps_current_extras() {
        let p = resolve_app_path("/usr/bin:/bin:/app/extra", Some("/Users/u/.local/bin:/usr/bin:/bin".into()), None);
        assert_eq!(p, "/Users/u/.local/bin:/usr/bin:/bin:/app/extra");
    }

    #[test]
    fn login_shell_path_reads_marked_output() {
        let d = tempfile::tempdir().unwrap();
        // A stand-in "shell" that prints rc noise, then runs the script it is given.
        let sh = d.path().join("fake-shell");
        std::fs::write(&sh, "#!/bin/sh\necho 'rc noise'\nPATH=/fake/bin:/usr/bin\nshift\neval \"$1\"\n").unwrap();
        std::fs::set_permissions(&sh, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert_eq!(login_shell_path(sh.to_str().unwrap(), PATH_IMPORT_TIMEOUT).as_deref(), Some("/fake/bin:/usr/bin"));
    }

    #[test]
    fn login_shell_path_times_out_on_a_hung_shell() {
        let d = tempfile::tempdir().unwrap();
        let sh = d.path().join("hung-shell");
        std::fs::write(&sh, "#!/bin/sh\necho 'no path coming'\nsleep 30\n").unwrap();
        std::fs::set_permissions(&sh, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let t = std::time::Instant::now();
        assert_eq!(login_shell_path(sh.to_str().unwrap(), std::time::Duration::from_millis(300)), None);
        assert!(t.elapsed() < std::time::Duration::from_secs(2), "{:?}", t.elapsed());
        assert_eq!(login_shell_path("/definitely/not/a/shell", PATH_IMPORT_TIMEOUT), None);
    }

    #[test]
    fn output_within_returns_output_or_times_out() {
        let sh = |script: &str| { let mut c = std::process::Command::new("/bin/sh"); c.args(["-c", script]); c };
        assert_eq!(output_within(sh("echo 1.2.3"), std::time::Duration::from_secs(5)), RunOutcome::Exited { success: true, stdout: b"1.2.3\n".to_vec() });
        assert!(matches!(output_within(sh("exit 4"), std::time::Duration::from_secs(5)), RunOutcome::Exited { success: false, .. }));
        // A background job holding stdout does not hold up the result.
        let t = std::time::Instant::now();
        assert!(matches!(output_within(sh("sleep 3 & echo hi"), std::time::Duration::from_secs(5)), RunOutcome::Exited { success: true, .. }));
        assert!(t.elapsed() < std::time::Duration::from_secs(2), "{:?}", t.elapsed());
        // A hung command is killed at the deadline, child processes included.
        let t = std::time::Instant::now();
        assert_eq!(output_within(sh("sleep 30"), std::time::Duration::from_millis(200)), RunOutcome::TimedOut);
        assert!(t.elapsed() < std::time::Duration::from_secs(2), "{:?}", t.elapsed());
        assert_eq!(output_within(std::process::Command::new("/no/such/binary"), std::time::Duration::from_secs(1)), RunOutcome::SpawnFailed);
    }
}
