//! This Mac's key: what signs a teammate's actions in a village they visit. The private half is
//! a key in the login Keychain, made the first time it is needed; a village's owner pairs its
//! public half and gives it a level.
use super::remote::b64;

/// P-256's group order, big-endian.
const N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9,
    0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
];

pub trait MacKey: Send + Sync {
    /// The raw public key: 65 bytes, uncompressed. Makes the key when there is none.
    fn public(&self) -> Result<Vec<u8>, String>;
    /// The public key when this Mac already has a key; never makes one (looking at a village
    /// should not leave anything in the Keychain).
    fn public_if_any(&self) -> Option<Vec<u8>> {
        self.public().ok()
    }
    /// ECDSA P-256 / SHA-256 of `msg`, as `r‖s` in base64url with `s` in the low half (what the
    /// owner's Mac accepts).
    fn sign(&self, msg: &[u8]) -> Result<String, String>;
}

/// One DER INTEGER at the start of `der`, as 32 big-endian bytes; and what follows it.
fn der_int(der: &[u8]) -> Option<([u8; 32], &[u8])> {
    let (&tag, rest) = der.split_first()?;
    let (&len, rest) = rest.split_first()?;
    let len = len as usize;
    if tag != 0x02 || len == 0 || len > 33 || rest.len() < len {
        return None;
    }
    let (mut digits, after) = rest.split_at(len);
    while digits.len() > 32 {
        // a leading zero keeps a high first bit from reading as negative
        if digits[0] != 0 {
            return None;
        }
        digits = &digits[1..];
    }
    let mut out = [0u8; 32];
    out[32 - digits.len()..].copy_from_slice(digits);
    Some((out, after))
}

/// `n - s`.
fn flipped(s: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = N[i] as i16 - s[i] as i16 - borrow;
        borrow = (d < 0) as i16;
        out[i] = (d + 256 * borrow) as u8;
    }
    out
}

/// An X9.62 DER signature (`SEQUENCE { r, s }`, what the Keychain makes) as raw `r‖s`, with a
/// high `s` replaced by its low twin `n - s`: the same signature in the one form that is accepted.
pub fn raw_low_s(der: &[u8]) -> Option<[u8; 64]> {
    let (&tag, rest) = der.split_first()?;
    let (&len, body) = rest.split_first()?;
    if tag != 0x30 || len as usize != body.len() || len >= 0x80 {
        return None;
    }
    let (r, rest) = der_int(body)?;
    let (mut s, rest) = der_int(rest)?;
    if !rest.is_empty() {
        return None;
    }
    let mut raw = [0u8; 64];
    raw[..32].copy_from_slice(&r);
    raw[32..].copy_from_slice(&s);
    if !super::remote::low_s(&raw) {
        s = flipped(&s);
        raw[32..].copy_from_slice(&s);
    }
    Some(raw)
}

/// A key held in memory: for tests, and never for a real pairing.
pub struct MemoryKey {
    pair: ring::signature::EcdsaKeyPair,
    rng: ring::rand::SystemRandom,
}

impl MemoryKey {
    pub fn new() -> MemoryKey {
        use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).expect("randomness");
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng).expect("a fresh key");
        MemoryKey { pair, rng }
    }
}

impl Default for MemoryKey {
    fn default() -> Self {
        Self::new()
    }
}

impl MacKey for MemoryKey {
    fn public(&self) -> Result<Vec<u8>, String> {
        use ring::signature::KeyPair;
        Ok(self.pair.public_key().as_ref().to_vec())
    }
    fn sign(&self, msg: &[u8]) -> Result<String, String> {
        let der = self.pair.sign(&self.rng, msg).map_err(|_| "could not sign")?;
        raw_low_s(der.as_ref()).map(|raw| b64(&raw)).ok_or_else(|| "the signature could not be read".to_string())
    }
}

/// The Mac's key in the login Keychain, found by its label; made when there is none.
pub struct KeychainKey {
    pub label: String,
}

