use super::*;

#[tokio::test]
async fn memory_survives_restart_and_only_injects_the_selected_projects_facts() {
    let fake = Fake::start(|_| text("MEMORY_RESPONSE")).await;
    let (data, project, engine, id) = setup(&fake).await;
    engine
        .call(
            "editMemory",
            json!({"revision":0,"scope":"user","action":"add","content":"默认中文回答"}),
        )
        .await
        .unwrap();
    engine
        .call(
            "editMemory",
            json!({"revision":1,"scope":"project","action":"add","content":"当前项目使用 pnpm"}),
        )
        .await
        .unwrap();
    send(&engine, &id, "with-memory", "检查上下文").await;
    assert_eq!(
        wait(&engine, &id, |value| value["status"] == "idle").await["status"],
        "idle"
    );
    let first = fake.requests.lock().unwrap()[0].clone();
    assert!(first["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("当前项目使用 pnpm"));
    assert_eq!(first["messages"][1]["role"], "user");
    assert!(!first["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("当前项目使用 pnpm"));
    engine.shutdown().await.unwrap();

    let resumed = NativeEngine::open(data.path().into()).await.unwrap();
    resumed
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    let saved = resumed.call("getMemory", json!({})).await.unwrap();
    assert_eq!(saved["user"]["entries"][0]["content"], "默认中文回答");
    assert_eq!(
        saved["project"]["entries"][0]["content"],
        "当前项目使用 pnpm"
    );
    let other = TempDir::new().unwrap();
    resumed
        .bind(other.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    let unrelated = resumed.call("getMemory", json!({})).await.unwrap();
    assert_eq!(unrelated["project"]["entries"], json!([]));
    assert_eq!(unrelated["user"]["entries"][0]["content"], "默认中文回答");
    let other_id = resumed
        .call(
            "createSession",
            json!({"mode":"build","permissionMode":"auto"}),
        )
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    send(&resumed, &other_id, "other-memory", "检查项目隔离").await;
    wait(&resumed, &other_id, |value| value["status"] == "idle").await;
    let other_request = fake.requests.lock().unwrap().last().unwrap().clone();
    let body = other_request.to_string();
    assert!(body.contains("默认中文回答"));
    assert!(!body.contains("当前项目使用 pnpm"));
    resumed.shutdown().await.unwrap();
}

#[tokio::test]
async fn model_memory_write_obeys_confirmation_and_is_visible_to_the_next_request() {
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() {
            tool(
                "memory",
                json!({"scope":"project","action":"add","content":"使用 Rust 和 pnpm"}),
            )
        } else {
            text("MEMORY_SAVED_AFTER_PERMISSION")
        }
    })
    .await;
    let (_data, _project, engine, id) = setup(&fake).await;
    send(&engine, &id, "remember", "记住项目使用 Rust 和 pnpm").await;
    let pending = wait(&engine, &id, |value| {
        value["status"] == "waiting_permission"
    })
    .await;
    assert_eq!(pending["permissions"][0]["toolName"], "memory");
    assert_eq!(pending["permissions"][0]["approvalMode"], "user-once");
    assert_eq!(
        engine.call("getMemory", json!({})).await.unwrap()["project"]["entries"],
        json!([])
    );
    engine
        .call(
            "replyPermission",
            json!({"sessionId":id,"requestId":pending["permissions"][0]["id"],"decision":"once"}),
        )
        .await
        .unwrap();
    wait(&engine, &id, |value| value["status"] == "idle").await;
    let saved = engine.call("getMemory", json!({})).await.unwrap();
    assert_eq!(
        saved["project"]["entries"][0]["content"],
        "使用 Rust 和 pnpm"
    );
    let second = fake.requests.lock().unwrap()[1].clone();
    assert!(second["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("使用 Rust 和 pnpm"));
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn disabled_memory_is_not_injected_or_advertised_and_clear_is_revision_safe() {
    let fake = Fake::start(|_| text("NO_MEMORY")).await;
    let (_data, _project, engine, id) = setup(&fake).await;
    engine
        .call(
            "editMemory",
            json!({"revision":0,"scope":"user","action":"add","content":"默认回答简洁"}),
        )
        .await
        .unwrap();
    assert!(engine
        .call("clearMemory", json!({"revision":0,"scope":"all"}))
        .await
        .is_err());
    engine
        .call("configureMemory", json!({"revision":1,"enabled":false}))
        .await
        .unwrap();
    send(&engine, &id, "without-memory", "开始").await;
    wait(&engine, &id, |value| value["status"] == "idle").await;
    let request = fake.requests.lock().unwrap()[0].clone();
    assert!(!request["messages"].to_string().contains("默认回答简洁"));
    assert!(!request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|schema| schema["function"]["name"] == "memory"));
    engine
        .call("clearMemory", json!({"revision":2,"scope":"all"}))
        .await
        .unwrap();
    assert_eq!(
        engine.call("getMemory", json!({})).await.unwrap()["user"]["entries"],
        json!([])
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn rejected_or_disabled_pending_memory_writes_do_not_change_storage() {
    for disable_while_waiting in [false, true] {
        let fake = Fake::start(|input| {
            if last_tool(input).is_none() {
                tool(
                    "memory",
                    json!({"scope":"user","action":"add","content":"记住默认用中文"}),
                )
            } else {
                text("MEMORY_OPERATION_SETTLED")
            }
        })
        .await;
        let (_data, _project, engine, id) = setup(&fake).await;
        send(&engine, &id, "memory-permission", "整理偏好").await;
        let pending = wait(&engine, &id, |value| {
            value["status"] == "waiting_permission"
        })
        .await;
        if disable_while_waiting {
            engine
                .call("configureMemory", json!({"revision":0,"enabled":false}))
                .await
                .unwrap();
        }
        engine.call("replyPermission", json!({"sessionId":id,"requestId":pending["permissions"][0]["id"],"decision":if disable_while_waiting {"once"} else {"reject"}})).await.unwrap();
        wait(&engine, &id, |value| value["status"] == "idle").await;
        assert_eq!(
            engine.call("getMemory", json!({})).await.unwrap()["user"]["entries"],
            json!([])
        );
        engine.shutdown().await.unwrap();
    }
}
