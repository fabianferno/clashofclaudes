//! Pairing a phone with this Mac, with no I/O: the ticket the Mac posts, the request a phone
//! sends through the remote, and the owner's Confirm.
//!
//! The code the Mac shows is the secret: twelve characters the owner carries to the phone by eye
//! (or by the QR's address fragment), and that are never written to the board. The board gets a
//! name for the ticket derived from the code, and a request must carry a proof made with the code.
//! So someone who can post on the board, even with the owner's own login (their agents can), cannot
//! answer a pairing with a key of their own. The check number on both screens stays as a last look.
use serde_json::json;

use super::cli::MsgWrite;
use super::listen::Event;
use super::remote::{b64, check_number, key_id, sha_hex, unb64, Phone};
use sha2::{Digest, Sha256};

/// Crockford's base32: no I, L, O or U to misread.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A pairing code from 60 random bits: 12 characters.
pub fn code_of(rng: u64) -> String {
    (0..12).rev().map(|i| ALPHABET[((rng >> (5 * i)) & 31) as usize] as char).collect()
}

/// The ticket's name on the board. Finding the code from it means trying 2^60 codes.
pub fn ticket_id(code: &str) -> String {
    sha_hex(format!("coc-ticket\n{code}").as_bytes())[..16].to_string()
}

/// What a phone that was given `code` sends with its key and name (HMAC-SHA256, base64url).
pub fn proof(code: &str, public: &[u8], name: &str) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &Sha256::digest(format!("coc-proof\n{code}").as_bytes()));
    let mut msg = public.to_vec();
    msg.extend_from_slice(name.as_bytes());
    b64(ring::hmac::sign(&key, &msg).as_ref())
}

fn proves(code: &str, public: &[u8], name: &str, mac: &str) -> bool {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &Sha256::digest(format!("coc-proof\n{code}").as_bytes()));
    let mut msg = public.to_vec();
    msg.extend_from_slice(name.as_bytes());
    unb64(mac).is_some_and(|tag| ring::hmac::verify(&key, &msg, &tag).is_ok())
}

/// How long a pairing code stays open.
pub const TICKET_MS: i64 = 300_000;
const NAME_MAX: usize = 40;

/// A phone asking to be paired.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    /// The request's message id.
    pub id: String,
    pub name: String,
    pub public: Vec<u8>,
    /// What the phone shows too (`482 913`).
    pub check: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PairState {
    Idle,
    /// The code is shown; no phone has answered.
    Open { code: String, until: i64 },
    /// One phone answered: the owner confirms or cancels.
    Asking(Request),
    /// It ended without a phone; why, for Settings.
    Cancelled(String),
}

/// The ticket behind an open pairing.
#[derive(Clone, Debug)]
struct Ticket {
    host: String,
    owner: String,
    code: String,
    until: i64,
    /// Its message id, once posted.
    id: Option<String>,
}

impl Ticket {
    fn text(&self, state: &str) -> String {
        json!({ "host": self.host, "id": ticket_id(&self.code), "until": self.until, "state": state }).to_string()
    }

    fn close(&self) -> Option<MsgWrite> {
        self.id.clone().map(|id| MsgWrite::Edit { id, text: self.text("closed") })
    }
}

pub struct Pairing {
    state: PairState,
    ticket: Option<Ticket>,
}

impl Default for Pairing {
    fn default() -> Self {
        Pairing { state: PairState::Idle, ticket: None }
    }
}

fn channel(owner: &str) -> String {
    format!("v/{owner}/remote")
}

fn kv(k: &str, v: &str) -> (String, String) {
    (k.to_string(), v.to_string())
}

impl Pairing {
    pub fn state(&self) -> &PairState {
        &self.state
    }

    /// Opens a pairing: the ticket to post. `rng`: 64 random bits, 60 of which become the code.
    pub fn start(&mut self, now: i64, rng: u64, host: &str, owner: &str) -> MsgWrite {
        let code = code_of(rng);
        let t = Ticket { host: host.into(), owner: owner.into(), code: code.clone(), until: now + TICKET_MS, id: None };
        let write = MsgWrite::Post {
            channel: channel(owner),
            text: t.text("open"),
            labels: vec![kv("coc.kind", "pair-open"), kv("coc.code", &ticket_id(&code)), kv("coc.host", host)],
            key: format!("coc-pair-{host}-{now}"),
        };
        self.state = PairState::Open { code, until: t.until };
        self.ticket = Some(t);
        write
    }

