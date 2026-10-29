use super::*;

#[tokio::test]
async fn scalar_or_unknown_context_accepts_local_session_budget_presets_without_sending() {
    for context in [Value::Null, json!(1_000_000)] {
        let fake = Fake::start(|_| text("unused")).await;
        let (_data, project, engine, id) = setup(&fake).await;
        let mut models = catalog();
        models["models"][0]["contextLimit"] = context;
        engine
            .bind(project.path().into(), models, fake.gateway())
            .await
            .unwrap();
        for limit in [128000, 256000] {
            let saved = engine
                .call(
                    "updateSession",
                    json!({"sessionId":id,"contextLimit":limit}),
                )
                .await
                .unwrap();
            assert_eq!(saved["contextLimit"], limit);
        }
        assert!(engine
            .call(
                "updateSession",
                json!({"sessionId":id,"contextLimit":777777})
            )
            .await
            .is_err());
        assert_eq!(fake.count(), 0);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn selected_one_million_keeps_transport_budget_across_reopen_and_catalog_refresh() {
    let fake = Fake::start(|_| text("REFRESHED_BUDGET_ACCEPTED")).await;
    let (data, project, engine, id) = setup(&fake).await;
    let mut models = catalog();
    models["models"][0]["contextLimit"] = json!(1_000_000);
    models["models"][0]["contextLimits"] = json!([32768, 1_000_000]);
    models["models"][0]["maxRequestBytes"] = json!(131072);
    engine
        .bind(project.path().into(), models.clone(), fake.gateway())
        .await
        .unwrap();
    engine
        .call(
            "updateSession",
            json!({"sessionId":id,"contextLimit":1_000_000}),
        )
        .await
        .unwrap();
    assert_eq!(
        engine.call("catalog", json!({})).await.unwrap()["models"][0]["maxRequestBytes"],
        131072
    );
    send(&engine, &id, "capped", &"full specification ".repeat(10000)).await;
    let failed = wait(&engine, &id, |value| value["status"] == "error").await;
    assert!(failed["error"].as_str().unwrap().contains("上下文预算"));
    assert_eq!(failed["session"]["contextLimit"], 1_000_000);
    assert_eq!(fake.count(), 0);
    engine.shutdown().await.unwrap();

    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.path().into(), models.clone(), fake.gateway())
        .await
        .unwrap();
    let restored = snapshot(&reopened, &id).await;
    assert_eq!(restored["session"]["contextLimit"], 1_000_000);
    send(
        &reopened,
        &id,
        "still-capped",
        "Continue the full specification",
    )
    .await;
    let failed = wait(&reopened, &id, |value| value["status"] == "error").await;
    assert!(failed["error"].as_str().unwrap().contains("上下文预算"));
    assert_eq!(fake.count(), 0);

    models["models"][0]
        .as_object_mut()
        .unwrap()
        .remove("maxRequestBytes");
    reopened
        .bind(project.path().into(), models, fake.gateway())
        .await
        .unwrap();
    send(
        &reopened,
        &id,
        "larger-transport",
        "Continue after refreshing the transport limit",
    )
    .await;
    let finished = wait(&reopened, &id, |value| {
        matches!(value["status"].as_str(), Some("idle" | "error"))
    })
    .await;
    assert_eq!(finished["status"], "idle", "{}", finished["error"]);
    assert_eq!(fake.count(), 1);
    assert!(finished.to_string().contains("REFRESHED_BUDGET_ACCEPTED"));
    reopened.shutdown().await.unwrap();
}
