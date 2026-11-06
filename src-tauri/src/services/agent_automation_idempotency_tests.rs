use super::*;

fn registered_workspaces() -> (
    tempfile::TempDir,
    Arc<crate::database::Database>,
    String,
    String,
) {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(crate::database::Database::memory().unwrap());
    let mut prefs = preferences::Preferences::default();
    let mut paths = Vec::new();
    for name in ["first", "second"] {
        let path = root.path().join(name);
        std::fs::create_dir(&path).unwrap();
        let path = crate::services::agent_host::canonical_project(&path.to_string_lossy())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        prefs.projects.insert(
            preferences::path_key(&path),
            AgentProject {
                standalone: false,
                path: path.clone(),
                name: name.into(),
                pinned: false,
                last_opened_at: now_ms(),
            },
        );
        paths.push(path);
    }
    preferences::save(&db, &prefs).unwrap();
    (root, db, paths.remove(0), paths.remove(0))
}

fn input(workspace: &str, request: &str) -> Value {
    json!({"workspacePath":workspace,"clientRequestId":request,"title":"Saved proposal",
        "prompt":"Inspect the project","trigger":"schedule","cronExpr":"0 9 * * 1,3,5",
        "recurring":false,"mode":"guarded","locale":"zh",
        "modelSelection":{"providerId":"owned","modelId":"fixture","options":{"reasoningLevel":"high","temperature":0.2}}})
}

#[tokio::test]
async fn automation_one_time_plan_consumes_once_and_retains_original_run_prompt() {
    let (_root, db, workspace, _) = registered_workspaces();
    let run_at = now_ms() + 60_000;
    let mut payload = input(&workspace, "one-time-create");
    payload["target"] = json!({"kind":"new_once"});
    payload["runAt"] = json!(run_at);
    payload["recurring"] = json!(true);
    assert!(create_saved_job(&db, &payload).await.is_err());
    payload["recurring"] = json!(false);
    payload["runAt"] = json!(now_ms() - 1);
    assert!(create_saved_job(&db, &payload).await.is_err());
    payload["runAt"] = json!(run_at);
    let created = create_saved_job(&db, &payload).await.unwrap();
    assert_eq!(created["nextRunAt"], run_at);
    let id = created["automationId"].as_str().unwrap();
    let (claimed, run) = claim_run(&db, id, &workspace).await.unwrap().unwrap();
    assert_eq!(claimed.run_at, Some(run_at));
    assert_eq!(run.prompt.as_deref(), Some("Inspect the project"));
    update_run(&db, &run.run_id, |run| {
        run.outcome = Some("succeeded".into())
    })
    .await
    .unwrap();
    assert!(claim_run(&db, id, &workspace).await.is_err());
    let ended = load(&db).unwrap().jobs.pop().unwrap();
    assert_eq!(ended.lifecycle_status, "completed");
    assert!(ended.next_run_at.is_none());

    let mut edit = input(&workspace, "one-time-edit");
    edit["expectedUpdatedAt"] = created["updatedAt"].clone();
    edit["prompt"] = json!("New instruction");
    assert!(update_saved_job(&db, id, &edit, workspace.clone())
        .await
        .is_err());
    edit["expectedUpdatedAt"] = json!(ended.updated_at);
    let updated = update_saved_job(&db, id, &edit, workspace.clone())
        .await
        .unwrap();
    assert_eq!(updated["lifecycleStatus"], "completed");
    assert_eq!(updated["target"], json!({"kind":"new_once"}));
    assert_eq!(updated["runAt"], run_at);
    assert_eq!(
        load(&db).unwrap().runs[0].prompt.as_deref(),
        Some("Inspect the project")
    );

    edit["clientRequestId"] = json!("one-time-reschedule");
    edit["expectedUpdatedAt"] = updated["updatedAt"].clone();
    edit["runAt"] = json!(run_at + 60_000);
    let rescheduled = update_saved_job(&db, id, &edit, workspace).await.unwrap();
    assert_eq!(rescheduled["lifecycleStatus"], "active");
    let mut store = load(&db).unwrap();
    let projects = preferences::load(&db).unwrap();
    assert!(
        claim_due(&mut store, &projects, run_at + 59_999, Ok(0), false)
            .0
            .is_empty()
    );
    assert_eq!(
        claim_due(&mut store, &projects, run_at + 60_000, Ok(0), false)
            .0
            .len(),
        1
    );
    assert!(
        claim_due(&mut store, &projects, run_at + 60_001, Ok(0), false)
            .0
            .is_empty()
    );
    assert_eq!(
        store.runs.last().unwrap().prompt.as_deref(),
        Some("New instruction")
    );
}

