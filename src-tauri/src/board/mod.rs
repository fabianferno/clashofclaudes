//! The village on Vercel Board (Settings › Team): every agent session of a shared workspace is one
//! thread on the team's board, and the thread's labels say how the session stands.
//!
//! This file is the pure part: names, labels, texts, and `plan`, which turns what the board last
//! got for a session and what the session is now into the writes that bring the board up to date.
//! Design: `docs/superpowers/specs/2026-11-20-board-link-design.md`.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::model::{AgentKind, SessionInfo, SessionState, Workspace};
use crate::queue::{queue_reason, QueueReason};

pub mod access;
pub mod access_app;
pub mod app;
pub mod cli;
pub mod deploy;
pub mod listen;
pub mod map;
pub mod pairing;
pub mod phones;
pub mod publisher;
pub mod remote;
pub mod remote_app;
pub mod remote_src;
pub mod snapshot;
#[cfg(test)]
mod real_run_tests;
pub mod store;
pub mod visits;

#[cfg(test)]
mod tests;

/// Board's limit for one message, in characters.
pub const MAX_TEXT: usize = 10_000;
/// The profile the app writes status under ("village via ada"); builders write under their own.
pub const STATUS_PROFILE: &str = "village";
const CUT_MARK: &str = "… (cut)";
const MAX_FILES: usize = 20;

/// Lower case letters, digits and single hyphens; "x" when nothing is left.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() { "x".into() } else { out.into() }
}

/// A board profile for a builder: starts with a letter, at most 32 letters, digits and hyphens.
pub fn profile_name(builder: &str) -> String {
    let s = slug(builder);
    let named = !s.starts_with(|c: char| c.is_ascii_digit()) && s != "x";
    let s = if named { s } else { format!("builder-{s}") };
    s.chars().take(32).collect::<String>().trim_end_matches('-').to_string()
}

/// Each workspace's channel name, by workspace id. Workspaces whose names give the same slug get
/// the start of their id added, so no two share a channel.
pub fn workspace_slugs(ws: &[Workspace]) -> HashMap<String, String> {
    let mut count: HashMap<String, usize> = HashMap::new();
    for w in ws {
        *count.entry(slug(&w.name)).or_default() += 1;
    }
    ws.iter()
        .map(|w| {
            let s = slug(&w.name);
            let s = if count[&s] > 1 { format!("{s}-{}", slug(&w.id.chars().take(6).collect::<String>())) } else { s };
            (w.id.clone(), s)
        })
        .collect()
}

/// A workspace's channel in its owner's village.
pub fn channel(owner: &str, ws_slug: &str) -> String {
    format!("v/{owner}/w/{ws_slug}")
}

/// `text`, cut to what one message holds.
pub fn cut(text: &str) -> String {
    if text.chars().count() <= MAX_TEXT {
        return text.to_string();
    }
    let keep = MAX_TEXT - CUT_MARK.chars().count();
    text.chars().take(keep).chain(CUT_MARK.chars()).collect()
}

/// A session's state as the board's `coc.state` label has it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Wire {
    Starting,
    Working,
    NeedsYou,
    Finished,
    Stuck,
    Paused,
    Closed,
}

impl Wire {
    pub fn as_str(self) -> &'static str {
        match self {
            Wire::Starting => "starting",
            Wire::Working => "working",
            Wire::NeedsYou => "needs_you",
            Wire::Finished => "finished",
            Wire::Stuck => "stuck",
            Wire::Paused => "paused",
            Wire::Closed => "closed",
        }
    }
}

/// Why a session waits on its owner (`coc.wait`): the queue's four reasons.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Wait {
    Decide,
    Answer,
    Review,
    Stuck,
}

impl Wait {
    pub fn as_str(self) -> &'static str {
        match self {
            Wait::Decide => "decide",
            Wait::Answer => "answer",
            Wait::Review => "review",
            Wait::Stuck => "stuck",
        }
    }
}

/// How a closed session ended (`coc.outcome`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Accepted,
    Discarded,
}

/// What the board last got for a session (kept in `board.json`).
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Published {
    /// "<team or empty>/<board name>": the board the thread is on.
    pub board: String,
    pub channel: String,
    /// The root message's id, once posted.
    pub root: Option<String>,
    pub state: Wire,
    pub wait: Option<Wait>,
    pub since: i64,
    /// The root already leads with the agent's title (or never will).
    pub titled: bool,
    /// Closed because its workspace stopped being shared; sharing again reopens this thread.
    #[serde(default)]
    pub unshared: bool,
    /// The prompt block of the wait it is in (`remote::block_json`), as its reply carried it.
    #[serde(default)]
    pub block: Option<String>,
}

/// What a session is now.
pub enum Now<'a> {
    Live(&'a SessionInfo),
    /// The app is quitting with the session alive.
    Paused,
    Closed(Option<Outcome>),
}

