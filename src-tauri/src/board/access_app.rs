//! Closing a village and inviting people, through the owner's `vercel` CLI. Every function here
//! runs CLI calls (about two seconds each): call them from a blocking worker, never from a
//! session's path. What they change in `AccessSettings` is what the owner set; what Settings
//! shows as the truth is always read back from the board (`status`).
use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use super::access::{closing, create_args, drift, invite_spec, list_args, parse_grants, revoke_args, update_args, village_state, who_can_see, Grant, GrantSpec, Seen, Who};
use super::cli::{BoardCli, CliError, Target};
use crate::model::{AccessSettings, Invite, Level};

/// The village's owner on the board.
#[derive(Clone, Debug, PartialEq)]
pub struct Me {
    /// Their Vercel username.
    pub owner: String,
    /// Their login's email: how a grant names a person.
    pub email: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteView {
    pub email: String,
    pub level: Level,
    pub workspaces: Option<Vec<String>>,
    /// Their grant is on the board.
    pub on_board: bool,
}

/// Settings › Team: Private village and People, as the board has it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessStatus {
    /// `closed`, `open`, or `unknown` (the grants could not be read).
    pub state: String,
    /// False once the board refused to let this login close the village.
    pub can_close: bool,
    /// What the board said then.
    pub refused: Option<String>,
    /// For a team owner to run, when this login may not.
    pub command: Option<String>,
    /// Who can see the village now, in words.
    pub who: Vec<String>,
    /// What on the board is not as the owner set it.
    pub drift: Option<String>,
    pub invites: Vec<InviteView>,
}

fn why(e: CliError) -> String {
    match e {
        CliError::Missing => "The Vercel CLI is not installed.".into(),
        CliError::NoBoard => "This Vercel CLI has no board command.".into(),
        CliError::SignedOut(m) | CliError::Retryable(m) | CliError::Fatal(m) => m,
    }
}

fn grants(cli: &dyn BoardCli, t: &Target) -> Result<Vec<Grant>, String> {
    cli.run(&list_args(t)).map(|v| parse_grants(&v)).map_err(why)
}

/// Makes one grant; its id and the user id the board named, if any.
fn create(cli: &dyn BoardCli, t: &Target, g: &GrantSpec) -> Result<(String, Option<String>), String> {
    let v: Value = cli.run(&create_args(g, t)).map_err(why)?;
    let id = v["grant"]["id"].as_str().ok_or("the board made a grant and did not name it")?.to_string();
    let user = v["grant"]["principals"][0]["userId"].as_str().map(str::to_string);
    Ok((id, user))
}

/// The commands a team owner runs to close this member's village for them.
pub fn owner_command(t: &Target, me: &Me, remote: bool) -> String {
    let scope = t.team.as_ref().map(|s| format!(" --scope {s}")).unwrap_or_default();
    closing(&me.owner, &me.email, remote)
        .iter()
        .map(|g| {
            let who = match &g.who {
                Who::User(e) => format!("--user {e}"),
                Who::Project(p) => format!("--project {p}"),
                Who::Everyone => "--everyone".to_string(),
            };
            let can: Vec<String> = g.can.iter().map(|(p, perms)| format!("--can '{p}={}'", if perms.is_empty() { "none".to_string() } else { perms.join(",") })).collect();
            format!("vercel board grants create {who} {} --name {}{scope}", can.join(" "), t.name)
        })
        .collect::<Vec<_>>()
        .join(" && ")
}

/// Closes the village: the owner in, the phone remote in (when it is set up), everyone else out.
/// `set.grants` keeps the ids, the everyone-out one last. A step the board refuses takes back
/// what this call made, so nothing is left half done.
pub fn close(cli: &dyn BoardCli, t: &Target, me: &Me, remote: bool, set: &mut AccessSettings) -> Result<(), String> {
    let specs = closing(&me.owner, &me.email, remote);
    if set.private && set.grants.len() >= specs.len() {
        return Ok(());
    }
    // Closed before the phone remote existed: only its grant is missing, and it goes before the last.
    if set.private && set.grants.len() == 2 && remote {
        let (id, _) = create(cli, t, &specs[1])?;
        set.grants.insert(1, id);
        return Ok(());
    }
    let mut made: Vec<String> = Vec::new();
    for g in &specs {
        match create(cli, t, g) {
            Ok((id, _)) => made.push(id),
            Err(e) => {
                for id in made.iter().rev() {
                    let _ = cli.run(&revoke_args(id, t));
                }
                if g.who == Who::Everyone {
                    set.refused = Some(e.clone());
                }
                return Err(e);
            }
        }
    }
    set.grants = made;
    set.private = true;
    set.refused = None;
    Ok(())
}

