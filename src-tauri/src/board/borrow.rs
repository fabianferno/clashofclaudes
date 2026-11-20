//! Borrowing a builder, with no I/O: the request a teammate's Mac signs, the lender's record of
//! what is lent, and whether the lender's Mac takes a request
//! (`docs/superpowers/specs/2026-11-20-shared-builders-design.md`).
//!
//! A taken request runs a teammate's words through an agent on the lender's Mac. So nothing here
//! trusts the board: who asks is a paired key's signature, what is lent is the lender's own
//! record, and a request is good once, for a day, in the workspace it was posted in.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::remote::{sha_hex, verify, Phone};
use crate::model::Level;

/// The whole message may be this long (the board takes 10,000 characters).
pub const MAX_REQUEST: usize = 9_000;
/// A request is good for this long after it was signed.
pub const FRESH_MS: i64 = 24 * 3_600_000;
/// How far ahead of this Mac's clock a request's signed time may be.
pub const AHEAD_MS: i64 = 5 * 60_000;

/// A teammate asking to borrow a builder: the text of a thread root in the lender's workspace channel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub v: u8,
    /// The builder's profile, as the lender's map names it.
    pub builder: String,
    /// The workspace's slug.
    pub workspace: String,
    pub task: String,
    /// When it was signed (ms).
    pub at: i64,
    pub nonce: String,
    /// The asking Mac's key id.
    pub key: String,
    pub sig: String,
}

pub fn parse_request(text: &str) -> Option<Request> {
    if text.chars().count() > MAX_REQUEST {
        return None;
    }
    serde_json::from_str::<Request>(text.trim()).ok().filter(|r| r.v == 1 && !r.task.trim().is_empty())
}

/// What the asking Mac signs. `host`: the lender's village id, so a request is for one village.
pub fn request_bytes(host: &str, r: &Request) -> Vec<u8> {
    ["coc-borrow-1".to_string(), host.to_string(), r.builder.clone(), r.workspace.clone(), sha_hex(r.task.as_bytes()), r.at.to_string(), r.nonce.clone()].join("\n").into_bytes()
}

/// One lent builder, in the lender's own record (the Keychain).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lend {
    /// The builder's id.
    pub builder: String,
    /// The paired key ids it is lent to; None: every paired Mac.
    #[serde(default)]
    pub keys: Option<Vec<String>>,
    /// The workspace ids it may work in; None: every shared workspace.
    #[serde(default)]
    pub workspaces: Option<Vec<String>>,
    /// With less elixir left than this (percent), requests are refused.
    #[serde(default)]
    pub floor: u32,
    /// The first task waits for the lender's Accept.
    #[serde(default)]
    pub ask: bool,
}

/// What the lender's Mac does with a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Take {
    Start,
    /// The builder is lent "ask me first": it waits for the lender.
    Ask,
    /// The builder has a session already.
    Busy,
    /// Its agent's elixir is under the floor.
    Low,
    Refused(&'static str),
}

/// What the lender's Mac knows when a request arrives.
pub struct Facts<'a> {
    /// This village's id.
    pub host: &'a str,
    /// The channel the request was posted in.
    pub channel: &'a str,
    /// The lender's Vercel username.
    pub owner: &'a str,
    pub now: i64,
    /// The paired keys (the Keychain).
    pub phones: &'a [Phone],
    /// What is lent (the Keychain).
    pub lends: &'a [Lend],
    /// Nonces of requests taken in the last day.
    pub seen: &'a HashSet<String>,
    /// The builder the request's profile names: its id, whether it has a live session, and the
    /// least elixir its agent has left (percent; None: no reading, which counts as enough).
    pub builder: Option<(&'a str, bool, Option<u32>)>,
    /// The workspace the request's slug names: its id, and whether it is shared and can be lent
    /// (a git repository with a commit and an `origin`).
    pub workspace: Option<(&'a str, bool)>,
}

/// Who asked, checked before anything else on this Mac is looked at: a paired Helper's or
/// Trusted person's key whose signature, for this village, matches. The refusal otherwise.
pub fn signed_by<'a>(r: &Request, host: &str, phones: &'a [Phone]) -> Result<&'a Phone, &'static str> {
    let phone = phones.iter().find(|p| p.key == r.key).ok_or("not a paired Mac")?;
    match phone.level {
        None => return Err("a phone cannot borrow"),
        Some(Level::Visitor) => return Err("a Visitor cannot borrow"),
        Some(Level::Helper | Level::Trusted) => {}
    }
    if !verify(&phone.public, &request_bytes(host, r), &r.sig) {
        return Err("the signature does not match");
    }
    Ok(phone)
}