/// What `plan` needs to know beyond the session itself.
pub struct Ctx<'a> {
    /// The builder's display name.
    pub builder: &'a str,
    pub agent: AgentKind,
    pub channel: &'a str,
    pub board: &'a str,
    pub host_id: &'a str,
    pub share_details: bool,
    /// Files changed since the session started; used only when it finishes.
    pub files: &'a [String],
    /// The app has the keys for the open permission prompt (`SessionManager::answerable`).
    pub answerable: bool,
}

/// One call to the board. Replies, labels and edits go to the session's root, which the caller knows.
#[derive(Clone, PartialEq, Debug)]
pub enum Write {
    PostRoot { channel: String, text: String, labels: Vec<(String, String)>, key: String },
    Reply { text: String, labels: Vec<(String, String)>, key: String },
    Label { set: Vec<(String, String)>, unset: Vec<String> },
    EditRoot { text: String },
}

pub(crate) fn agent_key(a: &AgentKind) -> &'static str {
    match a {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Antigravity => "antigravity",
        AgentKind::OpenCode => "opencode",
        AgentKind::Grok => "grok",
        AgentKind::Custom => "custom",
    }
}

fn agent_name(a: &AgentKind) -> &'static str {
    match a {
        AgentKind::Claude => "Claude Code",
        AgentKind::Codex => "Codex",
        AgentKind::Antigravity => "Antigravity",
        AgentKind::OpenCode => "OpenCode",
        AgentKind::Grok => "Grok Build",
        AgentKind::Custom => "Custom",
    }
}

pub(crate) fn wire(info: &SessionInfo) -> Wire {
    match info.state {
        SessionState::Starting => Wire::Starting,
        SessionState::Working => Wire::Working,
        SessionState::NeedsYou { .. } => Wire::NeedsYou,
        SessionState::Finished => Wire::Finished,
        SessionState::Stuck { .. } => Wire::Stuck,
        SessionState::Ended { .. } if info.paused => Wire::Paused,
        SessionState::Ended { .. } => Wire::Stuck,
    }
}

pub(crate) fn wait(info: &SessionInfo) -> Option<Wait> {
    queue_reason(info).map(|r| match r {
        QueueReason::Decide => Wait::Decide,
        QueueReason::Answer => Wait::Answer,
        QueueReason::Stuck => Wait::Stuck,
        QueueReason::Review => Wait::Review,
    })
}

fn kv(k: &str, v: impl Into<String>) -> (String, String) {
    (k.to_string(), v.into())
}

fn root_text(info: &SessionInfo, ctx: &Ctx<'_>) -> String {
    let who = format!("**{}** ({})", ctx.builder, agent_name(&ctx.agent));
    if !ctx.share_details {
        return who;
    }
    let task = info.task.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let title = info.title.as_deref().map(str::trim).filter(|t| !t.is_empty());
    cut(&match (title, task) {
        (Some(title), Some(task)) => format!("{who}: {title}\n\n{task}"),
        (Some(one), None) | (None, Some(one)) => format!("{who}: {one}"),
        (None, None) => format!("{who}: No task given"),
    })
}

