use super::*;
use std::time::Duration;

async fn run(project: &Path, name: &str, args: Value) -> Result<ToolOutput, String> {
    let (_sender, receiver) = watch::channel(false);
    execute(project, name, &args, receiver).await
}

#[test]
fn cleanup_uncertainty_is_explicit_and_never_confused_with_normal_cancellation() {
    assert!(cleanup_uncertain(&cleanup_failure(
        "无法确认命令进程组的退出状态"
    )));
    assert!(!cleanup_uncertain(CANCELLED));
    assert!(!cleanup_uncertain("命令超时，所属进程已回收"));
    assert!(!cleanup_uncertain("文件内容已变化"));
    assert!(!cleanup_uncertain("ordinary output [cleanup_uncertain]"));
}

#[test]
fn schema_and_inspection_expose_real_tools_and_plan_mutation_boundaries() {
    let names: Vec<_> = schemas()
        .iter()
        .map(|schema| schema["function"]["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        names,
        [
            "read_file",
            "view_image",
            "list_files",
            "search_files",
            "glob",
            "grep",
            "write_file",
            "apply_patch",
            "run_command"
        ]
    );
    let project = tempfile::tempdir().unwrap();
    fs::write(project.path().join("file.txt"), "old").unwrap();
    assert!(
        !inspect(project.path(), "read_file", &json!({"path":"file.txt"}))
            .unwrap()
            .mutating
    );
    assert!(
        inspect(
            project.path(),
            "write_file",
            &json!({"path":"file.txt","content":"new","expected_content":"old"})
        )
        .unwrap()
        .mutating
    );
    let write = inspect(
        project.path(),
        "apply_patch",
        &json!({"path":"file.txt","old_text":"old","new_text":"new"}),
    )
    .unwrap();
    assert!(write.mutating);
    assert!(!write.requires_approval);
    fs::create_dir(project.path().join(".GIT")).unwrap();
    let special = inspect(
        project.path(),
        "write_file",
        &json!({"path":".GIT/config","content":"x","expected_content":null}),
    )
    .unwrap();
    assert!(special.dangerous && special.requires_approval);
    for command in [
        "node --version",
        "git status --short",
        "git diff --stat --no-ext-diff --no-textconv",
    ] {
        let read = inspect(project.path(), "run_command", &json!({"command":command})).unwrap();
        assert!(
            !read.mutating && !read.requires_approval && !read.dangerous,
            "{command}"
        );
    }
    for command in [
        "git diff",
        "node --version > changed.txt",
        "git status && echo unsafe",
        "node -e code",
        "npm test",
        "git reset --hard",
        "git status %COMSPEC%",
    ] {
        let unknown = inspect(project.path(), "run_command", &json!({"command":command})).unwrap();
        assert!(
            unknown.mutating && unknown.requires_approval && unknown.dangerous,
            "{command}"
        );
    }
}

#[tokio::test]
async fn glob_finds_nested_files_filters_build_outputs_and_scopes_search_paths() {
    let project = tempfile::tempdir().unwrap();
    for directory in [
        "src/nested",
        "tests",
        ".git",
        "node_modules/pkg",
        "target/debug",
        "dist",
        "build",
    ] {
        fs::create_dir_all(project.path().join(directory)).unwrap();
    }
    for file in [
        "main.rs",
        "src/lib.rs",
        "src/nested/extra.rs",
        "src/nested/readme.md",
        "tests/check.rs",
        ".git/hidden.rs",
        "node_modules/pkg/hidden.rs",
        "target/debug/hidden.rs",
        "dist/hidden.rs",
        "build/hidden.rs",
    ] {
        fs::write(project.path().join(file), "fixture\n").unwrap();
    }
    let all = run(project.path(), "glob", json!({"pattern":"**/*.rs"}))
        .await
        .unwrap();
    assert_eq!(
        all.text.lines().collect::<Vec<_>>(),
        [
            "main.rs",
            "src/lib.rs",
            "src/nested/extra.rs",
            "tests/check.rs"
        ]
    );
    assert!(all.diffs.is_empty() && all.file_changes.is_empty());
    let subtree = run(
        project.path(),
        "glob",
        json!({"path":"src","pattern":"**/*.rs"}),
    )
    .await
    .unwrap();
    assert_eq!(
        subtree.text.lines().collect::<Vec<_>>(),
        ["src/lib.rs", "src/nested/extra.rs"]
    );
    let direct = run(
        project.path(),
        "glob",
        json!({"path":"src","pattern":"*.rs"}),
    )
    .await
    .unwrap();
    assert_eq!(direct.text, "src/lib.rs\n");
    let no_match = run(project.path(), "glob", json!({"pattern":"**/*.missing"}))
        .await
        .unwrap();
    assert!(no_match.text.contains("未找到匹配文件"));
    let capped = run(
        project.path(),
        "glob",
        json!({"pattern":"**/*.rs","max_results":2}),
    )
    .await
    .unwrap();
    assert!(capped.text.starts_with("main.rs\nsrc/lib.rs\n"));
    assert!(capped.text.contains("搜索已截断"));
    assert!(!capped.text.contains("extra.rs"));
}

#[tokio::test]
async fn grep_runs_real_regex_filters_and_case_options_without_changing_literal_search() {
    let project = tempfile::tempdir().unwrap();
    fs::create_dir_all(project.path().join("src/nested")).unwrap();
    fs::create_dir_all(project.path().join("node_modules/pkg")).unwrap();
    fs::write(
        project.path().join("src/main.rs"),
        "const Alpha = 1;\nconst Beta = 2;\nAlpha.*literal\n",
    )
    .unwrap();
    fs::write(project.path().join("src/nested/other.rs"), "ALPHA\nalpha\n").unwrap();
    fs::write(project.path().join("src/note.md"), "Alpha\n").unwrap();
    fs::write(
        project.path().join("node_modules/pkg/ignored.rs"),
        "Alpha\n",
    )
    .unwrap();
    fs::write(project.path().join("src/binary.rs"), b"Alpha\0binary").unwrap();
    let regex = run(
        project.path(),
        "grep",
        json!({"pattern":"^const (Alpha|Beta) = [0-9];$","include":"*.rs"}),
    )
    .await
    .unwrap();
    assert_eq!(
        regex.text,
        "src/main.rs:1: const Alpha = 1;\nsrc/main.rs:2: const Beta = 2;\n"
    );
    let insensitive = run(
        project.path(),
        "grep",
        json!({"path":"src","pattern":"^alpha$","include":"**/*.rs","case_sensitive":false}),
    )
    .await
    .unwrap();
    assert_eq!(
        insensitive.text,
        "src/nested/other.rs:1: ALPHA\nsrc/nested/other.rs:2: alpha\n"
    );
    let sensitive = run(
        project.path(),
        "grep",
        json!({"pattern":"^alpha$","include":"*.rs"}),
    )
    .await
    .unwrap();
    assert_eq!(sensitive.text, "src/nested/other.rs:2: alpha\n");
    let single = run(
        project.path(),
        "grep",
        json!({"path":"src/main.rs","pattern":"Beta"}),
    )
    .await
    .unwrap();
    assert_eq!(single.text, "src/main.rs:2: const Beta = 2;\n");
    let literal = run(
        project.path(),
        "search_files",
        json!({"pattern":"Alpha.*literal"}),
    )
    .await
    .unwrap();
    assert_eq!(literal.text, "src/main.rs:3: Alpha.*literal\n");
    assert!(regex.diffs.is_empty() && regex.file_changes.is_empty());
    let no_match = run(
        project.path(),
        "grep",
        json!({"pattern":"not-in-the-files"}),
    )
    .await
    .unwrap();
    assert!(no_match.text.contains("未找到匹配内容"));
    let capped = run(
        project.path(),
        "grep",
        json!({"pattern":"Alpha|Beta","include":"*.rs","max_results":1}),
    )
    .await
    .unwrap();
    assert!(capped.text.starts_with("src/main.rs:1:"));
    assert!(capped.text.contains("搜索已截断"));
    assert!(!capped.text.contains("src/main.rs:2:"));
}

#[tokio::test]
async fn grep_explicit_files_named_like_ignored_directories_remain_searchable() {
    let project = tempfile::tempdir().unwrap();
    for name in ["build", "target", "vendor"] {
        fs::write(project.path().join(name), format!("needle in {name}\n")).unwrap();
    }
    fs::create_dir_all(project.path().join("deps/vendor")).unwrap();
    fs::write(
        project.path().join("deps/vendor/ignored.txt"),
        "needle in dependency\n",
    )
    .unwrap();
    let all = run(project.path(), "grep", json!({"pattern":"needle"}))
        .await
        .unwrap();
    assert_eq!(
        all.text,
        "build:1: needle in build\ntarget:1: needle in target\nvendor:1: needle in vendor\n"
    );
    for name in ["build", "target", "vendor"] {
        let direct = run(
            project.path(),
            "grep",
            json!({"pattern":"needle","path":name}),
        )
        .await
        .unwrap();
        assert_eq!(direct.text, format!("{name}:1: needle in {name}\n"));
    }
    let ignored = run(
        project.path(),
        "grep",
        json!({"pattern":"needle","path":"deps/vendor/ignored.txt"}),
    )
    .await
    .unwrap();
    assert!(ignored.text.contains("未找到匹配内容"));
    assert!(!ignored.text.contains("needle in dependency"));
}

#[tokio::test]
async fn new_search_tools_reject_invalid_patterns_paths_and_cancel_without_writes() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(project.path().join("safe.txt"), "keep unchanged\n").unwrap();
    for (name, input) in [
        ("glob", json!({"pattern":"["})),
        ("glob", json!({"pattern":"../**"})),
        ("glob", json!({"pattern":"/absolute/**"})),
        ("glob", json!({"pattern":"C:/outside/**"})),
        ("glob", json!({"pattern":"**","path":outside.path()})),
        ("glob", json!({"pattern":"**","path":"safe.txt"})),
        ("glob", json!({"pattern":"**","max_results":501})),
        ("grep", json!({"pattern":"("})),
        ("grep", json!({"pattern":"a","include":"../*"})),
        ("grep", json!({"pattern":"a","case_sensitive":"false"})),
        ("grep", json!({"pattern":"a","max_results":0})),
        ("grep", json!({"pattern":"a","path":outside.path()})),
        ("grep", json!({"pattern":"a","ignored":true})),
    ] {
        assert!(
            inspect(project.path(), name, &input).is_err(),
            "{name}: {input}"
        );
    }
    for name in ["glob", "grep"] {
        let input = json!({"pattern":"keep"});
        let policy = inspect(project.path(), name, &input).unwrap();
        assert!(!policy.mutating && !policy.requires_approval && !policy.dangerous);
        assert_eq!(policy.action, "read");
        let (cancel, stopped) = watch::channel(false);
        cancel.send(true).unwrap();
        assert_eq!(
            execute(project.path(), name, &input, stopped)
                .await
                .err()
                .as_deref(),
            Some(CANCELLED)
        );
    }
    assert_eq!(
        fs::read_to_string(project.path().join("safe.txt")).unwrap(),
        "keep unchanged\n"
    );
}

