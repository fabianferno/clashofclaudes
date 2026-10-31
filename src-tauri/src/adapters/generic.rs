//! Custom command adapter: runs a user-supplied command through the login shell.
use super::{AgentAdapter, Detection, LaunchRequest};
use crate::model::AgentKind;
use crate::platform::default_shell;
use crate::pty::LaunchSpec;
use crate::status::StatusPolicy;

pub struct CustomAdapter;

impl AgentAdapter for CustomAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Custom
    }
    fn label(&self) -> &'static str {
        "Custom command"
    }
    fn detect(&self) -> Detection {
        Detection { installed: true, path: None, version: None }
    }
    fn models(&self) -> Vec<String> {
        vec![]
    }
    fn efforts(&self) -> Vec<String> {
        vec![]
    }
    fn launch(&self, req: &LaunchRequest) -> anyhow::Result<LaunchSpec> {
        let cmd = req
            .custom_command
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .ok_or_else(|| anyhow::anyhow!("custom agent requires a command"))?;
        // The task travels as $1 (argv), never spliced into the shell string.
        let mut command = cmd.to_string();
        if req.task.is_some() && !command.contains("$1") && !command.contains("$@") {
            // Parameter reference only; the task itself stays an argv element.
            command.push_str(" \"$@\"");
        }
        let mut args = vec!["-lc".to_string(), command];
        if let Some(task) = req.task {
            args.push("coc".into());
            args.push(task.to_string());
        }
        Ok(LaunchSpec { program: default_shell(), args, env: vec![], cwd: req.cwd.to_path_buf() })
    }
    fn policy(&self) -> StatusPolicy {
        StatusPolicy {
            uses_hooks: false,
            finished_after_silence_secs: Some(20),
            stuck_after_silence_secs: Some(900),
            any_exit_ends: false,
            silence_needs_you_until_first_event: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn req_with<'a>(cmd: Option<&'a str>, task: Option<&'a str>) -> LaunchRequest<'a> {
        LaunchRequest {
            session_id: "s1",
            cwd: Path::new("/tmp"),
            model: None,
            effort: None,
            task,
            hook_url: "http://127.0.0.1:1/x",
            data_dir: Path::new("/tmp"),
            custom_command: cmd,
        }
    }

    #[test]
    fn custom_launch_passes_task_as_positional() {
        let spec = CustomAdapter
            .launch(&req_with(Some("aider --yes"), Some("fix \"it\" $(rm -rf /)")))
            .unwrap();
        assert_eq!(spec.args, vec!["-lc", "aider --yes \"$@\"", "coc", "fix \"it\" $(rm -rf /)"]);
    }

    #[test]
    fn custom_appends_task_param_when_unreferenced() {
        let spec = CustomAdapter
            .launch(&req_with(Some("aider --yes"), Some("fix \"it\" $(rm -rf /)")))
            .unwrap();
        assert_eq!(spec.args, vec!["-lc", "aider --yes \"$@\"", "coc", "fix \"it\" $(rm -rf /)"]);
    }

    #[test]
    fn custom_keeps_command_that_references_task() {
        let spec = CustomAdapter
            .launch(&req_with(Some("mytool --prompt \"$1\""), Some("hi")))
            .unwrap();
        assert_eq!(spec.args, vec!["-lc", "mytool --prompt \"$1\"", "coc", "hi"]);
    }

    #[test]
    fn custom_without_command_errors() {
        assert!(CustomAdapter.launch(&req_with(None, None)).is_err());
    }

    #[test]
    fn custom_without_task_omits_positional() {
        let spec = CustomAdapter.launch(&req_with(Some("aider"), None)).unwrap();
        assert_eq!(spec.args, vec!["-lc", "aider"]);
    }
}