struct DeliveryFixture {
    snapshot: std::sync::Mutex<AgentSnapshot>,
    calls: std::sync::Mutex<Vec<(String, Value)>>,
}

impl DeliveryFixture {
    fn new(workspace: &str) -> Self {
        let session_id = format!("lc:{}", uuid::Uuid::new_v4());
        Self {
            snapshot: std::sync::Mutex::new(serde_json::from_value(json!({
                "session": {"id":session_id,"projectPath":workspace,"title":"Fixture","mode":"build",
                    "permissionMode":"auto","model":{"providerId":"owned","modelId":"fixture"},
                    "createdAt":1,"updatedAt":1},
                "status":"idle","messages":[],"permissions":[],"questions":[],"diffs":[],
                "streamConnected":false,"streamGap":false,
            })).unwrap()),
            calls: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl AutomationRuntime for DeliveryFixture {
    fn bind_project<'a>(&'a self, _path: &'a str) -> BoxFuture<'a, Result<AgentCatalog, String>> {
        Box::pin(async {
            Ok(serde_json::from_value(json!({
                "revision":1,"models":[{"id":"owned/fixture","providerId":"owned","modelId":"fixture",
                "name":"Fixture","channelName":"Owned"}],"defaultModel":"owned/fixture","excludedSources":[],
            })).unwrap())
        })
    }

    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        _mutate: bool,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push((method.into(), params));
            let snapshot = self.snapshot.lock().unwrap();
            Ok(match method {
                "createSession" => json!(snapshot.session),
                "getSession" => json!(*snapshot),
                "sendMessage" | "interruptSession" => Value::Null,
                "queryCommand" => json!({"results":[]}),
                _ => panic!("Unexpected automation call: {method}"),
            })
        })
    }
}

#[tokio::test]
async fn automation_new_once_reuses_the_persisted_native_session() {
    let (_root, db, workspace, _) = registered_workspaces();
    let runtime = Arc::new(DeliveryFixture::new(&workspace));
    let mut payload = input(&workspace, "create-reusable");
    payload["target"] = json!({"kind":"new_once"});
    let created = create_saved_job(&db, &payload).await.unwrap();
    let id = created["automationId"].as_str().unwrap();
    let mut delivered = Vec::new();
    for _ in 0..2 {
        let (job, run) = claim_run(&db, id, &workspace).await.unwrap().unwrap();
        delivered.push(
            dispatch_run(runtime.clone(), db.clone(), job, run.clone())
                .await
                .unwrap(),
        );
        update_run(&db, &run.run_id, |record| {
            record.outcome = Some("succeeded".into())
        })
        .await
        .unwrap();
    }
    assert_eq!(delivered[0], delivered[1]);
    assert_eq!(
        load(&db).unwrap().jobs[0].reusable_session_id.as_deref(),
        Some(delivered[0].as_str())
    );
    let calls = runtime.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(method, _)| method == "createSession")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(method, params)| method == "sendMessage"
                && params["sessionId"] == delivered[0]
                && params["automationIdleOnly"] == true
                && params["backgroundOnly"] == false)
            .count(),
        2
    );
}

