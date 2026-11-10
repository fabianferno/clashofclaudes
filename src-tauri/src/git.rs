//! Git review helpers. Shells out to the `git` CLI with `-C <dir>`; reads only
//! metadata and diff statistics, never file contents.
use crate::model::WorktreeInfo;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Debug, PartialEq)]
pub struct GitBaseline {
    pub repo_root: PathBuf,
    pub head: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub added: u32,
    pub removed: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub is_git: bool,
    pub branch: Option<String>,
    pub files: Vec<FileChange>,
    pub untracked: Vec<String>,
    pub other_sessions_active: bool,
}

/// Runs `git -C dir <args>`; `Some(stdout)` on success, `None` on any failure.
fn git_out(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        // An inherited repo selection (e.g. when run from a git hook) must not leak in.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

fn git_line(dir: &Path, args: &[&str]) -> Option<String> {
    let out = git_out(dir, args)?;
    let s = String::from_utf8_lossy(&out).trim_end_matches(['\n', '\r']).to_string();
    (!s.is_empty()).then_some(s)
}

fn toplevel(dir: &Path) -> Option<PathBuf> {
    git_line(dir, &["rev-parse", "--show-toplevel"]).map(PathBuf::from)
}

fn common_dir(dir: &Path) -> Option<PathBuf> {
    let p = git_line(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    Some(std::fs::canonicalize(&p).unwrap_or_else(|_| PathBuf::from(p)))
}

/// Current branch name; `None` when detached or unborn-and-unnamed.
fn branch(dir: &Path) -> Option<String> {
    git_line(dir, &["symbolic-ref", "--short", "-q", "HEAD"])
}

/// The folder's git state at session start; `None` when `dir` is not in a git repo.
pub fn baseline(dir: &Path) -> Option<GitBaseline> {
    let repo_root = toplevel(dir)?;
    let head = git_line(dir, &["rev-parse", "--verify", "-q", "HEAD"]);
    Some(GitBaseline { repo_root, head })
}

/// Parses `git diff --numstat -z --no-renames` output: `added\tremoved\tpath\0` records;
/// binary files show `-` and count as 0/0.
fn parse_numstat(out: &[u8]) -> Vec<FileChange> {
    out.split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let rec = String::from_utf8_lossy(rec);
            let mut it = rec.splitn(3, '\t');
            let added = it.next()?.parse().unwrap_or(0);
            let removed = it.next()?.parse().unwrap_or(0);
            let path = it.next()?.to_string();
            Some(FileChange { path, added, removed })
        })
        .collect()
}

/// Working tree of `dir` versus the baseline commit, plus untracked files.
/// Paths are relative to the repository root.
pub fn review_since(dir: &Path, base: Option<&GitBaseline>) -> anyhow::Result<Review> {
    let Some(base) = base else {
        return Ok(Review { is_git: false, branch: None, files: vec![], untracked: vec![], other_sessions_active: false });
    };
    // No commit at start: compare against the empty tree (hash depends on the repo's object format).
    let against = match &base.head {
        Some(h) => h.clone(),
        None => git_line(dir, &["hash-object", "-t", "tree", "/dev/null"])
            .ok_or_else(|| anyhow::anyhow!("git hash-object failed in {}", dir.display()))?,
    };
    let numstat = git_out(dir, &["diff", "--numstat", "-z", "--no-renames", &against])
        .ok_or_else(|| anyhow::anyhow!("git diff failed in {}", dir.display()))?;
    let others = git_out(dir, &["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"])
        .ok_or_else(|| anyhow::anyhow!("git ls-files failed in {}", dir.display()))?;
    let untracked = others
        .split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .map(|r| String::from_utf8_lossy(r).into_owned())
        .collect();
    Ok(Review { is_git: true, branch: branch(dir), files: parse_numstat(&numstat), untracked, other_sessions_active: false })
}

/// `Some` when `cwd` is inside a different worktree of the repository that holds `workspace_root`.
pub fn worktree_of(workspace_root: &Path, cwd: &Path) -> Option<WorktreeInfo> {
    let ws_common = common_dir(workspace_root)?;
    let cwd_common = common_dir(cwd)?;
    if ws_common != cwd_common {
        return None;
    }
    let ws_top = toplevel(workspace_root)?;
    let cwd_top = toplevel(cwd)?;
    let same = |a: &Path, b: &Path| match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    };
    if same(&ws_top, &cwd_top) {
        return None;
    }
    Some(WorktreeInfo { branch: branch(&cwd_top), path: cwd_top })
}

