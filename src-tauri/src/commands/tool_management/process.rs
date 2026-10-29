//! CLI process execution, output decoding, deadlines and WSL transport.

use super::installations::locate_default_tool;
#[cfg(target_os = "windows")]
use super::installations::wsl_distro_for_tool;
#[cfg(target_os = "windows")]
use super::paths::{is_windows_command_script, windows_shell_compatible_path};
use super::terminal::shell_single_quote;
#[cfg(target_os = "windows")]
use super::terminal::{
    is_valid_wsl_distro_name, win_quote_path_for_batch, windows_cmd_double_quote_arg,
};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;
use super::VALID_TOOLS;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;

pub(crate) fn decode_command_output(bytes: &[u8]) -> String {
    #[cfg(target_os = "windows")]
    {
        decode_windows_command_output(bytes)
    }

    #[cfg(not(target_os = "windows"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(target_os = "windows")]
pub(super) fn decode_windows_command_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }

    use windows_sys::Win32::Globalization::{GetACP, GetOEMCP, MultiByteToWideChar};

    fn decode_codepage(bytes: &[u8], codepage: u32) -> Option<String> {
        if codepage == 0 {
            return None;
        }

        let input_len = i32::try_from(bytes.len()).ok()?;
        unsafe {
            let wide_len = MultiByteToWideChar(
                codepage,
                0,
                bytes.as_ptr(),
                input_len,
                std::ptr::null_mut(),
                0,
            );
            if wide_len <= 0 {
                return None;
            }

            let mut wide = vec![0u16; wide_len as usize];
            let written = MultiByteToWideChar(
                codepage,
                0,
                bytes.as_ptr(),
                input_len,
                wide.as_mut_ptr(),
                wide_len,
            );
            if written <= 0 {
                return None;
            }

            Some(String::from_utf16_lossy(&wide[..written as usize]))
        }
    }

    let oem_cp = unsafe { GetOEMCP() };
    if let Some(decoded) = decode_codepage(bytes, oem_cp) {
        return decoded;
    }

    let ansi_cp = unsafe { GetACP() };
    if ansi_cp != oem_cp {
        if let Some(decoded) = decode_codepage(bytes, ansi_cp) {
            return decoded;
        }
    }

    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(target_os = "windows")]
