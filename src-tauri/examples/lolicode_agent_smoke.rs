//! Offline integration smoke for the owned OpenCode engine and shared Rust core.
//! Run: cargo run --manifest-path src-tauri/Cargo.toml --example lolicode_agent_smoke -j 2
//! Uses only owned temporary directories and an in-process loopback fake model.

use anyhow::{anyhow, bail, ensure, Context, Result};
use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use lolicode_agent::{AgentModelRef, AgentPart, AgentSnapshot, AgentStatus, Engine, EngineOptions};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{net::TcpListener, process::Command, sync::Mutex, time::Instant};

const CONTENT: &str = "Lolicode real-engine smoke passed.\n";
const BUILD_PROMPT: &str = "LOLICODE_BUILD_SMOKE: use the write tool to create probe.txt in the current project containing exactly 'Lolicode real-engine smoke passed.' followed by a newline, then report PROBE_WRITTEN. Do not run commands or access other paths.";
const PLAN_PROMPT: &str = "LOLICODE_PLAN_SAFETY_PROBE: this is a planning session. A malicious fake provider will attempt to write plan_probe.txt; the runtime must reject that operation. Do not run commands or access other paths.";
const STOP_PROMPT: &str =
    "LOLICODE_STOP_PROBE: return a slow text stream. Do not call tools or change files.";

#[derive(Clone)]
struct FakeModel {
    project: PathBuf,
    write_tool: Arc<Mutex<Option<(String, Value)>>>,
    build_requests: Arc<AtomicUsize>,
    tool_result_seen: Arc<AtomicBool>,
    plan_attempted: Arc<AtomicBool>,
    plan_result_seen: Arc<AtomicBool>,
    stop_started: Arc<AtomicBool>,
    stop_dropped: Arc<AtomicBool>,
    failures: Arc<Mutex<Vec<String>>>,
}

