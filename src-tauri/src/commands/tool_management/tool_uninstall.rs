//! Uninstall the detected installation, retaining configuration and user data.
//! Never fall back to a different package manager or delete an arbitrary directory.

#[cfg(not(target_os = "windows"))]
use super::installations::parent_dir;
#[cfg(target_os = "windows")]
use super::installations::wsl_distro_for_tool;
use super::installations::{
    default_install, enumerate_tool_installations, mcode_receipt_install_root,
    mcode_script_install_root, McodeLayout, ToolInstallation,
};
use super::lifecycle::run_tool_lifecycle_silently;
#[cfg(not(target_os = "windows"))]
use super::lifecycle::sibling_bin;
#[cfg(target_os = "windows")]
use super::lifecycle::sibling_bin_with_ext;
use super::lifecycle::{
    finish_lifecycle_output, is_native_executable, npm_package_for, tool_display_name,
    ToolUninstallPlan,
};
use super::paths::resolve_path_default;
#[cfg(target_os = "windows")]
use super::paths::windows_shell_compatible_path;
use super::process::{
    decode_command_output, wait_child_output, CommandDeadline, INSTALL_PROBE_TIMEOUT,
};
use super::terminal::{default_flag_for_shell, is_valid_shell, shell_single_quote};
#[cfg(target_os = "windows")]
use super::terminal::{
    is_valid_shell_flag, is_valid_wsl_distro_name, win_quote_path_for_batch,
    windows_cmd_double_quote_arg,
};
#[cfg(test)]
use super::versions::wsl_auto_shell_command;
#[cfg(any(target_os = "windows", test))]
use super::versions::WSL_AUTO_SHELL_FLAGS;
use super::WslShellPreferenceInput;
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;

pub(super) fn plan(
    tool: &str,
    pref: Option<&WslShellPreferenceInput>,
) -> Result<ToolUninstallPlan, String> {
    #[cfg(target_os = "windows")]
    if let Some(distro) = wsl_distro_for_tool(tool) {
        return wsl_plan(tool, &distro, pref);
    }
    let _ = pref;
    let installs = enumerate_tool_installations(tool);
    let inst = default_install(&installs).ok_or_else(|| {
        format!("Cannot identify the installation of {} to uninstall. Check installations and try again.", tool_display_name(tool))
    })?;
    plan_for_install(tool, inst)
}