pub(super) fn build_windows_tool_command(
    tool_path: &Path,
    args: &[&str],
    new_path: &str,
) -> std::process::Command {
    use std::process::Command;

    if is_windows_command_script(tool_path) {
        // `resolve_path_default` returns a canonical path so callers can
        // compare installation identities. Canonical Windows paths carry a
        // `\\?\` prefix, which `cmd /C call` rejects for batch files. Normalize
        // only at this shell boundary and keep the canonical identity intact
        // everywhere else.
        let shell_path = windows_shell_compatible_path(tool_path);
        let path = shell_path.to_string_lossy();
        let args = args
            .iter()
            .map(|arg| windows_cmd_double_quote_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let command = format!(
            "call {}{}",
            win_quote_path_for_batch(&path),
            if args.is_empty() {
                String::new()
            } else {
                format!(" {args}")
            }
        );
        let mut cmd = Command::new("cmd");
        cmd.args(["/D", "/S", "/C"])
            .raw_arg(&command)
            .env("PATH", new_path)
            .creation_flags(CREATE_NO_WINDOW);
        return cmd;
    }

    let mut cmd = Command::new(tool_path);
    cmd.args(args)
        .env("PATH", new_path)
        .creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(target_os = "windows")]
pub(super) fn run_windows_tool_command(
    tool_path: &Path,
    args: &[&str],
    new_path: &str,
) -> std::io::Result<std::process::Output> {
    build_windows_tool_command(tool_path, args, new_path).output()
}

#[cfg(target_os = "windows")]
pub(super) fn run_windows_tool_version_command(
    tool_path: &Path,
    new_path: &str,
) -> std::io::Result<std::process::Output> {
    run_windows_tool_command(tool_path, &["--version"], new_path)
}

/// 升级预检/冲突诊断的单条子进程探测预算。枚举会对每个工具开一次登录 shell、对每处
/// 安装跑一次 `--version`，任何一条挂死（.zshrc 阻塞、nvm shim 指向已删除的 node 等）
/// 都会卡住整个"全部升级"预检——到点整组击杀，该条按探测失败降级，预检继续。
pub(super) const INSTALL_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// 带超时的 `--version` 探测（非 Windows）。与 `scan_cli_version` 的裸 `output()`
/// 不同：stdin 显式置 null、经 `isolate_child_process_group` 进独立会话，超时可整组击杀。
/// `new_path` 取 `&OsStr` 而非 `&str`：与 `prepend_search_dir_to_path` 同一约定，
/// 非 UTF-8 的 PATH 段不能在传递途中被有损转换丢弃。
#[cfg(not(target_os = "windows"))]
pub(super) fn run_probe_version_command(
    tool_path: &Path,
    new_path: &std::ffi::OsStr,
) -> Result<std::process::Output, String> {
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(tool_path);
    cmd.arg("--version")
        .env("PATH", new_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolate_child_process_group(&mut cmd);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    wait_child_output(
        child,
        CommandDeadline::from_timeout(Some(INSTALL_PROBE_TIMEOUT)),
    )
}

/// 带超时的 `--version` 探测（Windows）。命令构造与 `run_windows_tool_version_command`
/// 完全一致（.cmd/.bat 经 `cmd /C call`、其余直连），但改 spawn + `wait_child_output`：
/// 挂死的 .cmd shim / CLI 到点由 `terminate_child_tree`（taskkill /T /F）整树击杀，
/// 预检不再被单个候选卡死。scan 路径保持原 helper 不受影响。
#[cfg(target_os = "windows")]
pub(super) fn run_probe_version_command(
    tool_path: &Path,
    new_path: &str,
) -> Result<std::process::Output, String> {
    use std::process::Stdio;

    let mut cmd = build_windows_tool_command(tool_path, &["--version"], new_path);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    wait_child_output(
        child,
        CommandDeadline::from_timeout(Some(INSTALL_PROBE_TIMEOUT)),
    )
}

#[derive(Clone, Copy)]
pub(super) struct CommandDeadline {
    expires_at: std::time::Instant,
    limit: std::time::Duration,
}

impl CommandDeadline {
    pub(super) fn from_timeout(timeout: Option<std::time::Duration>) -> Option<Self> {
        timeout.map(|limit| Self {
            expires_at: std::time::Instant::now() + limit,
            limit,
        })
    }

    pub(super) fn remaining(self) -> Result<std::time::Duration, String> {
        self.expires_at
            .checked_duration_since(std::time::Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| self.timeout_error())
    }

    pub(super) fn timeout_error(self) -> String {
        format!("Command timed out after {}s", self.limit.as_secs())
    }
}

#[cfg(target_os = "windows")]
pub(super) fn terminate_child_tree(child: &mut std::process::Child) -> bool {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let status = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    matches!(status, Ok(status) if status.success()) || child.kill().is_ok()
}

#[cfg(not(target_os = "windows"))]
pub(super) fn terminate_child_tree(child: &mut std::process::Child) -> bool {
    let process_group = -(child.id() as libc::pid_t);
    // SAFETY: runtime commands are placed in a dedicated process group before spawn.
    (unsafe { libc::kill(process_group, libc::SIGKILL) == 0 }) || child.kill().is_ok()
}

#[cfg(not(target_os = "windows"))]
pub(super) fn isolate_child_process_group(cmd: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;

    // setsid 而非 process_group(0)：新会话自带新进程组（组长=自身，
    // terminate_child_tree 的 kill(-pid) 整组击杀语义不变），并额外**脱离控制终端**。
    // 只隔离进程组时，探测用的交互式 shell（zsh -lic）若还持有控制终端（如 dev 模式
    // 从终端启动），其作业控制会因处于背景进程组被 SIGTTIN/SIGTTOU 停住，`wait()`
    // 永远等不到退出；脱离终端后 shell 拿不到 /dev/tty，作业控制自动关闭。
    // SAFETY: setsid 是 async-signal-safe；fork 出的子进程继承父进程组、必不是组长，
    // 调用不会因 EPERM 失败。
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

pub(super) fn wait_child_output(
    mut child: std::process::Child,
    deadline: Option<CommandDeadline>,
) -> Result<std::process::Output, String> {
    use std::io::Read;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_handle = stdout_pipe.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });
    let stderr_handle = stderr_pipe.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });

    let status = match deadline {
        None => child
            .wait()
            .map_err(|e| format!("Failed to wait for command: {e}"))?,
        Some(deadline) => {
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => break status,
                    Ok(None) => {
                        let remaining = match deadline.remaining() {
                            Ok(remaining) => remaining,
                            Err(error) => {
                                if terminate_child_tree(&mut child) {
                                    let _ = child.wait();
                                }
                                // Do not join pipe readers on timeout. If tree termination fails,
                                // a descendant may still own the write handle and never produce EOF.
                                drop(stdout_handle);
                                drop(stderr_handle);
                                return Err(error);
                            }
                        };
                        std::thread::sleep(std::cmp::min(
                            std::time::Duration::from_millis(50),
                            remaining,
                        ));
                    }
                    Err(e) => {
                        if terminate_child_tree(&mut child) {
                            let _ = child.wait();
                        }
                        return Err(format!("Failed to wait for command: {e}"));
                    }
                }
            }
        }
    };

    if let Some(deadline) = deadline {
        while stdout_handle
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
            || stderr_handle
                .as_ref()
                .is_some_and(|handle| !handle.is_finished())
        {
            let remaining = match deadline.remaining() {
                Ok(remaining) => remaining,
                Err(error) => {
                    let _ = terminate_child_tree(&mut child);
                    drop(stdout_handle);
                    drop(stderr_handle);
                    return Err(error);
                }
            };
            std::thread::sleep(std::cmp::min(
                std::time::Duration::from_millis(50),
                remaining,
            ));
        }
    }

    let stdout = stdout_handle
        .map(|handle| handle.join().unwrap_or_default())
        .unwrap_or_default();
    let stderr = stderr_handle
        .map(|handle| handle.join().unwrap_or_default())
        .unwrap_or_default();

    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

