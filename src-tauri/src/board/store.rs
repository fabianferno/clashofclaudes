//! `board.json`, beside the settings: what the board last got for each session. It is what makes
//! restarts and retries exact.
use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::Published;

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Store {
    /// By session id.
    #[serde(default)]
    pub sessions: BTreeMap<String, Published>,
}

impl Store {
    /// The saved records; none when the file is missing or unreadable (the board's idempotency
    /// keys then lead back to the threads that exist).
    pub fn load(path: &Path) -> Store {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    /// Writes beside the target, then renames over it.
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::Wire;

    #[test]
    fn store_round_trips_and_survives_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board.json");
        assert_eq!(Store::load(&path), Store::default());

        let mut s = Store::default();
        s.sessions.insert(
            "s1".into(),
            Published { board: "/village".into(), channel: "v/ada/w/api".into(), root: Some("msg_1".into()), state: Wire::NeedsYou, wait: None, since: 5, titled: true, unshared: false, block: None },
        );
        s.save(&path).unwrap();
        assert_eq!(Store::load(&path), s);

        std::fs::write(&path, "not json").unwrap();
        assert_eq!(Store::load(&path), Store::default());
    }
}