fn plan_for_install(tool: &str, inst: &ToolInstallation) -> Result<ToolUninstallPlan, String> {
    let (command, native) = if let Some(command) = package_uninstall_command(tool, inst)? {
        (command, false)
    } else if known_native_install(tool, inst) {
        let mut paths = vec![inst.real.to_string_lossy().into_owned()];
        if Path::new(&inst.path) != inst.real {
            paths.push(inst.path.clone());
        }
        // Display the equivalent file operation; execution uses remove_file, never a shell.
        #[cfg(target_os = "windows")]
        let command = format!(
            "Remove-Item -LiteralPath {}",
            paths
                .iter()
                .map(|p| format!("'{}'", p.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(", ")
        );
        #[cfg(not(target_os = "windows"))]
        let command = format!(
            "rm -- {}",
            paths.iter().map(|p| quote(p)).collect::<Vec<_>>().join(" ")
        );
        (command, true)
    } else {
        return Err(format!(
            "Cannot automatically uninstall {} at {}. Use the original installer or package manager to uninstall it.",
            tool_display_name(tool), inst.path
        ));
    };
    let command = if tool == "openclaw" {
        // The official CLI removes only the Gateway service with this scope.
        // Stop on failure; config, sessions and workspaces must remain untouched.
        #[cfg(target_os = "windows")]
        let next = "call ";
        #[cfg(not(target_os = "windows"))]
        let next = "";
        format!(
            "{} uninstall --service --yes --non-interactive && {next}{command}",
            quote(&inst.path)
        )
    } else {
        command
    };
    Ok(ToolUninstallPlan {
        tool: tool.into(),
        path: inst.path.clone(),
        real_path: inst.real.to_string_lossy().into_owned(),
        command,
        native,
        wsl_distro: None,
    })
}

pub(super) fn uninstall(
    tool: &str,
    pref: Option<&WslShellPreferenceInput>,
    confirmed: &ToolUninstallPlan,
) -> Result<(), String> {
    // Never execute a command supplied by the frontend or silently switch installations
    // while the dialog is open / this task is queued behind another lifecycle operation.
    #[cfg(target_os = "windows")]
    if let Some(distro) = wsl_distro_for_tool(tool) {
        // Run the very process the re-derived plan describes (same shell and flag).
        let (current, mut process) = wsl_plan_and_process(tool, &distro, pref)?;
        validate_confirmed_plan(&current, confirmed)?;
        let output = process
            .output()
            .map_err(|e| format!("Cannot start WSL uninstall: {e}"))?;
        return finish_lifecycle_output(&output);
    }
    let current = plan(tool, pref)?;
    validate_confirmed_plan(&current, confirmed)?;
    if current.native {
        remove_native_executable(&ToolInstallation {
            path: current.path.clone(),
            real: PathBuf::from(&current.real_path),
            version: None,
            runnable: false,
            error: None,
            source: "system".into(),
            is_path_default: true,
        })?;
    } else {
        run_package_uninstall(&current.command)?;
    }
    // Some managers return zero even if the selected package was not removed.
    verify_removed(tool, &current.path)
}

fn run_package_uninstall(command: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let batch = format!("@chcp 65001>nul\r\n@echo off\r\ncall {command}\r\nexit /b %errorlevel%");
    #[cfg(target_os = "windows")]
    let command = batch.as_str();
    run_tool_lifecycle_silently(command, "tool_uninstall")
}

fn validate_confirmed_plan(
    current: &ToolUninstallPlan,
    confirmed: &ToolUninstallPlan,
) -> Result<(), String> {
    if current != confirmed {
        return Err("Installation changed since the uninstall preview. Check installations and confirm again.".into());
    }
    Ok(())
}

fn verify_removed(tool: &str, path: &str) -> Result<(), String> {
    // exists() follows symlinks and would report a dangling manager shim as removed.
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot verify removal of {path}: {error}")),
        Ok(_) => Err(format!(
            "{} is still installed at {}. Use the original installer or package manager to uninstall it.",
            tool_display_name(tool), path
        )),
    }
}

fn brew_uninstall_command(tool: &str, real: &str) -> Result<Option<String>, String> {
    for (marker, flag) in [("/Caskroom/", "--cask"), ("/Cellar/", "--formula")] {
        if let Some((prefix, rest)) = real.split_once(marker) {
            let token = rest.split('/').next().unwrap_or_default();
            let owners: &[(&str, &str)] = match tool {
                "claude" => &[
                    ("/Caskroom/", "claude-code"),
                    ("/Caskroom/", "claude-code@latest"),
                ],
                "codex" => &[("/Caskroom/", "codex")],
                "gemini" => &[("/Cellar/", "gemini-cli")],
                "opencode" => &[("/Cellar/", "opencode")],
                _ => &[],
            };
            if !owners.contains(&(marker, token)) {
                return Err(format!("Cannot automatically uninstall {}: Homebrew package {token} is not a verified owner. Use the original installer or package manager.", tool_display_name(tool)));
            }
            let brew = format!("{prefix}/bin/brew");
            if !Path::new(&brew).is_file() {
                return Err(format!("Cannot find the Homebrew executable at {brew}. Use the original package manager to uninstall this application."));
            }
            return Ok(Some(format!(
                "{} uninstall {flag} {}",
                quote(&brew),
                quote(token)
            )));
        }
    }
    Ok(None)
}

fn package_uninstall_command(
    tool: &str,
    inst: &ToolInstallation,
) -> Result<Option<String>, String> {
    // Check Homebrew ownership before npm: formulae can contain lib/node_modules.
    if let Some(command) =
        brew_uninstall_command(tool, &inst.real.to_string_lossy().replace('\\', "/"))?
    {
        return Ok(Some(command));
    }
    if tool == "hermes" {
        // The official installer uses a uv venv, often without pip. Let the selected
        // CLI remove its own installation; omitting --full retains config and data.
        return Ok(Some(format!("{} uninstall --yes", quote(&inst.path))));
    }
    Ok(node_package_uninstall_command(tool, inst))
}

fn quote(value: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        win_quote_path_for_batch(value)
    }
    #[cfg(not(target_os = "windows"))]
    {
        shell_single_quote(value)
    }
}

