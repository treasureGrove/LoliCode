use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct FlightHost {
    prepared: AtomicUsize,
    host: HostedFixture,
    deferred: bool,
}

impl FlightHost {
    fn new() -> Self {
        Self {
            prepared: AtomicUsize::new(0),
            host: HostedFixture {
                enabled: true.into(),
                executions: 0.into(),
            },
            deferred: false,
        }
    }
}

impl applications::ApplicationTools for FlightHost {
    fn prepare<'a>(
        &'a self,
        _: &'a std::path::Path,
        _: tokio::sync::watch::Receiver<bool>,
    ) -> applications::ApplicationResult<'a> {
        Box::pin(async move {
            self.prepared.fetch_add(1, Ordering::SeqCst);
            Ok(String::new())
        })
    }

    fn schemas(&self) -> Vec<Value> {
        applications::ApplicationTools::schemas(&self.host)
    }

    fn deferred_tool_names(&self, _: &std::path::Path) -> Vec<String> {
        if self.deferred {
            vec!["tavern_fixture".into()]
        } else {
            vec![]
        }
    }

    fn inspect(
        &self,
        project: &std::path::Path,
        name: &str,
        input: &Value,
    ) -> Option<Result<applications::ToolInspection, String>> {
        applications::ApplicationTools::inspect(&self.host, project, name, input)
    }

    fn execute<'a>(
        &'a self,
        project: &'a std::path::Path,
        name: &'a str,
        input: &'a Value,
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> applications::ApplicationResult<'a> {
        applications::ApplicationTools::execute(&self.host, project, name, input, cancel)
    }
}

fn current_user(input: &Value) -> &str {
    input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .unwrap()["content"]
        .as_str()
        .unwrap()
}

fn current_turn_has_tool(input: &Value) -> bool {
    input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .take_while(|message| message["role"] != "user")
        .any(|message| message["role"] == "tool")
}

