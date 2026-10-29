//! Serialized CLI install/update actions and installation-aware command strategies.

#[cfg(target_os = "windows")]
use super::installations::wsl_distro_for_tool;
#[cfg(not(target_os = "windows"))]
use super::installations::{brew_cask_from_path, brew_formula_from_path, is_brew_managed_path};
use super::installations::{
    default_install, enumerate_tool_installations, infer_install_source, is_grok_native_install,
    mcode_receipt_install_root, mcode_script_install_root, parent_dir, McodeLayout,
    ToolInstallation,
};
#[cfg(target_os = "windows")]
use super::paths::effective_path_string;
#[cfg(not(target_os = "windows"))]
use super::paths::{login_shell_path, merge_path_segments};
use super::process::decode_command_output;
#[cfg(not(target_os = "windows"))]
use super::terminal::quote_path_if_spaced;
#[cfg(not(target_os = "windows"))]
use super::terminal::shell_single_quote;
use super::terminal::{default_flag_for_shell, is_valid_shell};
#[cfg(target_os = "windows")]
use super::terminal::{
    is_valid_shell_flag, is_valid_wsl_distro_name, win_quote_path_for_batch,
    windows_cmd_double_quote_arg,
};
use super::tool_uninstall;
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;
use super::{WslShellPreferenceInput, VALID_TOOLS};
use once_cell::sync::Lazy;
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;

// 不同工具仍可能共用 pnpm/npm 的全局目录。先保守地串行化所有安装写入，
// 并在排队前锁定工具，防止页面重挂或另一 IPC 调用重复提交同一工具。
pub(super) struct ToolLifecycleCoordinator {
    tools: HashMap<&'static str, Arc<tokio::sync::Mutex<()>>>,
    execution: Arc<tokio::sync::Mutex<()>>,
}

impl Default for ToolLifecycleCoordinator {
    fn default() -> Self {
        Self {
            tools: VALID_TOOLS
                .iter()
                .map(|&tool| (tool, Arc::new(tokio::sync::Mutex::new(()))))
                .collect(),
            execution: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}

impl ToolLifecycleCoordinator {
    pub(super) async fn run<F>(&self, tools: Vec<&'static str>, operation: F) -> Result<(), String>
    where
        F: FnOnce(&[&str]) -> Result<(), String> + Send + 'static,
    {
        let tool_guards = tools
            .iter()
            .map(|tool| {
                self.tools
                    .get(tool)
                    .ok_or_else(|| format!("Unsupported tool action target: {tool}"))?
                    .clone()
                    .try_lock_owned()
                    // 稳定错误码供前端区分后台任务仍在进行与真正的执行失败。
                    .map_err(|_| "TOOL_ACTION_IN_PROGRESS".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let execution_guard = self.execution.clone().lock_owned().await;

        // 必须把锁移进 blocking 任务：即使等待它的 IPC future 被取消，
        // 子进程仍会继续运行，直到它真正退出前都不能允许下一次写入。
        tokio::task::spawn_blocking(move || {
            let _tool_guards = tool_guards;
            let _execution_guard = execution_guard;
            operation(&tools)
        })
        .await
        .map_err(|e| format!("tool lifecycle task join error: {e}"))?
    }
}

pub(super) static TOOL_LIFECYCLE: Lazy<ToolLifecycleCoordinator> =
    Lazy::new(ToolLifecycleCoordinator::default);

/// Display-only plan. Execution regenerates it under the lifecycle lock and rejects changes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ToolUninstallPlan {
    pub(super) tool: String,
    pub(super) path: String,
    pub(super) real_path: String,
    pub(super) command: String,
    pub(super) native: bool,
    pub(super) wsl_distro: Option<String>,
}

#[tauri::command]
pub async fn prepare_tool_uninstall(
    tool: String,
    wsl_shell_by_tool: Option<HashMap<String, WslShellPreferenceInput>>,
) -> Result<ToolUninstallPlan, String> {
    if !VALID_TOOLS.contains(&tool.as_str()) {
        return Err(format!("Unsupported tool action target: {tool}"));
    }
    tokio::task::spawn_blocking(move || {
        let pref = wsl_shell_by_tool
            .as_ref()
            .and_then(|prefs| prefs.get(&tool));
        tool_uninstall::plan(&tool, pref)
    })
    .await
    .map_err(|e| format!("uninstall plan task join error: {e}"))?
}

#[tauri::command]
pub async fn run_tool_lifecycle_action(
    tools: Vec<String>,
    action: String,
    wsl_shell_by_tool: Option<HashMap<String, WslShellPreferenceInput>>,
    uninstall_plan: Option<ToolUninstallPlan>,
) -> Result<(), String> {
    let requested = normalize_requested_tools(&tools);
    if requested.is_empty() {
        return Err("No supported tools selected".to_string());
    }

    if action == "uninstall" {
        let plan = uninstall_plan.ok_or("Preview the uninstall plan before confirming.")?;
        if requested.len() != 1 || requested[0] != plan.tool {
            return Err("The uninstall plan does not match the selected tool.".into());
        }
        return TOOL_LIFECYCLE
            .run(requested, move |tools| {
                for tool in tools {
                    let pref = wsl_shell_by_tool
                        .as_ref()
                        .and_then(|prefs| prefs.get(*tool));
                    tool_uninstall::uninstall(tool, pref, &plan)?;
                }
                Ok(())
            })
            .await;
    }
    let action = ToolLifecycleAction::from_str(&action)?;

    let label = match action {
        ToolLifecycleAction::Install => "tool_install",
        ToolLifecycleAction::Update => "tool_update",
    };

    // 排队结束后再探测安装目标，与执行一起持锁，避免读到另一升级的中间状态。
    TOOL_LIFECYCLE
        .run(requested, move |tools| {
            let command_line =
                build_tool_lifecycle_command(tools, action, wsl_shell_by_tool.as_ref())?;
            run_tool_lifecycle_silently(&command_line, label)
        })
        .await
}

/// 静默执行工具安装/更新脚本：直接捕获子进程输出并阻塞到命令真正结束，
/// 不再弹出可见终端窗口（与 `launch_terminal_running` 的"开窗即返回"形成对比，
/// 后者仍保留给 provider 切换等需要交互式终端的场景）。
/// 失败时回传 stderr/stdout 末尾若干行，供前端 toast 提示。
#[cfg(not(target_os = "windows"))]
pub(super) fn run_tool_lifecycle_silently(command_line: &str, _label: &str) -> Result<(), String> {
    use std::process::Command;
    // command_line 是 bash 风格脚本（含 `set -e` 与多行命令）；强制用 bash 执行，
    // 避免用户默认 shell 为 fish/zsh 时 `set -e` 等语义不一致。
    let mut cmd = Command::new("bash");
    cmd.arg("-c").arg(command_line);
    // GUI App 继承的是 launchd 的窄 PATH，而锚定探测用的是登录 shell —— 见
    // `login_shell_path` doc。命令自身用绝对路径不受影响，但工具**内部** spawn 的
    // npm/node 等子进程、以及 install 链里裸的 npm fallback 都需要真实 PATH。
    if let Some(login_path) = login_shell_path() {
        let inherited = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", merge_path_segments(&login_path, &inherited));
    }
    let output = cmd.output().map_err(|e| format!("启动安装进程失败: {e}"))?;
    finish_lifecycle_output(&output)
}

/// Windows 静默执行：command_line 是 .bat 内容（chcp 65001 + @echo off + call/wsl 行，CRLF 分隔），
/// 写临时 .bat 后用 `cmd /C` 执行，`CREATE_NO_WINDOW` 抑制 console 窗口。
#[cfg(target_os = "windows")]
pub(super) fn run_tool_lifecycle_silently(command_line: &str, label: &str) -> Result<(), String> {
    // 每次调用使用独立目录，避免同进程并发升级时覆盖或删除另一工具的脚本。
    let script_dir = tempfile::Builder::new()
        .prefix("lolicode_lifecycle_")
        .tempdir()
        .map_err(|e| format!("创建批处理目录失败: {e}"))?;
    let bat_file = script_dir.path().join(format!("{label}.bat"));
    std::fs::write(&bat_file, command_line).map_err(|e| format!("写入批处理文件失败: {e}"))?;

    let output = windows_lifecycle_command(&bat_file, &effective_path_string()).output();

    finish_lifecycle_output(&output.map_err(|e| format!("启动安装进程失败: {e}"))?)
}

#[cfg(target_os = "windows")]
pub(super) fn windows_lifecycle_command(
    bat_file: &Path,
    effective_path: &str,
) -> std::process::Command {
    let mut command = std::process::Command::new("cmd");
    command
        .arg("/C")
        .arg(bat_file)
        // MSI 自动重启可能丢失用户 PATH（#8171）。执行与探测共用补全后的 PATH，
        // 让裸 npm 兜底及工具内部启动的 node/npm 都能找到；仅设置子进程环境。
        .env("PATH", effective_path)
        .creation_flags(CREATE_NO_WINDOW);
    command
}

/// 把子进程退出结果转成 `Result`：成功返回 `Ok`；失败提取 stderr（空则回退 stdout）
/// 的末尾若干行作为错误详情，避免把整段安装日志塞进 toast。
pub(super) fn finish_lifecycle_output(output: &std::process::Output) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = decode_command_output(&output.stderr);
    let stdout = decode_command_output(&output.stdout);
    let raw = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    let detail = last_lines(raw, 8);
    Err(if detail.is_empty() {
        format!("命令执行失败 (exit code: {:?})", output.status.code())
    } else {
        detail
    })
}

/// 取文本末尾最多 `n` 行（npm / pip 的关键错误通常出现在输出尾部）。
pub(super) fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

pub(super) fn normalize_requested_tools(tools: &[String]) -> Vec<&'static str> {
    let set: std::collections::HashSet<&str> = tools.iter().map(|s| s.as_str()).collect();
    VALID_TOOLS
        .iter()
        .copied()
        .filter(|tool| set.contains(tool))
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub(super) enum ToolLifecycleAction {
    Install,
    Update,
}

impl FromStr for ToolLifecycleAction {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "install" => Ok(Self::Install),
            "update" => Ok(Self::Update),
            _ => Err(format!("Unsupported tool action: {value}")),
        }
    }
}

pub(super) fn build_tool_lifecycle_command(
    tools: &[&str],
    action: ToolLifecycleAction,
    wsl_shell_by_tool: Option<&HashMap<String, WslShellPreferenceInput>>,
) -> Result<String, String> {
    let mut lines = Vec::new();

    #[cfg(not(target_os = "windows"))]
    {
        // set -e 让任一步失败即中止;set -o pipefail 保留为管道命令的兜底防线。
        // 当前官方 installer 路径已避免 `curl | bash`,但未来若新增管道命令,
        // 仍应让管道前段失败参与整条脚本判定。
        lines.push("set -e".to_string());
        lines.push("set -o pipefail".to_string());
    }

    // .bat 以 UTF-8 写入，cmd 却按控制台代码页（中文系统 936、西文 437/850）解析，
    // 用户名含非 ASCII 字符时锚定的 npm.cmd 路径会乱码（#8034）。首行是纯 ASCII，
    // 任何代码页都能正确解析；chcp 之后的行按 UTF-8 读。CREATE_NO_WINDOW 下这是
    // 独立的隐藏控制台，不影响用户终端。
    #[cfg(target_os = "windows")]
    {
        lines.push("@chcp 65001>nul".to_string());
        lines.push("@echo off".to_string());
    }

    for tool in tools {
        let label = tool_display_name(tool);
        lines.push(format!("echo ========== {label} =========="));

        let pref = wsl_shell_by_tool.and_then(|m| m.get(*tool));
        let line = build_tool_action_line(
            tool,
            action,
            pref.and_then(|p| p.wsl_shell.as_deref()),
            pref.and_then(|p| p.wsl_shell_flag.as_deref()),
        )?;
        lines.push(line);

        #[cfg(target_os = "windows")]
        lines.push("if errorlevel 1 exit /b %errorlevel%".to_string());

        #[cfg(not(target_os = "windows"))]
        lines.push(String::new());
    }

    Ok(lines.join(if cfg!(target_os = "windows") {
        "\r\n"
    } else {
        "\n"
    }))
}

pub(super) fn tool_display_name(tool: &str) -> &'static str {
    match tool {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "gemini" => "Gemini CLI",
        "grok" => "Grok Build",
        "opencode" => "OpenCode",
        "openclaw" => "OpenClaw",
        "hermes" => "Hermes",
        "pi" => "Pi",
        "mcode" => "MiniMax Code",
        _ => "Unknown",
    }
}

/// 官方 shell installer 都不用 `curl | bash` 这种 pipe 形式（仍然用 curl 下载，
/// 只是先落到临时文件再交给 bash 执行）:WSL 分支会在
/// `wsl.exe ... -- sh -c "<cmd>"` 子 shell 里执行命令,外层脚本的 `set -o pipefail`
/// 不会继承进去;而 WSL 默认 shell 可能是 dash/ash,也不能假设支持 `set -o pipefail`。
/// 先下载到 mktemp 文件再交给 bash,能让 curl 失败稳定变成整条命令失败。
pub(super) const CLAUDE_INSTALL_UNIX: &str =
    "bash -c 'tmp=$(mktemp) && curl -fsSL https://claude.ai/install.sh -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";
pub(super) const OPENCODE_INSTALL_UNIX: &str =
    "bash -c 'tmp=$(mktemp) && curl -fsSL https://opencode.ai/install -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";
pub(super) const GROK_INSTALL_UNIX: &str =
    "bash -c 'tmp=$(mktemp) && curl -fsSL https://x.ai/cli/install.sh -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";
/// MiniMax Code 官方 installer：用 npm `--prefix` 装进 `~/.minimax-code`（`MCODE_INSTALL_DIR`
/// 可改），系统 Node 不达标时自带隔离 Node；重跑即升级（已是最新则跳过），全程无交互提示。
pub(super) const MCODE_INSTALL_UNIX: &str =
    "bash -c 'tmp=$(mktemp) && curl -fsSL https://filecdn.minimax.chat/public/install.sh -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";
/// Codex 官方独立安装器（POSIX sh 脚本）。独立安装版的 `codex update` 内部跑的正是
/// `curl ... | sh` 且没开 pipefail——实测断网时 curl 失败、sh 读到空脚本 exit 0，
/// `codex update` 仍打印 "Update ran successfully" 并 exit 0。所以不走 `codex update`，
/// 由这里下载到临时文件再执行，curl 失败会如实变成整条命令失败。
/// 只用于锚定升级（Windows 用 `CODEX_INSTALL_WINDOWS_SCRIPT`；WSL 不锚定），故按平台 gate。
#[cfg(not(target_os = "windows"))]
pub(super) const CODEX_INSTALL_UNIX: &str =
    "bash -c 'tmp=$(mktemp) && curl -fsSL https://chatgpt.com/codex/install.sh -o $tmp && sh $tmp; status=$?; rm -f $tmp; exit $status'";

/// Hermes 官方安装器会自带/选择合适的 Python 运行时。不要再用
/// `python3 -m pip ... || python -m pip ...`:Hermes PyPI 包要求 Python >=3.11,
/// 但 macOS 系统 `python3` 常是 3.9,而 pyenv 下 `python` shim 还可能不存在,会把
/// 真正的 Python 版本问题盖成 "python command exists in these Python versions"。
pub(super) const HERMES_INSTALL_UNIX: &str =
    "bash -c 'tmp=$(mktemp) && curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";
pub(super) const HERMES_UPDATE_UNIX: &str =
    "hermes update || bash -c 'tmp=$(mktemp) && curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";

#[cfg(target_os = "windows")]
pub(super) const HERMES_INSTALL_WINDOWS_SCRIPT: &str =
    "irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex";
#[cfg(target_os = "windows")]
pub(super) const GROK_INSTALL_WINDOWS_SCRIPT: &str = "irm https://x.ai/cli/install.ps1 | iex";
#[cfg(target_os = "windows")]
pub(super) const MCODE_INSTALL_WINDOWS_SCRIPT: &str =
    "irm https://filecdn.minimax.chat/public/install.ps1 | iex";
#[cfg(target_os = "windows")]
pub(super) const CODEX_INSTALL_WINDOWS_SCRIPT: &str =
    "irm https://chatgpt.com/codex/install.ps1 | iex";

#[cfg(target_os = "windows")]
pub(super) fn powershell_encoded_command(script: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let mut bytes = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    STANDARD.encode(bytes)
}

#[cfg(target_os = "windows")]
pub(super) fn hermes_install_windows_command() -> String {
    format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
        powershell_encoded_command(HERMES_INSTALL_WINDOWS_SCRIPT)
    )
}

