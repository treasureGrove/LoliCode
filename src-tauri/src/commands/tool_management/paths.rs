//! Executable search paths and PATH-default resolution across platforms.

#[cfg(not(target_os = "windows"))]
use super::process::isolate_child_process_group;
use super::process::{decode_command_output, wait_child_output, CommandDeadline};
#[cfg(not(target_os = "windows"))]
use super::terminal::{default_flag_for_shell, is_valid_shell};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;
use std::path::Path;
#[cfg(target_os = "windows")]
use std::path::PathBuf;

pub(super) fn push_unique_path(paths: &mut Vec<std::path::PathBuf>, path: std::path::PathBuf) {
    if path.as_os_str().is_empty() {
        return;
    }

    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

pub(super) fn push_env_single_dir(
    paths: &mut Vec<std::path::PathBuf>,
    value: Option<std::ffi::OsString>,
) {
    if let Some(raw) = value {
        push_unique_path(paths, std::path::PathBuf::from(raw));
    }
}

pub(super) fn extend_from_path_list(
    paths: &mut Vec<std::path::PathBuf>,
    value: Option<std::ffi::OsString>,
    suffix: Option<&str>,
) {
    if let Some(raw) = value {
        for p in std::env::split_paths(&raw) {
            let dir = match suffix {
                Some(s) => p.join(s),
                None => p,
            };
            push_unique_path(paths, dir);
        }
    }
}

pub(super) fn extend_from_cli_path_env(
    paths: &mut Vec<std::path::PathBuf>,
    value: Option<std::ffi::OsString>,
) {
    if let Some(raw) = value {
        for p in std::env::split_paths(&raw) {
            if should_skip_cli_path_env_dir(&p) {
                continue;
            }
            push_unique_path(paths, p);
        }
    }
}

pub(super) fn should_skip_cli_path_env_dir(path: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        is_windows_app_execution_alias_dir(path)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        false
    }
}

