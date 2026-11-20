//! The phone remote's source (`remote/`), carried in the app so Settings can deploy it with the
//! owner's `vercel` CLI. Tests and their helpers stay behind. The list is checked against the
//! folder by a test: add a file there, add it here.

/// Path inside the project, and the file.
pub const FILES: &[(&str, &[u8])] = &[
    (".gitignore", include_bytes!("../../../remote/.gitignore")),
    ("app/api/act/route.ts", include_bytes!("../../../remote/app/api/act/route.ts")),
    ("app/api/board/[[...path]]/route.ts", include_bytes!("../../../remote/app/api/board/[[...path]]/route.ts")),
    ("app/api/pair/route.ts", include_bytes!("../../../remote/app/api/pair/route.ts")),
    ("app/api/push/route.ts", include_bytes!("../../../remote/app/api/push/route.ts")),
    ("app/api/queue/route.ts", include_bytes!("../../../remote/app/api/queue/route.ts")),
    ("app/api/version/route.ts", include_bytes!("../../../remote/app/api/version/route.ts")),
    ("app/globals.css", include_bytes!("../../../remote/app/globals.css")),
    ("app/layout.tsx", include_bytes!("../../../remote/app/layout.tsx")),
    ("app/manifest.ts", include_bytes!("../../../remote/app/manifest.ts")),
    ("app/page.tsx", include_bytes!("../../../remote/app/page.tsx")),
    ("app/pair/page.tsx", include_bytes!("../../../remote/app/pair/page.tsx")),
    ("app/ui/App.tsx", include_bytes!("../../../remote/app/ui/App.tsx")),
    ("app/ui/Card.tsx", include_bytes!("../../../remote/app/ui/Card.tsx")),
    ("app/ui/Pair.tsx", include_bytes!("../../../remote/app/ui/Pair.tsx")),
    ("app/ui/Queue.tsx", include_bytes!("../../../remote/app/ui/Queue.tsx")),
    ("app/ui/phone-api.ts", include_bytes!("../../../remote/app/ui/phone-api.ts")),
    ("lib/api.ts", include_bytes!("../../../remote/lib/api.ts")),
    ("lib/auth.ts", include_bytes!("../../../remote/lib/auth.ts")),
    ("lib/board.ts", include_bytes!("../../../remote/lib/board.ts")),
    ("lib/crypto.ts", include_bytes!("../../../remote/lib/crypto.ts")),
    ("lib/phone.ts", include_bytes!("../../../remote/lib/phone.ts")),
    ("lib/push.ts", include_bytes!("../../../remote/lib/push.ts")),
    ("lib/queue.ts", include_bytes!("../../../remote/lib/queue.ts")),
    ("lib/records.ts", include_bytes!("../../../remote/lib/records.ts")),
    ("lib/types.ts", include_bytes!("../../../remote/lib/types.ts")),
    ("next.config.mjs", include_bytes!("../../../remote/next.config.mjs")),
    ("package-lock.json", include_bytes!("../../../remote/package-lock.json")),
    ("package.json", include_bytes!("../../../remote/package.json")),
    ("public/icon-192.png", include_bytes!("../../../remote/public/icon-192.png")),
    ("public/icon-512.png", include_bytes!("../../../remote/public/icon-512.png")),
    ("public/icon.svg", include_bytes!("../../../remote/public/icon.svg")),
    ("public/sw.js", include_bytes!("../../../remote/public/sw.js")),
    ("tsconfig.json", include_bytes!("../../../remote/tsconfig.json")),
    ("vercel.json", include_bytes!("../../../remote/vercel.json")),
];

/// The remote's version, from its `package.json`.
pub fn version() -> String {
    FILES
        .iter()
        .find(|(p, _)| *p == "package.json")
        .and_then(|(_, b)| serde_json::from_slice::<serde_json::Value>(b).ok())
        .and_then(|v| v["version"].as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Writes the source into `dir` (emptied first), ready for `vercel deploy`.
pub fn write_to(dir: &std::path::Path) -> std::io::Result<()> {
    let _ = std::fs::remove_dir_all(dir);
    for (path, bytes) in FILES {
        let to = dir.join(path);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(to, bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on_disk(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let (p, name) = (e.path(), e.file_name().to_string_lossy().into_owned());
            if p.is_dir() {
                if !["node_modules", ".next", ".vercel"].contains(&name.as_str()) {
                    on_disk(&p, base, out);
                }
            } else if !(name.ends_with(".test.ts") || name.ends_with(".test.tsx") || name.ends_with(".tsbuildinfo") || ["fake.ts", "vitest.config.ts", "next-env.d.ts", ".env.local"].contains(&name.as_str())) {
                out.push(p.strip_prefix(base).unwrap().to_string_lossy().into_owned());
            }
        }
    }

    #[test]
    fn the_list_is_the_folder() {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../remote");
        let mut disk = Vec::new();
        on_disk(&base, &base, &mut disk);
        disk.sort();
        let listed: Vec<String> = FILES.iter().map(|(p, _)| p.to_string()).collect();
        assert_eq!(listed, disk, "remote/ and board/remote_src.rs differ");
    }

    #[test]
    fn it_writes_a_project_the_cli_can_deploy() {
        let dir = tempfile::tempdir().unwrap();
        let to = dir.path().join("src");
        std::fs::create_dir_all(to.join("stale")).unwrap();
        write_to(&to).unwrap();
        assert!(!to.join("stale").exists());
        for f in ["package.json", "vercel.json", "app/api/board/[[...path]]/route.ts", "lib/crypto.ts", "public/sw.js"] {
            assert!(to.join(f).is_file(), "{f}");
        }
        assert!(!to.join("lib/fake.ts").exists());
        assert_eq!(version(), "0.1.0");
    }
}
