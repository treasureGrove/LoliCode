//! Loopback integration uses the real native model transport, durable command
//! receipts and cancellation. No user account, external model or global config.
use super::*;
use axum::{body::Body, response::Response, routing::post, Json};
use bytes::Bytes;
use futures::StreamExt;
use lolicode_agent::{
    native::{NativeEngine, NativeGateway},
    AgentSnapshot,
};

struct NativeAutomationFixture {
    engine: NativeEngine,
    catalog: AgentCatalog,
    gateway: NativeGateway,
}
impl AutomationRuntime for NativeAutomationFixture {
    fn bind_project<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<AgentCatalog, String>> {
        Box::pin(async move {
            self.engine
                .bind_background(
                    path.into(),
                    serde_json::to_value(&self.catalog).unwrap(),
                    self.gateway.clone(),
                )
                .await?;
            Ok(self.catalog.clone())
        })
    }
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        _mutate: bool,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move { self.engine.call(method, params).await })
    }
}

struct UnavailableAutomationRuntime(std::sync::atomic::AtomicUsize);
impl AutomationRuntime for UnavailableAutomationRuntime {
    fn bind_project<'a>(&'a self, _path: &'a str) -> BoxFuture<'a, Result<AgentCatalog, String>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err("OWNED_BINDING_UNAVAILABLE".into())
        })
    }
    fn call<'a>(
        &'a self,
        _method: &'a str,
        _params: Value,
        _mutate: bool,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move { panic!("Cancelled or unbound automation must not call an Agent") })
    }
}

#[tokio::test]
async fn automation_dispatch_preserves_cancelled_and_binding_failure_receipts_without_model_calls()
{
    let project = tempfile::tempdir().unwrap();
    let path =
        crate::services::agent_host::canonical_project(&project.path().to_string_lossy()).unwrap();
    for cancelled in [false, true] {
        let db = Arc::new(crate::database::Database::memory().unwrap());
        let mut prefs = preferences::Preferences::default();
        prefs.projects.insert(
            preferences::path_key(&path.to_string_lossy()),
            AgentProject {
                path: path.to_string_lossy().into_owned(),
                name: "isolated failure".into(),
                pinned: false,
                last_opened_at: now_ms(),
            },
        );
        preferences::save(&db, &prefs).unwrap();
        let saved = create_saved_job(&db,&json!({"workspacePath":path,"title":"Owned dispatch failure","prompt":"OWNED_SUCCESS","cronExpr":"0 * * * *","recurring":false,"modelSelection":{"providerId":"owned","modelId":"fixture"}})).await.unwrap();
        let mut store = load(&db).unwrap();
        let job = store.jobs[0].clone();
        let run = create_run(&mut store, saved["automationId"].as_str().unwrap());
        store.runs[0].cancel_requested = cancelled;
        save(&db, &store).unwrap();
        let runtime = Arc::new(UnavailableAutomationRuntime(
            std::sync::atomic::AtomicUsize::new(0),
        ));
        assert!(dispatch_run(runtime.clone(), db.clone(), job, run)
            .await
            .is_none());
        assert_eq!(
            runtime.0.load(Ordering::SeqCst),
            if cancelled { 0 } else { 1 }
        );
        let saved = load(&db).unwrap();
        let receipt = &saved.runs[0];
        assert_eq!(
            receipt.outcome.as_deref(),
            Some(if cancelled { "stopped" } else { "failed" })
        );
        assert!(receipt.finished_at.is_some());
        assert!(receipt.session_id.is_none());
        assert!(!active(receipt));
        if cancelled {
            assert!(receipt.error.is_none());
        } else {
            assert_eq!(receipt.error.as_deref(), Some("OWNED_BINDING_UNAVAILABLE"));
        }
    }
}

