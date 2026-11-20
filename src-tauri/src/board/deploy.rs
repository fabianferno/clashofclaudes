//! Putting the phone remote on the team's Vercel account with the owner's own `vercel` CLI, and
//! watching who deploys to it afterwards. The commands and their JSON were recorded from CLI
//! 66.4.0 (the design's spike section).
//!
//! Whoever can deploy to the remote's project can make its page act as a paired phone. The watch
//! here narrows that: a production deployment this Mac neither made nor was told to trust pauses
//! the remote until the owner says so.
use std::path::Path;

use serde_json::Value;

use super::cli::{BoardCli, CliError};
use super::remote::b64;

/// The remote's project on the team: one per team, shared by its villages.
pub const PROJECT: &str = "village-remote";
/// How often the deployments are looked at.
pub const WATCH_MS: i64 = 300_000;

/// A production deployment of the remote.
#[derive(Clone, Debug, PartialEq)]
pub struct Deployment {
    /// Its own address (`village-remote-abc123-team.vercel.app`): unique to it.
    pub id: String,
    pub created: i64,
    /// Who made it (their Vercel username).
    pub by: String,
}

#[derive(Debug, PartialEq)]
pub enum Found {
    /// The team has a remote: its address and the deployment now in production.
    Team { url: String, deployment: String },
    None,
}

#[derive(Debug, PartialEq)]
pub struct Deployed {
    pub url: String,
    pub deployment: String,
}

/// What a first deploy sets and never changes: the push keys (VAPID) and the setup secret.
pub struct NewSecrets {
    pub setup: String,
    pub vapid_public: String,
    pub vapid_private: String,
}

fn scoped(mut args: Vec<String>, team: Option<&str>) -> Vec<String> {
    if let Some(t) = team {
        args.extend(["--scope".to_string(), t.to_string()]);
    }
    args
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn why(e: CliError) -> String {
    match e {
        CliError::Missing => "The Vercel CLI is not installed.".into(),
        CliError::NoBoard => "This Vercel CLI is too old.".into(),
        CliError::SignedOut(m) | CliError::Retryable(m) | CliError::Fatal(m) => m,
    }
}

/// A call's JSON answer; `Err` carries the CLI's own message.
fn json(cli: &dyn BoardCli, args: Vec<String>) -> Result<Value, String> {
    let out = cli.raw(&args).map_err(why)?;
    let v: Value = serde_json::from_str(out.stdout.trim()).map_err(|_| {
        let said = out.stdout.lines().chain(out.stderr.lines()).rfind(|l| !l.trim().is_empty()).unwrap_or("no answer");
        format!("vercel {}: {}", args.first().map(String::as_str).unwrap_or(""), said.chars().take(300).collect::<String>())
    })?;
    Ok(v)
}

fn error_of(v: &Value) -> Option<(String, String)> {
    (v["status"] == "error").then(|| (v["reason"].as_str().unwrap_or_default().to_string(), v["message"].as_str().unwrap_or("The Vercel CLI refused").to_string()))
}

/// The remote's ready production deployments, newest first; None when the team has no such project.
pub fn production_deployments(cli: &dyn BoardCli, team: Option<&str>) -> Result<Option<Vec<Deployment>>, String> {
    let v = json(cli, scoped(s(&["ls", PROJECT, "--environment", "production", "--json"]), team))?;
    match error_of(&v) {
        Some((reason, _)) if reason == "project_not_found" => return Ok(None),
        Some((_, message)) => return Err(message),
        None => {}
    }
    let mut out: Vec<Deployment> = v["deployments"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|d| d["state"] == "READY")
                .filter_map(|d| Some(Deployment { id: d["url"].as_str()?.to_string(), created: d["createdAt"].as_i64().unwrap_or(0), by: d["creator"]["username"].as_str().unwrap_or("someone").to_string() }))
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(Some(out))
}

/// Whether the team already has a remote, and where.
pub fn find(cli: &dyn BoardCli, team: Option<&str>) -> Result<Found, String> {
    let Some(newest) = production_deployments(cli, team)?.and_then(|d| d.into_iter().next()) else { return Ok(Found::None) };
    let v = json(cli, scoped(s(&["inspect", &newest.id, "--json"]), team))?;
    if let Some((_, message)) = error_of(&v) {
        return Err(message);
    }
    let host = v["aliases"].as_array().and_then(|a| a.first()).and_then(Value::as_str).unwrap_or(&newest.id);
    Ok(Found::Team { url: format!("https://{host}"), deployment: newest.id })
}

/// The newest deployment this Mac neither made nor trusted.
pub fn unknown<'a>(seen: &'a [Deployment], trusted: &[String]) -> Option<&'a Deployment> {
    seen.iter().find(|d| !trusted.contains(&d.id))
}

