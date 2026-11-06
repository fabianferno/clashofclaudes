//! Anonymous usage counts, sent only while the owner has "Share anonymous usage" on (the welcome and
//! Settings), to the project's PostHog. Every event is one of a fixed few, with fixed properties:
//! counts, agent kinds and versions, never workspace names, paths, tasks, prompts or output. The
//! install id is random, made when sharing is turned on and dropped when it is turned off. The key is
//! set at build time (see `build.rs`); builds without one, and dev builds, send nothing.
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::commands::AppState;
use crate::model::AgentKind;

const KEY: Option<&str> = option_env!("COC_POSTHOG_KEY");
/// PostHog's EU cloud: the events stay in the EU.
const ENDPOINT: &str = "https://eu.i.posthog.com/i/v0/e/";

/// What happened. The frontend may send only the ones `FrontEvent` lists.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    AppOpened { workspaces: usize, builders: usize },
    SessionStarted(AgentKind),
    TerminalStarted,
    PromptAnswered { allowed: bool },
    KanbanOpened,
}

/// The events the frontend reports (the rest happen in the backend).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FrontEvent {
    KanbanOpened,
}

fn agent_name(a: &AgentKind) -> &'static str {
    match a {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Antigravity => "antigravity",
        AgentKind::OpenCode => "opencode",
        AgentKind::Grok => "grok",
        AgentKind::Custom => "custom",
    }
}

impl Event {
    fn name(&self) -> &'static str {
        match self {
            Event::AppOpened { .. } => "app_opened",
            Event::SessionStarted(_) => "session_started",
            Event::TerminalStarted => "terminal_started",
            Event::PromptAnswered { .. } => "prompt_answered",
            Event::KanbanOpened => "kanban_opened",
        }
    }
    fn props(&self) -> Map<String, Value> {
        let mut m = Map::new();
        match self {
            Event::AppOpened { workspaces, builders } => {
                m.insert("workspaces".into(), (*workspaces).into());
                m.insert("builders".into(), (*builders).into());
            }
            Event::SessionStarted(a) => {
                m.insert("agent".into(), agent_name(a).into());
            }
            Event::PromptAnswered { allowed } => {
                m.insert("answer".into(), if *allowed { "allow" } else { "deny" }.into());
            }
            Event::TerminalStarted | Event::KanbanOpened => {}
        }
        m
    }
}

/// The app, macOS and chip, sent with every event.
#[derive(Clone, Debug, PartialEq)]
pub struct Context {
    pub app_version: String,
    pub macos: String,
    pub arch: &'static str,
}

/// The JSON PostHog takes for one event: anonymous (no person profile) and keyed by the install id.
pub fn payload(key: &str, install_id: &str, event: Event, ctx: &Context) -> Value {
    let mut props = event.props();
    props.insert("app_version".into(), ctx.app_version.clone().into());
    props.insert("os_version".into(), ctx.macos.clone().into());
    props.insert("arch".into(), ctx.arch.into());
    props.insert("$process_person_profile".into(), false.into());
    props.insert("$lib".into(), "clash-of-claudes".into());
    json!({ "api_key": key, "event": event.name(), "distinct_id": install_id, "properties": props })
}

/// The key this build sends with, if it has a PostHog project key.
fn key() -> Option<&'static str> {
    KEY.map(str::trim).filter(|k| k.starts_with("phc_"))
}

/// Whether this build sends at all: a release with a key (or a dev build run with COC_USAGE_DEV=1, to test).
fn enabled() -> bool {
    key().is_some() && (!cfg!(debug_assertions) || std::env::var("COC_USAGE_DEV").is_ok_and(|v| v == "1"))
}

/// Records `event` if the owner shares usage. Never blocks or fails the caller: sent in the
/// background, once, and dropped on any error.
pub fn track(app: &AppHandle, event: Event) {
    if !enabled() {
        return;
    }
    let Some(state) = app.try_state::<AppState>() else { return };
    let install_id = {
        let d = state.data();
        match (&d.settings.share_usage, &d.settings.install_id) {
            (true, Some(id)) => id.clone(),
            _ => return,
        }
    };
    let ctx = context(app);
    let body = payload(key().unwrap_or_default(), &install_id, event, &ctx);
    tauri::async_runtime::spawn(async move {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let Ok(client) = http_client::Client::builder().timeout(Duration::from_secs(10)).build() else { return };
        let _ = client.post(ENDPOINT).header("content-type", "application/json").body(body.to_string()).send().await;
    });
}

fn context(app: &AppHandle) -> Context {
    let system = crate::bugreport::system(app);
    let get = |k: &str| system.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_default();
    Context { app_version: get("App"), macos: get("macOS"), arch: std::env::consts::ARCH }
}

/// An event the frontend saw (opening the Kanban).
#[tauri::command]
pub fn track_usage(event: FrontEvent, app: AppHandle) {
    match event {
        FrontEvent::KanbanOpened => track(&app, Event::KanbanOpened),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Context {
        Context { app_version: "0.2.6".into(), macos: "15.4".into(), arch: "aarch64" }
    }

    #[test]
    fn an_event_carries_only_its_fixed_properties_and_no_person() {
        let p = payload("phc_x", "id-1", Event::SessionStarted(AgentKind::Codex), &ctx());
        assert_eq!(p["event"], "session_started");
        assert_eq!(p["distinct_id"], "id-1");
        assert_eq!(p["api_key"], "phc_x");
        let props = p["properties"].as_object().unwrap();
        let mut keys: Vec<&str> = props.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["$lib", "$process_person_profile", "agent", "app_version", "arch", "os_version"]);
        assert_eq!(props["agent"], "codex");
        assert_eq!(props["$process_person_profile"], false);
    }

    #[test]
    fn app_opened_sends_counts_and_prompts_send_the_answer() {
        let p = payload("phc_x", "i", Event::AppOpened { workspaces: 3, builders: 5 }, &ctx());
        assert_eq!((p["event"].as_str(), &p["properties"]["workspaces"], &p["properties"]["builders"]), (Some("app_opened"), &json!(3), &json!(5)));
        let p = payload("phc_x", "i", Event::PromptAnswered { allowed: false }, &ctx());
        assert_eq!(p["properties"]["answer"], "deny");
    }

    #[test]
    fn the_frontend_can_send_only_the_events_it_lists() {
        assert_eq!(serde_json::from_str::<FrontEvent>(r#""kanbanOpened""#).unwrap(), FrontEvent::KanbanOpened);
        assert!(serde_json::from_str::<FrontEvent>(r#""appOpened""#).is_err());
        assert!(serde_json::from_str::<FrontEvent>(r#""anything""#).is_err());
    }
}
