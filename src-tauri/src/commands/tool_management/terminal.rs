//! Provider terminal launchers and platform-specific shell argument handling.

#[cfg(target_os = "windows")]
use super::paths::windows_shell_compatible_path;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use super::process::decode_command_output;
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;
use crate::app_config::AppType;
use crate::services::ProviderService;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;
use std::str::FromStr;
use tauri::State;

/// Windows 双引号包裹基础原语:无条件加引号 + 内部 `"` 转义为 `\"`。
/// `windows_cmd_double_quote_arg`(给 wsl.exe 传 bash 命令字符串用)与
/// `win_quote_path_for_batch`(给锚定路径用)都基于它,避免两份 quoter 各自演化、
/// 未来对同一路径产生不一致引用形态。镜像 POSIX 侧 `shell_single_quote` 与
/// `quote_path_if_spaced` 的"重量基础 + 轻量条件包装"两层结构。
#[cfg(target_os = "windows")]
pub(super) fn win_double_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

#[cfg(target_os = "windows")]
pub(super) fn windows_cmd_double_quote_arg(value: &str) -> String {
    win_double_quote(value)
}

/// 校验 WSL 发行版名称是否合法
/// WSL 发行版名称只允许字母、数字、连字符和下划线
#[cfg(target_os = "windows")]
pub(super) fn is_valid_wsl_distro_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Validate that the given shell name is one of the allowed shells.
pub(super) fn is_valid_shell(shell: &str) -> bool {
    matches!(
        shell.rsplit('/').next().unwrap_or(shell),
        "sh" | "bash" | "zsh" | "fish" | "dash"
    )
}

/// Validate that the given shell flag is one of the allowed flags.
#[cfg(target_os = "windows")]
pub(super) fn is_valid_shell_flag(flag: &str) -> bool {
    matches!(flag, "-c" | "-lc" | "-lic")
}

/// Return the default invocation flag for the given shell.
pub(super) fn default_flag_for_shell(shell: &str) -> &'static str {
    match shell.rsplit('/').next().unwrap_or(shell) {
        "dash" | "sh" => "-c",
        "fish" => "-lc",
        _ => "-lic",
    }
}

// 以下 shell 解析辅助函数仅被 macOS/Linux 的终端启动逻辑使用；Windows 非 test 编译下为死代码。
#[cfg_attr(windows, allow(dead_code))]
pub(super) fn fallback_user_shell() -> &'static str {
    if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    }
}

#[cfg_attr(windows, allow(dead_code))]
pub(super) fn valid_user_shell_path(shell: &str) -> bool {
    if shell.is_empty()
        || !shell.starts_with('/')
        || !is_valid_shell(shell)
        || shell.chars().any(char::is_control)
    {
        return false;
    }

    let path = std::path::Path::new(shell);
    path.is_file() && is_executable_file(path)
}

#[cfg(unix)]
pub(super) fn is_executable_file(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
#[cfg_attr(windows, allow(dead_code))]
pub(super) fn is_executable_file(path: &std::path::Path) -> bool {
    path.is_file()
}

/// 获取用户默认 shell 的完整路径；异常或被污染的 SHELL 回退到平台默认值。
#[cfg_attr(windows, allow(dead_code))]
pub(super) fn get_user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|shell| valid_user_shell_path(shell))
        .unwrap_or_else(|| fallback_user_shell().to_string())
}

/// 构建 exec 行：引号保护 shell 路径，交还用户 shell 让其按默认规则加载 rc 配置。
#[cfg_attr(windows, allow(dead_code))]
pub(super) fn build_exec_line(shell: &str, cwd: Option<&Path>) -> String {
    let quoted_shell = shell_single_quote(shell);

    match shell.rsplit('/').next().unwrap_or(shell) {
        "zsh" => cwd
            .map(|dir| {
                let command = format!(
                    "cd {} || exit 1; exec {} -i",
                    shell_single_quote(&dir.to_string_lossy()),
                    quoted_shell
                );
                format!("exec {} -lc {}", quoted_shell, shell_single_quote(&command))
            })
            .unwrap_or_else(|| format!("exec {quoted_shell} -l")),
        _ => format!("exec {quoted_shell}"),
    }
}

/// 构建 provider 命令行：通过用户 shell 的交互模式执行，确保 GUI 启动的终端也加载用户 PATH。
#[cfg_attr(windows, allow(dead_code))]
pub(super) fn build_provider_command_line(
    shell: &str,
    config_path: &str,
    cwd: Option<&Path>,
) -> String {
    let claude_command = format!("claude --settings {}", shell_single_quote(config_path));
    let command = cwd
        .map(|dir| {
            format!(
                "cd {} && {}",
                shell_single_quote(&dir.to_string_lossy()),
                claude_command
            )
        })
        .unwrap_or(claude_command);

    format!(
        "{} {} {}",
        shell_single_quote(shell),
        provider_command_flag_for_shell(shell),
        shell_single_quote(&command)
    )
}

#[cfg_attr(windows, allow(dead_code))]
pub(super) fn provider_command_flag_for_shell(shell: &str) -> &'static str {
    match shell.rsplit('/').next().unwrap_or(shell) {
        "dash" | "sh" => "-c",
        "zsh" => "-lic",
        _ => "-ic",
    }
}

