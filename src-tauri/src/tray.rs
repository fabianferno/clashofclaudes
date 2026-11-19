//! The menu bar item: the owner's queue as a count beside the icon and a native menu, with
//! Allow / Deny for a waiting permission and Open for anything else. Built from `queue.rs`, so it
//! shows what the window's queue shows, also while the window is closed (hidden).
//!
//! A row never shows task text or the agent's title. A permission row shows the tool call (which
//! can hold a command, a path or a URL), cut short: Allow must not be a blind approval.
use crate::queue::{QueueItem, QueueReason};
use crate::commands::AppState;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

/// The tray icon's id.
pub const TRAY_ID: &str = "main";
/// A tool call (or any detail) is cut to this many characters.
pub const DETAIL_MAX: usize = 60;
/// At most this many sessions are listed; the rest are an "and N more" line.
pub const MAX_ROWS: usize = 10;
/// How often the menu is looked at again with nothing changing, so its waits ("4m") move on.
const TICK: std::time::Duration = std::time::Duration::from_secs(60);

/// One waiting session in the menu.
#[derive(Clone, Debug, PartialEq)]
pub struct TrayRow {
    pub session_id: String,
    pub reason: QueueReason,
    pub label: String,
    /// The open prompt's `state_since` when the app can answer it: the row offers Allow and Deny,
    /// and they answer only that prompt.
    pub decide_since: Option<i64>,
}

/// Everything the menu bar shows; the native menu is rebuilt only when this changes.
#[derive(Clone, Debug, PartialEq)]
pub struct TrayModel {
    pub count: usize,
    pub header: String,
    pub rows: Vec<TrayRow>,
    /// Waiting sessions past `MAX_ROWS`.
    pub more: usize,
    pub mini_open: bool,
}

/// "Sir Hammer · Bash: npm test · 4m": one line, the detail cut to `DETAIL_MAX` characters.
pub fn row_label(builder: &str, detail: &str, waited: &str) -> String {
    let flat = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    let detail = if flat.chars().count() > DETAIL_MAX {
        format!("{}…", flat.chars().take(DETAIL_MAX - 1).collect::<String>())
    } else {
        flat
    };
    format!("{builder} · {detail} · {waited}")
}

/// The menu for `queue`. `builder_name` takes a builder id, `workspace_name` a workspace id and
/// `answerable` a session id (whether the app can answer its open prompt).
pub fn model(
    queue: &[QueueItem],
    builder_name: &dyn Fn(&str) -> String,
    workspace_name: &dyn Fn(&str) -> String,
    answerable: &dyn Fn(&str) -> bool,
    now_ms: i64,
    mini_open: bool,
) -> TrayModel {
    use crate::model::{SessionKind, SessionState};
    let rows = queue
        .iter()
        .take(MAX_ROWS)
        .map(|q| {
            let s = &q.session;
            let builder = match &s.kind {
                SessionKind::Agent { builder_id } => builder_name(builder_id),
                SessionKind::Terminal => "Terminal".to_string(),
            };
            let detail = match (q.reason, &s.asking, &s.state) {
                (QueueReason::Decide, Some(asking), _) => asking.clone(),
                (QueueReason::Decide, None, SessionState::NeedsYou { reason }) => reason.clone(),
                _ => workspace_name(&s.workspace_id),
            };
            let waited = crate::queue::waited_label(now_ms - crate::queue::waiting_since(s));
            TrayRow {
                session_id: s.id.clone(),
                reason: q.reason,
                label: row_label(&builder, &detail, &waited),
                decide_since: (q.reason == QueueReason::Decide && answerable(&s.id)).then_some(s.state_since),
            }
        })
        .collect();
    TrayModel {
        count: queue.len(),
        header: if queue.is_empty() { "Nothing waiting on you".to_string() } else { format!("{} waiting on you", queue.len()) },
        rows,
        more: queue.len().saturating_sub(MAX_ROWS),
        mini_open,
    }
}

/// What a click in the menu asks for.
#[derive(Clone, Debug, PartialEq)]
pub enum TrayAction {
    Allow { id: String, since: i64 },
    Deny { id: String, since: i64 },
    Open { id: String },
    OpenVillage,
    ToggleMini,
    Quit,
}

