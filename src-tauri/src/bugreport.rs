//! Bug reports and feature requests: what the owner wrote, plus the details shown to them before sending, posted to the
//! project's Discord webhook. Sent only when the owner presses Send; the webhook is set at build
//! time (see `build.rs`) and never reaches the frontend.
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tauri::AppHandle;

const WEBHOOK: Option<&str> = option_env!("COC_BUG_WEBHOOK");
/// Seconds between two reports, so a stuck key or a double click doesn't post twice.
pub const MIN_GAP_S: i64 = 30;
const TEXT_MAX: usize = 3800;
/// Discord's limit on an embed's title, description and fields together.
const EMBED_MAX: usize = 6000;
const SCREENSHOT_MAX: usize = 8 * 1024 * 1024;
static LAST_SENT: AtomicI64 = AtomicI64::new(i64::MIN);

/// Something broken, or something wanted.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ReportKind {
    #[default]
    Bug,
    Feature,
}

impl ReportKind {
    fn title(self) -> &'static str {
        match self {
            ReportKind::Bug => "Bug report",
            ReportKind::Feature => "Feature request",
        }
    }
    fn color(self) -> u32 {
        match self {
            ReportKind::Bug => 0xff4b3e,
            ReportKind::Feature => 0x4ab0f0,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugReport {
    #[serde(default)]
    pub kind: ReportKind,
    pub text: String,
    /// How to reach the owner, if they gave it.
    #[serde(default)]
    pub contact: Option<String>,
    /// Name/value pairs from the frontend (agents, village counts), shown to the owner first.
    #[serde(default)]
    pub details: Vec<(String, String)>,
    /// A JPEG of the window, base64, when the owner chose to attach it.
    #[serde(default)]
    pub screenshot: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BugReportInfo {
    /// False in builds made without a webhook.
    pub enabled: bool,
    /// What the backend adds to every report.
    pub system: Vec<(String, String)>,
}

/// The webhook, if this build has a Discord one.
fn webhook() -> Option<&'static str> {
    WEBHOOK.map(str::trim).filter(|u| u.starts_with("https://discord.com/api/webhooks/") || u.starts_with("https://discordapp.com/api/webhooks/"))
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// The app version, macOS version, chip and build kind.
pub fn system(app: &AppHandle) -> Vec<(String, String)> {
    let macos = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".into());
    vec![
        ("App".into(), app.package_info().version.to_string()),
        ("macOS".into(), macos),
        ("Chip".into(), std::env::consts::ARCH.into()),
        ("Build".into(), if cfg!(debug_assertions) { "dev" } else { "release" }.into()),
    ]
}

/// The Discord message: an embed with the text and one field per detail, within Discord's limits
/// (fields that don't fit are dropped). Mentions are off, so a report can't ping the server.
pub fn payload(r: &BugReport, system: &[(String, String)], with_image: bool) -> serde_json::Value {
    let description = clip(r.text.trim(), TEXT_MAX);
    let title = r.kind.title();
    let mut left = EMBED_MAX - title.len() - description.chars().count();
    let contact = r.contact.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(|c| ("Contact".to_string(), clip(c, 200)));
    let mut fields: Vec<serde_json::Value> = Vec::new();
    for (name, value) in contact.iter().chain(system.iter()).chain(r.details.iter()).take(24) {
        let name = clip(name, 200);
        let value = if value.trim().is_empty() { "—".to_string() } else { value.clone() };
        let room = left.saturating_sub(name.chars().count()).min(900);
        if room < 16 {
            break;
        }
        let value = clip(&value, room);
        left -= name.chars().count() + value.chars().count();
        fields.push(serde_json::json!({ "name": name, "value": value, "inline": name != "Contact" }));
    }
    let mut embed = serde_json::json!({
        "title": title,
        "description": description,
        "color": r.kind.color(),
        "fields": fields,
    });
    if with_image {
        embed["image"] = serde_json::json!({ "url": "attachment://screenshot.jpg" });
    }
    serde_json::json!({
        "username": "Clash of Claudes beta",
        "embeds": [embed],
        "allowed_mentions": { "parse": [] },
    })
}

/// Seconds to wait before another report may go, or None when one may go now.
pub fn wait_left(last: i64, now: i64) -> Option<i64> {
    let left = last.saturating_add(MIN_GAP_S).saturating_sub(now);
    (left > 0).then_some(left)
}

fn now_s() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[tauri::command]
pub fn bug_report_info(app: AppHandle) -> BugReportInfo {
    BugReportInfo { enabled: webhook().is_some(), system: system(&app) }
}

#[tauri::command]
pub async fn send_bug_report(report: BugReport, app: AppHandle) -> Result<(), String> {
    let url = webhook().ok_or("This build can't send bug reports.")?;
    if report.text.trim().is_empty() {
        return Err("Say what went wrong first.".into());
    }
    if let Some(left) = wait_left(LAST_SENT.load(Ordering::SeqCst), now_s()) {
        return Err(format!("A report just went. Try again in {left} s."));
    }
    let image = match report.screenshot.as_deref() {
        Some(b64) => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "The screenshot could not be read.")?;
            if bytes.len() > SCREENSHOT_MAX {
                return Err("The screenshot is too large to send.".into());
            }
            Some(bytes)
        }
        None => None,
    };
    let body = payload(&report, &system(&app), image.is_some()).to_string();
    let mut form = http_client::multipart::Form::new().text("payload_json", body);
    if let Some(bytes) = image {
        let part = http_client::multipart::Part::bytes(bytes).file_name("screenshot.jpg").mime_str("image/jpeg").map_err(|e| e.to_string())?;
        form = form.part("files[0]", part);
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    // errors drop the url: it is the webhook's secret
    let fail = |e: http_client::Error| format!("Could not send the report: {}", e.without_url());
    let client = http_client::Client::builder().timeout(Duration::from_secs(30)).build().map_err(fail)?;
    let res = client.post(url).multipart(form).send().await.map_err(fail)?;
    if !res.status().is_success() {
        return Err(format!("Could not send the report (Discord said {}).", res.status()));
    }
    LAST_SENT.store(now_s(), Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> BugReport {
        BugReport { kind: ReportKind::Bug, text: "  The house vanished @everyone  ".into(), contact: Some("ada#1".into()), details: vec![("Agents".into(), "Claude Code 2.1".into())], screenshot: None }
    }

    #[test]
    fn the_message_carries_the_text_and_every_detail_and_never_pings() {
        let sys = vec![("App".to_string(), "0.1.0".to_string()), ("macOS".to_string(), "".to_string())];
        let v = payload(&report(), &sys, false);
        let e = &v["embeds"][0];
        assert_eq!(e["title"], "Bug report");
        assert_eq!(e["description"], "The house vanished @everyone");
        let names: Vec<_> = e["fields"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["Contact", "App", "macOS", "Agents"]);
        assert_eq!(e["fields"][2]["value"], "—", "Discord refuses empty field values");
        assert_eq!(v["allowed_mentions"]["parse"].as_array().unwrap().len(), 0);
        assert!(e.get("image").is_none());
        assert_eq!(payload(&report(), &sys, true)["embeds"][0]["image"]["url"], "attachment://screenshot.jpg");
    }

    #[test]
    fn long_text_and_values_are_clipped_to_discord_limits() {
        let mut r = report();
        r.text = "x".repeat(10_000);
        r.contact = Some("   ".into());
        r.details = (0..40).map(|i| (format!("d{i}"), "y".repeat(5000))).collect();
        let v = payload(&r, &[], false);
        let e = &v["embeds"][0];
        assert_eq!(e["description"].as_str().unwrap().chars().count(), TEXT_MAX);
        let fields = e["fields"].as_array().unwrap();
        assert!(!fields.is_empty() && fields.len() <= 24, "Discord allows 25 fields");
        assert!(fields.iter().all(|f| f["name"] != "Contact"), "no Contact when blank");
        let chars = |v: &serde_json::Value| v.as_str().unwrap().chars().count();
        let total = chars(&e["title"]) + chars(&e["description"]) + fields.iter().map(|f| chars(&f["name"]) + chars(&f["value"])).sum::<usize>();
        assert!(total <= EMBED_MAX, "{total}");
        assert!(fields.iter().all(|f| chars(&f["value"]) <= 900));
    }

    #[test]
    fn feature_requests_are_titled_and_coloured_apart_and_old_reports_are_bugs() {
        let r = BugReport { kind: ReportKind::Feature, ..report() };
        let e = &payload(&r, &[], false)["embeds"][0];
        assert_eq!(e["title"], "Feature request");
        assert_ne!(e["color"], payload(&report(), &[], false)["embeds"][0]["color"]);
        let old: BugReport = serde_json::from_str(r#"{"text":"x"}"#).unwrap();
        assert_eq!(old.kind, ReportKind::Bug);
        let new: BugReport = serde_json::from_str(r#"{"kind":"feature","text":"x"}"#).unwrap();
        assert_eq!(new.kind, ReportKind::Feature);
    }

    #[test]
    fn reports_are_spaced_out() {
        assert_eq!(wait_left(i64::MIN, 1_000), None, "the first one goes at once");
        assert_eq!(wait_left(1_000, 1_010), Some(MIN_GAP_S - 10));
        assert_eq!(wait_left(1_000, 1_000 + MIN_GAP_S), None);
    }
}
