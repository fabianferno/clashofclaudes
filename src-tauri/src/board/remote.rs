//! The phone remote's rules, with no I/O: what a prompt offers a phone, how an action is signed,
//! and whether the Mac takes it (`docs/superpowers/specs/2026-11-20-web-remote-design.md`).
//!
//! The board and the web remote only carry messages. An action counts when a phone the owner
//! paired signed it, for the prompt this Mac itself last described.
use crate::model::{Level, SessionInfo, SessionKind, SessionState};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

/// A phone the owner paired with this Mac (kept in the Keychain).
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phone {
    /// `key_id` of `public`.
    pub key: String,
    /// The raw P-256 public key: 65 bytes, uncompressed.
    #[serde(with = "b64_bytes")]
    pub public: Vec<u8>,
    pub name: String,
    pub paired_at: i64,
    pub last_used: i64,
    /// Its record's message id on the board, once posted (edited when the phone is removed).
    #[serde(default)]
    pub record: Option<String>,
    /// None: one of the owner's own phones, which may do everything. Some: a teammate's Mac,
    /// held to this level. This entry, in the Keychain, is the only authority for it.
    #[serde(default)]
    pub level: Option<Level>,
    /// Whose Mac it is, for a teammate's key.
    #[serde(default)]
    pub who: Option<Mate>,
}

/// The teammate a paired key belongs to.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mate {
    pub email: String,
    /// Their Vercel username.
    pub handle: String,
    pub user_id: String,
}

/// Whether a key of this level may do `d` (None: the owner's own phone).
pub fn allows(level: Option<Level>, d: Do) -> bool {
    match level {
        None | Some(Level::Trusted) => true,
        Some(Level::Helper) => matches!(d, Do::Answer | Do::Followup | Do::Close),
        Some(Level::Visitor) => false,
    }
}

mod b64_bytes {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(b: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&super::b64(b))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        super::unb64(&String::deserialize(d)?).ok_or_else(|| serde::de::Error::custom("not base64url"))
    }
}

/// What a phone may do to a waiting session.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Do {
    Allow,
    Deny,
    Answer,
    Followup,
    /// The borrower of a finished borrowed session says it is done with it.
    Close,
}

impl Do {
    pub fn as_str(self) -> &'static str {
        match self {
            Do::Allow => "allow",
            Do::Deny => "deny",
            Do::Answer => "answer",
            Do::Followup => "followup",
            Do::Close => "close",
        }
    }
}

/// What the Mac says about one wait, at the end of its reply in the session's thread. The phone
/// shows it and signs its hash, so an answer is tied to exactly what was shown.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct PromptBlock {
    pub v: u8,
    pub host: String,
    pub session: String,
    pub since: i64,
    pub wait: String,
    pub can: Vec<Do>,
    #[serde(default)]
    pub question: Option<String>,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    /// For a borrowed session: the key id of the teammate it works for. Only that key (and the
    /// lender's own phones) may act on it. Left out for the owner's own sessions, whose blocks
    /// read exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

/// The one question of an open picker a phone can answer: single-select, with options.
fn single_picker(info: &SessionInfo) -> Option<&crate::model::AskQuestion> {
    match info.questions.as_slice() {
        [q] if !q.multi_select && !q.options.is_empty() => Some(q),
        _ => None,
    }
}

/// What the Mac will take from a phone for the session as it is now. `answerable`: the app has the
/// keys for the open permission prompt (`SessionManager::answerable`).
/// `borrowed`: the session works for a teammate; a finished one can then be closed by them.
pub fn can(info: &SessionInfo, answerable: bool, share_details: bool, borrowed: bool) -> Vec<Do> {
    if !matches!(info.kind, SessionKind::Agent { .. }) || info.paused || info.parked.is_some() {
        return vec![];
    }
    match info.state {
        SessionState::NeedsYou { .. } if info.awaiting_decision => {
            if answerable {
                vec![Do::Allow, Do::Deny]
            } else {
                vec![]
            }
        }
        // a picker is open: typing would land in it, so only a pick the phone can show
        SessionState::NeedsYou { .. } if !info.questions.is_empty() => {
            if share_details && single_picker(info).is_some() {
                vec![Do::Answer]
            } else {
                vec![]
            }
        }
        SessionState::NeedsYou { .. } => vec![Do::Answer],
        SessionState::Finished if borrowed => vec![Do::Followup, Do::Close],
        SessionState::Stuck { .. } | SessionState::Finished => vec![Do::Followup],
        _ => vec![],
    }
}

/// The prompt block for the session's current wait.
/// `by`: for a borrowed session, the key id of the teammate it works for.
pub fn block(info: &SessionInfo, session_id: &str, host: &str, wait: &str, answerable: bool, share_details: bool, by: Option<&str>) -> PromptBlock {
    let can = can(info, answerable, share_details, by.is_some());
    let (mut question, mut options) = (None, None);
    if share_details {
        if info.awaiting_decision {
            question = info.asking.clone();
        } else if let Some(q) = single_picker(info) {
            question = Some(q.question.clone());
            options = Some(q.options.iter().map(|o| o.label.clone()).collect());
        }
    }
    PromptBlock { v: 1, host: host.into(), session: session_id.into(), since: info.state_since, wait: wait.into(), can, question, options, by: by.map(str::to_string) }
}

/// The block's bytes: what is posted, hashed and signed. Never re-serialized on the way.
pub fn block_json(b: &PromptBlock) -> String {
    serde_json::to_string(b).unwrap_or_default()
}

const FENCE_OPEN: &str = "\n\n```json coc\n";
const FENCE_CLOSE: &str = "\n```";