#[cfg_attr(windows, allow(dead_code))]
pub(super) fn build_final_shell_cd_command(shell: &str, cwd: Option<&Path>) -> String {
    if matches!(shell.rsplit('/').next().unwrap_or(shell), "zsh") {
        return String::new();
    }

    cwd.map(|dir| {
        format!(
            "cd {} || exit 1\n",
            shell_single_quote(&dir.to_string_lossy())
        )
    })
    .unwrap_or_default()
}

/// 含空格才用 POSIX 单引号包一层,否则保持裸路径——命令展示更干净。
/// claude / brew / volta / bun / npm 五个锚定分支共用,避免"含空格"判定漂移。
///
/// **仅按空格判定,不防其他 shell 元字符**(`$` / `` ` `` / `'` / `"` / `;` 等)。
/// 调用方传入的是探测得到的可执行路径(`enumerate_tool_installations` 里来源于
/// `Path::display()`),实际 macOS/Linux 上 home dir 名几乎不允许这类字符、
/// npm/brew/volta/bun 也不会装到含这类字符的路径,与 diff 前内联在 npm 分支里的
/// `if npm.contains(' ')` 实现等价。若未来要扩广,改成 `shell_single_quote` 无条件
/// 包裹即可,但会失去"无空格时的清洁展示"。
#[cfg(not(target_os = "windows"))]
pub(super) fn quote_path_if_spaced(p: &str) -> String {
    if p.contains(' ') {
        shell_single_quote(p)
    } else {
        p.to_string()
    }
}

/// 锚定路径走 `.bat` 文件且**被 `call` 调用**,需要为 batch 特殊字符做两层防御:
///
/// **(1) `%` 经历两轮 percent expansion → 用 4 个 `%` 转义**。.bat 中字面 `%` 的
/// 标准转义是 `%%`,但 `call` 命令(Microsoft `call /?`:"percent (%) expansion is
/// performed on each parameter")**在 batch parser 处理完 `%%` → `%` 后自己再做一轮**。
/// 所以源 .bat 里写 `%%FOO%%`,batch 一轮变 `%FOO%`,call 二轮当成 variable reference
/// 又展开一次——要让最终 call 看到字面 `%FOO%` 必须写 `%%%%FOO%%%%`(一轮 → `%%FOO%%`,
/// 二轮 → `%FOO%` 字面)。这是 cmd 唯一**引号无法保护**的字符:引号内的 `%` 仍参与
/// 两轮 expansion。
///
/// **(2) token 边界 / escape 字符触发外层双引号**:`' '` `'&'` `'('` `')'` `'^'`
/// `';'` `'<'` `'>'` `'|'` `','` 任一出现即包引号。NTFS 允许这些字符出现在路径中,
/// 不包会让 cmd 把路径切成多 token、`^` 又会触发 escape;引号内它们是字面意义,
/// 而且 call 二次解析对引号内的它们也不会做特殊处理(`^` 在引号内失去 escape 作用,
/// token 边界字符在引号内是字面)。
///
/// `!`(delayed expansion)只在 `setlocal enabledelayedexpansion` 下生效——我们
/// .bat 头只有 `chcp 65001` 和 `@echo off`、没开,所以不需要处理。`'` 在 cmd 中无特殊意义。
///
/// 镜像 POSIX `quote_path_if_spaced` 的"轻量条件包装"语义:不含任何特殊字符就保持
/// 裸路径(命令展示更干净),否则用 `win_double_quote` 包并做必要转义。
#[cfg(target_os = "windows")]
pub(super) fn win_quote_path_for_batch(p: &str) -> String {
    // `%` 经历两轮 expansion:.bat parser 一轮 + `call` 二轮(Microsoft `call /?`:
    // "percent (%) expansion is performed on each parameter")。要让 call 最终看到
    // 字面 `%` 需要 4 个 → `%%%%`(batch 一轮 → `%%`,call 二轮 → `%` 字面)。
    // 引号内仍参与两轮 expansion,所以这一步独立于外层引号、必须无条件做。
    let escaped = if p.contains('%') {
        p.replace('%', "%%%%")
    } else {
        p.to_string()
    };
    // 注:`needs_quote` 基于**原路径** `p` 判断,不能用 `escaped`——后者引入的 `%`
    // 字符不算"特殊触发字符",否则含 `%` 的路径会被错误地额外加引号。
    let needs_quote = p
        .chars()
        .any(|c| matches!(c, ' ' | '&' | '(' | ')' | '^' | ';' | '<' | '>' | '|' | ','));
    if needs_quote {
        win_double_quote(&escaped)
    } else {
        escaped
    }
}

/// 打开指定提供商的终端
///
/// 根据提供商配置的环境变量启动一个带有该提供商特定设置的终端
/// 无需检查是否为当前激活的提供商，任何提供商都可以打开终端
#[allow(non_snake_case)]
#[tauri::command]
pub async fn open_provider_terminal(
    state: State<'_, crate::store::AppState>,
    app: String,
    #[allow(non_snake_case)] providerId: String,
    cwd: Option<String>,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let launch_cwd = resolve_launch_cwd(cwd)?;

    // 获取提供商配置
    let providers = ProviderService::list(state.inner(), app_type.clone())
        .map_err(|e| format!("获取提供商列表失败: {e}"))?;

    let provider = providers
        .get(&providerId)
        .ok_or_else(|| format!("提供商 {providerId} 不存在"))?;

    // 从提供商配置中提取环境变量
    let config = &provider.settings_config;
    let env_vars = extract_env_vars_from_config(config, &app_type);

    // 根据平台启动终端，传入提供商ID用于生成唯一的配置文件名
    launch_terminal_with_env(env_vars, &providerId, launch_cwd.as_deref())
        .map_err(|e| format!("启动终端失败: {e}"))?;

    Ok(true)
}

