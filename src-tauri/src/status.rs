// Session status state machine. Pure: no I/O, no clocks.

use crate::model::SessionState;

#[derive(Clone, Debug, PartialEq)]
pub enum StatusEvent {
    Output,
    Silence { secs: u64 },
    TurnFinished,
    PermissionRequested { message: String },
    WaitingForInput,
    ToolUsed,
    /// The agent reported an error. Stuck (not NeedsYou): there is no prompt to answer.
    Failed { reason: String },
    PromptSubmitted,
    UserInput,
    Exited { code: Option<i32> },
    CwdChanged { cwd: std::path::PathBuf },
}

#[derive(Clone, Debug, PartialEq)]
pub struct StatusPolicy {
    pub uses_hooks: bool,
    pub finished_after_silence_secs: Option<u64>,
    pub stuck_after_silence_secs: Option<u64>,
    /// Any exit is a normal end (plain terminals: `exit` after a failed command is not a crash).
    pub any_exit_ends: bool,
    /// `finished_after_silence_secs` applies only until the first hook event arrives
    /// (an agent whose single hook, e.g. Codex `notify`, may be missing or broken).
    pub silence_finishes_until_first_event: bool,
}

impl StatusPolicy {
    /// This policy once a hook event has arrived for the session.
    pub fn after_first_event(&self) -> Self {
        let mut p = self.clone();
        if p.silence_finishes_until_first_event {
            p.finished_after_silence_secs = None;
        }
        p
    }
}

const SILENCE_STUCK_PREFIX: &str = "no output for ";
const EXIT_STUCK_PREFIX: &str = "exited with code ";
const EXIT_STUCK_NONE: &str = "process ended";

/// Stuck from a stall or an agent-reported failure recovers on activity; exit-stuck does not.
fn stuck_recovers(reason: &str) -> bool {
    !(reason.starts_with(EXIT_STUCK_PREFIX) || reason == EXIT_STUCK_NONE)
}

/// Pure transition table (spec section 5.3). Anything not listed leaves `state` unchanged.
pub fn next_state(state: &SessionState, ev: &StatusEvent, policy: &StatusPolicy) -> SessionState {
    use SessionState as S;
    use StatusEvent as E;

    if matches!(state, S::Ended { .. }) {
        return state.clone();
    }
    match (state, ev) {
        (_, E::Exited { code }) if policy.any_exit_ends => S::Ended { exit_code: *code },
        (_, E::Exited { code: Some(0) }) => S::Ended { exit_code: Some(0) },
        (_, E::Exited { code: Some(c) }) => S::Stuck { reason: format!("{EXIT_STUCK_PREFIX}{c}") },
        (_, E::Exited { code: None }) => S::Stuck { reason: EXIT_STUCK_NONE.into() },

        (_, E::Failed { reason }) => S::Stuck { reason: reason.clone() },
        (_, E::PromptSubmitted) => S::Working,
        (S::Starting | S::NeedsYou { .. } | S::Finished, E::ToolUsed) => S::Working,
        (_, E::TurnFinished) => S::Finished,
        (_, E::PermissionRequested { message }) => S::NeedsYou { reason: message.clone() },

        (S::Starting, E::Output) => S::Working,
        (S::Working, E::WaitingForInput) => S::Finished,
        (S::Working | S::Finished | S::NeedsYou { .. }, E::UserInput) if !policy.uses_hooks => S::Working,

        // Silence counts from the start too: a custom agent may print nothing at all.
        (S::Starting | S::Working, E::Silence { secs })
            if policy.finished_after_silence_secs.is_some_and(|t| *secs >= t) =>
        {
            S::Finished
        }
        (S::Working, E::Silence { secs })
            if policy.stuck_after_silence_secs.is_some_and(|t| *secs >= t) =>
        {
            S::Stuck { reason: format!("{SILENCE_STUCK_PREFIX}{} min", secs / 60) }
        }
        // A stall or a reported failure recovers on new output or typing; exit-stuck stays put.
        (S::Stuck { reason }, E::Output | E::UserInput) if stuck_recovers(reason) => S::Working,

        // Unlisted pairs, including later-added events, are unchanged.
        _ => state.clone(),
    }
}

/// Terminal text with ANSI CSI/OSC sequences removed and everything but letters/digits dropped
/// (whitespace and punctuation), so matching survives cursor-move sequences that stand in for
/// spaces.
pub fn screen_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    for n in chars.by_ref() {
                        if n == '\x07' || n == '\\' {
                            break;
                        }
                    }
                }
                _ => {}
            },
            c if c.is_alphanumeric() => out.push(c),
            _ => {}
        }
    }
    out
}