#[tokio::test]
async fn grep_bounds_unicode_matching_lines_and_skips_large_or_binary_files() {
    let project = tempfile::tempdir().unwrap();
    fs::write(
        project.path().join("long.txt"),
        format!("needle{}\n", "界".repeat(5000)),
    )
    .unwrap();
    fs::write(
        project.path().join("large.txt"),
        "needle".repeat(MAX_FILE / 6 + 1),
    )
    .unwrap();
    fs::write(project.path().join("binary.txt"), b"needle\0data").unwrap();
    let result = run(project.path(), "grep", json!({"pattern":"needle"}))
        .await
        .unwrap();
    assert!(result.text.starts_with("long.txt:1: needle"));
    assert!(result.text.contains("匹配行已截断"));
    assert!(result.text.len() < 8000);
    assert!(!result.text.contains("large.txt") && !result.text.contains("binary.txt"));
}

#[test]
fn malformed_tools_and_outside_paths_are_rejected_before_execution() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), "owned outside fixture").unwrap();
    for (name, args) in [
        ("not_a_tool", json!({})),
        (
            "read_file",
            json!({"path":outside.path().join("secret.txt")}),
        ),
        (
            "write_file",
            json!({"path":"../outside","content":"bad","expected_content":null}),
        ),
        ("read_file", json!({"path":"missing","ignored":true})),
        (
            "run_command",
            json!({"command":"echo ok","workdir":outside.path()}),
        ),
        ("list_files", json!({"recursive":"true"})),
        ("write_file", json!({"path":"new","content":"new"})),
        (
            "run_command",
            json!({"command":"echo ok","timeout_seconds":121}),
        ),
        ("run_command", json!({"command":"x".repeat(8193)})),
    ] {
        assert!(
            inspect(project.path(), name, &args).is_err(),
            "{name}: {args}"
        );
    }
}