    /// The ticket's message id, once the board has it. Requests are replies to it.
    pub fn ticket_posted(&mut self, id: String) {
        if let Some(t) = self.ticket.as_mut() {
            t.id = Some(id);
        }
    }

    /// A message from the village's log. A request under the open ticket that proves it was made
    /// with the code asks the owner. A second such request (two phones were given the code) ends
    /// the pairing: the ticket's closing edit. Requests without the proof are not requests.
    pub fn on_event(&mut self, e: &Event, _now: i64) -> Option<MsgWrite> {
        let ticket = self.ticket.as_ref()?;
        let ticket_id = ticket.id.as_deref()?;
        if e.kind != "message.posted" || e.labels.get("coc.kind").map(String::as_str) != Some("pair") || e.thread_root.as_deref() != Some(ticket_id) || e.id == ticket_id {
            return None;
        }
        let v: serde_json::Value = serde_json::from_str(&e.text).ok()?;
        let public = unb64(v.get("public")?.as_str()?)?;
        // an uncompressed P-256 point
        if public.len() != 65 || public[0] != 4 {
            return None;
        }
        let sent_name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if !proves(&ticket.code, &public, sent_name, v.get("mac").and_then(|m| m.as_str()).unwrap_or("")) {
            return None;
        }
        let name: String = sent_name.trim().chars().take(NAME_MAX).collect();
        let name = if name.is_empty() { "Phone".to_string() } else { name };
        match &self.state {
            PairState::Open { .. } => {
                let check = check_number(&public, ticket_id);
                self.state = PairState::Asking(Request { id: e.id.clone(), name, public, check });
                None
            }
            PairState::Asking(r) if r.id != e.id => {
                let close = ticket.close();
                self.state = PairState::Cancelled("Two phones answered this pairing code. Start again.".into());
                self.ticket = None;
                close
            }
            _ => None,
        }
    }

    /// The owner pressed Confirm: the phone to keep, and the writes that record it.
    pub fn confirm(&mut self, now: i64) -> Option<(Phone, Vec<MsgWrite>)> {
        let PairState::Asking(r) = &self.state else { return None };
        let ticket = self.ticket.take()?;
        let phone = Phone { key: key_id(&r.public), public: r.public.clone(), name: r.name.clone(), paired_at: now, last_used: 0, record: None };
        let record = MsgWrite::Post {
            channel: channel(&ticket.owner),
            text: phone_record(&phone, "paired", &ticket.host),
            labels: vec![kv("coc.kind", "phone"), kv("coc.key", &phone.key), kv("coc.host", &ticket.host)],
            key: format!("coc-phone-{}-{now}", phone.key),
        };
        let writes = std::iter::once(record).chain(ticket.close()).collect();
        self.state = PairState::Idle;
        Some((phone, writes))
    }

    /// The owner pressed Cancel (or closed Settings): back to nothing.
    pub fn cancel(&mut self) -> Option<MsgWrite> {
        self.state = PairState::Idle;
        self.ticket.take().and_then(|t| t.close())
    }

    /// Time passed: an unanswered or unconfirmed ticket ends at its `until`.
    pub fn tick(&mut self, now: i64) -> Option<MsgWrite> {
        let ticket = self.ticket.as_ref().filter(|t| now >= t.until)?;
        let close = ticket.close();
        self.state = PairState::Cancelled("The pairing code expired. Start again.".into());
        self.ticket = None;
        close
    }
}

/// A phone's record on the board: what lets the remote decide who may read. `state`: `paired` or `removed`.
pub fn phone_record(p: &Phone, state: &str, host: &str) -> String {
    json!({ "key": p.key, "public": b64(&p.public), "name": p.name, "state": state, "host": host }).to_string()
}

/// The village root's text; `seen` is the heartbeat.
pub fn village_text(host: &str, version: &str, seen: i64) -> String {
    json!({ "host": host, "version": version, "seen": seen }).to_string()
}

#[cfg(test)]
#[path = "pairing_tests.rs"]
mod tests;
