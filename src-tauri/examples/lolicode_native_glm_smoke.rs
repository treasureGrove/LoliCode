//! Explicit live acceptance of the actual in-process NativeEngine.
//! Reads the human-authorized GLM managed-channel/account reference read-only;
//! production gateway auth resolves its token in-process. No key is printed,
//! passed as a command argument, or written to a fixture/evidence file.
#[cfg(not(feature = "test-hooks"))]
fn main() {
    eprintln!("requires --features test-hooks");
    std::process::exit(2);
}

#[cfg(feature = "test-hooks")]
mod live {
    use anyhow::{anyhow, ensure, Context, Result};
    use axum::{
        body::Body,
        extract::State,
        http::{HeaderMap, StatusCode},
        response::Response,
        routing::post,
        Json, Router,
    };
    use cc_switch_lib::{
        agent_test_support::{
            channel_center::{self, ChannelCenterSnapshot},
            CodexOAuthManager, UsageCache,
        },
        AppState, Database, ProxyService,
    };
    use lolicode_agent::native::{NativeEngine, NativeGateway};
    use serde_json::{json, Value};
    use std::{
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };

    const MODEL: &str = "glm-5.3-flash";
    const ROUTE: &str = "glm_native_live/glm-5.3-flash";
    const BEFORE: &str = "export function add(a, b) { return a - b; }\n";
    const MEMORY_MARKER: &str = "PINKDOG_MEMORY_47";
    const PROMPT: &str = "In this isolated test project: 1. use view_image to inspect color-check.png and identify the colors of the LEFT and RIGHT large blocks (ignore the bottom strip); include RED_LEFT BLUE_RIGHT in your final answer only if that matches the real image. 2. read sum.js, fix add(2,3) returning -1 so addition works; make the smallest edit to sum.js only. Do not run shell commands, access network, write memories, or read outside this project. Report the correction in Chinese in under 100 words. Use real tools rather than describing proposed changes.";