/// 从提供商配置中提取环境变量
pub(super) fn extract_env_vars_from_config(
    config: &serde_json::Value,
    app_type: &AppType,
) -> Vec<(String, String)> {
    let mut env_vars = Vec::new();

    let Some(obj) = config.as_object() else {
        return env_vars;
    };

    // 处理 env 字段（Claude/Gemini 通用）
    if let Some(env) = obj.get("env").and_then(|v| v.as_object()) {
        for (key, value) in env {
            if let Some(str_val) = value.as_str() {
                env_vars.push((key.clone(), str_val.to_string()));
            }
        }

        // 处理 base_url: 根据应用类型添加对应的环境变量
        let base_url_key = match app_type {
            AppType::Claude | AppType::ClaudeDesktop => Some("ANTHROPIC_BASE_URL"),
            AppType::Gemini => Some("GOOGLE_GEMINI_BASE_URL"),
            _ => None,
        };

        if let Some(key) = base_url_key {
            if let Some(url_str) = env.get(key).and_then(|v| v.as_str()) {
                env_vars.push((key.to_string(), url_str.to_string()));
            }
        }
    }

    // Codex 使用 auth 字段转换为 OPENAI_API_KEY
    if *app_type == AppType::Codex {
        if let Some(auth) = obj.get("auth").and_then(|v| v.as_str()) {
            env_vars.push(("OPENAI_API_KEY".to_string(), auth.to_string()));
        }
    }

    // Gemini 使用 api_key 字段转换为 GEMINI_API_KEY
    if *app_type == AppType::Gemini {
        if let Some(api_key) = obj.get("api_key").and_then(|v| v.as_str()) {
            env_vars.push(("GEMINI_API_KEY".to_string(), api_key.to_string()));
        }
    }

    env_vars
}

pub(super) fn resolve_launch_cwd(cwd: Option<String>) -> Result<Option<PathBuf>, String> {
    let Some(raw_path) = cwd.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };

    if raw_path.contains('\n') || raw_path.contains('\r') {
        return Err("目录路径包含非法换行符".to_string());
    }

    let path = Path::new(&raw_path);
    if !path.exists() {
        return Err(format!("目录不存在: {raw_path}"));
    }

    let resolved = std::fs::canonicalize(path).map_err(|e| format!("解析目录失败: {e}"))?;
    if !resolved.is_dir() {
        return Err(format!("选择的路径不是文件夹: {}", resolved.display()));
    }

    #[cfg(target_os = "windows")]
    let resolved = windows_shell_compatible_path(&resolved);

    Ok(Some(resolved))
}

