use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const LOOKUP: &str = "mcp_fixture_lookup";
const WRITE: &str = "mcp_fixture_write";

struct DeferredHost {
    enabled: AtomicBool,
    target: AtomicUsize,
    executions: AtomicUsize,
    remote: bool,
    project: Option<std::path::PathBuf>,
}

impl DeferredHost {
    fn new() -> Self {
        Self {
            enabled: true.into(),
            target: 1.into(),
            executions: 0.into(),
            remote: false,
            project: None,
        }
    }
}

impl applications::ApplicationTools for DeferredHost {
    fn schemas(&self) -> Vec<Value> {
        if !self.enabled.load(Ordering::SeqCst) {
            return vec![];
        }
        [LOOKUP, WRITE].into_iter().map(|name| json!({"type":"function","function":{
            "name":name,"description":"Fixture MCP document operation","parameters":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false}
        }})).collect()
    }
    fn schemas_for_project(&self, project: &std::path::Path) -> Vec<Value> {
        if self
            .project
            .as_ref()
            .is_some_and(|allowed| allowed != project)
        {
            return vec![];
        }
        self.schemas()
    }
    fn project_schemas(&self, _: &std::path::Path) -> Option<Vec<Value>> {
        self.remote.then(applications::core_tool_schemas)
    }
    fn deferred_tool_names(&self, _: &std::path::Path) -> Vec<String> {
        // Deliberately unfiltered: engine scope must intersect the real catalog.
        vec![LOOKUP.into(), WRITE.into(), "read_file".into()]
    }
    fn inspect(
        &self,
        _: &std::path::Path,
        name: &str,
        input: &Value,
    ) -> Option<Result<applications::ToolInspection, String>> {
        if ![LOOKUP, WRITE].contains(&name) {
            return None;
        }
        Some(if !self.enabled.load(Ordering::SeqCst) {
            Err("DEFERRED_REVOKED_NO_EXECUTION".into())
        } else if !input["value"].is_string() {
            Err("MCP_INPUT_MUST_MATCH_SCHEMA".into())
        } else {
            Ok(applications::ToolInspection {
                action: name.into(),
                resources: vec![format!(
                    "mcp:fixture:{}",
                    self.target.load(Ordering::SeqCst)
                )],
                description: "MCP fixture operation".into(),
                mutating: name == WRITE,
                requires_approval: name == WRITE,
                dangerous: false,
            })
        })
    }
    fn execute<'a>(
        &'a self,
        project: &'a std::path::Path,
        name: &'a str,
        input: &'a Value,
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> applications::ApplicationResult<'a> {
        Box::pin(async move {
            if *cancel.borrow() {
                return Err("cancelled".into());
            }
            self.inspect(project, name, input).unwrap()?;
            self.executions.fetch_add(1, Ordering::SeqCst);
            Ok(format!(
                "MCP_FIXTURE_EXECUTED:{}",
                input["value"].as_str().unwrap()
            ))
        })
    }
}

fn advertised(input: &Value, name: &str) -> bool {
    input["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|schema| schema["function"]["name"] == name)
}

fn last_receipt(input: &Value) -> &str {
    input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap()
}

fn invoke(name: &str, wrapped: bool) -> Reply {
    if wrapped {
        tool(
            "deferred_tool_call",
            json!({"name":name,"input":{"value":"real input"}}),
        )
    } else {
        tool(name, json!({"value":"real input"}))
    }
}

struct PreparingHost {
    preparations: AtomicUsize,
    pending: bool,
}

impl applications::ApplicationTools for PreparingHost {
    fn prepare<'a>(
        &'a self,
        _: &'a std::path::Path,
        _: tokio::sync::watch::Receiver<bool>,
    ) -> applications::ApplicationResult<'a> {
        Box::pin(async move {
            self.preparations.fetch_add(1, Ordering::SeqCst);
            if self.pending {
                std::future::pending().await
            } else {
                Ok(String::new())
            }
        })
    }
    fn schemas(&self) -> Vec<Value> {
        vec![]
    }
    fn inspect(
        &self,
        _: &std::path::Path,
        _: &str,
        _: &Value,
    ) -> Option<Result<applications::ToolInspection, String>> {
        None
    }
    fn execute<'a>(
        &'a self,
        _: &'a std::path::Path,
        _: &'a str,
        _: &'a Value,
        _: tokio::sync::watch::Receiver<bool>,
    ) -> applications::ApplicationResult<'a> {
        Box::pin(async { Err("preparation fixture owns no tools".into()) })
    }
}

