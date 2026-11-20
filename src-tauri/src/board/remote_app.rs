//! The phone remote on the Mac: takes what the listener hears, checks it against the paired
//! phones and the prompt this Mac described, applies it to the session and writes the result back.
//! Also pairing, the paired list and the heartbeat. `Remote` has no Tauri in it; the glue at the
//! end joins it to the app.
use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::cli::MsgWrite;
use super::listen::Event;
use super::pairing::{phone_record, village_text, PairState, Pairing};
use super::phones::{SecretStore, Secrets};
use super::publisher::{Publisher, Sent};
use super::remote::{judge, parse_action, sha_hex, signed_bytes, Action, Do, Open, Phone, PromptBlock, Verdict};

/// How often the Mac says it is there (the village root's `seen`).
pub const HEARTBEAT_MS: i64 = 300_000;
/// How many applied actions are remembered, so none is applied twice.
const SEEN_MAX: usize = 500;

/// The board, as the remote needs it (the publisher, or a fake).
pub trait Outbox: Send + Sync {
    fn send(&self, w: MsgWrite, done: Option<Sent>);
    fn open_block(&self, session_id: &str) -> Option<(String, i64)>;
    fn session_for_root(&self, root: &str) -> Option<String>;
}

impl Outbox for Publisher {
    fn send(&self, w: MsgWrite, done: Option<Sent>) {
        Publisher::send(self, w, done)
    }
    fn open_block(&self, session_id: &str) -> Option<(String, i64)> {
        Publisher::open_block(self, session_id)
    }
    fn session_for_root(&self, root: &str) -> Option<String> {
        Publisher::session_for_root(self, root)
    }
}

/// The sessions, as the remote needs them (the session manager, or a fake). Errors that say
/// `stale` mean the wait had moved on.
pub trait Sessions: Send + Sync {
    /// The session's `state_since`; None when there is no such session.
    fn since(&self, id: &str) -> Option<i64>;
    fn approve_if(&self, id: &str, since: i64) -> Result<(), String>;
    fn deny_if(&self, id: &str, since: i64) -> Result<(), String>;
    fn prompt_if(&self, id: &str, since: i64, text: &str) -> Result<(), String>;
    fn pick_if(&self, id: &str, since: i64, pick: Option<usize>, text: &str) -> Result<(), String>;
}

/// Whose village this Mac is, on the board the app is connected to.
#[derive(Clone, Debug, PartialEq)]
pub struct Village {
    pub host: String,
    pub owner: String,
    /// The app's version, for the village root.
    pub version: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneView {
    pub key: String,
    pub name: String,
    pub paired_at: i64,
    pub last_used: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairView {
    /// `idle`, `open`, `asking`, `cancelled`.
    pub state: String,
    pub code: Option<String>,
    pub until: Option<i64>,
    /// The phone that asks, and the number it shows.
    pub name: Option<String>,
    pub check: Option<String>,
    /// Why it was cancelled.
    pub why: Option<String>,
}

/// Settings › Team › Phone remote.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub phones: Vec<PhoneView>,
    pub pairing: PairView,
    pub listening: bool,
    /// Why actions are refused for now (the remote was redeployed by someone else).
    pub paused: Option<String>,
    /// When something that was not a paired phone last tried to act.
    pub last_refused_at: Option<i64>,
    pub keychain_error: Option<String>,
    /// Where the team's remote is deployed, once set up.
    pub url: Option<String>,
    /// The version of the remote this app carries.
    pub bundled_version: String,
}

/// `board-remote.json`: the actions already applied (hashes of what was signed).
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    seen: VecDeque<String>,
}

/// What a teammate did in this village, for the owner to see.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Acted {
    /// Their Vercel username.
    pub who: String,
    /// "allowed `Bash: npm test`", "answered Wizard", …
    pub what: String,
    pub at: i64,
}