fn has_schema(input: &Value, name: &str) -> bool {
    input["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|schema| schema["function"]["name"] == name)
}

async fn phone_send(engine: &NativeEngine, id: &str, request: &str) {
    engine
        .call(
            "sendMessage",
            json!({"sessionId":id,"requestId":request,"text":"phone","backgroundOnly":true}),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn desktop_background_flight_blocks_tools_and_prepare_then_restores_desktop_access() {
    for name in ["run_command", "tavern_fixture", "unreal_editor_command"] {
        let requested = name.to_owned();
        let fake = Fake::start(move |input| {
            if current_turn_has_tool(input) {
                text("FINISHED")
            } else if current_user(input) == "phone" {
                tool(
                    &requested,
                    json!({"command":"echo unsafe > forbidden.txt","path":"ignored"}),
                )
            } else {
                tool("tavern_fixture", json!({}))
            }
        })
        .await;
        let (data, project, engine, id) = setup(&fake).await;
        engine
            .call(
                "updateSession",
                json!({"sessionId":id,"permissionMode":"full_access"}),
            )
            .await
            .unwrap();
        let host = Arc::new(FlightHost::new());
        engine.set_application_tools(host.clone()).await;
        phone_send(&engine, &id, "phone-blocked").await;
        let result = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
        assert!(result.to_string().contains("此次未执行"));
        assert!(!project.path().join("forbidden.txt").exists());
        assert_eq!(host.prepared.load(Ordering::SeqCst), 0);
        assert_eq!(host.host.executions.load(Ordering::SeqCst), 0);
        assert_eq!(result["session"]["permissionMode"], "full_access");
        assert!(!engine.session_tool_scope(&id).await.unwrap().1);
        for request in fake.requests.lock().unwrap().iter() {
            for forbidden in [
                "run_command",
                "tavern_fixture",
                "unreal_editor_command",
                "deferred_tool_call",
            ] {
                assert!(!has_schema(request, forbidden));
            }
        }

        // A completed phone continuation has not persisted a restricted desktop policy.
        engine.shutdown().await.unwrap();
        let engine = NativeEngine::open(data.path().into()).await.unwrap();
        engine
            .bind(project.path().into(), catalog(), fake.gateway())
            .await
            .unwrap();
        engine.set_application_tools(host.clone()).await;
        send(&engine, &id, "desktop-next", "desktop").await;
        wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
        assert_eq!(host.prepared.load(Ordering::SeqCst), 1);
        assert_eq!(host.host.executions.load(Ordering::SeqCst), 1);
        let requests = fake.requests.lock().unwrap();
        assert!(has_schema(requests.last().unwrap(), "run_command"));
        assert!(has_schema(requests.last().unwrap(), "tavern_fixture"));
        drop(requests);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn desktop_background_flight_requires_once_despite_full_access_and_remembered_grant() {
    let fake = Fake::start(|input| {
        if current_turn_has_tool(input) {
            text("WROTE")
        } else {
            tool(
                "write_file",
                json!({"path":"guarded.txt","content":"approved","expected_content":null}),
            )
        }
    })
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    engine
        .call(
            "updateSession",
            json!({"sessionId":id,"permissionMode":"ask"}),
        )
        .await
        .unwrap();
    send(&engine, &id, "desktop-grant", "desktop").await;
    let pending = wait(&engine, &id, |snapshot| {
        snapshot["status"] == "waiting_permission"
    })
    .await;
    engine
        .call(
            "replyPermission",
            json!({"sessionId":id,"requestId":pending["permissions"][0]["id"],"decision":"always"}),
        )
        .await
        .unwrap();
    wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    std::fs::remove_file(project.path().join("guarded.txt")).unwrap();
    engine
        .call(
            "updateSession",
            json!({"sessionId":id,"permissionMode":"full_access"}),
        )
        .await
        .unwrap();

    phone_send(&engine, &id, "phone-write").await;
    let pending = wait(&engine, &id, |snapshot| {
        snapshot["status"] == "waiting_permission"
    })
    .await;
    assert!(!project.path().join("guarded.txt").exists());
    assert!(engine.session_tool_scope(&id).await.unwrap().1);
    assert_eq!(pending["permissions"][0]["approvalMode"], "user-once");
    // Replaying the admitted ID with a weaker flag cannot replace its flight.
    engine
        .call(
            "sendMessage",
            json!({"sessionId":id,"requestId":"phone-write","text":"phone","backgroundOnly":false}),
        )
        .await
        .unwrap();
    assert!(engine.session_tool_scope(&id).await.unwrap().1);
    let permission = pending["permissions"][0]["id"].clone();
    assert!(engine
        .call(
            "replyPermission",
            json!({"sessionId":id,"requestId":permission,"decision":"always"})
        )
        .await
        .is_err());
    assert!(!project.path().join("guarded.txt").exists());
    engine
        .call(
            "replyPermission",
            json!({"sessionId":id,"requestId":permission,"decision":"once"}),
        )
        .await
        .unwrap();
    wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert_eq!(
        std::fs::read_to_string(project.path().join("guarded.txt")).unwrap(),
        "approved"
    );
    assert!(!engine.session_tool_scope(&id).await.unwrap().1);

    std::fs::remove_file(project.path().join("guarded.txt")).unwrap();
    send(&engine, &id, "desktop-restored", "desktop").await;
    wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert!(project.path().join("guarded.txt").exists());
    assert_eq!(
        snapshot(&engine, &id).await["session"]["permissionMode"],
        "full_access"
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_or_failed_background_flight_does_not_restrict_the_next_desktop_turn() {
    for cancel in [true, false] {
        let fake = Fake::start(move |input| {
            if current_user(input) == "phone" {
                if cancel {
                    tool(
                        "write_file",
                        json!({"path":"cancelled.txt","content":"no","expected_content":null}),
                    )
                } else {
                    Reply {
                        frames: vec![],
                        pause: false,
                        status: 500,
                        json_response: false,
                    }
                }
            } else if current_turn_has_tool(input) {
                text("DESKTOP_RECOVERED")
            } else {
                tool("tavern_fixture", json!({}))
            }
        })
        .await;
        let (_data, project, engine, id) = setup(&fake).await;
        engine
            .call(
                "updateSession",
                json!({"sessionId":id,"permissionMode":"full_access"}),
            )
            .await
            .unwrap();
        let host = Arc::new(FlightHost::new());
        engine.set_application_tools(host.clone()).await;
        phone_send(&engine, &id, "phone-stop-or-error").await;
        if cancel {
            wait(&engine, &id, |snapshot| {
                snapshot["status"] == "waiting_permission"
            })
            .await;
            assert!(engine.session_tool_scope(&id).await.unwrap().1);
            engine
                .call("interruptSession", json!({"sessionId":id}))
                .await
                .unwrap();
        }
        wait(&engine, &id, |snapshot| {
            snapshot["status"] == if cancel { "idle" } else { "error" }
        })
        .await;
        assert!(!engine.session_tool_scope(&id).await.unwrap().1);
        assert_eq!(host.prepared.load(Ordering::SeqCst), 0);
        assert!(!project.path().join("cancelled.txt").exists());
        send(&engine, &id, "desktop-recovery", "desktop").await;
        wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
        assert_eq!(host.prepared.load(Ordering::SeqCst), 1);
        assert_eq!(host.host.executions.load(Ordering::SeqCst), 1);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn permanent_background_session_cannot_opt_out_with_a_flight_flag() {
    let fake = Fake::start(|input| {
        if current_turn_has_tool(input) {
            text("BLOCKED")
        } else {
            tool("tavern_fixture", json!({}))
        }
    })
    .await;
    let (data, project, engine, _) = setup(&fake).await;
    let created = engine
        .call(
            "createSession",
            json!({"backgroundOnly":true,"permissionMode":"ask"}),
        )
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap();
    engine.shutdown().await.unwrap();
    let engine = NativeEngine::open(data.path().into()).await.unwrap();
    engine
        .bind_background(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    let host = Arc::new(FlightHost::new());
    engine.set_application_tools(host.clone()).await;
    engine.call("sendMessage", json!({"sessionId":id,"requestId":"cannot-opt-out","text":"phone","backgroundOnly":false})).await.unwrap();
    let result = wait(&engine, id, |snapshot| snapshot["status"] == "idle").await;
    assert!(result.to_string().contains("此次未执行"));
    assert!(engine.session_tool_scope(id).await.unwrap().1);
    assert_eq!(host.prepared.load(Ordering::SeqCst), 0);
    assert_eq!(host.host.executions.load(Ordering::SeqCst), 0);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn malformed_background_flight_flag_is_rejected_before_admission() {
    let fake = Fake::start(|_| text("OK")).await;
    let (_data, _project, engine, id) = setup(&fake).await;
    for flag in [json!("true"), json!(1), Value::Null, json!({"value":true})] {
        assert!(engine
            .call(
                "sendMessage",
                json!({"sessionId":id,"requestId":"bad-flag","text":"phone","backgroundOnly":flag})
            )
            .await
            .is_err());
    }
    assert!(snapshot(&engine, &id).await["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!engine.session_tool_scope(&id).await.unwrap().1);
    assert_eq!(fake.count(), 0);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn background_search_preserves_desktop_tool_discovery_without_exposing_it() {
    let fake = Fake::start(|input| {
        let user = current_user(input);
        let last_tool = input["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .take_while(|message| message["role"] != "user")
            .find(|message| message["role"] == "tool")
            .and_then(|message| message["tool_call_id"].as_str());
        match (user, last_tool) {
            ("discover" | "phone", None) => tool("tool_search", json!({"query":"tavern_fixture"})),
            ("discover", Some("call-tool_search")) | ("desktop", None) => {
                tool("tavern_fixture", json!({}))
            }
            _ => text("DONE"),
        }
    })
    .await;
    let (_data, _project, engine, id) = setup(&fake).await;
    engine
        .call(
            "updateSession",
            json!({"sessionId":id,"permissionMode":"full_access"}),
        )
        .await
        .unwrap();
    let mut host = FlightHost::new();
    host.deferred = true;
    let host = Arc::new(host);
    engine.set_application_tools(host.clone()).await;
    send(&engine, &id, "discover-host", "discover").await;
    wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert_eq!(host.host.executions.load(Ordering::SeqCst), 1);
    phone_send(&engine, &id, "phone-search").await;
    wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    for request in fake
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| current_user(request) == "phone")
    {
        assert!(!has_schema(request, "tavern_fixture"));
        assert!(!has_schema(request, "deferred_tool_call"));
    }
    send(&engine, &id, "desktop-with-discovery", "desktop").await;
    let result = wait(&engine, &id, |snapshot| snapshot["status"] == "idle").await;
    assert!(!result.to_string().contains("尚未在当前会话发现"));
    assert_eq!(host.host.executions.load(Ordering::SeqCst), 2);
    assert_eq!(host.prepared.load(Ordering::SeqCst), 2);
    engine.shutdown().await.unwrap();
}