/// What Settings says while the remote is paused over `d`.
pub fn pause_reason(d: &Deployment) -> String {
    format!("The remote was redeployed by {}.", d.by)
}

/// Fresh push keys and a setup secret.
pub fn new_secrets() -> Result<NewSecrets, String> {
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).map_err(|_| "no randomness")?;
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).map_err(|_| "could not make push keys")?;
    // ring writes one fixed PKCS#8 layout for P-256: the 32-byte private scalar starts at byte 36
    let private = pkcs8.as_ref().get(36..68).ok_or("could not make push keys")?;
    let public = pair.public_key().as_ref();
    EcdsaKeyPair::from_private_key_and_public_key(&ECDSA_P256_SHA256_FIXED_SIGNING, private, public, &rng).map_err(|_| "could not make push keys")?;
    let mut secret = [0u8; 24];
    getrandom::fill(&mut secret).map_err(|e| e.to_string())?;
    Ok(NewSecrets { setup: secret.iter().map(|b| format!("{b:02x}")).collect(), vapid_public: b64(public), vapid_private: b64(private) })
}

/// Deploys the bundled remote to production. `src`: an empty folder of the app's own to write the
/// source into. `first`: the secrets of a first deploy; None keeps the variables the project has
/// (an update). `progress` gets one line per step.
pub fn deploy(cli: &dyn BoardCli, team: Option<&str>, src: &Path, board: &str, first: Option<&NewSecrets>, progress: &dyn Fn(&str)) -> Result<Deployed, String> {
    super::remote_src::write_to(src).map_err(|e| format!("could not write the remote's source: {e}"))?;
    let cwd = src.to_string_lossy().into_owned();
    let run = |args: Vec<String>| -> Result<Value, String> {
        let out = cli.raw(&scoped(args, team)).map_err(why)?;
        let v: Value = serde_json::from_str(out.stdout.trim()).unwrap_or(Value::Null);
        match error_of(&v) {
            Some((_, message)) => Err(message),
            None if !out.ok && v.is_null() => Err(out.stderr.lines().chain(out.stdout.lines()).rfind(|l| !l.trim().is_empty()).unwrap_or("the Vercel CLI failed").chars().take(300).collect()),
            None => Ok(v),
        }
    };
    if first.is_some() {
        progress("Making the project…");
        // "already exists" is fine: a teammate made it, or an earlier try got this far
        let _ = cli.raw(&scoped(s(&["project", "add", PROJECT]), team)).map_err(why)?;
    }
    progress("Linking the project…");
    run(s(&["link", "--yes", "--project", PROJECT, "--cwd", &cwd]))?;
    if let Some(n) = first {
        progress("Setting its variables…");
        for (k, v) in [("COC_BOARD", board), ("COC_SETUP", n.setup.as_str()), ("VAPID_PUBLIC", n.vapid_public.as_str()), ("VAPID_PRIVATE", n.vapid_private.as_str())] {
            run(s(&["env", "add", k, "--environment", "production", "--value", v, "--force", "--yes", "--json", "--cwd", &cwd]))?;
        }
    }
    progress("Deploying (a minute or two)…");
    let v = run(s(&["deploy", "--prod", "--yes", "--cwd", &cwd]))?;
    let d = &v["deployment"];
    let host = |k: &str| d[k].as_str().map(|u| u.trim_start_matches("https://").trim_end_matches('/').to_string());
    let deployment = host("url").ok_or("the Vercel CLI did not say where it deployed")?;
    let url = format!("https://{}", host("productionUrl").unwrap_or_else(|| deployment.clone()));
    Ok(Deployed { url, deployment })
}

#[cfg(test)]
#[path = "deploy_tests.rs"]
mod tests;