#[tokio::test]
async fn actual_file_tools_read_search_patch_and_publish_real_atomic_diffs() {
    let project = tempfile::tempdir().unwrap();
    let created = run(
        project.path(),
        "write_file",
        json!({"path":"probe.txt","content":"one\ntwo\nthree\n","expected_content":null}),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(project.path().join("probe.txt")).unwrap(),
        "one\ntwo\nthree\n"
    );
    assert_eq!(created.diffs[0].status, "added");
    assert_eq!(created.diffs[0].additions, 3);
    assert_eq!(created.file_changes.len(), 1);
    assert_eq!(created.file_changes[0].path, "probe.txt");
    assert!(created.file_changes[0].before.is_none());
    assert_eq!(
        created.file_changes[0].after.as_deref(),
        Some("one\ntwo\nthree\n")
    );
    let read = run(
        project.path(),
        "read_file",
        json!({"path":"probe.txt","offset":2,"limit":1}),
    )
    .await
    .unwrap();
    assert!(read.text.contains("2: two"));
    assert!(!read.text.contains("one"));
    assert!(read.file_changes.is_empty());
    let found = run(project.path(), "search_files", json!({"pattern":"two"}))
        .await
        .unwrap();
    assert!(found.text.contains("probe.txt:2: two"));
    assert!(found.file_changes.is_empty());
    let patched = run(
        project.path(),
        "apply_patch",
        json!({"path":"probe.txt","old_text":"two","new_text":"updated"}),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(project.path().join("probe.txt")).unwrap(),
        "one\nupdated\nthree\n"
    );
    let diff = &patched.diffs[0];
    assert_eq!(diff.additions, 1);
    assert_eq!(diff.deletions, 1);
    assert!(diff.patch.contains("-two\n+updated\n"));
    assert_eq!(
        patched.file_changes[0].before.as_deref(),
        Some("one\ntwo\nthree\n")
    );
    assert_eq!(
        patched.file_changes[0].after.as_deref(),
        Some("one\nupdated\nthree\n")
    );
    let stale = run(
        project.path(),
        "write_file",
        json!({"path":"probe.txt","content":"lost edit","expected_content":"one\ntwo\nthree\n"}),
    )
    .await;
    assert!(stale.is_err());
    assert!(fs::read_to_string(project.path().join("probe.txt"))
        .unwrap()
        .contains("updated"));
    assert_eq!(
        fs::read_dir(project.path()).unwrap().count(),
        1,
        "Atomic temporary files must be cleaned"
    );
}

