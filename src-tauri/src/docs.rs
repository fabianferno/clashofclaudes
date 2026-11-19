//! Reading a markdown doc an agent points the owner to (a plan or spec it wrote), so the briefing
//! can show it rendered instead of sending the owner to an editor.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Result};
use serde::Serialize;

/// Larger than any plan worth reading in a side panel.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    /// The file's absolute path.
    pub path: String,
    pub text: String,
}

/// A markdown file's extension: the only kind this reads.
pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdx"))
}

/// Where `path`, as an agent wrote it, points: `~/` is the home folder; an absolute path is
/// itself; a relative one is looked up in each of `bases` in turn (the session's folder, then its
/// repository's root, as git reports changed files from there). `None` when no such file exists.
pub fn resolve(path: &str, bases: &[PathBuf], home: Option<&Path>) -> Option<PathBuf> {
    let p = path.trim();
    let p = p.strip_prefix("file://").unwrap_or(p);
    if let Some(rest) = p.strip_prefix("~/") {
        return home.map(|h| h.join(rest)).filter(|c| c.is_file());
    }
    let p = Path::new(p);
    if p.is_absolute() {
        return p.is_file().then(|| p.to_path_buf());
    }
    bases.iter().map(|b| b.join(p)).find(|c| c.is_file())
}

/// Reads the markdown file `path` points to (see [`resolve`]).
pub fn read(path: &str, bases: &[PathBuf], home: Option<&Path>) -> Result<Doc> {
    if !is_markdown(Path::new(path.trim())) {
        bail!("only markdown files open here");
    }
    let found = resolve(path, bases, home).ok_or_else(|| anyhow!("{} is not there (moved or deleted?)", path.trim()))?;
    let found = std::fs::canonicalize(&found).unwrap_or(found);
    // a link pointing elsewhere must still land on markdown
    if !is_markdown(&found) {
        bail!("only markdown files open here");
    }
    let len = std::fs::metadata(&found)?.len();
    if len > MAX_BYTES {
        bail!("{} is too large to show here ({} KB)", found.display(), len / 1024);
    }
    let bytes = std::fs::read(&found)?;
    Ok(Doc { path: found.to_string_lossy().into_owned(), text: String::from_utf8_lossy(&bytes).into_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn markdown_extensions_only() {
        assert!(is_markdown(Path::new("docs/plan.md")));
        assert!(is_markdown(Path::new("PLAN.MD")));
        assert!(is_markdown(Path::new("a.markdown")));
        assert!(!is_markdown(Path::new("src/main.rs")));
        assert!(!is_markdown(Path::new(".env")));
        assert!(!is_markdown(Path::new("md")));
    }

    #[test]
    fn relative_paths_try_each_base_in_turn() {
        let repo = tempfile::tempdir().unwrap();
        let sub = repo.path().join("app");
        fs::create_dir_all(sub.join("notes")).unwrap();
        fs::create_dir_all(repo.path().join("docs")).unwrap();
        fs::write(sub.join("notes/a.md"), "# A").unwrap();
        fs::write(repo.path().join("docs/plan.md"), "# Plan").unwrap();
        let bases = [sub.clone(), repo.path().to_path_buf()];

        assert_eq!(read("notes/a.md", &bases, None).unwrap().text, "# A");
        // git reports changed files from the repository's root
        assert_eq!(read("docs/plan.md", &bases, None).unwrap().text, "# Plan");
        assert!(read("docs/missing.md", &bases, None).unwrap_err().to_string().contains("not there"));
    }

    #[test]
    fn home_and_absolute_paths() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".claude/plans")).unwrap();
        let plan = home.path().join(".claude/plans/p.md");
        fs::write(&plan, "plan").unwrap();

        assert_eq!(read("~/.claude/plans/p.md", &[], Some(home.path())).unwrap().text, "plan");
        let abs = read(plan.to_str().unwrap(), &[], None).unwrap();
        assert_eq!(abs.text, "plan");
        assert!(Path::new(&abs.path).is_absolute());
    }

    #[test]
    fn refuses_other_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("secret.txt"), "x").unwrap();
        let bases = [dir.path().to_path_buf()];
        assert!(read("secret.txt", &bases, None).is_err());
        // a markdown-named link to something else
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret.txt"), dir.path().join("sneaky.md")).unwrap();
            assert!(read("sneaky.md", &bases, None).is_err());
        }
    }

    #[test]
    fn refuses_huge_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("big.md"), vec![b'a'; (MAX_BYTES + 1) as usize]).unwrap();
        assert!(read("big.md", &[dir.path().to_path_buf()], None).unwrap_err().to_string().contains("too large"));
    }
}