fn manager_next_to(entry: &str, manager: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        sibling_bin_with_ext(entry, manager, &["cmd", "exe"])
    }
    #[cfg(not(target_os = "windows"))]
    {
        let path = sibling_bin(entry, manager)?;
        Path::new(&path).is_file().then_some(path)
    }
}

/// Read package metadata instead of assuming every script or native binary is npm-owned.
/// The explicit prefix also supports user npm prefixes without a sibling npm executable.
fn npm_prefix(tool: &str, inst: &ToolInstallation) -> Option<PathBuf> {
    npm_prefix_for_layout(tool, inst, cfg!(target_os = "windows"))
}

fn npm_prefix_for_layout(tool: &str, inst: &ToolInstallation, windows: bool) -> Option<PathBuf> {
    let package = npm_package_for(tool)?;
    let launcher = Path::new(&inst.path);
    let bin = launcher.parent()?;
    // A local node_modules/.bin entry is never a global npm launcher. Pi's
    // managed releases use precisely that layout, even though they contain npm metadata.
    let prefix = if windows {
        if bin.file_name().is_some_and(|name| name == ".bin") {
            return None;
        }
        bin
    } else {
        if bin.file_name()? != "bin" {
            return None;
        }
        bin.parent()?
    };
    let modules = prefix.join(if windows {
        "node_modules"
    } else {
        "lib/node_modules"
    });
    let package_dir = std::fs::canonicalize(modules.join(package)).ok()?;
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package_dir.join("package.json")).ok()?).ok()?;
    if value.get("name").and_then(|name| name.as_str()) != Some(package) {
        return None;
    }
    let owns_target = inst.real.starts_with(&package_dir);
    // Windows npm shims are files, not symlinks. Their package reference is
    // required as well as the manifest and the global launcher layout.
    let owns_shim = windows
        && !is_native_executable(launcher)
        && std::fs::read_to_string(launcher).is_ok_and(|script| {
            script
                .replace('\\', "/")
                .contains(&format!("node_modules/{package}/"))
        });
    (owns_target || owns_shim).then(|| prefix.to_path_buf())
}

fn node_package_uninstall_command(tool: &str, inst: &ToolInstallation) -> Option<String> {
    let package = npm_package_for(tool)?;
    // A source badge or a sibling manager is not proof of package ownership.
    // pnpm/Bun commands remain available manually for the clients that document
    // them; until their global roots are verified, do not guess or fall back to npm.
    // Homebrew/mise can also supply Node itself: after excluding their own
    // formulae and shims, an independently verified npm layout is still valid.
    if !matches!(
        inst.source.as_str(),
        "system" | "nvm" | "fnm" | "homebrew" | "mise"
    ) {
        return None;
    }
    if tool == "mcode"
        && (mcode_receipt_install_root(&inst.path, McodeLayout::NATIVE).is_some()
            || mcode_script_install_root(
                &inst.path,
                &inst.real.to_string_lossy(),
                McodeLayout::NATIVE,
            )
            .is_some())
    {
        return None;
    }
    let prefix = npm_prefix(tool, inst)?;
    let npm = manager_next_to(&inst.path, "npm").or_else(|| {
        resolve_path_default(
            "npm",
            CommandDeadline::from_timeout(Some(INSTALL_PROBE_TIMEOUT)),
        )
        .ok()
        .flatten()
        .filter(|path| path.is_file())
        .map(|path| {
            // PATH lookup canonicalizes Windows paths; batch `call` rejects verbatim paths.
            #[cfg(target_os = "windows")]
            let path = windows_shell_compatible_path(&path);
            path.to_string_lossy().into_owned()
        })
    })?;
    let command = format!(
        "{} uninstall -g --prefix {} {package}",
        quote(&npm),
        quote(&prefix.to_string_lossy())
    );
    #[cfg(not(target_os = "windows"))]
    let command = if Path::new(&npm).is_absolute() {
        format!("PATH={}:\"$PATH\" {command}", quote(&parent_dir(&npm)))
    } else {
        command
    };
    Some(command)
}