struct Inner {
    village: Option<Village>,
    paused: Option<String>,
    /// The phone remote's own switch. Off: the owner's phones are refused; teammates still act.
    phones_on: bool,
    /// The last thing a teammate did here.
    acted: Option<Acted>,
    phones: Vec<Phone>,
    setup_secret: Option<String>,
    keychain_error: Option<String>,
    pairing: Pairing,
    seen: VecDeque<String>,
    last_refused_at: Option<i64>,
    /// The village root's message id, once posted.
    root: Option<String>,
    /// When the root last got its `seen`; None: it is due.
    beat_at: Option<i64>,
    /// The root's post is under way.
    rooting: bool,
}

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub struct Remote {
    board: Arc<dyn Outbox>,
    sessions: Arc<dyn Sessions>,
    secrets: Arc<dyn SecretStore>,
    saved_path: PathBuf,
    now: Clock,
    /// Called after anything Settings shows has changed.
    changed: Arc<dyn Fn() + Send + Sync>,
    inner: Arc<Mutex<Inner>>,
}

/// The text of the Mac's reply to an action.
pub fn result_text(action_id: &str, result: &str) -> String {
    serde_json::json!({ "re": action_id, "result": result }).to_string()
}

fn channel(owner: &str) -> String {
    format!("v/{owner}/remote")
}

fn kv(k: &str, v: &str) -> (String, String) {
    (k.to_string(), v.to_string())
}

fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(|e| e.into_inner())
}

