//! Local web apps running in a workspace: listening TCP ports whose process works inside the
//! workspace's folder (or one of its sessions' worktrees) and that answer HTTP. Each one gets a
//! board in the village with a live preview; a click opens it in the browser.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppPreview {
    pub workspace_id: String,
    pub port: u16,
    pub url: String,
    /// The page's `<title>`, if it has one.
    pub title: Option<String>,
    /// False when the page forbids framing (X-Frame-Options / frame-ancestors), so no live preview.
    pub frameable: bool,
    /// The listening process's command name (`node`, `python3`, ...).
    pub command: String,
}

/// One listening socket from `lsof`.
#[derive(Clone, Debug, PartialEq)]
pub struct Listener {
    pub pid: u32,
    pub command: String,
    /// Address to connect to for the probe.
    pub host: String,
    pub port: u16,
}

/// Parses `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`: `p<pid>`, `c<command>`, then one `n<addr>:<port>` per socket.
pub fn parse_listeners(out: &str) -> Vec<Listener> {
    let (mut pid, mut command) = (0u32, String::new());
    let mut v = Vec::new();
    for line in out.lines() {
        let (tag, rest) = match line.char_indices().nth(1) {
            Some((i, _)) => (&line[..i], &line[i..]),
            None => continue,
        };
        match tag {
            "p" => pid = rest.parse().unwrap_or(0),
            "c" => command = rest.to_string(),
            "n" => {
                let Some((addr, port)) = rest.rsplit_once(':') else { continue };
                let Ok(port) = port.parse::<u16>() else { continue };
                let host = match addr {
                    "*" | "0.0.0.0" => "127.0.0.1".to_string(),
                    "[::]" => "::1".to_string(),
                    a => a.trim_start_matches('[').trim_end_matches(']').to_string(),
                };
                // only loopback and wildcard listeners are "local apps"
                if host != "127.0.0.1" && host != "::1" && host != "localhost" {
                    continue;
                }
                if pid != 0 {
                    v.push(Listener { pid, command: command.clone(), host, port });
                }
            }
            _ => {}
        }
    }
    v
}

/// Parses `lsof -a -d cwd -Fn -p <pids>`: `p<pid>`, `fcwd`, `n<path>`.
pub fn parse_cwds(out: &str) -> HashMap<u32, PathBuf> {
    let mut pid = 0u32;
    let mut m = HashMap::new();
    for line in out.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().unwrap_or(0);
        } else if let Some(n) = line.strip_prefix('n')
            && pid != 0
        {
            m.insert(pid, PathBuf::from(n));
        }
    }
    m
}

/// The workspace whose root holds `cwd`; the deepest root wins (a worktree inside the workspace folder).
pub fn owner_of<'a>(cwd: &Path, roots: &'a [(String, PathBuf)]) -> Option<&'a str> {
    roots
        .iter()
        .filter(|(_, r)| cwd.starts_with(r))
        .max_by_key(|(_, r)| r.components().count())
        .map(|(id, _)| id.as_str())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Probe {
    pub title: Option<String>,
    pub frameable: bool,
}

/// Reads an HTTP response (head and the start of the body); None unless it is a page: a
/// successful (or redirecting) HTML response. APIs, tools' local servers and error pages are not apps.
pub fn parse_probe(resp: &[u8]) -> Option<Probe> {
    let text = String::from_utf8_lossy(resp);
    if !text.starts_with("HTTP/") {
        return None;
    }
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status: u16 = head.split_whitespace().nth(1)?.parse().ok()?;
    if status >= 400 {
        return None;
    }
    let content_type = head.lines().skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case("content-type").then(|| v.trim().to_ascii_lowercase())
    });
    let html = match content_type {
        Some(ct) => ct.contains("text/html"),
        None => body.trim_start().get(..5).is_some_and(|s| s.eq_ignore_ascii_case("<!doc") || s.eq_ignore_ascii_case("<html")),
    };
    // a redirect has no page of its own; follow-up requests will show where it leads
    if !html && !(300..400).contains(&status) {
        return None;
    }
    let mut frameable = true;
    for line in head.lines().skip(1) {
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_ascii_lowercase());
        if k == "x-frame-options" && (v.contains("deny") || v.contains("sameorigin")) {
            frameable = false;
        }
        if k == "content-security-policy"
            && let Some(fa) = v.split(';').map(str::trim).find(|d| d.starts_with("frame-ancestors"))
            && !fa.split_whitespace().skip(1).any(|s| s == "*" || s.contains("localhost") || s.contains("127.0.0.1"))
        {
            frameable = false;
        }
    }
    Some(Probe { title: title_of(body), frameable })
}

fn title_of(body: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = start + lower[start..].find('>')? + 1;
    let close = open_end + lower[open_end..].find("</title")?;
    let t = body[open_end..close]
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    (!t.is_empty()).then(|| t.chars().take(60).collect())
}