#[cfg(target_os = "windows")]
pub(super) fn grok_install_windows_command() -> String {
    format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
        powershell_encoded_command(GROK_INSTALL_WINDOWS_SCRIPT)
    )
}

#[cfg(target_os = "windows")]
pub(super) fn mcode_install_windows_command() -> String {
    format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
        powershell_encoded_command(MCODE_INSTALL_WINDOWS_SCRIPT)
    )
}

/// 重跑官方 installer 升级「脚本安装」那一处。显式传 `MCODE_INSTALL_DIR`，保证写回
/// 探测到的那个目录，而不是 installer 的默认目录。
#[cfg(not(target_os = "windows"))]
pub(super) fn mcode_installer_update_command(install_root: &str) -> String {
    format!(
        "MCODE_INSTALL_DIR={} {MCODE_INSTALL_UNIX}",
        shell_single_quote(install_root)
    )
}

#[cfg(target_os = "windows")]
pub(super) fn mcode_installer_update_command(install_root: &str) -> String {
    // PowerShell 单引号字面量里 `'` 写作 `''`；整段经 EncodedCommand 传入，不经 cmd 解析。
    let script = format!(
        "$env:MCODE_INSTALL_DIR = '{}'; {MCODE_INSTALL_WINDOWS_SCRIPT}",
        install_root.replace('\'', "''")
    );
    format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
        powershell_encoded_command(&script)
    )
}

/// Codex 官方独立安装器（`install.sh` / `install.ps1`）装出的一处安装。
///
/// 布局（2026-09 实测 install.sh、读 install.ps1）：发布包在
/// `<CODEX_HOME>/packages/standalone/releases/<ver>-<target>/`，`current` 指向当前版本；
/// PATH 上的入口放在 `CODEX_INSTALL_DIR`（POSIX 默认 `~/.local/bin` 下的软链，Windows 默认
/// `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` 这个 junction），真身都解析到发布包里。
/// 它既不归 npm 管，也不在 `prefers_official_update` 里，此前锚定落空、退回裸
/// `npm i -g` 另装一份 npm 版（#7650）。
#[derive(Debug, PartialEq, Eq)]
pub(super) struct CodexStandaloneInstall {
    /// 入口所在目录，重跑 installer 时作为 `CODEX_INSTALL_DIR` 写回同一处。
    pub(super) install_dir: String,
    /// 从真身路径截出的 `CODEX_HOME`；GUI 进程拿不到用户 shell 里设的 `CODEX_HOME`，
    /// 不显式传会装进默认的 `~/.codex`，入口指向的那份原地不动。
    pub(super) codex_home: Option<String>,
}