    #[derive(Clone)]
    struct BudgetRelay {
        client: reqwest::Client,
        endpoint: String,
        token: String,
        calls: Arc<AtomicUsize>,
        max_calls: usize,
        offline: Arc<AtomicBool>,
        audits: Arc<Mutex<Vec<Value>>>,
    }
    async fn relay(
        State(state): State<BudgetRelay>,
        headers: HeaderMap,
        Json(mut body): Json<Value>,
    ) -> Response {
        if headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            != Some(format!("Bearer {}", state.token).as_str())
        {
            return Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Body::from("bounded live test rejected request"))
                .unwrap();
        }
        let offline = state.offline.load(Ordering::SeqCst);
        state.audits.lock().unwrap().push(json!({
            "forwarded": !offline,
            "memoryToolAdvertised": body["tools"].as_array().is_some_and(|tools| tools.iter().any(|tool| tool["function"]["name"] == "memory")),
            "memoryMarkerInjected": body["messages"].as_array().is_some_and(|messages| messages.iter().any(|message| message["content"].as_str().is_some_and(|text| text.starts_with("Persistent factual context from local memory") && text.contains(MEMORY_MARKER)))),
            "anyMessageContainsMarker": body["messages"].to_string().contains(MEMORY_MARKER),
        }));
        if offline {
            // Inspect a real NativeEngine request after disabling memory without
            // paying for another model call or letting the model guess a marker.
            let text = json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"OFFLINE_MEMORY_DISABLED_CHECK"},"finish_reason":null}]});
            let end = json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
            return Response::builder()
                .status(200)
                .header("content-type", "text/event-stream")
                .body(Body::from(format!(
                    "data: {text}\n\ndata: {end}\n\ndata: [DONE]\n\n"
                )))
                .unwrap();
        }
        if state
            .calls
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                (count < state.max_calls).then_some(count + 1)
            })
            .is_err()
        {
            return Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Body::from("bounded live model request budget exhausted"))
                .unwrap();
        }
        // A test-only cap, not catalog metadata and not a model capability claim.
        body["max_tokens"] = json!(4096);
        match state
            .client
            .post(&state.endpoint)
            .bearer_auth(&state.token)
            .json(&body)
            .send()
            .await
        {
            Ok(upstream) => {
                let status = upstream.status();
                let mime = upstream.headers().get("content-type").cloned();
                let mut response = Response::builder().status(status);
                if let Some(mime) = mime {
                    response = response.header("content-type", mime);
                }
                response
                    .body(Body::from_stream(upstream.bytes_stream()))
                    .unwrap()
            }
            Err(_) => Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from("bounded gateway transport failed"))
                .unwrap(),
        }
    }
    fn redact(value: &mut Value, secrets: &[&str]) {
        match value {
            Value::String(text) => {
                for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
                    *text = text.replace(*secret, "[hidden]");
                }
            }
            Value::Array(array) => array.iter_mut().for_each(|value| redact(value, secrets)),
            Value::Object(object) => object.values_mut().for_each(|value| redact(value, secrets)),
            _ => {}
        }
    }
    fn png_fixture() -> Result<Vec<u8>> {
        let (width, height) = (240u32, 140u32);
        let mut pixels = Vec::with_capacity((width * height * 3) as usize);
        for y in 0..height {
            for x in 0..width {
                pixels.extend_from_slice(if y > 119 {
                    &[35, 175, 85]
                } else if x < 120 {
                    &[225, 40, 55]
                } else {
                    &[25, 100, 225]
                });
            }
        }
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header()?.write_image_data(&pixels)?;
        }
        Ok(bytes)
    }
    async fn wait(engine: &NativeEngine, id: &str, project: &Path) -> Result<Value> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
        loop {
            let snapshot = engine
                .call("getSession", json!({"sessionId":id}))
                .await
                .map_err(|error| anyhow!(error))?;
            let calls = snapshot["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|message| message["parts"].as_array().into_iter().flatten())
                .filter(|part| part["type"] == "tool")
                .count();
            if tokio::time::Instant::now() > deadline || calls > 6 {
                let _ = engine
                    .call("interruptSession", json!({"sessionId":id}))
                    .await;
                return Err(anyhow!(
                    "native live turn exceeded the bounded time/tool budget"
                ));
            }
            for permission in snapshot["permissions"].as_array().into_iter().flatten() {
                let safe = matches!(
                    permission["toolName"].as_str(),
                    Some("read_file" | "view_image" | "apply_patch" | "write_file")
                ) && permission["resources"].as_array().is_some_and(|resources| {
                    resources.iter().all(|resource| {
                        let key = resource
                            .as_str()
                            .unwrap_or_default()
                            .trim_start_matches(r"\\?\")
                            .replace('\\', "/")
                            .to_ascii_lowercase();
                        let root = project
                            .to_string_lossy()
                            .trim_start_matches(r"\\?\")
                            .replace('\\', "/")
                            .to_ascii_lowercase();
                        key == format!("{root}/sum.js") || key == format!("{root}/color-check.png")
                    })
                });
                engine.call("replyPermission", json!({"sessionId":id,"requestId":permission["id"],"decision":if safe {"once"}else{"reject"}})).await.map_err(|error|anyhow!(error))?;
            }
            ensure!(
                snapshot["questions"]
                    .as_array()
                    .is_none_or(|questions| questions.is_empty()),
                "unexpected interactive question in live fixture"
            );
            if matches!(snapshot["status"].as_str(), Some("idle" | "error")) {
                return Ok(snapshot);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    fn assistant_text(snapshot: &Value) -> String {
        snapshot["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|message| message["role"] == "assistant")
            .flat_map(|message| message["parts"].as_array().into_iter().flatten())
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn tool_parts(snapshot: &Value) -> Vec<Value> {
        snapshot["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|message| message["parts"].as_array().into_iter().flatten())
            .filter(|part| part["type"] == "tool")
            .cloned()
            .collect()
    }
    async fn wait_memory(
        engine: &NativeEngine,
        id: &str,
        allow_write: bool,
        approvals: &mut Vec<Value>,
    ) -> Result<Value> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(150);
        loop {
            let snapshot = engine
                .call("getSession", json!({"sessionId":id}))
                .await
                .map_err(|error| anyhow!(error))?;
            if tokio::time::Instant::now() >= deadline || tool_parts(&snapshot).len() > 2 {
                let _ = engine
                    .call("interruptSession", json!({"sessionId":id}))
                    .await;
                return Err(anyhow!(
                    "memory live turn exceeded bounded time/tool budget"
                ));
            }
            for permission in snapshot["permissions"].as_array().into_iter().flatten() {
                let before = engine
                    .call("getMemory", json!({}))
                    .await
                    .map_err(|error| anyhow!(error))?;
                let empty = before["user"]["entries"]
                    .as_array()
                    .is_some_and(Vec::is_empty);
                let safe = allow_write
                    && empty
                    && permission["toolName"] == "memory"
                    && permission["approvalMode"] == "user-once"
                    && permission["resources"] == json!(["user-preferences"])
                    && permission["toolInput"]["action"] == "add"
                    && permission["toolInput"]["scope"] == "user"
                    && permission["toolInput"]["content"]
                        .as_str()
                        .is_some_and(|text| text.contains(MEMORY_MARKER) && text.len() <= 120);
                engine.call("replyPermission", json!({"sessionId":id,"requestId":permission["id"],"decision":if safe {"once"} else {"reject"}})).await.map_err(|error|anyhow!(error))?;
                approvals.push(json!({"toolName":permission["toolName"],"approvalMode":permission["approvalMode"],"resources":permission["resources"],"input":permission["toolInput"],"storageWasEmptyBeforeApproval":empty,"decision":if safe {"once"} else {"reject"}}));
                ensure!(safe, "unexpected or unbounded memory permission rejected");
            }
            ensure!(
                snapshot["questions"].as_array().is_none_or(Vec::is_empty),
                "unexpected question during bounded memory acceptance"
            );
            if matches!(snapshot["status"].as_str(), Some("idle" | "error")) {
                return Ok(snapshot);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    async fn memory_acceptance(
        engine: &NativeEngine,
        private: &Path,
        requests: &AtomicUsize,
        offline: &AtomicBool,
        audits: &Mutex<Vec<Value>>,
    ) -> Result<Value> {
        let original = engine
            .call("getMemory", json!({}))
            .await
            .map_err(|error| anyhow!(error))?;
        ensure!(
            original["enabled"] == true
                && original["requireApproval"] == true
                && original["user"]["entries"] == json!([]),
            "temporary memory must start empty with default approval"
        );
        let first = engine
            .call(
                "createSession",
                json!({"mode":"build","permissionMode":"ask","title":"Isolated live memory write"}),
            )
            .await
            .map_err(|error| anyhow!(error))?;
        let first_id = first["id"].as_str().context("write session id missing")?;
        let prompt = format!("请保存这条明确的用户偏好到跨会话 user 记忆：用户偏好的演示输出标记是 {MEMORY_MARKER}。这是隔离测试目录，只调用一次 memory 工具，action=add、scope=user、content=用户偏好的演示输出标记是 {MEMORY_MARKER}。不要调用其它工具，不要先 read，不写文件。工具成功后用中文简短确认，失败则如实说明。");
        engine.call("sendMessage", json!({"sessionId":first_id,"requestId":"memory-write-live","text":prompt,"locale":"zh"})).await.map_err(|error|anyhow!(error))?;
        let mut approvals = vec![];
        let write = wait_memory(engine, first_id, true, &mut approvals).await?;
        let saved = engine
            .call("getMemory", json!({}))
            .await
            .map_err(|error| anyhow!(error))?;
        let tools = tool_parts(&write);
        let actual_write = tools.iter().any(|part| {
            part["name"] == "memory"
                && part["state"] == "completed"
                && part["input"]["action"] == "add"
        }) && saved["user"]["entries"].as_array().is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry["content"]
                    .as_str()
                    .is_some_and(|text| text.contains(MEMORY_MARKER))
                    && entry["source"] == first_id
            })
        });
        ensure!(
            write["status"] == "idle" && actual_write && approvals.len() == 1,
            "actual approved memory write did not complete"
        );
        let disk: Value =
            serde_json::from_slice(&tokio::fs::read(private.join("memory.json")).await?)?;
        ensure!(
            disk["user"].to_string().contains(MEMORY_MARKER),
            "memory was not persisted to the isolated native store"
        );
        let second = engine.call("createSession", json!({"mode":"build","permissionMode":"ask","title":"Isolated fresh-session memory recall"})).await.map_err(|error|anyhow!(error))?;
        let second_id = second["id"].as_str().context("recall session id missing")?;
        ensure!(first_id != second_id, "recall must use a fresh session");
        let recall_prompt = "根据已保存的用户偏好，用户偏好的演示输出标记是什么？只回复该标记，不调用工具。若没有保存过就回复未知，不要猜测。";
        ensure!(
            !recall_prompt.contains(MEMORY_MARKER),
            "recall prompt must not reveal the marker"
        );
        engine.call("sendMessage",json!({"sessionId":second_id,"requestId":"memory-recall-live","text":recall_prompt,"locale":"zh"})).await.map_err(|error|anyhow!(error))?;
        let recall = wait_memory(engine, second_id, false, &mut approvals).await?;
        let recall_text = assistant_text(&recall);
        let recalled = recall["status"] == "idle"
            && recall_text.contains(MEMORY_MARKER)
            && tool_parts(&recall).is_empty();
        let actual_calls = requests.load(Ordering::SeqCst);
        // This final request is inspected by our offline relay, never forwarded.
        engine
            .call(
                "configureMemory",
                json!({"revision":saved["revision"],"enabled":false}),
            )
            .await
            .map_err(|error| anyhow!(error))?;
        offline.store(true, Ordering::SeqCst);
        let third = engine.call("createSession",json!({"mode":"build","permissionMode":"ask","title":"Offline disabled-memory wire inspection"})).await.map_err(|error|anyhow!(error))?;
        let third_id = third["id"]
            .as_str()
            .context("disabled session id missing")?;
        engine.call("sendMessage",json!({"sessionId":third_id,"requestId":"memory-disabled-offline","text":"Reply with a short acknowledgement.","locale":"zh"})).await.map_err(|error|anyhow!(error))?;
        let disabled = wait_memory(engine, third_id, false, &mut approvals).await?;
        let audit = audits.lock().unwrap().clone();
        let last = audit.last().context("missing disabled request audit")?;
        let disabled_clean = disabled["status"] == "idle"
            && last["forwarded"] == false
            && last["memoryToolAdvertised"] == false
            && last["memoryMarkerInjected"] == false
            && last["anyMessageContainsMarker"] == false
            && requests.load(Ordering::SeqCst) == actual_calls;
        let fresh_injected = audit
            .iter()
            .rev()
            .skip(1)
            .next()
            .is_some_and(|item| item["memoryMarkerInjected"] == true);
        Ok(
            json!({"passed":actual_write && recalled && fresh_injected && disabled_clean && actual_calls <= 3,"engine":"rust-native-in-process","productionChannelGateway":true,"model":MODEL,"reasoningEffort":"medium","testedAt":chrono::Utc::now().to_rfc3339(),"maxOutputTokensPerRequest":4096,"maxLiveModelRequests":3,"loopbackModelRequests":actual_calls,"memoryToolWriteCompleted":actual_write,"defaultPermissionApprovalObserved":approvals.len()==1,"permissionReceipts":approvals,"writeTools":tools,"persistedSyntheticEntries":saved["user"]["entries"],"writeSummary":assistant_text(&write),"writeUsage":write["usage"],"freshSessionRecallPromptRevealedMarker":false,"freshSessionRecalledMarker":recalled,"freshSessionMemoryInjected":fresh_injected,"recallSummary":recall_text,"recallUsage":recall["usage"],"disabledCheckedOffline":true,"disabledMemoryNotInjectedOrAdvertised":disabled_clean,"wireAudit":audit,"temporaryStoreOnly":true,"userConfigWritten":false}),
        )
    }
    fn output_path() -> Result<(PathBuf, bool)> {
        let mut args = std::env::args_os().skip(1).collect::<Vec<_>>();
        let memory = args.first().is_some_and(|value| value == "--memory-smoke");
        if memory {
            args.remove(0);
        }
        ensure!(
            args.len() == 2 && args[0] == "--out",
            "usage: [--memory-smoke] --out <absolute-evidence-json-path>"
        );
        let path = PathBuf::from(&args[1]);
        ensure!(
            path.is_absolute(),
            "evidence output must be an absolute path"
        );
        Ok((path, memory))
    }
    pub async fn run() -> Result<()> {
        let (out, memory_smoke) = output_path()?;
        let authorized = PathBuf::from("C:/Users/admin/.tai-switch/cc-switch.db");
        ensure!(
            out != authorized,
            "evidence cannot replace the authorized database"
        );
        let readonly = rusqlite::Connection::open_with_flags(
            &authorized,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .context("authorized channel metadata unavailable")?;
        let stored: String = readonly
            .query_row(
                "SELECT value FROM settings WHERE key='channel_center'",
                [],
                |row| row.get(0),
            )
            .context("authorized channel catalog unavailable")?;
        let stored: ChannelCenterSnapshot =
            serde_json::from_str(&stored).context("authorized channel metadata invalid")?;
        drop(readonly);
        let mut managed = stored
            .channels
            .into_iter()
            .find(|source| {
                source.auth_kind == "zhipu_oauth"
                    && source.base_url == "https://open.bigmodel.cn/api/coding/paas/v4"
                    && source.account_id.is_some()
                    && source.models.iter().any(|model| model.id == MODEL)
            })
            .ok_or_else(|| anyhow!("authorized managed GLM channel unavailable"))?;
        // Copy the account reference only. Production gateway resolves its
        // managed project token privately for each actual request.
        managed.id = "glm_native_live".into();
        managed.name = "GLM Native managed temporary acceptance".into();
        managed.api_key.clear();
        managed.enabled = true;
        managed.models = serde_json::from_value(
            json!([{"id":MODEL,"name":MODEL,"contextLimit":128000,"outputLimit":4096,"supportsTools":true,"inputModalities":["text","image"],"reasoningEfforts":["medium","high"],"enabled":true}]),
        )?;
        let key = String::new();
        let temporary = tempfile::Builder::new()
            .prefix("LoliCode native GLM ")
            .tempdir()?;
        let project = temporary.path().join("project");
        tokio::fs::create_dir_all(&project).await?;
        tokio::fs::write(project.join("sum.js"), BEFORE).await?;
        tokio::fs::write(project.join("package.json"), "{\"type\":\"module\"}\n").await?;
        tokio::fs::write(project.join("test.mjs"), "import assert from 'node:assert/strict'; import {add} from './sum.js'; assert.equal(add(2,3),5); assert.equal(add(-2,3),1); assert.equal(add(0,0),0); console.log('NATIVE_JS_ASSERTIONS_PASSED');").await?;
        let pixels = png_fixture()?;
        tokio::fs::write(project.join("color-check.png"), &pixels).await?;
        let db = Arc::new(Database::memory()?);
        let state = AppState {
            db: db.clone(),
            proxy_service: ProxyService::new(db.clone()),
            usage_cache: Arc::new(UsageCache::new()),
            codex_oauth_manager: Arc::new(CodexOAuthManager::new(temporary.path().join("oauth"))),
        };
        let mut global = db.get_global_proxy_config().await?;
        global.listen_address = "127.0.0.1".into();
        global.listen_port = 0;
        db.update_global_proxy_config(global).await?;
        for app in ["codex", "claude"] {
            let mut limits = db.get_proxy_config_for_app(app).await?;
            limits.max_retries = 0;
            limits.streaming_first_byte_timeout = 45;
            limits.streaming_idle_timeout = 45;
            limits.non_streaming_timeout = 60;
            db.update_proxy_config_for_app(limits).await?;
        }
        channel_center::save(
            &db,
            ChannelCenterSnapshot {
                channels: vec![managed],
                targets: vec![],
                default_model: Some(ROUTE.into()),
                revision: 0,
            },
        )?;
        let binding = channel_center::prepare_inprocess_agent_binding(&state).await?;
        let local_key = binding.bearer_token.clone();
        let requests = Arc::new(AtomicUsize::new(0));
        let offline = Arc::new(AtomicBool::new(false));
        let audits = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let app = Router::new()
            .route("/v1/chat/completions", post(relay))
            .with_state(BudgetRelay {
                client: reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(150))
                    .build()?,
                endpoint: format!("{}/chat/completions", binding.base_url),
                token: local_key.clone(),
                calls: requests.clone(),
                max_calls: if memory_smoke { 3 } else { 8 },
                offline: offline.clone(),
                audits: audits.clone(),
            });
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let private = temporary.path().join("native-private");
        let engine = NativeEngine::open(private.clone())
            .await
            .map_err(|error| anyhow!(error))?;
        let result: Result<Value> = async {
            engine.bind(project.clone(),serde_json::to_value(binding.catalog)?,NativeGateway{base_url:format!("http://127.0.0.1:{port}/v1"),bearer_token:local_key.clone()}).await.map_err(|error|anyhow!(error))?;
            if memory_smoke {
                return memory_acceptance(&engine, &private, &requests, &offline, &audits).await;
            }
            engine.call("configureMemory",json!({"revision":0,"enabled":false})).await.map_err(|error|anyhow!(error))?;
            let session=engine.call("createSession",json!({"mode":"build","permissionMode":"ask","title":"Native GLM multimodal acceptance"})).await.map_err(|error|anyhow!(error))?;
            let id=session["id"].as_str().unwrap();
            engine.call("sendMessage",json!({"sessionId":id,"requestId":"native-glm-acceptance","text":PROMPT,"locale":"zh"})).await.map_err(|error|anyhow!(error))?;
            let snapshot=wait(&engine,id,&project).await?;
            let after=tokio::fs::read_to_string(project.join("sum.js")).await?;
            let mut command=tokio::process::Command::new("node"); command.env_clear().current_dir(&project).arg("test.mjs");
            for (name,value) in std::env::vars_os() { if matches!(name.to_string_lossy().to_ascii_uppercase().as_str(),"PATH"|"PATHEXT"|"SYSTEMROOT"|"WINDIR"|"COMSPEC") { command.env(name,value); } }
            let validation=tokio::time::timeout(Duration::from_secs(5),command.output()).await??;
            let tools=snapshot["messages"].as_array().into_iter().flatten().flat_map(|message|message["parts"].as_array().into_iter().flatten()).filter(|part|part["type"]=="tool").cloned().collect::<Vec<_>>();
            let text=snapshot["messages"].as_array().into_iter().flatten().filter(|message|message["role"]=="assistant").flat_map(|message|message["parts"].as_array().into_iter().flatten()).filter(|part|part["type"]=="text").filter_map(|part|part["text"].as_str()).collect::<Vec<_>>().join("\n");
            let vision=tools.iter().any(|tool|tool["name"]=="view_image" && tool["state"]=="completed") && text.contains("RED_LEFT") && text.contains("BLUE_RIGHT");
            let edited=tools.iter().any(|tool|matches!(tool["name"].as_str(),Some("apply_patch"|"write_file")) && tool["state"]=="completed") && after!=BEFORE && validation.status.success();
            Ok(json!({"passed":snapshot["status"]=="idle" && vision && edited,"engine":"rust-native-in-process","productionChannelGateway":true,"testBudgetRelay":true,"model":MODEL,"reasoningEffort":"medium","testedAt":chrono::Utc::now().to_rfc3339(),"maxOutputTokensPerRequest":4096,"maxToolCalls":6,"loopbackModelRequests":requests.load(Ordering::SeqCst),"actualImageToolSucceeded":vision,"actualJsEditAndNodeAssertionsPassed":edited,"before":BEFORE,"after":after,"summary":text,"tools":tools,"usage":snapshot["usage"],"snapshotStatus":snapshot["status"],"error":snapshot["error"],"temporaryProjectOnly":true,"userConfigWritten":false}))
        }.await;
        let _ = engine.shutdown().await;
        server.abort();
        let _ = server.await;
        let _ = state.proxy_service.stop().await;
        let mut proof = match result {
            Ok(proof) => proof,
            Err(error) => {
                json!({"passed":false,"engine":"rust-native-in-process","model":MODEL,"error":error.to_string(),"loopbackModelRequests":requests.load(Ordering::SeqCst)})
            }
        };
        redact(&mut proof, &[&key, &local_key]);
        let serialized = serde_json::to_string_pretty(&proof)?;
        ensure!(
            (key.is_empty() || !serialized.contains(&key)) && !serialized.contains(&local_key),
            "credential redaction failed"
        );
        if let Some(parent) = out.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&out, serialized).await?;
        if memory_smoke {
            println!("Native GLM memory acceptance: passed={}, model={}, requests={}, write={}, fresh_recall={}, disabled_offline={}; sanitized proof={}", proof["passed"], MODEL, proof["loopbackModelRequests"], proof["memoryToolWriteCompleted"], proof["freshSessionRecalledMarker"], proof["disabledMemoryNotInjectedOrAdvertised"], out.display());
        } else {
            println!("Native GLM acceptance: passed={}, model={}, requests={}, image={}, js_assertions={}; sanitized proof={}",proof["passed"],MODEL,proof["loopbackModelRequests"],proof["actualImageToolSucceeded"],proof["actualJsEditAndNodeAssertionsPassed"],out.display());
        }
        ensure!(
            proof["passed"] == true,
            "native GLM acceptance failed; inspect sanitized proof"
        );
        Ok(())
    }
}
#[cfg(feature = "test-hooks")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    live::run().await
}
