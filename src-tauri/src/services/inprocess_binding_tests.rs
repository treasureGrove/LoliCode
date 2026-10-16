//! Desktop binding integration: memory DB -> production gateway -> native core.
//! All directories, credentials and HTTP endpoints are owned offline fixtures.
use super::{agent_host, channel_center, ProxyService, UsageCache};
use crate::{
    database::Database, proxy::providers::codex_oauth_auth::CodexOAuthManager, store::AppState,
};
use axum::{body::Body, extract::State, http::HeaderMap, response::Response, routing::post, Json};
use bytes::Bytes;
use futures::FutureExt;
use lolicode_agent::native::{NativeEngine, NativeGateway};
use serde_json::{json, Value};
use std::{
    panic::AssertUnwindSafe,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

const SOURCE: &str = "binding-fixture";
const MODEL: &str = "vendor/family/model@2026:fast?profile=owned";
const UPSTREAM_KEY: &str = "owned-loopback-upstream-fixture-key";
const ANSWER: &str = "DESKTOP_NATIVE_BINDING_LOOPBACK_OK · 临时接线";

struct Captured {
    headers: HeaderMap,
    body: Value,
}
type Requests = Arc<Mutex<Vec<Captured>>>;

async fn upstream(
    State(requests): State<Requests>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    requests.lock().unwrap().push(Captured { headers, body });
    let frame = json!({
        "id":"binding-fixture-response","object":"chat.completion.chunk","created":1,"model":MODEL,
        "choices":[{"index":0,"delta":{"role":"assistant","content":ANSWER},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}
    });
    let sse = format!("data: {frame}\n\ndata: [DONE]\n\n");
    // Fragment UTF-8 and event boundaries on the real TCP route, rather than
    // bypassing either the production proxy or inference stream parser.
    let chunks = sse
        .as_bytes()
        .chunks(7)
        .map(|chunk| Ok::<_, std::io::Error>(Bytes::copy_from_slice(chunk)))
        .collect::<Vec<_>>();
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(futures::stream::iter(chunks)))
        .unwrap()
}

fn assert_private_files_contain_no_credentials(root: &Path, gateway_token: &str) {
    for entry in std::fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        assert!(
            !kind.is_symlink(),
            "Private fixture must contain no symlinks"
        );
        if kind.is_dir() {
            assert_private_files_contain_no_credentials(&entry.path(), gateway_token);
        } else {
            let bytes = std::fs::read(entry.path()).unwrap();
            for secret in [gateway_token, UPSTREAM_KEY] {
                assert!(
                    !bytes
                        .windows(secret.len())
                        .any(|window| window == secret.as_bytes()),
                    "A credential reached native session persistence"
                );
            }
        }
    }
}