impl KeychainKey {
    /// The app's own key.
    pub fn app() -> KeychainKey {
        KeychainKey { label: "Clash of Claudes: this Mac's village key".into() }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use security_framework::item::{ItemClass, ItemSearchOptions, KeyClass, Limit, Location, Reference, SearchResult};
    use security_framework::key::{Algorithm, GenerateKeyOptions, KeyType, SecKey};

    impl KeychainKey {
        fn find(&self) -> Result<Option<SecKey>, String> {
            let found = ItemSearchOptions::new().class(ItemClass::key()).key_class(KeyClass::private()).label(&self.label).load_refs(true).limit(Limit::Max(1)).search();
            let found = match found {
                Ok(f) => f,
                // errSecItemNotFound: no key yet
                Err(e) if e.code() == -25300 => vec![],
                Err(e) => return Err(format!("the Keychain could not be searched: {e}")),
            };
            Ok(found.into_iter().find_map(|r| match r {
                SearchResult::Ref(Reference::Key(k)) => Some(k),
                _ => None,
            }))
        }

        fn key(&self) -> Result<SecKey, String> {
            if let Some(k) = self.find()? {
                return Ok(k);
            }
            let mut options = GenerateKeyOptions::default();
            options.set_key_type(KeyType::ec()).set_size_in_bits(256).set_label(self.label.clone()).set_location(Location::DefaultFileKeychain);
            SecKey::new(&options).map_err(|e| format!("the Keychain could not make a key: {e}"))
        }

        /// Removes the key (tests).
        pub fn delete(&self) -> Result<(), String> {
            match self.find()? {
                Some(k) => k.delete().map_err(|e| e.to_string()),
                None => Ok(()),
            }
        }
    }

    impl MacKey for KeychainKey {
        fn public_if_any(&self) -> Option<Vec<u8>> {
            Some(self.find().ok()??.public_key()?.external_representation()?.to_vec())
        }
        fn public(&self) -> Result<Vec<u8>, String> {
            let public = self.key()?.public_key().ok_or("the key has no public half")?;
            Ok(public.external_representation().ok_or("the public key could not be read")?.to_vec())
        }
        fn sign(&self, msg: &[u8]) -> Result<String, String> {
            let der = self.key()?.create_signature(Algorithm::ECDSASignatureMessageX962SHA256, msg).map_err(|e| format!("the Keychain would not sign: {e}"))?;
            raw_low_s(&der).map(|raw| b64(&raw)).ok_or_else(|| "the signature could not be read".to_string())
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl MacKey for KeychainKey {
    fn public(&self) -> Result<Vec<u8>, String> {
        Err("acting in a teammate's village needs the macOS Keychain".into())
    }
    fn sign(&self, _: &[u8]) -> Result<String, String> {
        Err("acting in a teammate's village needs the macOS Keychain".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::remote::{low_s, unb64, verify};

    #[test]
    fn memory_key_signs_what_verify_accepts() {
        let k = MemoryKey::new();
        let public = k.public().unwrap();
        assert_eq!((public.len(), public[0]), (65, 4));
        for n in 0..40u8 {
            let msg = [b"coc-act-1\nallow\n".as_slice(), &[n]].concat();
            let sig = k.sign(&msg).unwrap();
            assert!(low_s(&unb64(&sig).unwrap()));
            assert!(verify(&public, &msg, &sig), "signature {n}");
            assert!(!verify(&public, b"something else", &sig));
        }
    }

    #[test]
    fn der_becomes_raw_r_s() {
        // r with a leading zero byte (high bit set), s short (leading zeros dropped by DER)
        let r = [0x80u8; 32];
        let s_short = [0x01u8, 0x02, 0x03];
        let mut der = vec![0x30, 0, 0x02, 33, 0x00];
        der.extend_from_slice(&r);
        der.extend_from_slice(&[0x02, 3]);
        der.extend_from_slice(&s_short);
        der[1] = (der.len() - 2) as u8;
        let raw = raw_low_s(&der).unwrap();
        assert_eq!(&raw[..32], &r);
        assert_eq!(&raw[32..61], &[0u8; 29]);
        assert_eq!(&raw[61..], &s_short);
        assert!(raw_low_s(&der[..der.len() - 1]).is_none(), "cut short");
        assert!(raw_low_s(&[0x31, 0x00]).is_none());
        assert!(raw_low_s(&[]).is_none());
    }

    #[test]
    fn a_high_s_is_flipped_and_still_verifies() {
        let k = MemoryKey::new();
        let public = k.public().unwrap();
        let msg = b"flip me";
        let low = unb64(&k.sign(msg).unwrap()).unwrap();
        // the high twin of that signature, as DER
        let mut s = [0u8; 32];
        s.copy_from_slice(&low[32..]);
        let high = flipped(&s);
        assert!(!low_s(&[&low[..32], &high[..]].concat()));
        let int = |v: &[u8]| {
            let v: Vec<u8> = v.iter().copied().skip_while(|b| *b == 0).collect();
            let mut out = vec![0x02, 0];
            if v.first().is_none_or(|b| b & 0x80 != 0) {
                out.push(0);
            }
            out.extend_from_slice(&v);
            out[1] = (out.len() - 2) as u8;
            out
        };
        let body = [int(&low[..32]), int(&high)].concat();
        let der = [vec![0x30, body.len() as u8], body].concat();
        let raw = raw_low_s(&der).unwrap();
        assert_eq!(&raw[..], &low[..], "back to the low form");
        assert!(verify(&public, msg, &b64(&raw)));
    }

    /// The real Keychain, under a label of its own. Run by hand:
    /// `cargo test --lib keychain_key_round_trip -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn keychain_key_round_trip() {
        let k = KeychainKey { label: format!("Clash of Claudes test key {}", uuid::Uuid::new_v4()) };
        let public = k.public().unwrap();
        assert_eq!((public.len(), public[0]), (65, 4));
        let sig = k.sign(b"hello").unwrap();
        assert!(verify(&public, b"hello", &sig));
        // found again, not made again
        assert_eq!(k.public().unwrap(), public);
        k.delete().unwrap();
        println!("KEYCHAIN KEY ok: {} bytes public", public.len());
    }
}
