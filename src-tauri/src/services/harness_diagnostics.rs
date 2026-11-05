//! Offline check of the actual bundled runtime before desktop initialization.
use super::{
    channel_center,
    harness_gateway::HarnessGateway,
    harness_paths::HarnessPaths,
    harness_runtime::{HarnessEvent, HarnessRuntime},
    inprocess_extensions::InprocessExtensionStore,
    ProxyService, UsageCache,
};
use crate::{
    database::Database, proxy::providers::codex_oauth_auth::CodexOAuthManager, store::AppState,
};
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

const MODEL: &str = "harness-check-model";
const MODEL_KEY: &str = "offline-diagnostic-fixture-key";
const INPUT: &str = "HARNESS_DIAGNOSTIC_INPUT";
const OUTPUT: &str = "HARNESS_DIAGNOSTIC_OUTPUT";
const FIRST: &str = "HARNESS_DIAGNOSTIC_FIRST";
const RESTORED: &str = "HARNESS_DIAGNOSTIC_RESTORED";

async fn model(
    State(requests): State<Arc<AtomicUsize>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some("Bearer offline-diagnostic-fixture-key")
        || body["model"] != MODEL
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let messages = body["messages"].to_string();
    let invoke = |name, id, arguments: Value| {
        json!({"tool_calls":[{
            "index":0,"id":id,"type":"function","function":{"name":name,"arguments":arguments.to_string()}
        }]})
    };
    let (delta, reason) = match requests.fetch_add(1, Ordering::SeqCst) {
        0 => (
            invoke("read", "call_read", json!({"file_path":"input.txt"})),
            "tool_calls",
        ),
        1 if messages.contains(INPUT) => (
            invoke(
                "write",
                "call_write",
                json!({"file_path":"output.txt","content":OUTPUT}),
            ),
            "tool_calls",
        ),
        2 if messages.contains("call_write") => (json!({"content":FIRST}), "stop"),
        3 if messages.contains(FIRST) => (json!({"content":RESTORED}), "stop"),
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    let chunk = |delta: Value, reason: Value| {
        json!({
            "id":"check", "model":MODEL, "object":"chat.completion.chunk","created":1,
            "choices":[{"index":0,"delta":delta,"finish_reason":reason}]
        })
    };
    let response = [
        chunk(json!({"role":"assistant"}), Value::Null),
        chunk(delta, Value::Null),
        chunk(json!({}), json!(reason)),
    ]
    .iter()
    .map(|value| format!("data: {value}\n\n"))
    .collect::<String>()
        + "data: [DONE]\n\n";
    ([(header::CONTENT_TYPE, "text/event-stream")], response).into_response()
}

fn resource_root() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| "无法定位主程序")?;
    let dir = exe.parent().ok_or("主程序路径无效")?;
    #[cfg(target_os = "macos")]
    let dir = dir.join("../Resources");
    if dir
        .join("agent/harness-runtime/runtime-manifest.json")
        .is_file()
    {
        return Ok(dir.to_owned());
    }
    #[cfg(debug_assertions)]
    if crate::channel::is_development() {
        return Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"));
    }
    Err("内置 Harness 运行包缺失".into())
}

async fn do_turn(
    paths: &HarnessPaths,
    state: &AppState,
    project: &Path,
    home: &Path,
    session: &str,
    restore: bool,
) -> Result<String, String> {
    let gateway = HarnessGateway::open(
        state,
        &format!("lolicode/fixture/{MODEL}"),
        &format!("lc:{session}"),
        &[],
    )
    .await?;
    let token = gateway.token.clone();
    let (runner, mut events) =
        HarnessRuntime::start_live(&paths.node, &paths.package, project, home, gateway).await?;
    let result: Result<(), String> = async {
        if restore {
            runner.request("session/resume", json!({"sessionId":session})).await?;
        }
        let mut answer = false;
        let mut observe = |event: &Value| {
            let data = &event["params"]["event"];
            if event["method"] == "session.event" && data["type"] == "assistant/message" {
                answer |= data["data"].to_string().contains(if restore { RESTORED } else { FIRST });
            }
        };
        runner.request("session/prompt", json!({
            "sessionId":session,"contentBlocks":[{"type":"text","text": if restore { "Continue the previous check." } else { "Read input.txt and write output.txt." }}]
        })).await?;
        tokio::time::timeout(Duration::from_secs(40), async {
            let wait = runner.request("session/wait", json!({"sessionId":session}));
            tokio::pin!(wait);
            loop {
                tokio::select! {
                    result = &mut wait => { result?; break; },
                    event = events.recv() => match event {
                        Some(HarnessEvent::Notification(event)) => observe(&event),
                        Some(HarnessEvent::Request(request)) => request.respond(None).await?,
                        None => return Err("Harness 自检事件连接断开".to_owned()),
                    },
                }
            }
            while let Ok(event) = events.try_recv() {
                if let HarnessEvent::Notification(event) = event { observe(&event); }
            }
            Ok(())
        }).await.map_err(|_| "Harness 自检任务超时")??;
        if !answer { return Err("Harness 自检未收到模型结果".into()); }
        Ok(())
    }.await;
    let shutdown = runner.shutdown().await;
    result?;
    shutdown?;
    Ok(token)
}

