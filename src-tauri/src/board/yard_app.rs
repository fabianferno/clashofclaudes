//! The lender's Mac, as the desk needs it: the app's builders, workspaces, quota readings, git
//! and notifications behind `desk::Yard`; and the commands of Settings › Lent builders and the
//! Requests list.
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use super::app::BoardState;
use super::borrow::Lend;
use super::desk::{Borrowed, RequestView, Started, Yard, YardBuilder, YardWorkspace};
use super::{profile_name, workspace_slugs};
use crate::commands::{AppState, QuotaState};
use crate::model::{SessionKind, SessionState, WorktreeInfo};

pub struct AppYard(pub AppHandle);

impl AppYard {
    fn state(&self) -> Option<tauri::State<'_, AppState>> {
        self.0.try_state::<AppState>()
    }
}

impl Yard for AppYard {
    fn builder(&self, profile: &str) -> Option<YardBuilder> {
        let st = self.state()?;
        let b = st.data().builders.iter().find(|b| profile_name(&b.name) == profile).cloned()?;
        let busy = st.manager.list().iter().any(|s| matches!(&s.kind, SessionKind::Agent { builder_id } if builder_id == &b.id) && !matches!(s.state, SessionState::Ended { .. }));
        let now = crate::quota::now_ms();
        let elixir = self.0.try_state::<QuotaState>().and_then(|q| q.store.all().into_iter().find(|q| q.agent == b.agent)).and_then(|q| crate::quota::least_left(&q, now));
        Some(YardBuilder { id: b.id, name: b.name, busy, elixir })
    }

    fn workspace(&self, slug: &str) -> Option<YardWorkspace> {
        let st = self.state()?;
        let d = st.data();
        let slugs = workspace_slugs(&d.workspaces);
        let w = d.workspaces.iter().find(|w| slugs.get(&w.id).map(String::as_str) == Some(slug))?.clone();
        drop(d);
        let lendable = w.board_shared && !w.missing && crate::git::lendable(&w.path);
        Some(YardWorkspace { id: w.id, name: w.name, lendable })
    }

    fn start(&self, builder_id: &str, workspace_id: &str, task: &str, branch: &str) -> Result<Started, String> {
        let st = self.state().ok_or("the app is starting")?;
        let (mut ws, builder) = {
            let d = st.data();
            (d.workspaces.iter().find(|w| w.id == workspace_id).cloned().ok_or("that workspace is gone")?, d.builders.iter().find(|b| b.id == builder_id).cloned().ok_or("that builder is gone")?)
        };
        let repo = ws.path.clone();
        // Cut from what origin has now, never from this Mac's own state: its unpushed commits
        // are not the borrower's to receive.
        crate::git::fetch_origin(&repo).map_err(|e| format!("origin could not be fetched: {e}"))?;
        let base = crate::git::default_branch(&repo).ok_or("origin has no default branch to start from")?;
        let data_dir = st.data_path.parent().ok_or("no data folder")?.to_path_buf();
        let at = data_dir.join("worktrees").join(branch.replace('/', "-"));
        let (wt, cwd) = crate::git::add_worktree_from(&repo, &at, branch, &format!("origin/{base}")).map_err(|e| format!("the worktree could not be made: {e}"))?;
        ws.path = cwd;
        match st.manager.start_agent(&ws, &builder, Some(task), &[]) {
            Ok(s) => {
                st.manager.set_worktree(&s.id, wt);
                Ok(Started { session: s.id, worktree: at, repo })
            }
            Err(e) => {
                crate::git::remove_worktree(&repo, &wt);
                Err(format!("{e:#}"))
            }
        }
    }

    fn push(&self, b: &Borrowed, first: bool) -> Result<(), String> {
        crate::git::push_branch(&b.worktree, &b.branch, first).map_err(|e| format!("{e:#}"))
    }

    fn remove_if_safe(&self, b: &Borrowed) -> bool {
        crate::git::safe_to_remove(&b.worktree, &b.branch) && crate::git::remove_worktree_keep_branch(&b.repo, &WorktreeInfo { path: b.worktree.clone(), branch: Some(b.branch.clone()) }).is_ok()
    }

    fn notify(&self, title: &str, body: &str) {
        let _ = self.0.notification().builder().title(title).body(body).show();
    }
}

/// A builder in Settings › Lent builders.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LendView {
    pub builder: String,
    pub name: String,
    /// How it is lent; None: it is not.
    pub lend: Option<Lend>,
}