fn probe(host: &str, port: u16) -> Option<Probe> {
    let ip: std::net::IpAddr = host.parse().ok()?;
    let timeout = Duration::from_millis(1500);
    let mut s = TcpStream::connect_timeout(&SocketAddr::new(ip, port), timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    let req = format!(
        "GET / HTTP/1.0\r\nHost: localhost:{port}\r\nUser-Agent: ClashOfClaudes\r\nAccept: text/html,*/*\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let deadline = Instant::now() + timeout;
    while buf.len() < 64 * 1024 && Instant::now() < deadline {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        if String::from_utf8_lossy(&buf).to_ascii_lowercase().contains("</title") {
            break;
        }
    }
    parse_probe(&buf)
}

fn run(cmd: &mut Command) -> String {
    cmd.output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

/// Absolute: the app's PATH is the login shell's, which need not hold /usr/sbin.
const LSOF: &str = "/usr/sbin/lsof";

/// How long a port that did not answer HTTP is left alone before it is probed again.
const RETRY: Duration = Duration::from_secs(20);

/// Probe results by (pid, port), with when each was taken.
type Probed = HashMap<(u32, u16), (Option<Probe>, Instant)>;

/// Scans the machine for apps; remembers probe results per (pid, port) so a scan only probes new sockets.
#[derive(Default)]
pub struct Scanner {
    seen: Mutex<Probed>,
}

impl Scanner {
    /// Apps owned by `roots` (workspace id, folder), skipping `skip_ports` (the app's own dev server).
    pub fn scan(&self, roots: &[(String, PathBuf)], skip_ports: &[u16]) -> Vec<AppPreview> {
        if roots.is_empty() {
            return Vec::new();
        }
        let own = std::process::id();
        let listeners: Vec<Listener> = parse_listeners(&run(Command::new(LSOF).args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])))
            .into_iter()
            .filter(|l| l.pid != own && !skip_ports.contains(&l.port))
            .collect();
        if listeners.is_empty() {
            self.seen.lock().unwrap_or_else(|e| e.into_inner()).clear();
            return Vec::new();
        }
        let mut pids: Vec<String> = listeners.iter().map(|l| l.pid.to_string()).collect();
        pids.sort();
        pids.dedup();
        let cwds = parse_cwds(&run(Command::new(LSOF).args(["-a", "-d", "cwd", "-Fn", "-p", &pids.join(",")])));
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        seen.retain(|k, _| listeners.iter().any(|l| (l.pid, l.port) == *k));
        let mut out: Vec<AppPreview> = Vec::new();
        for l in &listeners {
            let Some(ws) = cwds.get(&l.pid).and_then(|c| owner_of(c, roots)) else { continue };
            if out.iter().any(|a| a.workspace_id == ws && a.port == l.port) {
                continue; // the same port on IPv4 and IPv6
            }
            let key = (l.pid, l.port);
            let fresh = match seen.get(&key) {
                Some((Some(_), _)) => false,
                Some((None, at)) => at.elapsed() >= RETRY,
                None => true,
            };
            if fresh {
                seen.insert(key, (probe(&l.host, l.port), Instant::now()));
            }
            if let Some((Some(p), _)) = seen.get(&key) {
                out.push(AppPreview {
                    workspace_id: ws.to_string(),
                    port: l.port,
                    url: format!("http://localhost:{}/", l.port),
                    title: p.title.clone(),
                    frameable: p.frameable,
                    command: l.command.clone(),
                });
            }
        }
        out.sort_by(|a, b| (&a.workspace_id, a.port).cmp(&(&b.workspace_id, b.port)));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listeners_keep_local_sockets_with_their_process() {
        let out = "p100\ncnode\nn*:3000\nn[::1]:3000\np200\ncpostgres\nn127.0.0.1:5432\np300\ncsshd\nn10.0.0.5:22\n";
        let v = parse_listeners(out);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0], Listener { pid: 100, command: "node".into(), host: "127.0.0.1".into(), port: 3000 });
        assert_eq!(v[1].host, "::1");
        assert_eq!((v[2].pid, v[2].port), (200, 5432));
    }

    #[test]
    fn cwds_map_pid_to_folder() {
        let m = parse_cwds("p100\nfcwd\nn/Users/me/my app\np200\nfcwd\nn/\n");
        assert_eq!(m[&100], PathBuf::from("/Users/me/my app"));
        assert_eq!(m[&200], PathBuf::from("/"));
    }

    #[test]
    fn the_deepest_root_owns_a_folder() {
        let roots = vec![("a".to_string(), PathBuf::from("/p/a")), ("wt".to_string(), PathBuf::from("/p/a/.wt/x"))];
        assert_eq!(owner_of(Path::new("/p/a/web"), &roots), Some("a"));
        assert_eq!(owner_of(Path::new("/p/a/.wt/x/web"), &roots), Some("wt"));
        assert_eq!(owner_of(Path::new("/p/ab"), &roots), None);
    }

    #[test]
    fn probe_reads_title_and_framing() {
        let ok = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html><head><TITLE>\n  My &amp; App </TITLE>";
        assert_eq!(parse_probe(ok), Some(Probe { title: Some("My & App".into()), frameable: true }));
        let xfo = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Frame-Options: DENY\r\n\r\n";
        assert_eq!(parse_probe(xfo), Some(Probe { title: None, frameable: false }));
        let csp = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: default-src 'self'; frame-ancestors 'none'\r\n\r\n";
        assert!(!parse_probe(csp).unwrap().frameable);
        let csp_ok = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: frame-ancestors *\r\n\r\n";
        assert!(parse_probe(csp_ok).unwrap().frameable);
        assert_eq!(parse_probe(b"\x00\x01binary"), None);
    }

    #[test]
    fn only_pages_are_apps() {
        let page = |r: &[u8]| parse_probe(r).is_some();
        assert!(page(b"HTTP/1.0 200 OK\r\nServer: SimpleHTTP\r\n\r\n<!DOCTYPE HTML>\n<html>"));
        assert!(page(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /login\r\n\r\n"));
        assert!(!page(b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{\"error\":1}"));
        assert!(!page(b"HTTP/1.1 404 Not Found\r\ncontent-type: text/html\r\n\r\n<html>nope"));
        assert!(!page(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}"));
    }
}
