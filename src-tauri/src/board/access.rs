//! Who may see a village on the board, with no I/O: the grants that close it, the grant behind
//! each invite, the `vercel board grants` calls for them, and what a list of grants means.
//!
//! Grants decide who can READ. They never decide who may act: that is a paired key and its level
//! in the owner's Keychain. Any team owner, and the village owner's own agents (they run with the
//! owner's login), can change a grant; so the app shows what the board says, and says when it is
//! not what the owner set.
use std::collections::BTreeMap;

use serde_json::Value;

use super::cli::Target;
use crate::model::{AccessSettings, Invite, Level};

/// The phone remote's project on the team.
const REMOTE_PROJECT: &str = super::deploy::PROJECT;

#[derive(Clone, Debug, PartialEq)]
pub enum Who {
    /// A person on the team, by their Vercel email.
    User(String),
    /// A project's production deployments.
    Project(String),
    /// Everyone let in some other way.
    Everyone,
}

/// One grant to make: who, and what they may do at each channel pattern (no permissions: nothing).
#[derive(Clone, Debug, PartialEq)]
pub struct GrantSpec {
    pub who: Who,
    pub can: Vec<(String, Vec<&'static str>)>,
}

fn village(owner: &str) -> String {
    format!("v/{owner}/")
}

/// The grants that close `owner`'s village, in the order that never locks the owner out: the
/// owner first, then the phone remote (when it is set up), and only then everyone else out.
pub fn closing(owner: &str, email: &str, remote: bool) -> Vec<GrantSpec> {
    let v = village(owner);
    let mut out = vec![GrantSpec { who: Who::User(email.into()), can: vec![(v.clone(), vec!["all"])] }];
    if remote {
        out.push(GrantSpec { who: Who::Project(REMOTE_PROJECT.into()), can: vec![(v.clone(), vec!["read", "post", "label"])] });
    }
    out.push(GrantSpec { who: Who::Everyone, can: vec![(v, vec![])] });
    out
}

/// The grant behind an invite. `slugs`: the shared workspaces' channel slugs, by workspace id.
/// Everyone invited reads the village's map and their workspaces. A Helper or Trusted person also
/// posts there (their actions are replies) and in `pair` (where their Mac asks to be paired).
/// Nobody gets `label`, and nothing reaches `remote`, which holds the owner's phones.
pub fn invite_spec(owner: &str, inv: &Invite, slugs: &BTreeMap<String, String>) -> GrantSpec {
    let acts = inv.level != Level::Visitor;
    let seen: Vec<&'static str> = if acts { vec!["read", "post"] } else { vec!["read"] };
    let mut can = Vec::new();
    if acts {
        can.push((format!("v/{owner}/pair"), vec!["read", "post"]));
    }
    can.push((format!("v/{owner}/village"), vec!["read"]));
    match &inv.workspaces {
        None => can.push((format!("v/{owner}/w/"), seen)),
        Some(ids) => {
            let mut some: Vec<&String> = ids.iter().filter_map(|id| slugs.get(id)).collect();
            some.sort();
            some.dedup();
            can.extend(some.into_iter().map(|slug| (format!("v/{owner}/w/{slug}"), seen.clone())));
        }
    }
    GrantSpec { who: Who::User(inv.email.clone()), can }
}

fn tail(mut args: Vec<String>, t: &Target) -> Vec<String> {
    args.extend(["--json".to_string(), "--name".to_string(), t.name.clone()]);
    if let Some(team) = &t.team {
        args.extend(["--scope".to_string(), team.clone()]);
    }
    args
}

fn can_args(args: &mut Vec<String>, g: &GrantSpec) {
    for (pattern, perms) in &g.can {
        let perms = if perms.is_empty() { "none".to_string() } else { perms.join(",") };
        args.extend(["--can".to_string(), format!("{pattern}={perms}")]);
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

pub fn create_args(g: &GrantSpec, t: &Target) -> Vec<String> {
    let mut a = s(&["board", "grants", "create"]);
    match &g.who {
        Who::User(email) => a.extend(["--user".to_string(), email.clone()]),
        Who::Project(name) => a.extend(["--project".to_string(), name.clone()]),
        Who::Everyone => a.push("--everyone".to_string()),
    }
    can_args(&mut a, g);
    tail(a, t)
}

/// Replaces what grant `id` allows.
pub fn update_args(id: &str, g: &GrantSpec, t: &Target) -> Vec<String> {
    let mut a = s(&["board", "grants", "update", id]);
    can_args(&mut a, g);
    tail(a, t)
}

pub fn revoke_args(id: &str, t: &Target) -> Vec<String> {
    tail(s(&["board", "grants", "revoke", id]), t)
}

pub fn list_args(t: &Target) -> Vec<String> {
    tail(s(&["board", "grants", "list"]), t)
}

/// A grant as the board lists it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grant {
    pub id: String,
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub project: Option<String>,
    pub everyone: bool,
    /// Every person on the team (the board's own first grant).
    pub all_users: bool,
    /// Every project's deployments on the team.
    pub all_projects: bool,
    /// Permissions by channel pattern; an empty list is "nothing".
    pub can: BTreeMap<String, Vec<String>>,
}

/// `vercel board grants list --json`.
pub fn parse_grants(v: &Value) -> Vec<Grant> {
    let Some(list) = v["grants"].as_array() else { return vec![] };
    list.iter()
        .filter_map(|g| {
            let mut out = Grant { id: g["id"].as_str()?.to_string(), ..Default::default() };
            for p in g["principals"].as_array().into_iter().flatten() {
                match p["kind"].as_str().unwrap_or_default() {
                    "user" => {
                        out.user_id = p["userId"].as_str().map(str::to_string);
                        out.email = p["email"].as_str().map(str::to_string);
                    }
                    "project" => out.project = p["name"].as_str().or(p["projectId"].as_str()).map(str::to_string),
                    "everyone" => out.everyone = true,
                    "all-users" => out.all_users = true,
                    "all-projects" => out.all_projects = true,
                    _ => {}
                }
            }
            for (pattern, perms) in g["can"].as_object().into_iter().flatten() {
                let perms = match perms {
                    Value::String(one) => vec![one.clone()],
                    Value::Array(many) => many.iter().filter_map(|p| p.as_str().map(str::to_string)).collect(),
                    _ => vec![],
                };
                out.can.insert(pattern.clone(), perms);
            }
            Some(out)
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seen {
    /// Everyone not named is shut out of the village.
    Closed,
    Open,
    /// No list of grants was read.
    Unknown,
}

/// Whether `owner`'s village is closed to the team, from the board's grants.
pub fn village_state(grants: &[Grant], owner: &str) -> Seen {
    if grants.is_empty() {
        return Seen::Unknown;
    }
    let v = village(owner);
    if grants.iter().any(|g| g.everyone && g.can.get(&v).is_some_and(|p| p.is_empty())) {
        Seen::Closed
    } else {
        Seen::Open
    }
}

/// The patterns inside `owner`'s village at which a grant lets its principal read.
fn reaching(g: &Grant, owner: &str) -> Vec<String> {
    let v = village(owner);
    g.can.iter().filter(|(pattern, perms)| pattern.starts_with(&v) && perms.iter().any(|p| p == "read" || p == "all")).map(|(p, _)| p.clone()).collect()
}

/// Whether a grant lets its principal read something inside `owner`'s village.
fn reaches(g: &Grant, owner: &str) -> bool {
    !reaching(g, owner).is_empty()
}

/// A grant that names a whole group (everyone, every person, every project) rather than one principal.
fn group(g: &Grant) -> bool {
    g.everyone || g.all_users || g.all_projects
}

/// Who can see the village now, in words for Settings. `me`: the owner's Vercel user id.
pub fn who_can_see(grants: &[Grant], owner: &str, me: &str) -> Vec<String> {
    if village_state(grants, owner) != Seen::Closed {
        return vec!["Everyone on your Vercel team, and every project's deployments".to_string()];
    }
    // Every grant that reaches the village is named, whoever made it: the list is the board's truth.
    let mut out = vec!["You".to_string()];
    let (mut projects, mut groups) = (Vec::new(), Vec::new());
    for g in grants.iter().filter(|g| reaches(g, owner)) {
        if group(g) {
            groups.extend(reaching(g, owner).into_iter().map(|p| format!("Everyone on your Vercel team, in {p}")));
        } else if let Some(p) = &g.project {
            let name = if p == REMOTE_PROJECT { "The phone remote".to_string() } else { format!("The project {p}") };
            projects.push(format!("{name}, and whoever can deploy it"));
        } else if g.user_id.as_deref() != Some(me) {
            out.extend(g.email.clone().or(g.user_id.clone()));
        }
    }
    out.extend(projects);
    out.extend(groups);
    out.dedup();
    out
}

/// What on the board is not as the owner set it, if anything. None also when no list was read.
pub fn drift(settings: &AccessSettings, grants: &[Grant], owner: &str) -> Option<String> {
    if grants.is_empty() {
        return None;
    }
    if settings.private && village_state(grants, owner) == Seen::Open {
        return Some("Your village is open to the team again.".into());
    }
    for inv in &settings.invites {
        if let Some(id) = &inv.grant
            && !grants.iter().any(|g| &g.id == id)
        {
            return Some(format!("The invite for {} is gone from the board.", inv.email));
        }
    }
    if village_state(grants, owner) != Seen::Closed {
        // open (by the owner's choice): everyone sees it anyway
        return None;
    }
    let known = |g: &Grant| settings.grants.contains(&g.id) || settings.invites.iter().any(|i| i.grant.as_ref() == Some(&g.id));
    let stranger = grants.iter().find(|g| !known(g) && reaches(g, owner))?;
    Some(if group(stranger) {
        format!("Everyone on your Vercel team can see {}.", reaching(stranger, owner).join(", "))
    } else if let Some(p) = &stranger.project {
        format!("The project {p} can see your village, and you did not let it in.")
    } else {
        format!("{} can see your village, and you did not invite them.", stranger.email.clone().or(stranger.user_id.clone()).unwrap_or_default())
    })
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;
