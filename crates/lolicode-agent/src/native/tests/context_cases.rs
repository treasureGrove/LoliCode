use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[tokio::test]
async fn switching_context_windows_rechecks_budget_without_changing_models_or_other_sessions() {
    let fake = Fake::start(|_| tool("ask_user", json!({"questions":[{"question":"Continue?","options":[{"label":"Yes"}]}]}))).await;
    let (data, project, engine, id) = setup(&fake).await;
    let mut models = catalog();
    models["models"][0]["contextLimits"] = json!([1024,128000,1000000]);
    engine.bind(project.path().into(), models.clone(), fake.gateway()).await.unwrap();
    let other = engine.call("createSession",json!({"contextLimit":1000000})).await.unwrap();
    assert!(engine.call("updateSession",json!({"sessionId":id,"contextLimit":999999})).await.is_err());
    let saved = engine.call("updateSession",json!({"sessionId":id,"contextLimit":128000})).await.unwrap();
    assert_eq!(saved["contextLimit"],128000);
    send(&engine, &id, "new-window", &"A useful long specification. ".repeat(250)).await;
    let pending = wait(&engine,&id,|value| value["status"] == "waiting_question").await;
    engine.call("updateSession",json!({"sessionId":id,"contextLimit":1024})).await.unwrap();
    engine.call("replyQuestion",json!({"sessionId":id,"requestId":pending["questions"][0]["id"],"answer":{"answer_0":"Yes"}})).await.unwrap();
    let result = wait(&engine,&id,|value| value["status"] == "error").await;
    assert!(result["error"].as_str().unwrap().contains("上下文预算"));
    assert_eq!(fake.count(),1,"the smaller window must be checked before another request");
    assert_eq!(result["session"]["model"]["modelId"],"channel/opaque/model");
    let other_state=engine.call("getSession",json!({"sessionId":other["id"]})).await.unwrap();
    assert_eq!(other_state["session"]["contextLimit"],1000000);
    engine.shutdown().await.unwrap();
    let restored=NativeEngine::open(data.path().into()).await.unwrap();
    restored.bind(project.path().into(),models,fake.gateway()).await.unwrap();
    let snapshot=restored.call("getSession",json!({"sessionId":id})).await.unwrap();
    assert_eq!(snapshot["session"]["contextLimit"],1024);
    let reset=restored.call("updateSession",json!({"sessionId":id,"resetContextLimit":true})).await.unwrap();
    assert!(reset["contextLimit"].is_null());
    restored.shutdown().await.unwrap();
}

#[tokio::test]
async fn switching_models_clears_a_window_not_advertised_by_the_new_model() {
    let fake=Fake::start(|_|text("OK")).await;
    let (_data,project,engine,id)=setup(&fake).await;
    let mut models=catalog();
    models["models"][0]["contextLimits"]=json!([128000,1000000]);
    let mut other=models["models"][0].clone();
    other["id"]=json!("lolicode/channel/other/model");
    other["modelId"]=json!("channel/other/model");
    other["contextLimit"]=json!(32000);
    other["contextLimits"]=json!([32000,64000]);
    models["models"].as_array_mut().unwrap().push(other);
    engine.bind(project.path().into(),models,fake.gateway()).await.unwrap();
    engine.call("updateSession",json!({"sessionId":id,"contextLimit":1000000})).await.unwrap();
    let changed=engine.call("updateSession",json!({"sessionId":id,"modelId":"lolicode/channel/other/model"})).await.unwrap();
    assert!(changed["contextLimit"].is_null());
    engine.shutdown().await.unwrap();
}

fn assert_protocol(messages: &[Value]) {
    let mut index = 0;
    while index < messages.len() {
        assert_ne!(messages[index]["role"], "tool", "orphaned tool result");
        let calls = messages[index]["tool_calls"].as_array();
        index += 1;
        if let Some(calls) = calls {
            let expected = calls
                .iter()
                .map(|call| call["id"].as_str().unwrap())
                .collect::<std::collections::BTreeSet<_>>();
            let mut results = std::collections::BTreeSet::new();
            while index < messages.len() && messages[index]["role"] == "tool" {
                assert!(results.insert(messages[index]["tool_call_id"].as_str().unwrap()));
                index += 1;
            }
            assert_eq!(results, expected);
        }
    }
}

