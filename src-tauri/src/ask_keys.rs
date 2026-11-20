//! The keystrokes that answer an agent's open picker from outside the window (the phone remote):
//! the one-question, single-select part of `src/panels/askKeys.ts`. Change both, and both tests.
use crate::model::AgentKind;

const DOWN: &str = "\x1b[B";
const ENTER: &str = "\r";

/// Typed words go into the picker's one-line text row: Enter there submits, so no newlines.
fn one_line(t: &str) -> String {
    t.split(['\r', '\n']).map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
}

/// One write each (keys sent in one write may be read as a single input). `options`: how many
/// the picker lists. Typed words win over a pick, as in the window.
pub fn pick_keys(agent: AgentKind, options: usize, pick: Option<usize>, text: &str) -> Vec<String> {
    let text = one_line(text);
    if text.is_empty() {
        return pick.map(|p| vec![(p + 1).to_string()]).unwrap_or_default();
    }
    match agent {
        // Codex: Down to "None of the above", Tab to add a note, the words, Enter.
        AgentKind::Codex => {
            let mut keys: Vec<String> = (0..options).map(|_| DOWN.to_string()).collect();
            keys.extend(["\t".to_string(), text, ENTER.to_string()]);
            keys
        }
        // Claude Code: the "Type something" digit, the words, Enter.
        _ => vec![(options + 1).to_string(), text, ENTER.to_string()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_pick_is_its_digit() {
        assert_eq!(pick_keys(AgentKind::Claude, 3, Some(1), ""), ["2"]);
        assert_eq!(pick_keys(AgentKind::Claude, 3, Some(1), "  \n "), ["2"], "blank words are no words");
    }

    #[test]
    fn claude_typed_is_the_type_something_row() {
        assert_eq!(pick_keys(AgentKind::Claude, 3, None, "use sqlite"), ["4", "use sqlite", "\r"]);
        assert_eq!(pick_keys(AgentKind::Claude, 2, Some(0), "kiwi\n  42 \r\n"), ["3", "kiwi 42", "\r"]);
    }

    // the cases of `askKeys.test.ts` ("answerKeys for Codex"), one question at a time
    #[test]
    fn codex_pick_and_typed() {
        assert_eq!(pick_keys(AgentKind::Codex, 3, Some(2), ""), ["3"]);
        assert_eq!(pick_keys(AgentKind::Codex, 3, None, "kiwi 42"), ["\x1b[B", "\x1b[B", "\x1b[B", "\t", "kiwi 42", "\r"]);
    }

    #[test]
    fn nothing_to_press_without_a_pick_or_words() {
        assert!(pick_keys(AgentKind::Claude, 3, None, "").is_empty());
    }
}