/// 纯字符串判定、不碰 fs，POSIX / Windows 路径都能在任一平台单测。
pub(super) fn codex_standalone_install(
    bin_path: &str,
    real_target: &str,
) -> Option<CodexStandaloneInstall> {
    let install_dir = parent_dir(bin_path);
    if install_dir.is_empty() {
        return None;
    }
    let normalized_real = real_target.replace('\\', "/").to_ascii_lowercase();
    if let Some(idx) = normalized_real.find("/packages/standalone/") {
        // `replace` 与 `to_ascii_lowercase` 都不改字节长度，下标可直接用于原串。
        // Windows 的 real 是 canonicalize 出的 `\\?\` verbatim 路径，交给 installer 前还原。
        let home = &real_target[..idx];
        let home = match home.strip_prefix(r"\\?\UNC\") {
            Some(unc) => format!(r"\\{unc}"),
            None => home.strip_prefix(r"\\?\").unwrap_or(home).to_string(),
        };
        if !home.is_empty() {
            return Some(CodexStandaloneInstall {
                install_dir,
                codex_home: Some(home),
            });
        }
    }
    // canonicalize 失败时 real 就是入口本身；Windows 默认入口目录仍能认出来，
    // 只是拿不到 CODEX_HOME，交给 installer 用默认值。
    let normalized_bin = bin_path.replace('\\', "/").to_ascii_lowercase();
    normalized_bin
        .contains("/programs/openai/codex/bin/")
        .then_some(CodexStandaloneInstall {
            install_dir,
            codex_home: None,
        })
}

/// 重跑官方 installer 升级独立安装那一处。显式传 `CODEX_INSTALL_DIR` / `CODEX_HOME`
/// 写回探测到的位置（实测自定义目录时会原地升级、不在默认目录多装一份）；
/// `CODEX_NON_INTERACTIVE=1` 与 `codex update` 自己重跑 installer 时的做法一致。
#[cfg(not(target_os = "windows"))]
pub(super) fn codex_installer_update_command(install: &CodexStandaloneInstall) -> String {
    let mut env = format!(
        "CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR={}",
        shell_single_quote(&install.install_dir)
    );
    if let Some(home) = &install.codex_home {
        env.push_str(&format!(" CODEX_HOME={}", shell_single_quote(home)));
    }
    format!("{env} {CODEX_INSTALL_UNIX}")
}

#[cfg(target_os = "windows")]
pub(super) fn codex_installer_update_command(install: &CodexStandaloneInstall) -> String {
    // PowerShell 单引号字面量里 `'` 写作 `''`；整段经 EncodedCommand 传入，不经 cmd 解析。
    let quote = |value: &str| value.replace('\'', "''");
    let mut script = format!(
        "$env:CODEX_NON_INTERACTIVE = '1'; $env:CODEX_INSTALL_DIR = '{}'; ",
        quote(&install.install_dir)
    );
    if let Some(home) = &install.codex_home {
        script.push_str(&format!("$env:CODEX_HOME = '{}'; ", quote(home)));
    }
    script.push_str(CODEX_INSTALL_WINDOWS_SCRIPT);
    format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
        powershell_encoded_command(&script)
    )
}

#[cfg(target_os = "windows")]
pub(super) fn hermes_update_windows_command() -> String {
    // fallback 是 powershell.exe，不是 .cmd/.bat；这里不需要 `call`。PowerShell 的
    // `irm | iex` 已被 EncodedCommand 收进单一参数,避免 `cmd.exe` 解析管道符。
    format!("hermes update || {}", hermes_install_windows_command())
}

#[derive(Debug, Clone, Copy)]
pub(super) enum LifecycleCommandShell {
    Posix,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    WindowsBatch,
}

pub(super) fn npm_install_command_for(tool: &str) -> Option<&'static str> {
    match tool {
        "claude" => Some(
            "npm i -g @anthropic-ai/claude-code@latest --ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code",
        ),
        "codex" => Some("npm i -g @openai/codex@latest"),
        "gemini" => Some("npm i -g @google/gemini-cli@latest"),
        "grok" => Some("npm i -g @xai-official/grok@latest"),
        "opencode" => Some("npm i -g opencode-ai@latest"),
        "openclaw" => Some("npm i -g openclaw@latest"),
        "pi" => Some("npm i -g @earendil-works/pi-coding-agent@latest"),
        "mcode" => Some(
            "npm i -g @minimax-ai/code@latest --ignore-scripts=false --include=optional \"--allow-scripts=@minimax-ai/code,better-sqlite3\"",
        ),
        _ => None,
    }
}

/// `npm i -g` 时须追加的参数（前导空格已含），与 `npm_install_command_for` 的静态命令
/// 保持一致，供锚定到某处 npm 的升级命令复用。
///
/// Claude Code 的 postinstall 把平台 optional dependency 中的原生程序放到 bin/claude.exe。
/// npm 12 拦截该脚本时会留下文本占位文件，Windows 执行后报“与 Windows 版本不兼容”。
/// MiniMax Code 依赖 better-sqlite3 的安装脚本：npm 12 默认拦截依赖的 install 脚本，
/// 只放行 `--allow-scripts` 列出的包（按注册表包名匹配），被拦后 SQLite 不可用；
/// `--ignore-scripts=false` / `--include=optional` 抵消用户 npmrc 里的相反设置。
/// npm 10/11 上这串参数无副作用（实测 exit 0、脚本照常执行）。整段 `--allow-scripts=…`
/// 加双引号：逗号在 PowerShell 里会被当成数组分隔符，bash/cmd 都会剥掉这层引号。
pub(super) fn npm_install_extra_args(tool: &str) -> &'static str {
    match tool {
        "claude" => {
            " --ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code"
        }
        "mcode" => {
            " --ignore-scripts=false --include=optional \"--allow-scripts=@minimax-ai/code,better-sqlite3\""
        }
        _ => "",
    }
}

// MiniMax Code 虽有 `mcode update`，却刻意不列在这里：它在 stdin/stdout 非 TTY 时只打印
// "No interactive confirmation is available" 就 exit 0、并不安装。静默 lifecycle 的
// `cmd.output()` 正是非 TTY，放进来会让 `mcode update || <fallback>` 的兜底永不触发。
pub(super) fn official_update_args(tool: &str) -> Option<&'static str> {
    match tool {
        "claude" | "codex" | "grok" | "hermes" => Some("update"),
        "openclaw" => Some("update --yes"),
        "opencode" => Some("upgrade"),
        _ => None,
    }
}

pub(super) fn bare_official_update_command(tool: &str) -> Option<String> {
    official_update_args(tool).map(|args| format!("{tool} {args}"))
}

pub(super) fn chain_update_commands(
    primary: String,
    fallback: String,
    shell: LifecycleCommandShell,
) -> String {
    if fallback.trim().is_empty() {
        return primary;
    }
    match shell {
        LifecycleCommandShell::Posix => format!("{primary} || {fallback}"),
        // 这段最终会被外层再包成 `call <command>`。fallback 若是 npm.cmd/pnpm.cmd,
        // `||` 右侧也必须显式 `call`,否则批处理会转移控制权并跳过后续工具。
        LifecycleCommandShell::WindowsBatch => format!("{primary} || call {fallback}"),
    }
}

pub(super) fn tool_action_shell_command_for_shell(
    tool: &str,
    action: ToolLifecycleAction,
    shell: LifecycleCommandShell,
) -> Option<String> {
    // xAI's and MiniMax's primary Windows distribution is the official PowerShell
    // installer. Keep npm as the network/policy fallback, matching the POSIX installer chain.
    #[cfg(target_os = "windows")]
    if matches!(action, ToolLifecycleAction::Install)
        && matches!(shell, LifecycleCommandShell::WindowsBatch)
    {
        let installer = match tool {
            "grok" => Some(grok_install_windows_command()),
            "mcode" => Some(mcode_install_windows_command()),
            _ => None,
        };
        if let Some(installer) = installer {
            return Some(chain_update_commands(
                installer,
                npm_install_command_for(tool)?.to_string(),
                shell,
            ));
        }
    }

    if tool == "hermes" {
        return Some(
            match (action, shell) {
                (ToolLifecycleAction::Install, LifecycleCommandShell::Posix) => HERMES_INSTALL_UNIX,
                (ToolLifecycleAction::Update, LifecycleCommandShell::Posix) => HERMES_UPDATE_UNIX,
                #[cfg(target_os = "windows")]
                (ToolLifecycleAction::Install, LifecycleCommandShell::WindowsBatch) => {
                    return Some(hermes_install_windows_command());
                }
                #[cfg(target_os = "windows")]
                (ToolLifecycleAction::Update, LifecycleCommandShell::WindowsBatch) => {
                    return Some(hermes_update_windows_command());
                }
                #[cfg(not(target_os = "windows"))]
                (_, LifecycleCommandShell::WindowsBatch) => return None,
            }
            .to_string(),
        );
    }

    let install = npm_install_command_for(tool)?;
    match action {
        ToolLifecycleAction::Install => Some(install.to_string()),
        ToolLifecycleAction::Update => match prefers_official_update(tool, shell)
            .then(|| bare_official_update_command(tool))
            .flatten()
        {
            Some(update) => Some(chain_update_commands(update, install.to_string(), shell)),
            None => Some(install.to_string()),
        },
    }
}

