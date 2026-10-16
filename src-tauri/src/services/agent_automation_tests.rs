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