#[tokio::test]
async fn inprocess_binding_routes_opaque_model_through_real_proxy_without_persisting_credentials() {
    let owned = tempfile::tempdir().unwrap();
    let project = owned.path().join("project");
    let native_root = owned.path().join("private-native");
    std::fs::create_dir(&project).unwrap();
    let db = Arc::new(Database::memory().unwrap());
    let mut proxy_config = db.get_proxy_config().await.unwrap();
    proxy_config.listen_port = 0;
    proxy_config.enable_logging = false;
    proxy_config.max_retries = 0;
    db.update_proxy_config(proxy_config).await.unwrap();
    // Construct explicitly: AppState::new would reference the user's OAuth dir.
    let state = AppState {
        db: db.clone(),
        proxy_service: ProxyService::new(db.clone()),
        usage_cache: Arc::new(UsageCache::new()),
        codex_oauth_manager: Arc::new(CodexOAuthManager::new(owned.path().join("private-oauth"))),
    };
    let requests: Requests = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let router = axum::Router::new()
        .route("/v1/chat/completions", post(upstream))
        .with_state(requests.clone());
    struct UpstreamTask(tokio::task::JoinHandle<()>);
    impl Drop for UpstreamTask {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let upstream_task = UpstreamTask(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let engine = NativeEngine::open(native_root.clone()).await.unwrap();
    // Always stop our listener and native core even when a regression assertion
    // fails, without touching any desktop instance or external configuration.
    let result = AssertUnwindSafe(async {
        let route = format!("{SOURCE}/{MODEL}");
        let full_model = format!("lolicode/{route}");
        let source: channel_center::ChannelSource = serde_json::from_value(json!({
            "id":SOURCE,"name":"Owned desktop binding fixture","baseUrl":format!("http://{address}/v1"),
            "apiKey":UPSTREAM_KEY,"authKind":"api_key","protocol":"openai_chat","enabled":true,
            "models":[{"id":MODEL,"name":"Opaque fixture model","contextLimit":128000,"outputLimit":4096,"supportsTools":true,"enabled":true}]
        })).unwrap();
        channel_center::save(db.as_ref(), channel_center::ChannelCenterSnapshot {
            channels:vec![source],targets:vec![],default_model:Some(route.clone()),revision:0,
        }).unwrap();
        let prepared = agent_host::prepare_native_binding(&state,&[]).await.unwrap();
        assert!(prepared.base_url.ends_with("/tai/catalogs/1/v1"));
        assert!(prepared.base_url.starts_with("http://127.0.0.1:"));
        assert_eq!(prepared.catalog.default_model.as_deref(),Some(full_model.as_str()));
        assert_eq!(prepared.catalog.models.len(),1);
        assert_eq!(prepared.catalog.models[0].model_id,route);
        assert!(db.get_setting("channel_center_applied").unwrap().is_none(),"Agent preparation must not apply another client's profile");
        let private_token = prepared.bearer_token.clone();
        assert!(!private_token.is_empty());
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let denied = client.get(format!("{}/models",prepared.base_url)).send().await.unwrap();
        assert!(!denied.status().is_success(),"The production directory must require local authentication");
        let models = client.get(format!("{}/models",prepared.base_url)).bearer_auth(&private_token).send().await.unwrap().error_for_status().unwrap().json::<Value>().await.unwrap();
        assert_eq!(models["data"][0]["id"],route);
        assert!(requests.lock().unwrap().is_empty(),"Catalog lookup must never generate text");
        let catalog = serde_json::to_value(&prepared.catalog).unwrap();
        engine.bind(project.clone(),catalog,NativeGateway { base_url:prepared.base_url,bearer_token:prepared.bearer_token }).await.unwrap();
        let session = engine.call("createSession",json!({"mode":"build","permissionMode":"auto","modelId":full_model})).await.unwrap();
        let session_id = session["id"].as_str().unwrap().to_string();
        let command = json!({"sessionId":session_id,"requestId":"desktop-binding-owned-request","text":"Return the offline fixture marker."});
        engine.call("sendMessage",command.clone()).await.unwrap();
        let deadline = tokio::time::Instant::now()+Duration::from_secs(20);
        let snapshot = loop {
            let value = engine.call("getSession",json!({"sessionId":session_id})).await.unwrap();
            if value["status"]=="idle" || value["status"]=="error" { break value; }
            assert!(tokio::time::Instant::now()<deadline,"Native turn did not finish");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(snapshot["status"],"idle");
        assert!(snapshot["error"].is_null());
        assert_eq!(snapshot["session"]["model"]["modelId"],route);
        assert!(snapshot["messages"].as_array().unwrap().iter().any(|message| message["role"]=="assistant" && message["parts"].as_array().unwrap().iter().any(|part|part["type"]=="text" && part["text"]==ANSWER)));
        let serialized = snapshot.to_string();
        for secret in [private_token.as_str(),UPSTREAM_KEY] { assert!(!serialized.contains(secret),"A credential reached the IPC snapshot"); }
        assert_private_files_contain_no_credentials(&native_root,&private_token);
        let files = std::fs::read_dir(native_root.join("sessions")).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        assert_eq!(files.len(),1);
        let persisted: Value = serde_json::from_slice(&std::fs::read(files[0].path()).unwrap()).unwrap();
        assert!(persisted.to_string().contains(ANSWER),"The real reply must be durably stored");
        assert_eq!(persisted["snapshot"]["session"]["model"]["modelId"],route);
        engine.call("sendMessage",command).await.unwrap();
        let captured = requests.lock().unwrap();
        // A completed first turn may also generate its title asynchronously.
        // Only inference requests advertise tools; a replay must not start
        // another inference turn or depend on the title request's timing.
        assert_eq!(captured.iter().filter(|request| request.body["tools"].as_array().is_some_and(|tools| !tools.is_empty())).count(),1,"Replay must not call the task model again");
        assert_eq!(captured[0].body["model"],MODEL,"Only the channel namespace may be removed from the opaque model ID");
        assert_eq!(captured[0].body["stream"],true);
        assert!(captured[0].body["tools"].as_array().is_some_and(|tools| tools.iter().any(|tool|tool["function"]["name"]=="read_file")));
        assert!(captured[0].headers.get("authorization").and_then(|value|value.to_str().ok()).is_some_and(|value|value==format!("Bearer {UPSTREAM_KEY}")),"The gateway must replace its local credential with the source credential");
        assert!(!captured[0].body.to_string().contains(&private_token));
        assert!(captured[0].headers.values().all(|value|!value.as_bytes().windows(private_token.len()).any(|window|window==private_token.as_bytes())),"The local bearer must never reach the upstream");
    }).catch_unwind().await;
    let shutdown = engine.shutdown().await;
    let stopped = state.proxy_service.stop().await;
    drop(upstream_task);
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
    assert!(shutdown.is_ok(), "Owned native core cleanup failed");
    assert!(stopped.is_ok(), "Owned proxy cleanup failed");
}
