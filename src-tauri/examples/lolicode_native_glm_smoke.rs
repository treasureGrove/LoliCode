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
    #[derive(Clone, Copy)]
    enum MemoryScenario {
        Marker,
        Address,
    }
    #[derive(Clone, Copy)]
    enum AcceptanceScenario {
        Coding,
        Memory(MemoryScenario),
        Workflow,
        Title,
        Tavern,
    }
    impl MemoryScenario {
        fn request_budget(self) -> usize {
            match self {
                Self::Marker => 4,
                Self::Address => 6,
            }
        }
        fn marker(self) -> &'static str {
            match self {
                Self::Marker => MEMORY_MARKER,
                Self::Address => "主人",
            }
        }
        fn write_prompt(self) -> String {
            match self {
                Self::Marker => format!("请保存这条明确的用户偏好到跨会话 user 记忆：用户偏好的演示输出标记是 {MEMORY_MARKER}。这是隔离测试目录，只调用一次 memory 工具，action=add、scope=user、content=用户偏好的演示输出标记是 {MEMORY_MARKER}。不要调用其它工具，不要先 read，不写文件。工具成功后用中文简短确认，失败则如实说明。"),
                Self::Address => "以后请叫我主人，这是我长期的称呼偏好。请用中文简短回复。".into(),
            }
        }
        fn recall_prompt(self) -> &'static str {
            match self {
                Self::Marker => "根据已保存的用户偏好，用户偏好的演示输出标记是什么？只回复该标记，不调用工具。若没有保存过就回复未知，不要猜测。",
                Self::Address => "你好，今天能帮我做些什么？请用一句中文回复，不调用工具。",
            }
        }
    }
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
        memory_marker: &'static str,
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
            "titleRequest": body["messages"][0]["content"].as_str().is_some_and(|text| text.starts_with("You generate a short session title for LoliCode.")),
            "requestedReasoningEffort": body["reasoning_effort"],
            "memoryToolAdvertised": body["tools"].as_array().is_some_and(|tools| tools.iter().any(|tool| tool["function"]["name"] == "memory")),
            "memoryMarkerInjected": body["messages"].as_array().is_some_and(|messages| messages.iter().any(|message| message["role"] == "user" && message["content"].as_str().is_some_and(|text| text.starts_with("Persistent memory from this user's explicit preferences and project facts") && text.contains(state.memory_marker)))),
            "anyMessageContainsMarker": body["messages"].to_string().contains(state.memory_marker),
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
        marker: &str,
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
                        .is_some_and(|text| text.contains(marker) && text.chars().count() <= 120);
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
        scenario: MemoryScenario,
        project: &Path,
        catalog: &Value,
        gateway: &NativeGateway,
    ) -> Result<Value> {
        let marker = scenario.marker();
        let request_budget = scenario.request_budget();
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
        let prompt = scenario.write_prompt();
        engine.call("sendMessage", json!({"sessionId":first_id,"requestId":"memory-write-live","text":prompt,"locale":"zh"})).await.map_err(|error|anyhow!(error))?;
        let mut approvals = vec![];
        let write = wait_memory(engine, first_id, true, &mut approvals, marker).await?;
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
                    .is_some_and(|text| text.contains(marker))
                    && entry["source"] == first_id
            })
        });
        if write["status"] != "idle" || !actual_write || approvals.len() != 1 {
            return Ok(
                json!({"passed":false,"stage":"memory-write","engine":"rust-native-in-process","productionChannelGateway":true,"model":MODEL,"loopbackModelRequests":requests.load(Ordering::SeqCst),"memoryToolWriteCompleted":actual_write,"naturalAddressPreference":matches!(scenario,MemoryScenario::Address),"writePromptSpecifiesTool":matches!(scenario,MemoryScenario::Marker),"snapshotStatus":write["status"],"error":write["error"],"writeSummary":assistant_text(&write),"writeTools":tools,"persistedSyntheticEntries":saved["user"]["entries"],"permissionReceipts":approvals,"wireAudit":audits.lock().unwrap().clone()}),
            );
        }
        let disk: Value =
            serde_json::from_slice(&tokio::fs::read(private.join("memory.json")).await?)?;
        ensure!(
            disk["user"].to_string().contains(marker),
            "memory was not persisted to the isolated native store"
        );
        let second = engine.call("createSession", json!({"mode":"build","permissionMode":"ask","title":"Isolated fresh-session memory recall"})).await.map_err(|error|anyhow!(error))?;
        let second_id = second["id"].as_str().context("recall session id missing")?;
        ensure!(first_id != second_id, "recall must use a fresh session");
        let recall_prompt = scenario.recall_prompt();
        ensure!(
            !recall_prompt.contains(marker),
            "recall prompt must not reveal the marker"
        );
        engine.call("sendMessage",json!({"sessionId":second_id,"requestId":"memory-recall-live","text":recall_prompt,"locale":"zh"})).await.map_err(|error|anyhow!(error))?;
        let recall = wait_memory(engine, second_id, false, &mut approvals, marker).await?;
        let recall_text = assistant_text(&recall);
        let recalled = recall["status"] == "idle"
            && recall_text.contains(marker)
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
        let disabled = wait_memory(engine, third_id, false, &mut approvals, marker).await?;
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
        // Re-enable the synthetic preference, close the actual engine and open
        // the same private store again. The recall session has no old history.
        let disabled_settings = engine
            .call("getMemory", json!({}))
            .await
            .map_err(|error| anyhow!(error))?;
        engine
            .call(
                "configureMemory",
                json!({"revision":disabled_settings["revision"],"enabled":true}),
            )
            .await
            .map_err(|error| anyhow!(error))?;
        engine.shutdown().await.map_err(|error| anyhow!(error))?;
        let restarted = NativeEngine::open(private.to_path_buf())
            .await
            .map_err(|error| anyhow!(error))?;
        offline.store(false, Ordering::SeqCst);
        let restart_result: Result<(Value, String)> = async {
            restarted.bind(project.to_path_buf(), catalog.clone(), gateway.clone()).await.map_err(|error|anyhow!(error))?;
            let session = restarted.call("createSession", json!({"mode":"build","permissionMode":"ask","title":"Isolated restart memory recall"})).await.map_err(|error|anyhow!(error))?;
            let id = session["id"].as_str().context("restart recall id missing")?;
            restarted.call("sendMessage",json!({"sessionId":id,"requestId":"memory-restarted-live","text":recall_prompt,"locale":"zh"})).await.map_err(|error|anyhow!(error))?;
            let snapshot = wait_memory(&restarted, id, false, &mut approvals, marker).await?;
            let text = assistant_text(&snapshot);
            Ok((snapshot, text))
        }.await;
        let _ = restarted.shutdown().await;
        let (restart, restart_text) = restart_result?;
        let after_restart_calls = requests.load(Ordering::SeqCst);
        let restart_injected =
            audits.lock().unwrap().last().is_some_and(|item| {
                item["memoryMarkerInjected"] == true && item["forwarded"] == true
            });
        let restart_recalled = restart["status"] == "idle"
            && restart_text.contains(marker)
            && tool_parts(&restart).is_empty()
            && restart_injected;
        let mut proof = json!({"passed":actual_write && recalled && fresh_injected && disabled_clean && actual_calls <= 3,"engine":"rust-native-in-process","productionChannelGateway":true,"model":MODEL,"reasoningEffort":"medium","testedAt":chrono::Utc::now().to_rfc3339(),"maxOutputTokensPerRequest":4096,"maxLiveModelRequests":3,"loopbackModelRequests":actual_calls,"memoryToolWriteCompleted":actual_write,"defaultPermissionApprovalObserved":approvals.len()==1,"permissionReceipts":approvals,"writeTools":tools,"persistedSyntheticEntries":saved["user"]["entries"],"writeSummary":assistant_text(&write),"writeUsage":write["usage"],"freshSessionRecallPromptRevealedMarker":false,"freshSessionRecalledMarker":recalled,"freshSessionMemoryInjected":fresh_injected,"recallSummary":recall_text,"recallUsage":recall["usage"],"disabledCheckedOffline":true,"disabledMemoryNotInjectedOrAdvertised":disabled_clean,"wireAudit":audit,"temporaryStoreOnly":true,"userConfigWritten":false});
        let first_preference_followed =
            !matches!(scenario, MemoryScenario::Address) || assistant_text(&write).contains(marker);
        proof["passed"] = json!(
            actual_write
                && recalled
                && fresh_injected
                && disabled_clean
                && first_preference_followed
                && restart_recalled
                && after_restart_calls <= request_budget
        );
        proof["maxLiveModelRequests"] = json!(request_budget);
        proof["loopbackModelRequests"] = json!(after_restart_calls);
        proof["memoryReenabledBeforeRestart"] = json!(true);
        proof["actualEngineReopened"] = json!(true);
        proof["restartRecalledMarker"] = json!(restart_recalled);
        proof["restartMemoryInjected"] = json!(restart_injected);
        proof["restartRecallSummary"] = json!(restart_text);
        proof["restartUsage"] = restart["usage"].clone();
        proof["wireAudit"] = json!(audits.lock().unwrap().clone());
        proof["firstReplyFollowsPreference"] = json!(first_preference_followed);
        proof["naturalAddressPreference"] = json!(matches!(scenario, MemoryScenario::Address));
        proof["writePromptSpecifiesTool"] = json!(matches!(scenario, MemoryScenario::Marker));
        Ok(proof)
    }

    async fn validate_js(project: &Path) -> Result<bool> {
        let mut command = tokio::process::Command::new("node");
        command.env_clear().current_dir(project).arg("test.mjs");
        for (name, value) in std::env::vars_os() {
            if matches!(
                name.to_string_lossy().to_ascii_uppercase().as_str(),
                "PATH" | "PATHEXT" | "SYSTEMROOT" | "WINDIR" | "COMSPEC"
            ) {
                command.env(name, value);
            }
        }
        Ok(
            tokio::time::timeout(Duration::from_secs(5), command.output())
                .await??
                .status
                .success(),
        )
    }

    async fn workflow_acceptance(
        engine: &NativeEngine,
        db: &Database,
        project: &Path,
        requests: &AtomicUsize,
    ) -> Result<Value> {
        use cc_switch_lib::agent_test_support::{
            record_run_in_db, workflow_files, workflow_prompt,
        };
        let name = "isolated-glm-math-check";
        let document = "---\ndescription: Repair a tiny math function and verify workflow arguments\n# This comment must survive editing.\ncustom: acceptance-only\nargs:\n  expectedTotal:\n    type: number\n    required: true\n    default: 5\n---\nRead sum.js and make its add function perform ordinary addition. The expected result for add(2,3) is the expectedTotal argument. Edit sum.js only, using the smallest change. Do not execute commands, access network, use images, write memories, or read outside this isolated project. Use real read_file and apply_patch/write_file tools. Report the change briefly in Chinese.";
        let params =
            json!({"workspacePath":project,"scope":"project","name":name,"document":document});
        let saved = workflow_files("saveSavedWorkflow", vec![params.clone()])
            .await
            .map_err(|error| anyhow!(error))?;
        ensure!(saved["ok"] == true, "saved workflow was not acknowledged");
        let loaded = workflow_files("getSavedWorkflow", vec![params.clone()])
            .await
            .map_err(|error| anyhow!(error))?;
        ensure!(
            loaded["document"] == document,
            "saved workflow document changed unexpectedly"
        );
        let prompt = workflow_prompt(&project.to_string_lossy(), name, "project", &json!({}))
            .await
            .map_err(|error| anyhow!(error))?;
        ensure!(
            prompt.contains("\"expectedTotal\": 5"),
            "default workflow argument missing"
        );
        engine
            .call("configureMemory", json!({"revision":0,"enabled":false}))
            .await
            .map_err(|error| anyhow!(error))?;
        let session = engine.call("createSession",json!({"mode":"build","permissionMode":"ask","title":"Isolated saved workflow live debug"})).await.map_err(|error|anyhow!(error))?;
        let id = session["id"]
            .as_str()
            .context("workflow session id missing")?;
        let receipt = "workflow-glm-owned-request";
        record_run_in_db(
            db,
            &project.to_string_lossy(),
            id,
            name,
            "project",
            receipt,
            &prompt,
        )
        .await
        .map_err(|error| anyhow!(error))?;
        engine
            .call(
                "sendMessage",
                json!({"sessionId":id,"requestId":receipt,"text":prompt,"locale":"zh"}),
            )
            .await
            .map_err(|error| anyhow!(error))?;
        let snapshot = wait(engine, id, project).await?;
        let after = tokio::fs::read_to_string(project.join("sum.js")).await?;
        let edited = tool_parts(&snapshot).iter().any(|part| {
            matches!(part["name"].as_str(), Some("apply_patch" | "write_file"))
                && part["state"] == "completed"
        }) && after != BEFORE
            && validate_js(project).await?;
        let calls_before_retry = requests.load(Ordering::SeqCst);
        record_run_in_db(
            db,
            &project.to_string_lossy(),
            id,
            name,
            "project",
            receipt,
            &prompt,
        )
        .await
        .map_err(|error| anyhow!(error))?;
        engine
            .call(
                "sendMessage",
                json!({"sessionId":id,"requestId":receipt,"text":prompt,"locale":"zh"}),
            )
            .await
            .map_err(|error| anyhow!(error))?;
        let command = engine
            .call("queryCommand", json!({"sessionId":id,"requestId":receipt}))
            .await
            .map_err(|error| anyhow!(error))?;
        let records: Value = serde_json::from_str(
            &db.get_setting("lolicode_workflow_runs_v1")?
                .context("workflow receipt missing")?,
        )?;
        let one_record = records
            .as_array()
            .is_some_and(|rows| rows.len() == 1 && rows[0]["sessionId"] == id);
        let no_replay = requests.load(Ordering::SeqCst) == calls_before_retry
            && command["results"][0]["result"]["status"] == "completed"
            && tokio::fs::read_to_string(project.join("sum.js")).await? == after;
        Ok(
            json!({"passed":snapshot["status"]=="idle" && edited && one_record && no_replay,"engine":"rust-native-in-process","productionChannelGateway":true,"productionWorkflowFileService":true,"desktopIpcExercised":false,"model":MODEL,"maxLiveModelRequests":8,"loopbackModelRequests":requests.load(Ordering::SeqCst),"workflowDefaultArgumentApplied":true,"workflowReceiptStoredOnce":one_record,"retryDidNotReplayModelOrFileEdit":no_replay,"actualJsEditAndNodeAssertionsPassed":edited,"snapshotStatus":snapshot["status"],"error":snapshot["error"],"tools":tool_parts(&snapshot),"summary":assistant_text(&snapshot),"usage":snapshot["usage"],"before":BEFORE,"after":after,"temporaryStoreOnly":true,"userConfigWritten":false}),
        )
    }

    async fn title_acceptance(
        engine: &NativeEngine,
        private: &Path,
        project: &Path,
        requests: &AtomicUsize,
        audits: &Mutex<Vec<Value>>,
    ) -> Result<Value> {
        engine
            .call("configureMemory", json!({"revision":0,"enabled":false}))
            .await
            .map_err(|error| anyhow!(error))?;
        let session = engine
            .call(
                "createSession",
                json!({"mode":"build","permissionMode":"ask"}),
            )
            .await
            .map_err(|error| anyhow!(error))?;
        let id = session["id"]
            .as_str()
            .context("automatic-title session missing")?;
        engine.call("sendMessage",json!({"sessionId":id,"requestId":"auto-title-owned-request","text":"我正在构思一个 HTML 黑洞动画网页，请用一句中文概括制作方向，不调用任何工具。","locale":"zh"})).await.map_err(|error|anyhow!(error))?;
        let _ = wait(engine, id, project).await?;
        let snapshot = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let value = engine
                    .call("getSession", json!({"sessionId":id}))
                    .await
                    .map_err(|error| anyhow!(error))?;
                if value["titlePending"] == false {
                    return Ok::<Value, anyhow::Error>(value);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await??;
        let file = private
            .join("sessions")
            .join(format!("{}.json", id.trim_start_matches("lc:")));
        let persisted: Value = serde_json::from_slice(&tokio::fs::read(file).await?)?;
        let title = snapshot["session"]["title"].as_str().unwrap_or_default();
        let generated = persisted["titleState"] == "generated"
            && persisted["snapshot"]["session"]["title"] == title;
        let audit = audits.lock().unwrap().clone();
        let actual_title_request = audit
            .iter()
            .any(|request| request["forwarded"] == true && request["titleRequest"] == true);
        Ok(
            json!({"passed":snapshot["status"]=="idle" && generated && actual_title_request && !title.is_empty() && requests.load(Ordering::SeqCst)<=3,"engine":"rust-native-in-process","productionChannelGateway":true,"model":MODEL,"maxLiveModelRequests":3,"loopbackModelRequests":requests.load(Ordering::SeqCst),"manualTitleSupplied":false,"automaticTitleGeneratedAndPersisted":generated,"actualTitleRequestObserved":actual_title_request,"title":title,"titlePending":snapshot["titlePending"],"snapshotStatus":snapshot["status"],"error":snapshot["error"],"summary":assistant_text(&snapshot),"wireAudit":audit,"temporaryStoreOnly":true,"userConfigWritten":false}),
        )
    }

    async fn tavern_acceptance(state: &AppState, project: &Path) -> Result<Value> {
        use cc_switch_lib::agent_test_support::{builtin_apps_test, tavern_test as tavern};
        builtin_apps_test::set_enabled(&state.db, builtin_apps_test::BuiltinApp::Tavern, true)
            .map_err(|error| anyhow!(error))?;
        let card_path = project.join("tavern-card.json");
        let card = json!({"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"Mira","description":"你是温柔的图书管理员米拉，用一句中文回复。","first_mes":"欢迎来到图书馆。","character_book":{"entries":[{"name":"Current place","keys":[],"constant":true,"enabled":true,"content":"当前地点叫 PINK_LIBRARY_73。对方问起你在哪里时，请明确说出这个地点名称。"}]}}});
        tokio::fs::write(&card_path, serde_json::to_vec(&card)?).await?;
        let character = tavern::import_character(state, &card_path.to_string_lossy())
            .map_err(|error| anyhow!(error))?;
        let story = tavern::create_story(state, &character.id, Some("Isolated GLM roleplay debug"))
            .map_err(|error| anyhow!(error))?;
        let preview = tavern::context_preview(state, &story.id).map_err(|error| anyhow!(error))?;
        ensure!(
            preview.pre_history.contains("PINK_LIBRARY_73") && preview.included_entries.len() == 1,
            "world book was not included"
        );
        let catalog = tavern::catalog(state)
            .await
            .map_err(|error| anyhow!(error))?;
        let model = catalog.default_model.context("tavern model unavailable")?;
        let result = tavern::send_message(state, &story.id, "你好，你现在在哪里？", &model).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let attributed = loop {
            let count = state
                .db
                .get_usage_summary(None, None, Some("tavern"), None, None)?
                .total_requests;
            if count > 0 || tokio::time::Instant::now() >= deadline {
                break count;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        let lolicode = state
            .db
            .get_usage_summary(None, None, Some("lolicode"), None, None)?
            .total_requests;
        let finished = match result {
            Ok(story) => story,
            Err(error) => {
                return Ok(
                    json!({"passed":false,"stage":"tavern-generation","error":error,"directTavernHttpSubmissions":1,"tavernAttributedRequests":attributed}),
                )
            }
        };
        let response = finished
            .messages
            .last()
            .filter(|message| message.role == "assistant")
            .context("tavern reply missing")?
            .text
            .clone();
        let saved = tavern::snapshot(state).map_err(|error| anyhow!(error))?;
        let persisted = saved.stories.iter().any(|story| {
            story.id == finished.id
                && story
                    .messages
                    .last()
                    .is_some_and(|message| message.text == response)
                && !story.is_generating
        });
        Ok(
            json!({"passed":response.contains("PINK_LIBRARY_73") && persisted && !finished.is_generating && attributed==1 && lolicode==0,"engine":"native-tavern-domain-service","productionChannelGateway":true,"desktopIpcExercised":false,"model":MODEL,"directTavernHttpSubmissions":1,"tavernAttributedRequests":attributed,"mainAgentAttributedRequests":lolicode,"worldBookEntryIncluded":true,"replyUsedWorldBookPlace":response.contains("PINK_LIBRARY_73"),"completedResultIdle":!finished.is_generating,"storyReplyPersisted":persisted,"summary":response,"temporaryStoreOnly":true,"userConfigWritten":false}),
        )
    }
    fn output_path() -> Result<(PathBuf, AcceptanceScenario)> {
        let mut args = std::env::args_os().skip(1).collect::<Vec<_>>();
        let scenario = match args.first().and_then(|value| value.to_str()) {
            Some("--memory-smoke") => Some(AcceptanceScenario::Memory(MemoryScenario::Marker)),
            Some("--memory-address-smoke") => {
                Some(AcceptanceScenario::Memory(MemoryScenario::Address))
            }
            Some("--workflow-smoke") => Some(AcceptanceScenario::Workflow),
            Some("--auto-title-smoke") => Some(AcceptanceScenario::Title),
            Some("--tavern-smoke") => Some(AcceptanceScenario::Tavern),
            _ => None,
        };
        if scenario.is_some() {
            args.remove(0);
        }
        ensure!(args.len()==2 && args[0]=="--out","usage: [--memory-smoke | --memory-address-smoke | --workflow-smoke | --auto-title-smoke | --tavern-smoke] --out <absolute-evidence-json-path>");
        let path = PathBuf::from(&args[1]);
        ensure!(
            path.is_absolute(),
            "evidence output must be an absolute path"
        );
        Ok((path, scenario.unwrap_or(AcceptanceScenario::Coding)))
    }
    pub async fn run() -> Result<()> {
        let (out, scenario) = output_path()?;
        let memory_scenario = match scenario {
            AcceptanceScenario::Memory(memory) => Some(memory),
            _ => None,
        };
        let workflow_smoke = matches!(scenario, AcceptanceScenario::Workflow);
        let title_smoke = matches!(scenario, AcceptanceScenario::Title);
        let tavern_smoke = matches!(scenario, AcceptanceScenario::Tavern);
        let memory_smoke = memory_scenario.is_some();
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
        // Used only for exact redaction; requests still use the production
        // managed-account gateway, never a copied credential channel.
        let account = managed
            .account_id
            .as_deref()
            .context("managed account reference missing")?;
        let key = cc_switch_lib::agent_test_support::glm_acceptance_secret(account)
            .await
            .map_err(|_| {
                anyhow!("authorized GLM credential resolution unavailable without writes")
            })?;
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
                max_calls: if title_smoke {
                    3
                } else {
                    memory_scenario.map_or(8, MemoryScenario::request_budget)
                },
                offline: offline.clone(),
                audits: audits.clone(),
                memory_marker: memory_scenario.map_or(MEMORY_MARKER, MemoryScenario::marker),
            });
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let private = temporary.path().join("native-private");
        let engine = NativeEngine::open(private.clone())
            .await
            .map_err(|error| anyhow!(error))?;
        let result: Result<Value> = async {
            let catalog = serde_json::to_value(binding.catalog)?;
            let gateway = NativeGateway{base_url:format!("http://127.0.0.1:{port}/v1"),bearer_token:local_key.clone()};
            engine.bind(project.clone(),catalog.clone(),gateway.clone()).await.map_err(|error|anyhow!(error))?;
            if let Some(scenario) = memory_scenario {
                return memory_acceptance(&engine, &private, &requests, &offline, &audits, scenario, &project, &catalog, &gateway).await;
            }
            if tavern_smoke { return tavern_acceptance(&state, &project).await; }
            if workflow_smoke { return workflow_acceptance(&engine, &db, &project, &requests).await; }
            if title_smoke { return title_acceptance(&engine, &private, &project, &requests, &audits).await; }
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
        proof["credentialPurpose"] = json!("supplementary-debug-with-prior-GLM-authorization");
        proof["designatedTestkeyAcceptance"] = json!(false);
        proof["catalogMetadataOverridesForBoundedHarness"] = json!(true);
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
        } else if tavern_smoke {
            println!("GLM Tavern debug: passed={}, requests={}, world_book={}, stored={}, idle={}; sanitized proof={}",proof["passed"],proof["tavernAttributedRequests"],proof["replyUsedWorldBookPlace"],proof["storyReplyPersisted"],proof["completedResultIdle"],out.display());
        } else if title_smoke {
            println!("Native GLM title debug: passed={}, requests={}, generated={}, persisted={}; sanitized proof={}", proof["passed"],proof["loopbackModelRequests"],proof["actualTitleRequestObserved"],proof["automaticTitleGeneratedAndPersisted"],out.display());
        } else if workflow_smoke {
            println!("Native GLM workflow debug: passed={}, requests={}, saved_once={}, no_replay={}, js_assertions={}; sanitized proof={}", proof["passed"],proof["loopbackModelRequests"],proof["workflowReceiptStoredOnce"],proof["retryDidNotReplayModelOrFileEdit"],proof["actualJsEditAndNodeAssertionsPassed"],out.display());
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