/// Whether the lender's Mac takes `r`.
pub fn take(r: &Request, f: &Facts<'_>) -> Take {
    let Some(phone) = f.phones.iter().find(|p| p.key == r.key) else { return Take::Refused("not a paired Mac") };
    match phone.level {
        None => return Take::Refused("a phone cannot borrow"),
        Some(Level::Visitor) => return Take::Refused("a Visitor cannot borrow"),
        Some(Level::Helper | Level::Trusted) => {}
    }
    if !verify(&phone.public, &request_bytes(f.host, r), &r.sig) {
        return Take::Refused("the signature does not match");
    }
    // posted where it says: someone invited to one workspace must not start work in another
    if f.channel != format!("v/{}/w/{}", f.owner, r.workspace) {
        return Take::Refused("posted in another workspace's channel");
    }
    if f.now - r.at > FRESH_MS {
        return Take::Refused("asked more than a day ago");
    }
    if r.at - f.now > AHEAD_MS {
        return Take::Refused("its clock is ahead");
    }
    if f.seen.contains(&r.nonce) {
        return Take::Refused("already taken");
    }
    let Some((builder, busy, elixir)) = f.builder else { return Take::Refused("no such builder") };
    let Some((workspace, lendable)) = f.workspace else { return Take::Refused("no such workspace") };
    let Some(lend) = f.lends.iter().find(|l| l.builder == builder) else { return Take::Refused("that builder is not lent") };
    if lend.keys.as_ref().is_some_and(|k| !k.contains(&r.key)) {
        return Take::Refused("that builder is not lent to you");
    }
    if lend.workspaces.as_ref().is_some_and(|w| !w.iter().any(|id| id == workspace)) {
        return Take::Refused("that builder is not lent for this workspace");
    }
    if !lendable {
        return Take::Refused("that workspace cannot be lent");
    }
    if busy {
        return Take::Busy;
    }
    // the window's own rule for low elixir: at or under the reserve; a floor of 0 is no floor
    if lend.floor > 0 && elixir.is_some_and(|left| left <= lend.floor) {
        return Take::Low;
    }
    if lend.ask { Take::Ask } else { Take::Start }
}

/// The branch a borrowed session works on: `borrow/<who>/<what>-<4 hex>`. Built only from
/// letters, digits and dashes, so nothing a borrower types reaches git as an option, a path or a
/// ref trick.
pub fn branch_name(handle: &str, task: &str, nonce: &str) -> String {
    let or_task = |s: String| if s.is_empty() { "task".to_string() } else { s };
    let who = or_task(crate::git::slug(handle, 20));
    let what = or_task(crate::git::slug(task, 40));
    let hex: String = nonce.chars().filter(char::is_ascii_hexdigit).map(|c| c.to_ascii_lowercase()).chain("0000".chars()).take(4).collect();
    format!("borrow/{who}/{what}-{hex}")
}

/// The lender's Mac's answer under a request: `waiting`, `started`, `declined`, `expired`,
/// `busy`, `low`, `refused` or `failed`, with the reason in words where there is one.
pub fn result_text(request_id: &str, result: &str, why: Option<&str>) -> String {
    let mut v = serde_json::json!({ "re": request_id, "result": result });
    if let Some(w) = why {
        v["why"] = serde_json::Value::String(w.to_string());
    }
    v.to_string()
}

#[cfg(test)]
#[path = "borrow_tests.rs"]
mod tests;