pub(super) fn tool_action_shell_command(tool: &str, action: ToolLifecycleAction) -> Option<String> {
    #[cfg(target_os = "windows")]
    let shell = LifecycleCommandShell::WindowsBatch;
    #[cfg(not(target_os = "windows"))]
    let shell = LifecycleCommandShell::Posix;

    tool_action_shell_command_for_shell(tool, action, shell)
}

/// Windows host 上的 WSL 分支专用:`tool_action_shell_command` 在 Windows target 编译
/// 出的版本会包含 Windows batch 语义(例如 `|| call npm ...`)且 hermes 会返回
/// Windows PowerShell installer,但跨 `wsl.exe` 边界后跑的是 Linux。这个 wrapper
/// 强制生成 POSIX 版命令。
#[cfg(target_os = "windows")]
pub(super) fn wsl_tool_action_shell_command(
    tool: &str,
    action: ToolLifecycleAction,
) -> Option<String> {
    match action {
        ToolLifecycleAction::Install => {
            let command = posix_install_command_for(tool);
            if command.is_empty() {
                None
            } else {
                Some(command)
            }
        }
        ToolLifecycleAction::Update => {
            tool_action_shell_command_for_shell(tool, action, LifecycleCommandShell::Posix)
        }
    }
}

pub(super) fn build_tool_action_line(
    tool: &str,
    action: ToolLifecycleAction,
    wsl_shell: Option<&str>,
    wsl_shell_flag: Option<&str>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // ① WSL 工具(override 是 UNC `\\wsl$\<distro>\...`):锚定的绝对路径是 Windows
        //    主机路径,跨 wsl.exe 进入 distro 文件系统后无效;且 enumerate 不参与 WSL。
        //    install 走 POSIX 安装优先级,update 走 POSIX 静态/官方 update 命令,
        //    再通过 wsl.exe -d distro -- sh 包一层。
        //    **必须用 wsl_tool_action_shell_command 而非 tool_action_shell_command**:
        //    后者在 Windows target 给 hermes 返回 PowerShell installer,且 Windows batch
        //    语义也不适合跨 wsl.exe;这里统一替换为 POSIX 版安装/更新命令。
        if let Some(distro) = wsl_distro_for_tool(tool) {
            let command = wsl_tool_action_shell_command(tool, action)
                .ok_or_else(|| format!("Unsupported tool action target: {tool}"))?;
            return build_wsl_tool_action_line(&distro, &command, wsl_shell, wsl_shell_flag);
        }
        // ② Windows 原生 update 锚定;install 走静态(install.sh 是 bash 脚本,Windows
        //    无意义)。**`enumerate_tool_installations` 在这里 per-tool 重做、与前端
        //    probe 阶段算过的结果不共享是 by design**:run_tool_lifecycle_action 是
        //    独立 IPC 调用,不信任前端回传的命令字符串(避免命令注入面扩大);前端是
        //    逐工具触发 lifecycle,batch 化会破坏"逐工具独立成败"的 UX。
        let command = match action {
            ToolLifecycleAction::Update => {
                let installs = enumerate_tool_installations(tool);
                match resolve_update_command(tool, &installs) {
                    UpdateCommand::Anchored(command) | UpdateCommand::Static(command) => command,
                    UpdateCommand::Unmanaged => {
                        return Err(unmanaged_update_error(tool, &installs));
                    }
                }
            }
            ToolLifecycleAction::Install => {
                static_fallback_command_for(tool, ToolLifecycleAction::Install)
            }
        };
        if command.is_empty() {
            return Err(format!("Unsupported tool action target: {tool}"));
        }
        // .bat 调用 .cmd/.bat 必须用 `call` 否则当前脚本被替换、后续 `if errorlevel`
        // 行被跳过;对 .exe 加 call 无害(等同直接调用)。锚定命令头部可能是 .cmd
        // (npm/pnpm)或 .exe(volta),静态命令头部是 `npm`(也是 .cmd)、`py` 等——
        // 全部加 `call ` 前缀,风格统一且语义正确。含空格的头部已被 `win_quote_path_for_batch`
        // 加上双引号,call 对带引号的路径解析正常。
        Ok(format!("call {command}"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (wsl_shell, wsl_shell_flag);
        // update 锚定到命令行实际命中的那处（写回同一个 node / brew / 原生安装器），
        // 而非裸 `npm` 落到 PATH 第一个 npm；install 走「上游推荐 || npm 兜底」短路链
        // （有 native installer 的工具如 claude/opencode/hermes），其余仍裸 npm。
        let command = match action {
            ToolLifecycleAction::Update => {
                let installs = enumerate_tool_installations(tool);
                match resolve_update_command(tool, &installs) {
                    UpdateCommand::Anchored(command) | UpdateCommand::Static(command) => command,
                    UpdateCommand::Unmanaged => {
                        return Err(unmanaged_update_error(tool, &installs));
                    }
                }
            }
            ToolLifecycleAction::Install => install_command_for(tool),
        };
        if command.is_empty() {
            return Err(format!("Unsupported tool action target: {tool}"));
        }
        Ok(command)
    }
}

#[cfg(target_os = "windows")]
pub(super) fn build_wsl_tool_action_line(
    distro: &str,
    command: &str,
    force_shell: Option<&str>,
    force_shell_flag: Option<&str>,
) -> Result<String, String> {
    if !is_valid_wsl_distro_name(distro) {
        return Err(format!("Invalid WSL distro name: {distro}"));
    }

    let shell = force_shell
        .map(|s| s.rsplit('/').next().unwrap_or(s))
        .unwrap_or("sh");
    if !is_valid_shell(shell) {
        return Err(format!("Invalid WSL shell: {shell}"));
    }

    let flag = if let Some(flag) = force_shell_flag {
        if !is_valid_shell_flag(flag) {
            return Err(format!("Invalid WSL shell flag: {flag}"));
        }
        flag
    } else {
        default_flag_for_shell(shell)
    };

    Ok(format!(
        "wsl.exe -d {distro} -- {shell} {flag} {}",
        windows_cmd_double_quote_arg(command)
    ))
}

/// 工具对应的 npm 包名（hermes 走自己的 CLI/installer，不在此表）。锚定升级据此拼 `npm i -g`。
/// 全平台共用一张表——Windows 锚定层(`anchored_command_from_paths` 的 windows 版)也读这里。
pub(super) fn npm_package_for(tool: &str) -> Option<&'static str> {
    match tool {
        "claude" => Some("@anthropic-ai/claude-code"),
        "codex" => Some("@openai/codex"),
        "gemini" => Some("@google/gemini-cli"),
        "grok" => Some("@xai-official/grok"),
        "opencode" => Some("opencode-ai"),
        "openclaw" => Some("openclaw"),
        "pi" => Some("@earendil-works/pi-coding-agent"),
        "mcode" => Some("@minimax-ai/code"),
        _ => None,
    }
}

