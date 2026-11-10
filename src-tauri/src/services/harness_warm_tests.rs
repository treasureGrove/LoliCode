use super::*;

fn record() -> SessionRecord {
    serde_json::from_value(json!({
        "snapshot": {
            "session": { "id": "lc:00000000-0000-4000-8000-000000000001", "title": "fixture",
                "projectPath": "fixture-project", "mode": "build", "permissionMode": "ask",
                "model": {"providerId":"fixture", "modelId":"model"}, "createdAt": 1, "updatedAt": 2 },
            "status": "running", "messages": [], "permissions": [], "questions": [],
            "diffs": [], "streamConnected": false, "streamGap": false
        },
        "rootCreated": true, "receipts": {}
    })).unwrap()
}

#[test]
fn presentation_changes_reuse_but_capability_changes_do_not() {
    let session = record().snapshot.session;
    let original = warm_session_configuration(&session).unwrap();
    let mut cosmetic = session.clone();
    cosmetic.title = "new title".into();
    cosmetic.updated_at += 1;
    cosmetic.pinned = true;
    assert_eq!(original, warm_session_configuration(&cosmetic).unwrap());
    for (field, value) in [
        ("mode", json!("plan")),
        ("permissionMode", json!("full_access")),
        ("reasoningEffort", json!("high")),
        ("contextLimit", json!(64000)),
        ("model", json!({"providerId":"fixture", "modelId":"other"})),
        ("archived", json!(true)),
        ("projectPath", json!("other-project")),
    ] {
        let mut changed = serde_json::to_value(&session).unwrap();
        changed[field] = value;
        let changed: AgentSession = serde_json::from_value(changed).unwrap();
        assert_ne!(
            original,
            warm_session_configuration(&changed).unwrap(),
            "{field}"
        );
    }
}

#[test]
fn any_context_route_or_tool_change_rebuilds_the_sdk() {
    let session = warm_session_configuration(&record().snapshot.session).unwrap();
    let workspace = json!({"policy":"build", "skills":[], "memory":"old memory"});
    let tools = json!({"tools":["fixture"], "mcpConfiguration":"first"});
    let key =
        warm_fingerprint(&session, "route", "sdk-version", &None, &workspace, &tools).unwrap();
    for (route, version, workspace, tools) in [
        ("new-route", "sdk-version", workspace.clone(), tools.clone()),
        ("route", "new-version", workspace.clone(), tools.clone()),
        (
            "route",
            "sdk-version",
            json!({"policy":"build","skills":[],"memory":"new memory"}),
            tools.clone(),
        ),
        (
            "route",
            "sdk-version",
            json!({"policy":"build","skills":["new-skill"],"memory":"old memory"}),
            tools.clone(),
        ),
        (
            "route",
            "sdk-version",
            workspace.clone(),
            json!({"tools":["new-tool"],"mcpConfiguration":"first"}),
        ),
        (
            "route",
            "sdk-version",
            workspace.clone(),
            json!({"tools":["fixture"],"mcpConfiguration":"changed"}),
        ),
    ] {
        assert_ne!(
            key,
            warm_fingerprint(&session, route, version, &None, &workspace, &tools).unwrap()
        );
    }
    let plugins = Some(serde_json::from_value(json!({"enabled":["terminal"]})).unwrap());
    assert_ne!(
        key,
        warm_fingerprint(
            &session,
            "route",
            "sdk-version",
            &plugins,
            &workspace,
            &tools
        )
        .unwrap()
    );
}

#[test]
fn only_quiescent_ordinary_desktop_records_are_cached() {
    assert!(can_keep_warm(&record()));
    let mut queued = record();
    queued.queue.push(QueuedInput {
        sdk_id: None,
        args: json!({"requestId":"queued"}),
    });
    assert!(!can_keep_warm(&queued));
    let mut withdrawn = record();
    withdrawn.withdrawn.push(json!({"requestId":"withdrawn"}));
    assert!(!can_keep_warm(&withdrawn));
    let mut worker = record();
    worker
        .worker_queues
        .insert("child".into(), WorkerQueue::default());
    assert!(!can_keep_warm(&worker));
    for kind in ["background", "title", "compaction"] {
        let mut active = record();
        match kind {
            "background" => active.snapshot.background_jobs = 1,
            "title" => active.snapshot.title_pending = true,
            _ => active.snapshot.compacting = true,
        }
        assert!(!can_keep_warm(&active), "{kind}");
    }
    let mut secretary = serde_json::to_value(record()).unwrap();
    secretary["snapshot"]["session"]["coordination"] = json!({"role":"secretary"});
    assert!(!can_keep_warm(&serde_json::from_value(secretary).unwrap()));
}
