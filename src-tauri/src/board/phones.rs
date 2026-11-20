//! Where the paired phones are kept: one item in the macOS Keychain, not a file. Any process of
//! the user can rewrite a file in the app's data folder, and this list decides who may answer
//! permission prompts.
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::remote::Phone;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    #[serde(default)]
    pub phones: Vec<Phone>,
    /// What the remote asks for before it registers its watcher (set at its first deploy).
    #[serde(default)]
    pub setup_secret: Option<String>,
    /// The builders lent to teammates. Here, not in settings: this list decides whose words may
    /// start an agent on this Mac.
    #[serde(default)]
    pub lends: Vec<super::borrow::Lend>,
    /// The nonces of borrow requests taken in the last day, with when (ms): a request is good once.
    #[serde(default)]
    pub borrow_nonces: Vec<(String, i64)>,
}

pub fn encode(s: &Secrets) -> Vec<u8> {
    serde_json::to_vec(s).unwrap_or_default()
}

/// An item that cannot be read is an error, never "no phones": the owner is told.
pub fn decode(bytes: &[u8]) -> Result<Secrets, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("the saved list of phones is damaged: {e}"))
}

pub trait SecretStore: Send + Sync {
    /// The saved secrets; empty when nothing was ever saved.
    fn load(&self) -> Result<Secrets, String>;
    fn save(&self, s: &Secrets) -> Result<(), String>;
}

/// For tests, and for platforms with no Keychain.
#[derive(Default)]
pub struct MemoryStore(Mutex<Option<Vec<u8>>>);

impl SecretStore for MemoryStore {
    fn load(&self) -> Result<Secrets, String> {
        match self.0.lock().unwrap_or_else(|e| e.into_inner()).as_deref() {
            Some(b) => decode(b),
            None => Ok(Secrets::default()),
        }
    }
    fn save(&self, s: &Secrets) -> Result<(), String> {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(encode(s));
        Ok(())
    }
}

/// The login Keychain's generic password `service` / `phones`.
pub struct Keychain {
    pub service: String,
}

const ACCOUNT: &str = "phones";

impl Keychain {
    /// The app's own item.
    pub fn app() -> Keychain {
        Keychain { service: "dev.clashofclaudes.desktop.remote".into() }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    /// `errSecItemNotFound`.
    const NOT_FOUND: i32 = -25300;

    impl SecretStore for Keychain {
        fn load(&self) -> Result<Secrets, String> {
            match get_generic_password(&self.service, ACCOUNT) {
                Ok(bytes) => decode(&bytes),
                Err(e) if e.code() == NOT_FOUND => Ok(Secrets::default()),
                Err(e) => Err(format!("the Keychain could not be read: {e}")),
            }
        }
        fn save(&self, s: &Secrets) -> Result<(), String> {
            set_generic_password(&self.service, ACCOUNT, &encode(s)).map_err(|e| format!("the Keychain could not be written: {e}"))
        }
    }

    impl Keychain {
        pub fn delete(&self) -> Result<(), String> {
            delete_generic_password(&self.service, ACCOUNT).map_err(|e| e.to_string())
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl SecretStore for Keychain {
    fn load(&self) -> Result<Secrets, String> {
        Err("paired phones need the macOS Keychain".into())
    }
    fn save(&self, _: &Secrets) -> Result<(), String> {
        Err("paired phones need the macOS Keychain".into())
    }
}