/// 创建临时配置文件并启动 claude 终端
/// 使用 --settings 参数传入提供商特定的 API 配置
pub(super) fn launch_terminal_with_env(
    env_vars: Vec<(String, String)>,
    provider_id: &str,
    cwd: Option<&Path>,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let config_file = temp_dir.join(format!(
        "claude_{}_{}.json",
        provider_id,
        std::process::id()
    ));

    // 创建并写入配置文件
    write_claude_config(&config_file, &env_vars)?;

    #[cfg(target_os = "macos")]
    {
        launch_macos_terminal(&config_file, cwd)?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        launch_linux_terminal(&config_file, cwd)?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        launch_windows_terminal(&temp_dir, &config_file, cwd)?;
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    Err("不支持的操作系统".to_string())
}

/// 写入 claude 配置文件
pub(super) fn write_claude_config(
    config_file: &std::path::Path,
    env_vars: &[(String, String)],
) -> Result<(), String> {
    let mut config_obj = serde_json::Map::new();
    let mut env_obj = serde_json::Map::new();

    for (key, value) in env_vars {
        env_obj.insert(key.clone(), serde_json::Value::String(value.clone()));
    }

    config_obj.insert("env".to_string(), serde_json::Value::Object(env_obj));

    let config_json =
        serde_json::to_string_pretty(&config_obj).map_err(|e| format!("序列化配置失败: {e}"))?;

    std::fs::write(config_file, config_json).map_err(|e| format!("写入配置文件失败: {e}"))
}

/// macOS: 根据用户首选终端启动
#[cfg(target_os = "macos")]
pub(super) fn launch_macos_terminal(
    config_file: &std::path::Path,
    cwd: Option<&Path>,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let preferred = crate::settings::get_preferred_terminal();
    let terminal = preferred.as_deref().unwrap_or("terminal");

    let shell = get_user_shell();
    let exec_line = build_exec_line(&shell, cwd);
    let final_cd_command = build_final_shell_cd_command(&shell, cwd);

    let temp_dir = std::env::temp_dir();
    let script_file = temp_dir.join(format!("lolicode_launcher_{}.sh", std::process::id()));
    let config_path = config_file.to_string_lossy();
    let provider_command = build_provider_command_line(&shell, &config_path, cwd);

    // Write the shell script to a temp file
    // 脚本使用 POSIX sh 语法确保可移植性，exec 行切换到用户交互式 shell
    let script_content = format!(
        r#"#!/usr/bin/env sh
trap 'rm -f "{config_path}" "{script_file}"' EXIT
echo "Using provider-specific claude config:"
echo "{config_path}"
{provider_command}
{final_cd_command}
{exec_line}
"#,
        config_path = config_path,
        script_file = script_file.display(),
        provider_command = provider_command,
        final_cd_command = final_cd_command,
        exec_line = exec_line,
    );

    std::fs::write(&script_file, &script_content).map_err(|e| format!("写入启动脚本失败: {e}"))?;

    // Make script executable
    std::fs::set_permissions(&script_file, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("设置脚本权限失败: {e}"))?;

    // Try the preferred terminal first, fall back to Terminal.app if it fails
    // Note: Kitty doesn't need the -e flag, others do
    let result = match terminal {
        "iterm2" => launch_macos_iterm2(&script_file),
        "warp" => launch_macos_warp(&script_file),
        "alacritty" => launch_macos_open_app("Alacritty", &script_file, true),
        "kitty" => launch_macos_open_app("kitty", &script_file, false),
        "ghostty" => launch_macos_ghostty(&script_file),
        "otty" => launch_macos_otty(&script_file),
        "wezterm" => launch_macos_open_app("WezTerm", &script_file, true),
        "kaku" => launch_macos_open_app("Kaku", &script_file, true),
        _ => launch_macos_terminal_app(&script_file),
    };

    // If preferred terminal fails and it's not the default, try Terminal.app as fallback
    if result.is_err() && terminal != "terminal" {
        log::warn!(
            "首选终端 {} 启动失败，回退到 Terminal.app: {:?}",
            terminal,
            result.as_ref().err()
        );
        return launch_macos_terminal_app(&script_file);
    }

    result
}

/// Escape a value as an AppleScript string literal.
#[cfg(target_os = "macos")]
pub(super) fn applescript_string_literal(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Build the launcher command literal used by AppleScript.
#[cfg(target_os = "macos")]
pub(super) fn applescript_launcher_command(script_file: &std::path::Path) -> String {
    applescript_string_literal(&format!(
        "sh {}",
        shell_single_quote(&script_file.to_string_lossy())
    ))
}

/// Build a launcher command that replaces the terminal-created shell session.
#[cfg(target_os = "macos")]
pub(super) fn applescript_exec_launcher_command(script_file: &std::path::Path) -> String {
    applescript_string_literal(&format!(
        "exec sh {}",
        shell_single_quote(&script_file.to_string_lossy())
    ))
}

/// macOS: Terminal.app AppleScript.
/// A cold `activate` creates a default empty window before `do script` opens the command session.
/// Use `launch` for cold starts so `do script` can create the only new session without reusing restored windows.
#[cfg(target_os = "macos")]
pub(super) fn build_macos_terminal_applescript(script_file: &std::path::Path) -> String {
    format!(
        r#"set launcher_script to {launcher}
set was_running to application "Terminal" is running
tell application "Terminal"
    if was_running then
        activate
        do script launcher_script
    else
        launch
        do script launcher_script
        activate
    end if
end tell"#,
        launcher = applescript_exec_launcher_command(script_file)
    )
}

/// Run AppleScript through `osascript -e` with shared error handling.
#[cfg(target_os = "macos")]
pub(super) fn run_terminal_osascript(
    applescript: &str,
    terminal_label: &str,
) -> Result<(), String> {
    use std::process::Command;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(applescript)
        .output()
        .map_err(|e| format!("执行 osascript 失败: {e}"))?;

    if !output.status.success() {
        let stderr = decode_command_output(&output.stderr);
        return Err(format!(
            "{terminal_label} 执行失败 (exit code: {:?}): {}",
            output.status.code(),
            stderr
        ));
    }

    Ok(())
}

/// macOS: Terminal.app
#[cfg(target_os = "macos")]
pub(super) fn launch_macos_terminal_app(script_file: &std::path::Path) -> Result<(), String> {
    run_terminal_osascript(
        &build_macos_terminal_applescript(script_file),
        "Terminal.app",
    )
}

#[cfg(target_os = "macos")]
pub(super) fn launch_macos_otty(script_file: &std::path::Path) -> Result<(), String> {
    use std::process::Command;

    let otty_cli = find_macos_otty_cli().ok_or_else(|| {
        "未找到 Otty CLI。请将 Otty 安装到 /Applications 或 ~/Applications。".to_string()
    })?;

    let command = build_macos_dash_c_command(script_file);
    let tab_result = Command::new(&otty_cli)
        .args(["tab", "new", "--window", "0", "--command", &command])
        .output()
        .map_err(|e| format!("启动 Otty CLI 失败: {e}"))?;

    if tab_result.status.success() {
        return Ok(());
    }

    log::debug!(
        "Otty 新建 Tab 失败，改为新建窗口: {}",
        decode_command_output(&tab_result.stderr)
    );

    let window_result = Command::new(&otty_cli)
        .args(["open", "--command", &command])
        .output()
        .map_err(|e| format!("启动 Otty CLI 失败: {e}"))?;

    if window_result.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Otty 新建窗口失败 (exit code: {:?}): {}",
            window_result.status.code(),
            decode_command_output(&window_result.stderr)
        ))
    }
}

#[cfg(target_os = "macos")]
pub(super) fn find_macos_otty_cli() -> Option<std::path::PathBuf> {
    macos_otty_cli_candidates()
        .into_iter()
        .find(|path| path.is_file() && is_executable_file(path))
}

