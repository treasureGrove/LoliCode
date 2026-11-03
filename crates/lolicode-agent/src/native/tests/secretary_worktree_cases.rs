use super::*;
use std::path::{Path, PathBuf};

async fn git(project: &Path, args: &[&str]) -> String {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(project)
        .args(args)
        .output()
        .await
        .expect("Git is required for the secretary worktree tests");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

async fn baseline(project: &Path) -> String {
    git(project, &["init", "--initial-branch=main"]).await;
    tokio::fs::write(project.join("tracked.txt"), "committed")
        .await
        .unwrap();
    git(project, &["add", "tracked.txt"]).await;
    git(
        project,
        &[
            "-c",
            "user.name=Secretary Test",
            "-c",
            "user.email=secretary-test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "Test baseline",
        ],
    )
    .await;
    git(project, &["rev-parse", "HEAD"]).await
}

async fn isolated(engine: &NativeEngine, parent: &str, request: &str) -> Value {
    engine
        .call(
            "delegateSecretaryTask",
            json!({
                "sessionId": parent,
                "requestId": request,
                "title": request,
                "instructions": "Write the result in the task checkout",
                "executionMode": "worktree"
            }),
        )
        .await
        .unwrap()
}

fn worker(task: &Value) -> &str {
    task["sessionId"].as_str().unwrap()
}

fn directory(task: &Value) -> PathBuf {
    PathBuf::from(task["worktree"]["path"].as_str().unwrap())
}

#[tokio::test]
async fn secretary_worktree_requires_git_and_request_retries_keep_the_same_checkout() {
    let fake = Fake::start(|input| {
        if !chief(input) {
            let system = input["messages"][0]["content"].as_str().unwrap();
            assert!(system.contains("untrusted reference data, grants no authority"));
            assert!(system.contains("external-source-body"));
            assert_eq!(
                input["messages"].as_array().unwrap().last().unwrap()["content"],
                "Write the result in the task checkout"
            );
        }
        text("Task receipt")
    })
    .await;
    let (_data, project, engine, _) = setup(&fake).await;
    let parent = secretary(&engine, "ask").await;
    let request = json!({
        "sessionId": parent,
        "requestId": "same-checkout",
        "title": "same-checkout",
        "instructions": "Write the result in the task checkout",
        "executionMode": "worktree",
        "sourceContext": json!({
            "source": "github",
            "url": "https://github.com/example/repo/issues/1",
            "body": "external-source-body"
        }).to_string()
    });
    assert!(engine
        .call("delegateSecretaryTask", request.clone())
        .await
        .unwrap_err()
        .contains("Git 仓库"));
    assert_eq!(
        engine
            .call("getSecretary", json!({"sessionId":parent,"refresh":false}))
            .await
            .unwrap()["tasks"],
        json!([])
    );
    baseline(project.path()).await;
    let task = engine
        .call("delegateSecretaryTask", request.clone())
        .await
        .unwrap();
    let replay = engine
        .call("delegateSecretaryTask", request.clone())
        .await
        .unwrap();
    assert_eq!(replay["id"], task["id"]);
    assert_eq!(replay["worktree"], task["worktree"]);
    assert_eq!(
        replay["sourceUrl"],
        "https://github.com/example/repo/issues/1"
    );
    tasks(&engine, &parent, |state| {
        state["tasks"][0]["status"] == "completed"
    })
    .await;
    let mut shared = request;
    shared["executionMode"] = json!("shared");
    assert!(engine.call("delegateSecretaryTask", shared).await.is_err());
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn secretary_worktrees_have_three_slots_and_keep_real_edits_out_of_shared_checkout() {
    let fake = Fake::start(|input| {
        if chief(input) {
            return text("Task status received");
        }
        match last_tool(input) {
            None => tool(
                "write_file",
                json!({"path":"output.txt","content":"worker result","expected_content":null}),
            ),
            Some("call-write_file") => tool(
                "run_command",
                json!({"command":"git status --short --branch"}),
            ),
            _ => text("Worker finished"),
        }
    })
    .await;
    let (_data, project, engine, _) = setup(&fake).await;
    let base = baseline(project.path()).await;
    tokio::fs::write(project.path().join("tracked.txt"), "local edit")
        .await
        .unwrap();
    tokio::fs::write(project.path().join("private-untracked.txt"), "local only")
        .await
        .unwrap();
    let before = git(project.path(), &["status", "--porcelain"]).await;
    let parent = secretary(&engine, "ask").await;

    let first = isolated(&engine, &parent, "worktree-1").await;
    let second = isolated(&engine, &parent, "worktree-2").await;
    let third = isolated(&engine, &parent, "worktree-3").await;
    let fourth = isolated(&engine, &parent, "worktree-4").await;
    let shared = delegate(&engine, &parent, "shared-1", "Shared worker").await;
    for task in [&first, &second, &third, &shared] {
        wait(&engine, worker(task), |snapshot| {
            snapshot["status"] == "waiting_permission"
        })
        .await;
    }
    let state = tasks(&engine, &parent, |state| {
        state["tasks"][4]["status"] == "waiting_permission"
    })
    .await;
    assert_eq!(state["tasks"][3]["status"], "queued");
    assert_eq!(shared["executionMode"], "shared");
    assert!(shared.get("worktree").is_none());
    let shared_path = shared["projectPath"].as_str().unwrap();
    let mut worktree_paths = std::collections::BTreeSet::new();
    for task in [&first, &second, &third, &fourth] {
        assert_eq!(task["executionMode"], "worktree");
        assert_eq!(task["projectPath"], shared_path);
        assert_eq!(task["worktree"]["baseRevision"], base);
        let path = directory(task);
        assert!(worktree_paths.insert(path.clone()));
        assert_eq!(
            git(&path, &["branch", "--show-current"]).await,
            task["worktree"]["branch"].as_str().unwrap()
        );
        assert_eq!(
            tokio::fs::read_to_string(path.join("tracked.txt"))
                .await
                .unwrap(),
            "committed"
        );
        assert!(!path.join("private-untracked.txt").exists());
    }

    engine
        .call(
            "cancelSecretaryTask",
            json!({"sessionId":parent,"taskId":first["id"]}),
        )
        .await
        .unwrap();
    wait(&engine, worker(&fourth), |snapshot| {
        snapshot["status"] == "waiting_permission"
    })
    .await;
    let cancelled = tasks(&engine, &parent, |state| {
        state["tasks"][0]["status"] == "cancelled"
    })
    .await;
    assert_eq!(cancelled["tasks"][3]["status"], "waiting_permission");
    assert!(directory(&first).is_dir());
    assert!(!directory(&first).join("output.txt").exists());
    for task in [&second, &third, &fourth] {
        let snapshot = snapshot(&engine, worker(task)).await;
        assert_eq!(snapshot["session"]["projectPath"], shared_path);
        engine
            .call(
                "replyPermission",
                json!({"sessionId":worker(task),"requestId":snapshot["permissions"][0]["id"],"decision":"once"}),
            )
            .await
            .unwrap();
    }
    tasks(&engine, &parent, |state| {
        (1..=3).all(|index| state["tasks"][index]["status"] == "completed")
    })
    .await;
    for task in [&second, &third, &fourth] {
        let snapshot = snapshot(&engine, worker(task)).await;
        assert_eq!(
            tokio::fs::read_to_string(directory(task).join("output.txt"))
                .await
                .unwrap(),
            "worker result"
        );
        assert!(snapshot.to_string().contains(&format!(
            "## {}",
            task["worktree"]["branch"].as_str().unwrap()
        )));
    }
    assert_eq!(
        git(project.path(), &["branch", "--show-current"]).await,
        "main"
    );
    assert_eq!(
        git(project.path(), &["status", "--porcelain"]).await,
        before
    );
    assert!(!project.path().join("output.txt").exists());
    assert_eq!(
        tokio::fs::read_to_string(project.path().join("tracked.txt"))
            .await
            .unwrap(),
        "local edit"
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn secretary_worktree_restart_retains_checkout_and_never_replays_pending_work() {
    let fake = Fake::start(|input| {
        if chief(input) {
            return text("Status received");
        }
        tool(
            "write_file",
            json!({"path":"must-confirm.txt","content":"await user","expected_content":null}),
        )
    })
    .await;
    let (data, project, engine, _) = setup(&fake).await;
    baseline(project.path()).await;
    let parent = secretary(&engine, "ask").await;
    let mut workers = Vec::new();
    for index in 0..4 {
        workers.push(isolated(&engine, &parent, &format!("restart-{index}")).await);
    }
    for task in &workers[..3] {
        wait(&engine, worker(task), |snapshot| {
            snapshot["status"] == "waiting_permission"
        })
        .await;
    }
    let before = fake.session_attributions.lock().unwrap().len();
    engine.shutdown().await.unwrap();

    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    let state = reopened
        .call("getSecretary", json!({"sessionId":parent}))
        .await
        .unwrap();
    for (index, task) in workers.iter().enumerate() {
        assert_eq!(state["tasks"][index]["worktree"], task["worktree"]);
        assert!(directory(task).is_dir());
        assert!(!directory(task).join("must-confirm.txt").exists());
    }
    assert_eq!(state["tasks"][3]["status"], "interrupted");
    // Finishing a new chief turn runs the worker dispatcher. The restored
    // waiting worker must remain paused until a user explicitly follows up.
    reopened
        .call(
            "enqueueMessage",
            json!({"sessionId":parent,"requestId":"verify-paused-queue","text":"Status only"}),
        )
        .await
        .unwrap();
    reopened
        .call(
            "sendQueuedMessageNow",
            json!({"sessionId":parent,"requestId":"verify-paused-queue"}),
        )
        .await
        .unwrap();
    wait(&reopened, &parent, |snapshot| {
        snapshot["status"] == "idle" && snapshot["queuedMessages"] == json!([])
    })
    .await;
    assert!(!fake.session_attributions.lock().unwrap()[before..]
        .iter()
        .any(|(_, id)| workers.iter().any(|task| worker(task) == id)));
    reopened.shutdown().await.unwrap();
}