/// The menu item id that carries `a`.
pub fn action_id(a: &TrayAction) -> String {
    match a {
        TrayAction::Allow { id, since } => format!("q:allow:{id}:{since}"),
        TrayAction::Deny { id, since } => format!("q:deny:{id}:{since}"),
        TrayAction::Open { id } => format!("q:open:{id}"),
        TrayAction::OpenVillage => "tray:open".to_string(),
        TrayAction::ToggleMini => "tray:mini".to_string(),
        TrayAction::Quit => "tray:quit".to_string(),
    }
}

/// The action a menu item id carries; None for any other menu's ids.
pub fn parse_action(id: &str) -> Option<TrayAction> {
    match id {
        "tray:open" => return Some(TrayAction::OpenVillage),
        "tray:mini" => return Some(TrayAction::ToggleMini),
        "tray:quit" => return Some(TrayAction::Quit),
        _ => {}
    }
    let rest = id.strip_prefix("q:")?;
    let (verb, rest) = rest.split_once(':')?;
    let decided = |rest: &str| {
        let (sid, since) = rest.rsplit_once(':')?;
        (!sid.is_empty()).then_some(())?;
        Some((sid.to_string(), since.parse::<i64>().ok()?))
    };
    match verb {
        "allow" => decided(rest).map(|(id, since)| TrayAction::Allow { id, since }),
        "deny" => decided(rest).map(|(id, since)| TrayAction::Deny { id, since }),
        "open" if !rest.is_empty() => Some(TrayAction::Open { id: rest.to_string() }),
        _ => None,
    }
}

/// The last menu shown, so the native menu is rebuilt only on a change (session updates arrive
/// with every tool step).
#[derive(Default)]
pub struct TrayCache(Mutex<Option<TrayModel>>);

impl TrayCache {
    /// True (and remembers `m`) when `m` differs from the last one; the first call is true.
    pub fn changed(&self, m: &TrayModel) -> bool {
        let mut last = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if last.as_ref() == Some(m) {
            return false;
        }
        *last = Some(m.clone());
        true
    }
}

/// The menu as it stands now.
fn model_now<R: Runtime>(app: &AppHandle<R>) -> TrayModel {
    let queue = crate::queue_now(app);
    let Some(state) = app.try_state::<AppState>() else {
        return model(&[], &|_| String::new(), &|_| String::new(), &|_| false, 0, false);
    };
    let (builders, workspaces) = {
        let d = state.data.lock().unwrap_or_else(|e| e.into_inner());
        (
            d.builders.iter().map(|b| (b.id.clone(), b.name.clone())).collect::<Vec<_>>(),
            d.workspaces.iter().map(|w| (w.id.clone(), w.name.clone())).collect::<Vec<_>>(),
        )
    };
    let name_in = |list: &[(String, String)], id: &str, or: &str| {
        list.iter().find(|(i, _)| i == id).map_or_else(|| or.to_string(), |(_, n)| n.clone())
    };
    model(
        &queue,
        &|id| name_in(&builders, id, "Builder"),
        &|id| name_in(&workspaces, id, "Workspace"),
        &|id| state.manager.answerable(id),
        crate::quota::now_ms(),
        crate::mini::is_open(app),
    )
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, m: &TrayModel) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::new(app, &m.header, false, None::<&str>)?)?;
    let mut section = None;
    for row in &m.rows {
        if section != Some(row.reason) {
            section = Some(row.reason);
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            menu.append(&MenuItem::new(app, row.reason.label(), false, None::<&str>)?)?;
        }
        let open = action_id(&TrayAction::Open { id: row.session_id.clone() });
        match row.decide_since {
            Some(since) => {
                let id = row.session_id.clone();
                let sub = Submenu::new(app, &row.label, true)?;
                sub.append(&MenuItem::with_id(app, action_id(&TrayAction::Allow { id: id.clone(), since }), "Allow", true, None::<&str>)?)?;
                sub.append(&MenuItem::with_id(app, action_id(&TrayAction::Deny { id, since }), "Deny", true, None::<&str>)?)?;
                sub.append(&PredefinedMenuItem::separator(app)?)?;
                sub.append(&MenuItem::with_id(app, open, "Open", true, None::<&str>)?)?;
                menu.append(&sub)?;
            }
            None => menu.append(&MenuItem::with_id(app, open, &row.label, true, None::<&str>)?)?,
        }
    }
    if m.more > 0 {
        menu.append(&MenuItem::new(app, format!("and {} more", m.more), false, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, action_id(&TrayAction::OpenVillage), "Open Village", true, None::<&str>)?)?;
    menu.append(&CheckMenuItem::with_id(app, action_id(&TrayAction::ToggleMini), "Mini Village", true, m.mini_open, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, action_id(&TrayAction::Quit), "Quit Clash of Claudes", true, None::<&str>)?)?;
    Ok(menu)
}