/// Windows 版 sibling 推导:在 `<bin_path 父目录>` 下按 `ext_candidates` 顺序找
/// 第一个存在的 `<exe_basename>.<ext>` 文件,返回该绝对路径。
///
/// **与 POSIX `sibling_bin` 的关键区别:这里碰 fs**——Windows 上 npm/pnpm 的入口
/// 实际扩展名可能是 `.cmd` 也可能是 `.exe`(Node.js installer 装的是 `npm.cmd`、
/// 部分 pnpm 是 `pnpm.exe`),纯字符串拼接无法知道哪个真的存在,猜错会拼出
/// "GUI 执行时 file not found" 的命令。fs 检查放进 helper、单测用 tempdir 覆盖,
/// 让上层 `anchored_command_from_paths` 仍保持"接收已锚定路径"的接口形态。
///
/// **TOCTOU 是 by design**:预检 `is_file` 是为了让确认对话框展示真实命令字符串;
/// 检查到执行之间被外部进程(卸载器 / nvm switch / 杀软隔离)移走文件 → cmd /C
/// 报 ENOENT,toast 显示错误。不要在执行前再做二次预检——双重 syscall 也解决不了 race。
///
/// 候选扩展名顺序按工具 idiom:npm/pnpm 优先 `.cmd`(node 装的),volta 优先 `.exe`
/// (Volta 是 Rust 写的 native binary)。
///
/// **不用 `which::which_in` 的理由**:per-tool 扩展名优先级(volta 偏 `.exe`、npm/pnpm
/// 偏 `.cmd`)与 PATHEXT 的固定顺序不一致,而且只为这一处加 `which` 依赖收益不抵 audit
/// surface。`PathBuf::join` 让 separator 选择交给 std,避免 `format!("{dir}\\...")`
/// 硬编码 `\\` 在混合分隔符 bin_path 下产出丑陋路径。
///
/// 空 dir 或所有候选都不存在 → None,上游退化到静态命令,与 POSIX 路径同款语义。
#[cfg(target_os = "windows")]
pub(super) fn sibling_bin_with_ext(
    bin_path: &str,
    exe_basename: &str,
    ext_candidates: &[&str],
) -> Option<String> {
    let dir = parent_dir(bin_path);
    if dir.is_empty() {
        return None;
    }
    let dir = std::path::PathBuf::from(dir);
    for ext in ext_candidates {
        let candidate = dir.join(format!("{exe_basename}.{ext}"));
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// 返回 `<bin_path 同目录>/<exe>` 的绝对路径。bin_path 是命令行命中的入口
/// (如 `/opt/homebrew/bin/gemini`、`~/.volta/bin/codex`),`exe` 是与之共处一个
/// bin 目录的另一个可执行(`brew` / `volta` / `bun` / `npm`)——这些包管理器
/// 都把自己的 cli 跟它们安装的命令并列放在同一个 bin 目录,所以"同目录推导"
/// 是可靠的绝对路径来源。
///
/// **dir 为空(bin_path 不含 `/`) → 返回 None**:此时无法推导出绝对路径,让上游
/// `anchored_command_from_paths` 整体退化为 None,调用方落到静态命令兜底——而非
/// 悄悄拼出 `npm i -g <pkg>` 这种依赖 PATH 的指令,违背"必须绝对路径"不变量。
/// 实际从 `enumerate_tool_installations` 走的 bin_path 都是 `Path::display()` 出
/// 来的绝对路径,这条防线不期望被触发,但闭合了 helper 与函数文档的语义一致。
#[cfg(not(target_os = "windows"))]
pub(super) fn sibling_bin(bin_path: &str, exe: &str) -> Option<String> {
    let dir = parent_dir(bin_path);
    if dir.is_empty() {
        None
    } else {
        Some(format!("{dir}/{exe}"))
    }
}

/// Build an npm command anchored to the same Node installation as `bin_path`.
///
/// npm's POSIX launcher is normally a JavaScript file with an
/// `#!/usr/bin/env node` shebang. Calling npm by absolute path therefore does
/// not make it independent of PATH: `env` still needs to find `node`. GUI apps
/// commonly inherit only the system PATH, while nvm/fnm/mise keep Node in a
/// user directory. Prefixing npm's sibling directory makes both npm and its
/// transitive Node interpreter resolve to the installation we selected.
#[cfg(not(target_os = "windows"))]
pub(super) fn anchored_npm_command(bin_path: &str, args: &str) -> Option<String> {
    let dir = parent_dir(bin_path);
    if dir.is_empty() {
        return None;
    }
    let npm = sibling_bin(bin_path, "npm")?;
    Some(format!(
        "PATH={}:\"$PATH\" {} {args}",
        shell_single_quote(&dir),
        quote_path_if_spaced(&npm)
    ))
}

#[cfg(not(target_os = "windows"))]
pub(super) fn anchored_official_update_command(tool: &str, bin_path: &str) -> Option<String> {
    official_update_args(tool).map(|args| format!("{} {args}", quote_path_if_spaced(bin_path)))
}

#[cfg(target_os = "windows")]
pub(super) fn anchored_official_update_command(tool: &str, bin_path: &str) -> Option<String> {
    official_update_args(tool).map(|args| format!("{} {args}", win_quote_path_for_batch(bin_path)))
}

/// Grok Build 原生安装的升级命令 = `<bin 绝对> update || <官方 installer>`。
///
/// **为什么唯独 native Grok 的 self-update 需要 fallback**（claude native / hermes 都没有）：
/// `grok update` 虽然是自包含 Rust 二进制的子命令，**却把 npm 当成自己的分发管道**——
/// 先 spawn `npm view @xai-official/grok version --json` 查最新版，再 spawn
/// `npm i -g @xai-official/grok@<version>` 安装，由该包的 `postinstall.js` 从平台 optional
/// 依赖里解出二进制、安置成 `~/.grok/bin/grok-<version>` 并 relink `grok`。而 `npm` 自身是
/// `#!/usr/bin/env node` 脚本 → **native 安装也隐式硬依赖 PATH 里同时有 `npm` + `node`**。
/// GUI 进程 PATH 由 launchd 给、`run_tool_lifecycle_silently` 又是非登录 `bash -c`，
/// nvm/homebrew 下的 node+npm 均不可见 → grok 内部 spawn 得到 ENOENT，只向用户抛出
/// 费解的 `Error: No such file or directory (os error 2)`（实测复现）。
///
/// **这是上游换了机制**：0.2.111 及更早版本自更新是直接下载二进制到 `~/.grok/downloads/`
/// （彼时 `is_grok_native_install` 假设的 "native = 不碰 npm" 成立），0.2.112 起改走上述 npm
/// 管道（落点随之从 `downloads/` 变为 `bin/`）。**副作用**：npm 全局包那一处安装是
/// `grok update` 自己装出来的，非用户手动所为，故 native 用户也会被 enumerate 到两处；
/// 两处由同一次 postinstall 同步，版本恒等。
///
/// 这正是 `anchored_command_from_paths` 那条"绝对路径 + 必要时把解释器目录放 PATH 首位"
/// 不变量没覆盖的第三类：**执行体自身既不需要解释器、也已用绝对路径，却在内部再 spawn
/// 第三方 CLI**。`login_shell_path` 的 PATH 注入已让绝大多数机器上的 primary 直接成功；
/// 这条 fallback 覆盖的是"这台机器根本没装 node"——用官方 installer 装的用户完全可能如此。
///
/// **fallback 必须是官方 installer，不能是 `npm i -g`**：后者与 primary **同源**——primary
/// 失败的两种现实原因（本机无 node；npm registry 指向未同步该 tarball 的镜像，见
/// npmmirror dist-tag 事故）都会让 npm fallback 一并失败，`||` 形同虚设。官方 installer
/// 是唯一 node-free 的独立路径（只需 `curl`，在 `/usr/bin`，窄 PATH 下可用），且落点同为
/// `~/.grok/bin`，锚定语义分毫不动 —— 真正的降级冗余要求 fallback 与 primary **失败模式不相关**。
///
/// **这条 fallback 还兼具第三重作用：修复上游锚点（勿在重构时丢掉）**。
/// grok 的更新路径由 `~/.grok/config.toml` 的 `[cli] installer` 决定（`npm` / `internal` /
/// `gh-release`），而官方 install.sh 会**无条件把该字段覆写为 `internal`**（其 awk 段落先插入
/// `installer = "internal"`、再跳过 `[cli]` 段里已有的 `installer`/`channel` 行）。于是：
/// 用户一旦因 install 端的 npm fallback 被切进 npm 模式（postinstall.js 会写 `installer = "npm"`
/// 并在每次 npm 更新时重写，自我巩固），只要 npm 路径出任何问题，这里的 `||` 就会把他拉回
/// node-free 的 internal 模式，并顺带修好 npm 模式漏更新的 `~/.grok/bin/agent` launcher。
/// **实测验证**（2026-07-30，窄 PATH + `installer = "npm"`）：primary 抛 `os error 2` → fallback
/// 接管 → 装上最新版 → config 写回 `internal` → agent 对齐 → `.zshrc` 幂等更新不重复。
/// ⇒ install 端保留 npm fallback 是安全的（它是 x.ai 不可达时的唯一退路，防火墙场景需要），
/// 其副作用由本链自愈；**把这里换成 npm fallback 会同时废掉降级冗余和这条自愈路径**。
#[cfg(not(target_os = "windows"))]
pub(super) fn grok_native_update_command(update: String) -> String {
    chain_update_commands(
        update,
        GROK_INSTALL_UNIX.to_string(),
        LifecycleCommandShell::Posix,
    )
}

/// Windows 版同上，fallback 换成官方 PowerShell installer。
/// **不走 `chain_update_commands`**：它会给 `||` 右侧加 `call`，而这里的 fallback 是
/// `powershell.exe`（不是 `.cmd`/`.bat`），不需要 `call`——与 `hermes_update_windows_command`
/// 同一理由。
#[cfg(target_os = "windows")]
pub(super) fn grok_native_update_command(update: String) -> String {
    format!("{update} || {}", grok_install_windows_command())
}

/// 哪些工具的"官方 self-update"优先于包管理器升级（生成 `<tool> update || <pkg-mgr>`）。
///
/// **codex 刻意不在此列**：`codex update` 在 npm 安装上只是裸 `npm install -g
/// @openai/codex`（无 `@latest` / `--include=optional` / 不先卸载），却只检查 exit code、
/// 无条件打印 “Update ran successfully”。当 npm 把平台二进制 optional 依赖
/// `@openai/codex-<triple>` 漏装时它仍 **exit 0 假成功**，使外层 `||` 兜底被短路、损坏被
/// 成功 toast 掩盖（用户报告的 “Missing optional dependency” 即源于此）。因此 codex 一律走
/// npm 锚定升级；真正损坏（`runnable=false`）时由 `installs_anchored_command` 的门控改用
/// `codex_repair_command` 的 uninstall+install 自愈，而非交给 codex 自身的 self-update。
pub(super) fn prefers_official_update(tool: &str, shell: LifecycleCommandShell) -> bool {
    match shell {
        LifecycleCommandShell::Posix => {
            matches!(tool, "claude" | "opencode" | "openclaw")
        }
        LifecycleCommandShell::WindowsBatch => {
            matches!(
                tool,
                // OpenCode 的 Windows `upgrade` 在 anomalyco/opencode#17295 修复前可能因
                // 安装方式探测失败弹交互 prompt（spawn npm.cmd 没传 shell:true）；静默
                // lifecycle 没有 stdin 会挂死，Windows 先锚到包管理器路径，等上游修了
                // 再把 opencode 加回这里。
                "claude" | "openclaw"
            )
        }
    }
}

/// Codex 平台分发包损坏的自愈命令。Codex 的 npm 包是「主包 `@openai/codex`（纯 JS
/// launcher）+ 平台二进制 optional 依赖 `@openai/codex-<triple>`」的分发模式（同 esbuild/swc）。
/// 当平台二进制缺失时 codex 跑不起来——`enumerate_tool_installations` 跑 `--version` 会拿到
/// “Missing optional dependency” 的非 0 退出，标记 `runnable=false`。此状态下普通
/// `npm i -g @pkg@latest` 是 **no-op**：npm 视 optional 依赖缺失为非致命，reify 又认为主包已是
/// 最新（外加半损坏留下的空 nested `node_modules` 残骸强化「tree 已满足」判断），不会补回平台
/// 二进制。唯一实测可靠的修复是先 `uninstall` 清掉残骸、再 `install` 装回完整的主包 + 平台二进制
/// （实测输出 `added 2 packages`）。
///
/// 锚定到与 codex 入口同目录的 npm，并把该目录放到每条 npm 命令的 PATH 首位，使 npm
/// 的 `#!/usr/bin/env node` 能找到同一安装下的 node，不依赖 GUI 非登录进程的 PATH。
/// `|| true` 让 uninstall 失败（如 nvm 上对半损坏包静默返回非 0）不触发外层 `set -e`
/// 中止，但随后的 install 若失败仍会被 `set -e` 捕获并上报给前端 toast。
///
/// **仅对会锚定到 sibling npm 的 node 管理器来源（nvm/fnm/mise/homebrew npm）生效**：
/// `runnable=false` 是宽信号（权限 / node 版本 / 任意 `--version` 失败皆可触发），非 npm
/// 全局安装各有自己的二进制分发与修复方式，无脑套 npm uninstall+install 会出错——Homebrew
/// formula / cask（real 在 `Cellar/` 或 `Caskroom/`）本应 `brew upgrade`，npm 够不到它反而旁路装第二份 npm
/// 全局 codex；Volta/Bun 本应 `volta install`/`bun add`，且 `~/.bun/bin` 下没有 npm、
/// `sibling_bin` 会拼出不存在的路径；system/未知来源无可靠 sibling npm。这些来源一律返回
/// None，让上游继续走 source-specific 的 `anchored_command_from_paths`。白名单与
/// `package_manager_anchored_command_from_paths` 的 sibling-npm 分支对齐。
/// 刻意**不**额外用 `inst.error` 文本确认「确系缺二进制」：enumerate 只保留 stderr 末尾 4 行，
/// 而 codex.js 抛错的 "Missing optional dependency" 行会被尾部 node stack `at ...` 行挤出窗口
/// （实测用户原始错误即如此），强加该条件反而漏修真实缺包；对 npm 全局安装，uninstall+install
/// 对各类损坏都是合理且不会更糟的修复。
#[cfg(not(target_os = "windows"))]
pub(super) fn codex_repair_command(bin_path: &str, real: &str) -> Option<String> {
    // brew formula / cask（real 在 Cellar 或 Caskroom）→ 不归 npm 管，交回 anchored 走 brew upgrade。
    // 官方独立安装同理：`CODEX_INSTALL_DIR` 可以指到 Homebrew / nvm 的 bin 目录，入口来源
    // 会被判成 homebrew / nvm，但真身在 standalone 发布包里，交回 anchored 重跑 installer。
    if is_brew_managed_path(real) || codex_standalone_install(bin_path, real).is_some() {
        return None;
    }
    // 只认会落到 sibling npm 的 node 管理器来源；volta/bun/system/未知交回 anchored。
    if !matches!(
        infer_install_source(Path::new(bin_path)),
        "nvm" | "fnm" | "mise" | "homebrew"
    ) {
        return None;
    }
    let pkg = "@openai/codex";
    let uninstall = anchored_npm_command(bin_path, &format!("uninstall -g {pkg}"))?;
    let install = anchored_npm_command(bin_path, &format!("i -g {pkg}@latest"))?;
    Some(format!("{uninstall} || true; {install}"))
}

/// Windows 暂不做平台分发自愈：Windows 上 codex 的破坏模式不同（EPERM 文件锁 / 版本 bump
/// 残留，见 openai/codex#21872、#19824），且 `.bat` 链的错误处理与 POSIX `set -e` 语义不同，
/// 需要单独设计；先在本问题实际发生的 POSIX 平台落地。返回 None → 上游走正常锚定命令。
#[cfg(target_os = "windows")]
pub(super) fn codex_repair_command(_bin_path: &str, _real: &str) -> Option<String> {
    None
}

#[cfg(not(target_os = "windows"))]
pub(super) fn package_manager_anchored_command_from_paths(
    tool: &str,
    bin_path: &str,
    real_target: &str,
) -> Option<String> {
    // Cask 必须先于 formula：两者互斥（真身不会同时落在 Caskroom 和 Cellar），
    // 但先拦 cask 能避免未来路径里同时出现这两个段时误走 formula。
    if let Some(cask) = brew_cask_from_path(real_target) {
        let brew = sibling_bin(bin_path, "brew")?;
        return Some(format!(
            "{} upgrade --cask {cask}",
            quote_path_if_spaced(&brew)
        ));
    }
    if let Some(formula) = brew_formula_from_path(real_target) {
        let brew = sibling_bin(bin_path, "brew")?;
        return Some(format!("{} upgrade {formula}", quote_path_if_spaced(&brew)));
    }
    let pkg = npm_package_for(tool)?;
    match infer_install_source(Path::new(bin_path)) {
        "volta" => {
            let volta = sibling_bin(bin_path, "volta")?;
            return Some(format!("{} install {pkg}", quote_path_if_spaced(&volta)));
        }
        "bun" => {
            let bun = sibling_bin(bin_path, "bun")?;
            return Some(format!(
                "{} add -g {pkg}@latest",
                quote_path_if_spaced(&bun)
            ));
        }
        // 自带同级 npm 的 node 管理器：落到下面锚定到那处的 npm。
        "nvm" | "fnm" | "mise" | "homebrew" => {}
        // system / 未知来源通常没有同级 npm，不能拼 `<dir>/npm`。若工具有官方
        // self-update，上层会直接锚到 CLI 自身；否则返回 None 走静态兜底。
        _ => return None,
    }
    anchored_npm_command(
        bin_path,
        &format!("i -g {pkg}@latest{}", npm_install_extra_args(tool)),
    )
}

/// 给定工具、原始 bin 路径（命令行命中的入口）、canonicalize 后的真身路径，
/// 推断"写回同一处"的锚定升级命令。**POSIX 版是纯函数（不碰 FS）**——真实 canonicalize
/// 由调用方做（`installs_anchored_command` 复用 enumerate 时算出的 `inst.real`),
/// 便于单测覆盖各包管理器分支。Windows 版同名函数因 sibling 扩展名歧义必须读 fs,
/// 是刻意保留的平台差异(详见 Windows 版本 doc)。
///
/// **关键不变量：返回的命令必须用绝对路径调用执行体；若执行体通过
/// `#!/usr/bin/env` 查找解释器，还必须把其同级 bin 目录显式放到 PATH 首位**。
/// 这条命令最终在 `run_tool_lifecycle_silently` 的非登录 `bash -c` 里执行——
/// GUI App 启动的进程 PATH 由 launchd / Windows Service / systemd 给,通常**不含**
/// `~/.local/bin` / `/opt/homebrew/bin` / `~/.volta/bin` 等用户级 bin 目录;而探测
/// 阶段 `try_get_version` 用的是 `$SHELL -lic`(登录+交互式,会读 .zshrc/.zprofile),
/// 两者 PATH 不对称。裸 `claude update` / `brew upgrade ...` 在 GUI 进程里大概率
/// `command not found`(exit 127)→ `set -e` 中止 → 用户看到失败 toast,锚定决策却
/// 已展示给用户"将写回原生那处"——欺骗性故障。
///
/// 判定顺序（命中即返回）：
/// ① Hermes → `<bin_path 绝对> update`;Hermes CLI 自己知道安装环境,避免 cc-switch
///    猜系统 `python3`/`python` 时撞上 Python 版本或 pyenv shim 问题。
/// ② Claude / Grok 原生安装器 → `<bin_path 绝对> update`；
///    bin_path 指向 launcher,launcher 内部 dispatch update 子命令。它不归 npm 管,
///    且在 PATH 里比 nvm/homebrew 更靠前,用 npm 升级会装到别处且被原生那份遮蔽。
///    MiniMax Code 的脚本安装同理不归全局 npm 管,但 `mcode update` 非 TTY 下不安装
///    (见 `official_update_args` 上方注释),改为带 `MCODE_INSTALL_DIR` 重跑官方 installer。
///    Codex 独立安装器同理:`codex update` 断网时假成功(见 `CODEX_INSTALL_UNIX`),
///    改为带 `CODEX_INSTALL_DIR` / `CODEX_HOME` 重跑官方 installer。
/// ③ Homebrew formula / cask（真身在 `Cellar/<formula>/` 或 `Caskroom/<token>/`）
///    → `<bin_path 同目录>/brew upgrade [--cask] <name>`；由 Homebrew 拥有,避免
///    self-update 或 sibling npm 改动包管理器管理的安装。
/// ④ 其余支持官方自升级的工具 → `<bin_path 绝对> update/upgrade || <原锚定包管理器命令>`；
///    Codex 的 self-update 只在部分 release 可用,所以保留 npm/brew/bun/volta fallback。
/// ⑤ 不支持官方自升级的 npm 全局包(例如 Gemini CLI，以及非 native 的 Grok Build) → 锚定到
///    "那处 bin 目录的 npm"。
#[cfg(not(target_os = "windows"))]
pub(super) fn anchored_command_from_paths(
    tool: &str,
    bin_path: &str,
    real_target: &str,
) -> Option<String> {
    let real_lower = real_target.to_ascii_lowercase();

    if tool == "hermes" {
        return anchored_official_update_command(tool, bin_path);
    }
    if tool == "claude"
        && (real_lower.contains("/.local/share/claude/")
            || real_lower.contains("/claude/versions/"))
    {
        return anchored_official_update_command(tool, bin_path);
    }
    if tool == "grok" && is_grok_native_install(bin_path, real_target) {
        return Some(grok_native_update_command(
            anchored_official_update_command(tool, bin_path)?,
        ));
    }
    if tool == "mcode" {
        if let Some(root) = mcode_script_install_root(bin_path, real_target, McodeLayout::Posix) {
            return Some(mcode_installer_update_command(&root));
        }
    }
    if tool == "codex" {
        if let Some(install) = codex_standalone_install(bin_path, real_target) {
            return Some(codex_installer_update_command(&install));
        }
    }
    let package_command = package_manager_anchored_command_from_paths(tool, bin_path, real_target);
    if is_brew_managed_path(real_target) {
        return package_command;
    }
    if prefers_official_update(tool, LifecycleCommandShell::Posix) {
        let mut update = anchored_official_update_command(tool, bin_path)?;
        // npm-installed Claude delegates updates to npm. Keep the npm 12
        // postinstall and optional dependency settings scoped to this process
        // tree; other installation sources retain their own update policy.
        // Gate on the real target rather than the launcher's source so npm
        // prefixes classified as `system` (Intel Homebrew node, nodejs.org pkg,
        // ~/.npm-global, distro node) are covered too: they have no sibling-npm
        // fallback, so a false-success update there could never self-heal.
        if tool == "claude" && real_lower.contains("/node_modules/@anthropic-ai/claude-code/") {
            update = format!(
                "npm_config_allow_scripts={} npm_config_ignore_scripts=false npm_config_include=optional {update}",
                npm_package_for(tool)?
            );
        }
        return Some(match package_command {
            Some(fallback) => chain_update_commands(update, fallback, LifecycleCommandShell::Posix),
            None => update,
        });
    }
    package_command
}

#[cfg(target_os = "windows")]
pub(super) fn package_manager_anchored_command_from_paths(
    tool: &str,
    bin_path: &str,
) -> Option<String> {
    let pkg = npm_package_for(tool)?;

    match infer_install_source(Path::new(bin_path)) {
        "volta" => {
            let volta = sibling_bin_with_ext(bin_path, "volta", &["exe", "cmd"])?;
            Some(format!(
                "{} install {pkg}",
                win_quote_path_for_batch(&volta)
            ))
        }
        "pnpm" => {
            let pnpm = sibling_bin_with_ext(bin_path, "pnpm", &["cmd", "exe"])?;
            Some(format!(
                "{} add -g {pkg}@latest",
                win_quote_path_for_batch(&pnpm)
            ))
        }
        // 兜底 = npm 类:Scoop / Chocolatey / winget / nvm-windows / MS Store nodejs /
        // system / 任何识别不到专属来源的 → sibling npm.cmd。
        _ => {
            let npm = sibling_bin_with_ext(bin_path, "npm", &["cmd", "exe"])?;
            Some(format!(
                "{} i -g {pkg}@latest{}",
                win_quote_path_for_batch(&npm),
                npm_install_extra_args(tool)
            ))
        }
    }
}

/// Windows 版锚定命令生成。对平台确认可静默运行的工具优先使用官方 CLI 自升级；
/// 对 npm/Volta/pnpm 这类可确认写回位置的安装，再接一个包管理器 fallback。不存在 brew/bun/claude-native
/// (Windows 没 Homebrew、Bun for Windows 仍 preview；Grok native 使用 PowerShell installer)。
/// Scoop/Chocolatey/winget/nvm-windows/MS Store node 都归 npm 类——它们都只是"如何装
/// node"的不同入口,全局包真正的 idiom 仍是 sibling `npm.cmd`。
///
/// **与 POSIX 版的语义差异**:POSIX 版是纯函数(不碰 fs),Windows 版通过
/// `sibling_bin_with_ext` 读 fs 来探明扩展名(`.cmd` vs `.exe`)——Node installer
/// 装 `.cmd`、Volta 装 `.exe`,纯字符串拼接无法消歧。这一平台差异**被刻意保留**:
/// 测试用 tempdir 隔离 fs,生产侧 TOCTOU 是 by design(见 `sibling_bin_with_ext` doc)。
///
/// `real_target` 维持与 POSIX 版的签名对称，并辅助识别 Grok native。若未来加 Scoop
/// persist 锚定(scoop 装的工具真身在 `<scoop_root>/persist/<app>/...`),也从这里取真身。
///
/// **关键不变量同 POSIX 版:返回的命令必须用绝对路径,不依赖 PATH**。Windows GUI
/// 进程 PATH 由 Service Control Manager / explorer.exe 给,通常不含用户 `%LOCALAPPDATA%`
/// 下的 Volta/pnpm 路径;`$SHELL -lic` 的探测时 PATH 与执行时 PATH 不对称。
///
/// 判定顺序(命中即返回):
/// ① hermes / Grok native → `<bin_path> update`;CLI 自己处理安装环境。
///    MiniMax Code 脚本安装 → 带 `MCODE_INSTALL_DIR` 重跑官方 PowerShell installer。
///    Codex 独立安装 → 带 `CODEX_INSTALL_DIR` / `CODEX_HOME` 重跑官方 PowerShell installer。
/// ② 支持官方自升级且 Windows 可安全静默执行的工具 → `<bin_path> update/upgrade || call <包管理器 fallback>`。
/// ③ 其余 npm 工具 → sibling `npm.cmd`/`.exe` i -g <pkg>@latest。
///
/// 包管理器 fallback 的 sibling 探测都通过 `sibling_bin_with_ext`(碰 fs):该处无候选
/// 扩展名存在时,支持官方自升级的工具仍返回 `<bin_path> update/upgrade`,其余工具
/// 才返 None 让上游兜回静态命令、`anchored=false`。
#[cfg(target_os = "windows")]
pub(super) fn anchored_command_from_paths(
    tool: &str,
    bin_path: &str,
    real_target: &str,
) -> Option<String> {
    if tool == "hermes" {
        return anchored_official_update_command(tool, bin_path);
    }
    if tool == "grok" && is_grok_native_install(bin_path, real_target) {
        return Some(grok_native_update_command(
            anchored_official_update_command(tool, bin_path)?,
        ));
    }
    if tool == "mcode" {
        if let Some(root) = mcode_script_install_root(bin_path, real_target, McodeLayout::Windows) {
            return Some(mcode_installer_update_command(&root));
        }
    }
    if tool == "codex" {
        if let Some(install) = codex_standalone_install(bin_path, real_target) {
            return Some(codex_installer_update_command(&install));
        }
    }
    let package_command = package_manager_anchored_command_from_paths(tool, bin_path);
    if prefers_official_update(tool, LifecycleCommandShell::WindowsBatch) {
        let update = anchored_official_update_command(tool, bin_path)?;
        return Some(match package_command {
            Some(fallback) => {
                chain_update_commands(update, fallback, LifecycleCommandShell::WindowsBatch)
            }
            None => update,
        });
    }
    package_command
}

/// 基于已枚举的安装列表生成锚定升级命令（复用 enumerate 结果，避免二次探测）。
/// 读取 enumerate 时已 canonicalize 写入的 `inst.real`,**不再二次 canonicalize**——
/// 既消除冗余 syscall,也闭合"enumerate 与 anchor 看到同一真身"的一致性边界
/// (两次 canonicalize 之间 symlink 被换会让锚定指向不同真身)。
///
/// 全平台共用——`anchored_command_from_paths` 自身是 cfg 二选一(POSIX 五分支 /
/// Windows 三分支),这里只负责取默认那处 + 转发。
pub(super) fn installs_anchored_command(
    tool: &str,
    installs: &[ToolInstallation],
) -> Option<String> {
    let inst = default_install(installs)?;
    let real = inst.real.to_string_lossy();
    // Codex 平台分发包损坏自愈：主包在但平台二进制缺失时 codex 跑不起来
    // （runnable=false），此时正常锚定的 `npm i -g @latest` 是 no-op 修不好——改用
    // uninstall+install 重装补回平台二进制。**但仅限会锚定到 sibling npm 的 node 管理器
    // 来源**（codex_repair_command 内按 source/real 收窄，brew/volta/bun/system 交回下方
    // source-specific 锚定，避免误用 npm 重装）。runnable=true 的正常升级也走下方普通锚定
    // 路径（且因 codex 不在 prefers_official_update，不会再跑会假成功掩盖损坏的 `codex update`）。
    if tool == "codex" && !inst.runnable {
        if let Some(cmd) = codex_repair_command(&inst.path, &real) {
            return Some(cmd);
        }
    }
    // MiniMax Code 脚本安装按回执认领（读 fs，故不放进纯函数 `anchored_command_from_paths`）。
    // 否则自定义 `MCODE_INSTALL_DIR` 会退到全局 `npm i -g`：单处安装不弹确认，静默升级了
    // 别处，命令行实际用的那处版本不变。
    if tool == "mcode" {
        if let Some(root) = [inst.path.as_str(), real.as_ref()]
            .into_iter()
            .find_map(|entry| mcode_receipt_install_root(entry, McodeLayout::NATIVE))
        {
            return Some(mcode_installer_update_command(&root));
        }
    }
    anchored_command_from_paths(tool, &inst.path, &real)
}

/// 静态命令（= 平台可安全静默执行的官方 CLI 自升级 || `npm i -g <pkg>@latest` /
/// 官方 installer）。锚定探不到默认安装时回退到它；npm fallback 仍等同于
/// "装到 PATH 第一个 npm"的旧行为。
pub(super) fn static_fallback_command_for(tool: &str, action: ToolLifecycleAction) -> String {
    tool_action_shell_command(tool, action).unwrap_or_default()
}

pub(super) fn static_fallback_command(tool: &str) -> String {
    static_fallback_command_for(tool, ToolLifecycleAction::Update)
}

/// 升级命令的解析结果。plan（前端确认 / 展示）与 execute（真正执行）共用
/// `resolve_update_command`，保证两边判定一致。
#[derive(Debug, PartialEq, Eq)]
pub(super) enum UpdateCommand {
    /// 锚定到命令行实际命中的那处。
    Anchored(String),
    /// 定位不到默认那处，或那处认不出渠道但可能归 npm 管（asdf/nodenv shim 等脚本）
    /// → 静态命令，保持旧行为。
    Static(String),
    /// 默认那处是原生可执行文件且不在 `node_modules` 里：不归 npm 管，也认不出是哪个
    /// 安装器装的（winget、Scoop、Nix、手动下载的二进制……）。退回裸 `npm i -g` 只会
    /// 另装一份 npm 版——要么被原生那份遮蔽、版本号不动，要么反过来顶替它（#7650），
    /// 所以不执行，由前端提示用户用原来的安装方式升级。
    Unmanaged,
}

pub(super) fn resolve_update_command(tool: &str, installs: &[ToolInstallation]) -> UpdateCommand {
    if let Some(command) = installs_anchored_command(tool, installs) {
        return UpdateCommand::Anchored(command);
    }
    if default_install(installs).is_some_and(is_unmanaged_native_install) {
        return UpdateCommand::Unmanaged;
    }
    UpdateCommand::Static(static_fallback_command(tool))
}

/// 只认「原生可执行文件 + 真身不在 `node_modules` 里」。npm 全局包的真身都在
/// `node_modules/<pkg>/` 下（多为 JS 入口，个别包把原生二进制放在包内）；asdf / nodenv
/// 的 shim、Windows npm 的 `.cmd` 是文本脚本，都不算——它们背后可能正是 npm 全局包，
/// 拒绝会误伤，保持旧的静态命令。
pub(super) fn is_unmanaged_native_install(inst: &ToolInstallation) -> bool {
    let real = inst
        .real
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    !real.contains("/node_modules/") && is_native_executable(&inst.real)
}

/// 按文件头识别原生可执行文件：ELF、Mach-O（单架构 / universal）、Windows PE。
pub(super) fn is_native_executable(path: &Path) -> bool {
    use std::io::Read;

    let mut magic = [0u8; 4];
    let read = std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut magic));
    if read.is_err() {
        return false;
    }
    matches!(
        magic,
        [0x7f, b'E', b'L', b'F']
            | [0xcf, 0xfa, 0xed, 0xfe]
            | [0xce, 0xfa, 0xed, 0xfe]
            | [0xfe, 0xed, 0xfa, 0xcf]
            | [0xfe, 0xed, 0xfa, 0xce]
            | [0xca, 0xfe, 0xba, 0xbe]
    ) || magic.starts_with(b"MZ")
}

