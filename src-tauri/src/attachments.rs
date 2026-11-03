//! Images attached to a task. A pasted or dropped image is saved as `<data>/attachments/<uuid>.<ext>`
//! and referred to by that file name; a To Do keeps its names in state.json. Starting a session
//! copies them into the session's own dir (`<data>/sessions/<id>/images`), which goes when the
//! session is closed; the originals are then removed.
use anyhow::{bail, Context, Result};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Largest image accepted (a full-resolution Retina screenshot is a few MB).
pub const MAX_BYTES: usize = 20 * 1024 * 1024;
/// Most images one task can carry.
pub const MAX_PER_TASK: usize = 10;

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("attachments")
}

/// The image format by its signature, as a file extension; None when it is not an image we take.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// A name `save` could have made: `<uuid>.<ext>` with a known extension. Anything else (a path,
/// `..`) is refused, so a name from the UI can never point outside the attachments dir.
pub fn valid_name(name: &str) -> bool {
    let Some((stem, ext)) = name.split_once('.') else { return false };
    Uuid::try_parse(stem).is_ok_and(|u| u.hyphenated().to_string() == stem) && ["png", "jpg", "gif", "webp"].contains(&ext)
}

/// Checks names sent by the UI (a To Do's images, a start's images).
pub fn validate(names: &[String]) -> Result<()> {
    if names.len() > MAX_PER_TASK {
        bail!("a task can carry at most {MAX_PER_TASK} images");
    }
    if let Some(n) = names.iter().find(|n| !valid_name(n)) {
        bail!("not an attachment: {n}");
    }
    Ok(())
}

/// Saves an image and returns its name.
pub fn save(data_dir: &Path, bytes: &[u8]) -> Result<String> {
    if bytes.len() > MAX_BYTES {
        bail!("the image is larger than {} MB", MAX_BYTES / (1024 * 1024));
    }
    let ext = sniff(bytes).context("not a PNG, JPEG, GIF or WebP image")?;
    let dir = dir(data_dir);
    std::fs::create_dir_all(&dir)?;
    let name = format!("{}.{ext}", Uuid::new_v4());
    std::fs::write(dir.join(&name), bytes)?;
    Ok(name)
}

/// Saves a copy of an image file (one dropped from Finder) and returns its name.
pub fn import(data_dir: &Path, src: &Path) -> Result<String> {
    let len = std::fs::metadata(src).with_context(|| format!("cannot read {}", src.display()))?.len();
    if len > MAX_BYTES as u64 {
        bail!("the image is larger than {} MB", MAX_BYTES / (1024 * 1024));
    }
    save(data_dir, &std::fs::read(src)?)
}

pub fn read(data_dir: &Path, name: &str) -> Result<Vec<u8>> {
    if !valid_name(name) {
        bail!("not an attachment: {name}");
    }
    Ok(std::fs::read(dir(data_dir).join(name))?)
}

/// Removes attachments; missing ones are fine (already gone). Invalid names are skipped.
pub fn remove(data_dir: &Path, names: &[String]) {
    for n in names.iter().filter(|n| valid_name(n)) {
        let _ = std::fs::remove_file(dir(data_dir).join(n));
    }
}

/// Copies the attachments into `dest` as `image-1.<ext>`, `image-2.<ext>`, … and returns their paths.
pub fn copy_into(data_dir: &Path, names: &[String], dest: &Path) -> Result<Vec<PathBuf>> {
    validate(names)?;
    if names.is_empty() {
        return Ok(vec![]);
    }
    std::fs::create_dir_all(dest)?;
    let mut out = Vec::with_capacity(names.len());
    for (i, n) in names.iter().enumerate() {
        let ext = n.rsplit('.').next().unwrap_or("png");
        let to = dest.join(format!("image-{}.{ext}", i + 1));
        std::fs::copy(dir(data_dir).join(n), &to).context("an attached image is gone; remove it and attach it again")?;
        out.push(to);
    }
    Ok(out)
}

/// Removes attachment files nobody keeps (pasted into a task that was never started or added),
/// leaving `keep` and anything that is not an attachment name. Run at startup. Returns what was removed.
pub fn sweep(data_dir: &Path, keep: &HashSet<&str>) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir(data_dir)) else { return vec![] };
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        let is_file = entry.file_type().is_ok_and(|t| t.is_file());
        if !is_file || !valid_name(&name) || keep.contains(name.as_str()) {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed.push(entry.path());
        }
    }
    removed.sort();
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n rest";

    #[test]
    fn sniffs_the_formats_we_take() {
        assert_eq!(sniff(PNG), Some("png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(sniff(b"GIF89a.."), Some("gif"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(sniff(b"<svg/>"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn names_cannot_leave_the_dir() {
        let id = Uuid::new_v4();
        assert!(valid_name(&format!("{id}.png")));
        assert!(!valid_name(&format!("{id}.svg")));
        assert!(!valid_name(&format!("../{id}.png")));
        assert!(!valid_name(&format!("{}.png", id.to_string().to_uppercase())));
        assert!(!valid_name("state.json"));
        assert!(read(Path::new("/tmp"), "../state.json").is_err());
    }

    #[test]
    fn save_copy_remove_and_sweep() {
        let d = tempfile::tempdir().unwrap();
        assert!(save(d.path(), b"not an image").is_err());
        let a = save(d.path(), PNG).unwrap();
        let b = save(d.path(), b"GIF89a..").unwrap();
        assert!(a.ends_with(".png") && b.ends_with(".gif"));
        assert_eq!(read(d.path(), &a).unwrap(), PNG);

        let dest = d.path().join("sessions/s1/images");
        let paths = copy_into(d.path(), &[a.clone(), b.clone()], &dest).unwrap();
        assert_eq!(paths, vec![dest.join("image-1.png"), dest.join("image-2.gif")]);
        assert_eq!(std::fs::read(&paths[0]).unwrap(), PNG);
        assert!(copy_into(d.path(), &["../x.png".into()], &dest).is_err());

        std::fs::write(dir(d.path()).join("notes.txt"), "keep me").unwrap();
        let removed = sweep(d.path(), &HashSet::from([a.as_str()]));
        assert_eq!(removed, vec![dir(d.path()).join(&b)]);
        assert!(dir(d.path()).join("notes.txt").exists());

        remove(d.path(), std::slice::from_ref(&a));
        assert!(!dir(d.path()).join(&a).exists());
        assert!(copy_into(d.path(), &[a], &dest).is_err(), "a gone image fails the start");
    }

    #[test]
    fn import_copies_a_file() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("shot.png");
        std::fs::write(&src, PNG).unwrap();
        let n = import(d.path(), &src).unwrap();
        assert_eq!(read(d.path(), &n).unwrap(), PNG);
        assert!(src.exists());
        assert!(import(d.path(), &d.path().join("nope.png")).is_err());
    }
}