#[cfg(target_os = "macos")]
pub(super) fn macos_otty_cli_candidates() -> Vec<std::path::PathBuf> {
    let mut candidates = vec![std::path::PathBuf::from(
        "/Applications/Otty.app/Contents/MacOS/otty-cli",
    )];

    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(
            std::path::PathBuf::from(home).join("Applications/Otty.app/Contents/MacOS/otty-cli"),
        );
    }

    candidates.push(std::path::PathBuf::from("/usr/local/bin/otty"));
    candidates.push(std::path::PathBuf::from("/opt/homebrew/bin/otty"));

    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            candidates.push(directory.join("otty"));
            candidates.push(directory.join("otty-cli"));
        }
    }

    candidates
}

/// macOS: iTerm2
#[cfg(target_os = "macos")]
pub(super) fn build_macos_iterm2_applescript(script_file: &std::path::Path) -> String {
    format!(
        r#"set launcher_script to {launcher}
set was_running to application "iTerm" is running
tell application "iTerm"
    if was_running then
        activate
        if (count of windows) = 0 then
            create window with default profile
        else
            tell current window
                create tab with default profile
            end tell
        end if
    else
        activate
        set waited to 0
        repeat while (count of windows) = 0
            delay 0.1
            set waited to waited + 1
            if waited >= 30 then exit repeat
        end repeat
        if (count of windows) = 0 then
            create window with default profile
        end if
    end if
    tell current session of current window
        write text launcher_script
    end tell
end tell"#,
        launcher = applescript_exec_launcher_command(script_file)
    )
}

/// macOS: iTerm2
#[cfg(target_os = "macos")]
pub(super) fn launch_macos_iterm2(script_file: &std::path::Path) -> Result<(), String> {
    run_terminal_osascript(&build_macos_iterm2_applescript(script_file), "iTerm2")
}

/// Keep the launcher path inside a `sh -c` string.
/// A bare `.sh` passed through `open --args` may also be opened as a document.
#[cfg(target_os = "macos")]
pub(super) fn build_macos_dash_c_command(script_file: &std::path::Path) -> String {
    format!(
        "exec sh {}",
        shell_single_quote(&script_file.to_string_lossy())
    )
}

/// macOS: Ghostty.
/// Warm starts use AppleScript to create one command window.
/// Cold starts use `initial-command` so the first default surface runs the launcher.
/// Do not use `initial-window=false` plus `new window`: cold launch can still create the default window first.
#[cfg(target_os = "macos")]
pub(super) fn build_macos_ghostty_applescript(script_file: &std::path::Path) -> String {
    format!(
        r#"set launcher_command to {launcher}
set was_running to application "Ghostty" is running
if was_running then
    tell application "Ghostty"
        new window with configuration {{command:launcher_command}}
    end tell
else
    do shell script "open -na Ghostty --args --quit-after-last-window-closed=true " & quoted form of ("--initial-command=" & launcher_command)
end if
"#,
        launcher = applescript_launcher_command(script_file)
    )
}

/// macOS: Ghostty
#[cfg(target_os = "macos")]
pub(super) fn launch_macos_ghostty(script_file: &std::path::Path) -> Result<(), String> {
    match run_terminal_osascript(&build_macos_ghostty_applescript(script_file), "Ghostty") {
        Ok(()) => Ok(()),
        Err(applescript_error) => {
            log::warn!(
                "Ghostty AppleScript launch failed, falling back to open -na: {applescript_error}"
            );
            launch_macos_open_app("Ghostty", script_file, true)
        }
    }
}

/// macOS: 使用 open -na 启动支持 --args 参数的终端（Alacritty/Kitty/WezTerm/Kaku）
#[cfg(target_os = "macos")]
pub(super) fn launch_macos_open_app(
    app_name: &str,
    script_file: &std::path::Path,
    use_e_flag: bool,
) -> Result<(), String> {
    use std::process::Command;

    let mut cmd = Command::new("open");
    cmd.arg("-na").arg(app_name).arg("--args");

    if use_e_flag {
        cmd.arg("-e");
    }
    // Keep the script path inside `sh -c`; a trailing bare `.sh` can be opened as a document.
    cmd.arg("sh")
        .arg("-c")
        .arg(build_macos_dash_c_command(script_file));

    let output = cmd
        .output()
        .map_err(|e| format!("启动 {app_name} 失败: {e}"))?;

    if !output.status.success() {
        let stderr = decode_command_output(&output.stderr);
        return Err(format!(
            "{} 启动失败 (exit code: {:?}): {}",
            app_name,
            output.status.code(),
            stderr
        ));
    }

    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn launch_macos_warp(script_file: &std::path::Path) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    let mut cmd = Command::new("open");
    cmd.arg("-a").arg("Warp");

    // Warp URI scheme cannot work well with script_file, because:
    //
    // 1. script_file's name ends up with .sh, so Warp would open the file rather than execute it
    // 2. script_file has no execution permission, so we need to add one more indirection
    let mut second_script_file = tempfile::Builder::new()
        .disable_cleanup(true)
        .permissions(std::fs::Permissions::from_mode(0o755))
        .tempfile()
        .map_err(|e| format!("Failed to create temporary script file: {e}"))?;

    writeln!(
        &mut second_script_file,
        r#"#!/usr/bin/env sh

        rm -- "$0"

        exec sh {quoted_script}
        "#,
        quoted_script = shell_single_quote(&script_file.to_string_lossy()),
    )
    .map_err(|e| format!("Failed to write to temporary script file for Warp: {e}"))?;

    let mut warp_url = url::Url::parse("warp://action/new_tab").unwrap();
    warp_url
        .query_pairs_mut()
        .append_pair("path", &second_script_file.path().to_string_lossy());
    let warp_url = warp_url.to_string();
    cmd.arg(warp_url);

    let output = cmd.output().map_err(|e| format!("启动 Warp 失败: {e}"))?;
    if !output.status.success() {
        let stderr = decode_command_output(&output.stderr);
        return Err(format!(
            "Warp 启动失败 (exit code: {:?}): {}",
            output.status.code(),
            stderr
        ));
    }

    Ok(())
}

