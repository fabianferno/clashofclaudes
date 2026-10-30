// Session status state machine. Pure: no I/O, no clocks. Consumed by later tasks.
#![allow(dead_code)]

use crate::model::SessionState;

#[derive(Clone, Debug, PartialEq)]
pub enum StatusEvent {
    Output,
    Silence { secs: u64 },
    TurnFinished,
    PermissionRequested { message: String },
    WaitingForInput,
    ToolUsed,
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
}

const SILENCE_STUCK_PREFIX: &str = "no output for ";

/// Pure transition table (spec section 5.3). Anything not listed leaves `state` unchanged.
pub fn next_state(state: &SessionState, ev: &StatusEvent, policy: &StatusPolicy) -> SessionState {
    use SessionState as S;
    use StatusEvent as E;

    if matches!(state, S::Ended { .. }) {
        return state.clone();
    }
    match (state, ev) {
        (_, E::Exited { code: Some(0) }) => S::Ended { exit_code: Some(0) },
        (_, E::Exited { code: Some(c) }) => S::Stuck { reason: format!("exited with code {c}") },
        (_, E::Exited { code: None }) => S::Stuck { reason: "process ended".into() },

        (_, E::PromptSubmitted) => S::Working,
        (S::Starting | S::NeedsYou { .. } | S::Finished, E::ToolUsed) => S::Working,
        (_, E::TurnFinished) => S::Finished,
        (_, E::PermissionRequested { message }) => S::NeedsYou { reason: message.clone() },

        (S::Starting, E::Output) => S::Working,
        (S::Working, E::WaitingForInput) => S::Finished,
        (S::Working | S::Finished, E::UserInput) if !policy.uses_hooks => S::Working,

        (S::Working, E::Silence { secs })
            if policy.finished_after_silence_secs.is_some_and(|t| *secs >= t) =>
        {
            S::Finished
        }
        (S::Working, E::Silence { secs })
            if policy.stuck_after_silence_secs.is_some_and(|t| *secs >= t) =>
        {
            S::Stuck { reason: format!("{SILENCE_STUCK_PREFIX}{} min", secs / 60) }
        }
        // Only a stall from silence recovers on output; exit-stuck stays put.
        (S::Stuck { reason }, E::Output) if reason.starts_with(SILENCE_STUCK_PREFIX) => S::Working,

        // Unlisted pairs, including later-added events, are unchanged.
        _ => state.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SessionState::*;
    use StatusEvent::*;

    fn hooks() -> StatusPolicy { StatusPolicy { uses_hooks: true, finished_after_silence_secs: None, stuck_after_silence_secs: Some(900) } }
    fn plain() -> StatusPolicy { StatusPolicy { uses_hooks: false, finished_after_silence_secs: Some(20), stuck_after_silence_secs: Some(900) } }
    #[test] fn starting_output_is_working() { assert_eq!(next_state(&Starting, &Output, &hooks()), Working); }
    #[test] fn permission_needs_you() { assert_eq!(next_state(&Working, &PermissionRequested{message:"Bash".into()}, &hooks()), NeedsYou{reason:"Bash".into()}); }
    #[test] fn tool_after_permission_resumes() { assert_eq!(next_state(&NeedsYou{reason:"x".into()}, &ToolUsed, &hooks()), Working); }
    #[test] fn turn_finished() { assert_eq!(next_state(&Working, &TurnFinished, &hooks()), Finished); }
    #[test] fn hook_agents_ignore_short_silence() { assert_eq!(next_state(&Working, &Silence{secs:60}, &hooks()), Working); }
    #[test] fn plain_agents_finish_on_silence() { assert_eq!(next_state(&Working, &Silence{secs:20}, &plain()), Finished); }
    #[test] fn long_silence_is_stuck() { assert_eq!(next_state(&Working, &Silence{secs:900}, &hooks()), Stuck{reason:"no output for 15 min".into()}); }
    #[test] fn nonzero_exit_is_stuck() { assert_eq!(next_state(&Working, &Exited{code:Some(1)}, &hooks()), Stuck{reason:"exited with code 1".into()}); }
    #[test] fn clean_exit_ends() { assert_eq!(next_state(&Finished, &Exited{code:Some(0)}, &hooks()), Ended{exit_code:Some(0)}); }
    #[test] fn ended_is_terminal() { assert_eq!(next_state(&Ended{exit_code:Some(0)}, &PromptSubmitted, &hooks()), Ended{exit_code:Some(0)}); }
    #[test] fn plain_user_input_resumes_from_finished() { assert_eq!(next_state(&Finished, &UserInput, &plain()), Working); }
}
