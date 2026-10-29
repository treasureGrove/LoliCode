use super::*;

use std::path::{Path, PathBuf};
use std::sync::Arc;

#[tokio::test]
async fn lifecycle_coordinator_serializes_writes_and_rejects_duplicate_tools() {
    let coordinator = Arc::new(ToolLifecycleCoordinator::default());
    let output_dir = tempfile::tempdir().unwrap();
    let output = output_dir.path().join("installed.txt");
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let first = {
        let coordinator = coordinator.clone();
        let output = output.clone();
        tokio::spawn(async move {
            coordinator
                .run(vec!["codex"], move |_| {
                    started_tx.send(()).unwrap();
                    finish_rx.recv().unwrap();
                    std::fs::write(output, "codex").unwrap();
                    Ok(())
                })
                .await
        })
    };
    started_rx.await.unwrap();

    // 独立调用者（例如重挂后的页面）不能重复启动正在执行的工具。
    assert_eq!(
        coordinator
            .run(vec!["codex"], |_| panic!("duplicate must not execute"))
            .await
            .unwrap_err(),
        "TOOL_ACTION_IN_PROGRESS"
    );
    // 批次部分取锁失败时，已取得的其他工具锁也必须释放。
    assert!(coordinator
        .run(vec!["claude", "codex"], |_| panic!(
            "batch must not execute"
        ))
        .await
        .is_err());

    let second_output = output.clone();
    let second = coordinator.run(vec!["claude"], move |_| {
        assert_eq!(std::fs::read_to_string(&second_output).unwrap(), "codex");
        std::fs::write(second_output, "codex,claude").unwrap();
        Ok(())
    });
    tokio::pin!(second);
    assert!(futures::poll!(second.as_mut()).is_pending());
    assert!(!output.exists(), "first write has not finished yet");
    assert_eq!(
        coordinator
            .run(vec!["claude"], |_| panic!(
                "queued duplicate must not execute"
            ))
            .await
            .unwrap_err(),
        "TOOL_ACTION_IN_PROGRESS"
    );

    finish_tx.send(()).unwrap();
    first.await.unwrap().unwrap();
    second.await.unwrap();
    assert_eq!(std::fs::read_to_string(output).unwrap(), "codex,claude");
}

#[tokio::test]
async fn lifecycle_coordinator_keeps_running_locks_when_caller_is_cancelled() {
    let coordinator = Arc::new(ToolLifecycleCoordinator::default());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let first = {
        let coordinator = coordinator.clone();
        tokio::spawn(async move {
            coordinator
                .run(vec!["codex"], move |_| {
                    started_tx.send(()).unwrap();
                    finish_rx.recv().unwrap();
                    Ok(())
                })
                .await
        })
    };
    started_rx.await.unwrap();
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    assert!(coordinator
        .run(vec!["codex"], |_| panic!(
            "running duplicate must not execute"
        ))
        .await
        .is_err());

    {
        let cancelled = coordinator.run(vec!["claude"], |_| {
            panic!("cancelled queued operation must not execute")
        });
        tokio::pin!(cancelled);
        assert!(futures::poll!(cancelled.as_mut()).is_pending());
    }
    // 尚未开始的排队请求取消后可以重试，但仍须等待正在运行的子任务退出。
    let retry = coordinator.run(vec!["claude"], |_| Ok(()));
    tokio::pin!(retry);
    assert!(futures::poll!(retry.as_mut()).is_pending());
    finish_tx.send(()).unwrap();
    retry.await.unwrap();
    coordinator.run(vec!["codex"], |_| Ok(())).await.unwrap();
}

#[tokio::test]
async fn lifecycle_coordinator_releases_locks_after_error_or_panic() {
    let coordinator = ToolLifecycleCoordinator::default();
    assert_eq!(
        coordinator
            .run(vec!["claude"], |_| Err("installer failed".to_string()))
            .await,
        Err("installer failed".to_string())
    );
    coordinator.run(vec!["claude"], |_| Ok(())).await.unwrap();
    assert!(coordinator
        .run(vec!["claude"], |_| panic!("installer panicked"))
        .await
        .unwrap_err()
        .contains("tool lifecycle task join error"));
    coordinator.run(vec!["claude"], |_| Ok(())).await.unwrap();
}

#[cfg(target_os = "windows")]
#[test]
fn concurrent_lifecycle_runs_use_independent_scripts() {
    let output_dir = tempfile::tempdir().unwrap();
    let outputs = [
        output_dir.path().join("first.txt"),
        output_dir.path().join("second.txt"),
    ];
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        for output in &outputs {
            let barrier = &barrier;
            scope.spawn(move || {
                let command = format!("@echo off\r\n>\"{}\" echo %~f0\r\n", output.display());
                barrier.wait();
                run_tool_lifecycle_silently(&command, "tool_update").unwrap();
            });
        }
    });
    let script_paths =
        outputs.map(|output| PathBuf::from(std::fs::read_to_string(output).unwrap().trim()));
    assert_ne!(script_paths[0], script_paths[1]);
    for script_path in script_paths {
        assert!(!script_path.exists(), "temporary script must be cleaned up");
        assert!(
            !script_path.parent().unwrap().exists(),
            "temporary directory must be cleaned up"
        );
    }
}

#[cfg(target_os = "windows")]
#[test]
fn windows_lifecycle_restores_user_path_for_npm_and_its_child() {
    let root = tempfile::tempdir().unwrap();
    let npm_dir = root.path().join("npm 用户 & tools");
    let node_dir = root.path().join("node 用户 tools");
    std::fs::create_dir_all(&npm_dir).unwrap();
    std::fs::create_dir_all(&node_dir).unwrap();
    std::fs::write(
        npm_dir.join("npm.cmd"),
        "@echo off\r\ncmd /D /C lolicode_lifecycle_test_node.cmd\r\nexit /b %errorlevel%\r\n",
    )
    .unwrap();
    std::fs::write(
        node_dir.join("lolicode_lifecycle_test_node.cmd"),
        "@echo restored-user-path\r\n@exit /b 0\r\n",
    )
    .unwrap();
    let script = root.path().join("update.bat");
    std::fs::write(&script, "@echo off\r\ncall npm --version\r\n").unwrap();

    // Model an MSI-launched process with only the system directory on PATH.
    // Inject the registry contribution without modifying the real registry
    // or the test runner's process environment.
    let system_path = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
    let inherited = system_path.to_str().unwrap();
    let user_path = format!("{};{}", npm_dir.display(), node_dir.display());
    let effective = merge_path_segments_win(&[inherited, &user_path]);
    let parent_path = std::env::var_os("PATH");

    let missing = windows_lifecycle_command(&script, inherited)
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(
        !missing.status.success(),
        "npm must be absent on the narrow PATH"
    );

    let restored = windows_lifecycle_command(&script, &effective)
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(restored.status.success(), "{restored:?}");
    assert_eq!(
        decode_command_output(&restored.stdout).trim(),
        "restored-user-path"
    );
    assert_eq!(std::env::var_os("PATH"), parent_path);
}

#[cfg(target_os = "windows")]
#[test]
fn windows_lifecycle_preserves_process_path_priority_and_failure() {
    let root = tempfile::tempdir().unwrap();
    let preferred = root.path().join("process tools");
    let fallback = root.path().join("registry tools");
    std::fs::create_dir_all(&preferred).unwrap();
    std::fs::create_dir_all(&fallback).unwrap();
    std::fs::write(
        preferred.join("npm.cmd"),
        "@echo process-npm-failed 1>&2\r\n@exit /b 23\r\n",
    )
    .unwrap();
    std::fs::write(
        fallback.join("npm.cmd"),
        "@echo registry-npm\r\n@exit /b 0\r\n",
    )
    .unwrap();
    let script = root.path().join("update.bat");
    std::fs::write(&script, "@echo off\r\ncall npm --version\r\n").unwrap();
    let effective =
        merge_path_segments_win(&[preferred.to_str().unwrap(), fallback.to_str().unwrap()]);

    let output = windows_lifecycle_command(&script, &effective)
        .current_dir(root.path())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(23));
    assert_eq!(
        finish_lifecycle_output(&output).unwrap_err(),
        "process-npm-failed"
    );
}

/// 探测 helper 正常路径：spawn（含 pre_exec setsid）能启动、输出能捕获。
/// `/bin/echo --version` 在 macOS/Linux 均即刻成功退出。
#[cfg(not(target_os = "windows"))]
#[test]
fn probe_version_command_captures_healthy_tool_output() {
    let out = run_probe_version_command(Path::new("/bin/echo"), std::ffi::OsStr::new(""))
        .expect("probe of /bin/echo should succeed");
    assert!(out.status.success());
}

