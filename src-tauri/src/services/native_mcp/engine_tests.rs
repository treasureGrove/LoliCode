//! Full native-engine turn, discovery, approval and MCP transport integration.
//! Both HTTP endpoints are owned loopback fixtures; no user server is read.
use super::*;
use axum::{body::Body, http::Response, routing::post, Json};
use lolicode_agent::{NativeEngine, NativeGateway};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex as StdMutex,
};

fn frame_tool(name: &str, input: Value) -> Value {
    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":format!("owned-call-{name}"),"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":"tool_calls"}]})
}
fn frame_text(text: &str) -> Value {
    json!({"choices":[{"delta":{"content":text},"finish_reason":"stop"}]})
}

async fn snapshot_until(
    engine: &NativeEngine,
    id: &str,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = engine
            .call("getSession", json!({"sessionId":id}))
            .await
            .unwrap();
        if predicate(&snapshot) {
            return snapshot;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "engine did not progress: {snapshot}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn native_engine_discovers_deferred_mcp_then_waits_for_approval_and_uses_real_receipt() {
    let mcp = super::tests::Fake::start(true, false).await;
    let manager = Arc::new(NativeMcpTools::new());
    let project = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let config = mcp.config();
    let server = parse_servers(&config).unwrap().remove("fixture").unwrap();
    let target = tool_name(&server, "read/report");
    manager.configure(1, config).await.unwrap();
    assert!(manager.schemas_for_project(project.path()).is_empty());
    let recorded = Arc::new(StdMutex::new(Vec::<Value>::new()));
    let requests = recorded.clone();
    let turns = Arc::new(AtomicUsize::new(0));
    let turn_count = turns.clone();
    let model_target = target.clone();
    let router = axum::Router::new().route(
        "/v1/chat/completions",
        post(move |Json(input): Json<Value>| {
            let target = model_target.clone();
            let recorded = recorded.clone();
            let turns = turns.clone();
            async move {
                let title = input["messages"][0]["content"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("You generate a short session title"));
                let response = if title {
                    frame_text("MCP permission fixture")
                } else {
                    recorded.lock().unwrap().push(input.clone());
                    match turns.fetch_add(1, Ordering::SeqCst) {
                        0 => {
                            assert!(
                                !input["tools"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .any(|schema| schema["function"]["name"] == target),
                                "MCP full schema must initially be deferred"
                            );
                            frame_tool("tool_search", json!({"query":target,"limit":1}))
                        }
                        1 => {
                            let searched = input["messages"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .rev()
                                .find(|message| message["role"] == "tool")
                                .unwrap();
                            assert!(searched["content"].as_str().unwrap().contains(&target));
                            assert!(input["tools"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|schema| schema["function"]["name"] == target));
                            frame_tool(
                                "deferred_tool_call",
                                json!({"name":target,"input":{"value":"37"}}),
                            )
                        }
                        2 => {
                            let receipt = input["messages"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .rev()
                                .find(|message| message["role"] == "tool")
                                .unwrap()["content"]
                                .as_str()
                                .unwrap();
                            assert!(
                                receipt.contains("value=37"),
                                "model must receive the actual HTTP MCP receipt: {receipt}"
                            );
                            assert!(!receipt.contains("fixture-secret-token"));
                            frame_text("Verified real MCP result: 37")
                        }
                        _ => panic!("native engine unexpectedly replayed the MCP task"),
                    }
                };
                Response::builder()
                    .header("Content-Type", "text/event-stream")
                    .body(Body::from(format!("data: {response}\n\ndata: [DONE]\n\n")))
                    .unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let model_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let model_task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let engine = NativeEngine::open(data.path().to_path_buf()).await.unwrap();
    engine.set_application_tools(manager.clone()).await;
    engine.bind(project.path().to_path_buf(),json!({"revision":1,"models":[{"id":"owned/channel/model","providerId":"owned","modelId":"channel/model","name":"Owned SSE fixture","channelName":"Owned fixture","contextLimit":128000}],"defaultModel":"owned/channel/model","excludedSources":[]}),NativeGateway {base_url:model_url,bearer_token:"owned-model-token".into()}).await.unwrap();
    let session = engine
        .call(
            "createSession",
            json!({"mode":"build","permissionMode":"ask"}),
        )
        .await
        .unwrap();
    let id = session["id"].as_str().unwrap();
    engine.call("sendMessage",json!({"sessionId":id,"requestId":"owned-mcp-roundtrip","text":"Discover the MCP report tool and return 37 after approval."})).await.unwrap();
    let pending = snapshot_until(&engine, id, |snapshot| {
        snapshot["status"] == "waiting_permission"
    })
    .await;
    assert_eq!(
        mcp.calls(),
        0,
        "tool_search and deferred schema loading are not authorization"
    );
    assert_eq!(turn_count.load(Ordering::SeqCst), 2);
    assert_eq!(pending["permissions"][0]["toolName"], target);
    engine
        .call(
            "replyPermission",
            json!({"sessionId":id,"requestId":pending["permissions"][0]["id"],"decision":"once"}),
        )
        .await
        .unwrap();
    let finished = snapshot_until(&engine, id, |snapshot| snapshot["status"] == "idle").await;
    assert_eq!(mcp.calls(), 1);
    assert_eq!(turn_count.load(Ordering::SeqCst), 3);
    assert!(finished
        .to_string()
        .contains("Verified real MCP result: 37"));
    assert!(!finished.to_string().contains("fixture-secret-token"));
    assert_eq!(requests.lock().unwrap().len(), 3);
    engine.shutdown().await.unwrap();
    manager.shutdown().await.unwrap();
    model_task.abort();
}
