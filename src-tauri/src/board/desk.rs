//! The lender's desk: takes a teammate's request to borrow a builder, starts the work, answers
//! under the request, pushes the branch when the work finishes, and tidies up when it is closed.
//! No Tauri here; `Yard` is what it needs from the app.
//!
//! Everything a request may do is decided by `borrow::take` against the Keychain's record. The
//! desk only carries that verdict out, once.
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::borrow::{branch_name, parse_request, result_text, take, Facts, Request, Take};
use super::cli::MsgWrite;
use super::listen::Event;
use super::remote_app::{Clock, Outbox, Remote};

/// An ask-first request waits this long for the lender.
pub const ASK_MS: i64 = 30 * 60_000;

/// A builder, as a request names it.
pub struct YardBuilder {
    pub id: String,
    pub name: String,
    /// It has a live session.
    pub busy: bool,
    /// The least elixir its agent has left (percent); None: no reading.
    pub elixir: Option<u32>,
}

pub struct YardWorkspace {
    pub id: String,
    pub name: String,
    /// Shared, and a git repository with a commit and an `origin`.
    pub lendable: bool,
}

/// A borrowed session that started.
pub struct Started {
    pub session: String,
    pub worktree: PathBuf,
    /// The workspace's own folder (where git is run for the push).
    pub repo: PathBuf,
}

/// What the desk needs from the lender's Mac. `start`, `push` and `remove_if_safe` run git and
/// may take seconds: the desk is called off the sessions' path.
pub trait Yard: Send + Sync {
    /// The builder whose board profile is `profile`.
    fn builder(&self, profile: &str) -> Option<YardBuilder>;
    /// The workspace whose channel slug is `slug`.
    fn workspace(&self, slug: &str) -> Option<YardWorkspace>;
    /// Fetches `origin`, cuts a worktree on `branch` from its default branch, and starts the
    /// builder's session there with `task`.
    fn start(&self, builder_id: &str, workspace_id: &str, task: &str, branch: &str) -> Result<Started, String>;
    /// Pushes the session's recorded branch, and only it.
    fn push(&self, b: &Borrowed, first: bool) -> Result<(), String>;
    /// Removes the worktree when that loses nothing; whether it did.
    fn remove_if_safe(&self, b: &Borrowed) -> bool;
    fn notify(&self, title: &str, body: &str);
}

/// A session working for a teammate.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Borrowed {
    pub session: String,
    /// The borrower's key id: the only teammate key that may act on it.
    pub key: String,
    /// The borrower's Vercel username.
    pub handle: String,
    /// The branch made for it: the only thing ever pushed for it.
    pub branch: String,
    /// The request's message id.
    pub request: String,
    pub pushed: bool,
    /// Why the last push failed.
    #[serde(default)]
    pub push_error: Option<String>,
    pub worktree: PathBuf,
    pub repo: PathBuf,
}

/// A request waiting for the lender (ask me first).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestView {
    pub id: String,
    /// The borrower's Vercel username.
    pub who: String,
    pub builder: String,
    pub workspace: String,
    pub task: String,
    pub until: i64,
}

struct Waiting {
    view: RequestView,
    request: Request,
    builder_id: String,
    workspace_id: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    borrowed: BTreeMap<String, Borrowed>,
}

#[derive(Default)]
struct Inner {
    borrowed: BTreeMap<String, Borrowed>,
    waiting: Vec<Waiting>,
    /// Request messages already looked at (a restarted tail delivers them again).
    heard: HashSet<String>,
    /// The result message under each request, once posted: it is edited as things move.
    results: BTreeMap<String, String>,
}

pub struct Desk {
    remote: Arc<Remote>,
    board: Arc<dyn Outbox>,
    yard: Arc<dyn Yard>,
    path: PathBuf,
    now: Clock,
    changed: Arc<dyn Fn() + Send + Sync>,
    inner: Arc<Mutex<Inner>>,
    /// Held while a request is judged and started, and while a branch is pushed.
    starting: Mutex<()>,
    pushing: Mutex<()>,
}

fn first_line(task: &str) -> String {
    task.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default().chars().take(120).collect()
}