#[tokio::test]
async fn automation_existing_target_is_scoped_and_never_interrupts_unrelated_work() {
    let (_root, db, workspace, other) = registered_workspaces();
    let runtime = Arc::new(DeliveryFixture::new(&workspace));
    let mut session = runtime.snapshot.lock().unwrap().session.clone();
    let session_id = session.id.clone();
    assert!(ensure_target_session(&session, &session_id, &other).is_err());
    session.archived = true;
    assert!(ensure_target_session(&session, &session_id, &workspace).is_err());
    let mut payload = input(&workspace, "create-linked");
    payload["target"] = json!({"kind":"session","sessionId":session_id});
    payload.as_object_mut().unwrap().remove("modelSelection");
    let created = create_saved_job(&db, &payload).await.unwrap();
    let id = created["automationId"].as_str().unwrap();

    runtime.snapshot.lock().unwrap().status = AgentStatus::Running;
    let (job, run) = claim_run(&db, id, &workspace).await.unwrap().unwrap();
    assert!(dispatch_run(runtime.clone(), db.clone(), job, run)
        .await
        .is_none());
    assert_eq!(
        load(&db).unwrap().runs[0].dispatch_status,
        "failed_to_dispatch"
    );
    assert!(runtime
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|(method, _)| method == "getSession"));

    runtime.snapshot.lock().unwrap().status = AgentStatus::Idle;
    let (job, run) = claim_run(&db, id, &workspace).await.unwrap().unwrap();
    assert_eq!(
        dispatch_run(runtime.clone(), db.clone(), job, run.clone()).await,
        Some(session_id.clone())
    );
    runtime.snapshot.lock().unwrap().status = AgentStatus::Running;
    cancel_run_runtime(runtime.clone(), db.clone(), &run.run_id, &workspace)
        .await
        .unwrap();
    recover_runs_runtime(runtime.clone(), db.clone()).await;
    let recovered = load(&db).unwrap().runs.pop().unwrap();
    assert!(!active(&recovered));
    assert_eq!(recovered.dispatch_status, "failed_to_dispatch");
    let calls = runtime.calls.lock().unwrap();
    let sends: Vec<_> = calls
        .iter()
        .filter(|(method, _)| method == "sendMessage")
        .collect();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].1["backgroundOnly"], true);
    assert_eq!(sends[0].1["automationIdleOnly"], true);
    let interrupts: Vec<_> = calls
        .iter()
        .filter(|(method, _)| method == "interruptSession")
        .collect();
    assert_eq!(interrupts.len(), 1);
    assert_eq!(
        interrupts[0].1["expectedRequestId"],
        format!("automation:{}", run.run_id)
    );
}

#[tokio::test]
async fn automation_save_retries_share_one_durable_job_even_when_concurrent() {
    let (_root, db, workspace, _) = registered_workspaces();
    let payload = input(&workspace, "proposal:stable-create");
    let (first, retry) = tokio::join!(
        create_saved_job(&db, &payload),
        create_saved_job(&db, &payload)
    );
    let first = first.unwrap();
    assert_eq!(retry.unwrap()["automationId"], first["automationId"]);
    assert_eq!(create_saved_job(&db, &payload).await.unwrap(), first);
    let persisted = load(&db).unwrap();
    assert_eq!(persisted.jobs.len(), 1);
    assert_eq!(persisted.save_receipts.len(), 1);
}

