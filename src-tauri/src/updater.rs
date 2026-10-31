//! Auto-update gating and outcome mapping. The updater is the app's only network access, so
//! every refusal here happens BEFORE any request is made (single source of truth).
use serde::Serialize;

/// The `pubkey` shipped in `tauri.conf.json` until the owner supplies a real one.
pub const PLACEHOLDER_PUBKEY: &str = "REPLACE_WITH_UPDATER_PUBLIC_KEY";

/// What `check_for_update` returns to the frontend.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
}

impl UpdateStatus {
    pub fn none() -> Self {
        Self { available: false, version: None, notes: None }
    }
}

/// The repository part of the shipped placeholder endpoint
/// (`https://github.com/OWNER/REPO/releases/latest/download/latest.json`).
pub const PLACEHOLDER_REPO: &str = "OWNER/REPO";

/// `Ok(())` when a check may touch the network; otherwise `Err("disabled")`.
/// Disabled when: debug build, empty/placeholder pubkey, no endpoint or any endpoint still
/// naming the placeholder repository, or the user turned updates off.
pub fn gate(debug_build: bool, pubkey: &str, endpoints: &[&str], updates_enabled: bool) -> Result<(), &'static str> {
    let key = pubkey.trim();
    let unconfigured = endpoints.is_empty() || endpoints.iter().any(|e| e.trim().is_empty() || e.contains(PLACEHOLDER_REPO));
    if debug_build || key.is_empty() || key == PLACEHOLDER_PUBKEY || unconfigured || !updates_enabled {
        return Err("disabled");
    }
    Ok(())
}

/// Maps a finished check to the UI status. Any failure (network, signature, parse) is logged and
/// reported as "no update": the UI stays silent.
pub fn outcome<E: std::fmt::Display>(r: Result<Option<(String, Option<String>)>, E>) -> UpdateStatus {
    match r {
        Ok(Some((version, notes))) => UpdateStatus { available: true, version: Some(version), notes },
        Ok(None) => UpdateStatus::none(),
        Err(e) => {
            eprintln!("update check failed: {e}");
            UpdateStatus::none()
        }
    }
}

/// What to do after an update was installed: restart now, or ask first because sessions run.
#[derive(Debug, PartialEq)]
pub enum RestartPlan {
    Now,
    AskUser { live: usize },
}

/// Reuses the quit guard's rule (`should_block_exit`) so restarting never kills sessions unasked.
pub fn restart_plan(live: usize) -> RestartPlan {
    if crate::commands::should_block_exit(live, false) { RestartPlan::AskUser { live } } else { RestartPlan::Now }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &[&str] = &["https://github.com/someone/clashofclaudes/releases/latest/download/latest.json"];

    #[test]
    fn placeholder_pubkey_disables_checks() {
        assert_eq!(gate(false, PLACEHOLDER_PUBKEY, REAL, true), Err("disabled"));
        assert_eq!(gate(false, "  ", REAL, true), Err("disabled"));
        assert_eq!(gate(true, "RWQrealkey", REAL, true), Err("disabled"), "debug build");
        assert_eq!(gate(false, "RWQrealkey", REAL, true), Ok(()));
    }

    #[test]
    fn placeholder_endpoint_disables_checks() {
        let shipped = "https://github.com/OWNER/REPO/releases/latest/download/latest.json";
        assert_eq!(gate(false, "RWQrealkey", &[shipped], true), Err("disabled"), "a real key alone is not enough");
        assert_eq!(gate(false, "RWQrealkey", &[REAL[0], shipped], true), Err("disabled"));
        assert_eq!(gate(false, "RWQrealkey", &[], true), Err("disabled"), "no endpoint");
        assert_eq!(gate(false, "RWQrealkey", &[" "], true), Err("disabled"));
        // The shipped config really is the placeholder pair.
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let eps: Vec<&str> = conf["plugins"]["updater"]["endpoints"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        let key = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
        assert_eq!(gate(false, key, &eps, true), Err("disabled"));
        assert_eq!(gate(false, "RWQrealkey", &eps, true), Err("disabled"));
    }

    #[test]
    fn settings_toggle_disables_updates() {
        assert_eq!(gate(false, "RWQrealkey", REAL, false), Err("disabled"));
        let mut d = crate::model::AppData::default();
        assert!(d.settings.updates_enabled);
        d.settings.updates_enabled = false;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        crate::persist::save(&p, &d).unwrap();
        assert!(!crate::persist::load(&p).settings.updates_enabled, "persisted");
    }

    #[test]
    fn update_check_failure_is_silent() {
        assert_eq!(outcome::<String>(Err("signature mismatch".into())), UpdateStatus::none());
        assert_eq!(outcome::<String>(Ok(None)), UpdateStatus::none());
        let s = outcome::<String>(Ok(Some(("1.2.0".into(), Some("fixes".into())))));
        assert_eq!((s.available, s.version.as_deref(), s.notes.as_deref()), (true, Some("1.2.0"), Some("fixes")));
    }

    #[test]
    fn restart_goes_through_quit_guard() {
        assert_eq!(restart_plan(0), RestartPlan::Now);
        assert_eq!(restart_plan(3), RestartPlan::AskUser { live: 3 });
    }
}