fn known_native_install(tool: &str, inst: &ToolInstallation) -> bool {
    if inst.source != "system" {
        return false;
    }
    let real = inst.real.to_string_lossy();
    let normalized = real.replace('\\', "/").to_ascii_lowercase();
    if normalized.contains("/node_modules/") || !is_native_executable(&inst.real) {
        return false;
    }
    match tool {
        "claude" => {
            normalized
                .split_once("/.local/share/claude/versions/")
                .is_some_and(|(_, version)| !version.is_empty() && !version.contains('/'))
                || normalized.ends_with("/.local/bin/claude")
                || normalized.ends_with("/.local/bin/claude.exe")
        }
        "codex" => normalized
            .split_once("/packages/standalone/releases/")
            .and_then(|(_, release)| release.split_once('/'))
            .is_some_and(|(version, binary)| {
                !version.is_empty()
                    && matches!(
                        binary,
                        "bin/codex" | "bin/codex.exe" | "codex" | "codex.exe"
                    )
            }),
        "grok" => {
            normalized.ends_with("/.grok/bin/grok")
                || normalized.ends_with("/.grok/bin/grok.exe")
                || normalized
                    .split_once("/.grok/downloads/")
                    .is_some_and(|(_, binary)| {
                        matches!(
                            binary,
                            "grok-macos-aarch64"
                                | "grok-macos-x86_64"
                                | "grok-linux-aarch64"
                                | "grok-linux-x86_64"
                                | "grok-windows-aarch64.exe"
                                | "grok-windows-x86_64.exe"
                        )
                    })
        }
        // The current curl installer (including Git Bash on Windows) uses this
        // directory. Do not invent OPENCODE_INSTALL_DIR / XDG_BIN_DIR layouts.
        "opencode" => {
            normalized.ends_with("/.opencode/bin/opencode")
                || normalized.ends_with("/.opencode/bin/opencode.exe")
        }
        _ => false,
    }
}