/// A short branch-safe slug of `text` (lowercase letters, digits and dashes), at most `max` chars.
pub fn slug(text: &str, max: usize) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if out.len() >= max {
            break;
        }
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// A new worktree of the repository holding `dir`, at `at`, on a new branch `branch` from HEAD.
/// Returns the worktree and the folder in it that matches `dir` (the workspace may be a
/// subfolder of its repository). Fails when `dir` is not in a repository with a commit.
pub fn add_worktree(dir: &Path, at: &Path, branch: &str) -> anyhow::Result<(WorktreeInfo, PathBuf)> {
    let top = toplevel(dir).ok_or_else(|| anyhow::anyhow!("this workspace is not a git repository, so it can't start in a worktree"))?;
    git_line(dir, &["rev-parse", "--verify", "-q", "HEAD"])
        .ok_or_else(|| anyhow::anyhow!("this repository has no commit yet, so it can't start in a worktree"))?;
    if let Some(parent) = at.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let at_s = at.to_string_lossy();
    let out = Command::new("git")
        .arg("-C")
        .arg(&top)
        .args(["worktree", "add", "-q", "-b", branch, &at_s, "HEAD"])
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null())
        .output()?;
    if !out.status.success() {
        anyhow::bail!("git worktree add failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let rel = canon(dir).strip_prefix(canon(&top)).map(Path::to_path_buf).unwrap_or_default();
    let cwd = at.join(rel);
    std::fs::create_dir_all(&cwd)?; // a subfolder with nothing committed in it yet
    Ok((WorktreeInfo { path: at.to_path_buf(), branch: Some(branch.to_string()) }, cwd))
}

/// The folder in worktree `worktree` that matches `dir` in its own checkout (`dir` may be a
/// subfolder of its repository).
pub fn matching_folder(dir: &Path, worktree: &Path) -> PathBuf {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let rel = toplevel(dir).and_then(|top| canon(dir).strip_prefix(canon(&top)).map(Path::to_path_buf).ok()).unwrap_or_default();
    worktree.join(rel)
}

/// Undoes `add_worktree` after a start that failed: the worktree and its (still empty) branch go.
pub fn remove_worktree(dir: &Path, wt: &WorktreeInfo) {
    let path = wt.path.to_string_lossy();
    let _ = git_out(dir, &["worktree", "remove", "--force", &path]);
    if let Some(b) = &wt.branch {
        let _ = git_out(dir, &["branch", "-D", b]);
    }
}

/// `git init` in an existing directory.
pub fn init_repo(dir: &Path) -> anyhow::Result<()> {
    git_out(dir, &["init", "-q"])
        .map(|_| ())
        .ok_or_else(|| anyhow::anyhow!("git init failed in {}", dir.display()))
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::path::Path;
    use std::process::Command;

    /// Runs git in `dir` with a fixed identity and no signing; panics on failure.
    pub fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A fresh repo in `dir` with `a.txt` = "1\n" committed.
    pub fn repo_with_commit(dir: &Path) {
        super::init_repo(dir).unwrap();
        std::fs::write(dir.join("a.txt"), "1\n").unwrap();
        git(dir, &["add", "a.txt"]);
        git(dir, &["commit", "-q", "-m", "init"]);
    }
}

#[cfg(test)]
mod tests {
    use super::test_util::*;
    use super::*;

    #[test]
    fn slug_is_branch_safe_and_short() {
        assert_eq!(slug("Fix the Login page!! (urgent)", 40), "fix-the-login-page-urgent");
        assert_eq!(slug("  ¿¿  ", 10), "");
        assert!(slug(&"word ".repeat(20), 12).len() <= 12);
    }

    #[test]
    fn worktree_gets_its_own_branch_and_matching_subfolder() {
        let d = tempfile::tempdir().unwrap();
        let repo = d.path().join("repo");
        std::fs::create_dir_all(repo.join("app")).unwrap();
        repo_with_commit(&repo);
        std::fs::write(repo.join("app/b.txt"), "b").unwrap();
        git(&repo, &["add", "app/b.txt"]);
        git(&repo, &["commit", "-q", "-m", "app"]);
        let at = d.path().join("wt").join("one");
        let (wt, cwd) = add_worktree(&repo.join("app"), &at, "coc/test-1").unwrap();
        assert_eq!(wt.branch.as_deref(), Some("coc/test-1"));
        assert_eq!(cwd, at.join("app"));
        assert!(cwd.join("b.txt").exists());
        assert_eq!(branch(&at).as_deref(), Some("coc/test-1"));
        assert!(add_worktree(d.path(), &d.path().join("x"), "coc/x").is_err(), "not a repo");
    }

    #[test]
    fn non_git_dir_has_no_baseline() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(baseline(tmp.path()).is_none());
    }

    #[test]
    fn review_counts_changes_since_baseline() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        repo_with_commit(dir);
        let b = baseline(dir).unwrap();
        assert!(b.head.is_some());
        std::fs::write(dir.join("a.txt"), "1\n2\n").unwrap();
        std::fs::write(dir.join("new.txt"), "x\n").unwrap();
        let r = review_since(dir, Some(&b)).unwrap();
        assert!(r.is_git);
        assert_eq!(r.files, vec![FileChange { path: "a.txt".into(), added: 1, removed: 0 }]);
        assert_eq!(r.untracked, vec!["new.txt".to_string()]);
    }

    #[test]
    fn review_without_git_is_flagged() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!review_since(tmp.path(), None).unwrap().is_git);
    }

    #[test]
    fn detects_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        repo_with_commit(&repo);
        let wt = tmp.path().join("wt");
        git(&repo, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "feature"]);
        assert_eq!(worktree_of(&repo, &wt).unwrap().branch.as_deref(), Some("feature"));
        assert!(worktree_of(&repo, &repo).is_none());
    }
}
