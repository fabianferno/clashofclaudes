//! Pairing a phone with this Mac, with no I/O: the ticket the Mac posts, the request a phone
//! sends through the remote, and the owner's Confirm.
//!
//! Nothing here is a secret. The code only finds the ticket; trust comes from the owner seeing the
//! same check number on the phone and on the Mac, and from there being exactly one request.
use serde_json::json;

use super::cli::MsgWrite;
use super::listen::Event;
use super::remote::{b64, check_number, key_id, unb64, Phone};

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
        json!({ "host": self.host, "code": self.code, "until": self.until, "state": state }).to_string()
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

    /// Opens a pairing: the ticket to post. `rng6`: any random number; its last six digits are the code.
    pub fn start(&mut self, now: i64, rng6: u32, host: &str, owner: &str) -> MsgWrite {
        let code = format!("{:06}", rng6 % 1_000_000);
        let t = Ticket { host: host.into(), owner: owner.into(), code: code.clone(), until: now + TICKET_MS, id: None };
        let write = MsgWrite::Post {
            channel: channel(owner),
            text: t.text("open"),
            labels: vec![kv("coc.kind", "pair-open"), kv("coc.code", &code), kv("coc.host", host)],
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

    /// A message from the village's log. A first request under the open ticket asks the owner; a
    /// second one means someone else answered too, and ends the pairing (the ticket's closing edit).
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
        let name: String = v.get("name").and_then(|n| n.as_str()).unwrap_or("").trim().chars().take(NAME_MAX).collect();
        let name = if name.is_empty() { "Phone".to_string() } else { name };
        match &self.state {
            PairState::Open { .. } => {
                let check = check_number(&public, ticket_id);
                self.state = PairState::Asking(Request { id: e.id.clone(), name, public, check });
                None
            }
            PairState::Asking(r) if r.id != e.id => {
                let close = ticket.close();
                self.state = PairState::Cancelled("Another device answered this pairing code. Start again.".into());
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