/// The block as it ends a reply's text.
pub fn fenced(json: &str) -> String {
    format!("{FENCE_OPEN}{json}{FENCE_CLOSE}")
}

/// The block that ends `text`, exactly as written. Only the last one counts, and only at the end.
pub fn block_in(text: &str) -> Option<&str> {
    let body = text.strip_suffix(FENCE_CLOSE)?;
    let at = body.rfind(FENCE_OPEN)?;
    let json = &body[at + FENCE_OPEN.len()..];
    (!json.contains('\n')).then_some(json)
}

pub fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()
}

/// A short name for a public key: the start of its hash.
pub fn key_id(public: &[u8]) -> String {
    sha_hex(public)[..16].to_string()
}

/// The six digits the phone and the Mac both show while pairing (`482 913`).
pub fn check_number(public: &[u8], ticket_id: &str) -> String {
    let mut h = Sha256::new();
    h.update(public);
    h.update(ticket_id.as_bytes());
    let d = h.finalize();
    let n = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 1_000_000;
    format!("{:03} {:03}", n / 1000, n % 1000)
}

/// One action from a phone: the text of its reply in the session's thread.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Action {
    pub v: u8,
    pub r#do: Do,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pick: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub nonce: String,
    pub key: String,
    /// `sha_hex` of the prompt block the phone showed.
    pub prompt: String,
    pub sig: String,
}

pub fn parse_action(text: &str) -> Option<Action> {
    serde_json::from_str::<Action>(text.trim()).ok().filter(|a| a.v == 1)
}

/// What the phone signs.
pub fn signed_bytes(a: &Action) -> Vec<u8> {
    [
        "coc-act-1".to_string(),
        a.r#do.as_str().to_string(),
        a.pick.map(|p| p.to_string()).unwrap_or_default(),
        sha_hex(a.text.as_deref().unwrap_or("").as_bytes()),
        a.nonce.clone(),
        a.prompt.clone(),
    ]
    .join("\n")
    .into_bytes()
}

/// Half of P-256's group order, big-endian. A signature's `s` above it is the twin `(r, n-s)` of
/// one below: valid too, so anyone could repost an action as "another" signature.
const HALF_N: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b,
    0xcf, 0x42, 0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31, 0x92, 0xa8,
];

/// Whether a 64-byte `r‖s` signature has its `s` in the low half.
pub fn low_s(sig: &[u8]) -> bool {
    sig.len() == 64 && sig[32..] <= HALF_N[..]
}

/// Whether `sig` (base64url, `r‖s`) is `public`'s ECDSA P-256 / SHA-256 signature of `msg`.
pub fn verify(public: &[u8], msg: &[u8], sig_b64url: &str) -> bool {
    let Some(sig) = unb64(sig_b64url) else { return false };
    if !low_s(&sig) {
        return false;
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, public).verify(msg, &sig).is_ok()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verdict {
    Apply,
    /// The prompt it answers is no longer the open one (or was answered already).
    Stale,
    /// Not from a paired phone, or not something this prompt offers.
    Refused,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Apply => "applied",
            Verdict::Stale => "stale",
            Verdict::Refused => "refused",
        }
    }
}

/// What the Mac knows about the session an action's thread belongs to.
#[derive(Clone, Copy)]
pub struct Open<'a> {
    /// The prompt block the Mac last wrote for it.
    pub block_json: &'a str,
    /// That block's `since`.
    pub since: i64,
    /// The session's `state_since` now.
    pub current_since: i64,
}

/// Whether the Mac takes `a`. `seen`: hashes of the signed bytes of actions already applied.
/// `phones_off`: the phone remote is switched off, or not trusted right now (its deployment
/// changed). That stops the owner's phones only: a teammate's action never passes through it.
pub fn judge(a: &Action, phones: &[Phone], open: Option<Open<'_>>, seen: &HashSet<String>, phones_off: bool) -> Verdict {
    let Some(phone) = phones.iter().find(|p| p.key == a.key) else { return Verdict::Refused };
    if phone.level.is_none() && phones_off {
        return Verdict::Refused;
    }
    let signed = signed_bytes(a);
    if !verify(&phone.public, &signed, &a.sig) {
        return Verdict::Refused;
    }
    let Some(open) = open else { return Verdict::Stale };
    if a.prompt != sha_hex(open.block_json.as_bytes()) || open.current_since != open.since || seen.contains(&sha_hex(&signed)) {
        return Verdict::Stale;
    }
    let Ok(block) = serde_json::from_str::<PromptBlock>(open.block_json) else { return Verdict::Stale };
    if !block.can.contains(&a.r#do) || !allows(phone.level, a.r#do) {
        return Verdict::Refused;
    }
    // A borrowed session is its borrower's: other teammates, whatever their level, look only.
    // (The lender's own phones are not teammates and keep everything but Done.)
    if phone.level.is_some() && block.by.as_ref().is_some_and(|by| by != &a.key) {
        return Verdict::Refused;
    }
    // Done is the borrower's word on their own borrowed session; the lender closes in their app.
    if a.r#do == Do::Close && (phone.level.is_none() || block.by.as_ref() != Some(&a.key)) {
        return Verdict::Refused;
    }
    let words = a.text.as_deref().is_some_and(|t| !t.trim().is_empty());
    let fits = match (a.r#do, &block.options) {
        (Do::Allow | Do::Deny | Do::Close, _) => a.pick.is_none(),
        // a picker: one of its options, or words in place of them
        (Do::Answer, Some(options)) => match a.pick {
            Some(p) => p < options.len(),
            None => words,
        },
        (Do::Answer | Do::Followup, _) => a.pick.is_none() && words,
    };
    if fits {
        Verdict::Apply
    } else {
        Verdict::Refused
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