impl Remote {
    pub fn new(board: Arc<dyn Outbox>, sessions: Arc<dyn Sessions>, secrets: Arc<dyn SecretStore>, saved_path: PathBuf, now: Clock, changed: Arc<dyn Fn() + Send + Sync>) -> Remote {
        let saved: Saved = std::fs::read(&saved_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let inner = Inner {
            village: None,
            paused: None,
            phones_on: true,
            acted: None,
            phones: vec![],
            setup_secret: None,
            keychain_error: None,
            pairing: Pairing::default(),
            seen: saved.seen,
            last_refused_at: None,
            root: None,
            beat_at: None,
            rooting: false,
        };
        Remote { board, sessions, secrets, saved_path, now, changed, inner: Arc::new(Mutex::new(inner)) }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }

    /// On (with the village it serves) or off, and whether its actions are refused for now. The
    /// paired phones are read from the Keychain when it comes on.
    pub fn configure(&self, village: Option<Village>, paused: Option<String>) {
        let was_off = {
            let mut g = self.lock();
            let was_off = g.village.is_none();
            if g.village != village {
                // another village or board: its root and any open pairing are not this one's
                g.root = None;
                g.beat_at = None;
                g.pairing = Pairing::default();
            }
            g.village = village.clone();
            g.paused = paused;
            was_off
        };
        if village.is_some() && was_off {
            self.reload();
        }
        (self.changed)();
    }

    /// The phone remote's switch: off refuses the owner's phones and stops its heartbeat;
    /// teammates' paired Macs are not affected.
    pub fn set_phones_on(&self, on: bool) {
        self.lock().phones_on = on;
    }

    /// The last thing a teammate did in this village.
    pub fn acted(&self) -> Option<Acted> {
        self.lock().acted.clone()
    }

    /// The owner changed an invite's level: the teammate's paired key follows at once. Nothing
    /// to do when their Mac is not paired yet.
    pub fn set_mate_level(&self, email: &str, level: crate::model::Level) -> Result<(), String> {
        let mut g = self.lock();
        let mut changed = false;
        for p in g.phones.iter_mut().filter(|p| p.who.as_ref().is_some_and(|w| w.email == email)) {
            p.level = Some(level);
            changed = true;
        }
        if changed { self.save_secrets(&mut g) } else { Ok(()) }
    }

    /// The owner removed an invite: that teammate's key is gone from this moment.
    pub fn remove_mate(&self, email: &str) -> Result<(), String> {
        let mut g = self.lock();
        let before = g.phones.len();
        g.phones.retain(|p| p.who.as_ref().is_none_or(|w| w.email != email));
        if g.phones.len() != before { self.save_secrets(&mut g) } else { Ok(()) }
    }

    /// Reads the paired phones again.
    pub fn reload(&self) {
        let loaded = self.secrets.load();
        let mut g = self.lock();
        match loaded {
            Ok(s) => {
                g.phones = s.phones;
                g.setup_secret = s.setup_secret;
                g.keychain_error = None;
            }
            Err(e) => {
                // unreadable is not "none paired, carry on": nobody acts, and the owner is told
                g.phones.clear();
                g.keychain_error = Some(e);
            }
        }
    }

    fn save_secrets(&self, g: &mut Inner) -> Result<(), String> {
        let r = self.secrets.save(&Secrets { phones: g.phones.clone(), setup_secret: g.setup_secret.clone() });
        g.keychain_error = r.clone().err();
        r
    }

    pub fn setup_secret(&self) -> Option<String> {
        self.lock().setup_secret.clone()
    }

    pub fn set_setup_secret(&self, secret: String) -> Result<(), String> {
        let mut g = self.lock();
        g.setup_secret = Some(secret);
        self.save_secrets(&mut g)
    }

    pub fn status(&self) -> RemoteStatus {
        let g = self.lock();
        let pairing = match g.pairing.state() {
            PairState::Idle => PairView { state: "idle".into(), ..Default::default() },
            PairState::Open { code, until } => PairView { state: "open".into(), code: Some(code.clone()), until: Some(*until), ..Default::default() },
            PairState::Asking(r) => PairView { state: "asking".into(), name: Some(r.name.clone()), check: Some(r.check.clone()), ..Default::default() },
            PairState::Cancelled(why) => PairView { state: "cancelled".into(), why: Some(why.clone()), ..Default::default() },
        };
        RemoteStatus {
            phones: g.phones.iter().map(|p| PhoneView { key: p.key.clone(), name: p.name.clone(), paired_at: p.paired_at, last_used: p.last_used }).collect(),
            pairing,
            listening: false,
            paused: g.paused.clone(),
            last_refused_at: g.last_refused_at,
            keychain_error: g.keychain_error.clone(),
            url: None,
            bundled_version: String::new(),
        }
    }

    #[cfg(test)]
    fn seen_len(&self) -> usize {
        self.lock().seen.len()
    }

    fn send_all(&self, writes: impl IntoIterator<Item = MsgWrite>) {
        for w in writes {
            self.board.send(w, None);
        }
    }

    /// One event of the village's log. Called on the listener's thread; may take a moment (a
    /// follow-up is typed with a pause before Enter).
    pub fn handle(&self, e: Event) {
        if e.kind != "message.posted" {
            return;
        }
        if e.labels.get("coc.kind").map(String::as_str) == Some("pair") {
            let write = {
                let mut g = self.lock();
                if g.village.is_none() {
                    return;
                }
                let now = (self.now)();
                g.pairing.on_event(&e, now)
            };
            self.send_all(write);
            (self.changed)();
            return;
        }
        if !e.labels.contains_key("coc.do") {
            return;
        }
        // an action: a reply in the thread of a session this Mac published
        let Some(root) = e.thread_root.as_deref().filter(|r| *r != e.id) else { return };
        if self.lock().village.is_none() {
            return;
        }
        let Some(session) = self.board.session_for_root(root) else { return };
        // The remote checks an action before it posts it, so a phone never sends one that cannot
        // be read. Anything else carrying the label is someone's noise: no reply, no alarm.
        if parse_action(&e.text).is_none() {
            return;
        }
        let result = self.act(&session, &e.text);
        self.board.send(
            MsgWrite::ReplyTo { id: e.id.clone(), text: result_text(&e.id, result), labels: vec![kv("coc.kind", "result")], key: format!("coc-res-{}", e.id) },
            None,
        );
        (self.changed)();
    }

    /// Judges the action in `text` for `session` and applies it. The result's word.
    fn act(&self, session: &str, text: &str) -> &'static str {
        let now = (self.now)();
        let refuse = |g: &mut Inner| {
            g.last_refused_at = Some(now);
            Verdict::Refused.as_str()
        };
        let Some(action) = parse_action(text) else { return refuse(&mut self.lock()) };
        let open = self.board.open_block(session);
        let current = self.sessions.since(session);
        {
            let mut g = self.lock();
            let open = match (&open, current) {
                (Some((block, since)), Some(current_since)) => Some(Open { block_json: block, since: *since, current_since }),
                _ => None,
            };
            let seen: HashSet<String> = g.seen.iter().cloned().collect();
            let hash = sha_hex(&signed_bytes(&action));
            let verdict = judge(&action, &g.phones, open, &seen, g.paused.is_some() || !g.phones_on);
            match verdict {
                Verdict::Refused => return refuse(&mut g),
                Verdict::Stale => return verdict.as_str(),
                Verdict::Apply => {
                    // taken before it is applied: heard again meanwhile, it is stale
                    g.seen.push_back(hash.clone());
                    while g.seen.len() > SEEN_MAX {
                        g.seen.pop_front();
                    }
                    if let Ok(bytes) = serde_json::to_vec(&Saved { seen: g.seen.clone() }) {
                        let _ = std::fs::write(&self.saved_path, bytes);
                    }
                    if let Some(p) = g.phones.iter_mut().find(|p| p.key == action.key) {
                        p.last_used = now;
                    }
                    let _ = self.save_secrets(&mut g);
                }
            }
        }
        let since = open.map(|(_, s)| s).unwrap_or_default();
        let block = self.board.open_block(session);
        let question = block.as_ref().and_then(|(b, _)| serde_json::from_str::<PromptBlock>(b).ok()).and_then(|b| b.question);
        match self.apply(session, since, &action, open_has_options(block)) {
            Ok(()) => {
                // a teammate did this, not the owner: the owner is told who and what
                let mut g = self.lock();
                if let Some(who) = g.phones.iter().find(|p| p.key == action.key).and_then(|p| p.who.clone()) {
                    let verb = match action.r#do {
                        Do::Allow => "allowed",
                        Do::Deny => "denied",
                        Do::Answer => "answered",
                        Do::Followup => "sent a follow-up",
                    };
                    let what = match (&action.r#do, question) {
                        (Do::Allow | Do::Deny, Some(q)) => format!("{verb} `{q}`"),
                        _ => verb.to_string(),
                    };
                    g.acted = Some(Acted { who: who.handle, what, at: now });
                }
                "applied"
            }
            Err(e) if e.contains("stale") => Verdict::Stale.as_str(),
            Err(_) => "failed",
        }
    }

    fn apply(&self, session: &str, since: i64, a: &Action, picker: bool) -> Result<(), String> {
        let text = a.text.as_deref().unwrap_or("");
        match a.r#do {
            Do::Allow => self.sessions.approve_if(session, since),
            Do::Deny => self.sessions.deny_if(session, since),
            Do::Answer if picker => self.sessions.pick_if(session, since, a.pick, text),
            Do::Answer | Do::Followup => self.sessions.prompt_if(session, since, text),
        }
    }

    /// Opens a pairing; the code to show (never written to the board). `rng`: 64 random bits.
    pub fn pair_start(&self, rng: u64) -> Result<String, String> {
        let (write, code, stale) = {
            let mut g = self.lock();
            let v = g.village.clone().filter(|_| g.phones_on).ok_or("the phone remote is off")?;
            if let Some(e) = &g.keychain_error {
                return Err(e.clone());
            }
            let stale = g.pairing.cancel();
            let write = g.pairing.start((self.now)(), rng, &v.host, &v.owner);
            let PairState::Open { code, .. } = g.pairing.state() else { return Err("pairing did not open".into()) };
            (write, code.clone(), stale)
        };
        self.send_all(stale);
        let inner = self.inner.clone();
        let changed = self.changed.clone();
        self.board.send(
            write,
            Some(Box::new(move |id| {
                if let Some(id) = id {
                    lock(&inner).pairing.ticket_posted(id);
                }
                changed();
            })),
        );
        (self.changed)();
        Ok(code)
    }

    /// The owner saw the same number on the phone and pressed Confirm.
    pub fn pair_confirm(&self) -> Result<(), String> {
        let (phone, mut writes) = {
            let mut g = self.lock();
            let (phone, writes) = g.pairing.confirm((self.now)()).ok_or("no phone is waiting to be paired")?;
            g.phones.retain(|p| p.key != phone.key);
            g.phones.push(phone.clone());
            self.save_secrets(&mut g)?;
            (phone, writes)
        };
        let record = writes.remove(0);
        let inner = self.inner.clone();
        let secrets = self.secrets.clone();
        let key = phone.key.clone();
        self.board.send(
            record,
            Some(Box::new(move |id| {
                let mut g = lock(&inner);
                if let Some(p) = g.phones.iter_mut().find(|p| p.key == key) {
                    p.record = id;
                }
                let _ = secrets.save(&Secrets { phones: g.phones.clone(), setup_secret: g.setup_secret.clone() });
            })),
        );
        self.send_all(writes);
        (self.changed)();
        Ok(())
    }

    pub fn pair_cancel(&self) {
        let write = self.lock().pairing.cancel();
        self.send_all(write);
        (self.changed)();
    }

    /// Unpairs a phone: it cannot act from this moment; its record on the board says so next.
    pub fn remove_phone(&self, key: &str) -> Result<(), String> {
        let write = {
            let mut g = self.lock();
            let at = g.phones.iter().position(|p| p.key == key).ok_or("no such phone")?;
            let phone = g.phones.remove(at);
            self.save_secrets(&mut g)?;
            let host = g.village.as_ref().map(|v| v.host.clone()).unwrap_or_default();
            phone.record.clone().map(|id| MsgWrite::Edit { id, text: phone_record(&phone, "removed", &host) })
        };
        self.send_all(write);
        (self.changed)();
        Ok(())
    }

    /// Once a second or so: ends an expired pairing, and keeps the village root's `seen` fresh.
    pub fn tick(&self) {
        let now = (self.now)();
        let (expired, beat) = {
            let mut g = self.lock();
            let Some(v) = g.village.clone() else { return };
            let phones_on = g.phones_on;
            let expired = g.pairing.tick(now);
            let cancelled = expired.is_some() || matches!(g.pairing.state(), PairState::Cancelled(_));
            // the heartbeat in `remote` is for the phone remote's page: none while it is off
            let due = phones_on && g.beat_at.is_none_or(|at| now - at >= HEARTBEAT_MS);
            let beat = match (g.root.clone(), due) {
                (Some(id), true) => {
                    g.beat_at = Some(now);
                    Some(MsgWrite::Edit { id, text: village_text(&v.host, &v.version, now) })
                }
                (None, true) if !g.rooting => {
                    g.rooting = true;
                    Some(MsgWrite::Post {
                        channel: channel(&v.owner),
                        text: village_text(&v.host, &v.version, now),
                        labels: vec![kv("coc.kind", "village"), kv("coc.host", &v.host)],
                        key: format!("coc-village-{}", v.host),
                    })
                }
                _ => None,
            };
            (expired.filter(|_| cancelled), beat)
        };
        let had_expiry = expired.is_some();
        self.send_all(expired);
        match beat {
            Some(post @ MsgWrite::Post { .. }) => {
                let inner = self.inner.clone();
                self.board.send(
                    post,
                    Some(Box::new(move |id| {
                        let mut g = lock(&inner);
                        g.rooting = false;
                        // The board gives back the same root for the same key, with its old text:
                        // the next tick edits it. Not delivered: the next tick posts again.
                        g.root = id;
                        g.beat_at = None;
                    })),
                );
            }
            Some(edit) => self.board.send(edit, None),
            None => {}
        }
        if had_expiry {
            (self.changed)();
        }
    }
}

/// Whether the open wait is a picker (an answer is then a pick, or words in place of one).
fn open_has_options(open: Option<(String, i64)>) -> bool {
    open.and_then(|(b, _)| serde_json::from_str::<PromptBlock>(&b).ok()).is_some_and(|b| b.options.is_some())
}

#[cfg(test)]
#[path = "remote_app_tests.rs"]
mod tests;
