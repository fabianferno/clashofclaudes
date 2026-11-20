//! The village's map: what an invited teammate's app draws. One JSON message the owner's Mac keeps
//! up to date in `v/<owner>/village`: where the shared workspaces stand, who builds there, what
//! state each session is in, and when the Mac was last there.
//!
//! It says nothing a visitor should not have: no paths, no notes, no tasks (those are in each
//! session's own thread, for the people invited to that workspace).
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::{agent_key, profile_name, wait, wire, workspace_slugs, Wire, MAX_TEXT};
use crate::model::{AppData, Compound, SessionInfo, SessionKind, Tile};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapWorkspace {
    #[serde(rename = "s")]
    pub slug: String,
    #[serde(rename = "n")]
    pub name: String,
    /// For apps before activity houses: a level their `houseStage` draws as `activity`.
    #[serde(rename = "l")]
    pub level: u32,
    /// The house's stage 0-4 (`activity::stage`); absent from older apps' maps, and kept absent
    /// when the map is passed on, so a visitor falls back to `level`.
    #[serde(rename = "a", default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<u8>,
    #[serde(rename = "c", default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// `[x0, y0, w, h, house x, house y]`.
    #[serde(rename = "p", default, skip_serializing_if = "Option::is_none", with = "compound_six")]
    pub compound: Option<Compound>,
}

/// A compound as six numbers: the board message has 10,000 characters for the whole village.
mod compound_six {
    use crate::model::{Compound, Tile};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(c: &Option<Compound>, s: S) -> Result<S::Ok, S::Error> {
        c.as_ref().map(|c| [c.x0 as i64, c.y0 as i64, c.w as i64, c.h as i64, c.house.x as i64, c.house.y as i64]).serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Compound>, D::Error> {
        Ok(Option::<[i64; 6]>::deserialize(d)?.map(|v| Compound { x0: v[0] as i32, y0: v[1] as i32, w: v[2] as u32, h: v[3] as u32, house: Tile { x: v[4] as i32, y: v[5] as i32 } }))
    }
}

mod tile_two {
    use crate::model::Tile;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(t: &Option<Tile>, s: S) -> Result<S::Ok, S::Error> {
        t.as_ref().map(|t| [t.x, t.y]).serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Tile>, D::Error> {
        Ok(Option::<[i32; 2]>::deserialize(d)?.map(|v| Tile { x: v[0], y: v[1] }))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapBuilder {
    #[serde(rename = "p")]
    pub profile: String,
    #[serde(rename = "n")]
    pub name: String,
    #[serde(rename = "a")]
    pub agent: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapSession {
    #[serde(rename = "i")]
    pub id: String,
    /// Its thread's root on the board, once posted.
    #[serde(rename = "r", default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// The workspace's slug.
    #[serde(rename = "w")]
    pub workspace: String,
    /// The builder's profile.
    #[serde(rename = "b")]
    pub builder: String,
    /// `coc.state`'s words: working, needs_you, finished, stuck, …
    #[serde(rename = "s")]
    pub state: String,
    #[serde(rename = "t", default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<String>,
    #[serde(rename = "n")]
    pub since: i64,
    #[serde(rename = "a")]
    pub started: i64,
    /// `[x, y]`.
    #[serde(rename = "p", default, skip_serializing_if = "Option::is_none", with = "tile_two")]
    pub spot: Option<Tile>,
    #[serde(rename = "k")]
    pub steps: u32,
}

/// A teammate whose Mac is paired with this village, and their level (for their own app's buttons).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapMate {
    pub key: String,
    pub handle: String,
    pub level: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub v: u8,
    pub host: String,
    pub owner: String,
    /// What the owner is called in their village.
    #[serde(default)]
    pub name: Option<String>,
    /// When the owner's Mac last wrote this (ms): its heartbeat for visitors.
    pub seen: i64,
    pub workspaces: Vec<MapWorkspace>,
    pub builders: Vec<MapBuilder>,
    pub sessions: Vec<MapSession>,
    #[serde(default)]
    pub mates: Vec<MapMate>,
}

/// The map of `owner`'s village as it is now. `roots`: a session's thread root on the board.
pub fn build(data: &AppData, owner: &str, host: &str, sessions: &[SessionInfo], roots: &dyn Fn(&str) -> Option<String>, now: i64) -> Snapshot {
    let slugs = workspace_slugs(&data.workspaces);
    let shared: Vec<_> = data.workspaces.iter().filter(|w| w.board_shared).collect();
    let workspaces = shared
        .iter()
        .map(|w| {
            let a = crate::activity::stage(&w.ships, now);
            MapWorkspace { slug: slugs[&w.id].clone(), name: w.name.clone(), level: crate::activity::legacy_level(a), activity: Some(a), color: w.color.clone(), compound: w.compound.clone() }
        })
        .collect();
    let mut used = BTreeSet::new();
    let mut out = Vec::new();
    for s in sessions {
        let SessionKind::Agent { builder_id } = &s.kind else { continue };
        let (Some(w), Some(b)) = (shared.iter().find(|w| w.id == s.workspace_id), data.builders.iter().find(|b| &b.id == builder_id)) else { continue };
        used.insert(b.id.clone());
        out.push(MapSession {
            id: s.id.clone(),
            root: roots(&s.id),
            workspace: slugs[&w.id].clone(),
            builder: profile_name(&b.name),
            state: wire(s).as_str().to_string(),
            wait: wait(s).map(|w| w.as_str().to_string()),
            since: s.state_since,
            started: s.started_at,
            spot: s.spot.clone(),
            steps: s.steps,
        });
    }
    let builders = data.builders.iter().filter(|b| used.contains(&b.id)).map(|b| MapBuilder { profile: profile_name(&b.name), name: b.name.clone(), agent: agent_key(&b.agent).to_string() }).collect();
    Snapshot { v: 1, host: host.into(), owner: owner.into(), name: data.settings.player_name.clone(), seen: now, workspaces, builders, sessions: out, mates: vec![] }
}

/// The message's text: the map as JSON, under the board's limit. A village too big for that
/// loses its finished sessions first, oldest first: nobody is waiting on those.
pub fn text(s: &Snapshot) -> String {
    let mut s = s.clone();
    loop {
        let t = serde_json::to_string(&s).unwrap_or_default();
        if t.chars().count() <= MAX_TEXT {
            return t;
        }
        let finished = Wire::Finished.as_str();
        let oldest = s.sessions.iter().enumerate().filter(|(_, x)| x.state == finished).min_by_key(|(_, x)| x.since).map(|(i, _)| i);
        match oldest.or_else(|| s.sessions.iter().enumerate().min_by_key(|(_, x)| x.since).map(|(i, _)| i)) {
            Some(i) => {
                s.sessions.remove(i);
            }
            None => return t.chars().take(MAX_TEXT).collect(),
        }
    }
}

/// Whether two maps differ only in when they were written.
pub fn same_but_seen(a: &Snapshot, b: &Snapshot) -> bool {
    let mut b = b.clone();
    b.seen = a.seen;
    *a == b
}

/// A map from a message's text; None for anything else, and for versions this app does not know.
pub fn parse(text: &str) -> Option<Snapshot> {
    serde_json::from_str::<Snapshot>(text.trim()).ok().filter(|s| s.v == 1)
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