#[cfg(target_os = "windows")]
pub(super) fn is_windows_app_execution_alias_dir(path: &Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    normalized
        .trim_end_matches('\\')
        .ends_with("\\microsoft\\windowsapps")
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) fn push_env_child_dir(
    paths: &mut Vec<std::path::PathBuf>,
    value: Option<std::ffi::OsString>,
    child: &str,
) {
    if let Some(raw) = value {
        push_unique_path(paths, std::path::PathBuf::from(raw).join(child));
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) fn extend_existing_child_search_paths(
    paths: &mut Vec<std::path::PathBuf>,
    base: &Path,
    suffix: Option<&str>,
) {
    if !base.exists() {
        return;
    }

    if let Ok(entries) = std::fs::read_dir(base) {
        for entry in entries.flatten() {
            let path = match suffix {
                Some(suffix) => entry.path().join(suffix),
                None => entry.path(),
            };
            if path.exists() {
                push_unique_path(paths, path);
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub(super) fn extend_windows_cli_manager_search_paths(
    paths: &mut Vec<std::path::PathBuf>,
    home: &Path,
) {
    push_env_single_dir(paths, std::env::var_os("PNPM_HOME"));
    push_env_child_dir(paths, std::env::var_os("VOLTA_HOME"), "bin");
    push_env_single_dir(paths, std::env::var_os("NVM_SYMLINK"));
    push_env_child_dir(paths, std::env::var_os("SCOOP"), "shims");
    push_env_child_dir(paths, std::env::var_os("SCOOP_GLOBAL"), "shims");

    if let Some(nvm_home) = std::env::var_os("NVM_HOME") {
        let nvm_home = std::path::PathBuf::from(nvm_home);
        push_unique_path(paths, nvm_home.clone());
        extend_existing_child_search_paths(paths, &nvm_home, None);
    }

    if let Some(appdata) = dirs::data_dir() {
        let nvm_home = appdata.join("nvm");
        push_unique_path(paths, nvm_home.clone());
        extend_existing_child_search_paths(paths, &nvm_home, None);
    }

    if !home.as_os_str().is_empty() {
        push_unique_path(paths, home.join("scoop").join("shims"));
    }

    if let Some(local_data) = dirs::data_local_dir() {
        push_unique_path(paths, local_data.join("pnpm"));
        push_unique_path(paths, local_data.join("Volta").join("bin"));
        push_unique_path(paths, local_data.join("Yarn").join("bin"));
    }

    let program_data = std::env::var_os("ProgramData")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("C:\\ProgramData"));
    push_unique_path(paths, program_data.join("scoop").join("shims"));
}

/// OpenCode install.sh 路径优先级（见 https://github.com/anomalyco/opencode README）:
///   $OPENCODE_INSTALL_DIR > $XDG_BIN_DIR > $HOME/bin > $HOME/.opencode/bin
/// 额外扫描 Bun 默认全局安装路径（~/.bun/bin）
/// 和 Go 安装路径（~/go/bin、$GOPATH/*/bin）。
pub(super) fn opencode_extra_search_paths(
    home: &Path,
    opencode_install_dir: Option<std::ffi::OsString>,
    xdg_bin_dir: Option<std::ffi::OsString>,
    gopath: Option<std::ffi::OsString>,
) -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();

    push_env_single_dir(&mut paths, opencode_install_dir);
    push_env_single_dir(&mut paths, xdg_bin_dir);

    if !home.as_os_str().is_empty() {
        push_unique_path(&mut paths, home.join("bin"));
        push_unique_path(&mut paths, home.join(".opencode").join("bin"));
        push_unique_path(&mut paths, home.join(".bun").join("bin"));
        push_unique_path(&mut paths, home.join("go").join("bin"));
    }

    extend_from_path_list(&mut paths, gopath, Some("bin"));

    paths
}

/// Grok's official installer writes the launcher to `$GROK_BIN_DIR` or, by
/// default, `~/.grok/bin`. Keep these ahead of generic npm/Node locations so
/// version probing and anchored updates can see the native distribution even
/// when the GUI process inherited a stale PATH.
pub(super) fn grok_extra_search_paths(
    home: &Path,
    grok_bin_dir: Option<std::ffi::OsString>,
) -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    push_env_single_dir(&mut paths, grok_bin_dir);
    if !home.as_os_str().is_empty() {
        push_unique_path(&mut paths, home.join(".grok").join("bin"));
    }
    paths
}

/// MiniMax Code 官方 installer 的入口：POSIX 在 `<root>/bin/mcode`，Windows 的
/// `mcode.cmd` / `mcode.ps1` 直接放在 `<root>` 下（不在 `bin`）。root 默认
/// `~/.minimax-code`，可由 `MCODE_INSTALL_DIR` 改。installer 只改 shell rc / 用户 PATH，
/// GUI 进程继承的旧 PATH 看不到，所以同 Grok 一样显式排在通用 npm/Node 目录前面。
pub(super) fn mcode_extra_search_paths(
    home: &Path,
    mcode_install_dir: Option<std::ffi::OsString>,
) -> Vec<std::path::PathBuf> {
    let launcher_dir = |root: std::path::PathBuf| {
        if cfg!(target_os = "windows") {
            root
        } else {
            root.join("bin")
        }
    };
    let mut paths = Vec::new();
    if let Some(root) = mcode_install_dir.filter(|value| !value.is_empty()) {
        push_unique_path(&mut paths, launcher_dir(std::path::PathBuf::from(root)));
    }
    if !home.as_os_str().is_empty() {
        push_unique_path(&mut paths, launcher_dir(home.join(".minimax-code")));
    }
    paths
}

pub(super) fn tool_executable_candidates(tool: &str, dir: &Path) -> Vec<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let extensionless = dir.join(tool);
        let mut candidates = vec![
            dir.join(format!("{tool}.cmd")),
            dir.join(format!("{tool}.exe")),
        ];
        if windows_runnable_sibling_for_extensionless_tool(&extensionless).is_none() {
            candidates.push(extensionless);
        }
        candidates
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![dir.join(tool)]
    }
}

