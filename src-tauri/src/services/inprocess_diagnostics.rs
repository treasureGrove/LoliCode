//! An opt-in check inside the actual application executable. This path runs
//! before desktop initialization and uses only owned temporary files and a
//! loopback fake model; it never opens user settings or starts an engine.
use super::inprocess_extensions::InprocessExtensionStore;
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use lolicode_agent::native::{NativeEngine, NativeGateway};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Clone)]
struct Fixture {
    token: String,
    requests: Arc<AtomicUsize>,
}
async fn model(
    State(fixture): State<Fixture>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if headers.get("authorization").and_then(|v| v.to_str().ok())
        != Some(format!("Bearer {}", fixture.token).as_str())
        || body["model"] != "native/check-route"
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"fixture authentication mismatch"})),
        );
    }
    let index = fixture.requests.fetch_add(1, Ordering::SeqCst);
    let choice = match index {
        0 => {
            json!({"message":{"role":"assistant","tool_calls":[{"id":"diagnostic-read","type":"function","function":{"name":"read_file","arguments":json!({"path":"input.txt"}).to_string()}}]},"finish_reason":"tool_calls"})
        }
        1 if body["messages"].as_array().is_some_and(|items| {
            items.iter().any(|m| {
                m["role"] == "tool"
                    && m["tool_call_id"] == "diagnostic-read"
                    && m["content"]
                        .as_str()
                        .is_some_and(|s| s.contains("NATIVE_INPUT_MARKER"))
            })
        }) =>
        {
            json!({"message":{"role":"assistant","tool_calls":[{"id":"diagnostic-write","type":"function","function":{"name":"write_file","arguments":json!({"path":"output.txt","content":"NATIVE_OUTPUT_MARKER\n","expected_content":null}).to_string()}}]},"finish_reason":"tool_calls"})
        }
        2 if body["messages"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|m| m["role"] == "tool" && m["tool_call_id"] == "diagnostic-write")
        }) =>
        {
            json!({"message":{"role":"assistant","content":"LOLICODE_IN_PROCESS_CHECK_OK"},"finish_reason":"stop"})
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"fixture continuation mismatch"})),
            )
        }
    };
    (
        StatusCode::OK,
        Json(json!({"id":"native-check","object":"chat.completion","choices":[choice]})),
    )
}

fn assets() -> Result<PathBuf, String> {
    let installed = std::env::current_exe()
        .map_err(|_| "无法定位主程序")?
        .parent()
        .ok_or("主程序路径无效")?
        .join("agent/extensions");
    if installed.join("manifest.json").is_file() {
        return Ok(installed);
    }
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent/extensions");
        if dev.join("manifest.json").is_file() {
            return Ok(dev);
        }
    }
    Err("主程序旁缺少默认技能资源".into())
}

async fn check() -> Result<Value, String> {
    let temporary = tempfile::Builder::new()
        .prefix("LoliCode 本体自检 ")
        .tempdir()
        .map_err(|_| "无法创建临时自检目录")?;
    let project = temporary.path().join("项目 with spaces");
    tokio::fs::create_dir_all(&project)
        .await
        .map_err(|_| "无法创建自检项目")?;
    tokio::fs::write(project.join("input.txt"), "NATIVE_INPUT_MARKER\n")
        .await
        .map_err(|_| "无法创建自检夹具")?;
    let private = temporary.path().join("private");
    let extension_store =
        InprocessExtensionStore::new(temporary.path().join("extensions"), assets()?)
            .map_err(|_| "无法读取默认技能资源")?;
    let skills = extension_store
        .prepare_skills()
        .map_err(|_| "默认技能校验失败")?;
    if skills.verified_skills.len() != 5 || !skills.omitted.is_empty() {
        return Err("默认技能数量或完整性不正确".into());
    }
    let token = format!("diagnostic-{}", uuid::Uuid::new_v4());
    let requests = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "无法创建本机自检服务")?;
    let port = listener
        .local_addr()
        .map_err(|_| "无法读取自检地址")?
        .port();
    let app = Router::new()
        .route("/v1/chat/completions", post(model))
        .with_state(Fixture {
            token: token.clone(),
            requests: requests.clone(),
        });
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let engine = NativeEngine::open(private.clone()).await?;
    let result=async {
        engine.bind(project.clone(),json!({"revision":1,"models":[{"id":"lolicode/native/check-route","providerId":"lolicode","modelId":"native/check-route","name":"Local diagnostic","channelName":"Local fixture","contextLimit":131072}],"defaultModel":"lolicode/native/check-route","excludedSources":[]}),NativeGateway{base_url:format!("http://127.0.0.1:{port}/v1"),bearer_token:token.clone()}).await?;
        engine.call("configureSkills",skills.configure_payload()).await?;
        let session=engine.call("createSession",json!({"modelId":"lolicode/native/check-route","mode":"build","permissionMode":"auto","title":"Isolated executable check"})).await?;
        let id=session["id"].as_str().ok_or("自检会话无效")?.to_string();
        let request=uuid::Uuid::new_v4().to_string();
        engine.call("sendMessage",json!({"sessionId":id,"requestId":request,"text":"Read input.txt and write output.txt in this temporary project."})).await?;
        let end=tokio::time::Instant::now()+Duration::from_secs(30);
        let snapshot=loop {
            let current=engine.call("getSession",json!({"sessionId":id})).await?;
            if !matches!(current["status"].as_str(),Some("running"|"waiting_permission"|"waiting_question")){break current;}
            if tokio::time::Instant::now()>end{return Err("本体自检任务未完成".to_string());}
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        if snapshot["status"]!="idle" || !snapshot["messages"].to_string().contains("LOLICODE_IN_PROCESS_CHECK_OK") {return Err("本体工具往返未通过".into());}
        if tokio::fs::read_to_string(project.join("output.txt")).await.map_err(|_|"自检输出未生成")?!="NATIVE_OUTPUT_MARKER\n" {return Err("本体写文件结果不正确".into());}
        if requests.load(Ordering::SeqCst)!=3{return Err("模型往返次数不正确".into());}
        let activity=engine.call("activity",json!({})).await?;
        if activity["inProcess"]!=true{return Err("执行模式不是本体".into());}
        engine.shutdown().await?;
        let resumed=NativeEngine::open(private.clone()).await?;
        let restored=resumed.call("getSession",json!({"sessionId":id})).await?;
        resumed.shutdown().await?;
        if restored["messages"]!=snapshot["messages"]{return Err("本体会话恢复不一致".into());}
        let record=private.join("sessions").join(format!("{}.json",id.trim_start_matches("lc:")));
        if tokio::fs::read_to_string(record).await.map_err(|_|"无法核对持久化")?.contains(&token){return Err("运行凭据不应持久化".into());}
        Ok(json!({"product":"LoliCode","version":env!("CARGO_PKG_VERSION"),"engine":"rust-in-process","passed":true,"nativeEngineProcessSpawned":false,"defaultSkillsVerified":skills.verified_skills.len(),"modelRequests":3,"paidCalls":0,"realReadWriteAndContinuation":true,"sessionRestartVerified":true,"gatewayCredentialPersisted":false,"userConfigurationRead":false,"temporaryProjectsOnly":true}))
    }.await;
    let _ = engine.shutdown().await;
    server.abort();
    let _ = server.await;
    result
}

/// Called before any desktop initialization only for --check-agent-runtime.
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
                json!({"product":"LoliCode","engine":"rust-in-process","passed":false,"error":error,"paidCalls":0,"userConfigurationRead":false})
            );
            1
        }
    }
}
