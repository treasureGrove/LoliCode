//! Real owned-engine extensions smoke; no user configs, accounts, or paid API.
//! cargo run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_agent_extensions_smoke -j 2

#[cfg(not(feature = "test-hooks"))]
fn main() {
    eprintln!("Run this offline example with --features test-hooks.");
}

#[cfg(feature = "test-hooks")]
mod smoke {
    use anyhow::{anyhow, bail, ensure, Context, Result};
    use axum::{
        body::Body, extract::State, http::header, response::Response, routing::post, Json, Router,
    };
    use cc_switch_lib::{
        agent_test_support::{
            channel_center::{AgentCatalog, AgentCatalogModel},
            extensions_runtime_catalog, AgentExtensionStore, AgentState,
        },
        Database,
    };
    use lolicode_agent::{AgentModelRef, AgentPart, AgentStatus, Engine, EngineOptions};
    use serde_json::{json, Value};
    use std::{
        io::{BufRead, Write},
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tokio::{net::TcpListener, time::Instant};

    #[derive(Clone, Default)]
    struct Fake {
        skill_seen: Arc<AtomicBool>,
        mcp_seen: Arc<AtomicBool>,
        tool_result_seen: Arc<AtomicBool>,
        failure: Arc<tokio::sync::Mutex<Option<String>>>,
    }

    fn response(delta: Value, finish: &str) -> Response {
        let chunk = json!({"id":"chatcmpl_extensions","object":"chat.completion.chunk","created":1,"model":"extensions/probe","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = json!({"id":"chatcmpl_extensions","object":"chat.completion.chunk","created":1,"model":"extensions/probe","choices":[{"index":0,"delta":{},"finish_reason":finish}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}});
        Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(format!(
                "data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"
            )))
            .unwrap()
    }

    async fn chat(State(state): State<Fake>, Json(body): Json<Value>) -> Response {
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        if messages
            .iter()
            .any(|m| m["role"] == "tool" && m["tool_call_id"] == "call_native_mcp")
        {
            state.tool_result_seen.store(true, Ordering::Release);
            return response(
                json!({"role":"assistant","content":"MCP_NATIVE_EXECUTED"}),
                "stop",
            );
        }
        if messages.iter().any(|m| {
            m["content"]
                .to_string()
                .contains("LOLICODE_MCP_EXECUTION_PROBE")
        }) {
            let tool = body["tools"].as_array().into_iter().flatten().find(|tool| {
                tool["function"]["name"]
                    .as_str()
                    .is_some_and(|name| name.contains("extension_probe"))
            });
            if let Some(tool) = tool {
                state.mcp_seen.store(true, Ordering::Release);
                return response(
                    json!({"role":"assistant","tool_calls":[{"index":0,"id":"call_native_mcp","type":"function","function":{"name":tool["function"]["name"],"arguments":"{\"message\":\"MCP_NATIVE_TOOL_OK\"}"}}]}),
                    "tool_calls",
                );
            }
            *state.failure.lock().await =
                Some("Native engine did not offer the connected MCP tool".into());
            return response(
                json!({"role":"assistant","content":"MCP_TOOL_MISSING"}),
                "stop",
            );
        }
        if messages.iter().any(|m| {
            m.to_string()
                .contains("A skill for authoring and iteratively improving local ZCode skills.")
        }) {
            state.skill_seen.store(true, Ordering::Release);
        } else {
            *state.failure.lock().await = Some(
                "Native skill activation did not supply actual bundled skill instructions".into(),
            );
        }
        response(
            json!({"role":"assistant","content":"SKILL_NATIVE_ACTIVATED"}),
            "stop",
        )
    }

    pub fn mcp_fixture(proof: &Path) -> Result<()> {
        for line in std::io::stdin().lock().lines() {
            let request: Value = serde_json::from_str(&line?)?;
            let Some(id) = request.get("id") else {
                continue;
            };
            let result = match request["method"].as_str().unwrap_or_default() {
                "initialize" => {
                    json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"owned-extensions-fixture","version":"1.0.0"}})
                }
                "tools/list" => {
                    json!({"tools":[{"name":"extension_probe","description":"Writes a marker only in this owned test fixture.","inputSchema":{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}}]})
                }
                "tools/call" => {
                    ensure!(
                        request["params"]["name"] == "extension_probe",
                        "unexpected fixture tool"
                    );
                    ensure!(
                        request["params"]["arguments"]["message"] == "MCP_NATIVE_TOOL_OK",
                        "unexpected fixture arguments"
                    );
                    std::fs::write(proof, b"MCP_NATIVE_TOOL_OK")?;
                    json!({"content":[{"type":"text","text":"MCP_NATIVE_TOOL_OK"}],"isError":false})
                }
                "resources/list" => json!({"resources":[]}),
                "prompts/list" => json!({"prompts":[]}),
                "ping" => json!({}),
                _ => {
                    continue;
                }
            };
            println!("{}", json!({"jsonrpc":"2.0","id":id,"result":result}));
            std::io::stdout().flush()?;
        }
        Ok(())
    }

    async fn wait_done(engine: &Engine, id: &str, text: &str) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(35);
        loop {
            ensure!(
                Instant::now() < deadline,
                "Owned native extension turn timed out"
            );
            let snapshot = engine.snapshot(id).await.map_err(|e| anyhow!(e))?;
            for permission in &snapshot.permissions {
                ensure!(
                    permission
                        .tool_name
                        .as_deref()
                        .is_some_and(|n| n.contains("extension_probe"))
                        || permission.action.contains("extension_probe"),
                    "unexpected permission in bounded MCP smoke"
                );
                engine
                    .reply_permission(id, &permission.id, "once")
                    .await
                    .map_err(|e| anyhow!(e))?;
            }
            if snapshot.status == AgentStatus::Error {
                bail!("Owned native extension execution failed");
            }
            if snapshot.status == AgentStatus::Idle
                && snapshot.messages.iter().any(|m| {
                    m.role == "assistant"
                        && m.parts
                            .iter()
                            .any(|p| matches!(p,AgentPart::Text{text:t}if t.contains(text)))
                })
            {
                ensure!(snapshot.error.is_none(), "snapshot has an error");
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }

    async fn registry_ready(engine: &Engine, project: &Path) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let inventory = engine.list_plugins(project).await.map_err(|e| anyhow!(e))?;
            if let Some(skill_loader) = inventory
                .iter()
                .find(|p| p.id.as_deref() == Some("opencode.config.skill"))
            {
                ensure!(
                    skill_loader.status != "failed",
                    "native skill discovery plugin failed"
                );
                if skill_loader.status == "active" {
                    return Ok(());
                }
            }
            ensure!(
                Instant::now() < deadline,
                "native extension registry never became ready"
            );
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
    async fn exercise(
        engine: &Engine,
        project: &Path,
        state: &Fake,
        proof: &Path,
        store: &AgentExtensionStore,
        revision: u64,
    ) -> Result<()> {
        registry_ready(engine, project).await?;
        let skills = engine.list_skills(project).await.map_err(|e| anyhow!(e))?;
        println!(
            "Native skills fact: count={}, names={}",
            skills.len(),
            skills
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>()
                .join(",")
        );
        let plugin_facts = engine.list_plugins(project).await.map_err(|e| anyhow!(e))?;
        for plugin in &plugin_facts {
            println!(
                "Native plugin fact: id={}, source_type={}, target_present={}, status={}",
                plugin.id.as_deref().unwrap_or("none"),
                plugin.source_type,
                plugin.target.is_some(),
                plugin.status
            );
        }
        for name in ["skill-creator", "docx", "pdf", "pptx", "xlsx"] {
            ensure!(
                skills.iter().any(|s| s.name == name),
                "bundled native skill missing: {name}"
            );
        }
        println!("PASS 1: real engine discovered five pinned ZCode content skills");
        let plugins = engine.list_plugins(project).await.map_err(|e| anyhow!(e))?;
        ensure!(
            plugins
                .iter()
                .any(|p| p.id.as_deref() == Some("lolicode.extensions.fixture")
                    && p.status == "active"),
            "real native v2 plugin did not become active"
        );
        if let Some(plugin) = plugins
            .iter()
            .find(|p| p.id.as_deref() == Some("lolicode.extensions.fixture"))
        {
            println!(
                "Native plugin fact: source_type={}, target_present={}",
                plugin.source_type,
                plugin.target.is_some()
            );
        }
        println!("PASS 2: real native v2 plugin loaded and reported active");
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let mcp = engine.list_mcp(project).await.map_err(|e| anyhow!(e))?;
            if mcp
                .iter()
                .any(|m| m.name == "owned-fixture" && m.status == "connected")
            {
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "real local MCP server is not connected"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let session = engine
            .create_session(
                project,
                &AgentModelRef {
                    provider_id: "lolicode".into(),
                    model_id: "extensions/probe".into(),
                },
                "build",
                Some("Owned extension smoke"),
            )
            .await
            .map_err(|e| anyhow!(e))?;
        let skill = skills.iter().find(|s| s.name == "skill-creator").unwrap();
        engine
            .activate_skill(&session.id, &skill.id)
            .await
            .map_err(|e| anyhow!(e))?;
        wait_done(engine, &session.id, "SKILL_NATIVE_ACTIVATED").await?;
        ensure!(
            state.skill_seen.load(Ordering::Acquire),
            "actual skill body never reached model"
        );
        println!("PASS 3: native skill activation supplied actual bundled instructions and resumed the real session");
        engine.send_message(&session.id,"LOLICODE_MCP_EXECUTION_PROBE: call the owned extension_probe tool exactly once with message MCP_NATIVE_TOOL_OK, then finish.","extensions_mcp_probe").await.map_err(|e|anyhow!(e))?;
        wait_done(engine, &session.id, "MCP_NATIVE_EXECUTED").await?;
        ensure!(
            state.mcp_seen.load(Ordering::Acquire)
                && state.tool_result_seen.load(Ordering::Acquire),
            "real native MCP tool roundtrip missing"
        );
        ensure!(
            std::fs::read_to_string(proof)? == "MCP_NATIVE_TOOL_OK",
            "MCP process did not perform the owned test side effect"
        );
        ensure!(
            state.failure.lock().await.is_none(),
            "offline model contract failed"
        );
        println!("PASS 4: real MCP process executed a tool; native agent received its tool result");
        let catalog = AgentCatalog {
            revision: 1,
            models: vec![AgentCatalogModel {
                id: "lolicode/extensions/probe".into(),
                provider_id: "lolicode".into(),
                model_id: "extensions/probe".into(),
                name: "Owned fake fixture".into(),
                channel_name: "Offline fixture".into(),
                context_limit: Some(131072),
                output_limit: Some(1024),
                reasoning_efforts: None,
            }],
            default_model: Some("lolicode/extensions/probe".into()),
            excluded_sources: vec![],
        };
        let host = AgentState::from_test_engine(
            Arc::new(engine.clone()),
            Arc::new(Database::memory()?),
            catalog,
            vec![project.to_path_buf()],
        )
        .await
        .map_err(|e| anyhow!(e))?;
        host.bind_test_extension_revision(revision)
            .await
            .map_err(|e| anyhow!(e))?;
        let view = extensions_runtime_catalog(&host, store.list()?)
            .await
            .map_err(|e| anyhow!(e))?;
        ensure!(
            view["pendingReload"] == false,
            "applied private extension revision did not match production IPC metadata"
        );
        ensure!(
            view["skills"]
                .as_array()
                .is_some_and(|items| items.len() == 5
                    && items
                        .iter()
                        .all(|item| item["loaded"] == true && item["runtimeId"].is_string())),
            "production IPC view did not match five native loaded skills"
        );
        ensure!(
            view["plugins"]
                .as_array()
                .is_some_and(|items| items.len() == 1
                    && items[0]["loaded"] == true
                    && items[0]["runtimeStatus"] == "active"),
            "production IPC view failed to identify owned loaded plugin"
        );
        ensure!(
            view["mcpServers"]
                .as_array()
                .is_some_and(|items| items.len() == 1
                    && items[0]["loaded"] == true
                    && items[0]["runtimeStatus"] == "connected"),
            "production IPC view failed to identify connected MCP"
        );
        println!("PASS 4b: production desktop IPC view matched actual native skill IDs, owned plugin identity, MCP connection and applied revision");
        Ok(())
    }

    pub async fn run() -> Result<()> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let temp = tempfile::tempdir()?;
        let project = temp.path().join("project");
        std::fs::create_dir(&project)?;
        let store = AgentExtensionStore::new(
            temp.path().join("extension-store"),
            root.join("resources/agent/extensions"),
        )?;
        let plugin = temp.path().join("fixture.mjs");
        std::fs::write(
            &plugin,
            "export default { id:'lolicode.extensions.fixture', async setup() {} };\n",
        )?;
        let plugin_id = store.install_plugin(&plugin)?.plugins[0].id.clone();
        let proof = temp.path().join("mcp-proof.txt");
        let mut extension_config = store.config()?;
        extension_config.mcp = json!({"timeout":{"startup":10000,"catalog":10000,"execution":10000},"servers":{"owned-fixture":{"type":"local","codemode":false,"command":[std::env::current_exe()?.to_string_lossy(),"--mcp-fixture",proof.to_string_lossy()]}}});
        store.save_config(extension_config)?;
        let fake = Fake::default();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let base = format!("http://127.0.0.1:{}/v1", listener.local_addr()?.port());
        let router = Router::new()
            .route("/v1/chat/completions", post(chat))
            .with_state(fake.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let private = temp.path().join("private-engine");
        let mut config = json!({"providers":{"lolicode":{"name":"Owned offline fixture","package":"@ai-sdk/openai-compatible","settings":{"baseURL":base,"apiKey":"local-fake-only"},"models":{"extensions/probe":{"modelID":"extensions/probe","name":"Offline extensions fixture","limit":{"context":131072,"output":1024}}}}},"model":"lolicode/extensions/probe","default_agent":"build","update":"disable","share":"disabled","snapshots":false,"permissions":[{"action":"*","resource":"*","effect":"ask"}],"experimental":{"policies":[{"action":"provider.use","resource":"*","effect":"deny"},{"action":"provider.use","resource":"lolicode","effect":"allow"}]}});
        let revision = store.project_runtime(&private, &mut config)?;
        let mounts = config["skills"]
            .as_array()
            .ok_or_else(|| anyhow!("skills projection missing"))?;
        ensure!(
            mounts.len() == 5
                && mounts.iter().all(|p| p
                    .as_str()
                    .is_some_and(|p| Path::new(p).join("SKILL.md").is_file())),
            "private projection did not prepare all five actual SKILL.md files"
        );
        println!("Private skills fact: five readable SKILL.md mounts prepared");
        let engine = Engine::launch(EngineOptions {
            executable: root.join("resources/agent/opencode.exe"),
            private_root: private.clone(),
            config,
        })
        .await
        .map_err(|e| anyhow!(e))?;
        let result = tokio::time::timeout(
            Duration::from_secs(90),
            exercise(&engine, &project, &fake, &proof, &store, revision),
        )
        .await
        .context("owned extensions smoke timed out")
        .and_then(|r| r);
        let cleanup = engine.shutdown().await.map_err(|e| anyhow!(e));
        server.abort();
        cleanup?;
        result?;
        store.set_skill_enabled("zcode-skill-creator", false)?;
        store.set_plugin_enabled(&plugin_id, false)?;
        let mut settings = store.config()?;
        settings.mcp["servers"]["owned-fixture"]["disabled"] = json!(true);
        store.save_config(settings)?;
        let mut reload = json!({"update":"disable","share":"disabled","snapshots":false});
        store.project_runtime(&private, &mut reload)?;
        let restored = Engine::launch(EngineOptions {
            executable: root.join("resources/agent/opencode.exe"),
            private_root: private,
            config: reload,
        })
        .await
        .map_err(|e| anyhow!(e))?;
        let verify = async {
            registry_ready(&restored, &project).await?;
            ensure!(
                !restored
                    .list_skills(&project)
                    .await
                    .map_err(|e| anyhow!(e))?
                    .iter()
                    .any(|s| s.name == "skill-creator"),
                "disabled skill still native-discoverable"
            );
            ensure!(
                !restored
                    .list_plugins(&project)
                    .await
                    .map_err(|e| anyhow!(e))?
                    .iter()
                    .any(|p| p.id.as_deref() == Some("lolicode.extensions.fixture")),
                "disabled plugin still active"
            );
            ensure!(
                restored
                    .list_mcp(&project)
                    .await
                    .map_err(|e| anyhow!(e))?
                    .iter()
                    .any(|m| m.name == "owned-fixture" && m.status == "disabled"),
                "MCP disable did not reach native engine"
            );
            Ok::<(), anyhow::Error>(())
        }
        .await;
        let cleanup = restored.shutdown().await.map_err(|e| anyhow!(e));
        cleanup?;
        verify?;
        ensure!(plugin.is_file(), "original plugin changed");
        println!("PASS 5: enable/disable persisted and changed real engine discovery after isolated reload; owned processes stopped");
        Ok(())
    }
}

#[cfg(feature = "test-hooks")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--mcp-fixture") {
        return smoke::mcp_fixture(std::path::Path::new(
            args.get(2)
                .ok_or_else(|| anyhow::anyhow!("missing owned MCP proof path"))?,
        ));
    }
    smoke::run().await
}
