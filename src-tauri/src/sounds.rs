//! The village's sounds: which moments play one, the macOS system sounds on offer, copies of the
//! owner's own sound files in the data folder, and playing a file (macOS `afplay`, detached).
//!
//! Sounds come from this app only; it never touches an agent's own hooks or settings.

use anyhow::{Context, Result, bail};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The moments that can play a sound (keys of `Settings::sounds`; see `src/state/sounds.ts`).
pub const MOMENTS: [&str; 9] = ["decide", "answer", "finished", "stuck", "start", "minion", "working", "xp", "levelUp"];

pub const SYSTEM_DIR: &str = "/System/Library/Sounds";

/// Audio files the owner can bring.
const EXTENSIONS: [&str; 8] = ["aiff", "aif", "mp3", "wav", "m4a", "caf", "aac", "flac"];

/// Largest sound file copied in.
const MAX_BYTES: u64 = 10 * 1024 * 1024;

fn system(name: &str) -> String {
    format!("{SYSTEM_DIR}/{name}.aiff")
}

/// What each moment plays on a fresh install: system sounds every Mac has; "" is silent.
pub fn default_sounds() -> BTreeMap<String, String> {
    let pick = |m: &str| match m {
        "decide" => system("Morse"),
        "answer" => system("Blow"),
        "finished" => system("Hero"),
        "start" => system("Glass"),
        "minion" => system("Pop"),
        "xp" => system("Bottle"),
        "levelUp" => system("Submarine"),
        _ => String::new(),
    };
    MOMENTS.iter().map(|m| (m.to_string(), pick(m))).collect()
}

/// Known moments only, every one present (missing ones get their default).
pub fn normalized(mut sounds: BTreeMap<String, String>) -> BTreeMap<String, String> {
    sounds.retain(|k, _| MOMENTS.contains(&k.as_str()));
    for (k, v) in default_sounds() {
        sounds.entry(k).or_insert(v);
    }
    for v in sounds.values_mut() {
        *v = v.trim().to_string();
    }
    sounds
}

fn is_audio(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// The system sounds' names (`Basso`, `Blow`, ...), sorted.
pub fn system_sounds() -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(SYSTEM_DIR)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| is_audio(p))
                .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("sounds")
}

/// A file name safe to keep: letters, digits, `-`, `_`, `.` and spaces; the rest become `_`.
fn safe_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_alphanumeric() || "-_. ".contains(c) { c } else { '_' }).collect();
    let s = s.trim_start_matches('.').trim().to_string();
    if s.is_empty() { "sound".into() } else { s }
}

/// Copies an audio file into the data folder's `sounds/`, so it keeps playing if the original
/// moves; returns the copy's path. The same name again replaces the earlier copy.
pub fn import(data_dir: &Path, src: &Path) -> Result<PathBuf> {
    if !is_audio(src) {
        bail!("not a sound file this app can play ({})", EXTENSIONS.join(", "));
    }
    let meta = std::fs::metadata(src).with_context(|| format!("cannot read {}", src.display()))?;
    if !meta.is_file() {
        bail!("{} is not a file", src.display());
    }
    if meta.len() > MAX_BYTES {
        bail!("the sound is larger than {} MB", MAX_BYTES / (1024 * 1024));
    }
    let name = safe_name(src.file_name().and_then(|n| n.to_str()).unwrap_or("sound"));
    let d = dir(data_dir);
    std::fs::create_dir_all(&d)?;
    let dest = d.join(name);
    if dest != src {
        std::fs::copy(src, &dest).with_context(|| format!("cannot copy {}", src.display()))?;
    }
    Ok(dest)
}

/// `afplay`'s volume (0.0 to 1.0, its default 1.0) for a 0-100 setting.
pub fn afplay_volume(pct: u32) -> f32 {
    pct.min(100) as f32 / 100.0
}

/// Plays an audio file at `volume` (0-100) without waiting for it; the player is reaped on a thread.
pub fn play(path: &Path, volume: u32) -> Result<()> {
    if volume == 0 {
        return Ok(());
    }
    if !is_audio(path) || !path.is_file() {
        bail!("no sound file at {}", path.display());
    }
    #[cfg(target_os = "macos")]
    {
        let mut child = std::process::Command::new("/usr/bin/afplay")
            .arg("-v")
            .arg(format!("{:.2}", afplay_volume(volume)))
            .arg(path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .context("cannot start afplay")?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_cover_every_moment_and_normalizing_keeps_choices_and_drops_unknowns() {
        let d = default_sounds();
        assert_eq!(d.len(), MOMENTS.len());
        assert_eq!(d["decide"], "/System/Library/Sounds/Morse.aiff");
        assert_eq!(d["working"], "", "silent by default");
        let mut mine = BTreeMap::new();
        mine.insert("finished".to_string(), " /x/ding.mp3 ".to_string());
        mine.insert("bogus".to_string(), "/x/y.mp3".to_string());
        let n = normalized(mine);
        assert_eq!(n["finished"], "/x/ding.mp3");
        assert!(!n.contains_key("bogus"));
        assert_eq!(n["answer"], d["answer"], "missing moments get their default");
    }

    #[test]
    fn import_copies_audio_into_the_data_folder_and_refuses_the_rest() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("my fireworks!.mp3");
        std::fs::write(&src, b"ID3fake").unwrap();
        let copy = import(d.path(), &src).unwrap();
        assert_eq!(copy, dir(d.path()).join("my fireworks_.mp3"));
        assert_eq!(std::fs::read(&copy).unwrap(), b"ID3fake");
        assert!(src.exists(), "the original stays");
        let txt = d.path().join("notes.txt");
        std::fs::write(&txt, b"hi").unwrap();
        assert!(import(d.path(), &txt).is_err());
        assert!(import(d.path(), &d.path().join("gone.mp3")).is_err());
    }

    #[test]
    fn play_refuses_missing_or_non_audio_files_and_volume_zero_is_silent() {
        assert!(play(Path::new("/nope/none.mp3"), 50).is_err());
        assert!(play(Path::new("/etc/hosts"), 50).is_err());
        assert!(play(Path::new("/nope/none.mp3"), 0).is_ok());
        assert_eq!(afplay_volume(70), 0.7);
        assert_eq!(afplay_volume(300), 1.0);
    }

    #[test]
    fn safe_names_keep_readable_names() {
        assert_eq!(safe_name("halo_shields.mp3"), "halo_shields.mp3");
        assert_eq!(safe_name("../evil.mp3"), "_evil.mp3");
        assert_eq!(safe_name("..."), "sound");
    }
}
