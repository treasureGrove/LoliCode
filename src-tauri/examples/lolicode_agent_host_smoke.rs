//! Real owned-engine verification of the desktop carrier and Auto permissions.
//! Requires test-hooks; only temp projects and an in-process fake model are used.

#[cfg(not(feature = "test-hooks"))]
fn main() {
    eprintln!("Run with --features test-hooks.");
}

#[cfg(feature = "test-hooks")]
mod smoke {
    use anyhow::{anyhow, bail, ensure, Result};
    use axum::{
        body::Body, extract::State, http::header, response::Response, routing::post, Json, Router,
    };
    use lolicode_lib::{
        agent_test_support::{
            channel_center::{AgentCatalog, AgentCatalogModel},
            AgentState,
        },
        Database,
    };
    use lolicode_agent::{AgentPart, AgentStatus, Engine, EngineOptions};
    use serde_json::{json, Value};
    use std::{
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tokio::{net::TcpListener, time::Instant};

    #[derive(Clone, Default)]
    struct Fake {
        safe_executed: Arc<AtomicBool>,
        switch_seen: Arc<AtomicBool>,
        unsafe_attempted: Arc<AtomicBool>,
        requests: Arc<AtomicUsize>,
        unsafe_attempts: Arc<AtomicUsize>,
        retry_seen: Arc<AtomicBool>,
        plan_write_filtered: Arc<AtomicBool>,
        native_bootstrap: Arc<AtomicUsize>,
        failures: Arc<tokio::sync::Mutex<Vec<String>>>,
    }
    fn stream(delta: Value, finish: &str) -> Response {
        let chunk = json!({"id":"chatcmpl_host","object":"chat.completion.chunk","created":1,"model":"host/first","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = json!({"id":"chatcmpl_host","object":"chat.completion.chunk","created":1,"model":"host/first","choices":[{"index":0,"delta":{},"finish_reason":finish}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}});
        Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(format!(
                "data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"
            )))
            .unwrap()
    }
    fn text(body: &Value, marker: &str) -> bool {
        body["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|m| m["content"].to_string().contains(marker))
    }
    fn result(body: &Value, id: &str) -> bool {
        body["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|m| m["role"] == "tool" && m["tool_call_id"] == id)
    }
    fn tool(body: &Value, name: &str, args: Value, id: &str) -> Result<Response> {
        let supplied = body["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["function"]["name"] == name)
            .ok_or_else(|| anyhow!("real native {name} tool absent"))?;
        for required in supplied["function"]["parameters"]["required"]
            .as_array()
            .into_iter()
            .flatten()
        {
            ensure!(
                args.get(required.as_str().unwrap_or_default()).is_some(),
                "unsupported actual {name} schema requirement"
            );
        }
        Ok(stream(
            json!({"role":"assistant","tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":args.to_string()}}]}),
            "tool_calls",
        ))
    }
    async fn chat(State(state): State<Fake>, Json(body): Json<Value>) -> Response {
        state.requests.fetch_add(1, Ordering::AcqRel);
        let operation = (|| -> Result<Response> {
            if text(&body, "LOLICODE_HOST_RETRY") {
                state.retry_seen.store(true, Ordering::Release);
                return Ok(stream(
                    json!({"role":"assistant","content":"HOST_RETRY_DONE"}),
                    "stop",
                ));
            }
            if result(&body, "call_host_safe") {
                state.safe_executed.store(true, Ordering::Release);
                return Ok(stream(
                    json!({"role":"assistant","content":"HOST_AUTO_SAFE_DONE"}),
                    "stop",
                ));
            }
            if result(&body, "call_host_unsafe") {
                return Ok(stream(
                    json!({"role":"assistant","content":"HOST_UNSAFE_REJECTED"}),
                    "stop",
                ));
            }
            if result(&body, "call_host_ask") {
                return Ok(stream(
                    json!({"role":"assistant","content":"HOST_ASK_REJECTED"}),
                    "stop",
                ));
            }
            if result(&body, "call_host_plan") {
                return Ok(stream(
                    json!({"role":"assistant","content":"HOST_PLAN_REJECTED"}),
                    "stop",
                ));
            }
            if text(&body, "LOLICODE_HOST_MODEL_SWITCH") {
                state
                    .switch_seen
                    .store(body["model"] == "host/second", Ordering::Release);
                return Ok(stream(
                    json!({"role":"assistant","content":"HOST_MODEL_SWITCH_DONE"}),
                    "stop",
                ));
            }
            if text(&body, "LOLICODE_HOST_AUTO_SAFE") {
                return tool(
                    &body,
                    "shell",
                    json!({"command":"node --version","description":"Read Node version in owned fixture."}),
                    "call_host_safe",
                );
            }
            if text(&body, "LOLICODE_HOST_UNSAFE") {
                state.unsafe_attempted.store(true, Ordering::Release);
                state.unsafe_attempts.fetch_add(1, Ordering::AcqRel);
                return tool(
                    &body,
                    "shell",
                    json!({"command":"node --version > unsafe-proof.txt","description":"Deliberately unsafe redirection; host must require confirmation."}),
                    "call_host_unsafe",
                );
            }
            if text(&body, "LOLICODE_HOST_ASK") {
                return tool(
                    &body,
                    "write",
                    json!({"path":"ask-proof.txt","content":"MUST_NOT_WRITE"}),
                    "call_host_ask",
                );
            }
            if text(&body, "LOLICODE_HOST_PLAN") {
                let write_supplied = body["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|t| t["function"]["name"] == "write");
                if !write_supplied {
                    state.plan_write_filtered.store(true, Ordering::Release);
                    return Ok(stream(
                        json!({"role":"assistant","content":"HOST_PLAN_WRITE_UNAVAILABLE"}),
                        "stop",
                    ));
                }
                return tool(
                    &body,
                    "write",
                    json!({"path":"plan-proof.txt","content":"MUST_NOT_WRITE"}),
                    "call_host_plan",
                );
            }
            // The official Plan agent can consume a synthetic bootstrap input
            // before the explicit user prompt. It requires an ordinary model
            // response, and must not be counted as an attempted tool call.
            if body["model"] == "host/first"
                && !text(&body, "LOLICODE_HOST_")
                && !body["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|t| t["function"]["name"] == "write")
            {
                state.native_bootstrap.fetch_add(1, Ordering::AcqRel);
                return Ok(stream(
                    json!({"role":"assistant","content":"HOST_PLAN_READY"}),
                    "stop",
                ));
            }
            bail!("unexpected offline host prompt")
        })();
        match operation {
            Ok(response) => response,
            Err(error) => {
                state.failures.lock().await.push(error.to_string());
                stream(
                    json!({"role":"assistant","content":"HOST_CONTRACT_FAILURE"}),
                    "stop",
                )
            }
        }
    }
    async fn wait_text(host: &AgentState, id: &str, needle: &str) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            ensure!(Instant::now() < deadline, "host turn timed out");
            let snapshot = host.snapshot(id).await.map_err(|e| anyhow!(e))?;
            ensure!(
                snapshot.status != AgentStatus::Error,
                "host snapshot failed"
            );
            if snapshot.status == AgentStatus::Idle
                && snapshot.messages.iter().any(|m| {
                    m.role == "assistant"
                        && m.parts
                            .iter()
                            .any(|p| matches!(p,AgentPart::Text{text}if text.contains(needle)))
                })
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }
    async fn wait_permission(host: &AgentState, id: &str, expected: &str) -> Result<String> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            ensure!(
                Instant::now() < deadline,
                "host confirmation did not appear"
            );
            let snapshot = host.snapshot(id).await.map_err(|e| anyhow!(e))?;
            if let Some(permission) = snapshot.permissions.first() {
                ensure!(
                    permission.action == expected,
                    "unexpected permission action"
                );
                return Ok(permission.id.clone());
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }
    async fn wait_terminal(
        host: &AgentState,
        engine: &Engine,
        id: &str,
        label: &str,
    ) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            let snapshot = host.snapshot(id).await.map_err(|e| anyhow!(e))?;
            if matches!(snapshot.status, AgentStatus::Idle | AgentStatus::Error)
                && snapshot.permissions.is_empty()
                && snapshot.questions.is_empty()
            {
                let states = snapshot
                    .messages
                    .iter()
                    .flat_map(|m| m.parts.iter())
                    .filter_map(|p| {
                        if let AgentPart::Tool { name, state, .. } = p {
                            Some(format!("{name}:{state}"))
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                println!("Native terminal fact: probe={label}, status={:?}, error_present={}, tools={states}",snapshot.status,snapshot.error.is_some());
                return Ok(());
            }
            if Instant::now() >= deadline {
                println!("Native timeout fact: probe={label}, status={:?}, error_present={}, permissions={}, questions={}",snapshot.status,snapshot.error.is_some(),snapshot.permissions.len(),snapshot.questions.len());
                println!(
                    "Native lifecycle diagnosis: {}",
                    engine
                        .lifecycle_diagnostic(id)
                        .await
                        .map_err(|e| anyhow!(e))?
                );
                bail!("native rejected/denied task did not reach a terminal status");
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }
    fn catalog() -> AgentCatalog {
        AgentCatalog {
            revision: 1,
            models: ["first", "second"]
                .into_iter()
                .map(|name| AgentCatalogModel {
                    id: format!("lolicode/host/{name}"),
                    provider_id: "lolicode".into(),
                    model_id: format!("host/{name}"),
                    name: format!("Owned {name}"),
                    channel_name: "Offline fixture".into(),
                    is_free: false,
                    context_limit: Some(131072),
                    context_limits: None,
                    max_request_bytes: None,
                    output_limit: Some(1024),
                    reasoning_efforts: None,
                    reasoning_effort_source: None,
                    reasoning_effort_transport: None,
                })
                .collect(),
            default_model: Some("lolicode/host/first".into()),
            excluded_sources: vec![],
        }
    }
    async fn exercise(engine: Arc<Engine>, projects: &[PathBuf], fake: &Fake) -> Result<String> {
        let db = Arc::new(Database::memory()?);
        let host =
            AgentState::from_test_engine(engine.clone(), db.clone(), catalog(), projects.to_vec())
                .await
                .map_err(|e| anyhow!(e))?;
        let auto = host
            .create_session(
                "lolicode/host/first",
                "build",
                Some("Owned Auto fixture"),
                "auto",
            )
            .await
            .map_err(|e| anyhow!(e))?;
        host.send(
            &auto.id,
            "LOLICODE_HOST_AUTO_SAFE: use shell node --version then finish.",
            "host_auto_safe",
        )
        .await
        .map_err(|e| anyhow!(e))?;
        // Selecting another owned project carrier does not kill A's background
        // monitor. Its native task must complete without a manual permission call.
        let other = AgentState::from_test_engine(
            engine.clone(),
            db.clone(),
            catalog(),
            vec![projects[1].clone(), projects[0].clone()],
        )
        .await
        .map_err(|e| anyhow!(e))?;
        let second = other
            .create_session(
                "lolicode/host/first",
                "build",
                Some("Owned second-project fixture"),
                "auto",
            )
            .await
            .map_err(|e| anyhow!(e))?;
        wait_text(&host, &auto.id, "HOST_AUTO_SAFE_DONE").await?;
        ensure!(
            fake.safe_executed.load(Ordering::Acquire),
            "Auto failed to resume a safe native shell tool"
        );
        let proof = host.snapshot(&auto.id).await.map_err(|e| anyhow!(e))?;
        ensure!(proof.messages.iter().any(|m|m.parts.iter().any(|p|matches!(p,AgentPart::Tool{name,state,output:Some(output),..}if name=="shell"&&state=="completed"&&output.contains('v')))),"native Node version output absent");
        ensure!(
            other
                .list_sessions(Some(&projects[1].to_string_lossy()), true)
                .await
                .map_err(|e| anyhow!(e))?
                .iter()
                .any(|s| s.id == second.id),
            "second project's native session absent"
        );
        println!("PASS H1: desktop carrier Auto completed real node --version while a second project carrier was selected");

        let unsafe_session = host
            .create_session(
                "lolicode/host/first",
                "build",
                Some("Owned unsafe fixture"),
                "auto",
            )
            .await
            .map_err(|e| anyhow!(e))?;
        host.send(
            &unsafe_session.id,
            "LOLICODE_HOST_UNSAFE: request a deliberately redirected version command.",
            "host_unsafe",
        )
        .await
        .map_err(|e| anyhow!(e))?;
        let permission = wait_permission(&host, &unsafe_session.id, "shell").await?;
        tokio::time::sleep(Duration::from_millis(1600)).await;
        ensure!(
            host.snapshot(&unsafe_session.id)
                .await
                .map_err(|e| anyhow!(e))?
                .permissions
                .iter()
                .any(|p| p.id == permission),
            "Auto bypassed unsafe shell confirmation"
        );
        ensure!(
            !projects[0].join("unsafe-proof.txt").exists(),
            "unsafe shell redirection executed"
        );
        host.permission(&unsafe_session.id, &permission, "reject")
            .await
            .map_err(|e| anyhow!(e))?;
        wait_terminal(&host, &engine, &unsafe_session.id, "unsafe-reject").await?;
        host.send(
            &unsafe_session.id,
            "LOLICODE_HOST_RETRY: answer briefly; do not use tools.",
            "host_retry_after_reject",
        )
        .await
        .map_err(|e| anyhow!(e))?;
        wait_text(&host, &unsafe_session.id, "HOST_RETRY_DONE").await?;
        ensure!(
            fake.retry_seen.load(Ordering::Acquire),
            "same rejected session could not accept and finish a new prompt"
        );
        println!("PASS H2: Auto preserved shell redirection confirmation; rejection left no file and the same session accepted a new prompt");

        let ask = host
            .create_session(
                "lolicode/host/first",
                "build",
                Some("Owned Ask fixture"),
                "ask",
            )
            .await
            .map_err(|e| anyhow!(e))?;
        host.send(
            &ask.id,
            "LOLICODE_HOST_ASK: attempt write ask-proof.txt.",
            "host_ask",
        )
        .await
        .map_err(|e| anyhow!(e))?;
        let permission = wait_permission(&host, &ask.id, "edit").await?;
        host.permission(&ask.id, &permission, "reject")
            .await
            .map_err(|e| anyhow!(e))?;
        wait_terminal(&host, &engine, &ask.id, "ask-reject").await?;
        ensure!(
            !projects[0].join("ask-proof.txt").exists(),
            "Ask write escaped confirmation"
        );
        let plan = host
            .create_session(
                "lolicode/host/first",
                "plan",
                Some("Owned Plan fixture"),
                "full_access",
            )
            .await
            .map_err(|e| anyhow!(e))?;
        host.send(
            &plan.id,
            "LOLICODE_HOST_PLAN: malicious fake provider attempts write.",
            "host_plan",
        )
        .await
        .map_err(|e| anyhow!(e))?;
        wait_terminal(&host, &engine, &plan.id, "plan-deny").await?;
        ensure!(
            !projects[0].join("plan-proof.txt").exists(),
            "Plan wrote a file"
        );
        ensure!(
            fake.plan_write_filtered.load(Ordering::Acquire),
            "native Plan did not exclude write from its real model tool schema"
        );
        println!("PASS H3: real Ask write required approval and Plan excluded write even with full_access selected");
        let switched_mode = host
            .update_session(&plan.id, None, Some("build"), None)
            .await
            .map_err(|e| anyhow!(e))?;
        ensure!(
            switched_mode.mode == "build",
            "mode-only update did not change the native agent"
        );

        let updated = host
            .update_session(
                &auto.id,
                Some("lolicode/host/second"),
                Some("build"),
                Some("ask"),
            )
            .await
            .map_err(|e| anyhow!(e))?;
        ensure!(
            updated
                .model
                .as_ref()
                .is_some_and(|m| m.model_id == "host/second")
                && updated.permission_mode == "ask",
            "host model/policy update did not persist"
        );
        // A clean session avoids reusing the earlier safe-tool branch in fake chat.
        let switched = host
            .create_session(
                "lolicode/host/first",
                "build",
                Some("Owned model-switch fixture"),
                "auto",
            )
            .await
            .map_err(|e| anyhow!(e))?;
        host.update_session(
            &switched.id,
            Some("lolicode/host/second"),
            None,
            Some("ask"),
        )
        .await
        .map_err(|e| anyhow!(e))?;
        host.send(
            &switched.id,
            "LOLICODE_HOST_MODEL_SWITCH: answer briefly.",
            "host_model_switch",
        )
        .await
        .map_err(|e| anyhow!(e))?;
        wait_text(&host, &switched.id, "HOST_MODEL_SWITCH_DONE").await?;
        ensure!(
            fake.switch_seen.load(Ordering::Acquire),
            "native model request did not switch modelID"
        );
        host.rename_session(&switched.id, "Renamed owned fixture")
            .await
            .map_err(|e| anyhow!(e))?;
        host.session_metadata(&switched.id, Some(true), Some(true))
            .await
            .map_err(|e| anyhow!(e))?;
        ensure!(
            !host
                .list_sessions(None, false)
                .await
                .map_err(|e| anyhow!(e))?
                .iter()
                .any(|s| s.id == switched.id),
            "archived session remains in visible list"
        );
        let restored =
            AgentState::from_test_engine(engine.clone(), db, catalog(), projects.to_vec())
                .await
                .map_err(|e| anyhow!(e))?;
        let all = restored
            .list_sessions(None, true)
            .await
            .map_err(|e| anyhow!(e))?;
        ensure!(
            all.iter().any(|s| s.id == switched.id
                && s.title == "Renamed owned fixture"
                && s.pinned
                && s.archived),
            "session pin/archive/rename failed to persist"
        );
        restored
            .session_metadata(&switched.id, None, Some(false))
            .await
            .map_err(|e| anyhow!(e))?;
        if let Err(error) = restored.delete_session(&switched.id).await {
            for (label, id) in [
                ("delete-target", switched.id.as_str()),
                ("auto", auto.id.as_str()),
                ("project-b", second.id.as_str()),
                ("unsafe-retry", unsafe_session.id.as_str()),
                ("ask-reject", ask.id.as_str()),
                ("plan-deny", plan.id.as_str()),
            ] {
                println!(
                    "Native delete diagnosis: probe={label}, facts={}",
                    engine
                        .lifecycle_diagnostic(id)
                        .await
                        .map_err(|e| anyhow!(e))?
                );
            }
            return Err(anyhow!(error));
        }
        ensure!(
            !restored
                .list_sessions(None, true)
                .await
                .map_err(|e| anyhow!(e))?
                .iter()
                .any(|s| s.id == switched.id),
            "native session deletion failed"
        );
        ensure!(
            fake.failures.lock().await.is_empty(),
            "offline host contract mismatch"
        );
        // Keep a different rejected session untouched after rejection. Retrying
        // that session would release the claim and hide native restart defects.
        let rejected = restored
            .create_session(
                "lolicode/host/first",
                "build",
                Some("Owned restart-decline fixture"),
                "auto",
            )
            .await
            .map_err(|e| anyhow!(e))?;
        restored.send(&rejected.id,"LOLICODE_HOST_UNSAFE: deliberately request redirected version read for restart cancellation verification.","host_restart_reject").await.map_err(|e|anyhow!(e))?;
        let permission = wait_permission(&restored, &rejected.id, "shell").await?;
        restored
            .permission(&rejected.id, &permission, "reject")
            .await
            .map_err(|e| anyhow!(e))?;
        wait_terminal(&restored, &engine, &rejected.id, "restart-decline").await?;
        ensure!(
            !projects[0].join("unsafe-proof.txt").exists(),
            "rejected restart fixture executed redirected shell"
        );
        ensure!(
            !engine.has_active_sessions().await.map_err(|e| anyhow!(e))?,
            "deleted session left the engine's tracked state busy"
        );
        restored.close_project().await.map_err(|e| anyhow!(e))?;
        println!("PASS H4: native model/policy switch, rename, archive/pin reload, deletion and closing the carrier persisted without stale active-session state");
        restored.shutdown().await.map_err(|e| anyhow!(e))?;
        ensure!(!engine.is_running(), "owned engine still running");
        Ok(rejected.id)
    }
    pub async fn run() -> Result<()> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let temp = tempfile::tempdir()?;
        let projects = vec![temp.path().join("project-a"), temp.path().join("project-b")];
        for project in &projects {
            std::fs::create_dir(project)?;
        }
        let fake = Fake::default();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let base = format!("http://127.0.0.1:{}/v1", listener.local_addr()?.port());
        let router = Router::new()
            .route("/v1/chat/completions", post(chat))
            .with_state(fake.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let config = json!({"providers":{"lolicode":{"name":"Owned fake","package":"@ai-sdk/openai-compatible","settings":{"baseURL":base,"apiKey":"local-fake-only"},"models":{"host/first":{"modelID":"host/first","limit":{"context":131072,"output":1024}},"host/second":{"modelID":"host/second","limit":{"context":131072,"output":1024}}}}},"model":"lolicode/host/first","default_agent":"build","update":"disable","share":"disabled","snapshots":false,"permissions":[{"action":"*","resource":"*","effect":"ask"}],"experimental":{"policies":[{"action":"provider.use","resource":"*","effect":"deny"},{"action":"provider.use","resource":"lolicode","effect":"allow"}]}});
        let engine = Arc::new(
            Engine::launch(EngineOptions {
                executable: root.join("resources/agent/opencode.exe"),
                private_root: temp.path().join("private-engine"),
                config: config.clone(),
            })
            .await
            .map_err(|e| anyhow!(e))?,
        );
        let result = tokio::time::timeout(
            Duration::from_secs(140),
            exercise(engine.clone(), &projects, &fake),
        )
        .await
        .map_err(|_| anyhow!("owned host smoke timed out"))
        .and_then(|r| r);
        let cleanup = engine.shutdown().await.map_err(|e| anyhow!(e));
        if cleanup.is_err() || result.is_err() {
            server.abort();
        }
        cleanup?;
        let rejected_id = result?;
        let requests = fake.requests.load(Ordering::Acquire);
        let attempts = fake.unsafe_attempts.load(Ordering::Acquire);
        // Keep the same owned fake server alive while the same native database
        // and config restart; no new user prompt is submitted to this session.
        let restarted = Engine::launch(EngineOptions {
            executable: root.join("resources/agent/opencode.exe"),
            private_root: temp.path().join("private-engine"),
            config,
        })
        .await
        .map_err(|e| anyhow!(e))?;
        let verify = async {
            let first = restarted
                .snapshot(&rejected_id)
                .await
                .map_err(|e| anyhow!(e))?;
            ensure!(
                first.permissions.is_empty(),
                "rejected task restored pending permission"
            );
            tokio::time::sleep(Duration::from_secs(2)).await;
            let after = restarted
                .snapshot(&rejected_id)
                .await
                .map_err(|e| anyhow!(e))?;
            ensure!(
                matches!(after.status, AgentStatus::Idle | AgentStatus::Error)
                    && after.permissions.is_empty(),
                "rejected task resumed after restart"
            );
            ensure!(
                !restarted
                    .has_active_sessions()
                    .await
                    .map_err(|e| anyhow!(e))?,
                "rejected task left a restored active execution"
            );
            ensure!(
                fake.requests.load(Ordering::Acquire) == requests
                    && fake.unsafe_attempts.load(Ordering::Acquire) == attempts,
                "native restart unexpectedly called the model or retried rejected shell"
            );
            ensure!(
                !projects[0].join("unsafe-proof.txt").exists(),
                "restart executed a rejected command"
            );
            Ok::<(), anyhow::Error>(())
        }
        .await;
        let cleanup = restarted.shutdown().await.map_err(|e| anyhow!(e));
        server.abort();
        cleanup?;
        verify?;
        println!("PASS H5: same private database/config restarted without any model call, permission or execution resuming an untouched rejected task");
        Ok(())
    }
}

#[cfg(feature = "test-hooks")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    smoke::run().await
}