fn summary_reply(input: &Value) -> Reply {
    assert!(input["tools"].as_array().unwrap().is_empty());
    let output = input["max_tokens"].as_u64().unwrap();
    assert!(output > 0 && output <= 20000);
    let prompt = input["messages"][0]["content"].as_str().unwrap();
    let bytes = prompt.split("shorter than ").nth(1).unwrap()
        .split_whitespace().next().unwrap().parse::<u64>().unwrap();
    assert!(bytes <= output, "summary instruction must fit its generation cap");
    let data: Value =
        serde_json::from_str(input["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_protocol(data["completedHistory"].as_array().unwrap());
    text("Goal: finish the user's counter task. Constraints: preserve log.txt and unrelated files. Verified completed tool results are authoritative. Files: counter.txt, log.txt. Continue pending counter updates; never replay completed writes.")
}

fn edit_batch(step: usize) -> Reply {
    let calls = [
        ("read_file", json!({"path":"log.txt"})),
        ("apply_patch", json!({"path":"counter.txt","old_text":format!("value={step}\n"),"new_text":format!("value={}\n",step+1)})),
    ].into_iter().enumerate().map(|(index,(name,input))| json!({"index":index,"id":format!("call-{step}-{index}"),"type":"function","function":{"name":name,"arguments":input.to_string()}})).collect::<Vec<_>>();
    Reply {
        frames: vec![
            json!({"choices":[{"delta":{"tool_calls":calls},"finish_reason":"tool_calls"}]}),
        ],
        pause: false,
        status: 200,
        json_response: false,
    }
}

async fn small_context(engine: &NativeEngine, project: &TempDir, fake: &Fake) {
    let mut models = catalog();
    models["models"][0]["contextLimit"] = json!(16000);
    engine
        .bind(project.path().into(), models, fake.gateway())
        .await
        .unwrap();
    tokio::fs::write(project.path().join("counter.txt"), "value=0\n")
        .await
        .unwrap();
    tokio::fs::write(
        project.path().join("log.txt"),
        "VERIFIED_LOG_DETAIL ".repeat(350),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn long_tasks_compact_multiple_complete_batches_and_resume_after_restart_without_replay() {
    let steps = Arc::new(AtomicUsize::new(0));
    let recorded = steps.clone();
    let fake = Fake::start(move |input| {
        if is_compaction(input) {
            return summary_reply(input);
        }
        assert_protocol(input["messages"].as_array().unwrap());
        let step = recorded.fetch_add(1, Ordering::SeqCst);
        if step < 40 {
            edit_batch(step)
        } else {
            text("ALL_FORTY_BATCHES_FINISHED")
        }
    })
    .await;
    let (data, project, engine, id) = setup(&fake).await;
    small_context(&engine, &project, &fake).await;
    send(
        &engine,
        &id,
        "compact-long-task",
        "Finish 40 updates to counter.txt; preserve log.txt and unrelated files.",
    )
    .await;
    let result = wait(&engine, &id, |value| {
        matches!(value["status"].as_str(), Some("idle" | "error"))
    })
    .await;
    assert_eq!(result["status"], "idle", "{}", result["error"]);
    assert!(!result["compacting"].as_bool().unwrap());
    assert_eq!(
        tokio::fs::read_to_string(project.path().join("counter.txt"))
            .await
            .unwrap(),
        "value=40\n"
    );
    assert_eq!(fake.count(), 41);
    assert!(fake.compaction_requests.lock().unwrap().len() >= 3);
    let attributions = fake.session_attributions.lock().unwrap().clone();
    assert!(attributions.iter().any(|(kind, _)| kind == "compaction"));
    assert!(attributions.iter().any(|(kind, _)| kind == "main"));
    assert!(attributions.iter().all(|(_, session)| session == &id));
    assert_eq!(
        result["messages"].as_array().unwrap().len(),
        42,
        "full transcript must remain available"
    );
    assert_eq!(result["diffs"].as_array().unwrap().len(), 1);
    engine.shutdown().await.unwrap();
    let record = std::fs::read_dir(data.path().join("sessions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let stored: Value = serde_json::from_slice(&std::fs::read(record).unwrap()).unwrap();
    assert!(stored["compactionCount"].as_u64().unwrap() >= 3);
    assert!(stored["contextSummary"]
        .as_str()
        .unwrap()
        .contains("counter.txt"));
    assert_protocol(stored["history"].as_array().unwrap());
    assert!(
        stored["history"].as_array().unwrap().len() < result["messages"].as_array().unwrap().len()
    );
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    let mut models = catalog();
    models["models"][0]["contextLimit"] = json!(16000);
    reopened
        .bind(project.path().into(), models, fake.gateway())
        .await
        .unwrap();
    send(
        &reopened,
        &id,
        "after-compaction-restart",
        "Confirm the completed result without changing files",
    )
    .await;
    let resumed = wait(&reopened, &id, |value| {
        matches!(value["status"].as_str(), Some("idle" | "error"))
    })
    .await;
    assert_eq!(resumed["status"], "idle", "{}", resumed["error"]);
    let requests = fake.requests.lock().unwrap();
    assert!(requests.last().unwrap()["messages"]
        .to_string()
        .contains("<lolicode_context_checkpoint>"));
    drop(requests);
    assert_eq!(fake.count(), 42);
    assert_eq!(
        tokio::fs::read_to_string(project.path().join("counter.txt"))
            .await
            .unwrap(),
        "value=40\n"
    );
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_or_cancelled_summaries_preserve_history_and_can_retry_without_tool_side_effects() {
    for cancel_summary in [false, true] {
        let recover = Arc::new(AtomicBool::new(false));
        let recovered = recover.clone();
        let steps = Arc::new(AtomicUsize::new(0));
        let count = steps.clone();
        let fake = Fake::start(move |input| {
            if is_compaction(input) {
                if recovered.load(Ordering::SeqCst) {
                    return summary_reply(input);
                }
                if cancel_summary {
                    let mut reply = summary_reply(input);
                    reply.pause = true;
                    return reply;
                }
                return Reply {
                    frames: Vec::new(),
                    pause: false,
                    status: 500,
                    json_response: false,
                };
            }
            if recovered.load(Ordering::SeqCst) {
                return text("RECOVERED_WITHOUT_REPLAY");
            }
            edit_batch(count.fetch_add(1, Ordering::SeqCst))
        })
        .await;
        let (data, project, engine, id) = setup(&fake).await;
        small_context(&engine, &project, &fake).await;
        send(
            &engine,
            &id,
            "summary-interrupted",
            "Update counter.txt while preserving log.txt.",
        )
        .await;
        wait(&engine, &id, |_| {
            !fake.compaction_requests.lock().unwrap().is_empty()
        })
        .await;
        if cancel_summary {
            assert_eq!(snapshot(&engine, &id).await["compacting"], true);
            engine
                .call(
                    "renameSession",
                    json!({"sessionId":id,"title":"用户保留的标题"}),
                )
                .await
                .unwrap();
            engine
                .call(
                    "updateSession",
                    json!({"sessionId":id,"permissionMode":"full_access"}),
                )
                .await
                .unwrap();
            engine
                .call("interruptSession", json!({"sessionId":id}))
                .await
                .unwrap();
        }
        let stopped = wait(&engine, &id, |value| {
            matches!(value["status"].as_str(), Some("idle" | "error"))
        })
        .await;
        assert_eq!(stopped["compacting"], false);
        let completed = steps.load(Ordering::SeqCst);
        assert_eq!(
            tokio::fs::read_to_string(project.path().join("counter.txt"))
                .await
                .unwrap(),
            format!("value={completed}\n")
        );
        let record = std::fs::read_dir(data.path().join("sessions"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let stored: Value = serde_json::from_slice(&std::fs::read(record).unwrap()).unwrap();
        assert_eq!(stored["compactionCount"], 0);
        assert!(stored["contextSummary"].is_null());
        assert_protocol(stored["history"].as_array().unwrap());
        assert_eq!(
            stored["history"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] == "tool")
                .count(),
            completed * 2
        );
        recover.store(true, Ordering::SeqCst);
        send(
            &engine,
            &id,
            "summary-retry",
            "Recover without repeating the previous writes",
        )
        .await;
        let result = wait(&engine, &id, |value| {
            matches!(value["status"].as_str(), Some("idle" | "error"))
        })
        .await;
        assert_eq!(result["status"], "idle", "{}", result["error"]);
        assert!(result.to_string().contains("RECOVERED_WITHOUT_REPLAY"));
        assert_eq!(
            tokio::fs::read_to_string(project.path().join("counter.txt"))
                .await
                .unwrap(),
            format!("value={completed}\n")
        );
        if cancel_summary {
            assert_eq!(result["session"]["title"], "用户保留的标题");
            assert_eq!(result["session"]["permissionMode"], "full_access");
        }
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn reasoning_configuration_is_validated_persisted_and_applies_to_the_next_request() {
    let steps = Arc::new(AtomicUsize::new(0));
    let observed = steps.clone();
    let fake = Fake::start(move |input| match observed.fetch_add(1, Ordering::SeqCst) {
        0 => {
            assert_eq!(input["reasoning_effort"], "low");
            tool(
                "ask_user",
                json!({"questions":[{"question":"Continue?","options":[{"label":"Yes"}]}]}),
            )
        }
        1 => {
            assert_eq!(input["reasoning_effort"], "high");
            text("HIGH_EFFORT_APPLIED")
        }
        _ => {
            assert_eq!(input["reasoning_effort"], "low");
            text("PROVIDER_DEFAULT_APPLIED")
        }
    })
    .await;
    let (data, project, engine, id) = setup(&fake).await;
    let mut models = catalog();
    models["models"][0]["reasoningEfforts"] = json!(["low", "high"]);
    let mut other = models["models"][0].clone();
    other["id"] = json!("lolicode/channel/other/model");
    other["modelId"] = json!("channel/other/model");
    other["reasoningEfforts"] = json!(["low"]);
    models["models"].as_array_mut().unwrap().push(other);
    engine
        .bind(project.path().into(), models.clone(), fake.gateway())
        .await
        .unwrap();
    assert!(engine
        .call(
            "updateSession",
            json!({"sessionId":id,"reasoningEffort":"invented"})
        )
        .await
        .is_err());
    engine
        .call(
            "updateSession",
            json!({"sessionId":id,"reasoningEffort":"low"}),
        )
        .await
        .unwrap();
    send(
        &engine,
        &id,
        "effort-live",
        "Switch the effort while waiting",
    )
    .await;
    let question = wait(&engine, &id, |value| value["status"] == "waiting_question").await;
    engine
        .call(
            "updateSession",
            json!({"sessionId":id,"reasoningEffort":"high"}),
        )
        .await
        .unwrap();
    engine.call("replyQuestion",json!({"sessionId":id,"requestId":question["questions"][0]["id"],"answer":{"answer_0":"Yes"}})).await.unwrap();
    wait(&engine, &id, |value| value["status"] == "idle").await;
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.path().into(), models, fake.gateway())
        .await
        .unwrap();
    assert_eq!(
        snapshot(&reopened, &id).await["session"]["reasoningEffort"],
        "high"
    );
    reopened
        .call(
            "updateSession",
            json!({"sessionId":id,"modelId":"lolicode/channel/other/model"}),
        )
        .await
        .unwrap();
    assert!(snapshot(&reopened, &id).await["session"]
        .get("reasoningEffort")
        .is_none());
    send(
        &reopened,
        &id,
        "effort-default",
        "Use the new model defaults",
    )
    .await;
    wait(&reopened, &id, |value| value["status"] == "idle").await;
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn unknown_context_is_compacted_once_after_an_explicit_upstream_limit_error_only() {
    for error_code in ["context_length_exceeded", "invalid_request_error"] {
        let steps = Arc::new(AtomicUsize::new(0));
        let recorded = steps.clone();
        let fake = Fake::start(move |input| {
            if is_compaction(input) { return summary_reply(input); }
            let step = recorded.fetch_add(1, Ordering::SeqCst);
            if step < 3 { return edit_batch(step); }
            if step == 3 {
                return Reply { frames:vec![json!({"error":{"code":error_code,"message":"relay context message with no guaranteed meaning"}})],pause:false,status:400,json_response:true };
            }
            assert!(input["messages"].to_string().contains("<lolicode_context_checkpoint>"));
            text("REACTIVE_CONTEXT_RECOVERED")
        }).await;
        let (_data, project, engine, id) = setup(&fake).await;
        let mut models = catalog();
        models["models"][0]
            .as_object_mut()
            .unwrap()
            .remove("contextLimit");
        engine
            .bind(project.path().into(), models, fake.gateway())
            .await
            .unwrap();
        tokio::fs::write(project.path().join("counter.txt"), "value=0\n")
            .await
            .unwrap();
        tokio::fs::write(
            project.path().join("log.txt"),
            "VERIFIED_LOG_DETAIL ".repeat(350),
        )
        .await
        .unwrap();
        send(
            &engine,
            &id,
            "reactive-context",
            "Update counter.txt and preserve verified results",
        )
        .await;
        let result = wait(&engine, &id, |value| {
            matches!(value["status"].as_str(), Some("idle" | "error"))
        })
        .await;
        if error_code == "context_length_exceeded" {
            assert_eq!(result["status"], "idle", "{}", result["error"]);
            assert_eq!(fake.compaction_requests.lock().unwrap().len(), 1);
            assert_eq!(fake.count(), 5);
        } else {
            assert_eq!(result["status"], "error");
            assert!(result["error"].as_str().unwrap().contains("HTTP 400"));
            assert!(fake.compaction_requests.lock().unwrap().is_empty());
            assert_eq!(fake.count(), 4);
        }
        assert_eq!(
            tokio::fs::read_to_string(project.path().join("counter.txt"))
                .await
                .unwrap(),
            "value=3\n"
        );
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn successful_compaction_preserves_configuration_and_title_changes_made_while_summarizing() {
    let steps = Arc::new(AtomicUsize::new(0));
    let recorded = steps.clone();
    let fake = Fake::start(move |input| {
        if is_compaction(input) {
            let mut reply = summary_reply(input);
            reply.pause = true;
            return reply;
        }
        let step = recorded.fetch_add(1, Ordering::SeqCst);
        if input["model"] != "channel/other/model" {
            edit_batch(step)
        } else {
            assert_eq!(input["model"], "channel/other/model");
            assert_eq!(input["reasoning_effort"], "low");
            text("CONFIGURATION_PRESERVED")
        }
    })
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    small_context(&engine, &project, &fake).await;
    let mut models = catalog();
    models["models"][0]["contextLimit"] = json!(16000);
    let mut other = models["models"][0].clone();
    other["id"] = json!("lolicode/channel/other/model");
    other["modelId"] = json!("channel/other/model");
    other["contextLimit"] = json!(32000);
    other["reasoningEfforts"] = json!(["low"]);
    models["models"].as_array_mut().unwrap().push(other);
    engine
        .bind(project.path().into(), models, fake.gateway())
        .await
        .unwrap();
    send(
        &engine,
        &id,
        "concurrent-summary",
        "Finish counter.txt without losing concurrent user choices",
    )
    .await;
    wait(&engine, &id, |value| value["compacting"] == true).await;
    engine
        .call(
            "renameSession",
            json!({"sessionId":id,"title":"不要覆盖我的名字"}),
        )
        .await
        .unwrap();
    engine.call("updateSession",json!({"sessionId":id,"modelId":"lolicode/channel/other/model","permissionMode":"ask","reasoningEffort":"low"})).await.unwrap();
    fake.resume.notify_one();
    let result = wait(&engine, &id, |value| {
        matches!(value["status"].as_str(), Some("idle" | "error"))
    })
    .await;
    assert_eq!(result["status"], "idle", "{}", result["error"]);
    assert_eq!(result["session"]["title"], "不要覆盖我的名字");
    assert_eq!(result["session"]["model"]["modelId"], "channel/other/model");
    assert_eq!(result["session"]["permissionMode"], "ask");
    assert_eq!(result["session"]["reasoningEffort"], "low");
    assert_eq!(result["compacting"], false);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn unknown_reasoning_capabilities_allow_explicit_override_but_do_not_inherit_it_on_switch() {
    let fake = Fake::start(|input| {
        assert_eq!(input["reasoning_effort"], "relay_custom");
        text("MANUAL_OVERRIDE_APPLIED")
    })
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    let mut models = catalog();
    let mut other = models["models"][0].clone();
    other["id"] = json!("lolicode/channel/other/model");
    other["modelId"] = json!("channel/other/model");
    models["models"].as_array_mut().unwrap().push(other);
    engine
        .bind(project.path().into(), models, fake.gateway())
        .await
        .unwrap();
    engine
        .call(
            "updateSession",
            json!({"sessionId":id,"reasoningEffort":"relay_custom"}),
        )
        .await
        .unwrap();
    send(
        &engine,
        &id,
        "manual-effort",
        "Use my explicit relay setting",
    )
    .await;
    wait(&engine, &id, |value| value["status"] == "idle").await;
    engine
        .call(
            "updateSession",
            json!({"sessionId":id,"modelId":"lolicode/channel/other/model"}),
        )
        .await
        .unwrap();
    assert!(snapshot(&engine, &id).await["session"]
        .get("reasoningEffort")
        .is_none());
    engine
        .call(
            "updateSession",
            json!({"sessionId":id,"reasoningEffort":""}),
        )
        .await
        .unwrap();
    assert!(snapshot(&engine, &id).await["session"]
        .get("reasoningEffort")
        .is_none());
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_second_context_rejection_does_not_enter_an_unbounded_summary_retry_loop() {
    let steps = Arc::new(AtomicUsize::new(0));
    let recorded = steps.clone();
    let fake = Fake::start(move |input| {
        if is_compaction(input) {
            return summary_reply(input);
        }
        let step = recorded.fetch_add(1, Ordering::SeqCst);
        if step < 3 {
            return edit_batch(step);
        }
        Reply {
            frames: vec![json!({"error":{"code":"context_length_exceeded"}})],
            pause: false,
            status: 400,
            json_response: true,
        }
    })
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    let mut models = catalog();
    models["models"][0]
        .as_object_mut()
        .unwrap()
        .remove("contextLimit");
    engine
        .bind(project.path().into(), models, fake.gateway())
        .await
        .unwrap();
    tokio::fs::write(project.path().join("counter.txt"), "value=0\n")
        .await
        .unwrap();
    tokio::fs::write(
        project.path().join("log.txt"),
        "VERIFIED_LOG_DETAIL ".repeat(350),
    )
    .await
    .unwrap();
    send(
        &engine,
        &id,
        "repeat-context-error",
        "Update counter.txt and preserve results",
    )
    .await;
    let result = wait(&engine, &id, |value| value["status"] == "error").await;
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("自动整理后仍报告上下文超限"));
    assert_eq!(fake.compaction_requests.lock().unwrap().len(), 1);
    assert_eq!(fake.count(), 5);
    assert_eq!(result["compacting"], false);
    assert_eq!(
        tokio::fs::read_to_string(project.path().join("counter.txt"))
            .await
            .unwrap(),
        "value=3\n"
    );
    engine.shutdown().await.unwrap();
}
