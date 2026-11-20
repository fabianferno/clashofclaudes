//! Acting in a village you visit, from your own Mac: asking its owner to pair this Mac, and
//! sending a signed action for a builder there. No I/O here: these make the messages; the app
//! posts them with the visitor's own CLI.
//!
//! Nothing here decides anything. The owner's Mac checks the proof, the signature, the level and
//! the prompt; a visitor's app that lies only gets refused.
use serde_json::Value;

use super::cli::MsgWrite;
use super::mac_key::MacKey;
use super::pairing::{proof, ticket_id};
use super::remote::{b64, check_number, key_id, signed_bytes, Action, Do};
use super::visits::written_by;

/// The owner's open pairing ticket for `code` among the roots of a read of `v/<owner>/pair`.
/// Only a ticket the owner's own login wrote counts: anyone invited can post in that channel.
pub fn find_ticket(read: &Value, owner: &str, code: &str, now: i64) -> Option<String> {
    let name = ticket_id(code);
    read["threads"].as_array()?.iter().map(|t| &t["message"]).filter(|m| m["re"].is_null() && written_by(m, owner)).find_map(|m| {
        let v: Value = serde_json::from_str(m["text"].as_str()?).ok()?;
        (v["id"] == name.as_str() && v["state"] == "open" && v["until"].as_i64()? > now).then(|| m["id"].as_str().map(str::to_string))?
    })
}

/// This Mac's request to be paired, as a reply under the owner's ticket, and the check number to
/// read to the owner. `handle`: the visitor's Vercel username (the owner's Mac names the key by
/// what the board verified, not by this).
pub fn pair_request(ticket: &str, code: &str, key: &dyn MacKey, handle: &str) -> Result<(MsgWrite, String), String> {
    let public = key.public()?;
    let name = format!("{handle}’s Mac");
    let text = serde_json::json!({ "public": b64(&public), "name": name, "mac": proof(code, &public, &name) }).to_string();
    let write = MsgWrite::ReplyTo { id: ticket.to_string(), text, labels: vec![("coc.kind".to_string(), "pair".to_string())], key: format!("coc-matereq-{}-{ticket}", key_id(&public)) };
    Ok((write, check_number(&public, ticket)))
}

/// An action signed by this Mac, for the prompt whose block hashes to `prompt`.
pub fn action(key: &dyn MacKey, r#do: Do, pick: Option<usize>, text: Option<&str>, prompt: &str, nonce: &str) -> Result<Action, String> {
    let mut a = Action { v: 1, r#do, pick, text: text.map(str::to_string), nonce: nonce.to_string(), key: key_id(&key.public()?), prompt: prompt.to_string(), sig: String::new() };
    a.sig = key.sign(&signed_bytes(&a))?;
    Ok(a)
}

/// The action as a reply in the session's thread (`root`).
pub fn action_write(root: &str, a: &Action) -> MsgWrite {
    MsgWrite::ReplyTo { id: root.to_string(), text: serde_json::to_string(a).unwrap_or_default(), labels: vec![("coc.do".to_string(), a.r#do.as_str().to_string())], key: format!("coc-act-{}", a.nonce) }
}

#[cfg(test)]
#[path = "visitor_tests.rs"]
mod tests;