#[tokio::test]
async fn admitted_turn_preparation_is_cancellable_and_never_sends_a_ghost_model_request() {
    let fake = Fake::start(|_| panic!("cancelled preparation must not send a model request")).await;
    let (_data, _project, engine, id) = setup(&fake).await;
    let host = Arc::new(PreparingHost {
        preparations: 0.into(),
        pending: true,
    });
    engine.set_application_tools(host.clone()).await;
    send(&engine, &id, "prepare-stop", "Prepare a configured server").await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while host.preparations.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    engine
        .call("interruptSession", json!({"sessionId":id}))
        .await
        .unwrap();
    let stopped = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert!(stopped["error"].is_null());
    assert_eq!(fake.count(), 0);
    assert_eq!(host.preparations.load(Ordering::SeqCst), 1);
    engine.shutdown().await.unwrap();
    assert_eq!(fake.count(), 0);
}

#[tokio::test]
async fn preparation_runs_once_per_turn_and_is_skipped_for_background_sessions() {
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() {
            tool("list_files", json!({}))
        } else {
            text("PREPARATION_CHECKED")
        }
    })
    .await;
    let (_data, _project, engine, id) = setup(&fake).await;
    let host = Arc::new(PreparingHost {
        preparations: 0.into(),
        pending: false,
    });
    engine.set_application_tools(host.clone()).await;
    send(
        &engine,
        &id,
        "prepare-once",
        "List project files then answer",
    )
    .await;
    wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert_eq!(host.preparations.load(Ordering::SeqCst), 1);
    assert_eq!(fake.count(), 2);
    send(&engine, &id, "prepare-next", "Continue the same session").await;
    wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert_eq!(host.preparations.load(Ordering::SeqCst), 2);
    let background = engine
        .call(
            "createSession",
            json!({"backgroundOnly":true,"permissionMode":"ask"}),
        )
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    send(
        &engine,
        &background,
        "prepare-background",
        "List files without starting host transports",
    )
    .await;
    wait(&engine, &background, |snapshot| {
        snapshot["status"] == "idle"
    })
    .await;
    assert_eq!(host.preparations.load(Ordering::SeqCst), 2);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn session_tool_scope_reads_the_persisted_boundary_without_mutation_or_inference() {
    let fake = Fake::start(|_| panic!("scope lookup must never start inference")).await;
    let (data, project, engine, foreground) = setup(&fake).await;
    let background = engine
        .call(
            "createSession",
            json!({"backgroundOnly":true,"permissionMode":"ask"}),
        )
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let expected_project = engine.session_tool_scope(&foreground).await.unwrap().0;
    assert_eq!(
        expected_project.canonicalize().unwrap(),
        project.path().canonicalize().unwrap()
    );
    let other_project = TempDir::new().unwrap();
    engine
        .bind(other_project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    for (id, expected_background) in [(&foreground, false), (&background, true)] {
        let path = persistence::session_path(data.path(), id).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert_eq!(
            engine.session_tool_scope(id).await.unwrap(),
            (expected_project.clone(), expected_background)
        );
        assert_eq!(std::fs::read(path).unwrap(), before);
        let snapshot = engine
            .call("getSession", json!({"sessionId":id}))
            .await
            .unwrap();
        assert!(snapshot.get("backgroundOnly").is_none());
    }
    assert!(engine
        .session_tool_scope("lc:00000000-0000-0000-0000-000000000000")
        .await
        .is_err());
    assert_eq!(fake.count(), 0);
    engine.shutdown().await.unwrap();
    let restored = NativeEngine::open(data.path().into()).await.unwrap();
    assert_eq!(
        restored.session_tool_scope(&foreground).await.unwrap(),
        (expected_project.clone(), false)
    );
    assert_eq!(
        restored.session_tool_scope(&background).await.unwrap(),
        (expected_project, true)
    );
    assert_eq!(fake.count(), 0);
    restored.shutdown().await.unwrap();
}

#[tokio::test]
async fn discovery_loads_real_schema_then_direct_and_wrapped_calls_share_execution() {
    for wrapped in [false, true] {
        let fake = Fake::start(move |input| match last_tool(input) {
            None => {
                assert!(advertised(input, "read_file"));
                assert!(advertised(input, "deferred_tool_call"));
                assert!(!advertised(input, LOOKUP));
                assert!(!advertised(input, WRITE));
                tool("tool_search", json!({"query":LOOKUP,"limit":1}))
            }
            Some("call-tool_search") => {
                let found: Value = serde_json::from_str(last_receipt(input)).unwrap();
                assert_eq!(found["tools"][0]["name"], LOOKUP);
                assert_eq!(found["tools"][0]["deferred"], true);
                assert_eq!(
                    found["tools"][0]["parameters"]["required"],
                    json!(["value"])
                );
                assert!(advertised(input, LOOKUP));
                assert!(!advertised(input, WRITE));
                invoke(LOOKUP, wrapped)
            }
            _ => {
                assert!(last_receipt(input).contains("MCP_FIXTURE_EXECUTED:real input"));
                text("DEFERRED_SUCCESS")
            }
        })
        .await;
        let (_data, _project, engine, id) = setup(&fake).await;
        let host = Arc::new(DeferredHost::new());
        engine.set_application_tools(host.clone()).await;
        send(
            &engine,
            &id,
            "discover-real",
            "Find and use the configured tool",
        )
        .await;
        let result = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
        assert!(result.to_string().contains("DEFERRED_SUCCESS"));
        assert_eq!(host.executions.load(Ordering::SeqCst), 1);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn guessed_deferred_names_and_missing_names_never_execute() {
    for (name, wrapped) in [(LOOKUP, false), (LOOKUP, true), ("mcp_missing", true)] {
        let fake = Fake::start(move |input| {
            if last_tool(input).is_none() {
                invoke(name, wrapped)
            } else {
                assert!(!last_receipt(input).contains("MCP_FIXTURE_EXECUTED"));
                text("GUESS_REJECTED")
            }
        })
        .await;
        let (_data, _project, engine, id) = setup(&fake).await;
        let host = Arc::new(DeferredHost::new());
        engine.set_application_tools(host.clone()).await;
        send(&engine, &id, "no-search", "Try an undiscovered tool").await;
        let result = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
        assert!(result.to_string().contains("GUESS_REJECTED"));
        assert_eq!(host.executions.load(Ordering::SeqCst), 0);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn deferred_wrappers_keep_plan_and_one_time_permission_boundaries_and_recheck_revocation() {
    for scenario in ["plan", "approved", "revoked", "changed"] {
        let fake = Fake::start(|input| match last_tool(input) {
            None => tool("tool_search", json!({"query":WRITE,"limit":1})),
            Some("call-tool_search") => invoke(WRITE, true),
            _ => text("BOUNDARY_CHECK_COMPLETE"),
        })
        .await;
        let (_data, _project, engine, id) = setup(&fake).await;
        let host = Arc::new(DeferredHost::new());
        engine.set_application_tools(host.clone()).await;
        engine.call("updateSession", json!({"sessionId":id,"mode":if scenario == "plan" {"plan"}else{"build"},"permissionMode":"ask"})).await.unwrap();
        send(
            &engine,
            &id,
            "deferred-boundary",
            "Use the discovered write tool",
        )
        .await;
        if scenario != "plan" {
            let pending = wait(&engine, &id, |snapshot| {
                snapshot["status"] == "waiting_permission"
            })
            .await;
            assert_eq!(pending["permissions"][0]["toolName"], WRITE);
            assert_eq!(
                pending["permissions"][0]["toolInput"],
                json!({"value":"real input"})
            );
            assert_eq!(host.executions.load(Ordering::SeqCst), 0);
            if scenario == "revoked" {
                host.enabled.store(false, Ordering::SeqCst);
            }
            if scenario == "changed" {
                host.target.store(2, Ordering::SeqCst);
            }
            engine.call("replyPermission", json!({"sessionId":id,"requestId":pending["permissions"][0]["id"],"decision":"once"})).await.unwrap();
        }
        let result = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
        assert_eq!(
            host.executions.load(Ordering::SeqCst),
            usize::from(scenario == "approved")
        );
        let encoded = result.to_string();
        match scenario {
            "plan" => assert!(encoded.contains("分析模式不能写文件")),
            "revoked" => assert!(encoded.contains("DEFERRED_REVOKED_NO_EXECUTION")),
            "changed" => assert!(encoded.contains("工具目标或权限范围已经改变")),
            _ => assert!(encoded.contains("MCP_FIXTURE_EXECUTED")),
        }
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn discovery_survives_compaction_restart_and_followup_but_revocation_clears_it() {
    let phase = Arc::new(AtomicUsize::new(0));
    let counter = phase.clone();
    let fake = Fake::start(move |input| {
        if is_compaction(input) { return text("The user asked to inspect the fixture. File log.txt was read. Continue without replaying completed reads."); }
        let phase = counter.fetch_add(1, Ordering::SeqCst);
        assert_eq!(advertised(input, LOOKUP), (1..=10).contains(&phase));
        match phase {
            0 => tool("tool_search", json!({"query":LOOKUP,"limit":1})),
            1..=7 => tool("read_file", json!({"path":"log.txt"})),
            8 => invoke(LOOKUP, true),
            _ => text("DISCOVERY_CONTINUITY_CHECKED"),
        }
    }).await;
    let (data, project, engine, id) = setup(&fake).await;
    let mut models = catalog();
    models["models"][0]["contextLimit"] = json!(16000);
    engine
        .bind(project.path().into(), models.clone(), fake.gateway())
        .await
        .unwrap();
    std::fs::write(
        project.path().join("log.txt"),
        "VERIFIED_FIXTURE_DETAIL ".repeat(350),
    )
    .unwrap();
    let host = Arc::new(DeferredHost::new());
    engine.set_application_tools(host.clone()).await;
    send(
        &engine,
        &id,
        "discover-compact",
        "Inspect fixture and retain discovery",
    )
    .await;
    wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert!(!fake.compaction_requests.lock().unwrap().is_empty());
    assert_eq!(host.executions.load(Ordering::SeqCst), 1);
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.path().into(), models, fake.gateway())
        .await
        .unwrap();
    reopened.set_application_tools(host.clone()).await;
    send(
        &reopened,
        &id,
        "after-restart",
        "Continue with discovered tools",
    )
    .await;
    wait(&reopened, &id, |snapshot| snapshot["status"] == "idle").await;
    // The next phase is 11 (the final response and this follow-up each infer once).
    host.enabled.store(false, Ordering::SeqCst);
    send(
        &reopened,
        &id,
        "after-revocation",
        "Check current capabilities",
    )
    .await;
    wait(&reopened, &id, |snapshot| snapshot["status"] == "idle").await;
    let stored = persistence::load(data.path())
        .await
        .unwrap()
        .into_iter()
        .find(|stored| stored.snapshot.session.id == id)
        .unwrap();
    assert!(stored.discovered_tools.is_empty());
    host.enabled.store(true, Ordering::SeqCst);
    send(
        &reopened,
        &id,
        "after-reenable",
        "The restored server needs discovery again",
    )
    .await;
    wait(&reopened, &id, |snapshot| snapshot["status"] == "idle").await;
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn discovered_tools_are_session_scoped() {
    let phase = Arc::new(AtomicUsize::new(0));
    let counter = phase.clone();
    let fake = Fake::start(move |input| match counter.fetch_add(1, Ordering::SeqCst) {
        0 => tool("tool_search", json!({"query":LOOKUP,"limit":1})),
        1 => {
            assert!(advertised(input, LOOKUP));
            text("FIRST_DISCOVERED")
        }
        2 => {
            assert!(!advertised(input, LOOKUP));
            text("OTHER_SESSION_UNLOADED")
        }
        _ => {
            assert!(advertised(input, LOOKUP));
            text("FIRST_STILL_LOADED")
        }
    })
    .await;
    let (_data, _project, engine, id) = setup(&fake).await;
    engine
        .set_application_tools(Arc::new(DeferredHost::new()))
        .await;
    send(&engine, &id, "first-discover", "Discover fixture").await;
    wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    let other = engine
        .call("createSession", json!({"permissionMode":"auto"}))
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    send(
        &engine,
        &other,
        "other-session",
        "Do not inherit another session's discovery",
    )
    .await;
    wait(&engine, &other, |snapshot| snapshot["status"] == "idle").await;
    send(
        &engine,
        &id,
        "first-again",
        "Retain this session's discovery",
    )
    .await;
    wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn deferred_mcp_catalog_never_leaks_into_remote_background_or_unconfigured_projects() {
    for scope in ["remote", "background", "other-project"] {
        let fake = Fake::start(|input| {
            assert!(!advertised(input, LOOKUP));
            assert!(!advertised(input, "deferred_tool_call"));
            if last_tool(input).is_none() {
                tool("tool_search", json!({"query":LOOKUP}))
            } else {
                let found: Value = serde_json::from_str(last_receipt(input)).unwrap();
                assert_eq!(found["totalMatches"], 0);
                text("MCP_SCOPE_PRESERVED")
            }
        })
        .await;
        let (_data, _project, engine, original_id) = setup(&fake).await;
        let mut host = DeferredHost::new();
        host.remote = scope == "remote";
        if scope == "other-project" {
            host.project = Some(std::path::PathBuf::from("unconfigured-project"));
        }
        let host = Arc::new(host);
        engine.set_application_tools(host.clone()).await;
        let id = if scope == "background" {
            engine
                .call(
                    "createSession",
                    json!({"backgroundOnly":true,"permissionMode":"ask"}),
                )
                .await
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_string()
        } else {
            original_id
        };
        send(
            &engine,
            &id,
            "scoped-search",
            "Find only tools in this execution scope",
        )
        .await;
        let result = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
        assert!(result.to_string().contains("MCP_SCOPE_PRESERVED"));
        assert_eq!(host.executions.load(Ordering::SeqCst), 0);
        engine.shutdown().await.unwrap();
    }
}