/// Remove only the selected executable and its launcher. No recursive deletion:
/// native installers may keep settings, sessions and projects next to their binaries.
fn remove_native_executable(inst: &ToolInstallation) -> Result<(), String> {
    let entry = Path::new(&inst.path);
    // Validate both paths before changing either. A replaced symlink must not delete a new target.
    if std::fs::canonicalize(entry).map_err(|e| e.to_string())? != inst.real {
        return Err(
            "Installation changed during uninstall. Check installations and try again.".into(),
        );
    }
    for path in [inst.real.as_path(), entry] {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
                std::fs::remove_file(path)
                    .map_err(|e| format!("Cannot remove {}: {e}", path.display()))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Err(format!("Refusing to remove directory {}", path.display())),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn wsl_plan(
    tool: &str,
    distro: &str,
    pref: Option<&WslShellPreferenceInput>,
) -> Result<ToolUninstallPlan, String> {
    wsl_plan_and_process(tool, distro, pref).map(|(plan, _)| plan)
}

/// The plan plus the exact process it describes. Without an explicit shell, the probe
/// tries the version check's flags in order and the removal reuses the winning flag.
#[cfg(target_os = "windows")]
fn wsl_plan_and_process(
    tool: &str,
    distro: &str,
    pref: Option<&WslShellPreferenceInput>,
) -> Result<(ToolUninstallPlan, std::process::Command), String> {
    let shell = WslShell::from_pref(pref)?;
    let probe = wsl_probe_script(tool);
    let child = wsl_process(distro, &shell.probe_args(&probe))?
        .spawn()
        .map_err(|e| format!("Cannot inspect WSL installation: {e}"))?;
    let output = wait_child_output(
        child,
        CommandDeadline::from_timeout(Some(INSTALL_PROBE_TIMEOUT)),
    )?;
    finish_lifecycle_output(&output)?;
    let stdout = decode_command_output(&output.stdout);
    let (path, real_path) = parse_wsl_installation(&stdout)?;
    let auto_flag = match shell {
        WslShell::Explicit { .. } => None,
        WslShell::Auto { .. } => Some(parse_wsl_shell_flag(&stdout)?),
    };
    let script = wsl_uninstall_command(tool, &path, &real_path)?;
    let process = wsl_process(distro, &shell.run_args(&script, auto_flag))?;
    let command = format!(
        "wsl.exe {}",
        process
            .get_args()
            .map(|arg| windows_cmd_double_quote_arg(&arg.to_string_lossy()))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let plan = ToolUninstallPlan {
        tool: tool.into(),
        path,
        real_path,
        command,
        native: false,
        wsl_distro: Some(distro.into()),
    };
    Ok((plan, process))
}

#[cfg(any(target_os = "windows", test))]
fn wsl_probe_script(tool: &str) -> String {
    format!(
        "sh -c {}",
        shell_single_quote(&format!(
            "entry=$(command -v {tool}) && real=$(readlink -f -- \"$entry\") && [ -f \"$real\" ] && printf '__LOLICODE_UNINSTALL__\\n%s\\n%s\\n' \"$entry\" \"$real\""
        ))
    )
}

#[cfg(any(target_os = "windows", test))]
const WSL_SHELL_FLAG_MARKER: &str = "__LOLICODE_SHELL_FLAG__ ";

/// Auto mode probe, run by an outer `sh -c`: `$1` is the probe, the remaining
/// arguments are flags. Like the version check, try each flag in `$SHELL` until
/// one succeeds (stderr kept only for the last), then report which flag won.
#[cfg(any(target_os = "windows", test))]
const WSL_SHELL_PROBE_LAUNCHER: &str = r#"s=${SHELL:-sh}; script=$1; shift; while [ $# -gt 1 ]; do out=$("$s" "$1" "$script" 2>/dev/null) && { printf '__LOLICODE_SHELL_FLAG__ %s\n%s\n' "$1" "$out"; exit 0; }; shift; done; out=$("$s" "$1" "$script") && printf '__LOLICODE_SHELL_FLAG__ %s\n%s\n' "$1" "$out""#;

/// Auto mode removal: run `$1` in `$SHELL` with exactly the probe's flag `$2`.
/// Never retry with another flag; a different environment could reach another copy.
#[cfg(any(target_os = "windows", test))]
const WSL_SHELL_RUN_LAUNCHER: &str = r#"s=${SHELL:-sh}; exec "$s" "$2" "$1""#;

#[cfg(any(target_os = "windows", test))]
fn parse_wsl_shell_flag(stdout: &str) -> Result<&'static str, String> {
    let flag = stdout
        .rsplit_once(WSL_SHELL_FLAG_MARKER)
        .and_then(|(_, rest)| rest.lines().next())
        .map(str::trim);
    WSL_AUTO_SHELL_FLAGS
        .into_iter()
        .find(|known| Some(*known) == flag)
        .ok_or_else(|| {
            "Cannot identify the WSL shell. Use the original installer to uninstall it.".into()
        })
}

/// The shell WSL commands run in: the user's preference, or the version check's
/// auto mode (`$SHELL` with `WSL_AUTO_SHELL_FLAGS`, or one preferred flag).
#[cfg(target_os = "windows")]
enum WslShell<'a> {
    Explicit { shell: &'a str, flag: &'a str },
    Auto { flag: Option<&'a str> },
}

#[cfg(target_os = "windows")]
impl<'a> WslShell<'a> {
    fn from_pref(pref: Option<&'a WslShellPreferenceInput>) -> Result<Self, String> {
        let flag = pref.and_then(|p| p.wsl_shell_flag.as_deref());
        let shell = match pref.and_then(|p| p.wsl_shell.as_deref()) {
            Some(shell) => {
                let shell = shell.rsplit('/').next().unwrap_or(shell);
                if !is_valid_shell(shell) {
                    return Err(format!("Invalid WSL shell: {shell}"));
                }
                WslShell::Explicit {
                    shell,
                    flag: flag.unwrap_or_else(|| default_flag_for_shell(shell)),
                }
            }
            None => WslShell::Auto { flag },
        };
        if let WslShell::Explicit { flag, .. } | WslShell::Auto { flag: Some(flag) } = &shell {
            if !is_valid_shell_flag(flag) {
                return Err(format!("Invalid WSL shell flag: {flag}"));
            }
        }
        Ok(shell)
    }

    fn probe_args<'s>(&'s self, script: &'s str) -> Vec<&'s str> {
        match self {
            WslShell::Explicit { shell, flag } => vec![*shell, *flag, script],
            WslShell::Auto { flag } => {
                let mut args = vec!["sh", "-c", WSL_SHELL_PROBE_LAUNCHER, "cc-switch", script];
                match flag {
                    Some(flag) => args.push(*flag),
                    None => args.extend(WSL_AUTO_SHELL_FLAGS),
                }
                args
            }
        }
    }

    fn run_args<'s>(&'s self, script: &'s str, auto_flag: Option<&'static str>) -> Vec<&'s str> {
        match self {
            WslShell::Explicit { shell, flag } => vec![*shell, *flag, script],
            WslShell::Auto { .. } => vec![
                "sh",
                "-c",
                WSL_SHELL_RUN_LAUNCHER,
                "cc-switch",
                script,
                auto_flag.unwrap_or("-c"),
            ],
        }
    }
}

