use super::*;

#[tokio::test]
async fn declared_output_limit_below_sixteen_is_rejected_without_a_model_request() {
    let fake =
        Fake::start(|_| panic!("a model with insufficient output capacity must not be called"))
            .await;
    let (_data, project, engine, id) = setup(&fake).await;
    let mut models = catalog();
    models["models"][0]["outputLimit"] = json!(15);
    engine
        .bind(project.path().into(), models, fake.gateway())
        .await
        .unwrap();
    send(
        &engine,
        &id,
        "output-too-small",
        "Preserve all existing history",
    )
    .await;
    let result = wait(&engine, &id, |value| value["status"] == "error").await;
    assert!(result["error"].as_str().unwrap().contains("16 tokens"));
    assert_eq!(fake.count(), 0);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn explicit_output_budget_is_dynamic_in_stream_and_json_without_reasoning_multipliers() {
    for json_response in [false, true] {
        let fake = Fake::start(move |input| {
            let output = input["max_tokens"].as_u64().unwrap();
            assert!(output > 0 && output < 128000);
            let estimated = context::estimated_input_tokens(
                input["messages"].as_array().unwrap(),
                input["tools"].as_array().unwrap(),
            )
            .unwrap();
            assert_eq!(output, 256000 - estimated - 1000);
            let mut reply = text("ADAPTIVE_OUTPUT_FINISHED");
            reply.json_response = json_response;
            reply
        })
        .await;
        let (_data, project, engine, id) = setup(&fake).await;
        let mut models = catalog();
        models["models"][0]["contextLimit"] = json!(1_000_000);
        models["models"][0]["outputLimit"] = json!(128000);
        models["models"][0]["reasoningEfforts"] = json!(["low", "high"]);
        engine
            .bind(project.path().into(), models, fake.gateway())
            .await
            .unwrap();
        engine
            .call(
                "updateSession",
                json!({"sessionId":id,"contextLimit":256000,"reasoningEffort":"high"}),
            )
            .await
            .unwrap();
        send(
            &engine,
            &id,
            "adaptive-output",
            &"full specification ".repeat(18000),
        )
        .await;
        let result = wait(&engine, &id, |value| {
            matches!(value["status"].as_str(), Some("idle" | "error"))
        })
        .await;
        assert_eq!(result["status"], "idle", "{}", result["error"]);
        assert_eq!(fake.count(), 1);
        assert!(result.to_string().contains("ADAPTIVE_OUTPUT_FINISHED"));
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn title_uses_explicit_small_budget_and_length_failure_does_not_replay_partial_tools() {
    let fake = Fake::start_with_titles(
        |_| text("Main response"),
        |input| {
            assert_eq!(input["max_tokens"], 2048);
            text("Safe title")
        },
    )
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    let mut models = catalog();
    models["models"][0]["outputLimit"] = json!(128000);
    engine
        .bind(project.path().into(), models, fake.gateway())
        .await
        .unwrap();
    send(&engine, &id, "title-budget", "Build the requested feature").await;
    wait(&engine, &id, |value| {
        value["status"] == "idle" && !value["titlePending"].as_bool().unwrap_or(false)
    })
    .await;
    assert_eq!(fake.title_requests.lock().unwrap().len(), 1);
    engine.shutdown().await.unwrap();

    let fake = Fake::start(|input| {
        assert!(input["max_tokens"].as_u64().unwrap() > 0);
        Reply { frames: vec![json!({"choices":[{"delta":{"content":"Partial visible answer","tool_calls":[{"index":0,"id":"never-execute","function":{"name":"write_file","arguments":"{\"path\":\"must-not-exist.txt\","}}]},"finish_reason":"length"}]})], pause:false,status:200,json_response:false }
    }).await;
    let (_data, project, engine, id) = setup(&fake).await;
    send(
        &engine,
        &id,
        "length-budget",
        "Do not replay truncated calls",
    )
    .await;
    let result = wait(&engine, &id, |value| value["status"] == "error").await;
    assert!(result["error"].as_str().unwrap().contains("输出长度限制"));
    assert!(result.to_string().contains("Partial visible answer"));
    assert_eq!(fake.count(), 1);
    assert!(!project.path().join("must-not-exist.txt").exists());
    engine.shutdown().await.unwrap();
}