#[tokio::test]
async fn automation_production_dispatch_and_monitor_record_completed_native_session() {
    let data = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let path =
        crate::services::agent_host::canonical_project(&project.path().to_string_lossy()).unwrap();
    let db = Arc::new(crate::database::Database::memory().unwrap());
    let mut registered = preferences::Preferences::default();
    registered.projects.insert(
        preferences::path_key(&path.to_string_lossy()),
        AgentProject {
            path: path.to_string_lossy().into_owned(),
            name: "isolated".into(),
            pinned: false,
            last_opened_at: now_ms(),
        },
    );
    preferences::save(&db, &registered).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route("/v1/chat/completions", post(upstream)),
        )
        .await
        .unwrap();
    });
    let catalog: AgentCatalog=serde_json::from_value(json!({"revision":1,"models":[{"id":"lolicode/owned/fixture","providerId":"lolicode","modelId":"owned/fixture","name":"Fixture","channelName":"Owned"}],"defaultModel":"lolicode/owned/fixture","excludedSources":[]})).unwrap();
    let engine = NativeEngine::open(data.path().into()).await.unwrap();
    let runtime: Arc<dyn AutomationRuntime> = Arc::new(NativeAutomationFixture {
        engine: engine.clone(),
        catalog,
        gateway: NativeGateway {
            base_url: format!("http://{address}/v1"),
            bearer_token: "owned-loopback-only".into(),
        },
    });
    let job=create_saved_job(&db,&json!({"workspacePath":path,"title":"Owned scheduled fixture","prompt":"OWNED_SUCCESS","trigger":"schedule","cronExpr":"0 * * * *","recurring":false,"mode":"guarded","modelSelection":{"providerId":"lolicode","modelId":"owned/fixture"}})).await.unwrap();
    // The real-clock trigger is exercised separately by live acceptance. This
    // fixture makes only this isolated job due to test dispatch/monitor/receipts.
    {
        let mut store = load(&db).unwrap();
        store.jobs[0].next_run_at = Some(now_ms());
        save(&db, &store).unwrap();
    }
    let ids = scheduler_tick_runtime(runtime.clone(), db.clone())
        .await
        .unwrap();
    assert_eq!(ids.len(), 1);
    let completed = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let store = load(&db).unwrap();
            if let Some(run) = store
                .runs
                .iter()
                .find(|run| run.run_id == ids[0] && !active(run))
            {
                break run.clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(completed.outcome.as_deref(), Some("succeeded"));
    assert_eq!(
        completed.automation_id,
        job["automationId"].as_str().unwrap()
    );
    assert!(completed.finished_at.is_some());
    let session_id = completed.session_id.unwrap();
    let snapshot = engine
        .call("getSession", json!({"sessionId":session_id}))
        .await
        .unwrap();
    assert!(snapshot["messages"]
        .to_string()
        .contains("OWNED_AUTOMATION_COMPLETED"));
    assert_eq!(
        command_status(runtime.as_ref(), &session_id, &ids[0])
            .await
            .unwrap()
            .as_deref(),
        Some("completed")
    );
    assert!(scheduler_tick_runtime(runtime.clone(), db.clone())
        .await
        .unwrap()
        .is_empty());
    assert_eq!(load(&db).unwrap().runs.len(), 1);
    engine.shutdown().await.unwrap();
    server.abort();
}