/// Linux: 根据用户首选终端启动
#[cfg(target_os = "linux")]
pub(super) fn launch_linux_terminal(
    config_file: &std::path::Path,
    cwd: Option<&Path>,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    let preferred = crate::settings::get_preferred_terminal();

    let shell = get_user_shell();
    let exec_line = build_exec_line(&shell, cwd);
    let final_cd_command = build_final_shell_cd_command(&shell, cwd);

    // Default terminal list with their arguments
    let default_terminals = [
        ("gnome-terminal", vec!["--"]),
        ("konsole", vec!["-e"]),
        ("xfce4-terminal", vec!["-e"]),
        ("mate-terminal", vec!["--"]),
        ("lxterminal", vec!["-e"]),
        ("alacritty", vec!["-e"]),
        ("kitty", vec!["-e"]),
        ("ghostty", vec!["-e"]),
    ];

    // Create temp script file
    let temp_dir = std::env::temp_dir();
    let script_file = temp_dir.join(format!("lolicode_launcher_{}.sh", std::process::id()));
    let config_path = config_file.to_string_lossy();
    let provider_command = build_provider_command_line(&shell, &config_path, cwd);

    let script_content = format!(
        r#"#!/usr/bin/env sh
trap 'rm -f "{config_path}" "{script_file}"' EXIT
echo "Using provider-specific claude config:"
echo "{config_path}"
{provider_command}
{final_cd_command}
{exec_line}
"#,
        config_path = config_path,
        script_file = script_file.display(),
        provider_command = provider_command,
        final_cd_command = final_cd_command,
        exec_line = exec_line,
    );

    std::fs::write(&script_file, &script_content).map_err(|e| format!("写入启动脚本失败: {e}"))?;

    std::fs::set_permissions(&script_file, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("设置脚本权限失败: {e}"))?;

    // Build terminal list: preferred terminal first (if specified), then defaults
    let terminals_to_try: Vec<(&str, Vec<&str>)> = if let Some(ref pref) = preferred {
        // Find the preferred terminal's args from default list
        let pref_args = default_terminals
            .iter()
            .find(|(name, _)| *name == pref.as_str())
            .map(|(_, args)| args.to_vec())
            .unwrap_or_else(|| vec!["-e"]); // Default args for unknown terminals

        let mut list = vec![(pref.as_str(), pref_args)];
        // Add remaining terminals as fallbacks
        for (name, args) in &default_terminals {
            if *name != pref.as_str() {
                list.push((*name, args.to_vec()));
            }
        }
        list
    } else {
        default_terminals
            .iter()
            .map(|(name, args)| (*name, args.to_vec()))
            .collect()
    };

    let mut last_error = String::from("未找到可用的终端");

    for (terminal, args) in terminals_to_try {
        // Check if terminal exists in common paths
        let terminal_exists = std::path::Path::new(&format!("/usr/bin/{}", terminal)).exists()
            || std::path::Path::new(&format!("/bin/{}", terminal)).exists()
            || std::path::Path::new(&format!("/usr/local/bin/{}", terminal)).exists()
            || which_command(terminal);

        if terminal_exists {
            let result = Command::new(terminal)
                .args(&args)
                .arg("sh")
                .arg(script_file.to_string_lossy().as_ref())
                .spawn();

            match result {
                Ok(_) => return Ok(()),
                Err(e) => {
                    last_error = format!("执行 {} 失败: {}", terminal, e);
                }
            }
        }
    }

    // Clean up on failure
    let _ = std::fs::remove_file(&script_file);
    let _ = std::fs::remove_file(config_file);
    Err(last_error)
}