/// 执行路径的兜底报错。正常流程里前端已按 probe 的 `unmanaged` 跳过该工具并给出
/// 本地化提示；只有 probe 失败、前端直接执行时才会走到这里。
pub(super) fn unmanaged_update_error(tool: &str, installs: &[ToolInstallation]) -> String {
    let path = default_install(installs)
        .map(|inst| inst.path.as_str())
        .unwrap_or_default();
    format!(
        "{} at {path} was not installed by npm or a recognized installer; update it the way it was installed",
        tool_display_name(tool)
    )
}

/// 新装(install)的命令:对有官方 installer 的工具走「上游推荐 || npm 兜底」短路链,
/// 其余工具透传到 install 静态命令。update fallback 会在平台可安全静默执行时
/// 优先跑官方 CLI 自升级,但 install 端不能先跑 `tool update`,
/// 否则“未安装时安装”的路径会多一次无效失败。
///
/// 设计理由:
/// - install 没有锚点可言(从无到有),但**有"上游推荐方式"这一事实** ——
///   Anthropic、xAI 和 SST(OpenCode)都已将自家 native installer 列为首推、把 npm 列为替代方式。
///   把这层认知补进来,让 install 表与 update 端的锚定决策树共用同一份"上游事实"。
/// - Hermes 使用官方 installer,避免用系统 Python/pip 安装时踩 Python >=3.11 与 pyenv
///   `python` shim 问题;更新路径若能锚定已安装 CLI,则走 `<hermes> update`。
///   **Hermes 没有 npm 包,install 端不享受 `||` 降级**——上游 installer 不可达就只能等。
/// - 对**有 npm 包**的工具(claude/grok/opencode/mcode),短路链(POSIX `||`)保证官方脚本不可达/
///   防火墙拦截时仍能装上,降级到裸 `npm i -g`。官方脚本本身不用 pipe,
///   所以这条路径在 WSL 的 `sh -c` 子 shell 中也不依赖外层 `pipefail`。
/// - Windows 上 Claude/OpenCode 原生不启用（对应 installer 都是 bash 脚本）；Grok
///   与 MiniMax Code 使用官方 PowerShell installer，并同样保留 npm fallback。WSL 作为 Linux 环境
///   复用这套 POSIX 安装优先级。
pub(super) fn installer_with_npm_fallback(installer: &str, tool: &str) -> String {
    match npm_install_command_for(tool) {
        Some(npm) => chain_update_commands(
            installer.to_string(),
            npm.to_string(),
            LifecycleCommandShell::Posix,
        ),
        None => installer.to_string(),
    }
}