#[tokio::test]
async fn automation_save_identity_rejects_changed_payload_but_not_json_key_order() {
    let (_root, db, workspace, _) = registered_workspaces();
    let payload = input(&workspace, "proposal:stable-payload");
    let first = create_saved_job(&db, &payload).await.unwrap();
    let mut reordered = payload.clone();
    reordered["modelSelection"]["options"] =
        serde_json::from_str(r#"{"temperature":0.2,"reasoningLevel":"high"}"#).unwrap();
    assert_eq!(
        create_saved_job(&db, &reordered).await.unwrap()["automationId"],
        first["automationId"]
    );
    for (key, changed) in [
        ("title", json!("Changed title")),
        ("prompt", json!("Changed task")),
        ("cronExpr", json!("0 10 * * 1,3,5")),
        ("mode", json!("yolo")),
        ("recurring", json!(true)),
        (
            "modelSelection",
            json!({"providerId":"other","modelId":"fixture"}),
        ),
    ] {
        let mut changed_payload = payload.clone();
        changed_payload[key] = changed;
        assert!(
            create_saved_job(&db, &changed_payload)
                .await
                .unwrap_err()
                .contains("此保存请求"),
            "{key}"
        );
    }
    assert_eq!(load(&db).unwrap().jobs.len(), 1);
}

#[tokio::test]
async fn automation_save_keys_are_isolated_by_project_and_never_cross_update_scope() {
    let (_root, db, first_project, second_project) = registered_workspaces();
    let first = create_saved_job(&db, &input(&first_project, "same-key"))
        .await
        .unwrap();
    let second = create_saved_job(&db, &input(&second_project, "same-key"))
        .await
        .unwrap();
    assert_ne!(first["automationId"], second["automationId"]);
    assert!(update_saved_job(
        &db,
        second["automationId"].as_str().unwrap(),
        &input(&first_project, "scoped-update"),
        first_project.clone()
    )
    .await
    .unwrap_err()
    .contains("不属于"));
    assert_eq!(load(&db).unwrap().jobs.len(), 2);
}

#[tokio::test]
async fn automation_deleted_save_identity_cannot_recreate_the_job() {
    let (_root, db, workspace, _) = registered_workspaces();
    let payload = input(&workspace, "deleted-create");
    create_saved_job(&db, &payload).await.unwrap();
    let mut store = load(&db).unwrap();
    store.jobs.clear();
    save(&db, &store).unwrap();
    assert!(create_saved_job(&db, &payload)
        .await
        .unwrap_err()
        .contains("已删除"));
    assert!(load(&db).unwrap().jobs.is_empty());
    assert_eq!(load(&db).unwrap().save_receipts.len(), 1);
}

#[tokio::test]
async fn automation_update_retry_does_not_revert_a_later_edit_or_resurrect_deleted_job() {
    let (_root, db, workspace, _) = registered_workspaces();
    let created = create_saved_job(&db, &input(&workspace, "create-original"))
        .await
        .unwrap();
    let id = created["automationId"].as_str().unwrap();
    let mut first = input(&workspace, "update-first");
    first["title"] = json!("First edit");
    update_saved_job(&db, id, &first, workspace.clone())
        .await
        .unwrap();
    let mut second = input(&workspace, "update-second");
    second["title"] = json!("Later edit");
    update_saved_job(&db, id, &second, workspace.clone())
        .await
        .unwrap();
    let replayed = update_saved_job(&db, id, &first, workspace.clone())
        .await
        .unwrap();
    assert_eq!(replayed["title"], "Later edit");
    assert_eq!(replayed["recurring"], false);
    let mut store = load(&db).unwrap();
    store.jobs.clear();
    save(&db, &store).unwrap();
    assert!(update_saved_job(&db, id, &first, workspace.clone())
        .await
        .unwrap_err()
        .contains("已删除"));
    assert!(load(&db).unwrap().jobs.is_empty());
}

#[tokio::test]
async fn automation_save_identity_cannot_change_operation_or_update_target() {
    let (_root, db, workspace, _) = registered_workspaces();
    let payload = input(&workspace, "create-key");
    let first = create_saved_job(&db, &payload).await.unwrap();
    let id = first["automationId"].as_str().unwrap();
    assert!(update_saved_job(&db, id, &payload, workspace.clone())
        .await
        .unwrap_err()
        .contains("此保存请求"));
    let second = create_saved_job(&db, &input(&workspace, "create-other"))
        .await
        .unwrap();
    let update = input(&workspace, "one-update-target");
    update_saved_job(&db, id, &update, workspace.clone())
        .await
        .unwrap();
    assert!(update_saved_job(
        &db,
        second["automationId"].as_str().unwrap(),
        &update,
        workspace.clone()
    )
    .await
    .unwrap_err()
    .contains("此保存请求"));
}

#[tokio::test]
async fn automation_save_identity_validates_keys_and_keeps_legacy_create_compatible() {
    let (_root, db, workspace, _) = registered_workspaces();
    for key in [
        json!(""),
        json!(" "),
        json!(7),
        json!(true),
        json!([]),
        json!("x".repeat(257)),
        json!("nul\0key"),
    ] {
        let mut payload = input(&workspace, "valid-key");
        payload["clientRequestId"] = key;
        assert!(create_saved_job(&db, &payload).await.is_err());
    }
    assert!(load(&db).unwrap().jobs.is_empty());
    let mut legacy = input(&workspace, "unused");
    legacy.as_object_mut().unwrap().remove("clientRequestId");
    let first = create_saved_job(&db, &legacy).await.unwrap();
    let second = create_saved_job(&db, &legacy).await.unwrap();
    assert_ne!(first["automationId"], second["automationId"]);
    assert!(load(&db).unwrap().save_receipts.is_empty());
}

struct ProposalConfirmationRuntime {
    session_id: String,
    project_path: String,
    calls: tokio::sync::Mutex<Vec<(String, Value)>>,
    delay_lookup: bool,
    lookup_started: tokio::sync::Notify,
    release_lookup: tokio::sync::Notify,
    record_ack: Option<Value>,
}
impl ProposalConfirmationRuntime {
    fn new(session_id: &str, project_path: &str, delay_lookup: bool) -> Self {
        Self {
            session_id: session_id.into(),
            project_path: project_path.into(),
            calls: tokio::sync::Mutex::new(Vec::new()),
            delay_lookup,
            lookup_started: tokio::sync::Notify::new(),
            release_lookup: tokio::sync::Notify::new(),
            record_ack: None,
        }
    }
}
impl AutomationRuntime for ProposalConfirmationRuntime {
    fn bind_project<'a>(&'a self, _path: &'a str) -> BoxFuture<'a, Result<AgentCatalog, String>> {
        Box::pin(async { panic!("Confirming a saved card must not rebind its project") })
    }

    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        mutate: bool,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.calls
                .lock()
                .await
                .push((method.into(), params.clone()));
            match method {
                "getSession" => {
                    assert!(!mutate);
                    if self.delay_lookup {
                        self.lookup_started.notify_one();
                        self.release_lookup.notified().await;
                    }
                    Ok(json!({
                        "session":{"id":self.session_id,"projectPath":self.project_path,
                            "title":"Automation design","mode":"build","createdAt":1,"updatedAt":1},
                        "status":"idle","messages":[],"permissions":[],"questions":[],"diffs":[],
                        "streamConnected":false,"streamGap":false,
                    }))
                }
                "recordAutomationSave" => {
                    assert!(mutate);
                    Ok(self.record_ack.clone().unwrap_or_else(|| json!({
                        "status":"saved","automationId":params["automationId"],"toolCallId":params["toolCallId"],
                    })))
                }
                _ => panic!("Unexpected confirmation method {method}"),
            }
        })
    }
}

