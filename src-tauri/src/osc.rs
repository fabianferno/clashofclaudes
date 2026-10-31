//! OSC 7501 program-status reports (`ESC ] 7501 ; state=…:app=…[:kind=…][:msg=…] ST`): agents
//! that support it (Antigravity CLI with `AGY_CLI_OSC7501=on`) write their state into the
//! terminal stream, so no hook files are needed. Parsing is lenient: `:` or `;` separate the
//! fields, BEL or ST ends the sequence, unknown keys are ignored, and `msg` is base64 when it
//! decodes to UTF-8 (raw text otherwise). Sequences may arrive split across reads.
use crate::status::StatusEvent;

#[derive(Clone, Debug, PartialEq)]
pub struct StatusReport {
    pub state: String,
    pub kind: Option<String>,
    pub msg: Option<String>,
}

const START: &[u8] = b"\x1b]7501;";
/// Longest sequence kept while waiting for its terminator; longer ones are dropped.
const MAX_SEQ: usize = 8 * 1024;

/// Stream scanner; keeps at most one partial sequence between `feed` calls, and whether a turn
/// is under way (for `events`).
#[derive(Default)]
pub struct Osc7501 {
    carry: Vec<u8>,
    in_turn: bool,
}

impl Osc7501 {
    pub fn feed(&mut self, data: &[u8]) -> Vec<StatusReport> {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(data);
        let mut out = Vec::new();
        let mut i = 0;
        loop {
            let Some(at) = find(&buf[i..], START).map(|p| p + i) else {
                // Keep a trailing partial `START` (e.g. a lone ESC) for the next read.
                let keep = (1..START.len()).rev().find(|&n| buf.len() >= n && buf.ends_with(&START[..n])).unwrap_or(0);
                self.carry = buf[buf.len() - keep..].to_vec();
                return out;
            };
            let body_at = at + START.len();
            match terminator(&buf[body_at..]) {
                Some((len, skip)) => {
                    let body = String::from_utf8_lossy(&buf[body_at..body_at + len]).into_owned();
                    #[cfg(debug_assertions)]
                    eprintln!("osc7501: {body}");
                    if let Some(r) = parse_body(&body) {
                        out.push(r);
                    }
                    i = body_at + len + skip;
                }
                None => {
                    if buf.len() - at <= MAX_SEQ {
                        self.carry = buf[at..].to_vec();
                    }
                    return out;
                }
            }
        }
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Length of the body and of its terminator (BEL, or ESC `\`).
fn terminator(b: &[u8]) -> Option<(usize, usize)> {
    b.iter().enumerate().find_map(|(i, &c)| match c {
        0x07 => Some((i, 1)),
        0x1b if b.get(i + 1) == Some(&b'\\') => Some((i, 2)),
        _ => None,
    })
}

/// A report from a sequence body; `None` for a support query (`?`) or a body without `state`.
pub fn parse_body(body: &str) -> Option<StatusReport> {
    let (mut state, mut kind, mut msg) = (None, None, None);
    for field in body.split([':', ';']) {
        let Some((k, v)) = field.split_once('=') else { continue };
        match k.trim() {
            "state" => state = Some(v.trim().to_ascii_lowercase()),
            "kind" => kind = Some(v.trim().to_ascii_lowercase()),
            "msg" | "message" => msg = Some(decode_msg(v.trim())),
            _ => {}
        }
    }
    state.filter(|s| !s.is_empty()).map(|state| StatusReport { state, kind, msg: msg.filter(|m| !m.is_empty()) })
}

/// Base64 (standard or URL-safe, padding optional) when it decodes to UTF-8; else the raw text.
fn decode_msg(v: &str) -> String {
    base64(v).and_then(|b| String::from_utf8(b).ok()).unwrap_or_else(|| v.to_string())
}

fn base64(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    };
    let s = s.trim_end_matches('=');
    if s.is_empty() || s.len() % 4 == 1 {
        return None;
    }
    let (mut out, mut acc, mut bits) = (Vec::with_capacity(s.len() * 3 / 4), 0u32, 0);
    for c in s.bytes() {
        acc = (acc << 6) | val(c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

impl Osc7501 {
    /// The status events a report stands for. Observed from agy 1.4.12: `blocked` (kind
    /// `permission` for tool and trust menus; kind `auth` at every launch while the keychain
    /// login loads, so it is ignored: a sign-in that really waits falls to the silence rule),
    /// `working` after each submit or approval, `done` with the turn's summary, and `idle`
    /// whenever it is back at its prompt: at launch (no news) and after an interrupt mid-turn
    /// (Esc, or Deny).
    pub fn events(&mut self, r: &StatusReport) -> Vec<StatusEvent> {
        let msg = |why: &str| r.msg.clone().unwrap_or_else(|| why.into());
        match r.state.as_str() {
            // Each `working` follows a submit or an approved tool call: it counts as a step.
            "working" => {
                self.in_turn = true;
                vec![StatusEvent::ToolUsed, StatusEvent::PromptSubmitted]
            }
            "blocked" => match r.kind.as_deref() {
                Some("question") => vec![StatusEvent::AskedInTerminal { message: msg("Has a question for you") }],
                Some("auth") => vec![],
                _ => {
                    self.in_turn = true; // a prompt is answered or cancelled before the prompt returns
                    vec![StatusEvent::PermissionRequested { message: msg("Wants permission") }]
                }
            },
            "done" => {
                self.in_turn = false;
                vec![StatusEvent::TurnFinished]
            }
            "idle" if std::mem::take(&mut self.in_turn) => vec![StatusEvent::Idle],
            "error" => {
                self.in_turn = false;
                vec![StatusEvent::Failed { reason: msg("reported an error") }]
            }
            // Idle outside a turn, `clear` and unknown states move nothing.
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rep(state: &str, kind: Option<&str>, msg: Option<&str>) -> StatusReport {
        StatusReport { state: state.into(), kind: kind.map(Into::into), msg: msg.map(Into::into) }
    }

    #[test]
    fn parses_reports_with_either_terminator_amid_output() {
        let mut p = Osc7501::default();
        let got = p.feed(b"hello\x1b]7501;state=working:app=agy\x1b\\more\x1b]7501;state=done;app=agy\x07tail");
        assert_eq!(got, vec![rep("working", None, None), rep("done", None, None)]);
    }

    #[test]
    fn a_sequence_split_across_reads_is_reassembled() {
        let mut p = Osc7501::default();
        let all = b"x\x1b]7501;state=blocked:app=agy:kind=permission:msg=QWxsb3cgYmFzaD8=\x1b\\y";
        for cut in 1..all.len() {
            let mut q = Osc7501::default();
            let mut got = q.feed(&all[..cut]);
            got.extend(q.feed(&all[cut..]));
            assert_eq!(got, vec![rep("blocked", Some("permission"), Some("Allow bash?"))], "cut at {cut}");
        }
        assert!(p.feed(b"\x1b]7501;?\x1b\\").is_empty(), "a support query is no report");
    }

    #[test]
    fn lenient_fields_and_raw_messages() {
        assert_eq!(parse_body("app=agy:state=ERROR:msg=quota exceeded!"), Some(rep("error", None, Some("quota exceeded!"))));
        assert_eq!(parse_body("app=agy"), None);
        assert_eq!(parse_body("state=working:future=1"), Some(rep("working", None, None)));
    }

    #[test]
    fn an_unterminated_runaway_sequence_is_dropped() {
        let mut p = Osc7501::default();
        let mut big = b"\x1b]7501;state=working:msg=".to_vec();
        big.extend(std::iter::repeat_n(b'A', MAX_SEQ + 10));
        assert!(p.feed(&big).is_empty());
        assert_eq!(p.feed(b"\x1b]7501;state=done\x07"), vec![rep("done", None, None)]);
    }

    #[test]
    fn reports_map_to_status_events() {
        let mut p = Osc7501::default();
        assert!(p.events(&rep("blocked", Some("auth"), Some("Sign in required"))).is_empty(), "sent at every launch");
        assert!(p.events(&rep("idle", None, None)).is_empty(), "idle at launch is no news");
        assert_eq!(p.events(&rep("working", None, None)), vec![StatusEvent::ToolUsed, StatusEvent::PromptSubmitted]);
        assert_eq!(
            p.events(&rep("blocked", Some("permission"), Some("Approve RunCommand: pwd"))),
            vec![StatusEvent::PermissionRequested { message: "Approve RunCommand: pwd".into() }]
        );
        assert_eq!(p.events(&rep("idle", None, None)), vec![StatusEvent::Idle], "interrupted mid-turn");
        assert!(p.events(&rep("idle", None, None)).is_empty(), "once");
        p.events(&rep("working", None, None));
        assert_eq!(p.events(&rep("done", None, Some("Created hello.txt."))), vec![StatusEvent::TurnFinished]);
        assert!(p.events(&rep("idle", None, None)).is_empty(), "after a finished turn");
        assert_eq!(
            p.events(&rep("blocked", Some("question"), None)),
            vec![StatusEvent::AskedInTerminal { message: "Has a question for you".into() }]
        );
        assert_eq!(p.events(&rep("error", None, None)), vec![StatusEvent::Failed { reason: "reported an error".into() }]);
        assert!(p.events(&rep("clear", None, None)).is_empty());
    }

    #[test]
    fn real_agy_bodies_parse() {
        // Captured from agy 1.4.12 (a trust menu, then a tool permission).
        assert_eq!(
            parse_body("state=blocked:kind=permission:app=antigravity:msg=VHJ1c3QgdGhpcyBmb2xkZXI/"),
            Some(rep("blocked", Some("permission"), Some("Trust this folder?")))
        );
        assert_eq!(
            parse_body("state=blocked:kind=permission:app=antigravity:msg=QXBwcm92ZSBSdW5Db21tYW5kOiBwd2Q="),
            Some(rep("blocked", Some("permission"), Some("Approve RunCommand: pwd")))
        );
        assert_eq!(parse_body("state=idle:app=antigravity"), Some(rep("idle", None, None)));
    }
}