impl Desk {
    pub fn new(remote: Arc<Remote>, board: Arc<dyn Outbox>, yard: Arc<dyn Yard>, path: PathBuf, now: Clock, changed: Arc<dyn Fn() + Send + Sync>) -> Desk {
        let saved: Saved = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Desk { remote, board, yard, path, now, changed, inner: Arc::new(Mutex::new(Inner { borrowed: saved.borrowed, ..Default::default() })), starting: Mutex::new(()), pushing: Mutex::new(()) }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self, g: &Inner) {
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec(&Saved { borrowed: g.borrowed.clone() })
            && std::fs::write(&tmp, bytes).is_ok()
        {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    /// The key id of the teammate session `id` works for.
    pub fn by(&self, session: &str) -> Option<String> {
        self.lock().borrowed.get(session).map(|b| b.key.clone())
    }

    pub fn borrowed(&self) -> Vec<Borrowed> {
        self.lock().borrowed.values().cloned().collect()
    }

    /// The requests waiting for Accept or Decline.
    pub fn requests(&self) -> Vec<RequestView> {
        self.lock().waiting.iter().map(|w| w.view.clone()).collect()
    }

    /// Writes the result under a request: a reply the first time, an edit of it afterwards.
    fn result(&self, request: &str, result: &str, why: Option<&str>) {
        let text = result_text(request, result, why);
        let known = self.lock().results.get(request).cloned();
        match known {
            Some(id) => self.board.send(MsgWrite::Edit { id, text }, None),
            None => {
                let (inner, key) = (self.inner.clone(), request.to_string());
                self.board.send(
                    MsgWrite::ReplyTo { id: request.to_string(), text, labels: vec![("coc.kind".to_string(), "borrow-result".to_string())], key: format!("coc-borrow-res-{request}") },
                    Some(Box::new(move |id| {
                        if let Some(id) = id {
                            inner.lock().unwrap_or_else(|e| e.into_inner()).results.insert(key, id);
                        }
                    })),
                );
            }
        }
    }

    /// A message from the village's log: a teammate's borrow request starts here.
    pub fn on_event(&self, e: &Event) {
        if e.kind != "message.posted" || e.labels.get("coc.kind").map(String::as_str) != Some("borrow") || e.thread_root.as_deref() != Some(e.id.as_str()) {
            return;
        }
        let Some(r) = parse_request(&e.text) else { return };
        let Some(v) = self.remote.village() else { return };
        {
            let mut g = self.lock();
            if g.heard.len() > 2_000 {
                g.heard.clear();
            }
            if !g.heard.insert(e.id.clone()) {
                return;
            }
        }
        let (phones, lends, seen) = (self.remote.paired(), self.remote.lends(), self.remote.seen_nonces());
        // who asked, before anything on this Mac is looked at (finding a workspace runs git)
        if let Err(why) = super::borrow::signed_by(&r, &v.host, &phones) {
            self.result(&e.id, "refused", Some(why));
            return;
        }
        // one request judged and started at a time: two for one builder must not both pass "not busy"
        let _one = self.starting.lock().unwrap_or_else(|p| p.into_inner());
        let (builder, workspace) = (self.yard.builder(&r.builder), self.yard.workspace(&r.workspace));
        let verdict = take(
            &r,
            &Facts {
                host: &v.host,
                channel: &e.channel,
                owner: &v.owner,
                now: (self.now)(),
                phones: &phones,
                lends: &lends,
                seen: &seen,
                builder: builder.as_ref().map(|b| (b.id.as_str(), b.busy, b.elixir)),
                workspace: workspace.as_ref().map(|w| (w.id.as_str(), w.lendable)),
            },
        );
        let who = phones.iter().find(|p| p.key == r.key).and_then(|p| p.who.as_ref()).map(|w| w.handle.clone()).unwrap_or_else(|| "someone".to_string());
        match (verdict, builder, workspace) {
            (Take::Refused(why), _, _) => self.result(&e.id, "refused", Some(why)),
            (Take::Busy, _, _) => self.result(&e.id, "busy", None),
            (Take::Low, _, _) => self.result(&e.id, "low", None),
            (Take::Start | Take::Ask, Some(b), Some(w)) => {
                // good once: from here the same request is "already taken"
                if !self.remote.take_nonce(&r.nonce).unwrap_or(false) {
                    return self.result(&e.id, "refused", Some("already taken"));
                }
                if verdict == Take::Start {
                    self.begin(&e.id, &r, &who, &b, &w, true);
                } else {
                    let view = RequestView { id: e.id.clone(), who: who.clone(), builder: b.name.clone(), workspace: w.name.clone(), task: r.task.clone(), until: (self.now)() + ASK_MS };
                    self.lock().waiting.push(Waiting { view, request: r.clone(), builder_id: b.id.clone(), workspace_id: w.id.clone() });
                    self.result(&e.id, "waiting", None);
                    self.yard.notify(&format!("{who} asks to borrow {} in {}", b.name, w.name), &first_line(&r.task));
                }
            }
            _ => self.result(&e.id, "refused", Some("no such builder or workspace")),
        }
        (self.changed)();
    }

    /// Starts the work and says so. `tell`: notify the lender (not after they accepted it themselves).
    fn begin(&self, request: &str, r: &Request, who: &str, b: &YardBuilder, w: &YardWorkspace, tell: bool) {
        let branch = branch_name(who, &r.task, &r.nonce);
        match self.yard.start(&b.id, &w.id, &r.task, &branch) {
            Ok(s) => {
                {
                    let mut g = self.lock();
                    g.borrowed.insert(s.session.clone(), Borrowed { session: s.session, key: r.key.clone(), handle: who.to_string(), branch, request: request.to_string(), pushed: false, push_error: None, worktree: s.worktree, repo: s.repo });
                    self.save(&g);
                }
                self.result(request, "started", None);
                if tell {
                    self.yard.notify(&format!("{who} borrowed {} in {}", b.name, w.name), &first_line(&r.task));
                }
            }
            Err(e) => self.result(request, "failed", Some(&e)),
        }
    }

    fn take_waiting(&self, id: &str) -> Result<Waiting, String> {
        let mut g = self.lock();
        let at = g.waiting.iter().position(|w| w.view.id == id).ok_or("That request was already answered.")?;
        Ok(g.waiting.remove(at))
    }

    /// The lender accepted an ask-first request. The builder may have become busy, or elixir low, meanwhile.
    pub fn accept(&self, id: &str) -> Result<(), String> {
        let w = self.take_waiting(id)?;
        let _one = self.starting.lock().unwrap_or_else(|p| p.into_inner());
        let (builder, workspace) = (self.yard.builder(&w.request.builder), self.yard.workspace(&w.request.workspace));
        let floor = self.remote.lends().iter().find(|l| l.builder == w.builder_id).map(|l| l.floor).unwrap_or(0);
        match (builder, workspace) {
            (Some(b), Some(ws)) if b.id == w.builder_id && ws.id == w.workspace_id => {
                if b.busy {
                    self.result(id, "busy", None);
                } else if floor > 0 && b.elixir.is_some_and(|left| left <= floor) {
                    self.result(id, "low", None);
                } else {
                    self.begin(id, &w.request, &w.view.who, &b, &ws, false);
                }
            }
            _ => self.result(id, "failed", Some("that builder or workspace is gone")),
        }
        (self.changed)();
        Ok(())
    }

    pub fn decline(&self, id: &str) -> Result<(), String> {
        self.take_waiting(id)?;
        self.result(id, "declined", None);
        (self.changed)();
        Ok(())
    }

    /// Once a second or so: ask-first requests the lender did not answer in time expire.
    pub fn tick(&self) {
        let now = (self.now)();
        let expired: Vec<String> = {
            let mut g = self.lock();
            let (gone, kept): (Vec<Waiting>, Vec<Waiting>) = std::mem::take(&mut g.waiting).into_iter().partition(|w| now >= w.view.until);
            g.waiting = kept;
            gone.into_iter().map(|w| w.view.id).collect()
        };
        for id in &expired {
            self.result(id, "expired", None);
        }
        if !expired.is_empty() {
            (self.changed)();
        }
    }

    /// A session reached Finished. A borrowed one has its branch pushed, and its thread
    /// (`root`) told. Runs git over the network: call it off the sessions' path.
    pub fn on_finished(&self, session: &str, root: Option<&str>) {
        // one push at a time: two close Finished waits must not race each other to "already on origin"
        let _one = self.pushing.lock().unwrap_or_else(|p| p.into_inner());
        let Some(b) = self.lock().borrowed.get(session).cloned() else { return };
        let outcome = self.yard.push(&b, !b.pushed);
        let said = {
            let mut g = self.lock();
            let Some(kept) = g.borrowed.get_mut(session) else { return };
            let said = match &outcome {
                Ok(()) => {
                    kept.pushed = true;
                    kept.push_error = None;
                    format!("Pushed to origin as `{}`.", b.branch)
                }
                Err(e) => {
                    kept.push_error = Some(e.clone());
                    format!("Not pushed: {e}")
                }
            };
            self.save(&g);
            said
        };
        if let Some(root) = root {
            self.board.send(MsgWrite::ReplyTo { id: root.to_string(), text: said, labels: vec![("coc.kind".to_string(), "push".to_string())], key: format!("coc-push-{session}-{}", (self.now)()) }, None);
        }
        (self.changed)();
    }

    /// Tries a push that failed again (the lender opened the session).
    pub fn retry_push(&self, session: &str, root: Option<&str>) {
        if self.lock().borrowed.get(session).is_some_and(|b| !b.pushed) {
            self.on_finished(session, root);
        }
    }

    /// A session was closed. For a borrowed one: its worktree is removed when that loses
    /// nothing; otherwise it stays and its path is returned, for the lender to be told.
    pub fn on_closed(&self, session: &str) -> Option<String> {
        let b = {
            let mut g = self.lock();
            let b = g.borrowed.remove(session)?;
            self.save(&g);
            b
        };
        (self.changed)();
        (!self.yard.remove_if_safe(&b)).then(|| b.worktree.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
#[path = "desk_tests.rs"]
mod tests;
