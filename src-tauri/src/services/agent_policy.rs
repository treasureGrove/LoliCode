//! Conservative Auto Mode approvals. Parsed permission resources alone are unsafe:
//! they omit redirects, pipes and shell workdir. Only full tool input is inspected.
use lolicode_agent::AgentPermission;
use std::path::Path;

pub fn approve_automatically(request: &AgentPermission, project: &str) -> bool {
    if request.action != "shell" {
        return false;
    }
    let Some(input) = request.tool_input.as_ref() else {
        return false;
    };
    let Some(command) = input.get("command").and_then(serde_json::Value::as_str) else {
        return false;
    };
    if let Some(workdir) = input.get("workdir").and_then(serde_json::Value::as_str) {
        let path = if Path::new(workdir).is_absolute() {
            Path::new(workdir).to_path_buf()
        } else {
            Path::new(project).join(workdir)
        };
        let (Ok(path), Ok(root)) = (std::fs::canonicalize(path), std::fs::canonicalize(project))
        else {
            return false;
        };
        if !path.starts_with(root) {
            return false;
        }
    }
    safe_command(command)
}

fn safe_command(command: &str) -> bool {
    if command.is_empty()
        || command.len() > 4096
        || command.chars().any(|c| {
            matches!(
                c,
                '\n' | '\r'
                    | '\0'
                    | '\''
                    | '"'
                    | '`'
                    | '$'
                    | '>'
                    | '<'
                    | '|'
                    | '&'
                    | ';'
                    | '('
                    | ')'
                    | '{'
                    | '}'
            )
        })
    {
        return false;
    }
    let parts: Vec<_> = command.split_whitespace().collect();
    match parts.as_slice() {
        [program, "--version"] => matches!(
            *program,
            "node" | "python" | "python3" | "git" | "npm" | "pnpm" | "cargo" | "rustc"
        ),
        ["git", "status", args @ ..] => args.iter().all(|arg| {
            matches!(
                *arg,
                "--short"
                    | "-s"
                    | "--branch"
                    | "-b"
                    | "--porcelain"
                    | "--porcelain=v1"
                    | "--porcelain=v2"
                    | "--untracked-files=all"
                    | "--untracked-files=no"
            )
        }),
        ["git", "diff", args @ ..] => {
            args.contains(&"--no-ext-diff")
                && args.contains(&"--no-textconv")
                && args.iter().all(|arg| {
                    matches!(
                        *arg,
                        "--stat"
                            | "--numstat"
                            | "--name-only"
                            | "--name-status"
                            | "--shortstat"
                            | "--no-color"
                            | "--no-ext-diff"
                            | "--no-textconv"
                            | "--cached"
                            | "--staged"
                            | "--check"
                    )
                })
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_read_commands_and_versions_are_allowed_but_opaque_scripts_are_not() {
        for command in [
            "git status --short",
            "git diff --stat --no-ext-diff --no-textconv",
            "node --version",
        ] {
            assert!(safe_command(command), "{command}");
        }
        for command in [
            "git diff",
            "git diff --cached",
            "git reset --hard",
            "git diff --output=changed.txt",
            "node --version > changed.txt",
            "git status && del data",
            "git status\nrm file",
            "node -e code",
            "npm test",
            "powershell -Command git status",
            "git -C other status",
            "node --version | cmd",
            "git status `whoami`",
        ] {
            assert!(!safe_command(command), "{command}");
        }
    }

    #[test]
    fn parsed_resource_cannot_override_original_tool_input_or_external_workdir() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut request = AgentPermission {
            id: "per_test".into(),
            session_id: "ses_test".into(),
            action: "shell".into(),
            resources: vec!["node --version".into()],
            description: None,
            tool_name: None,
            tool_input: None,
        };
        assert!(!approve_automatically(
            &request,
            &project.path().to_string_lossy()
        ));
        request.tool_input = Some(serde_json::json!({"command":"node --version > changed.txt"}));
        assert!(!approve_automatically(
            &request,
            &project.path().to_string_lossy()
        ));
        request.tool_input =
            Some(serde_json::json!({"command":"node --version", "workdir":outside.path()}));
        assert!(!approve_automatically(
            &request,
            &project.path().to_string_lossy()
        ));
        request.tool_input =
            Some(serde_json::json!({"command":"node --version", "workdir":project.path()}));
        assert!(approve_automatically(
            &request,
            &project.path().to_string_lossy()
        ));
    }
}
