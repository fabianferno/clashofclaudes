//! Window titles (OSC 0 and OSC 2: `ESC ] 0 ; text BEL`) an agent sets on its terminal. Some
//! agents name the conversation there, the short name a terminal tab shows, which reads better
//! than the start of a long task:
//!   * Claude Code 2.1: `✳ Claude Code` at launch, then `<glyph> <title>` once it has named the
//!     conversation (the glyph spins while it works).
//!   * Grok Build: `<spinner> - <status> - <title> - grok` while it works, the title appearing
//!     once named; `grok` alone otherwise.
//!
//! Codex and Antigravity set none, so their sessions keep showing the task.

/// Longest sequence kept while waiting for its terminator; longer ones are dropped.
const MAX_SEQ: usize = 2048;
/// Titles are cut to this many characters (a tab's worth, not a paragraph).
const MAX_CHARS: usize = 80;

/// Stream scanner; keeps at most one partial sequence between `feed` calls.
#[derive(Default)]
pub struct TitleScanner {
    carry: Vec<u8>,
}

impl TitleScanner {
    /// The last title set in `data` (sequences split across reads are reassembled).
    pub fn feed(&mut self, data: &[u8]) -> Option<String> {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(data);
        let mut last = None;
        let mut i = 0;
        loop {
            let Some(at) = buf[i..].windows(2).position(|w| w == b"\x1b]").map(|p| p + i) else {
                if buf.last() == Some(&0x1b) {
                    self.carry = vec![0x1b];
                }
                return last;
            };
            let head = &buf[at + 2..];
            match head {
                [b'0' | b'2', b';', ..] => {
                    let body_at = at + 4;
                    match crate::osc::terminator(&buf[body_at..]) {
                        Some((len, skip)) => {
                            last = Some(String::from_utf8_lossy(&buf[body_at..body_at + len]).into_owned());
                            i = body_at + len + skip;
                        }
                        None => {
                            if buf.len() - at <= MAX_SEQ {
                                self.carry = buf[at..].to_vec();
                            }
                            return last;
                        }
                    }
                }
                // Too short to tell yet: wait for the rest.
                [] | [b'0' | b'2'] => {
                    self.carry = buf[at..].to_vec();
                    return last;
                }
                _ => i = at + 2,
            }
        }
    }
}

/// Leading glyphs (`✳ `, `◑ `, a braille spinner) off a title.
fn after_glyphs(s: &str) -> &str {
    s.trim_start_matches(|c: char| !c.is_alphanumeric()).trim()
}

fn cut(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    Some(match s.char_indices().nth(MAX_CHARS) {
        Some((at, _)) => format!("{}…", s[..at].trim_end()),
        None => s.to_string(),
    })
}

/// Claude Code's conversation name, from its window title; None for its launch title.
pub fn claude(raw: &str) -> Option<String> {
    let t = after_glyphs(raw);
    if t.eq_ignore_ascii_case("Claude Code") {
        return None;
    }
    cut(t)
}

/// Grok Build's conversation name, from its window title; None while it has none.
pub fn grok(raw: &str) -> Option<String> {
    let mut parts: Vec<&str> = raw.split(" - ").map(str::trim).collect();
    if parts.last().is_some_and(|p| p.eq_ignore_ascii_case("grok")) {
        parts.pop();
    }
    // While working the first part is a spinner and the second the status ("Thinking"); the
    // title, once named, comes last.
    if parts.first().is_some_and(|p| !p.chars().any(char::is_alphanumeric)) {
        parts.remove(0);
        if parts.len() < 2 {
            return None;
        }
    }
    parts.last().and_then(|p| cut(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_last_title_amid_output_with_either_terminator() {
        let mut s = TitleScanner::default();
        assert_eq!(s.feed(b"a\x1b]0;\xe2\x9c\xb3 Claude Code\x07b\x1b]2;Fix the login\x1b\\c"), Some("Fix the login".into()));
        assert_eq!(s.feed(b"plain output \x1b[31mred\x1b[0m"), None);
        assert_eq!(s.feed(b"\x1b]7501;state=working\x07\x1b]8;;http://x\x07"), None, "other OSCs are not titles");
    }

    #[test]
    fn a_title_split_across_reads_is_reassembled() {
        let all = b"x\x1b]0;\xe2\x97\x91 Kanban board titles\x07y";
        for cut in 1..all.len() {
            let mut s = TitleScanner::default();
            let first = s.feed(&all[..cut]);
            let second = s.feed(&all[cut..]);
            assert_eq!(first.or(second).as_deref(), Some("◑ Kanban board titles"), "cut at {cut}");
        }
    }

    #[test]
    fn claude_titles_lose_the_glyph_and_the_launch_title_is_none() {
        // observed from Claude Code 2.1.319
        assert_eq!(claude("✳ Claude Code"), None);
        assert_eq!(claude("◑ Kanban board session card titles").as_deref(), Some("Kanban board session card titles"));
        assert_eq!(claude("✳ Local voice agent startup").as_deref(), Some("Local voice agent startup"));
        assert_eq!(claude("  "), None);
        let long = claude(&format!("✳ {}", "word ".repeat(40))).unwrap();
        assert!(long.ends_with('…') && long.chars().count() <= MAX_CHARS + 1);
    }

    #[test]
    fn grok_titles_come_after_the_status() {
        // observed from Grok Build
        assert_eq!(grok("grok"), None);
        assert_eq!(grok("⠹ - Waiting for response… - grok"), None);
        assert_eq!(grok("⠙ - Running 4 stop hooks… - grok"), None);
        assert_eq!(grok("⠴ - Responding - Rename Kanban Session Cards Short Titles - grok").as_deref(), Some("Rename Kanban Session Cards Short Titles"));
        assert_eq!(grok("⠹ - Running 4 stop hooks… - Rename Kanban Session Cards Short Titles - grok").as_deref(), Some("Rename Kanban Session Cards Short Titles"));
        assert_eq!(grok("Rename Kanban Session Cards Short Titles - grok").as_deref(), Some("Rename Kanban Session Cards Short Titles"));
    }
}