/// Check if a command exists using `which`
#[cfg(target_os = "linux")]
pub(super) fn which_command(cmd: &str) -> bool {
    use std::process::Command;
    Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Windows: 根据用户首选终端启动
#[cfg(target_os = "windows")]
pub(super) fn launch_windows_terminal(
    temp_dir: &std::path::Path,
    config_file: &std::path::Path,
    cwd: Option<&Path>,
) -> Result<(), String> {
    let preferred = crate::settings::get_preferred_terminal();
    let terminal = preferred.as_deref().unwrap_or("cmd");

    let bat_file = temp_dir.join(format!("lolicode_claude_{}.bat", std::process::id()));
    // 配置文件和 .bat 同在 temp_dir（%TEMP% 含用户名），用 %~dp0 引用：目录由 cmd
    // 运行时展开，不进 .bat 字节，非 ASCII 用户名下也不会乱码（#8034）。
    let config_name = config_file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let config_path_for_batch = format!("%~dp0{}", escape_windows_batch_value(&config_name));
    let (cwd_command, cwd_env) = build_windows_cwd_command(cwd);
    let launch_env: Vec<(&str, &str)> = cwd_env
        .as_deref()
        .map(|value| (WINDOWS_CWD_ENV, value))
        .into_iter()
        .collect();

    let content = format!(
        "@echo off
{cwd_command}
echo Using provider-specific claude config:
echo \"{}\"
claude --settings \"{}\"
del \"{}\" >nul 2>&1
del \"%~f0\" >nul 2>&1
",
        config_path_for_batch,
        config_path_for_batch,
        config_path_for_batch,
        cwd_command = cwd_command,
    );

    std::fs::write(&bat_file, &content).map_err(|e| format!("写入批处理文件失败: {e}"))?;

    let bat_path = bat_file.to_string_lossy();
    let ps_cmd = format!("& '{}'", bat_path);

    // Try the preferred terminal first
    let result = match terminal {
        "powershell" => run_windows_start_command_with_env(
            &["powershell", "-NoExit", "-Command", &ps_cmd],
            "PowerShell",
            &launch_env,
        ),
        "wt" => run_windows_start_command_with_env(
            &["wt", "cmd", "/K", &bat_path],
            "Windows Terminal",
            &launch_env,
        ),
        // "cmd" or default
        _ => run_windows_start_command_with_env(&["cmd", "/K", &bat_path], "cmd", &launch_env),
    };

    // If preferred terminal fails and it's not the default, try cmd as fallback
    if result.is_err() && terminal != "cmd" {
        log::warn!(
            "首选终端 {} 启动失败，回退到 cmd: {:?}",
            terminal,
            result.as_ref().err()
        );
        return run_windows_start_command_with_env(&["cmd", "/K", &bat_path], "cmd", &launch_env);
    }

    result
}

#[cfg_attr(windows, allow(dead_code))]
pub(super) fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) fn is_windows_unc_path(path: &str) -> bool {
    path.starts_with(r"\\")
}

/// 非 ASCII 的项目目录经这个环境变量传给 Claude 启动 .bat。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) const WINDOWS_CWD_ENV: &str = "LOLICODE_INTERNAL_CWD";

/// 生成切到项目目录的 .bat 行，第二项是需要给启动进程设置的 `WINDOWS_CWD_ENV` 值。
///
/// cmd 按控制台代码页解码 .bat 字节，非 ASCII 路径以 UTF-8 写进文件会乱码（#8034）；
/// 环境变量在 Windows 内部保持 Unicode，所以这类路径改由环境变量传入。纯 ASCII
/// 路径照旧写进文件，不依赖终端继承环境变量（旧版 Windows Terminal 不继承）。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) fn build_windows_cwd_command_str(path: &str) -> (String, Option<String>) {
    let (target, env_value, cleanup) = if path.is_ascii() {
        (escape_windows_batch_value(path), None, String::new())
    } else {
        (
            format!("%{WINDOWS_CWD_ENV}%"),
            Some(path.to_string()),
            format!("set \"{WINDOWS_CWD_ENV}=\"\r\n"),
        )
    };

    let command = if is_windows_unc_path(path) {
        // `cmd.exe` cannot make a UNC path current via `cd`; `pushd` maps it first.
        format!("pushd \"{target}\" || exit /b 1\r\n{cleanup}")
    } else {
        format!("cd /d \"{target}\" || exit /b 1\r\n{cleanup}")
    };
    (command, env_value)
}

#[cfg(target_os = "windows")]
pub(super) fn build_windows_cwd_command(cwd: Option<&Path>) -> (String, Option<String>) {
    cwd.map(|dir| build_windows_cwd_command_str(&dir.to_string_lossy()))
        .unwrap_or_default()
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) fn escape_windows_batch_value(value: &str) -> String {
    value
        .replace('^', "^^")
        .replace('%', "%%")
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>")
        .replace('(', "^(")
        .replace(')', "^)")
}
/// Windows: Run a start command with common error handling
#[cfg(target_os = "windows")]
pub(super) fn run_windows_start_command(args: &[&str], terminal_name: &str) -> Result<(), String> {
    run_windows_start_command_with_env(args, terminal_name, &[])
}

/// 同 `run_windows_start_command`，额外给启动的终端设置环境变量（`start` 会继承）。
#[cfg(target_os = "windows")]
pub(super) fn run_windows_start_command_with_env(
    args: &[&str],
    terminal_name: &str,
    envs: &[(&str, &str)],
) -> Result<(), String> {
    use std::process::Command;

    let mut full_args = vec!["/C", "start"];
    full_args.extend(args);

    let output = Command::new("cmd")
        .args(&full_args)
        .envs(envs.iter().copied())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("启动 {} 失败: {e}", terminal_name))?;

    if !output.status.success() {
        let stderr = decode_command_output(&output.stderr);
        return Err(format!(
            "{} 启动失败 (exit code: {:?}): {}",
            terminal_name,
            output.status.code(),
            stderr
        ));
    }

    Ok(())
}