/// Opens the village to the team again: the everyone-out grant goes first, so nobody is ever
/// shut out by what is left.
pub fn open(cli: &dyn BoardCli, t: &Target, set: &mut AccessSettings) -> Result<(), String> {
    while let Some(id) = set.grants.last().cloned() {
        cli.run(&revoke_args(&id, t)).map_err(why)?;
        set.grants.pop();
    }
    set.private = false;
    Ok(())
}

fn clean_email(raw: &str) -> Result<String, String> {
    let e = raw.trim().to_lowercase();
    let ok = e.split_once('@').is_some_and(|(a, b)| !a.is_empty() && b.contains('.')) && !e.contains(char::is_whitespace);
    if ok { Ok(e) } else { Err("That is not an email address.".into()) }
}

/// Invites a teammate, or changes their invite: one grant for that person.
#[allow(clippy::too_many_arguments)]
pub fn invite_put(cli: &dyn BoardCli, t: &Target, me: &Me, set: &mut AccessSettings, slugs: &BTreeMap<String, String>, email: &str, level: Level, workspaces: Option<Vec<String>>) -> Result<(), String> {
    let email = clean_email(email)?;
    if email == me.email.to_lowercase() {
        return Err("That is you.".into());
    }
    let at = set.invites.iter().position(|i| i.email == email);
    let mut inv = at.map(|i| set.invites[i].clone()).unwrap_or(Invite { email, level, workspaces: None, grant: None, user_id: None });
    inv.level = level;
    inv.workspaces = workspaces;
    let spec = invite_spec(&me.owner, &inv, slugs);
    match &inv.grant {
        Some(id) => {
            cli.run(&update_args(id, &spec, t)).map_err(why)?;
        }
        None => {
            let (id, user) = create(cli, t, &spec)?;
            inv.grant = Some(id);
            inv.user_id = user;
        }
    }
    match at {
        Some(i) => set.invites[i] = inv,
        None => set.invites.push(inv),
    }
    Ok(())
}

pub fn invite_remove(cli: &dyn BoardCli, t: &Target, set: &mut AccessSettings, email: &str) -> Result<(), String> {
    let at = set.invites.iter().position(|i| i.email == email).ok_or("No such invite.")?;
    if let Some(id) = &set.invites[at].grant {
        cli.run(&revoke_args(id, t)).map_err(why)?;
    }
    set.invites.remove(at);
    Ok(())
}

/// Makes the board what the owner set again: the village closed if they want it closed, and
/// every invite's grant there.
pub fn put_back(cli: &dyn BoardCli, t: &Target, me: &Me, remote: bool, set: &mut AccessSettings, slugs: &BTreeMap<String, String>) -> Result<(), String> {
    let now = grants(cli, t)?;
    let on_board = |id: &String| now.iter().any(|g| &g.id == id);
    if set.private && village_state(&now, &me.owner) != Seen::Closed {
        // open, so nothing that is left of ours can lock anyone out: clear it and close afresh
        for id in set.grants.clone().iter().filter(|id| on_board(id)) {
            let _ = cli.run(&revoke_args(id, t));
        }
        set.grants.clear();
        set.private = false;
        close(cli, t, me, remote, set)?;
    }
    for i in 0..set.invites.len() {
        if set.invites[i].grant.as_ref().is_some_and(|id| !on_board(id)) {
            set.invites[i].grant = None;
            let inv = set.invites[i].clone();
            invite_put(cli, t, me, set, slugs, &inv.email, inv.level, inv.workspaces)?;
        }
    }
    Ok(())
}

/// What Settings shows: read from the board now (one call).
pub fn status(cli: &dyn BoardCli, t: &Target, me: &Me, set: &AccessSettings, _slugs: &BTreeMap<String, String>) -> AccessStatus {
    let now = grants(cli, t).unwrap_or_default();
    let my_id = now.iter().find(|g| g.email.as_deref().is_some_and(|e| e.eq_ignore_ascii_case(&me.email))).and_then(|g| g.user_id.clone()).unwrap_or_default();
    let state = match village_state(&now, &me.owner) {
        Seen::Closed => "closed",
        Seen::Open => "open",
        Seen::Unknown => "unknown",
    };
    AccessStatus {
        state: state.into(),
        can_close: set.refused.is_none(),
        refused: set.refused.clone(),
        command: None,
        who: if now.is_empty() { vec![] } else { who_can_see(&now, &me.owner, &my_id) },
        drift: drift(set, &now, &me.owner),
        invites: set
            .invites
            .iter()
            .map(|i| InviteView { email: i.email.clone(), level: i.level, workspaces: i.workspaces.clone(), on_board: i.grant.as_ref().is_some_and(|id| now.iter().any(|g| &g.id == id)) })
            .collect(),
    }
}

/// Who may see the village is the app's own to change (Settings' buttons run the board calls):
/// whatever the window sends with its settings, this part stays as it was.
pub fn keep_app_owned(old: &AccessSettings, _from_window: &AccessSettings) -> AccessSettings {
    old.clone()
}

#[cfg(test)]
#[path = "access_app_tests.rs"]
mod tests;