#[cfg(target_os = "windows")]
fn wsl_process(distro: &str, shell_args: &[&str]) -> Result<std::process::Command, String> {
    if !is_valid_wsl_distro_name(distro) {
        return Err(format!("Invalid WSL distro name: {distro}"));
    }
    // Pass an argv directly and use --exec: cmd.exe / WSL's implicit shell must
    // not expand $entry or command substitutions before the chosen shell runs.
    let mut process = std::process::Command::new("wsl.exe");
    process
        .args(["-d", distro, "--exec"])
        .args(shell_args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    Ok(process)
}

#[cfg(any(target_os = "windows", test))]
fn parse_wsl_installation(stdout: &str) -> Result<(String, String), String> {
    let mut lines = stdout
        .rsplit_once("__LOLICODE_UNINSTALL__\n")
        .map(|(_, paths)| paths.lines())
        .ok_or(
            "Cannot identify the WSL installation. Use the original installer to uninstall it.",
        )?;
    let path = lines.next().unwrap_or_default();
    let real = lines.next().unwrap_or_default();
    if !path.starts_with('/') || !real.starts_with('/') || lines.next().is_some() {
        return Err("Cannot identify the WSL installation paths. Use the original installer to uninstall it.".into());
    }
    Ok((path.into(), real.into()))
}

#[cfg(any(target_os = "windows", test))]
fn wsl_uninstall_command(tool: &str, path: &str, real: &str) -> Result<String, String> {
    if real.contains("/Cellar/") || real.contains("/Caskroom/") {
        // WSL support is limited to verified npm prefixes and Hermes' own uninstaller.
        // A formula's libexec/node_modules must not fall through to npm.
        return Err("Use Homebrew to uninstall this WSL application.".into());
    }
    let removal = if tool == "hermes" {
        format!("{} uninstall --yes", shell_single_quote(path))
    } else {
        let package = npm_package_for(tool)
            .ok_or("Use the original installer to uninstall this WSL application.")?;
        let (prefix, _) = real
            .split_once(&format!("/lib/node_modules/{package}/"))
            .filter(|(prefix, _)| !prefix.is_empty() && path == format!("{prefix}/bin/{tool}"))
            .ok_or(
                "Use the original installer or package manager to uninstall this WSL application.",
            )?;
        format!(
            "npm uninstall -g --prefix {} {package}",
            shell_single_quote(prefix)
        )
    };
    let removal = if tool == "openclaw" {
        format!(
            "{} uninstall --service --yes --non-interactive && {removal}",
            shell_single_quote(path)
        )
    } else {
        removal
    };
    // The outer shell may be fish. All POSIX syntax stays inside an explicit sh.
    // Recheck the target just before running; do not accept a dangling shim as success.
    let script = format!(
        "entry={} && [ \"$(command -v {tool})\" = \"$entry\" ] && [ \"$(readlink -f -- \"$entry\")\" = {} ] && {removal} && {{ {{ [ ! -e \"$entry\" ] && [ ! -L \"$entry\" ]; }} || {{ echo 'Application is still installed' >&2; exit 1; }}; }}",
        shell_single_quote(path), shell_single_quote(real)
    );
    Ok(format!("sh -c {}", shell_single_quote(&script)))
}

#[cfg(test)]
mod tests;
