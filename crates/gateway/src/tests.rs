use crate::{
    credentials::{memory::MemoryCredentials, Credentials, SystemCredentials},
    *,
};
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

const KEY: &str = "fixture-upstream-secret-ONLY-FOR-TEST";
const PROMPT: &str = "fixture-private-prompt-ONLY-FOR-TEST";

struct Harness {
    dir: TempDir,
    store: Arc<Store>,
    gateway: GatewayHandle,
    mock: tokio::task::JoinHandle<()>,
    channel: Channel,
    calls: Arc<AtomicUsize>,
}
impl Harness {
    async fn new(kind: &'static str) -> Self {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let mock=Router::new().route("/v1/chat/completions",post(move |headers:HeaderMap,Json(body):Json<Value>| {
            let counted=counted.clone();
            async move {
                counted.fetch_add(1,Ordering::SeqCst);
                assert_eq!(headers.get("authorization").unwrap(),format!("Bearer {KEY}").as_str());
                assert_eq!(body["model"],if kind=="multi" {"paid-model"} else {"test-model"});
                if let Some(code)=kind.strip_prefix("status-") {
                    return (StatusCode::from_u16(code.parse().unwrap()).unwrap(),Json(json!({"error":{"message":format!("{KEY} {PROMPT}")}}))).into_response();
                }
                if kind=="redirect" {
                    return (StatusCode::TEMPORARY_REDIRECT,[("location","http://127.0.0.1:1/steal")]).into_response();
                }
                if body["stream"]==true {
                    assert_eq!(body["stream_options"]["include_usage"],true);
                    let data=match kind {
                        "initial-error"=>format!("data: {}\n\n",json!({"error":{"message":KEY}})),
                        "mid-error"=>format!("data: {}\n\ndata: {}\n\n",json!({"choices":[{"delta":{"content":"hello"}}]}),json!({"error":{"message":KEY}})),
                        "incomplete"=>format!("data: {}\n\n",json!({"choices":[{"delta":{"content":"hello"}}]})),
                        "cancel"=>format!("data: {}\n\n",json!({"choices":[{"delta":{"content":"hello"}}]})),
                        "usage"=>format!("data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":100,"completion_tokens":10}}),json!({"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40}}}),json!({"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40}}})),
                        _=>format!(": ping\r\n\r\ndata: {}\r\n\r\ndata: {}\n\ndata: [DONE]\n\n",json!({"id":"test","choices":[{"delta":{"content":"你好"}}]}),json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]})),
                    };
                    let events=async_stream::stream! {
                        for byte in data.as_bytes() { yield Ok::<Bytes,std::io::Error>(Bytes::copy_from_slice(&[*byte])); tokio::task::yield_now().await; }
                        if kind=="cancel" { tokio::time::sleep(Duration::from_secs(30)).await; }
                    };
                    return ([("content-type","text/event-stream")],Body::from_stream(events)).into_response();
                }
                Json(json!({"id":"test","object":"chat.completion","model":"test-model","choices":[{"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})).into_response()
            }
        })).route("/v1/models",axum::routing::get(||async {Json(json!({"data":[{"id":"test-model"},{"id":"paid-model"}]}))}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), Arc::new(MemoryCredentials::default())).unwrap();
        let channel = store.test_channel(format!("http://127.0.0.1:{port}/v1"), KEY);
        let gateway = Gateway::new(store.clone(), CancellationToken::new())
            .unwrap()
            .start(0)
            .await
            .unwrap();
        Self {
            dir,
            store,
            gateway,
            mock: task,
            channel,
            calls,
        }
    }
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.gateway.port)
    }
    fn client_request(&self, stream: bool) -> reqwest::RequestBuilder {
        reqwest::Client::new().post(self.url("/v1/chat/completions")).bearer_auth(self.store.local_token().unwrap().as_str())
            .json(&json!({"model":self.channel.public_model(),"messages":[{"role":"user","content":PROMPT}],"stream":stream}))
    }
    fn assert_private(&self) {
        for entry in std::fs::read_dir(self.dir.path()).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            for secret in [KEY, PROMPT] {
                assert!(
                    !bytes.windows(secret.len()).any(|w| w == secret.as_bytes()),
                    "Sensitive fixture reached disk"
                );
            }
        }
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.gateway.cancel();
        self.mock.abort();
    }
}

