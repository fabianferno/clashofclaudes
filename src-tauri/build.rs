fn main() {
    // The Discord webhook bug reports go to (see `bugreport.rs`): from COC_BUG_WEBHOOK, else from
    // the git-ignored `bug-webhook.txt`. Without either, the build has no bug reporting.
    println!("cargo:rerun-if-env-changed=COC_BUG_WEBHOOK");
    println!("cargo:rerun-if-changed=bug-webhook.txt");
    let url = std::env::var("COC_BUG_WEBHOOK")
        .ok()
        .or_else(|| std::fs::read_to_string("bug-webhook.txt").ok())
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    if let Some(url) = url {
        println!("cargo:rustc-env=COC_BUG_WEBHOOK={url}");
    }
    // The PostHog project key usage counts go to (see `usage.rs`): from COC_POSTHOG_KEY, else from
    // the git-ignored `posthog-key.txt`. Without either, the build sends no usage.
    println!("cargo:rerun-if-env-changed=COC_POSTHOG_KEY");
    println!("cargo:rerun-if-changed=posthog-key.txt");
    let key = std::env::var("COC_POSTHOG_KEY")
        .ok()
        .or_else(|| std::fs::read_to_string("posthog-key.txt").ok())
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    if let Some(key) = key {
        println!("cargo:rustc-env=COC_POSTHOG_KEY={key}");
    }
    tauri_build::build()
}
