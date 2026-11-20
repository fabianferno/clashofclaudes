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

/// The builders a village lends to this Mac's key for workspace `slug`.
pub fn lent_here<'a>(map: &'a super::snapshot::Snapshot, my_key: &str, slug: &str) -> Vec<&'a super::snapshot::MapLend> {
    map.lend.iter().filter(|l| l.keys.as_ref().is_none_or(|k| k.iter().any(|x| x == my_key))).filter(|l| l.workspaces.as_ref().is_none_or(|w| w.iter().any(|x| x == slug))).collect()
}

/// A session in someone's village that works for this Mac.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BorrowedView {
    pub owner: String,
    pub session: String,
    /// Its thread on the board, once posted.
    pub root: Option<String>,
    /// The builder's name.
    pub builder: String,
    /// The lender's workspace (its slug).
    pub workspace: String,
    pub state: String,
    pub wait: Option<String>,
}

/// The sessions in `map` whose borrower is this Mac.
pub fn borrowed_in(map: &super::snapshot::Snapshot, my_key: &str) -> Vec<BorrowedView> {
    map.sessions
        .iter()
        .filter(|s| s.by.as_deref() == Some(my_key))
        .map(|s| BorrowedView {
            owner: map.owner.clone(),
            session: s.id.clone(),
            root: s.root.clone(),
            builder: map.builders.iter().find(|b| b.profile == s.builder).map(|b| b.name.clone()).unwrap_or_else(|| s.builder.clone()),
            workspace: s.workspace.clone(),
            state: s.state.clone(),
            wait: s.wait.clone(),
        })
        .collect()
}

/// A request to borrow `builder` (its profile) in `owner`'s workspace `slug`, signed by this Mac
/// for the lender's village `host`: the request, and its message (a new thread in that
/// workspace's channel, which is where the lender's Mac requires it to be).
#[allow(clippy::too_many_arguments)]
pub fn borrow_request(key: &dyn MacKey, owner: &str, host: &str, builder: &str, slug: &str, task: &str, at: i64, nonce: &str) -> Result<(super::borrow::Request, MsgWrite), String> {
    let task = task.trim();
    if task.is_empty() {
        return Err("Write what the builder should do.".into());
    }
    let mut r = super::borrow::Request { v: 1, builder: builder.to_string(), workspace: slug.to_string(), task: task.to_string(), at, nonce: nonce.to_string(), key: key_id(&key.public()?), sig: String::new() };
    r.sig = key.sign(&super::borrow::request_bytes(host, &r))?;
    let text = serde_json::to_string(&r).map_err(|e| e.to_string())?;
    if text.chars().count() > super::borrow::MAX_REQUEST {
        return Err("That task is too long to send. Shorten it, or put the detail in a file in the repository.".into());
    }
    let write = MsgWrite::Post { channel: format!("v/{owner}/w/{slug}"), text, labels: vec![("coc.kind".to_string(), "borrow".to_string())], key: format!("coc-borrow-{nonce}") };
    Ok((r, write))
}

/// The lender's Mac's answer to request `request`, from its thread: the result and the reason.
/// Only a reply the lender's own login wrote counts.
pub fn borrow_result(thread: &Value, owner: &str, request: &str) -> Option<(String, Option<String>)> {
    thread["replies"]
        .as_array()?
        .iter()
        .filter(|m| written_by(m, owner))
        .filter_map(|m| serde_json::from_str::<Value>(m["text"].as_str()?).ok())
        .filter(|v| v["re"] == request)
        .filter_map(|v| Some((v["result"].as_str()?.to_string(), v["why"].as_str().map(str::to_string))))
        .last()
}

/// A request this Mac sent, and what came back.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentRequest {
    pub owner: String,
    /// The request's message id.
    pub request: String,
    pub builder: String,
    pub workspace: String,
    pub task: String,
    pub at: i64,
    /// `waiting`, `started`, `declined`, `expired`, `busy`, `low`, `refused`, `failed`; None: no answer yet.
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub why: Option<String>,
}

/// The requests this Mac sent (`board-borrows.json`): so "Waiting for ada" survives a restart.
pub struct SentRequests {
    path: std::path::PathBuf,
    list: Vec<SentRequest>,
}

impl SentRequests {
    pub fn load(path: std::path::PathBuf) -> SentRequests {
        let list = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        SentRequests { path, list }
    }

    fn save(&self) {
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec(&self.list)
            && std::fs::write(&tmp, bytes).is_ok()
        {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    pub fn add(&mut self, r: SentRequest) {
        self.list.push(r);
        let n = self.list.len();
        if n > 20 {
            self.list.drain(..n - 20);
        }
        self.save();
    }

    pub fn set_result(&mut self, request: &str, result: &str, why: Option<String>) {
        if let Some(r) = self.list.iter_mut().find(|r| r.request == request)
            && (r.result.as_deref() != Some(result) || r.why != why)
        {
            r.result = Some(result.to_string());
            r.why = why;
            self.save();
        }
    }

    pub fn list(&self) -> Vec<SentRequest> {
        self.list.clone()
    }

    /// The requests the lender's Mac has not finally answered.
    pub fn waiting(&self) -> Vec<SentRequest> {
        self.list.iter().filter(|r| matches!(r.result.as_deref(), None | Some("waiting"))).cloned().collect()
    }
}

#[cfg(test)]
#[path = "visitor_tests.rs"]
mod tests;