pub(super) fn apply_extra_env(cmd: &mut std::process::Command, extra_env: &[(&str, String)]) {
    for (key, value) in extra_env {
        cmd.env(key, value);
    }
}

pub(crate) fn run_detected_tool_command_with_timeout(
    tool: &str,
    args: &[&str],
    timeout: Option<std::time::Duration>,
    extra_env: &[(&str, String)],
    working_dir: &Path,
) -> Result<std::process::Output, String> {
    if !VALID_TOOLS.contains(&tool) {
        return Err(format!("Unsupported tool: {tool}"));
    }
    if args.iter().any(|arg| {
        arg.is_empty()
            || !arg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    }) {
        return Err("Invalid tool command arguments".to_string());
    }

    let deadline = CommandDeadline::from_timeout(timeout);

    #[cfg(target_os = "windows")]
    if let Some(distro) = wsl_distro_for_tool(tool) {
        return run_wsl_tool_command(tool, args, &distro, deadline, extra_env, working_dir);
    }

    // Runtime execution only needs the default entry point. Full installation
    // enumeration runs `--version` for every candidate and belongs to diagnostics.
    let tool_path = locate_default_tool(tool, deadline)?;
    let dir = tool_path
        .parent()
        .ok_or_else(|| format!("Invalid {tool} executable path"))?;
    let current_path = std::env::var_os("PATH")
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    {
        run_windows_tool_command_capture(
            &tool_path,
            args,
            &format!("{};{current_path}", dir.display()),
            deadline,
            extra_env,
            working_dir,
        )
    }

    #[cfg(not(target_os = "windows"))]
    {
        use std::process::{Command, Stdio};

        let mut cmd = Command::new(&tool_path);
        cmd.args(args)
            .env("PATH", format!("{}:{current_path}", dir.display()))
            .current_dir(working_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        apply_extra_env(&mut cmd, extra_env);
        isolate_child_process_group(&mut cmd);
        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to run {tool}: {e}"))?;
        wait_child_output(child, deadline)
    }
}

#[cfg(target_os = "windows")]
pub(super) fn run_windows_tool_command_capture(
    tool_path: &Path,
    args: &[&str],
    new_path: &str,
    deadline: Option<CommandDeadline>,
    extra_env: &[(&str, String)],
    working_dir: &Path,
) -> Result<std::process::Output, String> {
    use std::process::{Command, Stdio};

    let mut cmd = if is_windows_command_script(tool_path) {
        let path = tool_path.to_string_lossy();
        let args = args
            .iter()
            .map(|arg| windows_cmd_double_quote_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let command = format!(
            "call {}{}",
            win_quote_path_for_batch(&path),
            if args.is_empty() {
                String::new()
            } else {
                format!(" {args}")
            }
        );
        let mut cmd = Command::new("cmd");
        cmd.args(["/D", "/S", "/C"])
            .raw_arg(&command)
            .env("PATH", new_path)
            .creation_flags(CREATE_NO_WINDOW);
        cmd
    } else {
        let mut cmd = Command::new(tool_path);
        cmd.args(args)
            .env("PATH", new_path)
            .creation_flags(CREATE_NO_WINDOW);
        cmd
    };

    apply_extra_env(&mut cmd, extra_env);
    cmd.current_dir(working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run tool: {e}"))?;
    wait_child_output(child, deadline)
}

/// Convert `\\wsl$\Distro\home\user\...` / `\\wsl.localhost\...` to a Linux path.
#[cfg(target_os = "windows")]
pub(super) fn wsl_unc_path_to_linux(path: &Path) -> Option<String> {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let Component::Prefix(prefix) = components.next()? else {
        return None;
    };
    match prefix.kind() {
        Prefix::UNC(server, _share) | Prefix::VerbatimUNC(server, _share) => {
            let server_name = server.to_string_lossy();
            if !(server_name.eq_ignore_ascii_case("wsl$")
                || server_name.eq_ignore_ascii_case("wsl.localhost"))
            {
                return None;
            }
        }
        _ => return None,
    }

    let mut linux = String::new();
    for component in components {
        match component {
            Component::RootDir => {}
            Component::Normal(part) => {
                linux.push('/');
                linux.push_str(&part.to_string_lossy());
            }
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    if linux.is_empty() {
        None
    } else {
        Some(linux)
    }
}

#[cfg(target_os = "windows")]
pub(super) fn build_wsl_env_argv(extra_env: &[(&str, String)]) -> Result<Vec<String>, String> {
    let mut env_argv = Vec::new();
    for (key, value) in extra_env {
        if key.is_empty()
            || key.contains('=')
            || key.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(format!("invalid env for {key}"));
        }

        let linux_value = if *key == "OPENCODE_CONFIG_DIR" {
            let Some(value) = wsl_unc_path_to_linux(Path::new(value)) else {
                continue;
            };
            value
        } else {
            value.clone()
        };
        if linux_value.chars().any(char::is_control) {
            return Err(format!("invalid env for {key}"));
        }
        env_argv.push(format!("{key}={linux_value}"));
    }
    Ok(env_argv)
}

#[cfg(target_os = "windows")]
pub(super) fn build_wsl_tool_command(
    tool: &str,
    args: &[&str],
    deadline: Option<CommandDeadline>,
) -> Result<String, String> {
    let invocation = std::iter::once(tool)
        .chain(args.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    let command = format!(
        "for flag in -lic -lc -c; do if \"${{SHELL:-sh}}\" \"$flag\" 'command -v {tool}' >/dev/null 2>&1; then exec \"${{SHELL:-sh}}\" \"$flag\" '{invocation}'; fi; done; exit 127"
    );

    let Some(deadline) = deadline else {
        return Ok(command);
    };
    let remaining = deadline.remaining()?;
    let timeout_arg = format!("{:.3}s", remaining.as_secs_f64());
    Ok(format!(
        "command -v timeout >/dev/null 2>&1 || {{ echo 'timeout is required for bounded CLI execution' >&2; exit 127; }}; exec timeout --signal=TERM --kill-after=1s {timeout_arg} sh -c {}",
        shell_single_quote(&command)
    ))
}

#[cfg(target_os = "windows")]
pub(super) fn run_wsl_tool_command(
    tool: &str,
    args: &[&str],
    distro: &str,
    deadline: Option<CommandDeadline>,
    extra_env: &[(&str, String)],
    working_dir: &Path,
) -> Result<std::process::Output, String> {
    use std::process::{Command, Stdio};

    if !is_valid_wsl_distro_name(distro) {
        return Err(format!("[WSL:{distro}] invalid distro name"));
    }

    let command = build_wsl_tool_command(tool, args, deadline)?;
    let linux_working_dir = wsl_unc_path_to_linux(working_dir)
        .ok_or_else(|| format!("[WSL:{distro}] invalid working directory"))?;
    let env_argv = build_wsl_env_argv(extra_env).map_err(|e| format!("[WSL:{distro}] {e}"))?;

    let mut cmd = Command::new("wsl.exe");
    cmd.arg("-d")
        .arg(distro)
        .arg("--cd")
        .arg(linux_working_dir)
        .arg("--");
    if !env_argv.is_empty() {
        cmd.arg("env");
        for item in &env_argv {
            cmd.arg(item);
        }
    }
    cmd.args(["sh", "-c", &command])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| format!("[WSL:{distro}] failed to run {tool}: {e}"))?;
    let output = wait_child_output(child, deadline).map_err(|e| {
        if e.starts_with("Command timed out") {
            format!("[WSL:{distro}] {e}")
        } else {
            e
        }
    })?;
    if output.status.code() == Some(124) {
        return Err(format!(
            "[WSL:{distro}] {}",
            deadline
                .map(CommandDeadline::timeout_error)
                .unwrap_or_else(|| "Command timed out".to_string())
        ));
    }
    Ok(output)
}