/// 打开用户首选终端并在其中执行一段可信命令脚本。脚本尾部 `read -r` / `pause`
/// 是刻意设计的——让命令退出后窗口不要瞬间关闭，用户才看得到 `command
/// not found` / `ModuleNotFoundError` 这类诊断信息。
///
/// **Security**：`command_line` 会被原样拼进 shell/batch 脚本，调用方必须
/// 保证它是可信字符串（当前只由后端硬编码调用）。
pub(crate) fn launch_terminal_running(command_line: &str, label: &str) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let pid = std::process::id();

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let (script_file, script_content) = {
        let file = temp_dir.join(format!("lolicode_{}_{}.sh", label, pid));
        let content = format!(
            r#"#!/usr/bin/env sh
trap 'rm -f "{script_path}"' EXIT
echo "[LoliCode] Starting: {label}"
echo ""
{cmd}
echo ""
echo "[LoliCode] Command exited. Press Enter to close."
read -r _
"#,
            script_path = file.display(),
            label = label,
            cmd = command_line,
        );
        (file, content)
    };

    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(&script_file, &script_content)
            .map_err(|e| format!("写入启动脚本失败: {e}"))?;
        std::fs::set_permissions(&script_file, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("设置脚本权限失败: {e}"))?;

        let preferred = crate::settings::get_preferred_terminal();
        let terminal = preferred.as_deref().unwrap_or("terminal");

        let result = match terminal {
            "iterm2" => launch_macos_iterm2(&script_file),
            "warp" => launch_macos_warp(&script_file),
            "alacritty" => launch_macos_open_app("Alacritty", &script_file, true),
            "kitty" => launch_macos_open_app("kitty", &script_file, false),
            "ghostty" => launch_macos_ghostty(&script_file),
            "otty" => launch_macos_otty(&script_file),
            "wezterm" => launch_macos_open_app("WezTerm", &script_file, true),
            "kaku" => launch_macos_open_app("Kaku", &script_file, true),
            _ => launch_macos_terminal_app(&script_file),
        };

        if result.is_err() && terminal != "terminal" {
            log::warn!(
                "首选终端 {} 启动失败，回退到 Terminal.app: {:?}",
                terminal,
                result.as_ref().err()
            );
            return launch_macos_terminal_app(&script_file);
        }
        result
    }

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        std::fs::write(&script_file, &script_content)
            .map_err(|e| format!("写入启动脚本失败: {e}"))?;
        std::fs::set_permissions(&script_file, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("设置脚本权限失败: {e}"))?;

        let preferred = crate::settings::get_preferred_terminal();
        let default_terminals = [
            ("gnome-terminal", vec!["--"]),
            ("konsole", vec!["-e"]),
            ("xfce4-terminal", vec!["-e"]),
            ("mate-terminal", vec!["--"]),
            ("lxterminal", vec!["-e"]),
            ("alacritty", vec!["-e"]),
            ("kitty", vec!["-e"]),
            ("ghostty", vec!["-e"]),
        ];

        let terminals_to_try: Vec<(&str, Vec<&str>)> = if let Some(ref pref) = preferred {
            let pref_args = default_terminals
                .iter()
                .find(|(name, _)| *name == pref.as_str())
                .map(|(_, args)| args.to_vec())
                .unwrap_or_else(|| vec!["-e"]);
            let mut list = vec![(pref.as_str(), pref_args)];
            for (name, args) in &default_terminals {
                if *name != pref.as_str() {
                    list.push((*name, args.to_vec()));
                }
            }
            list
        } else {
            default_terminals
                .iter()
                .map(|(name, args)| (*name, args.to_vec()))
                .collect()
        };

        let mut last_error = String::from("未找到可用的终端");

        for (terminal, args) in terminals_to_try {
            let terminal_exists = which_command(terminal)
                || ["/usr/bin", "/bin", "/usr/local/bin"]
                    .iter()
                    .any(|dir| std::path::Path::new(&format!("{}/{}", dir, terminal)).exists());

            if terminal_exists {
                let spawn_result = Command::new(terminal)
                    .args(&args)
                    .arg("sh")
                    .arg(script_file.to_string_lossy().as_ref())
                    .spawn();
                match spawn_result {
                    Ok(_) => return Ok(()),
                    Err(e) => {
                        last_error = format!("执行 {} 失败: {}", terminal, e);
                    }
                }
            }
        }

        let _ = std::fs::remove_file(&script_file);
        Err(last_error)
    }

    #[cfg(target_os = "windows")]
    {
        let preferred = crate::settings::get_preferred_terminal();
        let terminal = preferred.as_deref().unwrap_or("cmd");

        let bat_file = temp_dir.join(format!("lolicode_{}_{}.bat", label, pid));
        let content = format!(
            "@echo off\r\necho [LoliCode] Starting: {label}\r\necho.\r\n{cmd}\r\necho.\r\necho [LoliCode] Command exited. Press any key to close.\r\npause >nul\r\ndel \"%~f0\" >nul 2>&1\r\n",
            label = label,
            cmd = command_line,
        );
        std::fs::write(&bat_file, &content).map_err(|e| format!("写入批处理文件失败: {e}"))?;

        let bat_path = bat_file.to_string_lossy();
        let ps_cmd = format!("& '{}'", bat_path);

        let result = match terminal {
            "powershell" => run_windows_start_command(
                &["powershell", "-NoExit", "-Command", &ps_cmd],
                "PowerShell",
            ),
            "wt" => run_windows_start_command(&["wt", "cmd", "/K", &bat_path], "Windows Terminal"),
            _ => run_windows_start_command(&["cmd", "/K", &bat_path], "cmd"),
        };

        let final_result = if result.is_err() && terminal != "cmd" {
            log::warn!(
                "首选终端 {} 启动失败，回退到 cmd: {:?}",
                terminal,
                result.as_ref().err()
            );
            run_windows_start_command(&["cmd", "/K", &bat_path], "cmd")
        } else {
            result
        };

        // The .bat self-deletes (`del "%~f0"`) after it runs, but that only
        // fires if *some* terminal actually launched it. If every attempt
        // failed, sweep the temp file ourselves to avoid pollution.
        if final_result.is_err() {
            let _ = std::fs::remove_file(&bat_file);
        }
        final_result
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (temp_dir, pid, command_line, label);
        Err("不支持的操作系统".to_string())
    }
}