#[tokio::test]
async fn authentication_and_origin_rejected_before_upstream() {
    let h = Harness::new("ok").await;
    let client = reqwest::Client::new();
    for path in ["/v1/models", "/v1/chat/completions"] {
        let response = if path.ends_with("models") {
            client.get(h.url(path)).send().await.unwrap()
        } else {
            client.post(h.url(path)).body("bad").send().await.unwrap()
        };
        assert_eq!(response.status(), 401);
    }
    assert_eq!(
        h.client_request(false)
            .header("origin", "https://evil.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    let models: Value = client
        .get(h.url("/v1/models"))
        .bearer_auth(h.store.local_token().unwrap().as_str())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["data"][0]["id"], h.channel.public_model());
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn nonstream_routes_actual_model_and_persists_only_metadata() {
    let h = Harness::new("ok").await;
    let response = h.client_request(false).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["choices"][0]["message"]["content"], "OK");
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    assert_eq!(h.store.logs().unwrap()[0].result, "completed");
    h.assert_private();
}

#[tokio::test]
async fn stream_preserves_fragmented_utf8_tools_and_done() {
    let h = Harness::new("ok").await;
    let response = h.client_request(true).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let text = response.text().await.unwrap();
    assert!(text.contains("你好"));
    assert!(text.contains("tool_calls"));
    assert!(text.ends_with("data: [DONE]\n\n"));
    assert!(!text.contains("ping"));
    assert_eq!(h.store.logs().unwrap()[0].result, "completed");
    h.assert_private();
}

#[tokio::test]
async fn stream_usage_is_cumulative_and_missing_usage_remains_unknown() {
    let h = Harness::new("usage").await;
    h.client_request(true)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let log = &h.store.logs().unwrap()[0];
    assert_eq!(log.input_tokens, Some(60));
    assert_eq!(log.output_tokens, Some(20));
    assert_eq!(log.cache_read_tokens, Some(40));
    assert!(log.is_streaming);
    assert_eq!(h.store.usage_summary().unwrap().output_tokens, 20);
    let h = Harness::new("ok").await;
    h.client_request(true)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(h.store.logs().unwrap()[0].input_tokens, None);
}

#[tokio::test]
async fn paid_secondary_model_routes_and_discovery_does_not_enable_models() {
    let h = Harness::new("multi").await;
    let gateway = Gateway::new(h.store.clone(), CancellationToken::new()).unwrap();
    let candidates = gateway.discover_models(&h.channel.id).await.unwrap();
    assert_eq!(candidates, vec!["paid-model", "test-model"]);
    assert_eq!(h.store.channels().unwrap()[0].models.len(), 1);
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    h.store
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE channels SET confirmed_free=0 WHERE id=?1",
            [&h.channel.id],
        )
        .unwrap();
    h.store
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE channel_models SET models=?1 WHERE channel_id=?2",
            rusqlite::params!["[\"test-model\",\"paid-model\"]", h.channel.id],
        )
        .unwrap();
    let response=reqwest::Client::new().post(h.url("/v1/chat/completions")).bearer_auth(h.store.local_token().unwrap().as_str()).json(&json!({"model":format!("{}/paid-model",h.channel.id),"messages":[{"role":"user","content":PROMPT}]})).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(h.store.logs().unwrap()[0].model, "paid-model");
    assert_eq!(h.store.logs().unwrap()[0].billing_status, "unpriced");
    let models: Value = reqwest::Client::new()
        .get(h.url("/v1/models"))
        .bearer_auth(h.store.local_token().unwrap().as_str())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["data"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn raw_upstream_errors_are_never_exposed_or_persisted() {
    for kind in ["status-401", "status-429", "status-500", "redirect"] {
        let h = Harness::new(kind).await;
        let response = h.client_request(false).send().await.unwrap();
        assert!(!response.status().is_success());
        let text = response.text().await.unwrap();
        assert!(!text.contains(KEY));
        assert!(!text.contains(PROMPT));
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        h.assert_private();
    }
}

#[tokio::test]
async fn error_before_first_stream_event_is_not_committed_as_success() {
    let h = Harness::new("initial-error").await;
    let response = h.client_request(true).send().await.unwrap();
    assert_eq!(response.status(), 502);
    assert!(!response.text().await.unwrap().contains(KEY));
    h.assert_private();
}

#[tokio::test]
async fn midstream_failure_and_truncation_never_replay_request() {
    for kind in ["mid-error", "incomplete"] {
        let h = Harness::new(kind).await;
        let response = h.client_request(true).send().await.unwrap();
        assert_eq!(response.status(), 200);
        let mut stream = response.bytes_stream();
        let mut collected = Vec::new();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => collected.extend_from_slice(&bytes),
                Err(_) => break,
            }
        }
        let text = String::from_utf8_lossy(&collected);
        assert!(!text.contains(KEY));
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        assert_ne!(h.store.logs().unwrap()[0].result, "completed");
        h.assert_private();
    }
}

