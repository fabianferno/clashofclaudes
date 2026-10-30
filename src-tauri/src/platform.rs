#![allow(dead_code)] // API consumed by the session manager (Task 8)

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

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn which_finds_sh() { assert!(which("sh").is_some()); assert!(which("definitely-not-a-real-binary-xyz").is_none()); }
    #[test] fn default_shell_nonempty() { assert!(!default_shell().is_empty()); }
}