/// What the thread says when the session starts waiting for `why`.
fn reply_prose(info: &SessionInfo, why: Wait, ctx: &Ctx<'_>) -> String {
    if !ctx.share_details {
        return match why {
            Wait::Decide => "Wants a decision",
            Wait::Answer => "Asking you",
            Wait::Review => "Finished",
            Wait::Stuck => "Stuck",
        }
        .to_string();
    }
    let reason = match &info.state {
        SessionState::NeedsYou { reason } | SessionState::Stuck { reason } => reason.as_str(),
        _ => "",
    };
    match why {
        Wait::Decide => match info.asking.as_deref() {
            Some(call) => format!("Wants a decision: `{call}`"),
            None => "Wants a decision".to_string(),
        },
        Wait::Answer if info.questions.is_empty() => format!("Asking you: {reason}"),
        Wait::Answer => info
            .questions
            .iter()
            .map(|q| {
                let mut s = format!("Asking you: {}", q.question);
                for (n, o) in q.options.iter().enumerate() {
                    s.push_str(&format!("\n{}. {}", n + 1, o.label));
                    if let Some(d) = o.description.as_deref().filter(|d| !d.is_empty()) {
                        s.push_str(&format!(": {d}"));
                    }
                }
                s
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        Wait::Review => {
            let mut s = "Finished.".to_string();
            if let Some(last) = info.last_message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
                s.push_str(&format!("\n\n{last}"));
            }
            if !ctx.files.is_empty() {
                let shown = ctx.files.iter().take(MAX_FILES).cloned().collect::<Vec<_>>().join(", ");
                s.push_str(&format!("\n\nChanged: {shown}"));
                if ctx.files.len() > MAX_FILES {
                    s.push_str(&format!(" and {} more", ctx.files.len() - MAX_FILES));
                }
            }
            s
        }
        Wait::Stuck => format!("Stuck: {reason}"),
    }
}

/// `text` cut to `max` characters, marked when cut.
fn cut_to(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let keep = max.saturating_sub(CUT_MARK.chars().count());
    text.chars().take(keep).chain(CUT_MARK.chars()).collect()
}

/// The reply for a wait, and the prompt block that ends it. The prose is cut to leave the block whole.
fn reply(session_id: &str, info: &SessionInfo, why: Wait, ctx: &Ctx<'_>) -> (Write, String) {
    let block = remote::block_json(&remote::block(info, session_id, ctx.host_id, why.as_str(), ctx.answerable, ctx.share_details));
    let tail = remote::fenced(&block);
    let prose = cut_to(&reply_prose(info, why, ctx), MAX_TEXT.saturating_sub(tail.chars().count()));
    let write = Write::Reply {
        text: format!("{prose}{tail}"),
        labels: vec![kv("coc.since", info.state_since.to_string())],
        key: format!("coc-{session_id}-{}-{}", info.state_since, why.as_str()),
    };
    (write, block)
}

/// The writes that take the board from `prev` to `now`, and the record to keep once they have
/// succeeded (its `root` is the caller's to fill in after a `PostRoot`).
pub fn plan(session_id: &str, prev: Option<&Published>, now: Now<'_>, ctx: &Ctx<'_>) -> (Vec<Write>, Published) {
    let posted = prev.filter(|p| p.root.is_some());
    let info = match now {
        Now::Live(info) => info,
        Now::Paused | Now::Closed(_) => {
            let to = if matches!(now, Now::Paused) { Wire::Paused } else { Wire::Closed };
            // Nothing on the board, or already there: nothing to say.
            let Some(p) = posted.filter(|p| p.state != to && p.state != Wire::Closed) else {
                let rec = prev.cloned().unwrap_or_else(|| Published {
                    board: ctx.board.into(),
                    channel: ctx.channel.into(),
                    root: None,
                    state: to,
                    wait: None,
                    since: 0,
                    titled: false,
                    unshared: false,
                    block: None,
                });
                return (vec![], rec);
            };
            let mut set = vec![kv("coc.state", to.as_str())];
            if let Now::Closed(Some(o)) = now {
                set.push(kv("coc.outcome", if o == Outcome::Accepted { "accepted" } else { "discarded" }));
            }
            let unset = if p.wait.is_some() { vec!["coc.wait".to_string()] } else { vec![] };
            return (vec![Write::Label { set, unset }], Published { state: to, wait: None, block: None, ..p.clone() });
        }
    };

    let (state, why, since) = (wire(info), wait(info), info.state_since);
    let titled = !ctx.share_details || info.title.as_deref().is_some_and(|t| !t.trim().is_empty());

    let Some(p) = posted else {
        let mut labels = vec![kv("coc.kind", "session"), kv("coc.state", state.as_str())];
        if let Some(w) = why {
            labels.push(kv("coc.wait", w.as_str()));
        }
        labels.extend([
            kv("coc.agent", agent_key(&ctx.agent)),
            kv("coc.builder", profile_name(ctx.builder)),
            kv("coc.host", ctx.host_id),
            kv("coc.session", session_id),
            kv("coc.since", since.to_string()),
        ]);
        let mut writes = vec![Write::PostRoot { channel: ctx.channel.into(), text: root_text(info, ctx), labels, key: format!("coc-{session_id}-root") }];
        let block = why.map(|w| reply(session_id, info, w, ctx)).map(|(write, block)| {
            writes.push(write);
            block
        });
        let rec = Published { board: ctx.board.into(), channel: ctx.channel.into(), root: None, state, wait: why, since, titled, unshared: false, block };
        return (writes, rec);
    };

    let mut writes = Vec::new();
    let fresh = p.unshared;
    let (mut set, mut unset) = (Vec::new(), Vec::new());
    if fresh || p.state != state {
        set.push(kv("coc.state", state.as_str()));
    }
    match why {
        Some(w) if fresh || p.wait != Some(w) => set.push(kv("coc.wait", w.as_str())),
        None if p.wait.is_some() => unset.push("coc.wait".to_string()),
        _ => {}
    }
    if fresh || p.since != since {
        set.push(kv("coc.since", since.to_string()));
    }
    if !set.is_empty() || !unset.is_empty() {
        writes.push(Write::Label { set, unset });
    }
    // A reply each time it starts waiting for something new.
    let mut block = why.and(p.block.clone());
    if let Some(w) = why
        && (fresh || p.wait != Some(w) || p.since != since)
    {
        let (write, b) = reply(session_id, info, w, ctx);
        writes.push(write);
        block = Some(b);
    }
    if titled && !p.titled && ctx.share_details {
        writes.push(Write::EditRoot { text: root_text(info, ctx) });
    }
    (writes, Published { state, wait: why, since, titled: p.titled || titled, unshared: false, block, ..p.clone() })
}