impl FakeModel {
    fn new(project: PathBuf) -> Self {
        Self {
            project,
            write_tool: Arc::new(Mutex::new(None)),
            build_requests: Arc::new(AtomicUsize::new(0)),
            tool_result_seen: Arc::new(AtomicBool::new(false)),
            plan_attempted: Arc::new(AtomicBool::new(false)),
            plan_result_seen: Arc::new(AtomicBool::new(false)),
            stop_started: Arc::new(AtomicBool::new(false)),
            stop_dropped: Arc::new(AtomicBool::new(false)),
            failures: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

fn content_text(message: &Value) -> String {
    if let Some(text) = message["content"].as_str() {
        return text.to_owned();
    }
    message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn has_tool_result(body: &Value, call_id: &str) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages
            .iter()
            .any(|message| message["role"] == "tool" && message["tool_call_id"] == call_id)
    })
}

fn write_arguments(parameters: &Value, path: &Path) -> Result<Value> {
    let properties = parameters["properties"]
        .as_object()
        .ok_or_else(|| anyhow!("write schema has no properties"))?;
    let path_key = ["path", "filePath", "file_path"]
        .into_iter()
        .find(|key| properties.contains_key(*key))
        .ok_or_else(|| anyhow!("write schema has no recognized path property"))?;
    ensure!(
        properties.contains_key("content"),
        "write schema has no content property"
    );
    let mut args = json!({"content": CONTENT});
    args[path_key] = json!(path.to_string_lossy());
    for required in parameters["required"].as_array().into_iter().flatten() {
        let key = required
            .as_str()
            .ok_or_else(|| anyhow!("invalid required property"))?;
        ensure!(
            args.get(key).is_some(),
            "unsupported required write property"
        );
    }
    Ok(args)
}

fn offered_write_tool(body: &Value, path: &Path) -> Result<(String, Value)> {
    let tools = body["tools"]
        .as_array()
        .filter(|tools| !tools.is_empty())
        .ok_or_else(|| anyhow!("real engine did not offer tool schemas"))?;
    for tool in tools {
        let function = &tool["function"];
        let name = function["name"].as_str().unwrap_or_default();
        if matches!(name, "write" | "write_file" | "file_write") {
            return Ok((name.into(), write_arguments(&function["parameters"], path)?));
        }
    }
    bail!("real engine did not offer a supported write tool")
}

fn stream_response(deltas: Vec<Value>, finish: &str, slow_text: bool) -> Response {
    let finish = finish.to_owned();
    let stream = async_stream::stream! {
        for delta in deltas {
            let chunk = json!({
                "id":"chatcmpl_lolicode_smoke", "object":"chat.completion.chunk",
                "created":1, "model":"smoke/probe",
                "choices":[{"index":0,"delta":delta,"finish_reason":null}]
            });
            yield Ok::<Bytes, Infallible>(Bytes::from(format!("data: {chunk}\n\n")));
            tokio::time::sleep(Duration::from_millis(if slow_text { 700 } else { 40 })).await;
        }
        let chunk = json!({
            "id":"chatcmpl_lolicode_smoke", "object":"chat.completion.chunk",
            "created":1, "model":"smoke/probe",
            "choices":[{"index":0,"delta":{},"finish_reason":finish}],
            "usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}
        });
        yield Ok::<Bytes, Infallible>(Bytes::from(format!("data: {chunk}\n\n")));
        yield Ok::<Bytes, Infallible>(Bytes::from_static(b"data: [DONE]\n\n"));
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .expect("static response headers")
}

fn tool_response(name: &str, args: &Value, call_id: &str) -> Response {
    let arguments = args.to_string();
    let middle = arguments
        .char_indices()
        .nth(arguments.chars().count() / 2)
        .map(|(index, _)| index)
        .unwrap_or(arguments.len());
    let (first, second) = arguments.split_at(middle);
    stream_response(
        vec![
            json!({"role":"assistant"}),
            json!({"tool_calls":[{"index":0,"id":call_id,"type":"function","function":{"name":name,"arguments":first}}]}),
            json!({"tool_calls":[{"index":0,"function":{"arguments":second}}]}),
        ],
        "tool_calls",
        false,
    )
}

struct StopStreamGuard(Arc<AtomicBool>);
impl Drop for StopStreamGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn stop_response(state: FakeModel) -> Response {
    let stream = async_stream::stream! {
        let _guard = StopStreamGuard(state.stop_dropped.clone());
        state.stop_started.store(true, Ordering::Release);
        let chunk = json!({"id":"chatcmpl_stop_probe","object":"chat.completion.chunk","created":1,"model":"smoke/probe",
            "choices":[{"index":0,"delta":{"role":"assistant","content":"STOP_PREFIX_"},"finish_reason":null}]});
        yield Ok::<Bytes, Infallible>(Bytes::from(format!("data: {chunk}\n\n")));
        // The caller must abort this real HTTP stream; there is no completed
        // response before the integration test's interrupt deadline.
        tokio::time::sleep(Duration::from_secs(60)).await;
        yield Ok::<Bytes, Infallible>(Bytes::from_static(b"data: [DONE]\n\n"));
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from_stream(stream))
        .expect("static response headers")
}

async fn fake_chat(State(state): State<FakeModel>, Json(body): Json<Value>) -> Response {
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    let is_plan = messages
        .iter()
        .any(|message| content_text(message).contains("LOLICODE_PLAN_SAFETY_PROBE"));
    let is_build = messages
        .iter()
        .any(|message| content_text(message).contains("LOLICODE_BUILD_SMOKE"));
    if messages
        .iter()
        .any(|message| content_text(message).contains("LOLICODE_STOP_PROBE"))
    {
        return stop_response(state);
    }
    if is_plan {
        if has_tool_result(&body, "call_plan_write") {
            state.plan_result_seen.store(true, Ordering::Release);
            return stream_response(
                vec![json!({"role":"assistant","content":"PLAN_BLOCKED"})],
                "stop",
                false,
            );
        }
        if !state.plan_attempted.swap(true, Ordering::AcqRel) {
            let Some((name, _)) = state.write_tool.lock().await.clone() else {
                state
                    .failures
                    .lock()
                    .await
                    .push("Plan probe has no real Build tool schema".into());
                return StatusCode::BAD_REQUEST.into_response();
            };
            // Deliberately inject the actual Build tool into Plan even if Plan
            // correctly omits it from offered tools. The engine must reject it.
            let args = json!({"path":state.project.join("plan_probe.txt").to_string_lossy(),"content":"MUST NOT BE WRITTEN\n"});
            return tool_response(&name, &args, "call_plan_write");
        }
        return stream_response(
            vec![json!({"role":"assistant","content":"PLAN_BLOCKED"})],
            "stop",
            false,
        );
    }
    if is_build {
        state.build_requests.fetch_add(1, Ordering::AcqRel);
        if has_tool_result(&body, "call_probe_write") {
            state.tool_result_seen.store(true, Ordering::Release);
            return stream_response(
                vec![
                    json!({"role":"assistant","content":"PROBE_"}),
                    json!({"content":"WRITTEN"}),
                ],
                "stop",
                true,
            );
        }
        match offered_write_tool(&body, &state.project.join("probe.txt")) {
            Ok((name, args)) => {
                *state.write_tool.lock().await = Some((name.clone(), args.clone()));
                return tool_response(&name, &args, "call_probe_write");
            }
            Err(error) => {
                state.failures.lock().await.push(error.to_string());
                return (StatusCode::BAD_REQUEST, Json(json!({"error":{"message":"Offline smoke: no usable real write tool schema"}}))).into_response();
            }
        }
    }
    // Auxiliary title/summary requests never execute a tool or affect assertions.
    if body["stream"] == true {
        stream_response(
            vec![json!({"role":"assistant","content":"Offline engine smoke"})],
            "stop",
            false,
        )
    } else {
        Json(json!({"id":"chatcmpl_aux","object":"chat.completion","created":1,"model":"smoke/probe",
            "choices":[{"index":0,"message":{"role":"assistant","content":"Offline engine smoke"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}})).into_response()
    }
}

fn config(base: &str, project: &Path) -> Value {
    let resource = format!("{}/**", project.to_string_lossy().replace('\\', "/"));
    json!({
        "providers":{"lolicode":{"name":"Offline smoke","package":"@ai-sdk/openai-compatible",
            "settings":{"baseURL":base,"apiKey":"local-fake-credential"},
            "models":{"smoke/probe":{"modelID":"smoke/probe","name":"Local fake model",
                "limit":{"context":131072,"output":4096}}}}},
        "model":"lolicode/smoke/probe", "default_agent":"build", "update":"disable",
        "share":"disabled", "snapshots":true,
        "permissions":[
            {"action":"*","resource":"*","effect":"ask"},
            {"action":"read","resource":resource,"effect":"allow"},
            {"action":"edit","resource":resource,"effect":"allow"},
            {"action":"shell","resource":"*","effect":"deny"},
            {"action":"external_directory","resource":"*","effect":"deny"}
        ],
        "experimental":{"policies":[
            {"action":"provider.use","resource":"*","effect":"deny"},
            {"action":"provider.use","resource":"lolicode","effect":"allow"}
        ]}
    })
}

async fn initialize_project(project: &Path) -> Result<()> {
    tokio::fs::create_dir_all(project).await?;
    let hooks = project.join(".smoke-hooks");
    tokio::fs::create_dir_all(&hooks).await?;
    tokio::fs::write(project.join("README.md"), "# Owned offline smoke project\n").await?;
    for args in [
        vec!["init", "--quiet"],
        vec!["add", "README.md"],
        vec![
            "-c",
            "user.name=Lolicode Smoke",
            "-c",
            "user.email=smoke@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Owned smoke baseline",
        ],
    ] {
        let mut command = Command::new("git");
        // A developer shell may export GIT_DIR/INDEX/CONFIG or global hooks.
        // None of those may redirect this fixture to a user's actual checkout.
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(key);
            }
        }
        let output = command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", project.join(".smoke-global-config"))
            .current_dir(project)
            .arg("-c")
            .arg(format!("core.hooksPath={}", hooks.to_string_lossy()))
            .args(["-c", "init.templateDir="])
            .args(args)
            .output()
            .await?;
        ensure!(
            output.status.success(),
            "failed to initialize owned temporary Git project"
        );
    }
    Ok(())
}

async fn diagnostic_metadata(private_root: &Path, project: &Path) {
    let mut git = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            git.env_remove(key);
        }
    }
    if let Ok(status) = git
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", project.join(".smoke-global-config"))
        .current_dir(project)
        .args(["status", "--porcelain", "--untracked-files=all"])
        .output()
        .await
    {
        eprintln!(
            "Owned Git metadata: {}",
            String::from_utf8_lossy(&status.stdout).trim()
        );
    }
    let path = private_root.join("data/lolicode-agent.db");
    let inspected = (|| -> Result<()> {
        let db = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        if let Ok(mut sessions) = db.prepare("SELECT data FROM session LIMIT 4") {
            if let Ok(rows) = sessions.query_map([], |row| row.get::<_, String>(0)) {
                for raw in rows.flatten() {
                    if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                        let location = &value["location"];
                        eprintln!(
                            "Owned session location metadata: directory={}",
                            location.get("directory").is_some()
                        );
                    }
                }
            }
        }
        if let Ok(mut projects) = db.prepare("SELECT data FROM project LIMIT 4") {
            if let Ok(rows) = projects.query_map([], |row| row.get::<_, String>(0)) {
                for raw in rows.flatten() {
                    if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                        eprintln!("Owned project metadata: vcs_git={}", value["vcs"] == "git");
                    }
                }
            }
        }
        let mut statement = db.prepare("SELECT data FROM session_message LIMIT 40")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        fn snapshots(value: &Value, count: &mut usize) {
            match value {
                Value::Object(object) => {
                    if let Some(snapshot) = object.get("snapshot") {
                        *count += 1;
                        eprintln!(
                            "Owned snapshot metadata: start={}, end={}, files={}",
                            snapshot.get("start").is_some(),
                            snapshot.get("end").is_some(),
                            snapshot
                                .get("files")
                                .and_then(Value::as_array)
                                .map_or(0, Vec::len)
                        );
                    }
                    for nested in object.values() {
                        snapshots(nested, count);
                    }
                }
                Value::Array(array) => {
                    for nested in array {
                        snapshots(nested, count);
                    }
                }
                _ => {}
            }
        }
        let mut count = 0;
        let mut messages = 0;
        for row in rows {
            let value: Value = serde_json::from_str(&row?)?;
            messages += 1;
            snapshots(&value, &mut count);
        }
        eprintln!("Owned persistence metadata: messages={messages}, snapshot_fields={count}");
        Ok(())
    })();
    if inspected.is_err() {
        eprintln!("Owned snapshot metadata unavailable under the configured test DB path");
    }
}

