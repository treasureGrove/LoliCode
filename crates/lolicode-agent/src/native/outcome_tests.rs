use super::*;
async fn fixture() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    NativeEngine,
    Entry,
    String,
    watch::Receiver<bool>,
) {
    let data = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let engine = NativeEngine::open(data.path().into()).await.unwrap();
    engine.bind(project.path().into(),json!({"revision":1,"models":[{"id":"fixture","providerId":"lolicode","modelId":"opaque","name":"Fixture","channelName":"Fixture"}],"defaultModel":"fixture"}),NativeGateway{base_url:"http://127.0.0.1:1/v1".into(),bearer_token:"owned-outcome-lease".into()}).await.unwrap();
    let session = engine.call("createSession", json!({})).await.unwrap();
    let id = session["id"].as_str().unwrap().to_owned();
    let entry = engine.entry(&id).await.unwrap();
    let (tx, rx) = watch::channel(false);
    {
        let mut state = entry.lock().await;
        state.flight = Some(Flight {
            request_id: "fixture-request".into(),
            cancel: tx,
        });
        state.stored.snapshot.status = AgentStatus::Running;
        state.stored.snapshot.messages.push(AgentMessage {
            id: "fixture-assistant".into(),
            role: "assistant".into(),
            created_at: now(),
            completed_at: None,
            parts: vec![AgentPart::Tool {
                id: "fixture-call".into(),
                name: "write_file".into(),
                state: "running".into(),
                input: json!({}),
                output: None,
                error: None,
            }],
        });
        state.stored.history.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":"fixture-call","type":"function","function":{"name":"write_file","arguments":"{}"}}]}));
    }
    (data, project, engine, entry, id, rx)
}
#[tokio::test]
async fn cancellation_after_a_real_write_preserves_its_result_and_diff() {
    let (_data, project, engine, entry, id, rx) = fixture().await;
    let output = tools::execute(
        project.path(),
        "write_file",
        &json!({"path":"completed.txt","content":"real completed write","expected_content":null}),
        rx.clone(),
    )
    .await
    .unwrap();
    entry
        .lock()
        .await
        .flight
        .as_ref()
        .unwrap()
        .cancel
        .send(true)
        .unwrap();
    let result = engine
        .record_tool_outcome(
            &entry,
            "fixture-assistant",
            "fixture-call",
            Ok(output),
            *rx.borrow(),
            "owned-outcome-lease",
        )
        .await;
    assert_eq!(
        result.as_ref().err().map(String::as_str),
        Some(inference::CANCELLED)
    );
    engine.finish(entry, "fixture-request", result).await;
    let value = engine
        .call("getSession", json!({"sessionId":id}))
        .await
        .unwrap();
    assert_eq!(value["status"], "idle");
    assert_eq!(value["messages"][0]["parts"][0]["state"], "completed");
    assert_eq!(value["diffs"].as_array().unwrap().len(), 1);
    assert_eq!(
        tokio::fs::read_to_string(project.path().join("completed.txt"))
            .await
            .unwrap(),
        "real completed write"
    );
    engine.shutdown().await.unwrap();
}
#[tokio::test]
async fn unconfirmed_cleanup_is_an_error_and_fences_new_work_and_updates() {
    let (_data, _project, engine, entry, id, _rx) = fixture().await;
    let result = engine
        .record_tool_outcome(
            &entry,
            "fixture-assistant",
            "fixture-call",
            Err(format!(
                "{}fixture cleanup could not confirm exit",
                tools::CLEANUP_UNCERTAIN_PREFIX
            )),
            true,
            "owned-outcome-lease",
        )
        .await;
    assert!(result.as_ref().unwrap_err().contains("could not confirm"));
    engine.finish(entry, "fixture-request", result).await;
    let value = engine
        .call("getSession", json!({"sessionId":id}))
        .await
        .unwrap();
    assert_eq!(value["status"], "error");
    assert!(engine.busy().await.is_err());
    assert!(engine.call("beginUpdate", json!({})).await.is_err());
    assert!(engine.call("createSession", json!({})).await.is_err());
    assert_eq!(
        engine.call("activity", json!({})).await.unwrap()["unknown"],
        true
    );
    assert!(engine.shutdown().await.is_err());
}