#[tokio::test]
async fn actual_file_snapshots_preserve_new_file_identity_and_restored_baselines() {
    let project = tempfile::tempdir().unwrap();
    let first = run(
        project.path(),
        "write_file",
        json!({"path":"new.txt","content":"first\n","expected_content":null}),
    )
    .await
    .unwrap();
    let latest = run(
        project.path(),
        "apply_patch",
        json!({"path":"new.txt","old_text":"first","new_text":"latest"}),
    )
    .await
    .unwrap();
    let net = cumulative_diff(
        "new.txt",
        first.file_changes[0].before.as_deref(),
        latest.file_changes[0].after.as_deref(),
    );
    assert_eq!(net[0].status, "added");
    assert_eq!(net[0].additions, 1);
    assert_eq!(net[0].deletions, 0);
    assert!(net[0].patch.contains("+latest"));
    assert!(!net[0].patch.contains("first"));

    fs::write(project.path().join("existing.txt"), "original\n").unwrap();
    let changed = run(
        project.path(),
        "apply_patch",
        json!({"path":"existing.txt","old_text":"original","new_text":"changed"}),
    )
    .await
    .unwrap();
    let restored = run(
        project.path(),
        "write_file",
        json!({"path":"existing.txt","content":"original\n","expected_content":"changed\n"}),
    )
    .await
    .unwrap();
    assert!(cumulative_diff(
        "existing.txt",
        changed.file_changes[0].before.as_deref(),
        restored.file_changes[0].after.as_deref()
    )
    .is_empty());
    assert_eq!(
        fs::read_to_string(project.path().join("existing.txt")).unwrap(),
        "original\n"
    );
    let unchanged = run(
        project.path(),
        "write_file",
        json!({"path":"existing.txt","content":"original\n","expected_content":"original\n"}),
    )
    .await
    .unwrap();
    assert!(unchanged.diffs.is_empty() && unchanged.file_changes.is_empty());

    assert!(cumulative_diff("new.txt", None, None).is_empty());
    assert_eq!(
        cumulative_diff("empty.txt", None, Some(""))[0].status,
        "added"
    );
    assert_eq!(
        cumulative_diff("empty.txt", Some(""), None)[0].status,
        "deleted"
    );
    let deleted = cumulative_diff("existing.txt", Some("original\n"), None);
    assert_eq!(deleted[0].deletions, 1);
    assert!(deleted[0].patch.contains("+++ /dev/null"));
}

