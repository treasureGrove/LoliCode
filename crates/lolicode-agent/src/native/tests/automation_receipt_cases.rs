use super::*;

fn current_user(input: &Value) -> &str {
    input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .unwrap()["content"]
        .as_str()
        .unwrap()
}
fn current_tool(input: &Value) -> Option<&Value> {
    input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .take_while(|message| message["role"] != "user")
        .find(|message| message["role"] == "tool")
}
fn proposal_parts(snapshot: &Value) -> Vec<&Value> {
    snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["parts"].as_array().unwrap())
        .filter(|part| part["type"] == "tool" && part["name"] == "propose_automation")
        .collect()
}
fn draft(edit: bool) -> Value {
    let mut input = json!({"title":"每日检查","prompt":"检查当前项目测试。","trigger":"schedule","cronExpr":if edit {"0 10 * * *"} else {"0 9 * * *"}});
    if edit {
        input["automationId"] = json!("desktop-saved-id");
    }
    input
}
async fn confirm(
    engine: &NativeEngine,
    id: &str,
    tool_id: &str,
    job_id: &str,
) -> Result<Value, String> {
    engine
        .call(
            "recordAutomationSave",
            json!({"sessionId":id,"toolCallId":tool_id,"automationId":job_id}),
        )
        .await
}