fn normalized_path(value: &str) -> String {
    value
        .trim_start_matches(r"\\?\")
        .replace('\\', "/")
        .to_ascii_lowercase()
}

async fn wait_turn(
    engine: &Engine,
    session: &str,
    project: &Path,
    plan: bool,
) -> Result<(AgentSnapshot, bool)> {
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut saw_partial = false;
    let prefix = normalized_path(&project.to_string_lossy());
    loop {
        ensure!(Instant::now() < deadline, "real engine turn timed out");
        let snapshot = engine
            .snapshot(session)
            .await
            .map_err(|error| anyhow!(error))?;
        for permission in &snapshot.permissions {
            ensure!(!plan, "Plan attempted to request write authorization");
            ensure!(
                permission.action == "edit",
                "unexpected permission action in offline write smoke"
            );
            ensure!(
                !permission.resources.is_empty(),
                "permission has no bounded resources"
            );
            ensure!(
                permission.resources.iter().all(|resource| {
                    let path = normalized_path(resource);
                    path == format!("{prefix}/probe.txt") || path == "probe.txt"
                }),
                "permission escaped the owned probe file"
            );
            engine
                .reply_permission(session, &permission.id, "once")
                .await
                .map_err(|error| anyhow!(error))?;
        }
        saw_partial |= snapshot.stream_connected
            && snapshot.messages.iter().any(|message| {
                message.role == "assistant"
                    && message
                        .parts
                        .iter()
                        .any(|part| matches!(part, AgentPart::Text { text } if text == "PROBE_"))
            });
        if matches!(snapshot.status, AgentStatus::Idle | AgentStatus::Error) {
            let settled = snapshot.messages.iter().any(|message| {
                message.role == "assistant"
                    && (!message.parts.is_empty() || message.completed_at.is_some())
            });
            if settled {
                return Ok((snapshot, saw_partial));
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn assert_build(snapshot: &AgentSnapshot, project: &Path) -> Result<()> {
    ensure!(
        snapshot.status == AgentStatus::Idle,
        "Build turn did not finish successfully: {:?}",
        snapshot.status
    );
    ensure!(
        snapshot.error.is_none(),
        "Build snapshot reported: {}",
        snapshot.error.as_deref().unwrap_or_default()
    );
    ensure!(
        snapshot.stream_connected,
        "real engine SSE stream disconnected"
    );
    ensure!(
        std::fs::read_to_string(project.join("probe.txt"))? == CONTENT,
        "engine did not write exact probe content"
    );
    ensure!(snapshot.messages.iter().any(|message| message.parts.iter().any(|part| {
        matches!(part, AgentPart::Tool { name, state, .. } if name == "write" && state == "completed")
    })), "snapshot lacks the real completed write tool");
    ensure!(
        snapshot
            .messages
            .iter()
            .any(|message| message.parts.iter().any(|part| {
                matches!(part, AgentPart::Text { text } if text.contains("PROBE_WRITTEN"))
            })),
        "snapshot lacks final assistant output"
    );
    if !snapshot.diffs.iter().any(|diff| {
        diff.path.ends_with("probe.txt")
            && diff.patch.contains(CONTENT.trim())
            && diff.additions > 0
    }) {
        eprintln!("Diff evidence: {} entries", snapshot.diffs.len());
        for diff in &snapshot.diffs {
            eprintln!(
                "Diff metadata: file={}, additions={}, deletions={}, patch_bytes={}, status={}",
                Path::new(&diff.path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
                diff.additions,
                diff.deletions,
                diff.patch.len(),
                diff.status
            );
        }
        bail!("real engine snapshot does not contain the probe diff");
    }
    Ok(())
}

async fn exercise(engine: &Engine, model: &FakeModel, project: &Path) -> Result<String> {
    let reference = AgentModelRef {
        provider_id: "lolicode".into(),
        model_id: "smoke/probe".into(),
    };
    let session = engine
        .create_session(project, &reference, "build", Some("Offline engine smoke"))
        .await
        .map_err(|error| anyhow!(error))?;
    println!("PASS 1: real engine created an isolated Build session");
    engine
        .send_message(&session.id, BUILD_PROMPT, "offline_build_smoke")
        .await
        .map_err(|error| anyhow!(error))?;
    let (mut snapshot, partial) = wait_turn(engine, &session.id, project, false).await?;
    ensure!(
        partial,
        "no actual partial SSE text observed before final persistence"
    );
    let diff_deadline = Instant::now() + Duration::from_secs(4);
    while snapshot.diffs.is_empty() && Instant::now() < diff_deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
        snapshot = engine
            .snapshot(&session.id)
            .await
            .map_err(|error| anyhow!(error))?;
    }
    assert_build(&snapshot, project)?;
    ensure!(
        model.tool_result_seen.load(Ordering::Acquire),
        "fake model did not receive the real tool result"
    );
    ensure!(
        model.build_requests.load(Ordering::Acquire) >= 2,
        "engine did not continue after executing its tool"
    );
    let tool = model
        .write_tool
        .lock()
        .await
        .as_ref()
        .map(|(name, _)| name.clone())
        .unwrap_or_default();
    println!("PASS 2: real {tool} tool wrote probe.txt; partial SSE and final output observed");
    println!("PASS 3: engine reported the actual probe.txt diff");
    let plan = engine
        .create_session(
            project,
            &reference,
            "plan",
            Some("Offline Plan safety probe"),
        )
        .await
        .map_err(|error| anyhow!(error))?;
    engine
        .send_message(&plan.id, PLAN_PROMPT, "offline_plan_smoke")
        .await
        .map_err(|error| anyhow!(error))?;
    let (plan_snapshot, _) = wait_turn(engine, &plan.id, project, true).await?;
    ensure!(
        model.plan_attempted.load(Ordering::Acquire),
        "fake provider never attempted the actual write tool in Plan"
    );
    ensure!(
        !project.join("plan_probe.txt").exists(),
        "Plan mode illegally wrote a file"
    );
    ensure!(!plan_snapshot.messages.iter().any(|message| message.parts.iter().any(|part| {
        matches!(part, AgentPart::Tool { name, state, .. } if name == "write" && state == "completed")
    })), "Plan incorrectly persisted a completed write tool");
    println!("PASS 4: Plan rejected an injected real write tool; project stayed unchanged");
    let stop_session = engine
        .create_session(
            project,
            &reference,
            "build",
            Some("Offline real interrupt probe"),
        )
        .await
        .map_err(|error| anyhow!(error))?;
    engine
        .send_message(&stop_session.id, STOP_PROMPT, "offline_stop_smoke")
        .await
        .map_err(|error| anyhow!(error))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        ensure!(
            Instant::now() < deadline,
            "real interrupt probe never exposed partial text"
        );
        let snapshot = engine
            .snapshot(&stop_session.id)
            .await
            .map_err(|error| anyhow!(error))?;
        if snapshot.status == AgentStatus::Running
            && snapshot.stream_connected
            && snapshot
                .messages
                .iter()
                .flat_map(|message| &message.parts)
                .any(|part| matches!(part, AgentPart::Text { text } if text == "STOP_PREFIX_"))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    ensure!(
        model.stop_started.load(Ordering::Acquire),
        "slow model stream was not actually opened"
    );
    engine
        .interrupt(&stop_session.id)
        .await
        .map_err(|error| anyhow!(error))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        ensure!(
            Instant::now() < deadline,
            "real interrupt did not settle with preserved partial text"
        );
        let snapshot = engine
            .snapshot(&stop_session.id)
            .await
            .map_err(|error| anyhow!(error))?;
        if snapshot.status == AgentStatus::Idle
            && snapshot
                .messages
                .iter()
                .flat_map(|message| &message.parts)
                .any(|part| matches!(part, AgentPart::Text { text } if text == "STOP_PREFIX_"))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    ensure!(
        tokio::fs::read_to_string(project.join("probe.txt")).await? == CONTENT,
        "interrupt probe changed the Build fixture"
    );
    println!("PASS 5: actual interrupt stopped a running SSE turn and preserved its partial text");
    ensure!(
        model.failures.lock().await.is_empty(),
        "offline fake provider contract failed"
    );
    Ok(session.id)
}

async fn smoke(
    executable: PathBuf,
    private_root: PathBuf,
    project: &Path,
    model: &FakeModel,
    config: Value,
) -> Result<()> {
    let engine = Engine::launch(EngineOptions {
        executable: executable.clone(),
        private_root: private_root.clone(),
        config: config.clone(),
    })
    .await
    .map_err(|error| anyhow!(error))?;
    let result =
        tokio::time::timeout(Duration::from_secs(100), exercise(&engine, model, project)).await;
    if !matches!(&result, Ok(Ok(_))) {
        diagnostic_metadata(&private_root, project).await;
    }
    let shutdown = engine.shutdown().await.map_err(|error| anyhow!(error));
    ensure!(
        !engine.is_running(),
        "owned engine still running after shutdown"
    );
    shutdown?;
    let session_id = result.context("offline smoke timed out")??;
    let restored = Engine::launch(EngineOptions {
        executable,
        private_root,
        config,
    })
    .await
    .map_err(|error| anyhow!(error))?;
    let check = async {
        let sessions = restored
            .list_sessions(project)
            .await
            .map_err(|error| anyhow!(error))?;
        ensure!(
            sessions.iter().any(|session| session.id == session_id),
            "owned session missing after engine restart"
        );
        let snapshot = restored
            .snapshot(&session_id)
            .await
            .map_err(|error| anyhow!(error))?;
        assert_build(&snapshot, project)?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    let shutdown = restored.shutdown().await.map_err(|error| anyhow!(error));
    ensure!(
        !restored.is_running(),
        "restored owned engine did not shut down"
    );
    check?;
    shutdown?;
    println!("PASS 6: restarted real engine restored persisted session, tool output and diff; owned processes shut down");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let executable = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent/opencode.exe");
    ensure!(
        executable.is_file(),
        "owned bundled engine has not been prepared"
    );
    let temporary = tempfile::tempdir().context("cannot create owned smoke directory")?;
    let project = temporary.path().join("project");
    initialize_project(&project).await?;
    let model = FakeModel::new(project.clone());
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let base = format!("http://127.0.0.1:{}/v1", listener.local_addr()?.port());
    let router = Router::new()
        .route("/v1/chat/completions", post(fake_chat))
        .route("/v1/models", get(|| async { Json(json!({"object":"list","data":[{"id":"smoke/probe","object":"model","owned_by":"offline-smoke"}]})) }))
        .with_state(model.clone());
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    let result = smoke(
        executable,
        temporary.path().join("private-engine"),
        &project,
        &model,
        config(&base, &project),
    )
    .await;
    let _ = stop.send(());
    if tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .is_err()
    {
        bail!("owned fake model server failed to shut down");
    }
    if result.is_err() {
        for problem in model.failures.lock().await.iter() {
            eprintln!("Offline contract failure: {problem}");
        }
    }
    result
}