fn contains_secret(root: &Path, secrets: &[&str]) -> Result<bool, String> {
    let files = std::fs::read_dir(root).map_err(|_| "无法核对 Harness 持久化")?;
    for entry in files {
        let entry = entry.map_err(|_| "无法核对 Harness 持久化")?;
        let kind = entry.file_type().map_err(|_| "无法核对 Harness 持久化")?;
        if kind.is_dir() && contains_secret(&entry.path(), secrets)? {
            return Ok(true);
        }
        if kind.is_file() {
            let bytes = std::fs::read(entry.path()).map_err(|_| "无法核对 Harness 持久化")?;
            if secrets.iter().any(|secret| {
                bytes
                    .windows(secret.len())
                    .any(|bytes| bytes == secret.as_bytes())
            }) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

async fn check() -> Result<Value, String> {
    let resources = resource_root()?;
    let paths = HarnessPaths::from_resource_dir(&resources)?;
    let temporary = tempfile::Builder::new()
        .prefix("LoliCode Harness 自检 ")
        .tempdir()
        .map_err(|_| "无法创建临时自检目录")?;
    let project = temporary.path().join("项目 with spaces");
    std::fs::create_dir(&project).map_err(|_| "无法创建临时项目")?;
    std::fs::write(project.join("input.txt"), INPUT).map_err(|_| "无法写入临时项目")?;
    let skills = InprocessExtensionStore::new(
        temporary.path().join("extensions"),
        resources.join("agent/extensions"),
    )
    .map_err(|_| "无法读取默认技能资源")?
    .prepare_skills()
    .map_err(|_| "默认技能校验失败")?;
    if skills.verified_skills.len() != 5 || !skills.omitted.is_empty() {
        return Err("默认技能资源不完整".into());
    }
    let db = Arc::new(Database::memory().map_err(|_| "无法创建临时渠道配置")?);
    let mut config = db
        .get_proxy_config()
        .await
        .map_err(|_| "无法读取临时渠道配置")?;
    config.listen_port = 0;
    config.enable_logging = false;
    config.max_retries = 0;
    db.update_proxy_config(config)
        .await
        .map_err(|_| "无法保存临时渠道配置")?;
    let state = AppState {
        db: db.clone(),
        proxy_service: ProxyService::new(db.clone()),
        usage_cache: Arc::new(UsageCache::new()),
        codex_oauth_manager: Arc::new(CodexOAuthManager::new(temporary.path().join("oauth"))),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "无法启动临时模型")?;
    let address = listener.local_addr().map_err(|_| "无法读取临时模型地址")?;
    let requests = Arc::new(AtomicUsize::new(0));
    let fixture = Router::new()
        .route("/v1/chat/completions", post(model))
        .with_state(requests.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, fixture).await;
    });
    let result = async {
        let source = serde_json::from_value(json!({
            "id":"fixture","name":"Offline check","baseUrl":format!("http://{address}/v1"),"apiKey":MODEL_KEY,"authKind":"api_key","protocol":"openai_chat",
            "models":[{"id":MODEL,"inputModalities":["text"],"contextLimit":65536,"outputLimit":4096,"supportsTools":true}]
        })).map_err(|_| "临时模型配置无效")?;
        channel_center::save(&db, channel_center::ChannelCenterSnapshot {
            channels: vec![source], targets: vec![], default_model: Some(format!("fixture/{MODEL}")), revision: 0,
        }).map_err(|_| "无法保存临时渠道")?;
        let session = uuid::Uuid::new_v4().to_string();
        let home = temporary.path().join("harness");
        let first = do_turn(&paths, &state, &project, &home, &session, false).await?;
        let second = do_turn(&paths, &state, &project, &home, &session, true).await?;
        if std::fs::read_to_string(project.join("output.txt")).ok().as_deref() != Some(OUTPUT)
            || requests.load(Ordering::SeqCst) != 4
        { return Err("Harness 工具往返或恢复结果不符".into()); }
        if contains_secret(&home, &[MODEL_KEY, &first, &second])? { return Err("运行凭据不应持久化".into()); }
        Ok(json!({"product":"LoliCode","version":env!("CARGO_PKG_VERSION"),"engine":"deepseek-harness",
            "passed":true,"nativeEngineProcessSpawned":true,"defaultSkillsVerified":5,"modelRequests":4,
            "paidCalls":0,"realReadWriteAndContinuation":true,"sessionRestartVerified":true,"gatewayCredentialPersisted":false,
            "userConfigurationRead":false,"temporaryProjectsOnly":true}))
    }.await;
    let _ = state.proxy_service.stop().await;
    server.abort();
    result
}

pub fn run() -> i32 {
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|_| "runtime initialization failed".to_string())
        .and_then(|runtime| runtime.block_on(check()));
    match result {
        Ok(proof) => {
            println!("{proof}");
            0
        }
        Err(error) => {
            println!(
                "{}",
                json!({"product":"LoliCode","engine":"deepseek-harness","passed":false,"error":error,
                "paidCalls":0,"userConfigurationRead":false})
            );
            1
        }
    }
}