#[tokio::test]
async fn desktop_save_during_stream_survives_completion_restart_and_followup_with_reused_provider_id(
) {
    let fake = Fake::start(|input| {
        assert!(!input["tools"].as_array().unwrap().iter().any(|schema| schema["function"]["name"] == "recordAutomationSave"));
        let edit = current_user(input) == "改成10点";
        if current_tool(input).is_none() {
            if edit {
                assert!(input["messages"][0]["content"].as_str().unwrap().contains("desktop-saved-id"));
                let previous = input["messages"].as_array().unwrap().iter().rev().find(|message| message["role"] == "tool").unwrap();
                let result: Value = serde_json::from_str(previous["content"].as_str().unwrap()).unwrap();
                assert_eq!(result["savedAutomationId"], "desktop-saved-id");
                assert_eq!(result["status"], "saved");
                assert!(result.get("automationId").is_none());
            }
            tool("propose_automation", draft(edit)) // Deliberately reuses call-propose_automation.
        } else if edit {
            text("这是同一个自动化的更新卡片。")
        } else {
            Reply { frames: vec![json!({"choices":[{"delta":{"content":"STREAMING_REPLY"},"finish_reason":null}]}), json!({"choices":[{"delta":{"content":"_FINISHED"},"finish_reason":"stop"}]})], pause:true, status:200, json_response:false }
        }
    }).await;
    let (data, project, engine, id) = setup(&fake).await;
    send(&engine, &id, "automation-initial", "每天9点检查测试。").await;
    let active = wait(&engine, &id, |value| {
        value.to_string().contains("STREAMING_REPLY")
    })
    .await;
    let original_tool_id = proposal_parts(&active)[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ack = confirm(&engine, &id, &original_tool_id, "desktop-saved-id")
        .await
        .unwrap();
    assert_eq!(
        ack,
        json!({"status":"saved","automationId":"desktop-saved-id","toolCallId":original_tool_id})
    );
    assert_eq!(
        confirm(&engine, &id, &original_tool_id, "desktop-saved-id")
            .await
            .unwrap(),
        ack
    );
    let saved_active = snapshot(&engine, &id).await;
    assert_eq!(saved_active["status"], "running");
    let output: Value =
        serde_json::from_str(proposal_parts(&saved_active)[0]["output"].as_str().unwrap()).unwrap();
    assert_eq!(output["savedAutomationId"], "desktop-saved-id");
    assert!(output.get("automationId").is_none());
    assert_eq!(fake.count(), 2, "confirmation never triggers inference");
    let path = data
        .path()
        .join("sessions")
        .join(format!("{}.json", id.trim_start_matches("lc:")));
    let stored: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    let history_output: Value = serde_json::from_str(
        stored["history"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert!(
        history_output.get("savedAutomationId").is_none(),
        "live compaction source is immutable until settlement"
    );
    assert_eq!(
        stored["automationSaveReceipts"][0]["automationId"],
        "desktop-saved-id"
    );
    fake.resume.notify_one();
    wait(&engine, &id, |value| value["modelPhase"] == "finishing").await;
    fake.resume.notify_one();
    let done = wait(&engine, &id, |value| value["status"] == "idle").await;
    assert!(done.to_string().contains("STREAMING_REPLY_FINISHED"));
    assert_eq!(
        proposal_parts(&done)[0]["output"],
        proposal_parts(&saved_active)[0]["output"]
    );
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    assert_eq!(
        confirm(&reopened, &id, &original_tool_id, "desktop-saved-id")
            .await
            .unwrap(),
        ack
    );
    assert_eq!(fake.count(), 2);
    send(&reopened, &id, "automation-edit", "改成10点").await;
    let edited = wait(&reopened, &id, |value| value["status"] == "idle").await;
    let parts = proposal_parts(&edited);
    assert_eq!(parts.len(), 2);
    let edit_tool_id = parts[1]["id"].as_str().unwrap();
    assert_ne!(
        edit_tool_id, original_tool_id,
        "provider call IDs are only response-local"
    );
    assert_eq!(edit_tool_id.len(), 37);
    assert!(edit_tool_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'));
    let edit: Value = serde_json::from_str(parts[1]["output"].as_str().unwrap()).unwrap();
    assert_eq!(edit["automationId"], "desktop-saved-id");
    assert_eq!(edit["input"]["cronExpr"], "0 10 * * *");
    assert_eq!(
        confirm(&reopened, &id, edit_tool_id, "desktop-saved-id")
            .await
            .unwrap()["status"],
        "saved"
    );
    let edited_saved = snapshot(&reopened, &id).await;
    let original: Value =
        serde_json::from_str(proposal_parts(&edited_saved)[0]["output"].as_str().unwrap()).unwrap();
    assert_eq!(original["input"]["cronExpr"], "0 9 * * *");
    assert_eq!(original["savedAutomationId"], "desktop-saved-id");
    assert_eq!(fake.count(), 4);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn desktop_confirmation_rejects_wrong_sessions_tools_and_changed_edit_targets() {
    let fake = Fake::start(|input| {
        if current_tool(input).is_none() {
            tool("propose_automation", draft(true))
        } else {
            text("请保存更新建议。")
        }
    })
    .await;
    let (_data, _project, engine, id) = setup(&fake).await;
    send(&engine, &id, "edit-existing", "更新已有任务。").await;
    let before = wait(&engine, &id, |value| {
        value["status"] == "idle" && value["titlePending"] == false
    })
    .await;
    let tool_id = proposal_parts(&before)[0]["id"].as_str().unwrap();
    let other = engine.call("createSession", json!({})).await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(confirm(&engine, &other, tool_id, "desktop-saved-id")
        .await
        .is_err());
    assert!(confirm(&engine, &id, "wrong-tool", "desktop-saved-id")
        .await
        .is_err());
    assert!(confirm(&engine, &id, tool_id, "different-id")
        .await
        .is_err());
    assert_eq!(snapshot(&engine, &id).await, before);
    assert_eq!(
        confirm(&engine, &id, tool_id, "desktop-saved-id")
            .await
            .unwrap()["status"],
        "saved"
    );
    assert!(confirm(&engine, &id, tool_id, "different-id")
        .await
        .is_err());
    assert_eq!(fake.count(), 2);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_proposals_and_receipt_write_failures_never_acknowledge_a_save() {
    for invalid in [true, false] {
        let fake = Fake::start(move |input| {
            if current_tool(input).is_none() {
                let mut input = draft(false);
                if invalid {
                    input.as_object_mut().unwrap().remove("cronExpr");
                }
                tool("propose_automation", input)
            } else {
                text("完成建议。")
            }
        })
        .await;
        let (data, _project, engine, id) = setup(&fake).await;
        send(&engine, &id, "receipt-failure", "检查测试。").await;
        let before = wait(&engine, &id, |value| {
            value["status"] == "idle" && value["titlePending"] == false
        })
        .await;
        let tool_id = proposal_parts(&before)[0]["id"].as_str().unwrap();
        let path = data
            .path()
            .join("sessions")
            .join(format!("{}.json", id.trim_start_matches("lc:")));
        let saved = tokio::fs::read(&path).await.unwrap();
        if !invalid {
            tokio::fs::remove_file(&path).await.unwrap();
            tokio::fs::create_dir(&path).await.unwrap();
        }
        assert!(confirm(&engine, &id, tool_id, "desktop-saved-id")
            .await
            .is_err());
        assert_eq!(snapshot(&engine, &id).await, before);
        assert_eq!(fake.count(), 2);
        if !invalid {
            tokio::fs::remove_dir(&path).await.unwrap();
            tokio::fs::write(&path, saved).await.unwrap();
        }
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn provider_tool_ids_with_control_characters_or_excessive_length_are_normalized() {
    for id in ["x".repeat(300), "call\n0".into()] {
        let fake = Fake::start(move |input| {
            if current_tool(input).is_none() {
                let mut reply = tool("propose_automation", draft(false));
                reply.frames[0]["choices"][0]["delta"]["tool_calls"][0]["id"] = json!(id);
                reply
            } else {
                text("请保存建议。")
            }
        })
        .await;
        let (_data, _project, engine, session) = setup(&fake).await;
        send(&engine, &session, "bounded-tool-id", "每天9点检查。").await;
        let done = wait(&engine, &session, |value| value["status"] == "idle").await;
        let tool_id = proposal_parts(&done)[0]["id"].as_str().unwrap();
        assert!(tool_id.len() < 100 && !tool_id.chars().any(char::is_control));
        assert!(format!("proposal:{session}:{tool_id}").len() <= 256);
        assert_eq!(
            confirm(&engine, &session, tool_id, "desktop-saved-id")
                .await
                .unwrap()["status"],
            "saved"
        );
        engine.shutdown().await.unwrap();
    }
}
