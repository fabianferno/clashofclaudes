//! The villages this login was invited to: their maps, read from the board and kept current by
//! the listener. A village is whatever `v/<owner>/village` the login can read; its map counts only
//! when the owner's own login wrote it. Labels and other people's messages there are ignored.
use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use super::cli::{BoardCli, CliError, Target};
use super::listen::Event;
use super::remote::{block_in, PromptBlock};
use super::snapshot::{parse, Snapshot};

/// With nothing from its Mac for this long, a village is shown as away.
pub const AWAY_MS: i64 = 12 * 60_000;
const WAITING: [&str; 3] = ["needs_you", "stuck", "finished"];

/// A village in the people row.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitView {
    pub owner: String,
    /// What the owner is called in their village.
    pub name: Option<String>,
    /// Builders waiting on their owner there.
    pub waiting: usize,
    /// Its Mac has not written for a while (asleep or offline).
    pub away: bool,
    pub seen: i64,
}

/// A builder in a visited village, as its thread tells it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitedBuilder {
    /// The root's first line: who, and on what.
    pub title: String,
    pub wait: Option<String>,
    /// The owner's Mac's words for the wait, without the block.
    pub words: Option<String>,
    pub question: Option<String>,
    pub options: Option<Vec<String>>,
    /// What the owner's Mac will take for this wait (`allow`, `deny`, `answer`, `followup`).
    pub can: Vec<String>,
    /// The hash of the wait's prompt block: what an action for it signs.
    pub prompt: Option<String>,
    /// This Mac sent an action for this wait.
    pub sent: bool,
    /// The owner's Mac's word on it: `applied`, `stale`, `refused`, `failed`.
    pub result: Option<String>,
}

pub struct Visits {
    path: PathBuf,
    me: String,
    villages: BTreeMap<String, Snapshot>,
}