/// 超时击杀路径：挂死的子进程到点被整组击杀、wait 返回超时错误而非永等。
/// 同时锚定 setsid 改造后的语义——child 是新会话/新进程组组长，
/// terminate_child_tree 的 kill(-pid) 仍能命中（回归红线：改回 process_group
/// 或去掉隔离都会让本测试的击杀路径失效）。
#[cfg(not(target_os = "windows"))]
#[test]
fn isolated_hung_child_is_killed_on_deadline() {
    use std::process::{Command, Stdio};

    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", "sleep 30"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolate_child_process_group(&mut cmd);
    let child = cmd.spawn().expect("spawn sleep");
    let started = std::time::Instant::now();
    let result = wait_child_output(
        child,
        CommandDeadline::from_timeout(Some(std::time::Duration::from_millis(200))),
    );
    assert!(result.is_err(), "expected timeout error, got {result:?}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "kill should return promptly instead of waiting out the sleep"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn wsl_env_allows_spaces_in_unc_config_path() {
    let extra_env = [
        (
            "OPENCODE_CONFIG_DIR",
            r"\\wsl$\Ubuntu\home\Jane Doe\.config\opencode".to_string(),
        ),
        ("OPENCODE_DISABLE_PROJECT_CONFIG", "true".to_string()),
    ];

    assert_eq!(
        build_wsl_env_argv(&extra_env).unwrap(),
        vec![
            "OPENCODE_CONFIG_DIR=/home/Jane Doe/.config/opencode".to_string(),
            "OPENCODE_DISABLE_PROJECT_CONFIG=true".to_string(),
        ]
    );
}

#[cfg(target_os = "windows")]
#[test]
fn wsl_env_skips_host_config_path() {
    let extra_env = [
        (
            "OPENCODE_CONFIG_DIR",
            r"C:\Users\Jane Doe\.config\opencode".to_string(),
        ),
        ("OPENCODE_DISABLE_PROJECT_CONFIG", "true".to_string()),
    ];

    assert_eq!(
        build_wsl_env_argv(&extra_env).unwrap(),
        vec!["OPENCODE_DISABLE_PROJECT_CONFIG=true".to_string()]
    );
}

#[cfg(unix)]
fn set_test_executable(path: &Path, executable: bool) {
    use std::os::unix::fs::PermissionsExt;

    let mode = if executable { 0o755 } else { 0o644 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .expect("fixture permissions should be set");
}

#[test]
fn test_build_exec_line() {
    assert_eq!(build_exec_line("/bin/zsh", None), "exec '/bin/zsh' -l");
    assert_eq!(build_exec_line("/bin/bash", None), "exec '/bin/bash'");
    assert_eq!(
        build_exec_line("/opt/homebrew dir/bin/fish", None),
        "exec '/opt/homebrew dir/bin/fish'"
    );
    assert_eq!(build_exec_line("/bin/sh", None), "exec '/bin/sh'");
    assert_eq!(
        build_exec_line("/tmp/shell'quote/zsh", None),
        "exec '/tmp/shell'\"'\"'quote/zsh' -l"
    );
    assert_eq!(
        build_exec_line("/bin/zsh", Some(Path::new("/tmp/project"))),
        r#"exec '/bin/zsh' -lc 'cd '"'"'/tmp/project'"'"' || exit 1; exec '"'"'/bin/zsh'"'"' -i'"#
    );
}

#[test]
fn test_build_provider_command_line_uses_user_shell_environment() {
    assert_eq!(
        build_provider_command_line("/bin/zsh", "/tmp/claude config.json", None),
        "'/bin/zsh' -lic 'claude --settings '\"'\"'/tmp/claude config.json'\"'\"''"
    );
    assert_eq!(
        build_provider_command_line(
            "/bin/bash",
            "/tmp/claude config.json",
            Some(Path::new("/tmp/project"))
        ),
        r#"'/bin/bash' -ic 'cd '"'"'/tmp/project'"'"' && claude --settings '"'"'/tmp/claude config.json'"'"''"#
    );
    assert_eq!(
        build_provider_command_line(
            "/bin/sh",
            "/tmp/claude config.json",
            Some(Path::new("/tmp/project O'Brien"))
        ),
        r#"'/bin/sh' -c 'cd '"'"'/tmp/project O'"'"'"'"'"'"'"'"'Brien'"'"' && claude --settings '"'"'/tmp/claude config.json'"'"''"#
    );
}

#[test]
fn test_build_final_shell_cd_command() {
    assert_eq!(build_final_shell_cd_command("/bin/zsh", None), "");
    assert_eq!(
        build_final_shell_cd_command("/bin/zsh", Some(Path::new("/tmp/project"))),
        ""
    );
    assert_eq!(
        build_final_shell_cd_command("/bin/bash", Some(Path::new("/tmp/project O'Brien"))),
        "cd '/tmp/project O'\"'\"'Brien' || exit 1\n"
    );
}

#[cfg(unix)]
#[test]
fn test_get_user_shell_fallback() {
    // $SHELL 未设置时应按平台 fallback
    // 此测试验证 fallback 逻辑，但不验证环境变量值（取决于运行环境）
    let shell = get_user_shell();
    // 至少应返回一个合法的绝对路径
    assert!(valid_user_shell_path(&shell));
    // basename 应为合法 shell 名
    let basename = shell.rsplit('/').next().unwrap_or("sh");
    assert!(["sh", "bash", "zsh", "fish", "dash"].contains(&basename));
}

#[cfg(unix)]
#[test]
fn test_valid_user_shell_path() {
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let executable_zsh = temp.path().join("zsh");
    std::fs::write(&executable_zsh, "#!/usr/bin/env sh\n")
        .expect("shell fixture should be written");
    set_test_executable(&executable_zsh, true);

    let executable_fish_dir = temp.path().join("homebrew dir/bin");
    std::fs::create_dir_all(&executable_fish_dir)
        .expect("shell fixture directory should be created");
    let executable_fish = executable_fish_dir.join("fish");
    std::fs::write(&executable_fish, "#!/usr/bin/env sh\n")
        .expect("shell fixture should be written");
    set_test_executable(&executable_fish, true);

    let non_executable_bash = temp.path().join("bash");
    std::fs::write(&non_executable_bash, "#!/usr/bin/env sh\n")
        .expect("shell fixture should be written");
    set_test_executable(&non_executable_bash, false);

    assert!(valid_user_shell_path(&executable_zsh.to_string_lossy()));
    assert!(valid_user_shell_path(&executable_fish.to_string_lossy()));
    assert!(!valid_user_shell_path(""));
    assert!(!valid_user_shell_path("zsh"));
    assert!(!valid_user_shell_path(
        &temp.path().join("missing/zsh").to_string_lossy()
    ));
    assert!(!valid_user_shell_path(
        &non_executable_bash.to_string_lossy()
    ));
    assert!(!valid_user_shell_path(
        &temp.path().join("zsh; rm -rf /").to_string_lossy()
    ));
    assert!(!valid_user_shell_path(&format!(
        "{}\n/bin/bash",
        executable_zsh.to_string_lossy()
    )));
    assert!(!valid_user_shell_path("/usr/bin/powershell"));
}

#[test]
fn version_probe_sentinel_drops_shell_startup_output() {
    assert_eq!(
        version_probe_payload("claude"),
        "echo __LOLICODE_VERSION__; claude --version"
    );

    // Ubuntu 的 update-motd 在当天第一个交互式 login shell 里打印 MOTD，
    // 整段取第一个版本号会拿到 24.04.4（#7347）
    let motd = "Welcome to Ubuntu 24.04.4 LTS (GNU/Linux 6.6.87.2-microsoft-standard-WSL2 x86_64)\n\n * Documentation:  https://help.ubuntu.com\n__LOLICODE_VERSION__\n2.1.270 (Claude Code)";
    assert_eq!(after_version_sentinel(motd), "2.1.270 (Claude Code)");

    // 兜底链 `-lic || -lc || -c` 会多次打印哨兵：取最后一次之后
    let chained = "__LOLICODE_VERSION__\nbash: warning\n__LOLICODE_VERSION__\n1.2.3";
    assert_eq!(after_version_sentinel(chained), "1.2.3");

    // OSC 序列没有换行、直接粘在哨兵前面（地址取自 RFC 5737 文档保留段）
    let glued = "\x1b]1337;RemoteHost=user@198.51.100.23\x07__LOLICODE_VERSION__\n0.154.0";
    assert_eq!(after_version_sentinel(glued), "0.154.0");

    // 版本打在 stderr 的工具：哨兵之后为空，调用方回退到 stderr
    assert_eq!(after_version_sentinel("__LOLICODE_VERSION__\n"), "");

    // 没有哨兵（shell 在执行载荷前就失败）：原样返回，行为不变
    assert_eq!(
        after_version_sentinel("sh: 1: bad: not found"),
        "sh: 1: bad: not found"
    );
}

#[test]
fn test_extract_version() {
    assert_eq!(extract_version("claude 1.0.20"), "1.0.20");
    assert_eq!(extract_version("v2.3.4-beta.1"), "2.3.4-beta.1");
    assert_eq!(extract_version("no version here"), "no version here");
}

#[test]
fn github_release_version_prefers_semver_in_name_over_calendar_tag() {
    // Hermes 官方 release：tag 日历式，语义版本只在 name 里；2026-08-19 起括号内还多了个 v
    for (name, tag, want) in [
        ("Hermes Agent v0.20.4 (2026.8.18)", "v2026.8.18", "0.20.4"),
        ("Hermes Agent v0.21.0 (v2026.8.31)", "v2026.8.31", "0.21.0"),
        (
            "Hermes Agent v0.20.3 (2026.8.16.2)",
            "v2026.8.16.2",
            "0.20.3",
        ),
    ] {
        let json = serde_json::json!({ "name": name, "tag_name": tag });
        assert_eq!(
            github_release_version_from_json(&json).as_deref(),
            Some(want),
            "{name}"
        );
    }
}

#[test]
fn github_release_version_falls_back_to_semver_tag() {
    // opencode：name == tag，走 name 或 tag 结果一致
    let named = serde_json::json!({ "name": "v1.18.18", "tag_name": "v1.18.18" });
    assert_eq!(
        github_release_version_from_json(&named).as_deref(),
        Some("1.18.18")
    );
    let prose = serde_json::json!({ "name": "August refresh", "tag_name": "v1.18.18" });
    assert_eq!(
        github_release_version_from_json(&prose).as_deref(),
        Some("1.18.18")
    );
    let unnamed = serde_json::json!({ "tag_name": "v1.2.3" });
    assert_eq!(
        github_release_version_from_json(&unnamed).as_deref(),
        Some("1.2.3")
    );
}

#[test]
fn github_release_version_rejects_calendar_versions_and_rate_limit_body() {
    // name 与 tag 都只有日历式数字：不得把 2026.8.31 当版本号（前端会永久判定"可更新"）
    let calendar = serde_json::json!({
        "name": "Hermes Agent (2026.8.31)",
        "tag_name": "v2026.8.31"
    });
    assert_eq!(github_release_version_from_json(&calendar), None);
    let four_seg = serde_json::json!({ "tag_name": "v2026.8.16.2" });
    assert_eq!(github_release_version_from_json(&four_seg), None);
    // GitHub 未认证限流响应只有 message / documentation_url
    let limited = serde_json::json!({
        "message": "API rate limit exceeded for 1.2.3.4.",
        "documentation_url": "https://docs.github.com/rest"
    });
    assert_eq!(github_release_version_from_json(&limited), None);
    assert_eq!(
        github_release_version_from_json(&serde_json::json!({})),
        None
    );
}

#[test]
fn hermes_pypi_fallback_is_hidden_when_local_leads() {
    let pypi = || Some("0.19.0".to_string());
    // GitHub 不可达、PyPI 仍停在 0.19.0：本地 0.21.0 时不展示旧值（否则"最新 < 当前"）
    assert_eq!(drop_latest_behind_local(pypi(), Some("0.21.0")), None);
    // 本地等于 / 落后 PyPI，或本地未知：照常展示
    assert_eq!(
        drop_latest_behind_local(pypi(), Some("0.19.0")).as_deref(),
        Some("0.19.0")
    );
    assert_eq!(
        drop_latest_behind_local(pypi(), Some("0.18.2")).as_deref(),
        Some("0.19.0")
    );
    assert_eq!(
        drop_latest_behind_local(pypi(), None).as_deref(),
        Some("0.19.0")
    );
    // 本地无法解析时保守视为未领先
    assert_eq!(
        drop_latest_behind_local(pypi(), Some("unknown")).as_deref(),
        Some("0.19.0")
    );
    assert_eq!(drop_latest_behind_local(None, Some("0.21.0")), None);
}

#[test]
fn grok_lifecycle_metadata_is_consistent() {
    let requested = vec!["unsupported".to_string(), "grok".to_string()];
    assert_eq!(normalize_requested_tools(&requested), vec!["grok"]);
    assert_eq!(tool_display_name("grok"), "Grok Build");
    assert_eq!(npm_package_for("grok"), Some("@xai-official/grok"));
    assert_eq!(
        npm_install_command_for("grok"),
        Some("npm i -g @xai-official/grok@latest")
    );
    assert_eq!(official_update_args("grok"), Some("update"));

    for action in [ToolLifecycleAction::Install, ToolLifecycleAction::Update] {
        assert_eq!(
            tool_action_shell_command_for_shell("grok", action, LifecycleCommandShell::Posix)
                .as_deref(),
            Some("npm i -g @xai-official/grok@latest")
        );
    }

    // Static update remains package-manager based. Only a path positively
    // identified as xAI's native install may run `grok update`.
    assert_eq!(
        tool_action_shell_command_for_shell(
            "grok",
            ToolLifecycleAction::Update,
            LifecycleCommandShell::WindowsBatch,
        )
        .as_deref(),
        Some("npm i -g @xai-official/grok@latest")
    );
}

#[test]
fn pi_lifecycle_metadata_matches_pinned_distribution() {
    let requested = vec!["unsupported".to_string(), "pi".to_string()];
    assert_eq!(normalize_requested_tools(&requested), vec!["pi"]);
    assert_eq!(tool_display_name("pi"), "Pi");
    assert_eq!(
        npm_package_for("pi"),
        Some("@earendil-works/pi-coding-agent")
    );
    assert_eq!(
        npm_install_command_for("pi"),
        Some("npm i -g @earendil-works/pi-coding-agent@latest")
    );
    // The verified distribution exposes `pi --version`, but no updater
    // contract is assumed; upgrades stay on the package-manager path.
    assert_eq!(official_update_args("pi"), None);
}

#[test]
fn mcode_lifecycle_metadata_skips_non_tty_self_update() {
    let requested = vec!["unsupported".to_string(), "mcode".to_string()];
    assert_eq!(normalize_requested_tools(&requested), vec!["mcode"]);
    assert_eq!(tool_display_name("mcode"), "MiniMax Code");
    // npm 上同名的 `mcode` 是无关项目，官方包是 scoped 的 @minimax-ai/code。
    assert_eq!(npm_package_for("mcode"), Some("@minimax-ai/code"));
    let npm = npm_install_command_for("mcode").unwrap();
    assert_eq!(
        npm,
        format!(
            "npm i -g @minimax-ai/code@latest{}",
            npm_install_extra_args("mcode")
        )
    );
    assert!(
        npm.contains("\"--allow-scripts=@minimax-ai/code,better-sqlite3\""),
        "npm 12 blocks better-sqlite3's install script without it: {npm}"
    );
    assert_eq!(npm_install_extra_args("codex"), "");

    // `mcode update` exits 0 without installing when stdin/stdout are not a
    // TTY, which is exactly how silent lifecycle actions run it.
    assert_eq!(official_update_args("mcode"), None);
    for shell in [
        LifecycleCommandShell::Posix,
        LifecycleCommandShell::WindowsBatch,
    ] {
        assert_eq!(
            tool_action_shell_command_for_shell("mcode", ToolLifecycleAction::Update, shell)
                .as_deref(),
            Some(npm)
        );
    }
}

#[test]
fn mcode_install_root_candidate_follows_platform_layout() {
    assert_eq!(
        mcode_install_root_candidate("/opt/mcode/bin/mcode", McodeLayout::Posix),
        "/opt/mcode"
    );
    // 根目录本身叫 bin：POSIX 只去掉入口所在的那一层 bin。
    assert_eq!(
        mcode_install_root_candidate("/opt/bin/bin/mcode", McodeLayout::Posix),
        "/opt/bin"
    );
    // Windows 入口直接在根目录，根目录叫 bin 也不能再上跳一级。
    assert_eq!(
        mcode_install_root_candidate("C:\\Users\\me\\bin\\mcode.cmd", McodeLayout::Windows),
        "C:\\Users\\me\\bin"
    );
}

#[test]
fn mcode_script_install_root_matches_only_installer_layout() {
    assert_eq!(
        mcode_script_install_root(
            "/Users/me/.minimax-code/bin/mcode",
            "/Users/me/.minimax-code/bin/mcode",
            McodeLayout::Posix,
        )
        .as_deref(),
        Some("/Users/me/.minimax-code")
    );
    assert_eq!(
        mcode_script_install_root(
            "C:\\Users\\me\\.minimax-code\\mcode.cmd",
            "C:\\Users\\me\\.minimax-code\\mcode.cmd",
            McodeLayout::Windows,
        )
        .as_deref(),
        Some("C:\\Users\\me\\.minimax-code")
    );
    // 用户自建软链：入口不在安装目录，但真身是 launcher。
    assert_eq!(
        mcode_script_install_root(
            "/Users/me/.local/bin/mcode",
            "/Users/me/.minimax-code/bin/mcode",
            McodeLayout::Posix,
        )
        .as_deref(),
        Some("/Users/me/.minimax-code")
    );
    // 全局 npm 安装、以及同名数据目录 `~/.minimax` 都不是 installer 布局。
    assert_eq!(
        mcode_script_install_root(
            "/opt/homebrew/bin/mcode",
            "/opt/homebrew/lib/node_modules/@minimax-ai/code/cli.js",
            McodeLayout::Posix,
        ),
        None
    );
    assert_eq!(
        mcode_script_install_root(
            "/Users/me/.minimax/bin/mcode",
            "/Users/me/.minimax/bin/mcode",
            McodeLayout::Posix,
        ),
        None
    );
}

/// 在 tempdir 下按 `layout` 搭一个自定义 `MCODE_INSTALL_DIR`（`<tmp>/apps/<root_name>`，
/// 目录名不是 `.minimax-code`）的 installer 布局，返回 `(TempDir, root, 入口路径)`。
fn mcode_custom_install(
    root_name: &str,
    layout: McodeLayout,
) -> (tempfile::TempDir, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("apps").join(root_name);
    let entry = match layout {
        McodeLayout::Posix => root.join("bin").join("mcode"),
        McodeLayout::Windows => root.join("mcode.cmd"),
    };
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    std::fs::write(&entry, "").unwrap();
    (
        dir,
        root.to_string_lossy().to_string(),
        entry.to_string_lossy().to_string(),
    )
}

fn write_mcode_receipt(root: &str, product: &str, owner: &str, prefix: &str, bom: bool) {
    let json = serde_json::json!({
        "schemaVersion": 2,
        "product": product,
        "updateOwner": owner,
        "prefix": prefix,
    })
    .to_string();
    let text = if bom { format!("\u{feff}{json}") } else { json };
    std::fs::write(Path::new(root).join("install.json"), text).unwrap();
}

#[test]
fn mcode_receipt_claims_custom_install_dir() {
    for (root_name, layout) in [
        ("mcode", McodeLayout::Posix),
        ("bin", McodeLayout::Posix),
        ("mcode", McodeLayout::Windows),
        // MCODE_INSTALL_DIR=C:\Users\me\bin：入口 `<root>\mcode.cmd` 的父目录名就是 bin。
        ("bin", McodeLayout::Windows),
    ] {
        let (_dir, root, entry) = mcode_custom_install(root_name, layout);
        write_mcode_receipt(&root, "minimax-code", "npm-prefix", &root, false);
        assert_eq!(
            mcode_receipt_install_root(&entry, layout).as_deref(),
            Some(root.as_str()),
            "{root_name} / {layout:?}"
        );
    }

    // 端到端：单处安装也必须原地重跑 installer，不能退到全局 `npm i -g`。
    let (_dir, root, entry) = mcode_custom_install("mcode", McodeLayout::NATIVE);
    write_mcode_receipt(&root, "minimax-code", "npm-prefix", &root, false);
    let installs = vec![ToolInstallation {
        path: entry.clone(),
        version: Some("0.5.3".to_string()),
        runnable: true,
        error: None,
        source: infer_install_source(Path::new(&entry)).to_string(),
        is_path_default: false,
        real: PathBuf::from(&entry),
    }];
    assert_eq!(
        installs_anchored_command("mcode", &installs),
        Some(mcode_installer_update_command(&root))
    );
}

#[test]
fn mcode_receipt_tolerates_utf8_bom() {
    // install.ps1 在 Windows PowerShell 5.1 下用 `Set-Content -Encoding UTF8` 写回执，带 BOM。
    let (_dir, root, entry) = mcode_custom_install("mcode", McodeLayout::Windows);
    write_mcode_receipt(&root, "minimax-code", "npm-prefix", &root, true);
    assert_eq!(
        mcode_receipt_install_root(&entry, McodeLayout::Windows).as_deref(),
        Some(root.as_str())
    );
}

#[test]
fn mcode_receipt_rejects_foreign_or_mismatched_receipts() {
    let layout = McodeLayout::NATIVE;
    // 没有回执：不认领。
    let (_dir, _root, entry) = mcode_custom_install("mcode", layout);
    assert_eq!(mcode_receipt_install_root(&entry, layout), None);

    // 不是 MiniMax Code 的回执、或不归 npm-prefix 管：不认领。
    for (product, owner) in [
        ("other", "npm-prefix"),
        ("minimax-code", "managed-installer"),
    ] {
        let (_dir, root, entry) = mcode_custom_install("mcode", layout);
        write_mcode_receipt(&root, product, owner, &root, false);
        assert_eq!(
            mcode_receipt_install_root(&entry, layout),
            None,
            "{product}/{owner}"
        );
    }

    // prefix 指向别的目录（拷贝来的回执）：不认领。
    let elsewhere = tempfile::tempdir().unwrap();
    let (_dir, root, entry) = mcode_custom_install("mcode", layout);
    write_mcode_receipt(
        &root,
        "minimax-code",
        "npm-prefix",
        &elsewhere.path().to_string_lossy(),
        false,
    );
    assert_eq!(mcode_receipt_install_root(&entry, layout), None);
}

#[test]
fn test_compare_semver() {
    use std::cmp::Ordering;
    assert_eq!(
        compare_semver("2.1.156", "2.1.154"),
        Some(Ordering::Greater)
    );
    assert_eq!(compare_semver("2.1.154", "2.1.156"), Some(Ordering::Less));
    assert_eq!(compare_semver("2.1.156", "2.1.156"), Some(Ordering::Equal));
    // 预发布 < 同核心正式版
    assert_eq!(
        compare_semver("2.1.156-beta.1", "2.1.156"),
        Some(Ordering::Less)
    );
    // core 更高的预发布仍高于较低的正式版（gemini nightly 场景）
    assert_eq!(
        compare_semver("0.45.0-nightly.1", "0.44.1"),
        Some(Ordering::Greater)
    );
    // 大 patch（codex 时间戳式）不溢出
    assert_eq!(
        compare_semver("0.1.2505172116", "0.135.0"),
        Some(Ordering::Less)
    );
    // 无法解析返回 None（gemini 的 `false` 脏 tag）
    assert_eq!(compare_semver("false", "1.0.0"), None);
}

#[test]
fn test_pick_latest_version() {
    use serde_json::json;
    let tags = json!({
        "latest": "2.1.154",
        "next": "2.1.156",
        "stable": "2.1.145"
    });
    let map = tags.as_object().unwrap();

    // 本地领先 latest（在 next 通道）→ 补查到 next，数字对齐
    assert_eq!(
        pick_latest_version(map, &["next"], Some("2.1.156")),
        Some("2.1.156".to_string())
    );
    // 本地等于 latest → 不补查，仍显示 latest
    assert_eq!(
        pick_latest_version(map, &["next"], Some("2.1.154")),
        Some("2.1.154".to_string())
    );
    // 本地落后 latest（稳定通道用户）→ 不补查，不被推向预发布版
    assert_eq!(
        pick_latest_version(map, &["next"], Some("2.1.145")),
        Some("2.1.154".to_string())
    );
    // 无预发布白名单 → 永远只看 latest（不解析 local，避免脏 local 触发）
    assert_eq!(
        pick_latest_version(map, &[], Some("2.1.156")),
        Some("2.1.154".to_string())
    );
    // 本地版本未知 → 保守只看 latest
    assert_eq!(
        pick_latest_version(map, &["next"], None),
        Some("2.1.154".to_string())
    );
}

#[test]
fn test_pick_latest_version_filters_dirty_prerelease() {
    use serde_json::json;
    // 模拟 codex：beta 是低于 latest 的时间戳式脏版本
    let tags = json!({
        "latest": "0.135.0",
        "beta": "0.1.2505172116"
    });
    let map = tags.as_object().unwrap();
    // 即便本地领先 latest，低于 latest 的脏 beta 也不会被选
    assert_eq!(
        pick_latest_version(map, &["beta"], Some("0.200.0")),
        Some("0.135.0".to_string())
    );
}

#[test]
fn test_npm_dist_tags_url() {
    // 普通包名直接拼进路径
    assert_eq!(
        npm_dist_tags_url("openclaw"),
        "https://registry.npmjs.org/-/package/openclaw/dist-tags"
    );
    // scoped 包名的 `/` 按 registry 约定转义成 %2f
    assert_eq!(
        npm_dist_tags_url("@openai/codex"),
        "https://registry.npmjs.org/-/package/@openai%2fcodex/dist-tags"
    );
}

/// `parent_dir` 是锚定层"由 bin 路径推导同目录绝对路径"的基石,跨平台共用——
/// 这里固化 `\`/`/`/混合分隔符/根边界四种情况,避免未来重构悄悄改语义。
mod parent_dir_cases {
    use super::*;

    #[test]
    fn unix_path() {
        assert_eq!(
            parent_dir("/Users/me/.volta/bin/codex"),
            "/Users/me/.volta/bin"
        );
    }

    #[test]
    fn windows_backslash() {
        assert_eq!(
            parent_dir("C:\\Users\\me\\AppData\\Local\\Volta\\bin\\codex.exe"),
            "C:\\Users\\me\\AppData\\Local\\Volta\\bin"
        );
    }

    #[test]
    fn mixed_separators_takes_rightmost() {
        // Windows 上 `Path::join` 与字符串拼接可能产出混合分隔符;取**两种之中最右
        // 出现**的位置,而非"优先 `\`"——后者在混合时会取错父目录。
        assert_eq!(
            parent_dir("C:\\Users\\me/Code/openclaw\\codex.cmd"),
            "C:\\Users\\me/Code/openclaw"
        );
    }

    #[test]
    fn no_separator_returns_empty() {
        // 无父目录 → 空串,锚定层据此返 None、回退静态命令。
        assert_eq!(parent_dir("codex"), "");
    }

    #[test]
    fn separator_at_root_returns_empty() {
        // `/codex`:根目录是 index 0,`i > 0` 不满足 → 空串。同款行为对 Windows
        // 上的 `\codex` 也成立(实际不会出现,但语义对齐)。
        assert_eq!(parent_dir("/codex"), "");
        assert_eq!(parent_dir("\\codex"), "");
    }
}

/// Codex 官方独立安装器的识别是纯字符串判定,POSIX / Windows 布局都在这里固化。
mod codex_standalone_detection {
    use super::*;

    #[test]
    fn posix_default_layout() {
        assert_eq!(
            codex_standalone_install(
                "/Users/me/.local/bin/codex",
                "/Users/me/.codex/packages/standalone/releases/0.157.0-aarch64-apple-darwin/bin/codex",
            ),
            Some(CodexStandaloneInstall {
                install_dir: "/Users/me/.local/bin".to_string(),
                codex_home: Some("/Users/me/.codex".to_string()),
            })
        );
    }

    #[test]
    fn windows_verbatim_real_is_restored() {
        // canonicalize 出的 `\\?\` 前缀要剥掉再交给 installer;大小写保持原样。
        assert_eq!(
            codex_standalone_install(
                r"C:\Users\Me\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
                r"\\?\C:\Users\Me\.Codex\Packages\Standalone\releases\0.157.0-x86_64-pc-windows-msvc\bin\codex.exe",
            ),
            Some(CodexStandaloneInstall {
                install_dir: r"C:\Users\Me\AppData\Local\Programs\OpenAI\Codex\bin".to_string(),
                codex_home: Some(r"C:\Users\Me\.Codex".to_string()),
            })
        );
        assert_eq!(
            codex_standalone_install(
                r"\\server\share\bin\codex.exe",
                r"\\?\UNC\server\share\cx\packages\standalone\current\bin\codex.exe",
            )
            .and_then(|install| install.codex_home),
            Some(r"\\server\share\cx".to_string())
        );
    }

    #[test]
    fn windows_default_entry_without_resolved_real() {
        // canonicalize 失败时 real 就是入口本身:仍按默认入口目录认出,只是不传 CODEX_HOME。
        let bin = r"C:\Users\me\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe";
        assert_eq!(
            codex_standalone_install(bin, bin),
            Some(CodexStandaloneInstall {
                install_dir: r"C:\Users\me\AppData\Local\Programs\OpenAI\Codex\bin".to_string(),
                codex_home: None,
            })
        );
    }

    #[test]
    fn other_install_channels_are_not_standalone() {
        for (bin, real) in [
            (
                "/Users/me/.nvm/versions/node/v22.19.0/bin/codex",
                "/Users/me/.nvm/versions/node/v22.19.0/lib/node_modules/@openai/codex/bin/codex.js",
            ),
            (
                "/opt/homebrew/bin/codex",
                "/opt/homebrew/Caskroom/codex/0.157.0/bin/codex",
            ),
            // app-server 守护进程的发布包不是 PATH 上的 CLI。
            (
                "/Users/me/.local/bin/codex",
                "/Users/me/.codex/packages/app-server-daemon/current/bin/codex",
            ),
            (
                r"C:\Users\me\AppData\Roaming\npm\codex.cmd",
                r"C:\Users\me\AppData\Roaming\npm\codex.cmd",
            ),
        ] {
            assert_eq!(codex_standalone_install(bin, real), None, "{bin}");
        }
    }
}

/// 锚定落空后的兜底:认不出渠道的原生可执行文件不再退回裸 `npm i -g`(#7650),
/// 脚本 shim / node_modules 里的入口 / 定位不到默认那处仍保持旧的静态命令。
mod unmanaged_native_update {
    use super::*;

    const MACH_O_64: [u8; 4] = [0xcf, 0xfa, 0xed, 0xfe];

    /// 在 tempdir 的 `rel` 位置写入 `bytes`,返回指向它的安装记录。TempDir 须保活。
    fn installed(
        dir: &tempfile::TempDir,
        rel: &str,
        bytes: &[u8],
        is_default: bool,
    ) -> ToolInstallation {
        let path = dir.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        ToolInstallation {
            path: path.to_string_lossy().to_string(),
            version: Some("1.0.0".to_string()),
            runnable: true,
            error: None,
            source: infer_install_source(&path).to_string(),
            is_path_default: is_default,
            real: path,
        }
    }

    #[test]
    fn native_binary_outside_node_modules_is_unmanaged() {
        let dir = tempfile::tempdir().unwrap();
        let gemini = installed(&dir, "nix-profile/bin/gemini", &MACH_O_64, true);
        assert_eq!(
            resolve_update_command("gemini", &[gemini]),
            UpdateCommand::Unmanaged
        );
        let pi = installed(&dir, "bin/pi", b"\x7fELF\x02\x01\x01", true);
        assert_eq!(
            resolve_update_command("pi", &[pi]),
            UpdateCommand::Unmanaged
        );
    }

    #[test]
    fn script_shim_keeps_static_npm_command() {
        // asdf / nodenv 的 shim 是脚本,背后可能正是 npm 全局包,不能拒绝。
        let dir = tempfile::tempdir().unwrap();
        let shim = installed(
            &dir,
            ".asdf/shims/gemini",
            b"#!/usr/bin/env bash\nexec asdf exec gemini \"$@\"\n",
            true,
        );
        assert_eq!(
            resolve_update_command("gemini", &[shim]),
            UpdateCommand::Static(static_fallback_command("gemini"))
        );
    }

    #[test]
    fn native_binary_inside_node_modules_keeps_static_npm_command() {
        // 有的 npm 包把原生二进制放在包内,真身仍在 node_modules 下,归 npm 管。
        let dir = tempfile::tempdir().unwrap();
        let bundled = installed(
            &dir,
            "prefix/lib/node_modules/@google/gemini-cli/bin/gemini",
            &MACH_O_64,
            true,
        );
        assert_eq!(
            resolve_update_command("gemini", &[bundled]),
            UpdateCommand::Static(static_fallback_command("gemini"))
        );
    }

    #[test]
    fn unknown_default_keeps_static_command() {
        // 多处安装又定位不到默认那处:不知道命令行用的是哪份,维持旧行为(前端会弹确认)。
        let dir = tempfile::tempdir().unwrap();
        let a = installed(&dir, "a/bin/gemini", &MACH_O_64, false);
        let b = installed(&dir, "b/bin/gemini", &MACH_O_64, false);
        assert_eq!(
            resolve_update_command("gemini", &[a, b]),
            UpdateCommand::Static(static_fallback_command("gemini"))
        );
    }

    #[test]
    fn native_executable_magic() {
        let dir = tempfile::tempdir().unwrap();
        let cases: [(&str, &[u8], bool); 7] = [
            ("elf", b"\x7fELF\x02", true),
            ("macho", &MACH_O_64, true),
            ("fat", &[0xca, 0xfe, 0xba, 0xbe], true),
            ("pe.exe", b"MZ\x90\x00", true),
            ("script", b"#!/bin/sh\n", false),
            ("cmd-shim.cmd", b"@ECHO off\r\n", false),
            ("short", b"MZ", false),
        ];
        for (name, bytes, expected) in cases {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(is_native_executable(&path), expected, "{name}");
        }
        assert!(!is_native_executable(&dir.path().join("missing")));
    }
}

/// Windows-only 锚定升级回归(等价类压缩到 3 种 idiom:volta/pnpm/npm)。整块通过
/// `cfg(target_os = "windows")` gate,在 macOS/Linux 上不参与 cargo test;Windows
/// CI 跑全套验证。tempdir 模拟 sibling 入口存在/不存在,锁定"扩展名顺序优先级 +
/// 含空格路径自动加双引号 + 探不到 sibling → None 退静态"三件事。
#[cfg(target_os = "windows")]
mod anchored_upgrade_windows {
    use super::*;

    /// 在 tempdir 下创建子目录 `subdir`(空字符串则用 tempdir 根),放入 `entry`
    /// 与若干 `siblings` 假文件。返回 `(TempDir, 子目录, 入口绝对路径)`——TempDir
    /// 必须保活,否则析构后 fs 文件消失、`is_file()` 失败,测试假绿。
    fn setup_sibling(
        subdir: &str,
        entry: &str,
        siblings: &[&str],
    ) -> (tempfile::TempDir, std::path::PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let sub = if subdir.is_empty() {
            dir.path().to_path_buf()
        } else {
            dir.path().join(subdir)
        };
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join(entry), "").unwrap();
        for s in siblings {
            std::fs::write(sub.join(s), "").unwrap();
        }
        let bin_path = sub.join(entry).to_string_lossy().to_string();
        (dir, sub, bin_path)
    }

    /// **必须与 `win_quote_path_for_batch` 主体保持镜像**——给 anchored 测试动态算
    /// expected,让用例在 temp 根目录含空格 / `&` / `(` / `%` 等特殊字符的开发机上
    /// 也能通过(默认 Windows `%TEMP%` = `C:\Users\<user>\AppData\Local\Temp`,
    /// 用户名带空格的机器整条 path 含空格、生产代码会正确加引号、测试硬编码无引号
    /// expected 会假失败)。
    ///
    /// 镜像引入"两边必须同步"的隐性依赖——回归防护层是 `win_quote_*` 那 7 个独立
    /// 单测,它们用硬编码字面值锁住 quoting 规则本身,即便此镜像漂移也会被那一组
    /// 测试 catch;反之亦然。
    fn expect_quoted_path(p: &str) -> String {
        let escaped = p.replace('%', "%%%%");
        let needs_quote = p
            .chars()
            .any(|c| matches!(c, ' ' | '&' | '(' | ')' | '^' | ';' | '<' | '>' | '|' | ','));
        if needs_quote {
            format!("\"{escaped}\"")
        } else {
            escaped
        }
    }

    #[test]
    fn volta_windows_uses_volta_install() {
        // tempdir 路径里不含 "volta" 子串,所以在 tempdir 下手建一个 `Volta` 子目录
        // 才能让 `infer_install_source` 通过路径 normalize 后命中 `/volta/` 分支。
        // sibling 候选顺序 `[exe, cmd]`——Volta 是 Rust 写的 native binary,首选 .exe。
        // expected 通过 `expect_quoted_path` 算出,以适应 temp 根目录含特殊字符的环境。
        let (_dir, sub, bin_path) = setup_sibling("Volta", "codex.cmd", &["volta.exe"]);
        let cmd = anchored_command_from_paths("codex", &bin_path, &bin_path);
        let volta_full = format!("{}\\volta.exe", sub.to_string_lossy());
        // codex 自 5092fe51 起不在 prefers_official_update：直接锚定包管理器，无 `codex update ||` 前缀。
        let expected = format!("{} install @openai/codex", expect_quoted_path(&volta_full));
        assert_eq!(cmd.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn pnpm_windows_uses_pnpm_add() {
        // bin_path 落 `%LOCALAPPDATA%\pnpm\codex.cmd`,sibling 有 `pnpm.cmd` → 锚定到
        // `<dir>\pnpm.cmd add -g @openai/codex@latest`。用 add+@latest 而非 update,
        // 兼容"之前没通过 pnpm 装过"的幂等性场景。
        let (_dir, sub, bin_path) = setup_sibling("pnpm", "codex.cmd", &["pnpm.cmd"]);
        let cmd = anchored_command_from_paths("codex", &bin_path, &bin_path);
        let pnpm_full = format!("{}\\pnpm.cmd", sub.to_string_lossy());
        // codex 自 5092fe51 起不在 prefers_official_update：直接锚定包管理器，无 `codex update ||` 前缀。
        let expected = format!(
            "{} add -g @openai/codex@latest",
            expect_quoted_path(&pnpm_full)
        );
        assert_eq!(cmd.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn opencode_windows_uses_package_fallback_without_official_upgrade() {
        let (_dir, sub, bin_path) = setup_sibling("pnpm", "opencode.cmd", &["pnpm.cmd"]);
        let cmd = anchored_command_from_paths("opencode", &bin_path, &bin_path);
        let pnpm_full = format!("{}\\pnpm.cmd", sub.to_string_lossy());
        let expected = format!(
            "{} add -g opencode-ai@latest",
            expect_quoted_path(&pnpm_full)
        );
        assert_eq!(cmd.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn opencode_windows_static_fallback_skips_official_upgrade() {
        let cmd = static_fallback_command("opencode");
        assert_eq!(cmd, "npm i -g opencode-ai@latest");
        assert!(!cmd.contains("opencode upgrade"));
    }

    #[test]
    fn npm_windows_default_branch() {
        // 任意 system 类路径(不命中 volta/pnpm)→ 兜底 sibling npm.cmd 锚定。
        // 模拟 nvm-windows 的实际形态:`<NVM_HOME>\v22.0.0\codex.cmd`。
        let (_dir, sub, bin_path) = setup_sibling("v22.0.0", "codex.cmd", &["npm.cmd"]);
        let cmd = anchored_command_from_paths("codex", &bin_path, &bin_path);
        let npm_full = format!("{}\\npm.cmd", sub.to_string_lossy());
        // codex 自 5092fe51 起不在 prefers_official_update：直接锚定包管理器，无 `codex update ||` 前缀。
        let expected = format!(
            "{} i -g @openai/codex@latest",
            expect_quoted_path(&npm_full)
        );
        assert_eq!(cmd.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn grok_windows_anchors_to_sibling_npm() {
        let (_dir, sub, bin_path) = setup_sibling("v22.0.0", "grok.cmd", &["npm.cmd"]);
        let cmd = anchored_command_from_paths("grok", &bin_path, &bin_path);
        let npm_full = format!("{}\\npm.cmd", sub.to_string_lossy());
        let expected = format!(
            "{} i -g @xai-official/grok@latest",
            expect_quoted_path(&npm_full)
        );
        assert_eq!(cmd.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn grok_native_windows_uses_self_update_with_installer_fallback() {
        // sibling 有 npm.cmd 也**不能**拿它当 fallback:`grok update` 本身就是靠 npm
        // 分发的(见 grok_native_update_command doc),npm fallback 与 primary 同源、
        // 会一起失败。fallback 必须是官方 PowerShell installer —— 唯一不经 npm 的路径。
        let (_dir, _sub, bin_path) = setup_sibling(".grok/bin", "grok.exe", &["npm.cmd"]);
        let cmd = anchored_command_from_paths("grok", &bin_path, &bin_path).unwrap();
        let expected = format!(
            "{} update || {}",
            expect_quoted_path(&bin_path),
            grok_install_windows_command()
        );
        assert_eq!(cmd, expected);
        // fallback 是 powershell.exe 不是 .cmd/.bat —— `||` 右侧不该有 `call`。
        assert!(
            !cmd.contains("|| call"),
            "powershell needs no `call`: {cmd}"
        );
        assert!(!cmd.contains("npm"), "npm must not be the fallback: {cmd}");
    }

    #[test]
    fn mcode_script_install_windows_reruns_installer_in_place() {
        // sibling 有 npm.cmd 也不能用：脚本安装不归全局 npm 管，npm 会装到另一处。
        let (_dir, sub, bin_path) =
            setup_sibling(".minimax-code", "mcode.cmd", &["mcode.ps1", "npm.cmd"]);
        let cmd = anchored_command_from_paths("mcode", &bin_path, &bin_path).unwrap();
        assert_eq!(cmd, mcode_installer_update_command(&sub.to_string_lossy()));
        assert!(!cmd.contains("npm"), "npm must not be used: {cmd}");
    }

    #[test]
    fn mcode_windows_installer_update_pins_install_root() {
        let cmd = mcode_installer_update_command("C:\\Users\\o'brien\\.minimax-code");
        let expected = powershell_encoded_command(
            "$env:MCODE_INSTALL_DIR = 'C:\\Users\\o''brien\\.minimax-code'; irm https://filecdn.minimax.chat/public/install.ps1 | iex",
        );
        assert_eq!(
            cmd.split_once("-EncodedCommand ")
                .map(|(_, encoded)| encoded),
            Some(expected.as_str())
        );
    }

    #[test]
    fn codex_standalone_windows_reruns_installer_in_place() {
        // #7650:独立安装的 codex.exe 旁边没有 npm.cmd,此前退回 `call npm i -g`
        // 另装一份 npm 版。
        let bin = r"C:\Users\o'brien\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe";
        let real = r"\\?\C:\Users\o'brien\.codex\packages\standalone\releases\0.157.0-x86_64-pc-windows-msvc\bin\codex.exe";
        let cmd = anchored_command_from_paths("codex", bin, real).unwrap();
        let expected = powershell_encoded_command(
            "$env:CODEX_NON_INTERACTIVE = '1'; $env:CODEX_INSTALL_DIR = 'C:\\Users\\o''brien\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin'; $env:CODEX_HOME = 'C:\\Users\\o''brien\\.codex'; irm https://chatgpt.com/codex/install.ps1 | iex",
        );
        assert_eq!(
            cmd.split_once("-EncodedCommand ")
                .map(|(_, encoded)| encoded),
            Some(expected.as_str())
        );
        assert!(!cmd.contains("npm"), "npm must not be used: {cmd}");
    }

    #[test]
    fn mcode_windows_npm_install_keeps_allow_scripts() {
        let (_dir, sub, bin_path) = setup_sibling("v22.19.0", "mcode.cmd", &["npm.cmd"]);
        let cmd = anchored_command_from_paths("mcode", &bin_path, &bin_path);
        let npm_full = format!("{}\\npm.cmd", sub.to_string_lossy());
        let expected = format!(
            "{} i -g @minimax-ai/code@latest{}",
            expect_quoted_path(&npm_full),
            npm_install_extra_args("mcode")
        );
        assert_eq!(cmd.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn mcode_windows_install_prefers_powershell_with_npm_fallback() {
        let install = static_fallback_command_for("mcode", ToolLifecycleAction::Install);
        let native = mcode_install_windows_command();
        assert_eq!(
            install,
            format!(
                "{native} || call {}",
                npm_install_command_for("mcode").unwrap()
            )
        );
        let expected_encoded = powershell_encoded_command(MCODE_INSTALL_WINDOWS_SCRIPT);
        assert_eq!(
            native
                .split_once("-EncodedCommand ")
                .map(|(_, encoded)| encoded),
            Some(expected_encoded.as_str())
        );
    }

    #[test]
    fn grok_windows_install_prefers_powershell_with_npm_fallback() {
        let install = static_fallback_command_for("grok", ToolLifecycleAction::Install);
        let native = grok_install_windows_command();
        assert!(
            install.starts_with(&native),
            "native installer first: {install}"
        );
        assert!(
            install.ends_with("|| call npm i -g @xai-official/grok@latest"),
            "npm fallback should remain available: {install}"
        );
        let expected_encoded = powershell_encoded_command(GROK_INSTALL_WINDOWS_SCRIPT);
        assert_eq!(
            native
                .split_once("-EncodedCommand ")
                .map(|(_, encoded)| encoded),
            Some(expected_encoded.as_str())
        );
    }

    #[test]
    fn windows_no_sibling_uses_cli_update_without_package_fallback() {
        // sibling 包管理器不存在(纯独立二进制)时,仍可锚定到 CLI 自身跑官方 update。
        // 只是没有包管理器 fallback。用 claude —— codex 自 5092fe51 起一律走 npm 锚定,
        // 已不再有官方 self-update 分支,故改用仍在 prefers_official_update 的 claude 覆盖此路径。
        let (_dir, _sub, bin_path) = setup_sibling("", "claude.cmd", &[]);
        let cmd = anchored_command_from_paths("claude", &bin_path, &bin_path);
        let expected = format!("{} update", expect_quoted_path(&bin_path));
        assert_eq!(cmd.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn hermes_windows_uses_cli_update() {
        // Hermes 自带 `hermes update`,不要再回退到 py/python/pip。即便同目录有
        // npm.cmd,也不应走 npm 分支。
        let (_dir, _sub, bin_path) = setup_sibling("", "hermes.exe", &["npm.cmd"]);
        let cmd = anchored_command_from_paths("hermes", &bin_path, &bin_path);
        let expected = format!("{} update", expect_quoted_path(&bin_path));
        assert_eq!(cmd.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn hermes_windows_static_fallback_uses_powershell_installer_without_pip() {
        let install = static_fallback_command_for("hermes", ToolLifecycleAction::Install);
        assert!(
            install.starts_with("powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "),
            "should use PowerShell EncodedCommand installer: {install}"
        );
        let encoded = install
            .split_once("-EncodedCommand ")
            .map(|(_, encoded)| encoded)
            .expect("installer should include encoded command");
        assert_eq!(
            encoded,
            powershell_encoded_command(HERMES_INSTALL_WINDOWS_SCRIPT)
        );
        let install_prefix = install
            .split_once("-EncodedCommand ")
            .map(|(prefix, _)| prefix)
            .expect("installer should include encoded command");
        assert!(
            !install_prefix.contains("|")
                && !install_prefix.contains("-Command")
                && !install_prefix.contains("python")
                && !install_prefix.contains("pip"),
            "should hide PowerShell pipe from cmd.exe and avoid system Python/pip: {install}"
        );

        let update = static_fallback_command("hermes");
        assert!(
            update.starts_with(
                "hermes update || powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "
            ),
            "should try CLI update before PowerShell installer: {update}"
        );
        let fallback = update
            .split_once("||")
            .map(|(_, fallback)| fallback)
            .expect("update should include a fallback command");
        let fallback_prefix = fallback
            .split_once("-EncodedCommand ")
            .map(|(prefix, _)| prefix)
            .expect("fallback should include encoded command");
        assert!(
            !fallback_prefix.contains('|')
                && !fallback_prefix.contains("-Command")
                && !update.contains("call powershell")
                && !fallback_prefix.contains("python")
                && !fallback_prefix.contains("pip"),
            "PowerShell fallback should be encoded, not called like a batch file or use pip: {update}"
        );
    }

    #[test]
    fn windows_path_with_space_is_double_quoted() {
        // 含空格的路径(`C:\Program Files\...`)在生成命令时必须用双引号包,否则
        // bat / cmd /C 解析会把第一个空格当 token 分隔符,后续参数串错。**精确等值断言
        // 锁定引号位置**(starts_with+contains 会放过"双引号位置错了但仍能命中"的回归)。
        let (_dir, sub, bin_path) = setup_sibling("Program Files", "codex.cmd", &["npm.cmd"]);
        let cmd = anchored_command_from_paths("codex", &bin_path, &bin_path);
        let npm_full = format!("{}\\npm.cmd", sub.to_string_lossy());
        // codex 走 npm 锚定(5092fe51),含空格的 npm 全路径仍必须被双引号包裹。
        let expected = format!(
            "{} i -g @openai/codex@latest",
            expect_quoted_path(&npm_full)
        );
        assert_eq!(cmd.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn windows_full_batch_line_for_percent_path_uses_quadruple_escape() {
        // **完整生成的 batch 行**(`call ` + anchored cmd)对含字面 `%` 的路径必须
        // 4 倍转义 `%foo%` → `%%%%foo%%%%`:.bat parser 一轮还原为 `%%foo%%`,call
        // 二轮再还原为 `%foo%` 字面。helper 单测验证的是 `win_quote_path_for_batch`
        // 内部转义,这条 integration 测验证 anchored_command_from_paths 输出 + call
        // 包装后,**最终落到 .bat 的字符串**仍然闭合两轮 expansion。
        let (_dir, sub, bin_path) = setup_sibling("path%foo%", "codex.cmd", &["npm.cmd"]);
        let anchored = anchored_command_from_paths("codex", &bin_path, &bin_path).unwrap();
        // build_tool_action_line Windows 分支最终拼的就是 `call <anchored>`(中间
        // 没有其他变换),这里直接用 format! 复刻那一步,无需暴露内部 API。
        let batch_line = format!("call {anchored}");
        // 用 `expect_quoted_path` 算 npm 全路径的期望 quoting,**同时覆盖 temp 根
        // 含空格的环境**(否则 sub 本身含空格 + 子目录 `path%foo%` 触发 4 倍 `%` 转义
        // 会让 expected 漏引号、假失败)。
        let npm_full = format!("{}\\npm.cmd", sub.to_string_lossy());
        // codex 走 npm 锚定(5092fe51)：batch 行 = `call <npm 全路径> i -g ...`，
        // 含字面 `%` 的 npm 路径仍须 4 倍转义。
        let expected = format!(
            "call {} i -g @openai/codex@latest",
            expect_quoted_path(&npm_full)
        );
        assert_eq!(batch_line, expected);
        // 双重锁定:确认 4 倍转义子串存在 + 不出现"残留的二倍转义或字面 `%foo%`"。
        assert!(
            batch_line.contains("%%%%foo%%%%"),
            "batch 行应含 4 倍转义 `%%%%foo%%%%`: {batch_line}"
        );
        assert!(
            !batch_line.contains("path%foo%"),
            "batch 行不应含未转义的字面 `%foo%`(会被 call 二次解析展开): {batch_line}"
        );
    }
}

/// Windows-only helpers 单测——在 macOS/Linux 上整块通过 cfg 排除,不参与 `cargo test`。
/// Windows CI(或本机 Windows 跑 cargo test)会激活这些用例。覆盖:①双引号
/// quoting 镜像 POSIX 版;②sibling_bin_with_ext 在 fs 上按 ext 顺序探到第一个存在的、
/// 全部不存在/空 dir 时返 None。tempdir 提供干净 fs 沙盒。
#[cfg(target_os = "windows")]
mod windows_helpers {
    use super::*;

    #[test]
    fn win_quote_clean_path_stays_bare() {
        // 普通路径不含特殊字符 → 不加引号,命令展示干净。
        assert_eq!(
            win_quote_path_for_batch("C:\\Users\\me\\npm.cmd"),
            "C:\\Users\\me\\npm.cmd"
        );
    }

    #[test]
    fn win_quote_spaced_path_gets_quoted() {
        assert_eq!(
            win_quote_path_for_batch("C:\\Program Files\\nodejs\\npm.cmd"),
            "\"C:\\Program Files\\nodejs\\npm.cmd\""
        );
    }

    #[test]
    fn win_quote_ampersand_path_gets_quoted() {
        // `&` 是 cmd 命令分隔符,NTFS 允许在路径中出现;没有引号会让 `call C:\A&B\npm.cmd`
        // 被解析为 `call C:\A` + `B\npm.cmd` 两条命令,执行错乱。
        assert_eq!(
            win_quote_path_for_batch("C:\\Tools&Dev\\npm.cmd"),
            "\"C:\\Tools&Dev\\npm.cmd\""
        );
    }

    #[test]
    fn win_quote_parens_path_gets_quoted() {
        // `(` / `)` 在 .bat 中是代码块语义,引号内才是字面意义。
        assert_eq!(
            win_quote_path_for_batch("C:\\Foo(x86)\\npm.cmd"),
            "\"C:\\Foo(x86)\\npm.cmd\""
        );
    }

    #[test]
    fn win_quote_caret_path_gets_quoted() {
        // `^` 是 cmd 的 escape character;包引号后是字面意义。
        assert_eq!(
            win_quote_path_for_batch("C:\\foo^bar\\npm.cmd"),
            "\"C:\\foo^bar\\npm.cmd\""
        );
    }

    #[test]
    fn win_quote_percent_is_escaped_to_quadruple_percent() {
        // `%` 经历 .bat 一轮 + call 二轮 expansion,要让 call 最终看到字面 `%FOO%`
        // 需要源 .bat 里写 `%%%%FOO%%%%`(一轮 → `%%FOO%%`,二轮 → `%FOO%` 字面)。
        // 用 `%%` 二倍转义只在 echo / 直接执行场景对,call 调用时会被还原成 variable
        // reference 进而被替换。**这一条用例锁住"call 二次解析"必须被 4 倍转义闭合**。
        assert_eq!(
            win_quote_path_for_batch("C:\\path%foo%\\npm.cmd"),
            "C:\\path%%%%foo%%%%\\npm.cmd"
        );
    }

    #[test]
    fn win_quote_percent_with_space_gets_both() {
        // `%` 4 倍转义与外层引号正交——含空格触发引号、含 `%` 触发 `%%%%` 转义,叠加。
        assert_eq!(
            win_quote_path_for_batch("C:\\my %dir%\\npm.cmd"),
            "\"C:\\my %%%%dir%%%%\\npm.cmd\""
        );
    }

    #[test]
    fn win_quote_needs_quote_uses_original_path() {
        // 回归 guard:`needs_quote` 判定基于**原路径**,不能用 escape 后字符串——
        // 否则原本无 token 边界字符的路径(如 `C:\path%foo%\npm.cmd`)在 escape
        // 引入更多 `%` 后被错误识别成"需要引号"。这是实现 bug 的隐性入口。
        // 入参不含任何 token 边界字符 → 不应加外层引号、只做 `%` 4 倍转义。
        let out = win_quote_path_for_batch("C:\\foo%bar%\\npm.cmd");
        assert!(!out.starts_with('"'), "纯 `%` 路径不应加外层引号: {out}");
    }

    #[test]
    fn sibling_bin_picks_first_existing_extension() {
        // 同目录同时存在 `npm.cmd` 和 `npm.exe` 时,候选顺序 `[cmd, exe]` 应取 .cmd——
        // 这是 Node.js 官方 installer 装出来的 idiom(.cmd 是入口、.exe 是 wrapper)。
        let dir = tempfile::tempdir().unwrap();
        let cmd_path = dir.path().join("npm.cmd");
        let exe_path = dir.path().join("npm.exe");
        std::fs::write(&cmd_path, "").unwrap();
        std::fs::write(&exe_path, "").unwrap();

        let codex = dir.path().join("codex.cmd").to_string_lossy().to_string();
        let found = sibling_bin_with_ext(&codex, "npm", &["cmd", "exe"]).unwrap();
        assert_eq!(found, cmd_path.to_string_lossy());
    }

    #[test]
    fn sibling_bin_volta_prefers_exe() {
        // Volta 是 Rust 写的 native binary,扩展名顺序应是 [exe, cmd]——若只有 .exe
        // 存在(常见情形),探到的就是它。
        let dir = tempfile::tempdir().unwrap();
        let exe_path = dir.path().join("volta.exe");
        std::fs::write(&exe_path, "").unwrap();

        let codex = dir.path().join("codex.exe").to_string_lossy().to_string();
        let found = sibling_bin_with_ext(&codex, "volta", &["exe", "cmd"]).unwrap();
        assert_eq!(found, exe_path.to_string_lossy());
    }

    #[test]
    fn sibling_bin_returns_none_when_none_exist() {
        // 同目录下没有任何候选 → None,锚定层据此退到静态命令。
        let dir = tempfile::tempdir().unwrap();
        let codex = dir.path().join("codex.cmd").to_string_lossy().to_string();
        assert!(sibling_bin_with_ext(&codex, "npm", &["cmd", "exe"]).is_none());
    }

    #[test]
    fn sibling_bin_returns_none_when_no_parent() {
        // bin_path 没有目录部分(纯文件名) → parent_dir 空串 → 返 None。
        assert!(sibling_bin_with_ext("codex.cmd", "npm", &["cmd"]).is_none());
    }

    #[test]
    fn wsl_hermes_command_uses_unix_installer_not_powershell_or_pip() {
        // 跨 wsl.exe 边界后跑的是 Linux,Windows PowerShell installer 不适用;
        // 也不要再走 python3/python pip 链,避免 Python 版本/pyenv shim 问题。
        let update_cmd =
            wsl_tool_action_shell_command("hermes", ToolLifecycleAction::Update).unwrap();
        assert!(
            update_cmd.starts_with("hermes update || bash -c 'tmp=$(mktemp) && curl -fsSL "),
            "WSL hermes 更新应先尝试 CLI 自更新再回退官方 installer,得到: {update_cmd}"
        );
        let fallback = update_cmd
            .split_once("||")
            .map(|(_, fallback)| fallback)
            .expect("update should include installer fallback");
        assert!(
            !fallback.contains('|')
                && fallback.contains(" -o $tmp && bash $tmp")
                && !update_cmd.contains("powershell")
                && !update_cmd.contains("pip"),
            "WSL hermes fallback 不能依赖 pipefail/Windows installer/pip,得到: {update_cmd}"
        );

        let install_cmd =
            wsl_tool_action_shell_command("hermes", ToolLifecycleAction::Install).unwrap();
        assert!(
            install_cmd.starts_with("bash -c 'tmp=$(mktemp) && curl -fsSL "),
            "WSL hermes 安装应直接走官方 Unix installer,得到: {install_cmd}"
        );
        assert!(
            !install_cmd.contains('|') && install_cmd.contains(" -o $tmp && bash $tmp"),
            "WSL hermes 安装不应依赖 pipefail,得到: {install_cmd}"
        );
    }

    #[test]
    fn wsl_hermes_install_line_does_not_depend_on_outer_pipefail() {
        let line = build_wsl_tool_action_line("Ubuntu", HERMES_INSTALL_UNIX, None, None)
            .expect("valid WSL command line");
        assert!(line.starts_with("wsl.exe -d Ubuntu -- sh -c "));
        assert!(
            !line.contains("| bash") && line.contains(" -o $tmp && bash $tmp"),
            "WSL 子 shell 内不能出现 curl 管道安装器: {line}"
        );
    }

    #[test]
    fn wsl_install_uses_posix_install_priority() {
        let claude = wsl_tool_action_shell_command("claude", ToolLifecycleAction::Install).unwrap();
        assert!(
            claude.starts_with("bash -c 'tmp=$(mktemp) && curl -fsSL https://claude.ai/install.sh ")
                && claude.ends_with(" || npm i -g @anthropic-ai/claude-code@latest --ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code"),
            "WSL claude install should prefer native POSIX installer with npm fallback: {claude}"
        );
        assert!(!claude.contains("| bash"));

        let opencode =
            wsl_tool_action_shell_command("opencode", ToolLifecycleAction::Install).unwrap();
        assert!(
            opencode.starts_with(
                "bash -c 'tmp=$(mktemp) && curl -fsSL https://opencode.ai/install "
            ) && opencode.contains(" || npm i -g opencode-ai@latest"),
            "WSL opencode install should prefer native POSIX installer with npm fallback: {opencode}"
        );
        assert!(!opencode.contains("| bash"));

        let codex = wsl_tool_action_shell_command("codex", ToolLifecycleAction::Install).unwrap();
        assert_eq!(codex, "npm i -g @openai/codex@latest");

        let grok = wsl_tool_action_shell_command("grok", ToolLifecycleAction::Install).unwrap();
        assert!(
            grok.starts_with("bash -c 'tmp=$(mktemp) && curl -fsSL https://x.ai/cli/install.sh ")
                && grok.contains(" || npm i -g @xai-official/grok@latest"),
            "WSL grok install should prefer native POSIX installer with npm fallback: {grok}"
        );
        assert!(!grok.contains("| bash"));
    }

    #[test]
    fn wsl_npm_tools_use_posix_update_chain_without_batch_call() {
        // WSL 内跑的是 POSIX shell,不能带 Windows batch 的 `call`。同时 update
        // fallback 仍应先尝试官方 CLI 自升级。
        let cmd = wsl_tool_action_shell_command("claude", ToolLifecycleAction::Update).unwrap();
        assert_eq!(
            cmd,
            "claude update || npm i -g @anthropic-ai/claude-code@latest --ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code"
        );
    }
}

/// `infer_install_source` 是判定锚定 idiom 的入口——nvm/homebrew/volta/pnpm/...
/// 各对应不同的升级命令形态。函数内部已 `replace('\\','/').to_ascii_lowercase()`
/// 归一化,Windows 反斜杠 + 大小写差异在此处不需要分平台。这里固化"哪条路径
/// 算哪种来源"的归类断言,避免未来调整子串顺序时静默改变分类。
mod install_source_classification {
    use super::*;
    use std::path::Path;

    #[test]
    fn macos_homebrew_caskroom_is_homebrew() {
        assert_eq!(
            infer_install_source(Path::new("/opt/homebrew/Caskroom/codex/0.146.0/bin/codex")),
            "homebrew"
        );
        // Intel prefix 不含 `/homebrew/`，必须靠 `/caskroom/` 本身命中。
        assert_eq!(
            infer_install_source(Path::new("/usr/local/Caskroom/codex/0.146.0/bin/codex")),
            "homebrew"
        );
    }

    #[test]
    fn intel_cask_launcher_uses_resolved_target() {
        // 标准 Intel cask：PATH 入口是 `/usr/local/bin/codex`，真身才在 Caskroom。
        // 只看 launcher 会落到 `system`，徽章和冲突诊断都会错。
        assert_eq!(
            infer_install_source(Path::new("/usr/local/bin/codex")),
            "system"
        );
        assert_eq!(
            infer_install_source_for_install(
                Path::new("/usr/local/bin/codex"),
                Path::new("/usr/local/Caskroom/codex/0.146.0/bin/codex"),
            ),
            "homebrew"
        );
        // nvm shim 仍按 launcher 分类，不能被真身路径抢走。
        assert_eq!(
            infer_install_source_for_install(
                Path::new("/Users/me/.nvm/versions/node/v22.0.0/bin/codex"),
                Path::new(
                    "/Users/me/.nvm/versions/node/v22.0.0/lib/node_modules/@openai/codex/bin/codex.js"
                ),
            ),
            "nvm"
        );
    }

    #[test]
    fn macos_volta_with_dot_prefix() {
        assert_eq!(
            infer_install_source(Path::new("/Users/me/.volta/bin/codex")),
            "volta"
        );
    }

    #[test]
    fn windows_volta_localappdata_no_dot() {
        // `%LOCALAPPDATA%\Volta\bin\codex.exe` —— 没有前导点,靠兜底的 `/volta/`
        // 命中(归一化后小写)。如果只识别 `/.volta/`,Windows 这一类会落到 system。
        assert_eq!(
            infer_install_source(Path::new(
                "C:\\Users\\me\\AppData\\Local\\Volta\\bin\\codex.exe"
            )),
            "volta"
        );
    }

    #[test]
    fn windows_pnpm_localappdata() {
        // `%LOCALAPPDATA%\pnpm\codex.cmd` —— pnpm 全局 bin 目录,识别为 pnpm 后
        // 锚定命令走 `pnpm add -g <pkg>@latest`,而不是 sibling npm。
        assert_eq!(
            infer_install_source(Path::new("C:\\Users\\me\\AppData\\Local\\pnpm\\codex.cmd")),
            "pnpm"
        );
    }

    #[test]
    fn windows_nvm_falls_back_to_system() {
        // nvm-windows 安装的工具路径不含 `.nvm`(它通常装在 `%APPDATA%\nvm` 或
        // `C:\Program Files\nodejs` symlink),刻意不识别成专属 source——锚定层
        // 会按 system → sibling npm.cmd 处理,跟 nvm-windows 的实际 idiom 一致
        // (它的全局包就是当前选中的 node 的 npm 装的)。
        assert_eq!(
            infer_install_source(Path::new(
                "C:\\Users\\me\\AppData\\Roaming\\nvm\\v22.0.0\\codex.cmd"
            )),
            "system"
        );
    }

    #[test]
    fn windows_scoop_still_identified() {
        // Scoop 已有 `/scoop/` 分支;我们的 6 个工具都不是 scoop formula,所以这条
        // 实际不影响锚定决策(锚定层会用 sibling npm.cmd),但归类保留方便未来。
        assert_eq!(
            infer_install_source(Path::new("C:\\Users\\me\\scoop\\shims\\codex.cmd")),
            "scoop"
        );
    }
}

/// 锚定升级命令生成：用真实勘察到的安装路径固化为回归断言——
/// 一台机器上 4 个工具恰好对应 4 种升级方式（原生 self-update / brew / nvm npm /
/// homebrew npm），任何改动若打破其中一种都会立刻被这些用例拦下。
#[cfg(not(target_os = "windows"))]
mod anchored_upgrade {
    use super::*;
    use std::path::Path;

    fn inst(path: &str, is_default: bool) -> ToolInstallation {
        ToolInstallation {
            path: path.to_string(),
            version: None,
            runnable: true,
            error: None,
            source: infer_install_source(Path::new(path)).to_string(),
            is_path_default: is_default,
            // 测试场景下不需要走 fs canonicalize——POSIX 锚定测试关心的是
            // path/real 都被传给 anchored_command_from_paths 的纯字符串判定,
            // 已有用例(brew_formula_extraction / claude_native_*)是直接
            // 调 anchored_command_from_paths,不通过 installs_anchored_command,
            // 这里 real 是给上层 default_install + read 用,填同值即可。
            real: std::path::PathBuf::from(path),
        }
    }

    #[test]
    fn claude_native_installer_uses_self_update() {
        // ~/.local/bin/claude → 真身在 ~/.local/share/claude/versions/,自带 self-update;
        // 它不归 npm 管,且在 PATH 里比 nvm/homebrew 更靠前,用 npm 升级纯属白装。
        // **绝对路径调用 launcher** 避免 GUI 非登录 `bash -c` 时 PATH 没有
        // ~/.local/bin 导致 `claude: not found`(exit 127)而失败。
        let cmd = anchored_command_from_paths(
            "claude",
            "/Users/me/.local/bin/claude",
            "/Users/me/.local/share/claude/versions/2.1.146",
        );
        assert_eq!(cmd.as_deref(), Some("/Users/me/.local/bin/claude update"));
    }

    #[test]
    fn grok_native_installer_uses_self_update_with_installer_fallback() {
        // ~/.grok/bin/grok is a launcher symlink into ~/.grok/downloads.
        // Updating it through npm would create or mutate a different install.
        let cmd = anchored_command_from_paths(
            "grok",
            "/Users/me/.grok/bin/grok",
            "/Users/me/.grok/downloads/grok-macos-aarch64",
        );
        assert_eq!(
            cmd.as_deref(),
            Some(format!("/Users/me/.grok/bin/grok update || {GROK_INSTALL_UNIX}").as_str())
        );
    }

    #[test]
    fn grok_native_update_falls_back_to_installer_not_npm() {
        // 反向锁定:`grok update` 内部靠 `npm view` + `npm i -g` 完成升级,GUI 的窄
        // PATH 下会 ENOENT。fallback 必须是官方 installer —— 换成 `npm i -g` 就与
        // primary 同源(无 node / 镜像缺 tarball 时一起失败),`||` 形同虚设。
        let cmd = anchored_command_from_paths(
            "grok",
            "/Users/me/.grok/bin/grok",
            "/Users/me/.grok/downloads/grok-macos-aarch64",
        )
        .expect("native grok should anchor");
        assert!(cmd.contains("x.ai/cli/install.sh"), "{cmd}");
        assert!(!cmd.contains("npm"), "npm must not be the fallback: {cmd}");
    }

    #[test]
    fn grok_custom_bin_dir_is_native_when_target_is_official_download() {
        let cmd = anchored_command_from_paths(
            "grok",
            "/Users/me/bin/grok",
            "/Users/me/.grok/downloads/grok-macos-aarch64",
        );
        assert_eq!(
            cmd.as_deref(),
            Some(format!("/Users/me/bin/grok update || {GROK_INSTALL_UNIX}").as_str())
        );
    }

    #[test]
    fn gemini_homebrew_formula_uses_brew_upgrade() {
        // /opt/homebrew/bin/gemini → Cellar/gemini-cli/...:是 brew formula 而非 npm 全局包,
        // 且 formula 名(gemini-cli) ≠ npm 包名(@google/gemini-cli)。
        // **brew 与 formula 入口同目录**,用 `<dir>/brew` 绝对路径调用,避免 GUI
        // 非登录 `bash -c` 时 PATH 没有 /opt/homebrew/bin 导致 `brew: not found`。
        let cmd = anchored_command_from_paths(
            "gemini",
            "/opt/homebrew/bin/gemini",
            "/opt/homebrew/Cellar/gemini-cli/0.13.0/libexec/lib/node_modules/@google/gemini-cli/dist/index.js",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("/opt/homebrew/bin/brew upgrade gemini-cli")
        );
    }

    #[test]
    fn codex_homebrew_formula_uses_brew_not_self_update() {
        // Homebrew formula 归 brew 管理;即使 Codex 有 self-update,也不先改动
        // Cellar 内的安装内容。
        let cmd = anchored_command_from_paths(
            "codex",
            "/opt/homebrew/bin/codex",
            "/opt/homebrew/Cellar/codex/1.2.3/bin/codex",
        );
        assert_eq!(cmd.as_deref(), Some("/opt/homebrew/bin/brew upgrade codex"));
    }

    #[test]
    fn codex_homebrew_cask_uses_brew_upgrade_cask() {
        // `/opt/homebrew/bin/codex` → Caskroom/codex/...:是 brew cask 而非 npm 全局包。
        // 若误走 sibling `npm i -g @openai/codex`，npm bin-links 会因
        // `/opt/homebrew/bin/codex` 不属于它而 EEXIST（#6562）。
        let cmd = anchored_command_from_paths(
            "codex",
            "/opt/homebrew/bin/codex",
            "/opt/homebrew/Caskroom/codex/0.146.0/bin/codex",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("/opt/homebrew/bin/brew upgrade --cask codex")
        );
    }

    #[test]
    fn intel_homebrew_cask_without_homebrew_prefix_still_uses_brew() {
        // Intel 默认 prefix 是 `/usr/local`，Caskroom 路径不含 `/homebrew/`。
        // 真身解析必须靠 `Caskroom` 段本身，不能依赖 prefix 子串。
        let cmd = anchored_command_from_paths(
            "codex",
            "/usr/local/bin/codex",
            "/usr/local/Caskroom/codex/0.146.0/bin/codex",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("/usr/local/bin/brew upgrade --cask codex")
        );
    }

    #[test]
    fn gemini_nvm_anchors_to_npm_without_cli_update() {
        let cmd = anchored_command_from_paths(
            "gemini",
            "/Users/me/.nvm/versions/node/v22.14.0/bin/gemini",
            "/Users/me/.nvm/versions/node/v22.14.0/lib/node_modules/@google/gemini-cli/dist/index.js",
        );
        assert_eq!(
            cmd.as_deref(),
            Some(
                "PATH='/Users/me/.nvm/versions/node/v22.14.0/bin':\"$PATH\" /Users/me/.nvm/versions/node/v22.14.0/bin/npm i -g @google/gemini-cli@latest"
            )
        );
    }

    #[test]
    fn grok_nvm_anchors_to_npm_without_cli_update() {
        let cmd = anchored_command_from_paths(
            "grok",
            "/Users/me/.nvm/versions/node/v22.14.0/bin/grok",
            "/Users/me/.nvm/versions/node/v22.14.0/lib/node_modules/@xai-official/grok/bin/grok",
        );
        assert_eq!(
            cmd.as_deref(),
            Some(
                "PATH='/Users/me/.nvm/versions/node/v22.14.0/bin':\"$PATH\" /Users/me/.nvm/versions/node/v22.14.0/bin/npm i -g @xai-official/grok@latest"
            )
        );
    }

    #[test]
    fn mcode_script_install_reruns_official_installer_in_place() {
        // `~/.minimax-code/bin/mcode` 是官方 installer 的 sh launcher，不归全局 npm 管；
        // `mcode update` 非 TTY 下不安装，所以改为带 MCODE_INSTALL_DIR 重跑 installer。
        let expected = format!("MCODE_INSTALL_DIR='/Users/me/.minimax-code' {MCODE_INSTALL_UNIX}");
        for bin_path in [
            "/Users/me/.minimax-code/bin/mcode",
            "/Users/me/.local/bin/mcode",
        ] {
            let cmd =
                anchored_command_from_paths("mcode", bin_path, "/Users/me/.minimax-code/bin/mcode");
            assert_eq!(cmd.as_deref(), Some(expected.as_str()));
        }
    }

    #[test]
    fn mcode_nvm_anchors_to_npm_with_allow_scripts() {
        let cmd = anchored_command_from_paths(
            "mcode",
            "/Users/me/.nvm/versions/node/v22.19.0/bin/mcode",
            "/Users/me/.nvm/versions/node/v22.19.0/lib/node_modules/@minimax-ai/code/cli.js",
        );
        assert_eq!(
            cmd.as_deref(),
            Some(
                "PATH='/Users/me/.nvm/versions/node/v22.19.0/bin':\"$PATH\" /Users/me/.nvm/versions/node/v22.19.0/bin/npm i -g @minimax-ai/code@latest --ignore-scripts=false --include=optional \"--allow-scripts=@minimax-ai/code,better-sqlite3\""
            )
        );
    }

    #[test]
    fn claude_npm_sources_scope_postinstall_settings_to_primary_and_full_fallback() {
        for (path, dir) in [
            (
                "/Users/me/.nvm/versions/node/v22/bin/claude",
                "/Users/me/.nvm/versions/node/v22/bin",
            ),
            (
                "/Users/me/.local/share/fnm_multishells/12345_abc/bin/claude",
                "/Users/me/.local/share/fnm_multishells/12345_abc/bin",
            ),
            (
                "/Users/me/.local/share/mise/installs/node/22/bin/claude",
                "/Users/me/.local/share/mise/installs/node/22/bin",
            ),
            ("/opt/homebrew/bin/claude", "/opt/homebrew/bin"),
        ] {
            let mut install = inst(path, true);
            install.real = PathBuf::from(format!(
                "{}/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
                dir.trim_end_matches("/bin")
            ));
            let command = installs_anchored_command("claude", &[install]).unwrap();
            let (primary, fallback) = command.split_once(" || ").unwrap();
            assert_eq!(
                primary,
                format!(
                    "npm_config_allow_scripts=@anthropic-ai/claude-code npm_config_ignore_scripts=false npm_config_include=optional {path} update"
                )
            );
            assert_eq!(
                fallback,
                format!(
                    "PATH='{dir}':\"$PATH\" {dir}/npm i -g @anthropic-ai/claude-code@latest --ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code"
                )
            );
        }
    }

    #[test]
    fn claude_system_npm_prefixes_scope_postinstall_settings_without_fallback() {
        // Launchers classified as `system` have no sibling-npm fallback, so the
        // primary update is their only chance to keep npm 12 from breaking Claude.
        for (path, real) in [
            (
                "/usr/local/bin/claude",
                "/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
            ),
            (
                "/Users/me/.npm-global/bin/claude",
                "/Users/me/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
            ),
            (
                "/usr/bin/claude",
                "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            ),
        ] {
            assert_eq!(
                anchored_command_from_paths("claude", path, real),
                Some(format!(
                    "npm_config_allow_scripts=@anthropic-ai/claude-code npm_config_ignore_scripts=false npm_config_include=optional {path} update"
                ))
            );
        }
    }

    #[test]
    fn claude_other_install_sources_keep_their_update_policy() {
        for (path, real, expected) in [
            (
                "/Users/me/.nvm/versions/node/v22/bin/claude",
                "/Users/me/.local/share/claude/versions/2.1.146",
                "/Users/me/.nvm/versions/node/v22/bin/claude update",
            ),
            (
                "/opt/homebrew/bin/claude",
                "/opt/homebrew/Cellar/claude-code/2.1.146/bin/claude",
                "/opt/homebrew/bin/brew upgrade claude-code",
            ),
            (
                "/Users/me/.volta/bin/claude",
                "/Users/me/.volta/bin/claude",
                "/Users/me/.volta/bin/claude update || /Users/me/.volta/bin/volta install @anthropic-ai/claude-code",
            ),
            (
                "/Users/me/.bun/bin/claude",
                "/Users/me/.bun/bin/claude",
                "/Users/me/.bun/bin/claude update || /Users/me/.bun/bin/bun add -g @anthropic-ai/claude-code@latest",
            ),
            (
                "/usr/local/bin/claude",
                "/usr/local/bin/claude",
                "/usr/local/bin/claude update",
            ),
        ] {
            assert_eq!(
                anchored_command_from_paths("claude", path, real).as_deref(),
                Some(expected)
            );
        }
    }

    #[test]
    fn claude_updater_child_inherits_scoped_settings_without_parent_leakage() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let temp = tempfile::tempdir().expect("temp dir should be created");
        let bin = temp.path().join("home dir/.nvm/versions/node/v22/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let claude = bin.join("claude");
        let npm = bin.join("npm");
        std::fs::write(
            &claude,
            "#!/bin/sh\n[ \"$1\" = update ] || exit 99\nnpm install -g @anthropic-ai/claude-code@latest\nexit \"$TEST_CLAUDE_EXIT\"\n",
        )
        .unwrap();
        std::fs::write(
            &npm,
            "#!/bin/sh\nprintf '%s|%s|%s|%s\n' \"\u{24}{npm_config_allow_scripts-unset}\" \"\u{24}{npm_config_ignore_scripts-unset}\" \"\u{24}{npm_config_include-unset}\" \"\u{24}*\"\n[ \"$1\" != i ] || exit \"$TEST_FALLBACK_EXIT\"\n",
        )
        .unwrap();
        for executable in [&claude, &npm] {
            std::fs::set_permissions(executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let mut install = inst(&claude.to_string_lossy(), true);
        install.real = temp.path().join(
            "home dir/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
        );
        let command = installs_anchored_command("claude", &[install]).unwrap();
        let script = format!(
            "set -e\n{command}\nprintf 'after|%s|%s|%s\n' \"$npm_config_allow_scripts\" \"$npm_config_ignore_scripts\" \"$npm_config_include\""
        );
        let primary = "@anthropic-ai/claude-code|false|optional|install -g @anthropic-ai/claude-code@latest\n";
        let fallback = "previous-package|true|prod|i -g @anthropic-ai/claude-code@latest --ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code\n";
        for (primary_exit, fallback_exit, expected_code, expected_output) in [
            (
                "0",
                "0",
                0,
                format!("{primary}after|previous-package|true|prod\n"),
            ),
            (
                "1",
                "0",
                0,
                format!("{primary}{fallback}after|previous-package|true|prod\n"),
            ),
            ("1", "42", 42, format!("{primary}{fallback}")),
        ] {
            let output = Command::new("/bin/bash")
                .args(["-c", &script])
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .env("npm_config_allow_scripts", "previous-package")
                .env("npm_config_ignore_scripts", "true")
                .env("npm_config_include", "prod")
                .env("TEST_CLAUDE_EXIT", primary_exit)
                .env("TEST_FALLBACK_EXIT", fallback_exit)
                .output()
                .expect("Claude update chain should start");
            assert_eq!(
                output.status.code(),
                Some(expected_code),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(String::from_utf8_lossy(&output.stdout), expected_output);
        }
    }

    #[test]
    fn codex_nvm_anchors_to_that_npm() {
        // Codex 不走 self-update（`codex update` 在 npm 安装上只是裸 `npm install -g`，
        // 却会假成功掩盖平台二进制漏装）——直接锚定到同一个 node 的 npm，而非 PATH
        // 第一个 npm。损坏时的 uninstall+install 自愈见 codex_missing_platform_binary_*。
        let cmd = anchored_command_from_paths(
            "codex",
            "/Users/me/.nvm/versions/node/v22.14.0/bin/codex",
            "/Users/me/.nvm/versions/node/v22.14.0/lib/node_modules/@openai/codex/bin/codex.js",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("PATH='/Users/me/.nvm/versions/node/v22.14.0/bin':\"$PATH\" /Users/me/.nvm/versions/node/v22.14.0/bin/npm i -g @openai/codex@latest")
        );
    }

    #[test]
    fn homebrew_npm_global_package_anchors_not_brew() {
        // openclaw 装在 Homebrew node 的全局目录(lib/node_modules，非 Cellar)：
        // 是 npm 全局包，官方 update 失败后走 npm 锚定而非 brew upgrade。
        let cmd = anchored_command_from_paths(
            "openclaw",
            "/opt/homebrew/bin/openclaw",
            "/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("/opt/homebrew/bin/openclaw update --yes || PATH='/opt/homebrew/bin':\"$PATH\" /opt/homebrew/bin/npm i -g openclaw@latest")
        );
    }

    #[test]
    fn volta_self_update_chain_anchors_to_volta() {
        // `~/.volta/bin` 通常不在 GUI 非登录 `bash -c` 的 PATH 里,且用户可能
        // PATH 上还有另一份 volta → 必须绝对路径锚定到命令行命中的这一份。
        // 用 openclaw（仍在 prefers_official_update）覆盖 volta 分支的 self-update 链;
        // codex 已改为不 self-update（见 codex_volta_anchors_to_volta_install）。
        let cmd = anchored_command_from_paths(
            "openclaw",
            "/Users/me/.volta/bin/openclaw",
            "/Users/me/.volta/tools/image/packages/openclaw/lib/node_modules/openclaw",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("/Users/me/.volta/bin/openclaw update --yes || /Users/me/.volta/bin/volta install openclaw")
        );
    }

    #[test]
    fn codex_volta_anchors_to_volta_install() {
        // codex 锚定到命令行命中的那份 volta，但不 self-update：纯 `volta install`。
        let cmd = anchored_command_from_paths(
            "codex",
            "/Users/me/.volta/bin/codex",
            "/Users/me/.volta/tools/image/packages/codex/lib/node_modules/@openai/codex",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("/Users/me/.volta/bin/volta install @openai/codex")
        );
    }

    #[test]
    fn bun_uses_bun_add() {
        // OpenCode 先跑官方 upgrade;失败后 bun 同 volta:绝对路径写回原安装源。
        let cmd = anchored_command_from_paths(
            "opencode",
            "/Users/me/.bun/bin/opencode",
            "/Users/me/.bun/install/global/node_modules/opencode-ai/bin/opencode",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("/Users/me/.bun/bin/opencode upgrade || /Users/me/.bun/bin/bun add -g opencode-ai@latest")
        );
    }

    #[test]
    fn volta_path_with_space_is_quoted() {
        // volta 分支用 `<dir>/volta`,目录含空格时同样要 POSIX 引号包裹。
        let cmd = anchored_command_from_paths(
            "codex",
            "/Users/my name/.volta/bin/codex",
            "/Users/my name/.volta/tools/image/packages/codex/lib/node_modules/@openai/codex",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("'/Users/my name/.volta/bin/volta' install @openai/codex")
        );
    }

    #[test]
    fn bun_path_with_space_is_quoted() {
        // bun 分支与 volta 共享 sibling_bin + quote_path_if_spaced,
        // 这条用例锁住 `bun add -g` 命令头部的引号包裹形态。
        let cmd = anchored_command_from_paths(
            "opencode",
            "/Users/my name/.bun/bin/opencode",
            "/Users/my name/.bun/install/global/node_modules/opencode-ai/bin/opencode",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("'/Users/my name/.bun/bin/opencode' upgrade || '/Users/my name/.bun/bin/bun' add -g opencode-ai@latest")
        );
    }

    #[test]
    fn hermes_uses_cli_update_anchor() {
        // Hermes 自带 `hermes update`;锚定到命令行默认那处 CLI,避免 cc-switch 猜
        // 系统 Python/pip 时撞上 Python >=3.11 或 pyenv shim 问题。
        let cmd =
            anchored_command_from_paths("hermes", "/usr/local/bin/hermes", "/usr/local/bin/hermes");
        assert_eq!(cmd.as_deref(), Some("/usr/local/bin/hermes update"));
    }

    #[test]
    fn opencode_native_install_uses_cli_upgrade_without_package_fallback() {
        // opencode install.sh 装到 ~/.opencode/bin（独立二进制、无同级 npm）：
        // 不能锚定到 `<dir>/npm`（必失败），但可以锚定到 CLI 自身跑官方 upgrade。
        let cmd = anchored_command_from_paths(
            "opencode",
            "/Users/me/.opencode/bin/opencode",
            "/Users/me/.opencode/bin/opencode",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("/Users/me/.opencode/bin/opencode upgrade")
        );
    }

    #[test]
    fn go_bin_opencode_uses_cli_upgrade_without_package_fallback() {
        // ~/go/bin 同理：无同级 npm，但 OpenCode 官方 upgrade 可由 CLI 自己处理。
        let cmd = anchored_command_from_paths(
            "opencode",
            "/Users/me/go/bin/opencode",
            "/Users/me/go/bin/opencode",
        );
        assert_eq!(cmd.as_deref(), Some("/Users/me/go/bin/opencode upgrade"));
    }

    #[test]
    fn fnm_install_anchors_to_that_npm() {
        // fnm 是自带同级 npm 的 node 管理器 → 锚定到那处的 npm。
        let cmd = anchored_command_from_paths(
            "codex",
            "/Users/me/.local/share/fnm_multishells/12345_abc/bin/codex",
            "/Users/me/.local/share/fnm_multishells/12345_abc/lib/node_modules/@openai/codex/bin/codex.js",
        );
        assert_eq!(
            cmd.as_deref(),
            Some(
                "PATH='/Users/me/.local/share/fnm_multishells/12345_abc/bin':\"$PATH\" /Users/me/.local/share/fnm_multishells/12345_abc/bin/npm i -g @openai/codex@latest"
            )
        );
    }

    #[test]
    fn path_with_space_is_quoted() {
        let cmd = anchored_command_from_paths(
            "codex",
            "/Users/my name/.nvm/versions/node/v22/bin/codex",
            "/Users/my name/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("PATH='/Users/my name/.nvm/versions/node/v22/bin':\"$PATH\" '/Users/my name/.nvm/versions/node/v22/bin/npm' i -g @openai/codex@latest")
        );
    }

    #[test]
    fn npm_anchor_supplies_sibling_node_to_env_shebang() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let temp = tempfile::tempdir().expect("temp dir should be created");
        let bin = temp.path().join("home dir/.nvm/versions/node/v22.14.0/bin");
        std::fs::create_dir_all(&bin).expect("node bin should be created");

        let marker = temp.path().join("sibling-node-used");
        let node = bin.join("node");
        let npm = bin.join("npm");
        std::fs::write(
            &node,
            format!(
                "#!/bin/sh\nprintf sibling-node > {}\n",
                shell_single_quote(&marker.to_string_lossy())
            ),
        )
        .expect("fake node should be written");
        std::fs::write(&npm, "#!/usr/bin/env node\n").expect("fake npm should be written");
        for executable in [&node, &npm] {
            let mut permissions = std::fs::metadata(executable)
                .expect("fake executable metadata should exist")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(executable, permissions)
                .expect("fake executable should be executable");
        }

        let codex = bin.join("codex").to_string_lossy().into_owned();
        let real = temp
            .path()
            .join(
                "home dir/.nvm/versions/node/v22.14.0/lib/node_modules/@openai/codex/bin/codex.js",
            )
            .to_string_lossy()
            .into_owned();
        let command = anchored_command_from_paths("codex", &codex, &real)
            .expect("nvm codex should produce an anchored npm command");
        let output = Command::new("/bin/bash")
            .args(["-c", &command])
            .env("PATH", "/usr/bin:/bin")
            .output()
            .expect("anchored npm command should start");

        assert!(
            output.status.success(),
            "anchored npm command failed: {}",
            decode_command_output(&output.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(marker).expect("sibling node should leave a marker"),
            "sibling-node"
        );
    }

    #[test]
    fn claude_native_path_with_space_is_quoted() {
        // claude 分支同样要 POSIX 引号包裹含空格的 bin_path,
        // 否则 `/Users/my name/.local/bin/claude update` 会被 shell 拆词。
        let cmd = anchored_command_from_paths(
            "claude",
            "/Users/my name/.local/bin/claude",
            "/Users/my name/.local/share/claude/versions/2.1.146",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("'/Users/my name/.local/bin/claude' update")
        );
    }

    #[test]
    fn brew_path_with_space_is_quoted() {
        // brew 分支用 `<bin_path 同目录>/brew`,目录含空格时同样要引号包裹。
        let cmd = anchored_command_from_paths(
            "gemini",
            "/opt/my brew/bin/gemini",
            "/opt/my brew/Cellar/gemini-cli/0.13.0/libexec/lib/node_modules/@google/gemini-cli/dist/index.js",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("'/opt/my brew/bin/brew' upgrade gemini-cli")
        );
    }

    #[test]
    fn brew_cask_path_with_space_is_quoted() {
        let cmd = anchored_command_from_paths(
            "codex",
            "/opt/my brew/bin/codex",
            "/opt/my brew/Caskroom/codex/0.146.0/bin/codex",
        );
        assert_eq!(
            cmd.as_deref(),
            Some("'/opt/my brew/bin/brew' upgrade --cask codex")
        );
    }

    #[test]
    fn brew_formula_extraction() {
        assert_eq!(
            brew_formula_from_path("/opt/homebrew/Cellar/gemini-cli/0.13.0/bin/gemini").as_deref(),
            Some("gemini-cli")
        );
        // node 全局包不在 Cellar 下 → 不是 formula。
        assert_eq!(
            brew_formula_from_path("/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs"),
            None
        );
        assert_eq!(
            brew_formula_from_path("/Users/me/.nvm/versions/node/v22/lib/node_modules/x"),
            None
        );
        // Caskroom 不是 formula。
        assert_eq!(
            brew_formula_from_path("/opt/homebrew/Caskroom/codex/0.146.0/bin/codex"),
            None
        );
    }

    #[test]
    fn brew_cask_extraction() {
        assert_eq!(
            brew_cask_from_path("/opt/homebrew/Caskroom/codex/0.146.0/bin/codex").as_deref(),
            Some("codex")
        );
        // Intel prefix 不含 /homebrew/，仍能抽出 token。
        assert_eq!(
            brew_cask_from_path("/usr/local/Caskroom/codex/0.146.0/bin/codex").as_deref(),
            Some("codex")
        );
        // formula / npm 全局包都不是 cask。
        assert_eq!(
            brew_cask_from_path("/opt/homebrew/Cellar/codex/1.2.3/bin/codex"),
            None
        );
        assert_eq!(
            brew_cask_from_path("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"),
            None
        );
    }

    #[test]
    fn sibling_bin_returns_none_when_bin_path_has_no_directory() {
        // bin_path 不含 `/` → parent_dir 返回空 → sibling_bin 不能拼出绝对路径
        // → None,让上游 anchored_command_from_paths 整体退化为静态命令兜底,
        // 而不是悄悄拼出 `npm i -g <pkg>` 这种依赖 PATH 的指令(违背"必须绝对路径"
        // 不变量)。实际从 enumerate_tool_installations 走的 bin_path 都是绝对路径,
        // 这条防线不期望被触发,但闭合了 helper 与函数文档的语义一致。
        assert_eq!(sibling_bin("codex", "npm"), None);
        assert_eq!(sibling_bin("", "brew"), None);
        // 含 `/` 即可拼出绝对路径——这是常规路径。
        assert_eq!(
            sibling_bin("/opt/homebrew/bin/gemini", "brew").as_deref(),
            Some("/opt/homebrew/bin/brew")
        );
    }

    #[test]
    fn default_install_prefers_path_default() {
        let installs = vec![
            inst("/opt/homebrew/bin/openclaw", false),
            inst("/Users/me/.nvm/versions/node/v22/bin/openclaw", true),
        ];
        assert_eq!(
            default_install(&installs).map(|i| i.path.as_str()),
            Some("/Users/me/.nvm/versions/node/v22/bin/openclaw")
        );
    }

    #[test]
    fn default_install_falls_back_to_sole_entry() {
        let installs = vec![inst("/opt/homebrew/bin/gemini", false)];
        assert_eq!(
            default_install(&installs).map(|i| i.path.as_str()),
            Some("/opt/homebrew/bin/gemini")
        );
    }

    #[test]
    fn default_install_none_when_ambiguous() {
        let installs = vec![
            inst("/opt/homebrew/bin/openclaw", false),
            inst("/Users/me/.nvm/versions/node/v22/bin/openclaw", false),
        ];
        assert!(default_install(&installs).is_none());
    }

    #[test]
    fn codex_missing_platform_binary_self_heals_via_uninstall_install() {
        // 平台二进制缺失 → `codex --version` 报 "Missing optional dependency" 退出非 0
        // → enumerate 标记 runnable=false。此状态下普通 `npm i -g @latest` 是 no-op 修不好,
        // 升级路径改用 uninstall+install 重装补回平台二进制（`|| true` 让 uninstall 在
        // set -e 下对半损坏包返回非 0 时仍继续 install）。
        let mut broken = inst("/Users/me/.nvm/versions/node/v22.14.0/bin/codex", true);
        broken.runnable = false;
        assert_eq!(
            installs_anchored_command("codex", &[broken]).as_deref(),
            Some("PATH='/Users/me/.nvm/versions/node/v22.14.0/bin':\"$PATH\" /Users/me/.nvm/versions/node/v22.14.0/bin/npm uninstall -g @openai/codex || true; PATH='/Users/me/.nvm/versions/node/v22.14.0/bin':\"$PATH\" /Users/me/.nvm/versions/node/v22.14.0/bin/npm i -g @openai/codex@latest")
        );
    }

    #[test]
    fn codex_runnable_uses_plain_npm_not_self_heal() {
        // 正常（runnable=true）的 codex 升级：锚定 npm，既不重装、也不跑会假成功
        // 掩盖损坏的 `codex update`。
        let healthy = inst("/Users/me/.nvm/versions/node/v22.14.0/bin/codex", true);
        let cmd = installs_anchored_command("codex", &[healthy]);
        assert_eq!(
            cmd.as_deref(),
            Some("PATH='/Users/me/.nvm/versions/node/v22.14.0/bin':\"$PATH\" /Users/me/.nvm/versions/node/v22.14.0/bin/npm i -g @openai/codex@latest")
        );
        assert!(!cmd.unwrap().contains("uninstall"));
    }

    #[test]
    fn codex_broken_homebrew_formula_uses_brew_not_npm_repair() {
        // brew formula 装的坏 codex（real 在 Cellar）：自愈门控必须收窄放行，回落到
        // `brew upgrade codex`——若误走 npm 重装，npm 够不到 Cellar 那份、反而旁路
        // 装第二份 npm 全局 codex 制造双安装。
        let broken = ToolInstallation {
            path: "/opt/homebrew/bin/codex".to_string(),
            version: None,
            runnable: false,
            error: None,
            source: "homebrew".to_string(),
            is_path_default: true,
            real: std::path::PathBuf::from("/opt/homebrew/Cellar/codex/1.2.3/bin/codex"),
        };
        assert_eq!(
            installs_anchored_command("codex", &[broken]).as_deref(),
            Some("/opt/homebrew/bin/brew upgrade codex")
        );
    }

    #[test]
    fn codex_broken_homebrew_cask_uses_brew_not_npm_repair() {
        // brew cask 装的坏 codex（real 在 Caskroom）：与 formula 同理，必须回落到
        // `brew upgrade --cask`。误走 npm uninstall+install 会撞 EEXIST，或旁路
        // 装第二份 npm 全局包争抢同一个 `/opt/homebrew/bin/codex`。
        let broken = ToolInstallation {
            path: "/opt/homebrew/bin/codex".to_string(),
            version: None,
            runnable: false,
            error: None,
            source: "homebrew".to_string(),
            is_path_default: true,
            real: std::path::PathBuf::from("/opt/homebrew/Caskroom/codex/0.146.0/bin/codex"),
        };
        assert_eq!(
            installs_anchored_command("codex", &[broken]).as_deref(),
            Some("/opt/homebrew/bin/brew upgrade --cask codex")
        );
    }

    #[test]
    fn codex_broken_volta_uses_volta_install_not_npm_repair() {
        // volta 装的坏 codex：回落到 `volta install`，不走 npm 重装。
        let mut broken = inst("/Users/me/.volta/bin/codex", true);
        broken.runnable = false;
        assert_eq!(
            installs_anchored_command("codex", &[broken]).as_deref(),
            Some("/Users/me/.volta/bin/volta install @openai/codex")
        );
    }

    #[test]
    fn codex_broken_bun_uses_bun_add_not_phantom_npm() {
        // bun 装的坏 codex：回落到 `bun add`，且**绝不**拼出 `~/.bun/bin/npm`
        // （bun 目录下没有 npm，那条路径不存在、执行会直接失败）。
        let mut broken = inst("/Users/me/.bun/bin/codex", true);
        broken.runnable = false;
        let cmd = installs_anchored_command("codex", &[broken]);
        assert_eq!(
            cmd.as_deref(),
            Some("/Users/me/.bun/bin/bun add -g @openai/codex@latest")
        );
        assert!(!cmd.unwrap().contains("npm"));
    }

    #[test]
    fn codex_standalone_reruns_official_installer_in_place() {
        // #7650:官方独立安装器装的 codex 此前被判 system 来源、锚定落空,退回裸
        // `npm i -g` 另装一份 npm 版。现在带 CODEX_INSTALL_DIR / CODEX_HOME 重跑官方
        // installer;不用 `codex update`——它断网时 exit 0 假成功。
        let cmd = anchored_command_from_paths(
            "codex",
            "/Users/me/.local/bin/codex",
            "/Users/me/.codex/packages/standalone/releases/0.157.0-aarch64-apple-darwin/bin/codex",
        )
        .unwrap();
        assert_eq!(
            cmd,
            format!(
                "CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR='/Users/me/.local/bin' CODEX_HOME='/Users/me/.codex' {CODEX_INSTALL_UNIX}"
            )
        );
        assert!(!cmd.contains("npm"), "npm must not be used: {cmd}");
        assert!(
            !cmd.contains("codex update"),
            "codex update fakes success: {cmd}"
        );
    }

    #[test]
    fn codex_standalone_custom_dirs_are_written_back() {
        // 自定义 CODEX_INSTALL_DIR / CODEX_HOME 装的一处:不显式传回去,installer 会装进
        // 默认的 ~/.local/bin 与 ~/.codex,命令行实际在用的那份原地不动。
        let cmd = anchored_command_from_paths(
            "codex",
            "/opt/tools/codex bin/codex",
            "/data/codex-home/packages/standalone/releases/0.157.0-x86_64-unknown-linux-musl/bin/codex",
        );
        assert_eq!(
            cmd,
            Some(format!(
                "CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR='/opt/tools/codex bin' CODEX_HOME='/data/codex-home' {CODEX_INSTALL_UNIX}"
            ))
        );
    }

    #[test]
    fn codex_broken_standalone_reinstalls_via_installer_not_npm_repair() {
        // 跑不起来的独立安装版:npm 自愈门控只放行 nvm/fnm/mise/homebrew,这里交回锚定,
        // 由官方 installer 重装同一处。
        let broken = ToolInstallation {
            path: "/Users/me/.local/bin/codex".to_string(),
            version: None,
            runnable: false,
            error: None,
            source: "system".to_string(),
            is_path_default: true,
            real: std::path::PathBuf::from(
                "/Users/me/.codex/packages/standalone/releases/0.157.0-aarch64-apple-darwin/bin/codex",
            ),
        };
        let cmd = installs_anchored_command("codex", &[broken]).unwrap();
        assert!(cmd.ends_with(CODEX_INSTALL_UNIX), "{cmd}");
        assert!(!cmd.contains("npm"), "{cmd}");
    }

    #[test]
    fn codex_broken_standalone_in_node_manager_dir_skips_npm_repair() {
        // CODEX_INSTALL_DIR 指到 Homebrew / nvm 的 bin 目录时,入口路径会被判成
        // homebrew / nvm 来源;npm 自愈门控只看入口来源的话会抢先返回 npm 重装,
        // 把独立安装版换成 npm 版。真身仍在 standalone 发布包里,必须交回 installer。
        for bin in [
            "/opt/homebrew/bin/codex",
            "/Users/me/.nvm/versions/node/v22.19.0/bin/codex",
        ] {
            let broken = ToolInstallation {
                path: bin.to_string(),
                version: None,
                runnable: false,
                error: None,
                source: infer_install_source(Path::new(bin)).to_string(),
                is_path_default: true,
                real: std::path::PathBuf::from(
                    "/Users/me/.codex/packages/standalone/releases/0.157.0-aarch64-apple-darwin/bin/codex",
                ),
            };
            let cmd = installs_anchored_command("codex", &[broken]).unwrap();
            assert!(cmd.ends_with(CODEX_INSTALL_UNIX), "{bin}: {cmd}");
            assert!(!cmd.contains("npm"), "{bin}: {cmd}");
        }
    }

    #[test]
    fn claude_homebrew_cask_uses_brew_not_self_update_or_npm() {
        // cask 归 brew 管:与 formula 一样不先跑 `claude update`,也不挂 npm fallback。
        let cmd = anchored_command_from_paths(
            "claude",
            "/opt/homebrew/bin/claude",
            "/opt/homebrew/Caskroom/claude-code/2.1.274/claude",
        )
        .unwrap();
        assert_eq!(cmd, "/opt/homebrew/bin/brew upgrade --cask claude-code");
        assert!(!cmd.contains("claude update"));
        assert!(!cmd.contains("npm"));
    }

    #[test]
    fn first_abs_path_line_skips_shell_noise() {
        // 交互式 .zshrc 先打印欢迎语（如 powerlevel10k / 自定义提示），
        // command -v 的真实路径在其后 → 跳过噪音取真路径。
        assert_eq!(
            first_abs_path_line("🚀 Welcome back!\n/Users/me/.local/bin/claude\n"),
            Some("/Users/me/.local/bin/claude")
        );
        // 无噪音时取第一行。
        assert_eq!(
            first_abs_path_line("/opt/homebrew/bin/gemini\n"),
            Some("/opt/homebrew/bin/gemini")
        );
        // 输出里没有任何绝对路径 → None。
        assert_eq!(first_abs_path_line("welcome\nbye\n"), None);
    }

    #[test]
    fn path_line_from_env_output_survives_shell_noise() {
        // `$SHELL -lic /usr/bin/env` 的 stdout 前面可能有交互式 rc 的欢迎语。
        let raw = "🚀 Welcome back, Jason!\nSHELL=/bin/zsh\nPATH=/opt/homebrew/bin:/usr/bin\nHOME=/Users/me\n";
        assert_eq!(
            path_line_from_env_output(raw),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        // 多行值的环境变量里恰好有一行以 `PATH=` 开头时，「值须以 / 开头」把它筛掉。
        let poisoned = "SOME_SCRIPT=line1\nPATH=not-a-path\nPATH=/usr/bin:/bin\n";
        assert_eq!(path_line_from_env_output(poisoned), Some("/usr/bin:/bin"));
        // 完全没有 PATH 行 → None，调用方保持不注入。
        assert_eq!(path_line_from_env_output("HOME=/Users/me\n"), None);
    }

    #[test]
    fn merge_path_segments_dedupes_preserving_login_order() {
        // 登录 shell 的段全部在前且保序；继承 PATH 里的新段追加在后。
        assert_eq!(
            merge_path_segments(
                "/Users/me/.nvm/versions/node/v22/bin:/usr/bin:/bin",
                "/usr/bin:/bin:/usr/sbin"
            ),
            "/Users/me/.nvm/versions/node/v22/bin:/usr/bin:/bin:/usr/sbin"
        );
        // 空段（`a::b` 在 POSIX 下意为当前目录）不该被注入。
        assert_eq!(merge_path_segments("/usr/bin::/bin", ""), "/usr/bin:/bin");
    }

    #[test]
    fn is_conflicting_thresholds() {
        let make = |version: Option<&str>, runnable: bool| ToolInstallation {
            path: "/x".to_string(),
            version: version.map(str::to_string),
            runnable,
            error: None,
            source: "nvm".to_string(),
            is_path_default: false,
            real: std::path::PathBuf::from("/x"),
        };
        // 单处 → 不冲突。
        assert!(!is_conflicting(&[make(Some("1.0.0"), true)]));
        // 两处同版本、都能跑 → 不冲突（同版本装两遍不打扰）。
        assert!(!is_conflicting(&[
            make(Some("1.0.0"), true),
            make(Some("1.0.0"), true)
        ]));
        // 版本分歧 → 冲突。
        assert!(is_conflicting(&[
            make(Some("1.0.0"), true),
            make(Some("2.0.0"), true)
        ]));
        // 同版本但运行态混合（一个能跑、一个跑不起来）→ 冲突。
        assert!(is_conflicting(&[
            make(Some("1.0.0"), true),
            make(Some("1.0.0"), false)
        ]));
    }
}

/// install 端的"上游推荐 || npm 兜底"短路链:把工具→官方安装方式这一上游事实
/// 固化为回归断言。任何方案改动若打破短路链结构或 URL,都会被这些用例拦下。
#[cfg(not(target_os = "windows"))]
mod install_strategy {
    use super::*;

    #[test]
    fn claude_install_prefers_native_with_npm_fallback() {
        // Anthropic 现在主推 native installer(claude.ai/install.sh),
        // 网络不通时短路到 npm 仍能装上;两段都得在,顺序也得对。
        let cmd = install_command_for("claude");
        assert!(
            cmd.contains("https://claude.ai/install.sh"),
            "should include official installer URL: {cmd}"
        );
        assert!(
            cmd.contains("@anthropic-ai/claude-code@latest"),
            "should keep npm package as fallback: {cmd}"
        );
        let parts: Vec<&str> = cmd.split("||").collect();
        assert_eq!(parts.len(), 2, "should be a two-step short-circuit chain");
        assert!(parts[0].contains("install.sh"), "native first: {cmd}");
        assert!(
            !parts[0].contains('|'),
            "native installer should avoid pipe: {cmd}"
        );
        assert!(parts[1].contains("npm i -g"), "npm second: {cmd}");
    }

    #[test]
    fn opencode_install_prefers_native_with_npm_fallback() {
        // SST 自家 install.sh 与 claude 同形态:bash 脚本、网络下载、装到 ~/.opencode/bin。
        let cmd = install_command_for("opencode");
        assert!(
            cmd.contains("https://opencode.ai/install"),
            "should include official installer URL: {cmd}"
        );
        assert!(
            cmd.contains("opencode-ai@latest"),
            "should keep npm package as fallback: {cmd}"
        );
        assert!(cmd.contains("||"), "should chain fallback: {cmd}");
        assert!(
            !cmd.split("||").next().unwrap_or_default().contains('|'),
            "native installer should avoid pipe: {cmd}"
        );
    }

    #[test]
    fn codex_install_keeps_static_npm() {
        // OpenAI 暂无独立 native installer,保持原裸 npm,不引入兜底链(无东西可兜底)。
        let cmd = install_command_for("codex");
        assert_eq!(cmd, "npm i -g @openai/codex@latest");
        assert!(!cmd.contains("||"));
    }

    #[test]
    fn gemini_install_keeps_static_npm() {
        // Google 文档同时支持 brew/npm,但本表保持与 update fallback 一致的 npm。
        // 用户若已装 brew gemini-cli,update 路径的锚定会识别 formula → brew upgrade,
        // 所以 install 端不强行替用户决策"用 brew 还是 npm"。
        let cmd = install_command_for("gemini");
        assert_eq!(cmd, "npm i -g @google/gemini-cli@latest");
    }

    #[test]
    fn grok_install_prefers_native_with_npm_fallback() {
        let cmd = install_command_for("grok");
        assert!(
            cmd.contains("https://x.ai/cli/install.sh"),
            "should include official installer URL: {cmd}"
        );
        assert!(
            cmd.contains("@xai-official/grok@latest"),
            "should keep npm package as fallback: {cmd}"
        );
        let parts: Vec<&str> = cmd.split("||").collect();
        assert_eq!(parts.len(), 2, "should be a two-step short-circuit chain");
        assert!(parts[0].contains("install.sh"), "native first: {cmd}");
        assert!(
            !parts[0].contains('|'),
            "native installer should avoid pipe: {cmd}"
        );
        assert!(parts[1].contains("npm i -g"), "npm second: {cmd}");
    }

    #[test]
    fn mcode_install_prefers_official_installer_with_npm_fallback() {
        let cmd = install_command_for("mcode");
        let (installer, fallback) = cmd
            .split_once(" || ")
            .expect("install should chain an npm fallback");
        assert!(
            installer.contains("https://filecdn.minimax.chat/public/install.sh"),
            "official installer first: {cmd}"
        );
        assert!(
            !installer.contains('|'),
            "native installer should avoid pipe: {cmd}"
        );
        assert_eq!(Some(fallback), npm_install_command_for("mcode"));
    }

    #[test]
    fn openclaw_install_keeps_static_npm() {
        let cmd = install_command_for("openclaw");
        assert_eq!(cmd, "npm i -g openclaw@latest");
    }

    #[test]
    fn pi_install_uses_the_verified_pinned_package() {
        let cmd = install_command_for("pi");
        assert_eq!(cmd, "npm i -g @earendil-works/pi-coding-agent@latest");
        assert!(!cmd.contains("||"));
    }

    #[test]
    fn update_fallbacks_use_official_cli_only_when_supported() {
        assert_eq!(
            static_fallback_command("claude"),
            "claude update || npm i -g @anthropic-ai/claude-code@latest --ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code"
        );
        assert_eq!(
            static_fallback_command("codex"),
            "npm i -g @openai/codex@latest"
        );
        assert!(!static_fallback_command("codex").contains("codex update"));
        assert_eq!(
            static_fallback_command("gemini"),
            "npm i -g @google/gemini-cli@latest"
        );
        assert!(!static_fallback_command("gemini").contains("gemini update"));
        assert_eq!(
            static_fallback_command("grok"),
            "npm i -g @xai-official/grok@latest"
        );
        assert!(!static_fallback_command("grok").contains("grok update"));
        assert_eq!(
            static_fallback_command("opencode"),
            "opencode upgrade || npm i -g opencode-ai@latest"
        );
        assert_eq!(
            static_fallback_command("openclaw"),
            "openclaw update --yes || npm i -g openclaw@latest"
        );
        assert_eq!(
            static_fallback_command("pi"),
            "npm i -g @earendil-works/pi-coding-agent@latest"
        );
        assert!(!static_fallback_command("pi").contains("pi update"));
        assert_eq!(
            Some(static_fallback_command("mcode").as_str()),
            npm_install_command_for("mcode")
        );
        assert!(!static_fallback_command("mcode").contains("mcode update"));
    }

    #[test]
    fn hermes_install_uses_official_installer() {
        // Hermes 官方 installer 会处理 Python 3.11+/uv 等运行时;不要再从 cc-switch
        // 里走 `python3 || python` pip 链。
        let cmd = install_command_for("hermes");
        assert!(
            cmd.starts_with("bash -c 'tmp=$(mktemp) && curl -fsSL ")
                && cmd.contains("install.sh -o $tmp && bash $tmp"),
            "should use official installer: {cmd}"
        );
        assert!(
            !cmd.contains('|') && !cmd.contains("python") && !cmd.contains("pip"),
            "should not depend on pipefail or system Python/pip: {cmd}"
        );
    }

    #[test]
    fn hermes_update_fallback_uses_cli_update_then_installer() {
        // 锚定失败时也不回退 pip:先让 PATH 上的 hermes 自更新,找不到/失败再跑官方
        // installer。这样 pyenv 的 `python` shim 不会参与错误路径。
        let cmd = static_fallback_command("hermes");
        assert!(
            cmd.starts_with("hermes update || bash -c 'tmp=$(mktemp) && curl -fsSL "),
            "should try CLI update before official installer: {cmd}"
        );
        let fallback = cmd
            .split_once("||")
            .map(|(_, fallback)| fallback)
            .expect("update should include installer fallback");
        assert!(
            !fallback.contains('|') && !cmd.contains("python") && !cmd.contains("pip"),
            "should not depend on pipefail or system Python/pip: {cmd}"
        );
    }
}

#[cfg(target_os = "windows")]
mod wsl_helpers {
    use super::*;

    #[test]
    fn test_is_valid_shell() {
        assert!(is_valid_shell("bash"));
        assert!(is_valid_shell("zsh"));
        assert!(is_valid_shell("sh"));
        assert!(is_valid_shell("fish"));
        assert!(is_valid_shell("dash"));
        assert!(is_valid_shell("/usr/bin/bash"));
        assert!(is_valid_shell("/bin/zsh"));
        assert!(!is_valid_shell("powershell"));
        assert!(!is_valid_shell("cmd"));
        assert!(!is_valid_shell(""));
    }

    #[test]
    fn test_is_valid_shell_flag() {
        assert!(is_valid_shell_flag("-c"));
        assert!(is_valid_shell_flag("-lc"));
        assert!(is_valid_shell_flag("-lic"));
        assert!(!is_valid_shell_flag("-x"));
        assert!(!is_valid_shell_flag(""));
        assert!(!is_valid_shell_flag("--login"));
    }

    #[test]
    fn test_default_flag_for_shell() {
        assert_eq!(default_flag_for_shell("sh"), "-c");
        assert_eq!(default_flag_for_shell("dash"), "-c");
        assert_eq!(default_flag_for_shell("/bin/dash"), "-c");
        assert_eq!(default_flag_for_shell("fish"), "-lc");
        assert_eq!(default_flag_for_shell("bash"), "-lic");
        assert_eq!(default_flag_for_shell("zsh"), "-lic");
        assert_eq!(default_flag_for_shell("/usr/bin/zsh"), "-lic");
    }

    #[test]
    fn test_is_valid_wsl_distro_name() {
        assert!(is_valid_wsl_distro_name("Ubuntu"));
        assert!(is_valid_wsl_distro_name("Ubuntu-22.04"));
        assert!(is_valid_wsl_distro_name("my_distro"));
        assert!(!is_valid_wsl_distro_name(""));
        assert!(!is_valid_wsl_distro_name("distro with spaces"));
        assert!(!is_valid_wsl_distro_name(&"a".repeat(65)));
    }
}

#[test]
fn opencode_extra_search_paths_includes_install_and_fallback_dirs() {
    let home = PathBuf::from("/home/tester");
    let install_dir = Some(std::ffi::OsString::from("/custom/opencode/bin"));
    let xdg_bin_dir = Some(std::ffi::OsString::from("/xdg/bin"));
    let gopath =
        std::env::join_paths([PathBuf::from("/go/path1"), PathBuf::from("/go/path2")]).ok();

    let paths = opencode_extra_search_paths(&home, install_dir, xdg_bin_dir, gopath);

    assert_eq!(paths[0], PathBuf::from("/custom/opencode/bin"));
    assert_eq!(paths[1], PathBuf::from("/xdg/bin"));
    assert!(paths.contains(&PathBuf::from("/home/tester/bin")));
    assert!(paths.contains(&PathBuf::from("/home/tester/.opencode/bin")));
    assert!(paths.contains(&PathBuf::from("/home/tester/.bun/bin")));
    assert!(paths.contains(&PathBuf::from("/home/tester/go/bin")));
    assert!(paths.contains(&PathBuf::from("/go/path1/bin")));
    assert!(paths.contains(&PathBuf::from("/go/path2/bin")));
}

#[test]
fn opencode_extra_search_paths_deduplicates_repeated_entries() {
    let home = PathBuf::from("/home/tester");
    let same_dir = Some(std::ffi::OsString::from("/same/path"));

    let paths = opencode_extra_search_paths(&home, same_dir.clone(), same_dir, None);

    let count = paths
        .iter()
        .filter(|path| path.as_path() == Path::new("/same/path"))
        .count();
    assert_eq!(count, 1);
}

#[test]
fn opencode_extra_search_paths_deduplicates_bun_default_dir() {
    let home = PathBuf::from("/home/tester");
    let paths = opencode_extra_search_paths(&home, None, None, None);

    let count = paths
        .iter()
        .filter(|path| path.as_path() == Path::new("/home/tester/.bun/bin"))
        .count();
    assert_eq!(count, 1);
}

#[test]
fn grok_extra_search_paths_prefers_override_then_default_native_dir() {
    let home = PathBuf::from("/home/tester");
    let paths = grok_extra_search_paths(&home, Some(std::ffi::OsString::from("/custom/grok/bin")));

    assert_eq!(paths[0], PathBuf::from("/custom/grok/bin"));
    assert_eq!(paths[1], PathBuf::from("/home/tester/.grok/bin"));
}

#[cfg(not(target_os = "windows"))]
#[test]
fn mcode_extra_search_paths_use_installer_bin_dir() {
    let home = PathBuf::from("/home/tester");
    let paths = mcode_extra_search_paths(&home, Some(std::ffi::OsString::from("/opt/mcode")));
    assert_eq!(
        paths,
        vec![
            PathBuf::from("/opt/mcode/bin"),
            PathBuf::from("/home/tester/.minimax-code/bin"),
        ]
    );
    // 空的 MCODE_INSTALL_DIR 视同未设置（installer 同样回退默认目录）。
    let paths = mcode_extra_search_paths(&home, Some(std::ffi::OsString::new()));
    assert_eq!(paths, vec![PathBuf::from("/home/tester/.minimax-code/bin")]);
}

#[cfg(target_os = "windows")]
#[test]
fn mcode_extra_search_paths_use_installer_root_on_windows() {
    // Windows installer 把 mcode.cmd / mcode.ps1 放在安装根目录，不在 bin 下。
    let home = PathBuf::from("C:\\Users\\tester");
    let paths = mcode_extra_search_paths(&home, None);
    assert_eq!(paths, vec![home.join(".minimax-code")]);
}

#[test]
fn grok_extra_search_paths_deduplicates_default_override() {
    let home = PathBuf::from("/home/tester");
    let paths = grok_extra_search_paths(
        &home,
        Some(std::ffi::OsString::from("/home/tester/.grok/bin")),
    );

    assert_eq!(paths, vec![PathBuf::from("/home/tester/.grok/bin")]);
}

#[test]
fn cli_path_env_search_paths_include_path_entries_and_dedupe() {
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    std::fs::create_dir_all(&first).expect("first dir should be created");
    std::fs::create_dir_all(&second).expect("second dir should be created");

    let path_env = std::env::join_paths([first.clone(), second.clone(), first.clone()])
        .expect("test path env should be joinable");
    let mut paths = vec![first.clone()];

    extend_from_cli_path_env(&mut paths, Some(path_env));

    assert!(paths.contains(&second));
    assert_eq!(paths.iter().filter(|path| *path == &first).count(), 1);
}

#[test]
fn child_search_paths_include_existing_children_with_suffix() {
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let base = temp.path().join("node");
    let bin = base.join("25.8.0").join("bin");
    std::fs::create_dir_all(&bin).expect("version bin should be created");

    let mut paths = Vec::new();
    extend_existing_child_search_paths(&mut paths, &base, Some("bin"));

    assert!(paths.contains(&bin));
}

#[test]
fn env_child_dir_appends_child_and_dedupes() {
    let base = std::ffi::OsString::from("/custom/toolchain");
    let mut paths = Vec::new();

    push_env_child_dir(&mut paths, Some(base.clone()), "bin");
    push_env_child_dir(&mut paths, Some(base), "bin");

    assert_eq!(paths, vec![PathBuf::from("/custom/toolchain").join("bin")]);
}

#[cfg(target_os = "windows")]
#[test]
fn cli_path_env_skips_windows_apps_alias_dir() {
    assert!(is_windows_app_execution_alias_dir(Path::new(
        r"C:\Users\tester\AppData\Local\Microsoft\WindowsApps"
    )));
    assert!(!is_windows_app_execution_alias_dir(Path::new(
        r"C:\Users\tester\AppData\Roaming\npm"
    )));
}

#[cfg(target_os = "windows")]
#[test]
fn merge_path_segments_win_preserves_order_and_dedupes_case_insensitively() {
    let merged = merge_path_segments_win(&[
        r"C:\a;C:\B;%SystemRoot%\system32",
        r"C:\b;C:\a", // dup of C:\a (case-insensitive) and C:\B
        "",
    ]);
    assert_eq!(merged, r"C:\a;C:\B;%SystemRoot%\system32");
}

#[cfg(unix)]
#[test]
fn prepend_search_dir_to_path_preserves_non_utf8_bytes() {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};

    let current = std::ffi::OsString::from_vec(b"/usr/bin:/tmp/\xff/bin".to_vec());
    let combined = prepend_search_dir_to_path(Path::new("/candidate/bin"), &current);

    assert_eq!(
        combined.as_os_str().as_bytes(),
        b"/candidate/bin:/usr/bin:/tmp/\xff/bin"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn expand_env_chars_preserves_unknown_vars_and_plain_text() {
    // No percent signs -> verbatim.
    assert_eq!(
        expand_env_chars(r"C:\Program Files\nodejs"),
        r"C:\Program Files\nodejs"
    );
    // Undefined variable is preserved verbatim (nothing dropped).
    assert_eq!(
        expand_env_chars(r"D:\npm-global\%DEFINITELY_NOT_A_REAL_VAR_xyz%\bin"),
        r"D:\npm-global\%DEFINITELY_NOT_A_REAL_VAR_xyz%\bin"
    );
    // Empty percent pair is not treated as a variable name.
    assert_eq!(expand_env_chars(r"C:\path\%%\tail"), r"C:\path\%%\tail");
}

#[cfg(target_os = "windows")]
#[test]
fn build_tool_search_paths_includes_standalone_installer_dirs() {
    // Non-npm installer locations must be scanned even when the process PATH
    // dropped them (regression guard for #6061 / #6278 / #6047).
    let local_data = dirs::data_local_dir().expect("LOCALAPPDATA should resolve");

    let codex_paths = build_tool_search_paths("codex");
    assert!(codex_paths.contains(
        &local_data
            .join("Programs")
            .join("OpenAI")
            .join("Codex")
            .join("bin")
    ));

    let claude_paths = build_tool_search_paths("claude");
    assert!(claude_paths.contains(&local_data.join("Programs").join("claude")));

    // The standalone Codex dir is codex-specific; it must not pollute other tools.
    assert!(!build_tool_search_paths("gemini").contains(
        &local_data
            .join("Programs")
            .join("OpenAI")
            .join("Codex")
            .join("bin")
    ));
}

#[cfg(target_os = "windows")]
#[test]
fn windows_path_lookup_ignores_same_named_file_in_current_directory() {
    let current_dir = tempfile::tempdir().expect("current directory should be created");
    let path_dir = tempfile::tempdir().expect("PATH directory should be created");
    std::fs::write(current_dir.path().join("codex.cmd"), "@echo current\r\n")
        .expect("current-directory shim should be created");
    let expected = path_dir.path().join("codex.cmd");
    std::fs::write(&expected, "@echo path\r\n").expect("PATH shim should be created");

    let effective_path = std::env::join_paths([path_dir.path()]).expect("test PATH should join");
    let output = windows_path_lookup_command("codex", &effective_path)
        .current_dir(current_dir.path())
        .output()
        .expect("where.exe should execute");
    let stderr = decode_command_output(&output.stderr);
    let matches = decode_command_output(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect::<Vec<_>>();

    assert!(output.status.success(), "where.exe failed: {stderr}");
    assert_eq!(matches.len(), 1);
    assert_eq!(
        std::fs::canonicalize(&matches[0]).expect("where.exe match should canonicalize"),
        std::fs::canonicalize(&expected).expect("expected PATH shim should canonicalize")
    );
}

#[test]
fn mise_node_search_paths_include_shims_and_installed_node_bins() {
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let home = temp.path();
    let node_bin = home
        .join(".local/share/mise/installs/node/25.8.0")
        .join("bin");
    std::fs::create_dir_all(&node_bin).expect("node bin should be created");

    let mut paths = Vec::new();
    extend_mise_node_search_paths(&mut paths, home);

    assert!(paths.contains(&home.join(".local/share/mise/shims")));
    assert!(paths.contains(&node_bin));
}

#[cfg(not(target_os = "windows"))]
#[test]
fn tool_executable_candidates_non_windows_uses_plain_binary_name() {
    let dir = PathBuf::from("/usr/local/bin");
    let candidates = tool_executable_candidates("opencode", &dir);

    assert_eq!(candidates, vec![PathBuf::from("/usr/local/bin/opencode")]);
}

#[cfg(target_os = "windows")]
#[test]
fn tool_executable_candidates_windows_includes_cmd_exe_and_plain_name() {
    let dir = PathBuf::from("C:\\tools");
    let candidates = tool_executable_candidates("opencode", &dir);

    assert_eq!(
        candidates,
        vec![
            PathBuf::from("C:\\tools\\opencode.cmd"),
            PathBuf::from("C:\\tools\\opencode.exe"),
            PathBuf::from("C:\\tools\\opencode"),
        ]
    );
}

#[cfg(target_os = "windows")]
#[test]
fn tool_executable_candidates_windows_skips_shadowed_npm_unix_shim() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let extensionless = dir.path().join("codex");
    let cmd = dir.path().join("codex.cmd");
    std::fs::write(&extensionless, "").expect("extensionless shim should be created");
    std::fs::write(&cmd, "").expect("cmd shim should be created");

    let candidates = tool_executable_candidates("codex", dir.path());

    assert_eq!(candidates, vec![cmd.clone(), dir.path().join("codex.exe")]);
    assert!(!candidates.contains(&extensionless));
}

#[cfg(target_os = "windows")]
#[test]
fn windows_runnable_sibling_prefers_cmd_over_extensionless_tool() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let extensionless = dir.path().join("codex");
    let cmd = dir.path().join("codex.cmd");
    std::fs::write(&extensionless, "").expect("extensionless shim should be created");
    std::fs::write(&cmd, "").expect("cmd shim should be created");

    let preferred = windows_runnable_sibling_for_extensionless_tool(&extensionless);

    assert_eq!(preferred.as_deref(), Some(cmd.as_path()));
}

#[cfg(target_os = "windows")]
#[test]
fn windows_shell_compatible_path_strips_verbatim_prefixes() {
    assert_eq!(
        windows_shell_compatible_path(Path::new(r"\\?\C:\tools\codex.cmd")),
        PathBuf::from(r"C:\tools\codex.cmd")
    );
    assert_eq!(
        windows_shell_compatible_path(Path::new(r"\\?\UNC\server\share\tools\codex.cmd")),
        PathBuf::from(r"\\server\share\tools\codex.cmd")
    );
    assert_eq!(
        windows_shell_compatible_path(Path::new(r"C:\tools\codex.cmd")),
        PathBuf::from(r"C:\tools\codex.cmd")
    );
}

#[cfg(target_os = "windows")]
#[test]
fn run_windows_tool_version_command_accepts_canonicalized_cmd_path() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let cmd = dir.path().join("codex.cmd");
    std::fs::write(&cmd, "@echo off\r\necho codex-cli 0.144.3\r\n")
        .expect("cmd shim should be created");
    let canonical = std::fs::canonicalize(&cmd).expect("cmd shim should canonicalize");
    assert!(
        canonical.to_string_lossy().starts_with(r"\\?\"),
        "Windows canonical paths should use the verbatim prefix: {}",
        canonical.display()
    );

    let current_path = std::env::var("PATH").unwrap_or_default();
    let output = run_windows_tool_version_command(&canonical, &current_path)
        .expect("canonicalized cmd shim should execute");
    let stderr = decode_command_output(&output.stderr);

    assert!(output.status.success(), "cmd shim failed: {stderr}");
    assert_eq!(
        decode_command_output(&output.stdout).trim(),
        "codex-cli 0.144.3"
    );
}

#[test]
fn resolve_launch_cwd_accepts_existing_directory() {
    let resolved = resolve_launch_cwd(Some(std::env::temp_dir().to_string_lossy().into_owned()))
        .expect("temp dir should resolve")
        .expect("temp dir should be present");

    assert!(resolved.is_dir());
}

#[test]
fn resolve_launch_cwd_rejects_missing_directory() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock should be after epoch")
        .as_nanos();
    let missing = std::env::temp_dir().join(format!("cc-switch-missing-{unique}"));

    let error = resolve_launch_cwd(Some(missing.to_string_lossy().into_owned()))
        .expect_err("missing directory should fail");

    assert!(error.contains("目录不存在"));
}

#[cfg(target_os = "macos")]
#[test]
fn iterm2_applescript_cold_start_avoids_current_window_before_one_exists() {
    let script = build_macos_iterm2_applescript(Path::new("/tmp/lolicode_launcher.sh"));

    let cold_start_branch = script
        .split("else\n        activate")
        .nth(1)
        .expect("cold start branch should be present")
        .split("    end if\n    tell current session")
        .next()
        .expect("cold start branch should end before writing command");

    assert!(cold_start_branch.contains("repeat while (count of windows) = 0"));
    assert!(cold_start_branch.contains("create window with default profile"));
    assert!(!cold_start_branch.contains("tell current window"));
    assert!(!cold_start_branch.contains("create tab with default profile"));
}

#[cfg(target_os = "macos")]
#[test]
fn iterm2_applescript_keeps_new_tab_behavior_for_existing_windows() {
    let script = build_macos_iterm2_applescript(Path::new("/tmp/lolicode_launcher.sh"));

    let running_branch = script
        .split("if was_running then")
        .nth(1)
        .expect("already-running branch should be present")
        .split("else\n        activate")
        .next()
        .expect("already-running branch should end before cold start branch");

    assert!(running_branch.contains("if (count of windows) = 0 then"));
    assert!(running_branch.contains("create window with default profile"));
    assert!(running_branch.contains("create tab with default profile"));
}

/// Terminal `activate` creates a default empty window on cold start; `launch` does not.
#[cfg(target_os = "macos")]
#[test]
fn terminal_applescript_cold_start_uses_launch_before_do_script() {
    let script = build_macos_terminal_applescript(Path::new("/tmp/lolicode_launcher.sh"));

    assert!(
        script.contains(r#"set was_running to application "Terminal" is running"#),
        "missing was_running detection:\n{script}"
    );
    // Cold launches avoid `activate` until after `do script`, so no default empty window is created first.
    assert!(
        script
            .contains("else\n        launch\n        do script launcher_script\n        activate"),
        "cold start should launch before activating:\n{script}"
    );
    // Already-running launches should create a fresh session.
    assert!(
        script
            .contains("if was_running then\n        activate\n        do script launcher_script\n"),
        "already-running branch should use bare do script:\n{script}"
    );
    assert!(
        script.contains(r#"set launcher_script to "exec sh '/tmp/lolicode_launcher.sh'""#),
        "Terminal should replace the auto-created shell:\n{script}"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn otty_launcher_command_executes_the_temporary_script() {
    assert_eq!(
        build_macos_dash_c_command(Path::new("/tmp/lolicode_launcher.sh")),
        "exec sh '/tmp/lolicode_launcher.sh'"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn otty_cli_candidates_include_bundle_and_installed_cli_locations() {
    let candidates = macos_otty_cli_candidates();

    assert!(candidates.contains(&PathBuf::from(
        "/Applications/Otty.app/Contents/MacOS/otty-cli"
    )));
    assert!(candidates.contains(&PathBuf::from("/usr/local/bin/otty")));
    assert!(candidates.contains(&PathBuf::from("/opt/homebrew/bin/otty")));
}

/// Restored windows should not receive the launcher command.
#[cfg(target_os = "macos")]
#[test]
fn terminal_applescript_does_not_hijack_restored_windows() {
    let script = build_macos_terminal_applescript(Path::new("/tmp/lolicode_launcher.sh"));
    assert!(
        !script.contains(" in window 1"),
        "should not inject into an existing/restored Terminal window:\n{script}"
    );
    assert!(
        !script.contains("count of windows"),
        "should not infer restored-window safety from window count:\n{script}"
    );
}

/// Ghostty cold starts use `initial-command`; warm starts use the scripting dictionary.
#[cfg(target_os = "macos")]
#[test]
fn ghostty_applescript_cold_start_uses_initial_command() {
    let script = build_macos_ghostty_applescript(Path::new("/tmp/lolicode_launcher.sh"));

    // Warm launches execute through the AppleScript command property, not `open -na ... -e`.
    assert!(
        script.contains(r#"set launcher_command to "sh '/tmp/lolicode_launcher.sh'""#),
        "missing launcher_command:\n{script}"
    );
    assert!(script.contains("if was_running then"));
    assert!(script.contains("new window with configuration {command:launcher_command}"));
    assert!(
        !script.contains(" --args -e"),
        "should not execute through open -na -e:\n{script}"
    );
    // Cold launches make Ghostty's first default surface execute the launcher.
    assert!(script.contains(r#"set was_running to application "Ghostty" is running"#));
    assert!(
        script.contains(
            r#"do shell script "open -na Ghostty --args --quit-after-last-window-closed=true " & quoted form of ("--initial-command=" & launcher_command)"#
        ),
        "cold start should use initial-command:\n{script}"
    );
    assert!(
        !script.contains("--initial-window=false"),
        "should not rely on initial-window=false:\n{script}"
    );
    assert!(
        !script.contains("delay 0.5"),
        "should not rely on a fixed delay:\n{script}"
    );
    assert!(
        !script.contains("old_ids"),
        "should not track default windows for closing:\n{script}"
    );
    assert!(
        !script.contains("close window"),
        "should not close a default window:\n{script}"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn dash_c_command_wraps_script_path_inside_quoted_arg() {
    // The script path must stay inside the `-c` string, not as a bare argv.
    let s = build_macos_dash_c_command(Path::new("/tmp/lolicode_launcher_1.sh"));
    assert_eq!(s, "exec sh '/tmp/lolicode_launcher_1.sh'");

    // Spaces and single quotes must stay shell-safe too.
    let s2 = build_macos_dash_c_command(Path::new("/Users/me/it's dir/x.sh"));
    assert_eq!(s2, r#"exec sh '/Users/me/it'"'"'s dir/x.sh'"#);
}

/// AppleScript launchers need both shell-path quoting and AppleScript string quoting.
#[cfg(target_os = "macos")]
#[test]
fn applescript_builders_safely_quote_special_paths() {
    // First shell-quote the path, then wrap the whole command as an AppleScript string.
    let expected = r#""sh '/Users/me/it'\"'\"'s dir/x.sh'""#;
    let p = Path::new("/Users/me/it's dir/x.sh");
    assert_eq!(applescript_launcher_command(p), expected);
    assert_eq!(
        applescript_exec_launcher_command(p),
        r#""exec sh '/Users/me/it'\"'\"'s dir/x.sh'""#
    );
    assert!(
        build_macos_terminal_applescript(p)
            .contains(r#""exec sh '/Users/me/it'\"'\"'s dir/x.sh'""#),
        "Terminal did not quote safely"
    );
    assert!(
        build_macos_iterm2_applescript(p).contains(r#""exec sh '/Users/me/it'\"'\"'s dir/x.sh'""#),
        "iTerm2 did not quote safely"
    );
    assert!(
        build_macos_ghostty_applescript(p).contains(expected),
        "Ghostty did not keep the non-exec launcher"
    );
}

#[test]
fn build_windows_cwd_command_str_uses_cd_for_drive_paths() {
    let (command, env) = build_windows_cwd_command_str(r"C:\work\repo");

    assert_eq!(command, "cd /d \"C:\\work\\repo\" || exit /b 1\r\n");
    assert_eq!(env, None);
}

#[test]
fn build_windows_cwd_command_str_uses_pushd_for_unc_paths() {
    let (command, _) = build_windows_cwd_command_str(r"\\wsl$\Ubuntu\home\coder\repo");

    assert_eq!(
        command,
        "pushd \"\\\\wsl$\\Ubuntu\\home\\coder\\repo\" || exit /b 1\r\n"
    );
}

#[test]
fn build_windows_cwd_command_str_escapes_batch_metacharacters() {
    let (command, _) = build_windows_cwd_command_str(r"\\server\share\100%&(test)");

    assert_eq!(
        command,
        "pushd \"\\\\server\\share\\100%%^&^(test^)\" || exit /b 1\r\n"
    );
}

#[test]
fn build_windows_cwd_command_str_passes_non_ascii_paths_via_env() {
    // cmd 按控制台代码页解码 .bat，中文路径不能写进文件（#8034）。
    let path = r"C:\Users\林增文\项目";
    let (command, env) = build_windows_cwd_command_str(path);

    assert!(command.is_ascii(), "batch line must stay ASCII: {command}");
    assert_eq!(
        command,
        "cd /d \"%LOLICODE_INTERNAL_CWD%\" || exit /b 1\r\nset \"LOLICODE_INTERNAL_CWD=\"\r\n"
    );
    assert_eq!(env.as_deref(), Some(path));

    let (unc_command, unc_env) = build_windows_cwd_command_str(r"\\server\共享\repo");
    assert!(unc_command.starts_with("pushd \"%LOLICODE_INTERNAL_CWD%\" || exit /b 1\r\n"));
    assert_eq!(unc_env.as_deref(), Some(r"\\server\共享\repo"));
}