/// True when `data` consists only of terminal-generated reports (cursor position, device
/// attributes, focus in/out, OSC replies) as xterm sends automatically, not typed input.
/// Empty input counts (nothing typed).
pub fn is_terminal_report_only(data: &[u8]) -> bool {
    let mut i = 0;
    while i < data.len() {
        if data[i] != 0x1b {
            return false;
        }
        match data.get(i + 1) {
            Some(b'[') => {
                let start = i + 2;
                let mut j = start;
                while j < data.len() && (0x20..=0x3f).contains(&data[j]) {
                    j += 1;
                }
                let Some(&fin) = data.get(j) else { return false };
                let ok = match fin {
                    b'R' | b'c' | b'n' | b't' | b'u' | b'y' => true,
                    b'I' | b'O' => j == start, // focus events carry no parameters
                    _ => false,
                };
                if !ok {
                    return false;
                }
                i = j + 1;
            }
            Some(b']') => {
                let mut j = i + 2;
                loop {
                    match data.get(j) {
                        None => return false,
                        Some(0x07) => break,
                        Some(0x1b) if data.get(j + 1) == Some(&b'\\') => {
                            j += 1;
                            break;
                        }
                        _ => j += 1,
                    }
                }
                i = j + 1;
            }
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SessionState::*;
    use StatusEvent::*;

    fn hooks() -> StatusPolicy { StatusPolicy { uses_hooks: true, finished_after_silence_secs: None, stuck_after_silence_secs: Some(900), any_exit_ends: false, silence_finishes_until_first_event: false } }
    fn plain() -> StatusPolicy { StatusPolicy { uses_hooks: false, finished_after_silence_secs: Some(20), stuck_after_silence_secs: Some(900), any_exit_ends: false, silence_finishes_until_first_event: false } }
    fn term() -> StatusPolicy { crate::adapters::terminal_policy() }
    #[test] fn starting_output_is_working() { assert_eq!(next_state(&Starting, &Output, &hooks()), Working); }
    #[test] fn permission_needs_you() { assert_eq!(next_state(&Working, &PermissionRequested{message:"Bash".into()}, &hooks()), NeedsYou{reason:"Bash".into()}); }
    #[test] fn tool_after_permission_resumes() { assert_eq!(next_state(&NeedsYou{reason:"x".into()}, &ToolUsed, &hooks()), Working); }
    #[test] fn turn_finished() { assert_eq!(next_state(&Working, &TurnFinished, &hooks()), Finished); }
    #[test] fn hook_agents_ignore_short_silence() { assert_eq!(next_state(&Working, &Silence{secs:60}, &hooks()), Working); }
    #[test] fn plain_agents_finish_on_silence() { assert_eq!(next_state(&Working, &Silence{secs:20}, &plain()), Finished); }
    #[test] fn plain_agents_finish_on_silence_without_output() {
        assert_eq!(next_state(&Starting, &Silence{secs:19}, &plain()), Starting);
        assert_eq!(next_state(&Starting, &Silence{secs:20}, &plain()), Finished);
    }
    #[test] fn hook_agents_and_terminals_stay_starting_in_silence() {
        assert_eq!(next_state(&Starting, &Silence{secs:900}, &hooks()), Starting);
        assert_eq!(next_state(&Starting, &Silence{secs:900}, &term()), Starting);
    }
    #[test] fn long_silence_is_stuck() { assert_eq!(next_state(&Working, &Silence{secs:900}, &hooks()), Stuck{reason:"no output for 15 min".into()}); }
    #[test] fn failed_event_goes_stuck() {
        for from in [Starting, Working, Finished, NeedsYou{reason:"x".into()}] {
            assert_eq!(next_state(&from, &Failed{reason:"boom".into()}, &hooks()), Stuck{reason:"boom".into()});
        }
        assert_eq!(next_state(&Ended{exit_code:None}, &Failed{reason:"boom".into()}, &hooks()), Ended{exit_code:None});
    }
    #[test] fn stuck_from_failure_recovers_on_output() {
        let s = Stuck{reason:"boom".into()};
        for p in [hooks(), plain()] {
            assert_eq!(next_state(&s, &Output, &p), Working);
            assert_eq!(next_state(&s, &UserInput, &p), Working);
        }
        // Exit-stuck still stays put.
        let e = Stuck{reason:"exited with code 1".into()};
        assert_eq!(next_state(&e, &Output, &hooks()), e);
        assert_eq!(next_state(&e, &UserInput, &plain()), e);
        // Silence-stuck recovers on output as before.
        let q = Stuck{reason:"no output for 15 min".into()};
        assert_eq!(next_state(&q, &Output, &hooks()), Working);
    }
    #[test] fn nonzero_exit_is_stuck() { assert_eq!(next_state(&Working, &Exited{code:Some(1)}, &hooks()), Stuck{reason:"exited with code 1".into()}); }
    #[test] fn clean_exit_ends() { assert_eq!(next_state(&Finished, &Exited{code:Some(0)}, &hooks()), Ended{exit_code:Some(0)}); }
    #[test] fn ended_is_terminal() { assert_eq!(next_state(&Ended{exit_code:Some(0)}, &PromptSubmitted, &hooks()), Ended{exit_code:Some(0)}); }
    #[test] fn terminal_any_exit_ends() {
        assert_eq!(next_state(&Working, &Exited{code:Some(3)}, &term()), Ended{exit_code:Some(3)});
        assert_eq!(next_state(&Starting, &Exited{code:None}, &term()), Ended{exit_code:None});
    }
    #[test] fn plain_user_input_resumes_from_finished() { assert_eq!(next_state(&Finished, &UserInput, &plain()), Working); }
    #[test] fn screen_text_strips_ansi_and_whitespace() {
        assert_eq!(screen_text(b"\x1b[1m Yes,\x1b[0m I  trust\x1b[1C this\r\nfolder\x1b]0;title\x07!"), "YesItrustthisfolder");
    }
    #[test] fn terminal_reports_are_not_typing() {
        for r in [&b"\x1b[12;40R"[..], b"\x1b[?1;2c", b"\x1b[I", b"\x1b[O", b"\x1b]11;rgb:0000/0000/0000\x07", b"\x1b]11;rgb:0/0/0\x1b\\", b"\x1b[?0u", b"\x1b[I\x1b[12;40R", b""] {
            assert!(is_terminal_report_only(r), "{r:?}");
        }
        for t in [&b"\x1b[B"[..], b"\r", b"1", b"\x1b", b"\x1b[12;40R1", b"1\x1b[12;40R", b"\x1b[A", b"\x1b]11;x"] {
            assert!(!is_terminal_report_only(t), "{t:?}");
        }
    }
}