#[tokio::test]
async fn dropping_client_stream_releases_upstream_and_records_cancellation() {
    let h = Harness::new("cancel").await;
    let mut stream = h.client_request(true).send().await.unwrap().bytes_stream();
    stream.next().await.unwrap().unwrap();
    drop(stream);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if !h.store.logs().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Cancelled response stayed alive");
    assert_eq!(h.store.logs().unwrap()[0].result, "cancelled");
}

#[tokio::test]
async fn gateway_reports_port_conflict_and_stops_active_stream() {
    let h = Harness::new("cancel").await;
    let g = Gateway::new(h.store.clone(), CancellationToken::new()).unwrap();
    assert!(g.start(h.gateway.port).await.is_err());
    let mut stream = h.client_request(true).send().await.unwrap().bytes_stream();
    stream.next().await.unwrap().unwrap();
    h.gateway.cancel();
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(piece) = stream.next().await {
            if piece.is_err() {
                break;
            }
        }
    })
    .await
    .expect("Shutdown did not cancel stream");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(reqwest::Client::new()
        .get(h.url("/health"))
        .send()
        .await
        .is_err());
}

#[test]
fn config_allows_paid_models_and_rejects_unsafe_urls() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path(), Arc::new(MemoryCredentials::default())).unwrap();
    for url in [
        "http://example.com/v1",
        "https://user:secret@example.com/v1",
        "https://example.com/v1?key=secret",
        "https://example.com/v1#secret",
    ] {
        assert!(store
            .save_channel(SaveChannel {
                id: None,
                name: "test".into(),
                provider_id: "test".into(),
                base_url: url.into(),
                model: "test-model".into(),
                models: vec![],
                enabled: true,
                confirmed_free: true,
                api_key: Some(KEY.into())
            })
            .is_err());
    }
    assert!(store
        .save_channel(SaveChannel {
            id: None,
            name: "test".into(),
            provider_id: "test".into(),
            base_url: "https://example.com/v1".into(),
            model: "test-model".into(),
            models: vec!["test-model".into(), "paid-model".into()],
            enabled: true,
            confirmed_free: false,
            api_key: Some(KEY.into())
        })
        .is_ok());
    assert_eq!(store.channels().unwrap()[0].models.len(), 2);
}

#[test]
fn credentials_survive_restart_rotation_and_channel_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let creds = Arc::new(MemoryCredentials::default());
    let store = Store::open(dir.path(), creds.clone()).unwrap();
    let c = store.test_channel("http://127.0.0.1:1/v1".into(), KEY);
    let original = store.local_token().unwrap();
    drop(store);
    let store = Store::open(dir.path(), creds.clone()).unwrap();
    assert!(store.authenticate(&original));
    assert_eq!(store.key(&c).unwrap().as_str(), KEY);
    store.rotate_token().unwrap();
    assert!(!store.authenticate(&original));
    assert!(store.authenticate(&store.local_token().unwrap()));
    store.delete_channel(&c.id).unwrap();
    assert!(creds.get(&c.credential_id()).unwrap().is_none());
    assert!(store.channels().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn windows_system_credentials_roundtrip_and_cleanup() {
    let credentials = SystemCredentials::default();
    let id = format!("acceptance-fixture-{}", uuid::Uuid::new_v4());
    credentials.set(&id, KEY).unwrap();
    let value = credentials.get(&id).unwrap().unwrap();
    let valid = value.as_str() == KEY;
    credentials.delete(&id).unwrap();
    assert!(valid, "Windows credential roundtrip failed");
    assert!(credentials.get(&id).unwrap().is_none());
}