/// A workspace that could be chosen for a lent builder.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LendWorkspace {
    pub id: String,
    pub name: String,
    pub lendable: bool,
    /// Why not, in words.
    pub why: Option<String>,
}

/// A paired teammate, for choosing whom a builder is lent to.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LendMate {
    pub key: String,
    pub email: String,
    pub handle: String,
}

/// What Settings › Lent builders shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lending {
    pub builders: Vec<LendView>,
    pub workspaces: Vec<LendWorkspace>,
    pub mates: Vec<LendMate>,
    /// The app's elixir reserve: the default floor.
    pub reserve: u32,
}

fn lending_of(app: &AppHandle) -> Result<Lending, String> {
    let (bs, st) = (app.try_state::<BoardState>().ok_or("the board is not set up")?, app.try_state::<AppState>().ok_or("the app is starting")?);
    let lends = bs.remote.lends();
    let (builders, shared, reserve) = {
        let d = st.data();
        let builders = d.builders.iter().map(|b| LendView { builder: b.id.clone(), name: b.name.clone(), lend: lends.iter().find(|l| l.builder == b.id).cloned() }).collect();
        (builders, d.workspaces.iter().filter(|w| w.board_shared).cloned().collect::<Vec<_>>(), d.settings.elixir_reserve)
    };
    let workspaces = shared
        .into_iter()
        .map(|w| {
            let why = if w.missing || crate::git::toplevel(&w.path).is_none() {
                Some("not a git repository".to_string())
            } else if !crate::git::has_origin(&w.path) {
                Some("no origin to push to".to_string())
            } else if !crate::git::lendable(&w.path) {
                Some("no commit yet".to_string())
            } else {
                None
            };
            LendWorkspace { id: w.id, name: w.name, lendable: why.is_none(), why }
        })
        .collect();
    let mates = bs.remote.paired().into_iter().filter_map(|p| p.who.map(|w| LendMate { key: p.key, email: w.email, handle: w.handle })).collect();
    Ok(Lending { builders, workspaces, mates, reserve })
}

/// Settings › Lent builders: the builders, how each is lent, and what can be chosen.
#[tauri::command]
pub async fn lending(app: AppHandle) -> Result<Lending, String> {
    tauri::async_runtime::spawn_blocking(move || lending_of(&app)).await.map_err(|e| e.to_string())?
}

/// Lends a builder, changes how it is lent, or (null) stops lending it. Kept in the Keychain.
#[tauri::command]
pub async fn lend_set(builder: String, lend: Option<Lend>, app: AppHandle) -> Result<Lending, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.try_state::<BoardState>().ok_or("the board is not set up")?.remote.set_lend(&builder, lend)?;
        lending_of(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The borrow requests waiting for Accept or Decline.
#[tauri::command]
pub fn borrow_requests(app: AppHandle) -> Vec<RequestView> {
    app.try_state::<BoardState>().map(|bs| bs.desk.requests()).unwrap_or_default()
}

#[tauri::command]
pub async fn borrow_accept(id: String, app: AppHandle) -> Result<Vec<RequestView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bs = app.try_state::<BoardState>().ok_or("the board is not set up")?;
        bs.desk.accept(&id)?;
        Ok(bs.desk.requests())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn borrow_decline(id: String, app: AppHandle) -> Result<Vec<RequestView>, String> {
    let bs = app.try_state::<BoardState>().ok_or("the board is not set up")?;
    bs.desk.decline(&id)?;
    Ok(bs.desk.requests())
}

/// The sessions on this Mac that work for a teammate: who for, their branch, whether it is pushed.
#[tauri::command]
pub fn lent_sessions(app: AppHandle) -> Vec<Borrowed> {
    app.try_state::<BoardState>().map(|bs| bs.desk.borrowed()).unwrap_or_default()
}

/// Tries a borrowed session's push again (the lender opened it and its branch was not pushed).
#[tauri::command]
pub async fn lent_push(session: String, app: AppHandle) -> Result<Vec<Borrowed>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bs = app.try_state::<BoardState>().ok_or("the board is not set up")?;
        bs.desk.retry_push(&session, bs.publisher.root_of(&session).as_deref());
        Ok(bs.desk.borrowed())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where a worktree kept after a close is: said to the lender once.
pub fn kept_note(path: &str) -> String {
    format!("Its worktree was kept, with work that is not on origin: {}", PathBuf::from(path).display())
}