pub(super) fn extend_mise_node_search_paths(paths: &mut Vec<std::path::PathBuf>, home: &Path) {
    if home.as_os_str().is_empty() {
        return;
    }

    let mise_base = home.join(".local/share/mise");
    push_unique_path(paths, mise_base.join("shims"));

    let node_installs = mise_base.join("installs").join("node");
    if node_installs.exists() {
        if let Ok(entries) = std::fs::read_dir(&node_installs) {
            for entry in entries.flatten() {
                let bin_path = entry.path().join("bin");
                if bin_path.exists() {
                    push_unique_path(paths, bin_path);
                }
            }
        }
    }
}

/// The "effective PATH" used for CLI detection and lifecycle commands. On Windows
/// the inherited process PATH can be incomplete — most notably after an in-app self-update,
/// where the MSI/WiX-auto-launched process inherits only the machine-level PATH
/// and drops the user-level PATH (see #6061). Any CLI installed in a user-PATH
/// location (winget Claude `%LOCALAPPDATA%\Programs\claude`, the standalone
/// Codex installer `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`, a custom npm
/// prefix `D:\npm-global`, …) then reads as "not installed".
///
/// Reconstruct the effective PATH by merging the process PATH with the machine
/// and user registry PATH values (`REG_EXPAND_SZ` expanded), so detection sees
/// the same installations a freshly logged-in shell would — regardless of how
/// the current process was launched. Process entries are kept first (a runtime
/// override wins); registry entries fill whatever the process is missing;
/// duplicates are removed.
///
/// See `env_checker::check_system_env` for the same set of registry keys; here
/// we read only the `Path` value.
#[cfg(target_os = "windows")]
pub(super) fn effective_path_string() -> String {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let process = std::env::var("PATH").unwrap_or_default();
    let user = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Environment")
        .and_then(|k| k.get_value::<String, &str>("Path"))
        .map(|raw| expand_env_chars(&raw))
        .unwrap_or_default();
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")
        .and_then(|k| k.get_value::<String, &str>("Path"))
        .map(|raw| expand_env_chars(&raw))
        .unwrap_or_default();
    merge_path_segments_win(&[&process, &user, &machine])
}

/// `extend_from_cli_path_env` consumes an `OsString` via `split_paths`. On
/// Windows this is derived from `effective_path_string`; on other platforms the
/// raw process value is returned unchanged (zero behaviour change).
#[cfg(target_os = "windows")]
pub(super) fn effective_path_os() -> Option<std::ffi::OsString> {
    Some(std::ffi::OsString::from(effective_path_string()))
}

#[cfg(not(target_os = "windows"))]
pub(super) fn effective_path_os() -> Option<std::ffi::OsString> {
    std::env::var_os("PATH")
}

/// Prepend a candidate directory without converting the existing PATH to
/// UTF-8. Unix permits arbitrary non-NUL bytes in environment values; keeping
/// this as an `OsString` ensures one non-Unicode segment cannot discard or
/// corrupt every other interpreter directory needed by an npm/python shim.
#[cfg(not(target_os = "windows"))]
pub(super) fn prepend_search_dir_to_path(
    dir: &Path,
    current_path: &std::ffi::OsStr,
) -> std::ffi::OsString {
    let mut path = dir.as_os_str().to_os_string();
    if !current_path.is_empty() {
        path.push(":");
        path.push(current_path);
    }
    path
}