#[tokio::test]
async fn automation_confirm_proposal_requires_its_exact_durable_receipt_and_project() {
    let (_root, db, workspace, other_workspace) = registered_workspaces();
    let session = "lc:proposal-design";
    let tool = "proposal-tool-1";
    let saved = create_saved_job(
        &db,
        &input(&workspace, &format!("proposal:{session}:{tool}")),
    )
    .await
    .unwrap();
    let id = saved["automationId"].as_str().unwrap();
    let runtime = Arc::new(ProposalConfirmationRuntime::new(session, &workspace, false));
    let before = db.get_setting(STORE_KEY).unwrap();
    assert!(confirm_proposal_runtime(
        runtime.clone(),
        db.clone(),
        id,
        session,
        "another-tool",
        &workspace
    )
    .await
    .unwrap_err()
    .contains("保存回执"));
    assert!(confirm_proposal_runtime(
        runtime.clone(),
        db.clone(),
        id,
        session,
        tool,
        &other_workspace
    )
    .await
    .unwrap_err()
    .contains("不属于"));
    assert!(runtime.calls.lock().await.is_empty());
    let result =
        confirm_proposal_runtime(runtime.clone(), db.clone(), id, session, tool, &workspace)
            .await
            .unwrap();
    assert_eq!(
        result,
        json!({"status":"saved","automationId":id,"toolCallId":tool})
    );
    assert_eq!(
        runtime.calls.lock().await.as_slice(),
        &[
            ("getSession".into(), json!({"sessionId":session})),
            (
                "recordAutomationSave".into(),
                json!({"sessionId":session,"toolCallId":tool,"automationId":id})
            ),
        ]
    );
    assert_eq!(
        db.get_setting(STORE_KEY).unwrap(),
        before,
        "Confirmation must not edit or dispatch an automation"
    );
}

