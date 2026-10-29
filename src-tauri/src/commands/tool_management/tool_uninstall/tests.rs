use super::*;

fn installation(path: &Path) -> ToolInstallation {
    ToolInstallation {
        path: path.to_string_lossy().into_owned(),
        real: std::fs::canonicalize(path).unwrap(),
        version: None,
        runnable: false,
        error: None,
        source: "system".into(),
        is_path_default: true,
    }
}

fn write_fixture_npm(entry: &Path) -> PathBuf {
    let npm = entry
        .parent()
        .unwrap()
        .join(if cfg!(target_os = "windows") {
            "npm.cmd"
        } else {
            "npm"
        });
    std::fs::write(&npm, "fixture manager").unwrap();
    npm
}

#[test]
fn npm_uninstall_uses_verified_package_and_exact_prefix() {
    let temp = tempfile::tempdir().unwrap();
    let prefix = temp.path().join("custom npm prefix");
    #[cfg(target_os = "windows")]
    let modules = prefix.join("node_modules");
    #[cfg(not(target_os = "windows"))]
    let modules = prefix.join("lib/node_modules");
    let package = modules.join("@openai/codex");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(package.join("package.json"), r#"{"name":"@openai/codex"}"#).unwrap();
    let executable = package.join("codex.js");
    std::fs::write(&executable, "launcher").unwrap();
    #[cfg(target_os = "windows")]
    let entry = prefix.join("codex.cmd");
    #[cfg(not(target_os = "windows"))]
    let entry = prefix.join("bin/codex");
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    std::fs::write(
        &entry,
        r#"node "%dp0%\node_modules\@openai\codex\codex.js""#,
    )
    .unwrap();
    let inst = ToolInstallation {
        real: if cfg!(target_os = "windows") {
            std::fs::canonicalize(&entry).unwrap()
        } else {
            std::fs::canonicalize(&executable).unwrap()
        },
        ..installation(&entry)
    };
    write_fixture_npm(&entry);
    let command = package_uninstall_command("codex", &inst).unwrap().unwrap();
    assert!(command.contains("uninstall -g --prefix"));
    assert!(command.contains(&quote(&prefix.to_string_lossy())));
    assert!(command.ends_with("@openai/codex"));
    for source in ["homebrew", "mise", "nvm", "fnm"] {
        let managed_node = ToolInstallation {
            source: source.into(),
            real: inst.real.clone(),
            ..installation(&entry)
        };
        assert_eq!(
            package_uninstall_command("codex", &managed_node)
                .unwrap()
                .unwrap(),
            command
        );
    }
    std::fs::write(
        package.join("package.json"),
        r#"{"name":"another-package"}"#,
    )
    .unwrap();
    assert!(package_uninstall_command("codex", &inst).unwrap().is_none());
}

#[cfg(target_os = "windows")]
#[test]
fn windows_npm_path_fallback_uses_batch_compatible_path() {
    use std::os::windows::process::CommandExt;

    const FIXTURE_ROOT: &str = "CC_SWITCH_TEST_NPM_UNINSTALL_ROOT";
    if let Some(root) = std::env::var_os(FIXTURE_ROOT) {
        let root = PathBuf::from(root);
        let prefix = root.join("custom npm prefix");
        let entry = prefix.join("codex.cmd");
        let npm = root.join("Program Files").join("nodejs").join("npm.cmd");
        let marker = npm.with_file_name("npm-args.txt");
        let inst = installation(&entry);
        assert!(manager_next_to(&inst.path, "npm").is_none());

        let resolved = resolve_path_default(
            "npm",
            CommandDeadline::from_timeout(Some(INSTALL_PROBE_TIMEOUT)),
        )
        .unwrap()
        .expect("npm should resolve from the separate PATH directory");
        assert_eq!(resolved, std::fs::canonicalize(&npm).unwrap());
        assert!(resolved.to_string_lossy().starts_with(r"\\?\"));

        let plan = plan_for_install("codex", &inst).unwrap();
        let arguments = format!(
            "uninstall -g --prefix {} @openai/codex",
            quote(&prefix.to_string_lossy())
        );
        // PATH lookup expands 8.3 aliases (e.g. RUNNER~1) before removing the
        // verbatim prefix, so the batch path may differ from the fixture spelling.
        let npm_for_batch = windows_shell_compatible_path(&resolved);
        assert_eq!(
            plan.command,
            format!("{} {arguments}", quote(&npm_for_batch.to_string_lossy()))
        );
        assert!(!plan.native);
        assert!(!plan.command.contains(r"\\?\"));
        assert!(!marker.exists(), "planning must not execute npm");

        run_package_uninstall(&plan.command).expect("PATH npm.cmd should execute via batch call");
        assert_eq!(std::fs::read_to_string(marker).unwrap().trim(), arguments);
        return;
    }

    let temp = tempfile::tempdir().unwrap();
    let prefix = temp.path().join("custom npm prefix");
    let package = prefix.join("node_modules/@openai/codex");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(package.join("package.json"), r#"{"name":"@openai/codex"}"#).unwrap();
    std::fs::write(
        prefix.join("codex.cmd"),
        "@echo off\r\nrem node_modules/@openai/codex/codex.js\r\n",
    )
    .unwrap();
    let node_dir = temp.path().join("Program Files").join("nodejs");
    std::fs::create_dir_all(&node_dir).unwrap();
    std::fs::write(
        node_dir.join("npm.cmd"),
        "@echo off\r\n>\"%~dp0npm-args.txt\" echo %*\r\nexit /b 0\r\n",
    )
    .unwrap();

    // Isolate PATH in a child test process so parallel tests keep their environment.
    let inherited_path = std::env::var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths(
        std::iter::once(node_dir.clone()).chain(std::env::split_paths(&inherited_path)),
    )
    .unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "commands::tool_management::tool_uninstall::tests::windows_npm_path_fallback_uses_batch_compatible_path",
            "--nocapture",
        ])
        .env(FIXTURE_ROOT, temp.path())
        .env("PATH", path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "PATH fallback regression failed:\n{}\n{}",
        decode_command_output(&output.stdout),
        decode_command_output(&output.stderr)
    );
    assert!(node_dir.join("npm-args.txt").is_file());
}

#[test]
fn unknown_executable_is_not_removed_or_assumed_to_be_npm() {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("codex.exe");
    std::fs::write(&executable, "MZ").unwrap();
    let inst = installation(&executable);
    assert!(package_uninstall_command("codex", &inst).unwrap().is_none());
    assert!(!known_native_install("codex", &inst));
    assert!(executable.exists());
}

#[test]
fn nearby_npm_package_does_not_claim_an_unrelated_executable() {
    let temp = tempfile::tempdir().unwrap();
    let package = temp.path().join("node_modules/@openai/codex");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(package.join("package.json"), r#"{"name":"@openai/codex"}"#).unwrap();
    let executable = temp.path().join("codex.cmd");
    std::fs::write(&executable, "unrelated launcher").unwrap();
    assert!(npm_prefix("codex", &installation(&executable)).is_none());
    std::fs::write(
        &executable,
        r#"node "%dp0%\node_modules\@openai\codex\bin\codex.js""#,
    )
    .unwrap();
    assert_eq!(
        npm_prefix_for_layout("codex", &installation(&executable), true),
        Some(temp.path().to_path_buf())
    );
}

#[test]
fn npm_layout_rejects_local_dependencies_and_installer_launchers() {
    for windows in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let release = temp.path().join(".pi/agent/install/releases/1.0");
        let package = release.join("node_modules/@earendil-works/pi-coding-agent");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@earendil-works/pi-coding-agent"}"#,
        )
        .unwrap();
        let executable = package.join("cli.js");
        std::fs::write(&executable, "launcher").unwrap();
        let local_bin = release.join("node_modules/.bin/pi");
        std::fs::create_dir_all(local_bin.parent().unwrap()).unwrap();
        std::fs::write(&local_bin, "launcher").unwrap();
        let inst = ToolInstallation {
            real: std::fs::canonicalize(&executable).unwrap(),
            ..installation(&local_bin)
        };
        assert!(npm_prefix_for_layout("pi", &inst, windows).is_none());
        // Even a direct package target is not a global installation.
        assert!(npm_prefix_for_layout("pi", &installation(&executable), windows).is_none());

        let bin = temp.path().join(".local/bin/pi");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "#!/bin/sh\nexec release/node_modules/.bin/pi").unwrap();
        assert!(npm_prefix_for_layout("pi", &installation(&bin), windows).is_none());
    }
}

#[test]
fn posix_npm_layout_requires_lib_modules_and_a_matching_global_bin() {
    let temp = tempfile::tempdir().unwrap();
    let prefix = temp.path().join("custom prefix");
    let package = prefix.join("lib/node_modules/@openai/codex");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(package.join("package.json"), r#"{"name":"@openai/codex"}"#).unwrap();
    let executable = package.join("codex.js");
    std::fs::write(&executable, "launcher").unwrap();
    let inst = ToolInstallation {
        path: prefix.join("bin/codex").to_string_lossy().into_owned(),
        ..installation(&executable)
    };
    assert_eq!(npm_prefix_for_layout("codex", &inst, false), Some(prefix));
    let unrelated = ToolInstallation {
        path: temp.path().join("bin/codex").to_string_lossy().into_owned(),
        ..inst
    };
    assert!(npm_prefix_for_layout("codex", &unrelated, false).is_none());
}

#[test]
fn source_badges_and_sibling_managers_do_not_prove_package_ownership() {
    for (tool, manager) in [
        ("codex", "volta"),
        ("opencode", "pnpm"),
        ("openclaw", "bun"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let entry = temp.path().join(format!("{tool}.cmd"));
        std::fs::write(&entry, "unrelated launcher").unwrap();
        for suffix in ["", ".cmd", ".exe"] {
            std::fs::write(temp.path().join(format!("{manager}{suffix}")), "manager").unwrap();
        }
        let inst = ToolInstallation {
            source: manager.into(),
            ..installation(&entry)
        };
        assert!(plan_for_install(tool, &inst).is_err());
        assert!(entry.exists());
    }
}

#[test]
fn minimax_installer_receipt_does_not_imply_a_native_or_global_npm_install() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("custom minimax");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("install.json"),
        serde_json::json!({
            "product": "minimax-code", "updateOwner": "npm-prefix", "prefix": root,
        })
        .to_string(),
    )
    .unwrap();
    #[cfg(target_os = "windows")]
    let entry = root.join("mcode.cmd");
    #[cfg(not(target_os = "windows"))]
    let entry = root.join("bin/mcode");
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    for contents in ["#!/bin/sh\nexec release/mcode", "MZ"] {
        std::fs::write(&entry, contents).unwrap();
        assert!(plan_for_install("mcode", &installation(&entry)).is_err());
    }
}

#[test]
fn openclaw_removes_only_the_service_before_its_npm_package() {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(target_os = "windows")]
    let modules = temp.path().join("node_modules");
    #[cfg(not(target_os = "windows"))]
    let modules = temp.path().join("lib/node_modules");
    let package = modules.join("openclaw");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(package.join("package.json"), r#"{"name":"openclaw"}"#).unwrap();
    let executable = package.join("openclaw.mjs");
    std::fs::write(&executable, "launcher").unwrap();
    #[cfg(target_os = "windows")]
    let entry = temp.path().join("openclaw.cmd");
    #[cfg(not(target_os = "windows"))]
    let entry = temp.path().join("bin/openclaw");
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    std::fs::write(&entry, "node node_modules/openclaw/openclaw.mjs").unwrap();
    let inst = ToolInstallation {
        real: if cfg!(target_os = "windows") {
            std::fs::canonicalize(&entry).unwrap()
        } else {
            std::fs::canonicalize(executable).unwrap()
        },
        ..installation(&entry)
    };
    write_fixture_npm(&entry);
    let plan = plan_for_install("openclaw", &inst).unwrap();
    assert!(plan.command.starts_with(&format!(
        "{} uninstall --service --yes --non-interactive && ",
        quote(&inst.path)
    )));
    assert!(plan.command.contains("uninstall -g --prefix"));
    for flag in ["--all", "--state", "--workspace", "--app"] {
        assert!(!plan.command.contains(flag));
    }
    assert!(
        entry.exists(),
        "planning must not execute the service uninstaller"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn windows_service_failure_blocks_package_removal_and_success_continues() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("prefix with spaces");
    let package = root.join("node_modules/openclaw");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(package.join("package.json"), r#"{"name":"openclaw"}"#).unwrap();
    let entry = root.join("openclaw.cmd");
    let marker = root.join("npm-ran.txt");
    let npm = root.join("npm.cmd");
    std::fs::write(
        &npm,
        format!(
            "@echo off\r\necho removed>\"{}\"\r\nexit /b 0\r\n",
            marker.display()
        ),
    )
    .unwrap();
    for exit_code in [23, 0] {
        // The package reference models an npm .cmd shim without running a real CLI.
        std::fs::write(
            &entry,
            format!(
                "@echo off\r\nrem node_modules/openclaw/openclaw.mjs\r\nexit /b {exit_code}\r\n"
            ),
        )
        .unwrap();
        let plan = plan_for_install("openclaw", &installation(&entry)).unwrap();
        let result = run_package_uninstall(&plan.command);
        assert_eq!(result.is_ok(), exit_code == 0);
        assert_eq!(marker.exists(), exit_code == 0);
    }
}

#[test]
fn wsl_uninstall_checks_the_selected_linux_prefix() {
    let command = wsl_uninstall_command(
        "codex",
        "/usr/local/bin/codex",
        "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
    )
    .unwrap();
    assert!(command.starts_with("sh -c '"));
    assert!(command.contains("command -v codex"));
    assert!(command.contains("/lib/node_modules/@openai/codex/"));
    assert!(command.contains("npm uninstall -g --prefix"));
    assert!(!command.contains("call "));
    assert!(command.contains("[ ! -L"));
    assert!(wsl_uninstall_command(
        "codex",
        "/usr/local/bin/codex",
        "/usr/local/Cellar/mise/1/bin/mise"
    )
    .is_err());
    let hermes = wsl_uninstall_command(
        "hermes",
        "/home/me/.local/bin/hermes",
        "/home/me/hermes/venv/bin/hermes",
    )
    .unwrap();
    assert!(hermes.contains("uninstall --yes"));
    assert!(!hermes.contains("pip"));
    assert!(!hermes.contains("--full"));
    for (path, real) in [
        (
            "/home/me/project/node_modules/.bin/codex",
            "/home/me/project/node_modules/@openai/codex/bin/codex.js",
        ),
        (
            "/home/me/.local/bin/codex",
            "/home/me/release/lib/node_modules/@openai/codex/bin/codex.js",
        ),
    ] {
        assert!(wsl_uninstall_command("codex", path, real).is_err());
    }
    let openclaw = wsl_uninstall_command(
        "openclaw",
        "/usr/local/bin/openclaw",
        "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
    )
    .unwrap();
    assert!(openclaw.contains("uninstall --service --yes --non-interactive && npm uninstall"));
}

/// The auto-mode probe must land on the same installation as the version check
/// (`wsl_auto_shell_command`), including a PATH set only by interactive init
/// (bash's guarded ~/.bashrc, dash's $ENV), and the removal must run there too.
#[cfg(unix)]
#[test]
fn wsl_auto_probe_and_removal_match_the_version_check_shell() {
    use std::{fs, os::unix::fs::PermissionsExt};
    for shell in ["/bin/bash", "/bin/dash"] {
        if !Path::new(shell).exists() {
            continue;
        }
        let home = tempfile::tempdir().unwrap();
        let rc_bin = home.path().join("interactive");
        let base_bin = home.path().join("base");
        for dir in [&rc_bin, &base_bin] {
            fs::create_dir_all(dir).unwrap();
            let tool = dir.join("codex");
            fs::write(&tool, "#!/bin/sh\necho 1.0.0\n").unwrap();
            fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let export = format!("export PATH='{}':\"$PATH\"\n", rc_bin.display());
        // Ubuntu's ~/.profile sources ~/.bashrc, which returns unless interactive.
        fs::write(
            home.path().join(".bashrc"),
            format!("case $- in *i*) ;; *) return ;; esac\n{export}"),
        )
        .unwrap();
        fs::write(home.path().join(".profile"), ". \"$HOME/.bashrc\"\n").unwrap();
        fs::write(home.path().join(".shrc"), &export).unwrap();
        let run = |args: &[&str]| {
            let mut command = std::process::Command::new("sh");
            command
                .args(args)
                .env_clear()
                .env("HOME", home.path())
                .env("SHELL", shell)
                .env("PATH", format!("{}:/usr/bin:/bin", base_bin.display()))
                .stdin(std::process::Stdio::null());
            if shell.ends_with("dash") {
                command.env("ENV", home.path().join(".shrc"));
            }
            let output = command.output().unwrap();
            assert!(output.status.success(), "{shell}: {output:?}");
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        let last = |out: String| out.lines().last().unwrap_or_default().to_string();
        let rc_tool = rc_bin.join("codex").display().to_string();
        let base_tool = base_bin.join("codex").display().to_string();

        let detected = last(run(&[
            "-c",
            &wsl_auto_shell_command("command -v codex", None),
        ]));
        assert_eq!(detected, rc_tool, "{shell}: version check");
        // A bare `sh -c` reaches the other copy.
        assert_eq!(last(run(&["-c", "command -v codex"])), base_tool);

        let probe = wsl_probe_script("codex");
        let mut args = vec!["-c", WSL_SHELL_PROBE_LAUNCHER, "cc-switch", &probe];
        args.extend(WSL_AUTO_SHELL_FLAGS);
        let stdout = run(&args);
        let (path, _) = parse_wsl_installation(&stdout).unwrap();
        assert_eq!(path, detected, "{shell}: uninstall probe");
        let flag = parse_wsl_shell_flag(&stdout).unwrap();
        assert_eq!(flag, "-lic", "{shell}");
        let removal = run(&[
            "-c",
            WSL_SHELL_RUN_LAUNCHER,
            "cc-switch",
            "command -v codex",
            flag,
        ]);
        assert_eq!(last(removal), detected, "{shell}: removal");
    }
}

#[test]
fn wsl_version_check_command_is_unchanged() {
    let p = "echo s; codex --version";
    assert_eq!(
        wsl_auto_shell_command(p, None),
        format!("\"${{SHELL:-sh}}\" -lic '{p}' 2>/dev/null || \"${{SHELL:-sh}}\" -lc '{p}' 2>/dev/null || \"${{SHELL:-sh}}\" -c '{p}'")
    );
    assert_eq!(
        wsl_auto_shell_command(p, Some("-lc")),
        format!("\"${{SHELL:-sh}}\" -lc '{p}'")
    );
}

#[test]
fn wsl_shell_flag_must_be_reported_and_known() {
    assert_eq!(
        parse_wsl_shell_flag(
            "noise\n__LOLICODE_SHELL_FLAG__ -lc\n__LOLICODE_UNINSTALL__\n/a\n/b\n"
        ),
        Ok("-lc")
    );
    assert!(parse_wsl_shell_flag("__LOLICODE_UNINSTALL__\n/a\n/b\n").is_err());
    assert!(parse_wsl_shell_flag("__LOLICODE_SHELL_FLAG__ -x\n").is_err());
}

#[cfg(target_os = "windows")]
#[test]
fn wsl_uninstall_passes_the_script_verbatim_to_the_selected_shell() {
    let script = wsl_uninstall_command(
        "codex",
        "/home/me/npm prefix's/bin/codex",
        "/home/me/npm prefix's/lib/node_modules/@openai/codex/bin/codex.js",
    )
    .unwrap();
    let fish = WslShellPreferenceInput {
        wsl_shell: Some("/usr/bin/fish".into()),
        wsl_shell_flag: Some("-lc".into()),
    };
    let explicit = WslShell::from_pref(Some(&fish)).unwrap();
    assert_eq!(explicit.probe_args(&script), ["fish", "-lc", &script]);
    assert_eq!(explicit.run_args(&script, None), ["fish", "-lc", &script]);
    let process = wsl_process("Ubuntu", &explicit.run_args(&script, None)).unwrap();
    let args: Vec<_> = process
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(args, ["-d", "Ubuntu", "--exec", "fish", "-lc", &script]);
    assert!(wsl_process("invalid distro", &[&script]).is_err());

    let launcher = |s: &'static str| ["sh", "-c", s, "cc-switch", script.as_str()];
    let auto = WslShell::from_pref(None).unwrap();
    let mut probe = launcher(WSL_SHELL_PROBE_LAUNCHER).to_vec();
    probe.extend(WSL_AUTO_SHELL_FLAGS);
    assert_eq!(auto.probe_args(&script), probe);
    let mut run = launcher(WSL_SHELL_RUN_LAUNCHER).to_vec();
    run.push("-lic");
    assert_eq!(auto.run_args(&script, Some("-lic")), run);

    let one_flag = WslShellPreferenceInput {
        wsl_shell: None,
        wsl_shell_flag: Some("-lc".into()),
    };
    let mut probe = launcher(WSL_SHELL_PROBE_LAUNCHER).to_vec();
    probe.push("-lc");
    assert_eq!(
        WslShell::from_pref(Some(&one_flag))
            .unwrap()
            .probe_args(&script),
        probe
    );

    for invalid in [
        WslShellPreferenceInput {
            wsl_shell: Some("other".into()),
            wsl_shell_flag: None,
        },
        WslShellPreferenceInput {
            wsl_shell: None,
            wsl_shell_flag: Some("-x".into()),
        },
    ] {
        assert!(WslShell::from_pref(Some(&invalid)).is_err());
    }
}

#[test]
fn brew_uninstall_rejects_unrelated_packages_and_shims() {
    for (tool, real) in [
        ("codex", "/opt/homebrew/Cellar/mise/1/bin/mise"),
        ("claude", "/opt/homebrew/Cellar/volta/1/bin/volta-shim"),
        ("grok", "/opt/homebrew/Cellar/grok/1/bin/grok"),
        ("claude", "/opt/homebrew/Cellar/claude-code/1/bin/claude"),
        ("codex", "/opt/homebrew/Cellar/codex/1/bin/codex"),
        ("codex", "/opt/homebrew/Caskroom/unrelated/1/bin/codex"),
        ("gemini", "/opt/homebrew/Caskroom/gemini-cli/1/gemini"),
    ] {
        let inst = ToolInstallation {
            path: format!("/Users/me/.local/share/mise/shims/{tool}"),
            real: real.into(),
            version: None,
            runnable: false,
            error: None,
            source: "homebrew".into(),
            is_path_default: true,
        };
        assert!(plan_for_install(tool, &inst).is_err(), "{tool}: {real}");
    }
}

#[test]
fn brew_uninstall_allows_only_the_matching_formula_or_cask() {
    let temp = tempfile::tempdir().unwrap();
    let prefix = temp.path().to_string_lossy().replace('\\', "/");
    let brew = format!("{prefix}/bin/brew");
    std::fs::create_dir_all(temp.path().join("bin")).unwrap();
    std::fs::write(&brew, "fixture brew").unwrap();

    for (tool, location, token, flag) in [
        ("claude", "Caskroom", "claude-code", "--cask"),
        ("claude", "Caskroom", "claude-code@latest", "--cask"),
        ("codex", "Caskroom", "codex", "--cask"),
        ("gemini", "Cellar", "gemini-cli", "--formula"),
        ("opencode", "Cellar", "opencode", "--formula"),
    ] {
        let real = format!("{prefix}/{location}/{token}/1/bin/{tool}");
        let command = brew_uninstall_command(tool, &real).unwrap().unwrap();
        assert_eq!(
            command,
            format!("{} uninstall {flag} {}", quote(&brew), quote(token))
        );
    }
    let inst = ToolInstallation {
        path: format!("{prefix}/bin/gemini"),
        real: format!("{prefix}/Cellar/gemini-cli/1/libexec/lib/node_modules/@google/gemini-cli/dist/index.js").into(),
        version: None,
        runnable: true,
        error: None,
        source: "homebrew".into(),
        is_path_default: true,
    };
    let plan = plan_for_install("gemini", &inst).unwrap();
    assert!(plan.command.contains("uninstall --formula"));
    assert!(!plan.command.contains("npm"));
    std::fs::remove_file(&brew).unwrap();
    assert!(
        plan_for_install("gemini", &inst).is_err(),
        "do not preview a missing brew executable"
    );
}

#[test]
fn hermes_plan_uses_the_selected_cli_without_python_or_pip() {
    let temp = tempfile::tempdir().unwrap();
    let bin = temp.path().join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let entry = bin.join("hermes");
    std::fs::write(&entry, "hermes launcher").unwrap();
    let inst = installation(&entry);
    let plan = plan_for_install("hermes", &inst).unwrap();
    assert_eq!(
        plan.command,
        format!("{} uninstall --yes", quote(&inst.path))
    );
    assert_eq!(plan.path, inst.path);
    assert_eq!(plan.real_path, inst.real.to_string_lossy());
    assert!(entry.exists(), "preparing a plan must be read-only");
    std::fs::write(bin.join("python"), "unrelated Python").unwrap();
    assert_eq!(plan_for_install("hermes", &inst).unwrap(), plan);
}

#[test]
fn confirmation_rejects_a_changed_target_or_command() {
    let temp = tempfile::tempdir().unwrap();
    let entry = temp.path().join("hermes");
    std::fs::write(&entry, "launcher").unwrap();
    let plan = plan_for_install("hermes", &installation(&entry)).unwrap();
    assert!(validate_confirmed_plan(&plan, &plan).is_ok());
    let mut changed = plan.clone();
    changed.path.push_str("-other");
    assert!(validate_confirmed_plan(&changed, &plan).is_err());
    changed = plan.clone();
    changed.real_path.push_str("-other");
    assert!(validate_confirmed_plan(&changed, &plan).is_err());
    changed = plan.clone();
    changed.command.push_str(" --full");
    assert!(validate_confirmed_plan(&changed, &plan).is_err());
    changed = plan.clone();
    changed.wsl_distro = Some("Ubuntu".into());
    assert!(validate_confirmed_plan(&changed, &plan).is_err());
    assert!(entry.exists());
}

#[test]
fn claude_native_plan_rejects_a_user_wrapper() {
    let temp = tempfile::tempdir().unwrap();
    let bin = temp.path().join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let entry = bin.join("claude");
    std::fs::write(&entry, "#!/bin/sh\necho my wrapper\n").unwrap();
    assert!(plan_for_install("claude", &installation(&entry)).is_err());
    assert!(entry.exists());
    std::fs::write(&entry, b"\x7fELF").unwrap();
    assert!(
        plan_for_install("claude", &installation(&entry))
            .unwrap()
            .native
    );
}

#[test]
fn native_layout_requires_the_real_target_to_belong_to_the_installer() {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("unrelated.exe");
    std::fs::write(&executable, "MZ").unwrap();
    for (tool, launcher) in [
        ("grok", ".grok/bin/grok"),
        ("codex", "Programs/OpenAI/Codex/bin/codex.exe"),
    ] {
        let inst = ToolInstallation {
            path: temp.path().join(launcher).to_string_lossy().into_owned(),
            ..installation(&executable)
        };
        assert!(!known_native_install(tool, &inst));
    }
    for (tool, binary) in [
        ("grok", ".grok/downloads/grok-linux-x86_64"),
        (
            "codex",
            ".codex/packages/standalone/releases/0.157.0-linux/bin/codex",
        ),
        (
            "codex",
            ".codex/packages/standalone/releases/0.150.0-linux/codex",
        ),
        ("opencode", ".opencode/bin/opencode"),
    ] {
        let path = temp.path().join(binary);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"\x7fELF").unwrap();
        assert!(known_native_install(tool, &installation(&path)));
    }
    assert!(executable.exists());
}

#[cfg(unix)]
#[test]
fn removal_verification_rejects_dangling_symlinks() {
    let temp = tempfile::tempdir().unwrap();
    let entry = temp.path().join("codex");
    std::os::unix::fs::symlink(temp.path().join("missing-mise"), &entry).unwrap();
    assert!(!entry.exists());
    assert!(verify_removed("codex", &entry.to_string_lossy()).is_err());
    std::fs::remove_file(&entry).unwrap();
    assert!(verify_removed("codex", &entry.to_string_lossy()).is_ok());
}

#[test]
fn wsl_probe_requires_an_unambiguous_absolute_target() {
    assert_eq!(
        parse_wsl_installation(
            "login output\n__LOLICODE_UNINSTALL__\n/usr/bin/codex\n/opt/codex\n"
        )
        .unwrap(),
        ("/usr/bin/codex".into(), "/opt/codex".into())
    );
    assert!(parse_wsl_installation("__LOLICODE_UNINSTALL__\ncodex\n/opt/codex\n").is_err());
    assert!(
        parse_wsl_installation("__LOLICODE_UNINSTALL__\n/usr/bin/codex\n/opt/codex\nextra\n")
            .is_err()
    );
}

#[test]
fn native_uninstall_keeps_configuration_and_other_files() {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("claude.exe");
    let config = temp.path().join("settings.json");
    std::fs::write(&executable, "MZ").unwrap();
    std::fs::write(&config, "settings").unwrap();
    remove_native_executable(&installation(&executable)).unwrap();
    assert!(!executable.exists());
    assert_eq!(std::fs::read_to_string(config).unwrap(), "settings");
}

#[test]
fn native_uninstall_rejects_changed_target() {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("claude.exe");
    std::fs::write(&executable, "MZ").unwrap();
    let mut inst = installation(&executable);
    inst.real = temp.path().join("another.exe");
    assert!(remove_native_executable(&inst).is_err());
    assert!(executable.exists());
}