/// Expand `%VAR%` environment-variable references. The registry `Path` value is
/// `REG_EXPAND_SZ`, and the `String` returned by `winreg` is not auto-expanded.
/// Variables such as `%LOCALAPPDATA%` / `%USERPROFILE%` / `%SystemRoot%` are
/// still defined in a process that lost its user PATH (Winlogon injects them
/// from the user profile), so expanding each via `std::env::var` is safe.
/// Undefined variables are preserved verbatim (no characters dropped).
#[cfg(target_os = "windows")]
pub(super) fn expand_env_chars(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(open) = rest.find('%') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('%') {
            None => {
                out.push('%');
                out.push_str(after);
                rest = "";
                break;
            }
            Some(close) => {
                let name = &after[..close];
                let is_ident =
                    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
                if is_ident {
                    match std::env::var(name) {
                        Ok(val) => out.push_str(&val),
                        Err(_) => {
                            out.push('%');
                            out.push_str(name);
                            out.push('%');
                        }
                    }
                } else {
                    out.push('%');
                    out.push_str(name);
                    out.push('%');
                }
                rest = &after[close + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Merge several Windows PATH strings (`;`-separated) in order, keeping only
/// the first occurrence of each segment (case-insensitive). Process segments
/// come first to respect runtime overrides, followed by user- and
/// machine-level registry segments.
#[cfg(target_os = "windows")]
pub(super) fn merge_path_segments_win(parts: &[&str]) -> String {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut merged: Vec<&str> = Vec::new();
    for part in parts {
        for seg in part.split(';') {
            let s = seg.trim();
            if s.is_empty() || !seen.insert(s.to_ascii_lowercase()) {
                continue;
            }
            merged.push(s);
        }
    }
    merged.join(";")
}

/// 构建某工具的候选搜索目录（原生安装优先，PATH 兜底）。
/// 单探兜底 (`scan_cli_version`) 与全量枚举 (`enumerate_tool_installations`) 共用，
/// 确保两条路径看到的是同一组安装位置。
pub(super) fn build_tool_search_paths(tool: &str) -> Vec<std::path::PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();

    // 常见的安装路径（原生安装优先）
    let mut search_paths: Vec<std::path::PathBuf> = Vec::new();
    if tool == "grok" {
        let extra_paths = grok_extra_search_paths(&home, std::env::var_os("GROK_BIN_DIR"));
        for path in extra_paths {
            push_unique_path(&mut search_paths, path);
        }
    }
    if tool == "mcode" {
        let extra_paths = mcode_extra_search_paths(&home, std::env::var_os("MCODE_INSTALL_DIR"));
        for path in extra_paths {
            push_unique_path(&mut search_paths, path);
        }
    }
    if !home.as_os_str().is_empty() {
        push_unique_path(&mut search_paths, home.join(".local/bin"));
        push_unique_path(&mut search_paths, home.join(".npm-global/bin"));
        push_unique_path(&mut search_paths, home.join("n/bin"));
        push_unique_path(&mut search_paths, home.join(".volta/bin"));
        extend_mise_node_search_paths(&mut search_paths, &home);
    }

    #[cfg(target_os = "macos")]
    {
        push_unique_path(
            &mut search_paths,
            std::path::PathBuf::from("/opt/homebrew/bin"),
        );
        push_unique_path(
            &mut search_paths,
            std::path::PathBuf::from("/usr/local/bin"),
        );
        if tool == "hermes" {
            let python_base = home.join("Library").join("Python");
            if python_base.exists() {
                if let Ok(entries) = std::fs::read_dir(&python_base) {
                    for entry in entries.flatten() {
                        let bin_path = entry.path().join("bin");
                        if bin_path.exists() {
                            push_unique_path(&mut search_paths, bin_path);
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        push_unique_path(
            &mut search_paths,
            std::path::PathBuf::from("/usr/local/bin"),
        );
        push_unique_path(&mut search_paths, std::path::PathBuf::from("/usr/bin"));
    }

    #[cfg(target_os = "windows")]
    {
        // Official standalone (non-npm) installer locations — belt-and-suspenders
        // alongside the registry-PATH merge in `effective_path_os`. These
        // installers normally register themselves on the user PATH, but some
        // per-user MSI/MSIX installs do not, and an in-app-update relaunch can
        // drop the user PATH (#6061), so add them explicitly here. Placed ahead
        // of the npm directory so a native install wins over a stale npm shim
        // (#4701).
        if let Some(local_data) = dirs::data_local_dir() {
            if tool == "codex" {
                // OpenAI Codex Installer.exe / .msi standalone install location
                // (#6061, #6047).
                push_unique_path(
                    &mut search_paths,
                    local_data
                        .join("Programs")
                        .join("OpenAI")
                        .join("Codex")
                        .join("bin"),
                );
            }
            if tool == "claude" {
                // `winget install Anthropic.ClaudeCode` / official native
                // installer location (#6278).
                push_unique_path(
                    &mut search_paths,
                    local_data.join("Programs").join("claude"),
                );
            }
        }
        if let Some(appdata) = dirs::data_dir() {
            push_unique_path(&mut search_paths, appdata.join("npm"));
            if tool == "hermes" {
                let python_base = appdata.join("Python");
                if python_base.exists() {
                    if let Ok(entries) = std::fs::read_dir(&python_base) {
                        for entry in entries.flatten() {
                            let scripts_path = entry.path().join("Scripts");
                            if scripts_path.exists() {
                                push_unique_path(&mut search_paths, scripts_path);
                            }
                        }
                    }
                }
            }
        }
        if tool == "hermes" {
            if let Some(local_data) = dirs::data_local_dir() {
                let programs_python = local_data.join("Programs").join("Python");
                if programs_python.exists() {
                    if let Ok(entries) = std::fs::read_dir(&programs_python) {
                        for entry in entries.flatten() {
                            let scripts_path = entry.path().join("Scripts");
                            if scripts_path.exists() {
                                push_unique_path(&mut search_paths, scripts_path);
                            }
                        }
                    }
                }
            }
        }
        push_unique_path(
            &mut search_paths,
            std::path::PathBuf::from("C:\\Program Files\\nodejs"),
        );
        extend_windows_cli_manager_search_paths(&mut search_paths, &home);
    }

    let fnm_base = home.join(".local/state/fnm_multishells");
    if fnm_base.exists() {
        if let Ok(entries) = std::fs::read_dir(&fnm_base) {
            for entry in entries.flatten() {
                let bin_path = entry.path().join("bin");
                if bin_path.exists() {
                    push_unique_path(&mut search_paths, bin_path);
                }
            }
        }
    }

    let nvm_base = home.join(".nvm/versions/node");
    if nvm_base.exists() {
        if let Ok(entries) = std::fs::read_dir(&nvm_base) {
            for entry in entries.flatten() {
                let bin_path = entry.path().join("bin");
                if bin_path.exists() {
                    push_unique_path(&mut search_paths, bin_path);
                }
            }
        }
    }

    if tool == "opencode" {
        let extra_paths = opencode_extra_search_paths(
            &home,
            std::env::var_os("OPENCODE_INSTALL_DIR"),
            std::env::var_os("XDG_BIN_DIR"),
            std::env::var_os("GOPATH"),
        );

        for path in extra_paths {
            push_unique_path(&mut search_paths, path);
        }
    }

    let path_env = effective_path_os();
    extend_from_cli_path_env(&mut search_paths, path_env);
    search_paths
}

#[cfg(target_os = "windows")]
pub(super) fn is_windows_command_script(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

/// Convert a canonicalized Windows path back to the form accepted by shell
/// commands. `std::fs::canonicalize` prefixes local paths with `\\?\` (and UNC
/// paths with `\\?\UNC\`), but `cmd.exe` cannot `call` a batch file through
/// those verbatim paths and reports "The system cannot find the path
/// specified." Direct Win32 executable launches accept the prefix; batch
/// scripts do not.
#[cfg(target_os = "windows")]
pub(super) fn windows_shell_compatible_path(path: &Path) -> std::path::PathBuf {
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        std::path::PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(local) = raw.strip_prefix(r"\\?\") {
        std::path::PathBuf::from(local)
    } else {
        path.to_path_buf()
    }
}

#[cfg(target_os = "windows")]
pub(super) fn windows_runnable_sibling_for_extensionless_tool(
    path: &Path,
) -> Option<std::path::PathBuf> {
    if path.extension().is_some() {
        return None;
    }

    ["cmd", "exe"]
        .iter()
        .map(|ext| path.with_extension(ext))
        .find(|candidate| candidate.is_file())
}

/// 从 shell 输出里挑出第一个绝对路径行（trim 后以 `/` 开头），跳过交互式登录 shell
/// （`-lic`）里 .zshrc 打印的欢迎语/提示符等噪音。canonicalize 由调用方做（碰 FS）。
#[cfg(not(target_os = "windows"))]
pub(super) fn first_abs_path_line(raw: &str) -> Option<&str> {
    raw.lines().map(str::trim).find(|l| l.starts_with('/'))
}

/// 从 `env` 输出里取 `PATH=` 那行的值。要求值以 `/` 开头——PATH 首段必是绝对路径，
/// 这条约束顺带跳过"某个多行值的环境变量恰好有一行以 `PATH=` 开头"的污染，
/// 与 `first_abs_path_line` 对交互式 shell 噪音的容错同理。
#[cfg(not(target_os = "windows"))]
pub(super) fn path_line_from_env_output(raw: &str) -> Option<&str> {
    raw.lines()
        .filter_map(|line| line.strip_prefix("PATH="))
        .find(|value| value.starts_with('/'))
}

/// 合并两段 PATH：`primary` 全部保留在前，`extra` 中未出现过的段按序追加。
/// 空段直接丢弃（`a::b` 里的空段在 POSIX 下语义是"当前目录"，注入时不该带上）。
#[cfg(not(target_os = "windows"))]
pub(super) fn merge_path_segments(primary: &str, extra: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut merged: Vec<&str> = Vec::new();
    for segment in primary.split(':').chain(extra.split(':')) {
        if segment.is_empty() || !seen.insert(segment) {
            continue;
        }
        merged.push(segment);
    }
    merged.join(":")
}

/// 用与 `resolve_path_default` 相同的登录 shell 解析用户的真实 PATH，
/// 供 `run_tool_lifecycle_silently` 注入给安装/升级脚本。
///
/// **要解决的不对称**：探测阶段（`try_get_version` / `resolve_path_default`）跑的是
/// `$SHELL -lic`，会读 `.zshrc`/`.zprofile`，看得到 nvm / homebrew / volta；而执行阶段
/// 是非登录 `bash -c`，继承的是 launchd 给 GUI App 的 PATH，通常只有
/// `/usr/bin:/bin:/usr/sbin:/sbin`。锚定命令自己用绝对路径调用执行体，本不受这条影响
/// ——但有两类漏网：
/// 1. **执行体在内部再 spawn 第三方 CLI**：`grok update` 靠 `npm view` 查最新版本
///    （见 `grok_native_update_command`），npm 又是 `#!/usr/bin/env node` 脚本；
///    未来任何 self-update 内部调 node/git/python 同理。
/// 2. **install 分支的 `<官方 installer> || npm i -g <pkg>@latest`**：`||` 右侧是裸命令，
///    窄 PATH 下必然 exit 127，等于没有兜底。
///
/// 把执行阶段的 PATH 拉平到探测阶段的水平，一次消除这两类。
///
/// **用 `/usr/bin/env` 而不是 `echo $PATH`**：`$PATH` 在 fish 里是 list 类型，
/// `"$PATH"` 展开成空格分隔而非冒号分隔；`env` 打印的则是子进程的真实环境，
/// 任何 shell 下格式都正确。写绝对路径又绕过了 alias / function / PATH 三重不确定性
/// （交互式 shell 会加载用户 alias）。
///
/// 解析不到时返回 `None`，调用方保持原有行为（不注入），不引入新的失败模式。
#[cfg(not(target_os = "windows"))]
pub(super) fn login_shell_path() -> Option<String> {
    use std::process::Command;
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| is_valid_shell(s))
        .unwrap_or_else(|| "sh".to_string());
    let flag = default_flag_for_shell(&shell);
    let out = Command::new(shell)
        .arg(flag)
        .arg("/usr/bin/env")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = decode_command_output(&out.stdout);
    Some(path_line_from_env_output(&raw)?.to_string())
}

/// 用与 `try_get_version` 相同的登录 shell 解析 PATH 默认命中的可执行文件路径，
/// canonicalize 后作为"命令行默认 / 升级目标"的锚点（与升级会作用的那处对齐）。
#[cfg(not(target_os = "windows"))]
pub(super) fn resolve_path_default(
    tool: &str,
    deadline: Option<CommandDeadline>,
) -> Result<Option<std::path::PathBuf>, String> {
    use std::process::{Command, Stdio};

    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| is_valid_shell(s))
        .unwrap_or_else(|| "sh".to_string());
    let flag = default_flag_for_shell(&shell);
    let mut cmd = Command::new(shell);
    cmd.arg(flag)
        .arg(format!("command -v {tool}"))
        // 改 spawn 后 stdin 不再像 output() 那样默认置 null，须显式关闭：
        // 继承来的 stdin 可能是终端/管道，交互式 rc 里的读操作会永久阻塞。
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolate_child_process_group(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to locate {tool}: {e}"))?;
    let out = wait_child_output(child, deadline)?;
    if !out.status.success() {
        return Ok(None);
    }
    let raw = decode_command_output(&out.stdout);
    // 不能死取第一行：交互式 .zshrc 可能先打印欢迎语（如 "🚀 Welcome back"），
    // command -v 的真实路径在其后；取第一个 `/` 开头的行才稳。
    let Some(first) = first_abs_path_line(&raw) else {
        return Ok(None);
    };
    Ok(std::fs::canonicalize(first).ok())
}

#[cfg(target_os = "windows")]
pub(super) fn windows_path_lookup_command(
    tool: &str,
    effective_path: &std::ffi::OsStr,
) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    // Use the system copy explicitly so a project-local `where.exe` cannot
    // hijack the passive lookup before the PATH-only pattern is evaluated.
    let where_exe = PathBuf::from(
        std::env::var_os("SystemRoot").unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows")),
    )
    .join("System32")
    .join("where.exe");
    let mut command = Command::new(where_exe);
    command
        // `$PATH:pattern` is where.exe's documented environment-variable
        // search form. Unlike a bare pattern, it does not search the current
        // directory before PATH.
        .arg(format!("$PATH:{tool}"))
        .env("PATH", effective_path)
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

#[cfg(target_os = "windows")]
pub(super) fn resolve_path_default(
    tool: &str,
    deadline: Option<CommandDeadline>,
) -> Result<Option<std::path::PathBuf>, String> {
    // Restrict `where` to the merged effective PATH. A bare `where {tool}` also
    // searches the current directory first, which would let a project-local
    // `codex.cmd` be executed by a passive version check. The `$PATH:pattern`
    // form searches only the supplied environment variable while still seeing
    // registry PATH entries lost by an in-app-update relaunch (#6061).
    let current_path = effective_path_os().unwrap_or_default();
    let child = windows_path_lookup_command(tool, &current_path)
        .spawn()
        .map_err(|e| format!("Failed to locate {tool}: {e}"))?;
    let out = wait_child_output(child, deadline)?;
    if !out.status.success() {
        return Ok(None);
    }
    let raw = decode_command_output(&out.stdout);
    // `where` lists every match on PATH in order; the first is what the user
    // actually runs. Skip App Execution Aliases (reparse points under
    // `Microsoft\WindowsApps`) — they launch the Store / a protocol handler,
    // are not CLIs we can `--version`-probe, and must not be treated as the
    // PATH default. Take the first remaining real entry.
    let resolved = raw.lines().map(str::trim).find(|line| {
        !line.is_empty()
            && !is_windows_app_execution_alias_dir(
                Path::new(line).parent().unwrap_or(Path::new("")),
            )
    });
    let Some(first) = resolved else {
        return Ok(None);
    };
    let path = Path::new(first);
    let preferred =
        windows_runnable_sibling_for_extensionless_tool(path).unwrap_or_else(|| path.to_path_buf());
    Ok(std::fs::canonicalize(preferred).ok())
}
