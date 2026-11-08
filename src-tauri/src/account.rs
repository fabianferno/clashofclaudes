//! Who each rationed agent is signed in as, for the tank's panel. Read only, all local:
//!   * Claude Code: `claude auth status` prints JSON (`loggedIn`, `authMethod`, `email`,
//!     `subscriptionType`, `planTier`, `orgName`).
//!   * Codex: `$CODEX_HOME/auth.json` (else `~/.codex/auth.json`). With `auth_mode: chatgpt` the
//!     `id_token` JWT's claims carry `email` and `https://api.openai.com/auth.chatgpt_plan_type`;
//!     only those two claims are read (the tokens themselves are never kept or sent anywhere).
//!   * Antigravity: `~/.gemini/google_accounts.json`, whose `active` is the signed-in Google
//!     account.
use crate::model::AgentKind;
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccount {
    pub agent: Option<AgentKind>,
    pub signed_in: bool,
    pub email: Option<String>,
    /// Plan, as the provider names it, made readable ("Max 20x", "Go").
    pub plan: Option<String>,
    /// How it signs in when that is not an account (an API key), or the organization.
    pub detail: Option<String>,
}

const CLAUDE_TIMEOUT: Duration = Duration::from_secs(20);

/// `max_20x` -> `Max 20x`, `go` -> `Go`.
fn readable(s: &str) -> String {
    s.split(['_', '-', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// From `claude auth status` JSON.
pub fn parse_claude_status(v: &Value) -> AgentAccount {
    let signed_in = v.get("loggedIn").and_then(Value::as_bool).unwrap_or(false);
    let method = text(v, "authMethod");
    let plan = text(v, "planTier").or_else(|| text(v, "subscriptionType")).map(|p| readable(&p));
    let detail = match method.as_deref() {
        Some("claude.ai") | None => None,
        Some(m) if m.to_ascii_lowercase().contains("key") => Some("API key".into()),
        Some(m) => Some(m.into()),
    };
    AgentAccount { agent: Some(AgentKind::Claude), signed_in, email: text(v, "email"), plan, detail }
}

/// The claims of a JWT (unverified: it only labels the panel).
fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// From Codex's `auth.json`.
pub fn parse_codex_auth(v: &Value) -> AgentAccount {
    let mut a = AgentAccount { agent: Some(AgentKind::Codex), ..Default::default() };
    let claims = v.pointer("/tokens/id_token").and_then(Value::as_str).and_then(jwt_claims);
    if let Some(c) = claims {
        a.signed_in = true;
        a.email = text(&c, "email");
        a.plan = c.pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type").and_then(Value::as_str).map(readable);
    } else if text(v, "OPENAI_API_KEY").is_some() {
        a.signed_in = true;
        a.detail = Some("API key".into());
    }
    a
}

/// From `~/.gemini/google_accounts.json`.
pub fn parse_google_accounts(v: &Value) -> AgentAccount {
    let email = text(v, "active");
    AgentAccount { agent: Some(AgentKind::Antigravity), signed_in: email.is_some(), email, ..Default::default() }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The account `agent` is signed in as; None when the agent has no account to show or its
/// source could not be read (not installed, never signed in).
pub fn read(agent: &AgentKind, cwd: &Path) -> Option<AgentAccount> {
    match agent {
        AgentKind::Claude => {
            let out = crate::quota::run_quiet("claude", &["auth", "status"], cwd, CLAUDE_TIMEOUT)?;
            Some(parse_claude_status(&serde_json::from_str(out.trim()).ok()?))
        }
        AgentKind::Codex => {
            let dir = std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| home().map(|h| h.join(".codex")))?;
            Some(parse_codex_auth(&read_json(&dir.join("auth.json"))?))
        }
        AgentKind::Antigravity => Some(parse_google_accounts(&read_json(&home()?.join(".gemini/google_accounts.json"))?)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Live: reads this machine's accounts (`cargo test -- --ignored accounts_live --nocapture`).
    #[test]
    #[ignore]
    fn accounts_live() {
        for a in [AgentKind::Claude, AgentKind::Codex, AgentKind::Antigravity] {
            eprintln!("{a:?}: {:?}", read(&a, &std::env::temp_dir()));
        }
    }

    #[test]
    fn claude_reads_email_and_plan() {
        // shape of Claude Code 2.1.319's `claude auth status`
        let a = parse_claude_status(&json!({
            "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
            "email": "me@example.com", "orgName": "me@example.com's Organization",
            "subscriptionType": "max", "planTier": "max_20x"
        }));
        assert_eq!(a, AgentAccount {
            agent: Some(AgentKind::Claude), signed_in: true, email: Some("me@example.com".into()), plan: Some("Max 20x".into()), detail: None,
        });
        let key = parse_claude_status(&json!({ "loggedIn": true, "authMethod": "api_key" }));
        assert_eq!((key.signed_in, key.email, key.detail.as_deref()), (true, None, Some("API key")));
        assert!(!parse_claude_status(&json!({ "loggedIn": false })).signed_in);
    }

    #[test]
    fn codex_reads_the_id_token_claims_only() {
        let claims = json!({ "email": "me@example.com", "https://api.openai.com/auth": { "chatgpt_plan_type": "go" } });
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        let a = parse_codex_auth(&json!({ "auth_mode": "chatgpt", "tokens": { "id_token": format!("h.{b64}.sig"), "access_token": "x" } }));
        assert_eq!((a.signed_in, a.email.as_deref(), a.plan.as_deref()), (true, Some("me@example.com"), Some("Go")));
        let key = parse_codex_auth(&json!({ "auth_mode": "apikey", "OPENAI_API_KEY": "sk-…" }));
        assert_eq!((key.signed_in, key.detail.as_deref()), (true, Some("API key")));
        assert!(!parse_codex_auth(&json!({})).signed_in);
    }

    #[test]
    fn antigravity_reads_the_active_google_account() {
        let a = parse_google_accounts(&json!({ "active": "me@gmail.com", "old": [] }));
        assert_eq!((a.signed_in, a.email.as_deref()), (true, Some("me@gmail.com")));
        assert!(!parse_google_accounts(&json!({ "active": null })).signed_in);
    }
}
