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
const REJECTING_IMAGE_MODEL: &str = "fixture-declared-text-only";
const UPSTREAM_KEY: &str = "owned-loopback-upstream-fixture-key";
const ANSWER: &str = "DESKTOP_NATIVE_BINDING_LOOPBACK_OK · 临时接线";

#[tokio::test]
#[ignore = "requires the pinned Harness runtime prepared with Node.js 24.9+"]
async fn deepseek_harness_routes_an_image_through_the_saved_channel() {
    use super::{
        harness_events::{HarnessEvents, HarnessTurnOutcome},
        harness_gateway::HarnessGateway,
        harness_runtime::HarnessRuntime,
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::{io::Cursor, path::PathBuf};

    let owned = tempfile::tempdir().unwrap();
    let project = owned.path().join("项目 with spaces");
    std::fs::create_dir(&project).unwrap();
    let db = Arc::new(Database::memory().unwrap());
    let mut proxy_config = db.get_proxy_config().await.unwrap();
    proxy_config.listen_port = 0;
    proxy_config.enable_logging = false;
    proxy_config.max_retries = 0;
    db.update_proxy_config(proxy_config).await.unwrap();
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
    let fixture = axum::Router::new()
        .route("/v1/chat/completions", post(upstream))
        .with_state(requests.clone());
    let upstream_task = tokio::spawn(async move { axum::serve(listener, fixture).await.unwrap() });
    let route = format!("{SOURCE}/{MODEL}");
    let source = serde_json::from_value(json!({
        "id": SOURCE, "name": "Owned Harness binding fixture",
        "baseUrl": format!("http://{address}/v1"), "apiKey": UPSTREAM_KEY,
        "authKind": "api_key", "protocol": "openai_chat", "enabled": true,
        "models": [
            {"id": MODEL, "contextLimit": 128000, "outputLimit": 4096, "supportsTools": true},
            {"id": REJECTING_IMAGE_MODEL, "contextLimit": 128000, "outputLimit": 4096,
                "inputModalities": ["text"], "imageInputOverride": false, "supportsTools": true}
        ]
    }))
    .unwrap();
    channel_center::save(
        &db,
        channel_center::ChannelCenterSnapshot {
            channels: vec![source],
            targets: vec![],
            default_model: Some(route.clone()),
            revision: 0,
        },
    )
    .unwrap();

    let result = AssertUnwindSafe(async {
        let session = uuid::Uuid::new_v4();
        let gateway = HarnessGateway::open(&state, &format!("lolicode/{route}"), &format!("lc:{session}"), &[]).await.unwrap();
        let lease_token = gateway.token.clone();
        let base = gateway.profile_patch[0]["config"]["providers"]["lolicode-gateway"]["baseURL"].as_str().unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(client.post(format!("{base}/chat/completions")).json(&json!({"model":MODEL})).send().await.unwrap().status(), 401);
        assert_eq!(client.post(format!("{base}/chat/completions")).bearer_auth(&lease_token).json(&json!({"model":"another-channel"})).send().await.unwrap().status(), 400);
        assert!(requests.lock().unwrap().is_empty());

        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/lolicode-harness-runtime");
        let node = std::env::var_os("LOLICODE_HARNESS_NODE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("node"));
        let home = owned.path().join("private-harness");
        let mut harness = HarnessRuntime::start(&node, &package, &project, &home, gateway).await.unwrap();
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(16, 16, image::Rgb([6, 141, 210])))
            .write_to(&mut png, image::ImageFormat::Png).unwrap();
        let image_data = STANDARD.encode(png.into_inner());
        let expected_url = format!("data:image/png;base64,{image_data}");
        let content = json!([
            {"type": "text", "text": "Return the offline fixture marker for this attached image."},
            {"type": "image", "mimeType": "image/png", "data": image_data}
        ]);
        let mut events = Vec::new();
        let receipt = harness.request("session/prompt", json!({"sessionId": session, "contentBlocks": content}), |event| events.push(event.clone()), |_| None).await.unwrap();
        assert!(receipt["messageId"].as_str().is_some());
        harness.request("session/wait", json!({"sessionId": session}), |event| events.push(event.clone()), |_| None).await.unwrap();
        harness.shutdown().await.unwrap();
        let mut projection = HarnessEvents::new(&session.to_string());
        for event in &events {
            projection.apply(event).unwrap();
        }
        assert_eq!(projection.turn_outcome(&session.to_string(), receipt["messageId"].as_str().unwrap()), Some(&HarnessTurnOutcome::Completed));
        assert!(events.iter().any(|event| event["method"] == "session.event" && event["params"]["event"]["type"] == "assistant/message" && event.to_string().contains(ANSWER)), "Harness did not persist the fixture answer");
        let session_id = format!("lc:{session}");
        let restored_gateway = HarnessGateway::open(&state, &format!("lolicode/{route}"), &session_id, &[]).await.unwrap();
        let restored_token = restored_gateway.token.clone();
        let mut restored = HarnessRuntime::start(&node, &package, &project, &home, restored_gateway).await.unwrap();
        restored.request("session/resume", json!({"sessionId": session}), |_| {}, |_| None).await.unwrap();
        restored.request("session/prompt", json!({"sessionId": session, "contentBlocks": [{"type": "text", "text": "Continue the same session."}]}), |_| {}, |_| None).await.unwrap();
        restored.request("session/wait", json!({"sessionId": session}), |_| {}, |_| None).await.unwrap();
        restored.shutdown().await.unwrap();
        let rejected_session = uuid::Uuid::new_v4();
        let rejected_route = format!("lolicode/{SOURCE}/{REJECTING_IMAGE_MODEL}");
        let gateway = HarnessGateway::open(&state, &rejected_route, &format!("lc:{rejected_session}"), &[]).await.unwrap();
        let rejected_home = owned.path().join("rejected-harness");
        let mut rejected = HarnessRuntime::start(&node, &package, &project, &rejected_home, gateway).await.unwrap();
        let mut rejected_events = Vec::new();
        let receipt = rejected.request("session/prompt", json!({"sessionId": rejected_session, "contentBlocks": content}), |event| rejected_events.push(event.clone()), |_| None).await.unwrap();
        rejected.request("session/wait", json!({"sessionId": rejected_session}), |event| rejected_events.push(event.clone()), |_| None).await.unwrap();
        rejected.shutdown().await.unwrap();
        let mut projection = HarnessEvents::new(&rejected_session.to_string());
        for event in &rejected_events {
            projection.apply(event).unwrap();
        }
        assert_eq!(projection.turn_outcome(&rejected_session.to_string(), receipt["messageId"].as_str().unwrap()), Some(&HarnessTurnOutcome::Ended("error".into())));

        let other_client = channel_center::prepare_tavern_binding(&state).await.unwrap();
        let response = client
            .post(format!("{}/chat/completions", other_client.base_url))
            .bearer_auth(&other_client.bearer_token)
            .json(&json!({
                "model": format!("{SOURCE}/{REJECTING_IMAGE_MODEL}"),
                "messages": [{"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": expected_url}}
                ]}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        assert!(response.text().await.unwrap().contains("This fixture only accepts text"));

        let captured = requests.lock().unwrap();
        let carries_attachment = |request: &Captured| {
            request.body["messages"].as_array().unwrap().iter().any(|message| {
                message["content"].as_array().is_some_and(|blocks| blocks.iter().any(|block| {
                    block["type"] == "image_url" && block["image_url"]["url"] == expected_url
                }))
            })
        };
        let request = captured.iter().find(|request| request.body["model"] == MODEL && carries_attachment(request))
            .expect("undeclared model must receive the original attachment");
        let rejected_requests: Vec<_> = captured.iter().filter(|request| request.body["model"] == REJECTING_IMAGE_MODEL).collect();
        assert!(!rejected_requests.is_empty(), "declared-text model must receive an upstream request");
        assert!(rejected_requests.into_iter().all(carries_attachment), "never retry the rejected model without its attached image");
        let continuation = captured.iter().find(|request| request.body["messages"].to_string().contains("Continue the same session.")).expect("restored session must reach the channel");
        assert!(continuation.body["messages"].to_string().contains(ANSWER), "the restored model context must contain its previous answer");
        assert_eq!(request.body["model"], MODEL);
        assert_eq!(request.headers.get("authorization").unwrap().to_str().unwrap(), format!("Bearer {UPSTREAM_KEY}"));
        assert!(!request.body.to_string().contains(&lease_token));
        assert!(request.headers.values().all(|header| !header.to_str().unwrap_or_default().contains(&lease_token)));
        assert_private_files_contain_no_credentials(&home, &lease_token);
        assert_private_files_contain_no_credentials(&home, &restored_token);
    }).catch_unwind().await;
    state.proxy_service.stop().await.unwrap();
    upstream_task.abort();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

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
    let rejects_image = body["model"] == REJECTING_IMAGE_MODEL;
    requests.lock().unwrap().push(Captured { headers, body });
    if rejects_image {
        return Response::builder()
            .status(400)
            .header("content-type", "application/json")
            .body(Body::from(r#"{"error":{"message":"This fixture only accepts text","code":"unsupported_image"}}"#))
            .unwrap();
    }
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
        assert!(prepared.base_url.ends_with("/tai/catalogs/1/clients/lolicode/v1"), "Native requests must use the attributed LoliCode route");
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