pub(super) fn posix_install_command_for(tool: &str) -> String {
    match tool {
        "claude" => installer_with_npm_fallback(CLAUDE_INSTALL_UNIX, tool),
        // Grok 的 npm fallback **会切换用户的分发模式**（该包 postinstall 把
        // `~/.grok/config.toml` 的 `[cli] installer` 写成 `npm`，此后 `grok update` 一律走
        // npm、隐式依赖 node）。仍然保留它：官方 installer 不可达（防火墙 / x.ai 被拦）时
        // 这是唯一退路，而副作用可自愈——`grok_native_update_command` 的 `||` 官方 installer
        // 会在 npm 路径出问题时把 `installer` 覆写回 `internal`（见该函数 doc 的实测记录）。
        "grok" => installer_with_npm_fallback(GROK_INSTALL_UNIX, tool),
        "opencode" => installer_with_npm_fallback(OPENCODE_INSTALL_UNIX, tool),
        "mcode" => installer_with_npm_fallback(MCODE_INSTALL_UNIX, tool),
        "hermes" => HERMES_INSTALL_UNIX.to_string(),
        _ => static_fallback_command_for(tool, ToolLifecycleAction::Install),
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn install_command_for(tool: &str) -> String {
    posix_install_command_for(tool)
}

/// 计算某工具的升级命令与"是否需确认"。全平台共用一份:
/// - **Windows + WSL 工具**(override 是 `\\wsl$\<distro>\...` UNC 路径)的升级规划
///   始终走 POSIX 静态命令、不锚定:锚定命令是 Windows 主机绝对路径,跨 `wsl.exe`
///   边界进入 distro 文件系统后完全无效;且 `enumerate_tool_installations` 不参与
///   WSL 文件系统、锚定无锚点。这一类显式短路到 `(unix_static, false, false)`,
///   前端不会弹确认。
///   **必须用 `wsl_tool_action_shell_command`(unix 版)而非 `static_fallback_command`**
///   ——后者读 `tool_action_shell_command`,Windows target 给 hermes 返回 PowerShell
///   installer,跨 wsl.exe 后不适用;`build_tool_action_line` 的 WSL 分支也用同一 wrapper,
///   保证 plan 展示给前端的命令与实际执行落 .bat 的命令一致。
/// - 其他平台与 Windows 原生工具走 `resolve_update_command`:命中 → 锚定;
///   None(无默认 / sibling 不存在等)→ 静态兜底、`anchored=false`,
///   前端据此给"默认入口无法确定"诚实文案;默认那处是认不出渠道的原生可执行文件
///   → `Unmanaged`,前端跳过并提示用原安装方式升级。
pub(super) fn plan_command_for(tool: &str, installs: &[ToolInstallation]) -> (UpdateCommand, bool) {
    #[cfg(target_os = "windows")]
    {
        if wsl_distro_for_tool(tool).is_some() {
            let cmd = wsl_tool_action_shell_command(tool, ToolLifecycleAction::Update)
                .unwrap_or_default();
            return (UpdateCommand::Static(cmd), false);
        }
    }
    (resolve_update_command(tool, installs), installs.len() >= 2)
}
