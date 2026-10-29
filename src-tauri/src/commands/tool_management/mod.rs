//! External CLI tools: version discovery, installation diagnostics, lifecycle actions and terminals.
//!
//! Desktop-only operations live in `commands::desktop`. Each implementation module
//! owns one part of tool management; the IPC command names stay exported here.
#![allow(non_snake_case)]

mod installations;
mod lifecycle;
mod paths;
mod process;
mod terminal;
mod tool_uninstall;
mod versions;

pub use installations::*;
pub use lifecycle::*;
#[cfg(test)]
use paths::*;
#[cfg(test)]
use process::*;
pub use terminal::*;
pub use versions::*;

pub(crate) use process::{decode_command_output, run_detected_tool_command_with_timeout};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const VALID_TOOLS: [&str; 9] = [
    "claude", "codex", "gemini", "grok", "opencode", "openclaw", "hermes", "pi", "mcode",
];

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslShellPreferenceInput {
    #[serde(default)]
    pub wsl_shell: Option<String>,
    #[serde(default)]
    pub wsl_shell_flag: Option<String>,
}

#[cfg(test)]
mod tests;