#[tokio::test]
async fn automation_confirm_proposal_rejects_unsaved_cards_and_a_foreign_native_session() {
    let (_root, db, workspace, other_workspace) = registered_workspaces();
    let session = "lc:proposal-design";
    let tool = "proposal-tool-1";
    let unrelated = create_saved_job(&db, &input(&workspace, "not-a-proposal-receipt"))
        .await
        .unwrap();
    let runtime = Arc::new(ProposalConfirmationRuntime::new(session, &workspace, false));
    assert!(confirm_proposal_runtime(
        runtime.clone(),
        db.clone(),
        unrelated["automationId"].as_str().unwrap(),
        session,
        tool,
        &workspace
    )
    .await
    .unwrap_err()
    .contains("保存回执"));
    assert!(runtime.calls.lock().await.is_empty());
    let saved = create_saved_job(
        &db,
        &input(&workspace, &format!("proposal:{session}:{tool}")),
    )
    .await
    .unwrap();
    let id = saved["automationId"].as_str().unwrap();
    let foreign = Arc::new(ProposalConfirmationRuntime::new(
        session,
        &other_workspace,
        false,
    ));
    assert!(
        confirm_proposal_runtime(foreign.clone(), db.clone(), id, session, tool, &workspace)
            .await
            .unwrap_err()
            .contains("设计会话不属于")
    );
    assert_eq!(
        foreign.calls.lock().await.len(),
        1,
        "No native record may be written for a foreign session"
    );
    let wrong_id = Arc::new(ProposalConfirmationRuntime::new(
        "lc:another-design",
        &workspace,
        false,
    ));
    assert!(
        confirm_proposal_runtime(wrong_id.clone(), db.clone(), id, session, tool, &workspace)
            .await
            .is_err()
    );
    assert_eq!(wrong_id.calls.lock().await.len(), 1);
}

#[tokio::test]
async fn automation_confirm_proposal_does_not_hold_management_lock_during_native_lookup() {
    let (_root, db, workspace, _) = registered_workspaces();
    let session = "lc:proposal-design";
    let tool = "proposal-tool-1";
    let saved = create_saved_job(
        &db,
        &input(&workspace, &format!("proposal:{session}:{tool}")),
    )
    .await
    .unwrap();
    let id = saved["automationId"].as_str().unwrap().to_string();
    let runtime = Arc::new(ProposalConfirmationRuntime::new(session, &workspace, true));
    let confirmation = tokio::spawn({
        let runtime = runtime.clone();
        let db = db.clone();
        let workspace = workspace.clone();
        async move { confirm_proposal_runtime(runtime, db, &id, session, tool, &workspace).await }
    });
    tokio::time::timeout(Duration::from_secs(2), runtime.lookup_started.notified())
        .await
        .unwrap();
    let listed =
        tokio::time::timeout(Duration::from_millis(500), list_saved_jobs(&db, &workspace)).await;
    assert!(
        listed.is_ok(),
        "Native confirmation must not block the automation page"
    );
    {
        let _guard = mutation_lock().lock().await;
        let mut store = load(&db).unwrap();
        store.jobs.clear();
        save(&db, &store).unwrap();
    }
    runtime.release_lookup.notify_one();
    assert!(confirmation.await.unwrap().unwrap_err().contains("已删除"));
    assert_eq!(
        runtime.calls.lock().await.len(),
        1,
        "Deletion during lookup must not record a stale saved card"
    );
}

#[tokio::test]
async fn automation_confirm_proposal_validates_the_native_ack_identity_and_status() {
    let (_root, db, workspace, _) = registered_workspaces();
    let session = "lc:proposal-design";
    let tool = "proposal-tool-1";
    let saved = create_saved_job(
        &db,
        &input(&workspace, &format!("proposal:{session}:{tool}")),
    )
    .await
    .unwrap();
    let id = saved["automationId"].as_str().unwrap();
    for ack in [
        json!({"status":"confirmed","automationId":id,"toolCallId":tool}),
        json!({"status":"saved","automationId":"another-job","toolCallId":tool}),
        json!({"status":"saved","automationId":id,"toolCallId":"another-tool"}),
        json!({"status":"saved","automationId":id}),
    ] {
        let mut runtime = ProposalConfirmationRuntime::new(session, &workspace, false);
        runtime.record_ack = Some(ack);
        assert!(confirm_proposal_runtime(
            Arc::new(runtime),
            db.clone(),
            id,
            session,
            tool,
            &workspace
        )
        .await
        .unwrap_err()
        .contains("确认回执"));
    }
}