async fn upstream(Json(body): Json<Value>) -> Response {
    let text = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .map(|message| message["content"].as_str().unwrap_or_default())
        .collect::<String>();
    if text.contains("OWNED_FAIL") {
        return Response::builder()
            .status(400)
            .body(Body::from("owned invalid request"))
            .unwrap();
    }
    let waiting = text.contains("OWNED_WAIT");
    let frame = if waiting {
        json!({"choices":[{"delta":{"role":"assistant","content":""}}]})
    } else {
        json!({"choices":[{"delta":{"content":"OWNED_AUTOMATION_COMPLETED"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}})
    };
    let first = futures::stream::once(async move {
        Ok::<_, std::io::Error>(Bytes::from(format!("data: {frame}\n\n")))
    });
    let tail: std::pin::Pin<Box<dyn futures::Stream<Item = Result<Bytes, std::io::Error>> + Send>> =
        if waiting {
            Box::pin(futures::stream::pending())
        } else {
            Box::pin(futures::stream::iter([Ok(Bytes::from("data: [DONE]\n\n"))]))
        };
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(first.chain(tail)))
        .unwrap()
}
async fn settled(engine: &NativeEngine, id: &str) -> AgentSnapshot {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let value = engine
                .call("getSession", json!({"sessionId":id}))
                .await
                .unwrap();
            let snapshot: AgentSnapshot = serde_json::from_value(value).unwrap();
            if !matches!(
                snapshot.status,
                AgentStatus::Running
                    | AgentStatus::WaitingPermission
                    | AgentStatus::WaitingQuestion
            ) {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("owned native run did not settle")
}
async fn receipt(engine: &NativeEngine, id: &str, request: &str) -> String {
    engine
        .call("queryCommand", json!({"sessionId":id,"requestId":request}))
        .await
        .unwrap()["results"][0]["result"]["status"]
        .as_str()
        .unwrap()
        .into()
}
#[tokio::test]
async fn automation_native_receipts_distinguish_success_stop_failure_and_restart() {
    let data = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    struct Server(tokio::task::JoinHandle<()>);
    impl Drop for Server {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _server = Server(tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route("/v1/chat/completions", post(upstream)),
        )
        .await
        .unwrap();
    }));
    let engine = NativeEngine::open(data.path().into()).await.unwrap();
    let catalog = json!({"revision":1,"models":[{"id":"lolicode/owned/fixture","providerId":"lolicode","modelId":"owned/fixture","name":"Fixture","channelName":"Owned","contextLimit":128000}],"defaultModel":"lolicode/owned/fixture","excludedSources":[]});
    engine
        .bind(
            project.path().into(),
            catalog,
            NativeGateway {
                base_url: format!("http://{address}/v1"),
                bearer_token: "owned-loopback-only".into(),
            },
        )
        .await
        .unwrap();
    let mut success_id = String::new();
    for (text, expected) in [
        ("OWNED_SUCCESS", "succeeded"),
        ("OWNED_WAIT", "stopped"),
        ("OWNED_FAIL", "failed"),
    ] {
        let session = engine
            .call(
                "createSession",
                json!({"title":"自动化 · Fixture","mode":"build","permissionMode":"ask"}),
            )
            .await
            .unwrap();
        let id = session["id"].as_str().unwrap();
        let request = format!("automation:{text}");
        engine
            .call(
                "sendMessage",
                json!({"sessionId":id,"requestId":request,"text":text}),
            )
            .await
            .unwrap();
        if text == "OWNED_WAIT" {
            assert_eq!(receipt(&engine, id, &request).await, "accepted");
            engine
                .call("interruptSession", json!({"sessionId":id}))
                .await
                .unwrap();
        }
        let snapshot = settled(&engine, id).await;
        let status = receipt(&engine, id, &request).await;
        let (outcome, _) = terminal_outcome(Some(&status), false, &snapshot);
        assert_eq!(outcome, expected);
        if expected == "succeeded" {
            success_id = id.into();
            engine
                .call(
                    "sendMessage",
                    json!({"sessionId":id,"requestId":request,"text":text}),
                )
                .await
                .unwrap();
            assert_eq!(
                engine
                    .call("getSession", json!({"sessionId":id}))
                    .await
                    .unwrap()["messages"]
                    .as_array()
                    .unwrap()
                    .len(),
                snapshot.messages.len(),
                "Lost-response replay must not create another turn"
            );
        }
    }
    engine.shutdown().await.unwrap();
    let restored = NativeEngine::open(data.path().into()).await.unwrap();
    assert_eq!(
        receipt(&restored, &success_id, "automation:OWNED_SUCCESS").await,
        "completed"
    );
    restored.shutdown().await.unwrap();
    println!("AUTOMATION_NATIVE_ACCEPTANCE_OK: success, cancellation, HTTP failure, durable restart and idempotent resend");
}