/// The owners with a map channel in `channels`, other than `me`.
pub fn owners_of(channels: &[String], me: &str) -> Vec<String> {
    let mut out: Vec<String> = channels
        .iter()
        .filter_map(|c| match c.split('/').collect::<Vec<_>>().as_slice() {
            ["v", owner, "village"] if *owner != me => Some(owner.to_string()),
            _ => None,
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

fn tail(mut args: Vec<String>, t: &Target) -> Vec<String> {
    args.extend(["--json".to_string(), "--name".to_string(), t.name.clone()]);
    if let Some(team) = &t.team {
        args.extend(["--scope".to_string(), team.clone()]);
    }
    args
}

/// Whether a message read from the board was written with `owner`'s own login.
pub(crate) fn written_by(m: &Value, owner: &str) -> bool {
    let handle = m["author"]["handle"].as_str().unwrap_or_default();
    m["author"]["verified"] == true
        && m["by"]["principal"].as_str().is_some_and(|p| p.starts_with("vercel:user:"))
        && (handle == owner || handle.strip_prefix(owner).is_some_and(|rest| rest.starts_with('/')))
}

/// `owner`'s map among a channel read's roots: the newest the owner wrote that is about their own village.
fn map_in(read: &Value, owner: &str) -> Option<Snapshot> {
    read["threads"]
        .as_array()?
        .iter()
        .map(|t| &t["message"])
        .filter(|m| m["re"].is_null() && written_by(m, owner))
        .filter_map(|m| parse(m["text"].as_str()?))
        .filter(|s| s.owner == owner)
        .max_by_key(|s| s.seen)
}

impl Visits {
    /// What was known when the app last ran (so the row is there at launch).
    pub fn load(path: PathBuf) -> Visits {
        let villages = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Visits { path, me: String::new(), villages }
    }

    fn save(&self) {
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec(&self.villages)
            && std::fs::write(&tmp, bytes).is_ok()
        {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    /// Whose app this is: their own village is never a visit.
    pub fn set_me(&mut self, me: &str) {
        if self.me != me {
            self.me = me.to_string();
            if self.villages.remove(me).is_some() {
                self.save();
            }
        }
    }

    /// Forgets every village (another board, or Board link off).
    pub fn clear(&mut self) {
        if !self.villages.is_empty() {
            self.villages.clear();
            self.save();
        }
    }

    /// Reads the list of villages again: one call for the channels, one per village. A village no
    /// longer listed, or whose map can no longer be read, is dropped. A board that cannot be
    /// reached at all leaves what is known as it is.
    pub fn refresh(&mut self, cli: &dyn BoardCli, t: &Target, me: &str, _now: i64) -> Result<(), CliError> {
        self.set_me(me);
        let listed = cli.run(&tail(vec!["board".into(), "channels".into()], t))?;
        let channels: Vec<String> = listed["channels"].as_array().map(|a| a.iter().filter_map(|c| c["path"].as_str().map(str::to_string)).collect()).unwrap_or_default();
        let mut now_known = BTreeMap::new();
        for owner in owners_of(&channels, me) {
            match cli.run(&tail(vec!["board".into(), "read".into(), format!("v/{owner}/village")], t)) {
                Ok(read) => {
                    if let Some(snap) = map_in(&read, &owner) {
                        now_known.insert(owner, snap);
                    }
                }
                // the board itself is failing: keep what we had for this one
                Err(CliError::Retryable(_)) => {
                    if let Some(had) = self.villages.get(&owner) {
                        now_known.insert(owner, had.clone());
                    }
                }
                // no access any more
                Err(_) => {}
            }
        }
        if now_known != self.villages {
            self.villages = now_known;
            self.save();
        }
        Ok(())
    }

    /// An event from the listener: a village's owner posted or edited their map. True when what
    /// the row or a visit shows has changed.
    pub fn on_event(&mut self, e: &Event, _now: i64) -> bool {
        if e.kind != "message.posted" && e.kind != "message.edited" {
            return false;
        }
        let ["v", owner, "village"] = e.channel.split('/').collect::<Vec<_>>()[..] else { return false };
        if owner == self.me || !e.by_owner(owner) {
            return false;
        }
        let Some(snap) = parse(&e.text).filter(|s| s.owner == owner) else { return false };
        if self.villages.get(owner).is_some_and(|had| had.seen >= snap.seen) {
            return false;
        }
        self.villages.insert(owner.to_string(), snap);
        self.save();
        true
    }

    pub fn list(&self, now: i64) -> Vec<VisitView> {
        self.villages
            .iter()
            .map(|(owner, s)| VisitView {
                owner: owner.clone(),
                name: s.name.clone(),
                waiting: s.sessions.iter().filter(|x| WAITING.contains(&x.state.as_str())).count(),
                away: now - s.seen > AWAY_MS,
                seen: s.seen,
            })
            .collect()
    }

    pub fn get(&self, owner: &str) -> Option<&Snapshot> {
        self.villages.get(owner)
    }
}

/// `vercel board read <root> --json` for a session's thread.
pub fn thread_args(root: &str, t: &Target) -> Vec<String> {
    tail(vec!["board".into(), "read".into(), root.to_string()], t)
}

/// What a visitor is shown of a builder, from its thread: the title the owner's Mac gave it, its
/// newest wait in the owner's Mac's own words, and how this Mac's own action for that wait ended
/// (`my_key`: this Mac's key id, when it has a key). None when the owner did not start the thread.
pub fn visited_builder(thread: &Value, owner: &str, my_key: Option<&str>) -> Option<VisitedBuilder> {
    let root = &thread["message"];
    if !written_by(root, owner) {
        return None;
    }
    let title = root["text"].as_str().unwrap_or_default().lines().next().unwrap_or_default().chars().take(200).collect();
    let replies: Vec<&Value> = thread["replies"].as_array().into_iter().flatten().collect();
    let newest = replies.iter().enumerate().filter(|(_, m)| written_by(m, owner)).filter_map(|(at, m)| {
        let text = m["text"].as_str()?;
        let json = block_in(text)?;
        let block: PromptBlock = serde_json::from_str(json).ok()?;
        let words = text[..text.len() - json.len()].rsplit_once("\n\n```json coc").map(|(w, _)| w.to_string()).unwrap_or_default();
        Some((at, block, words, super::remote::sha_hex(json.as_bytes())))
    });
    let Some((at, block, words, prompt)) = newest.last() else {
        return Some(VisitedBuilder { title, wait: None, words: None, question: None, options: None, can: vec![], prompt: None, sent: false, result: None });
    };
    // After that wait: the actions this Mac signed, and the owner's Mac's results for them.
    let after = &replies[at + 1..];
    let mine: Vec<&str> = after
        .iter()
        .filter(|m| m["labels"].get("coc.do").is_some())
        .filter(|m| my_key.is_some_and(|k| m["text"].as_str().and_then(super::remote::parse_action).is_some_and(|a| a.key == k)))
        .filter_map(|m| m["id"].as_str())
        .collect();
    let result = after
        .iter()
        .filter(|m| written_by(m, owner))
        .filter_map(|m| serde_json::from_str::<Value>(m["text"].as_str()?).ok())
        .filter(|v| v["re"].as_str().is_some_and(|re| mine.contains(&re)))
        .filter_map(|v| v["result"].as_str().map(str::to_string))
        .last();
    Some(VisitedBuilder {
        title,
        wait: Some(block.wait),
        words: Some(words),
        question: block.question,
        options: block.options,
        can: block.can.iter().map(|d| d.as_str().to_string()).collect(),
        prompt: Some(prompt),
        sent: !mine.is_empty(),
        result,
    })
}

#[cfg(test)]
#[path = "visits_tests.rs"]
mod tests;