/// Brings the menu bar item up to date: a new menu and count when what it shows changed, nothing
/// otherwise. Cheap to call on every session update.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let m = model_now(app);
    if app.try_state::<TrayCache>().is_some_and(|c| !c.changed(&m)) {
        return;
    }
    if let Ok(menu) = build_menu(app, &m) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_title((m.count > 0).then(|| m.count.to_string()));
}

/// Puts the item in the menu bar (its menu opens on a click) and keeps its waits moving.
pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.manage(TrayCache::default());
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Clash of Claudes")
        .show_menu_on_left_click(true)
        .build(app)?;
    refresh(app);
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        refresh(&handle);
    });
    Ok(())
}

/// A click in the menu bar's menu. False when `id` belongs to another menu.
pub fn on_menu_event(app: &AppHandle, id: &str) -> bool {
    let Some(action) = parse_action(id) else { return false };
    match action {
        // Answered from the menu bar: the window stays where it is. A prompt that was answered or
        // replaced since the menu was built is refused by the manager, and nothing happens.
        TrayAction::Allow { id, since } => {
            if app.state::<AppState>().manager.approve_if(&id, since).is_ok() {
                crate::usage::track(app, crate::usage::Event::PromptAnswered { allowed: true });
            }
        }
        TrayAction::Deny { id, since } => {
            if app.state::<AppState>().manager.deny_if(&id, since).is_ok() {
                crate::usage::track(app, crate::usage::Event::PromptAnswered { allowed: false });
            }
        }
        TrayAction::Open { id } => crate::focus_and_select(app, &id),
        TrayAction::OpenVillage => crate::show_main(app),
        TrayAction::ToggleMini => crate::mini::toggle(app),
        TrayAction::Quit => app.exit(0),
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SessionInfo, SessionKind, SessionState};

    fn item(id: &str, reason: QueueReason, since: i64, f: impl FnOnce(&mut SessionInfo)) -> QueueItem {
        let state = match reason {
            QueueReason::Decide | QueueReason::Answer => SessionState::NeedsYou { reason: "Permission needed".into() },
            QueueReason::Stuck => SessionState::Stuck { reason: "no output".into() },
            QueueReason::Review => SessionState::Finished,
        };
        let mut s = SessionInfo {
            id: id.into(),
            workspace_id: "w1".into(),
            kind: SessionKind::Agent { builder_id: "b1".into() },
            task: Some("SECRET TASK TEXT".into()),
            title: Some("SECRET TITLE".into()),
            state,
            steps: 0,
            started_at: 0,
            last_output_at: 0,
            reached_finished: false,
            worktree: None,
            command_preview: String::new(),
            awaiting_decision: reason == QueueReason::Decide,
            busy: false,
            rev: 1,
            spot: None,
            paused: false,
            subagents: vec![],
            state_since: since,
            last_message: Some("SECRET REPLY".into()),
            asking: None,
            questions: vec![],
            parked: None,
        };
        f(&mut s);
        QueueItem { reason, session: s }
    }
    fn build(queue: &[QueueItem], answerable: bool, now: i64) -> TrayModel {
        model(queue, &|_| "Sir Hammer".to_string(), &|_| "webapp".to_string(), &|_| answerable, now, false)
    }

    #[test]
    fn row_label_cuts_tool_call_at_60() {
        let long = "x".repeat(100);
        assert_eq!(row_label("Bob", &long, "4m"), format!("Bob · {}… · 4m", "x".repeat(59)));
        let exact = "y".repeat(60);
        assert_eq!(row_label("Bob", &exact, "4m"), format!("Bob · {exact} · 4m"));
    }

    #[test]
    fn row_label_cuts_on_char_boundary() {
        let hammers = "🔨".repeat(80);
        assert_eq!(row_label("Bob", &hammers, "1m"), format!("Bob · {}… · 1m", "🔨".repeat(59)));
    }

    #[test]
    fn row_label_keeps_to_one_line() {
        assert_eq!(row_label("Bob", "Bash: echo a\n  && echo b", "1m"), "Bob · Bash: echo a && echo b · 1m");
    }

    #[test]
    fn model_header_and_rows() {
        let empty = build(&[], true, 0);
        assert_eq!((empty.count, empty.header.as_str(), empty.rows.len(), empty.more), (0, "Nothing waiting on you", 0, 0));

        let queue = vec![
            item("d1", QueueReason::Decide, 60_000, |s| s.asking = Some("Bash: npm test".into())),
            item("d2", QueueReason::Decide, 60_000, |_| {}),
            item("r1", QueueReason::Review, 0, |_| {}),
        ];
        let m = build(&queue, true, 300_000);
        assert_eq!((m.count, m.header.as_str(), m.more), (3, "3 waiting on you", 0));
        assert_eq!(m.rows[0], TrayRow { session_id: "d1".into(), reason: QueueReason::Decide, label: "Sir Hammer · Bash: npm test · 4m".into(), decide_since: Some(60_000) });
        assert_eq!(m.rows[1].label, "Sir Hammer · Permission needed · 4m", "no tool call: the reason it gave");
        assert_eq!(m.rows[2], TrayRow { session_id: "r1".into(), reason: QueueReason::Review, label: "Sir Hammer · webapp · 5m".into(), decide_since: None });
        assert!(m.rows.iter().all(|r| !r.label.contains("SECRET")), "never task text, title or reply");

        // an agent the app can't answer (Codex, OpenCode, Grok): the row only opens
        assert_eq!(build(&queue, false, 300_000).rows[0].decide_since, None);
        assert_eq!(build(&queue[..1], true, 300_000).header, "1 waiting on you");
    }

    #[test]
    fn model_caps_at_ten() {
        let queue: Vec<QueueItem> = (0..13).map(|i| item(&format!("s{i:02}"), QueueReason::Review, 0, |_| {})).collect();
        let m = build(&queue, true, 0);
        assert_eq!((m.count, m.rows.len(), m.more), (13, 10, 3));
        assert_eq!(m.header, "13 waiting on you");
    }

    #[test]
    fn action_ids_round_trip() {
        let sid = "3f2b8c1e-7a4d-4e0b-9c1d-2a6f5e8b7c90".to_string();
        for a in [
            TrayAction::Allow { id: sid.clone(), since: 1_763_500_000_123 },
            TrayAction::Deny { id: sid.clone(), since: 42 },
            TrayAction::Open { id: sid.clone() },
            TrayAction::OpenVillage,
            TrayAction::ToggleMini,
            TrayAction::Quit,
        ] {
            assert_eq!(parse_action(&action_id(&a)), Some(a));
        }
        assert_eq!(parse_action("q:allow:abc:notanumber"), None);
        assert_eq!(parse_action("q:allow:abc"), None);
        assert_eq!(parse_action("q:open:"), None);
        assert_eq!(parse_action("nope"), None);
        assert_eq!(parse_action("quit"), None, "the app menu's ids are not the tray's");
    }

    #[test]
    fn tray_cache_reports_only_changes() {
        let cache = TrayCache::default();
        let queue = vec![item("d1", QueueReason::Decide, 0, |s| s.asking = Some("Bash: ls".into()))];
        let m = build(&queue, true, 0);
        assert!(cache.changed(&m), "the first is a change");
        assert!(!cache.changed(&m.clone()), "the same menu is not rebuilt");
        let later = build(&queue, true, 120_000); // only its wait label moved
        assert!(cache.changed(&later));
        assert!(!cache.changed(&later));
    }
}