#[tokio::test]
async fn ambiguous_patches_binary_files_and_cancelled_mutations_do_not_write() {
    let project = tempfile::tempdir().unwrap();
    fs::write(project.path().join("repeat.txt"), "same same").unwrap();
    assert!(run(
        project.path(),
        "apply_patch",
        json!({"path":"repeat.txt","old_text":"same","new_text":"new"})
    )
    .await
    .is_err());
    fs::write(project.path().join("binary"), [0, 1, 2]).unwrap();
    assert!(run(project.path(), "read_file", json!({"path":"binary"}))
        .await
        .is_err());
    let (_sender, receiver) = watch::channel(true);
    assert!(execute(
        project.path(),
        "write_file",
        &json!({"path":"cancelled","content":"no","expected_content":null}),
        receiver
    )
    .await
    .is_err());
    assert!(!project.path().join("cancelled").exists());
}

#[tokio::test]
async fn symlink_or_junction_escape_is_rejected_for_read_write_and_listing() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), "owned outside fixture").unwrap();
    let link = project.path().join("link");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), &link).unwrap();
    #[cfg(windows)]
    {
        let command = std::env::var_os("SYSTEMROOT")
            .map(PathBuf::from)
            .unwrap()
            .join("System32")
            .join("cmd.exe");
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new(command)
            .raw_arg(format!(
                "/D /C mklink /J \"{}\" \"{}\"",
                command::shell_directory(&link).display(),
                command::shell_directory(outside.path()).display()
            ))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Owned junction fixture must be real: {} / {} / {}",
            link.display(),
            outside.path().display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    for (name, args) in [
        ("read_file", json!({"path":"link/secret.txt"})),
        (
            "write_file",
            json!({"path":"link/new.txt","content":"no","expected_content":null}),
        ),
        ("list_files", json!({"path":"link"})),
    ] {
        assert!(run(project.path(), name, args).await.is_err());
    }
    assert!(!outside.path().join("new.txt").exists());
    #[cfg(windows)]
    fs::remove_dir(link).unwrap();
}

#[tokio::test]
async fn native_shell_cancellation_reaps_descendants_before_they_can_write() {
    let project = tempfile::tempdir().unwrap();
    let root = project.path().to_path_buf();
    let (sender, receiver) = watch::channel(false);
    #[cfg(windows)]let command="powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"Set-Content -LiteralPath 'child-started' -Value 'ok'; Start-Sleep -Seconds 2; Set-Content -LiteralPath 'late.txt' -Value 'leaked'\"";
    #[cfg(not(windows))]
    let command = "(printf ok > child-started; sleep 2; printf leaked > late.txt) & wait";
    let operation = tokio::spawn(async move {
        execute(
            &root,
            "run_command",
            &json!({"command":command,"timeout_seconds":20}),
            receiver,
        )
        .await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !project.path().join("child-started").exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if !project.path().join("child-started").exists() {
        let outcome = tokio::time::timeout(Duration::from_secs(1), operation).await;
        panic!(
            "The real nested child must have started: {}",
            match outcome {
                Ok(Ok(Ok(output))) => output.text,
                Ok(Ok(Err(error))) => error,
                _ => "still running".into(),
            }
        );
    }
    sender.send(true).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), operation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.err().unwrap(), CANCELLED);
    tokio::time::sleep(Duration::from_millis(2300)).await;
    assert!(
        !project.path().join("late.txt").exists(),
        "Cancelling only the parent shell would leak this write"
    );
}

#[tokio::test]
async fn actual_shell_timeout_and_output_limit_are_enforced() {
    let project = tempfile::tempdir().unwrap();
    #[cfg(windows)]
    let wait = "ping -n 20 127.0.0.1 >nul";
    #[cfg(not(windows))]
    let wait = "sleep 20";
    let result = run(
        project.path(),
        "run_command",
        json!({"command":wait,"timeout_seconds":1}),
    )
    .await;
    assert!(match result {
        Err(error) => error.contains("超时"),
        Ok(output) => panic!("Expected timeout: {}", output.text),
    });
    #[cfg(windows)]
    let noisy = "for /L %i in (1,1,10000) do @echo 0123456789012345678901234567890123456789";
    #[cfg(not(windows))]let noisy="i=0; while [ $i -lt 10000 ]; do printf 0123456789012345678901234567890123456789; i=$((i+1)); done";
    let output = run(
        project.path(),
        "run_command",
        json!({"command":noisy,"timeout_seconds":20}),
    )
    .await
    .unwrap();
    assert!(output.text.len() < MAX_OUTPUT + 200);
    assert!(output.text.contains("输出已截断"));
    assert!(output.file_changes.is_empty());
    // Lossy decoding can expand each non-UTF8 byte to three UTF8 bytes.
    // The returned model text remains bounded after that expansion as well.
    assert!(bounded("\u{fffd}".repeat(MAX_OUTPUT)).len() < MAX_OUTPUT + 100);
}
