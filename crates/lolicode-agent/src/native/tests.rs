use super::*;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Reply {
    frames: Vec<Value>,
    pause: bool,
    status: u16,
    json_response: bool,
}
fn text(value: &str) -> Reply {
    Reply {
        frames: vec![json!({"choices":[{"delta":{"content":value},"finish_reason":"stop"}]})],
        pause: false,
        status: 200,
        json_response: false,
    }
}
fn tool(name: &str, input: Value) -> Reply {
    Reply {
        frames: vec![
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":format!("call-{name}"),"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":"tool_calls"}]}),
        ],
        pause: false,
        status: 200,
        json_response: false,
    }
}
struct Fake {
    address: String,
    requests: Arc<StdMutex<Vec<Value>>>,
    title_requests: Arc<StdMutex<Vec<Value>>>,
    compaction_requests: Arc<StdMutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
    children: Arc<StdMutex<Vec<tokio::task::JoinHandle<()>>>>,
    resume: Arc<tokio::sync::Notify>,
}
impl Drop for Fake {
    fn drop(&mut self) {
        self.task.abort();
        for child in self.children.lock().unwrap().drain(..) {
            child.abort();
        }
    }
}
impl Fake {
    async fn start(handler: impl Fn(&Value) -> Reply + Send + Sync + 'static) -> Self {
        Self::start_with_titles(handler, |_| text("归纳后的测试会话")).await
    }
    async fn start_with_titles(
        handler: impl Fn(&Value) -> Reply + Send + Sync + 'static,
        title_handler: impl Fn(&Value) -> Reply + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/v1", listener.local_addr().unwrap());
        let handler = Arc::new(handler);
        let title_handler = Arc::new(title_handler);
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let children = Arc::new(StdMutex::new(Vec::new()));
        let recorded = requests.clone();
        let title_requests = Arc::new(StdMutex::new(Vec::new()));
        let recorded_titles = title_requests.clone();
        let compaction_requests = Arc::new(StdMutex::new(Vec::new()));
        let recorded_compactions = compaction_requests.clone();
        let child_list = children.clone();
        let resume = Arc::new(tokio::sync::Notify::new());
        let response_resume = resume.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let handler = handler.clone();
                let title_handler = title_handler.clone();
                let requests = recorded.clone();
                let title_requests = recorded_titles.clone();
                let compaction_requests = recorded_compactions.clone();
                let resume = response_resume.clone();
                let child = tokio::spawn(async move {
                    let mut input = Vec::new();
                    let header_end = loop {
                        let mut chunk = [0u8; 8192];
                        let n = stream.read(&mut chunk).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        input.extend_from_slice(&chunk[..n]);
                        if let Some(end) = input.windows(4).position(|v| v == b"\r\n\r\n") {
                            break end + 4;
                        }
                        assert!(input.len() < 65536);
                    };
                    let headers = String::from_utf8(input[..header_end].to_vec()).unwrap();
                    assert!(headers.starts_with("POST /v1/chat/completions "));
                    assert!(headers
                        .to_ascii_lowercase()
                        .contains("authorization: bearer owned-private-gateway"));
                    let size = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    while input.len() - header_end < size {
                        let mut chunk = [0u8; 8192];
                        let n = stream.read(&mut chunk).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        input.extend_from_slice(&chunk[..n]);
                    }
                    let body: Value =
                        serde_json::from_slice(&input[header_end..header_end + size]).unwrap();
                    assert!(body["model"].as_str().is_some_and(|model| model.starts_with("channel/")));
                    let is_title = body["messages"][0]["content"].as_str()
                        .is_some_and(|prompt| prompt.starts_with("You generate a short session title"));
                    let is_compaction = is_compaction(&body);
                    let reply = if is_title {
                        title_requests.lock().unwrap().push(body.clone());
                        title_handler(&body)
                    } else if is_compaction {
                        compaction_requests.lock().unwrap().push(body.clone());
                        handler(&body)
                    } else {
                        requests.lock().unwrap().push(body.clone());
                        handler(&body)
                    };
                    if reply.status != 200 {
                        if reply.json_response {
                            let body = serde_json::to_string(&reply.frames[0]).unwrap();
                            let _=stream.write_all(format!("HTTP/1.1 {} Error\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",reply.status,body.len(),body).as_bytes()).await;
                            return;
                        }
                        let _=stream.write_all(format!("HTTP/1.1 {} Error\r\nConnection: close\r\nContent-Length: 43\r\n\r\nupstream echoed owned-private-gateway secret",reply.status).as_bytes()).await;
                        return;
                    }
                    if reply.json_response {
                        let body = serde_json::to_string_pretty(&reply.frames[0]).unwrap();
                        let _=stream.write_all(format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",body.len(),body).as_bytes()).await;
                        return;
                    }
                    let _=stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/event-stream\r\n\r\n").await;
                    for frame in reply.frames {
                        if stream
                            .write_all(format!("data: {frame}\n\n").as_bytes())
                            .await
                            .is_err()
                        {
                            return;
                        }
                        if reply.pause {
                            resume.notified().await;
                        }
                    }
                    let _ = stream.write_all(b"data: [DONE]\n\n").await;
                });
                child_list.lock().unwrap().push(child);
            }
        });
        Self {
            address,
            requests,
            title_requests,
            compaction_requests,
            task,
            children,
            resume,
        }
    }
    fn gateway(&self) -> NativeGateway {
        NativeGateway {
            base_url: self.address.clone(),
            bearer_token: "owned-private-gateway".into(),
        }
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
fn catalog() -> Value {
    json!({"revision":1,"models":[{"id":"lolicode/channel/opaque/model","providerId":"lolicode","modelId":"channel/opaque/model","name":"Offline fixture","channelName":"Owned fixture","contextLimit":128000}],"defaultModel":"lolicode/channel/opaque/model","excludedSources":[]})
}
async fn setup(fake: &Fake) -> (TempDir, TempDir, NativeEngine, String) {
    let data = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let engine = NativeEngine::open(data.path().into()).await.unwrap();
    engine
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    let session = engine
        .call(
            "createSession",
            json!({"mode":"build","permissionMode":"auto"}),
        )
        .await
        .unwrap();
    (
        data,
        project,
        engine,
        session["id"].as_str().unwrap().into(),
    )
}

#[tokio::test]
async fn projects_can_switch_and_run_concurrently_with_isolated_workspaces() {
    let data = TempDir::new().unwrap();
    let project_a = TempDir::new().unwrap();
    let project_b = TempDir::new().unwrap();
    let project_a_path = project_a.path().to_string_lossy().into_owned();
    let fake = Fake::start(move |input| {
        let system = input["messages"][0]["content"].as_str().unwrap_or_default();
        let is_project_a = system.contains(&project_a_path);
        match last_tool(input) {
            None => {
                let mut reply = tool(
                    "write_file",
                    json!({
                        "path":"parallel-project.txt",
                        "content":if is_project_a {"written by project A"} else {"written by project B"},
                        "expected_content":null
                    }),
                );
                reply.pause = is_project_a;
                reply
            }
            Some("call-write_file") => text("PROJECT_TASK_COMPLETED"),
            other => panic!("unexpected tool call: {other:?}"),
        }
    })
    .await;
    let engine = NativeEngine::open(data.path().into()).await.unwrap();
    engine
        .bind(project_a.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    let session_a = engine
        .call("createSession", json!({"mode":"build","permissionMode":"auto"}))
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    send(&engine, &session_a, "parallel-a", "Work in project A").await;

    tokio::time::timeout(Duration::from_secs(5), async {
        while fake.count() < 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("project A should reach the model while its response is paused");
    assert_eq!(snapshot(&engine, &session_a).await["status"], "running");

    engine
        .bind(project_b.path().into(), catalog(), fake.gateway())
        .await
        .expect("switching projects must not wait for project A");
    let session_b = engine
        .call("createSession", json!({"mode":"build","permissionMode":"auto"}))
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    send(&engine, &session_b, "parallel-b", "Work in project B").await;
    let result_b = wait(&engine, &session_b, |value| value["status"] == "idle").await;
    assert!(result_b.to_string().contains("PROJECT_TASK_COMPLETED"));
    assert_eq!(snapshot(&engine, &session_a).await["status"], "running");

    let mut refreshed_catalog = catalog();
    refreshed_catalog["revision"] = json!(2);
    let reopened_a = engine
        .bind(
            project_a.path().into(),
            refreshed_catalog.clone(),
            fake.gateway(),
        )
        .await
        .unwrap();
    assert_eq!(
        reopened_a["catalog"]["revision"],
        json!(1),
        "an active project keeps its original model configuration"
    );
    assert_eq!(
        tokio::fs::read_to_string(project_b.path().join("parallel-project.txt"))
            .await
            .unwrap(),
        "written by project B"
    );
    assert!(!project_a.path().join("parallel-project.txt").exists());

    fake.resume.notify_one();
    let result_a = wait(&engine, &session_a, |value| value["status"] == "idle").await;
    assert!(result_a.to_string().contains("PROJECT_TASK_COMPLETED"));
    assert_eq!(
        tokio::fs::read_to_string(project_a.path().join("parallel-project.txt"))
            .await
            .unwrap(),
        "written by project A"
    );
    assert_eq!(
        tokio::fs::read_to_string(project_b.path().join("parallel-project.txt"))
            .await
            .unwrap(),
        "written by project B"
    );
    let refreshed_a = engine
        .bind(project_a.path().into(), refreshed_catalog, fake.gateway())
        .await
        .unwrap();
    assert_eq!(refreshed_a["catalog"]["revision"], json!(2));
    engine.shutdown().await.unwrap();
}

async fn snapshot(engine: &NativeEngine, id: &str) -> Value {
    engine
        .call("getSession", json!({"sessionId":id}))
        .await
        .unwrap()
}
async fn wait(engine: &NativeEngine, id: &str, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let value = snapshot(engine, id).await;
        if predicate(&value) {
            return value;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out at status {}",
            value["status"]
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
async fn send(engine: &NativeEngine, id: &str, request: &str, text: &str) {
    engine
        .call(
            "sendMessage",
            json!({"sessionId":id,"requestId":request,"text":text}),
        )
        .await
        .unwrap();
}
fn last_tool(input: &Value) -> Option<&str> {
    input["messages"]
        .as_array()?
        .iter()
        .rev()
        .find(|v| v["role"] == "tool")?["tool_call_id"]
        .as_str()
}

#[tokio::test]
async fn mobile_background_policy_blocks_shell_hosted_tools_and_survives_restart() {
    for name in ["run_command", "tavern_fixture", "unreal_editor_command"] {
        let tool_name=name.to_string();
        let fake=Fake::start(move |input|if last_tool(input).is_none(){tool(&tool_name,json!({"command":"echo SHOULD_NOT_RUN","path":"ignored"}))}else{text("BLOCK_CONFIRMED")}).await;
        let data=TempDir::new().unwrap();let project=TempDir::new().unwrap();let engine=NativeEngine::open(data.path().into()).await.unwrap();
        engine.bind(project.path().into(),catalog(),fake.gateway()).await.unwrap();
        let host=Arc::new(HostedFixture{enabled:true.into(),executions:0.into()});engine.set_application_tools(host.clone()).await;
        assert!(engine.call("createSession",json!({"backgroundOnly":true,"permissionMode":"full_access"})).await.is_err());
        let created=engine.call("createSession",json!({"backgroundOnly":true,"permissionMode":"ask"})).await.unwrap();let id=created["id"].as_str().unwrap();
        assert!(engine.call("updateSession",json!({"sessionId":id,"permissionMode":"auto"})).await.is_err());
        engine.shutdown().await.unwrap();let engine=NativeEngine::open(data.path().into()).await.unwrap();engine.bind_background(project.path().into(),catalog(),fake.gateway()).await.unwrap();engine.set_application_tools(host.clone()).await;
        send(&engine,id,"blocked-call","Try the requested tool").await;
        let result=wait(&engine,id,|v|v["status"]=="idle").await;assert!(result.to_string().contains("此次未执行"));assert_eq!(host.executions.load(std::sync::atomic::Ordering::SeqCst),0);
        let requests=fake.requests.lock().unwrap();for request in requests.iter(){for schema in request["tools"].as_array().unwrap(){let name=schema["function"]["name"].as_str().unwrap();assert!(!matches!(name,"run_command"|"tavern_fixture"|"unreal_editor_command"));}}drop(requests);
        engine.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn mobile_background_binding_never_reselects_the_desktop_project() {
    let fake=Fake::start(|_|text("done")).await;let data=TempDir::new().unwrap();let a=TempDir::new().unwrap();let b=TempDir::new().unwrap();let engine=NativeEngine::open(data.path().into()).await.unwrap();
    engine.bind(a.path().into(),catalog(),fake.gateway()).await.unwrap();let before=engine.call("status",json!({})).await.unwrap();
    engine.bind_background(b.path().into(),catalog(),fake.gateway()).await.unwrap();
    let phone=engine.call("createSession",json!({"projectPath":b.path().to_string_lossy(),"backgroundOnly":true,"permissionMode":"ask"})).await.unwrap();
    assert_eq!(engine.call("status",json!({})).await.unwrap()["projectPath"],before["projectPath"]);
    let local=engine.call("createSession",json!({"permissionMode":"auto"})).await.unwrap();assert_ne!(local["projectPath"],phone["projectPath"]);assert_eq!(local["permissionMode"],"auto");engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn mobile_background_ignores_desktop_grants_and_rejects_stale_or_remembered_approval() {
    let fake=Fake::start(|input|if last_tool(input).is_none(){tool("write_file",json!({"path":"mobile-write.txt","content":"approved","expected_content":null}))}else{text("done")}).await;
    let (_data,project,engine,local)=setup(&fake).await;
    engine.call("updateSession",json!({"sessionId":local,"permissionMode":"ask"})).await.unwrap();
    send(&engine,&local,"grant-local","Write a file").await;
    let pending=wait(&engine,&local,|s|s["status"]=="waiting_permission").await;
    engine.call("replyPermission",json!({"sessionId":local,"requestId":pending["permissions"][0]["id"],"decision":"always"})).await.unwrap();
    wait(&engine,&local,|s|s["status"]=="idle").await;
    std::fs::remove_file(project.path().join("mobile-write.txt")).unwrap();
    let phone=engine.call("createSession",json!({"backgroundOnly":true,"permissionMode":"ask"})).await.unwrap();let id=phone["id"].as_str().unwrap();
    send(&engine,id,"phone-write","Write a file").await;
    let pending=wait(&engine,id,|s|s["status"]=="waiting_permission").await;
    assert!(!project.path().join("mobile-write.txt").exists());let permission=pending["permissions"][0]["id"].clone();
    assert!(engine.call("replyPermission",json!({"sessionId":id,"requestId":permission,"decision":"always"})).await.is_err());
    engine.call("replyPermission",json!({"sessionId":id,"requestId":permission,"decision":"once"})).await.unwrap();
    wait(&engine,id,|s|s["status"]=="idle").await;
    assert_eq!(std::fs::read_to_string(project.path().join("mobile-write.txt")).unwrap(),"approved");
    assert!(engine.call("replyPermission",json!({"sessionId":id,"requestId":permission,"decision":"once"})).await.is_err());
    engine.shutdown().await.unwrap();
}
fn is_compaction(input: &Value) -> bool {
    input["messages"][0]["content"].as_str()
        .is_some_and(|prompt| prompt.starts_with(super::context::SUMMARY_PROMPT))
}

mod context_cases;
mod stream_usage_cases;
mod image_output_cases;
mod memory_cases;
mod tool_search_cases;
mod deferred_tool_cases;

#[tokio::test]
async fn long_tool_tasks_complete_real_edits_after_more_than_twenty_four_rounds() {
    let fake = Fake::start(|input| {
        let count = input["messages"].as_array().unwrap().iter()
            .filter(|message| message["role"] == "tool").count();
        if count < 32 {
            tool("apply_patch", json!({"path":"counter.txt","old_text":format!("value={count}\n"),"new_text":format!("value={}\n", count+1)}))
        } else {
            text("ALL_32_EDITS_FINISHED")
        }
    }).await;
    let (_data, project, engine, id) = setup(&fake).await;
    tokio::fs::write(project.path().join("counter.txt"), "value=0\n").await.unwrap();
    send(&engine, &id, "long-task", "Complete all 32 dependent edits").await;
    let result = wait(&engine, &id, |value| matches!(value["status"].as_str(), Some("idle" | "error"))).await;
    assert_eq!(result["status"], "idle", "{}", result["error"]);
    assert_eq!(fake.count(), 33);
    assert_eq!(tokio::fs::read_to_string(project.path().join("counter.txt")).await.unwrap(), "value=32\n");
    assert!(result.to_string().contains("ALL_32_EDITS_FINISHED"));
    assert_eq!(result["diffs"].as_array().unwrap().len(), 1);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancellation_still_stops_long_tool_tasks_without_replaying_work() {
    let fake = Fake::start(|input| {
        let messages = input["messages"].as_array().unwrap();
        let user = messages.iter().rev().find(|message| message["role"] == "user").unwrap()["content"].as_str().unwrap();
        if user == "Continue after cancellation" { return text("CONTINUED_SAFELY"); }
        let count = messages.iter().filter(|message| message["role"] == "tool").count();
        let mut reply = tool("read_file", json!({"path":"preserved.txt"}));
        reply.pause = count >= 26;
        reply
    }).await;
    let (_data, project, engine, id) = setup(&fake).await;
    tokio::fs::write(project.path().join("preserved.txt"), "unchanged").await.unwrap();
    send(&engine, &id, "long-cancel", "Inspect until I stop").await;
    wait(&engine, &id, |_| fake.count() >= 27).await;
    engine.call("interruptSession", json!({"sessionId":id})).await.unwrap();
    let stopped = wait(&engine, &id, |value| value["status"] == "idle").await;
    assert!(stopped["error"].is_null());
    send(&engine, &id, "after-long-cancel", "Continue after cancellation").await;
    let resumed = wait(&engine, &id, |value| value["status"] == "idle").await;
    assert!(resumed.to_string().contains("CONTINUED_SAFELY"));
    assert_eq!(fake.count(), 28);
    assert_eq!(tokio::fs::read_to_string(project.path().join("preserved.txt")).await.unwrap(), "unchanged");
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn running_session_model_and_mode_changes_apply_at_the_next_model_request() {
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() {
            assert_eq!(input["model"], "channel/opaque/model");
            return tool("ask_user", json!({"questions":[{"question":"Continue?","options":[{"label":"Yes"}]}]}));
        }
        assert_eq!(input["model"], "channel/other/model");
        assert!(input["messages"][0]["content"].as_str().unwrap().contains("Current mode: plan"));
        if last_tool(input) == Some("call-ask_user") {
            tool("write_file", json!({"path":"blocked.txt","content":"must not write","expected_content":null}))
        } else {
            assert!(input.to_string().contains("分析模式不能写文件"));
            text("NEW_MODEL_AND_PLAN_APPLIED")
        }
    }).await;
    let (_data, project, engine, id) = setup(&fake).await;
    let mut models = catalog();
    let mut other = models["models"][0].clone();
    other["id"] = json!("lolicode/channel/other/model");
    other["modelId"] = json!("channel/other/model");
    models["models"].as_array_mut().unwrap().push(other);
    engine.bind(project.path().into(), models, fake.gateway()).await.unwrap();
    send(&engine, &id, "switch-live", "Ask me before proceeding").await;
    let pending = wait(&engine, &id, |value| value["status"] == "waiting_question").await;
    let updated = engine.call("updateSession", json!({"sessionId":id,"modelId":"lolicode/channel/other/model","mode":"plan","permissionMode":"ask"})).await.unwrap();
    assert_eq!(updated["model"]["modelId"], "channel/other/model");
    let after = snapshot(&engine, &id).await;
    assert_eq!(after["status"], "waiting_question");
    assert_eq!(after["messages"], pending["messages"]);
    assert_eq!(after["questions"], pending["questions"]);
    assert!(engine.call("sendMessage", json!({"sessionId":id,"requestId":"overlap","text":"Do not overlap"})).await.is_err());
    engine.call("replyQuestion", json!({"sessionId":id,"requestId":pending["questions"][0]["id"],"answer":{"answer_0":"Yes"}})).await.unwrap();
    let result = wait(&engine, &id, |value| value["status"] == "idle").await;
    assert!(result.to_string().contains("NEW_MODEL_AND_PLAN_APPLIED"));
    assert!(!project.path().join("blocked.txt").exists());
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn permission_changes_apply_to_new_checks_without_bypassing_a_pending_approval() {
    let fake = Fake::start(|input| match last_tool(input) {
        None => tool("ask_user", json!({"questions":[{"question":"Continue?","options":[{"label":"Yes"}]}]})),
        Some("call-ask_user") => tool("write_file", json!({"path":"denied.txt","content":"denied","expected_content":null})),
        Some("call-write_file") => {
            let results = input["messages"].as_array().unwrap().iter().filter(|message| message["role"] == "tool").count();
            if results == 2 { tool("write_file", json!({"path":"allowed.txt","content":"allowed","expected_content":null})) }
            else { text("LIVE_POLICY_APPLIED") }
        }
        _ => unreachable!(),
    }).await;
    let (_data, project, engine, id) = setup(&fake).await;
    send(&engine, &id, "live-policy", "Check live permissions").await;
    let question = wait(&engine, &id, |value| value["status"] == "waiting_question").await;
    engine.call("updateSession", json!({"sessionId":id,"permissionMode":"ask"})).await.unwrap();
    engine.call("replyQuestion", json!({"sessionId":id,"requestId":question["questions"][0]["id"],"answer":{"answer_0":"Yes"}})).await.unwrap();
    let pending = wait(&engine, &id, |value| value["status"] == "waiting_permission").await;
    engine.call("updateSession", json!({"sessionId":id,"permissionMode":"full_access"})).await.unwrap();
    let still_pending = snapshot(&engine, &id).await;
    assert_eq!(still_pending["permissions"], pending["permissions"]);
    assert_eq!(still_pending["status"], "waiting_permission");
    assert!(!project.path().join("denied.txt").exists());
    engine.call("replyPermission", json!({"sessionId":id,"requestId":pending["permissions"][0]["id"],"decision":"reject"})).await.unwrap();
    wait(&engine, &id, |value| value["status"] == "idle").await;
    assert!(!project.path().join("denied.txt").exists());
    assert_eq!(tokio::fs::read_to_string(project.path().join("allowed.txt")).await.unwrap(), "allowed");
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn switching_models_rechecks_the_new_context_limit_before_the_next_request() {
    let fake = Fake::start(|_| tool("ask_user", json!({"questions":[{"question":"Continue?","options":[{"label":"Yes"}]}]}))).await;
    let (_data, project, engine, id) = setup(&fake).await;
    let mut models = catalog();
    let mut small = models["models"][0].clone();
    small["id"] = json!("lolicode/channel/small/model");
    small["modelId"] = json!("channel/small/model");
    small["contextLimit"] = json!(1024);
    models["models"].as_array_mut().unwrap().push(small);
    engine.bind(project.path().into(), models, fake.gateway()).await.unwrap();
    send(&engine, &id, "new-context", &"A useful long specification. ".repeat(250)).await;
    let pending = wait(&engine, &id, |value| value["status"] == "waiting_question").await;
    engine.call("updateSession", json!({"sessionId":id,"modelId":"lolicode/channel/small/model"})).await.unwrap();
    engine.call("replyQuestion", json!({"sessionId":id,"requestId":pending["questions"][0]["id"],"answer":{"answer_0":"Yes"}})).await.unwrap();
    let result = wait(&engine, &id, |value| value["status"] == "error").await;
    assert!(result["error"].as_str().unwrap().contains("上下文预算"));
    assert_eq!(fake.count(), 1, "the small model must not receive an over-budget request");
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn unknown_context_metadata_does_not_invent_a_small_limit_for_skills() {
    let skill = "COMPLETE_SKILL_BODY".repeat(2000);
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() {
            tool("read_skill", json!({"id":"large"}))
        } else {
            assert!(input.to_string().contains("COMPLETE_SKILL_BODY"));
            text("FULL_SKILL_WAS_AVAILABLE")
        }
    }).await;
    let (_data, project, engine, id) = setup(&fake).await;
    let mut models = catalog();
    models["models"][0].as_object_mut().unwrap().remove("contextLimit");
    engine.bind(project.path().into(), models, fake.gateway()).await.unwrap();
    engine.call("configureSkills", json!({"revision":1,"skills":[{"id":"large","name":"Large skill","content":skill}]})).await.unwrap();
    send(&engine, &id, "unknown-budget", "Read the entire relevant skill").await;
    let result = wait(&engine, &id, |value| matches!(value["status"].as_str(), Some("idle" | "error"))).await;
    assert_eq!(result["status"], "idle", "{}", result["error"]);
    assert!(result.to_string().contains("FULL_SKILL_WAS_AVAILABLE"));
    assert_eq!(engine.call("loadedSkills", json!({})).await.unwrap(), json!(["large"]));
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn generated_titles_persist_and_manual_titles_win_over_late_summaries() {
    let fake = Fake::start_with_titles(|_| text("Implemented the requested fix"), |_| text("修复主 Agent 交互")).await;
    let (data, project, engine, id) = setup(&fake).await;
    send(&engine, &id, "title-success", "Please fix the Agent interaction bugs").await;
    let result = wait(&engine, &id, |value| value["session"]["title"] == "修复主 Agent 交互").await;
    assert_eq!(result["status"], "idle");
    assert_eq!(result["titlePending"], false);
    let listed = engine.call("listSessions", json!({})).await.unwrap();
    assert_eq!(listed[0]["activity"], json!({"status":"idle","titlePending":false}));
    assert_eq!(fake.title_requests.lock().unwrap().len(), 1);
    assert!(fake.title_requests.lock().unwrap()[0]["tools"].as_array().unwrap().is_empty());
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened.bind(project.path().into(), catalog(), fake.gateway()).await.unwrap();
    assert_eq!(snapshot(&reopened, &id).await["session"]["title"], "修复主 Agent 交互");
    reopened.shutdown().await.unwrap();

    let late = Fake::start_with_titles(|_| text("Done"), |_| {
        let mut reply = text("迟到的自动标题"); reply.pause = true; reply
    }).await;
    let (_data, _project, engine, id) = setup(&late).await;
    send(&engine, &id, "title-late", "Use this as a provisional title").await;
    let provisional = wait(&engine, &id, |_| !late.title_requests.lock().unwrap().is_empty()).await;
    assert_eq!(provisional["session"]["title"], "Use this as a provisional title");
    assert_eq!(provisional["status"], "idle");
    assert_eq!(provisional["titlePending"], true);
    engine.call("renameSession", json!({"sessionId":id,"title":"我的手动标题"})).await.unwrap();
    late.resume.notify_one();
    tokio::time::timeout(Duration::from_secs(2), engine.settle_background_tasks()).await.unwrap();
    assert_eq!(snapshot(&engine, &id).await["session"]["title"], "我的手动标题");
    assert_eq!(snapshot(&engine, &id).await["titlePending"], false);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn title_failure_is_non_fatal_and_deleted_sessions_are_never_restored_by_a_summary() {
    let failed = Fake::start_with_titles(|_| text("Task succeeds"), |_| Reply {
        frames: Vec::new(), pause: false, status: 500, json_response: false,
    }).await;
    let (_data, _project, engine, id) = setup(&failed).await;
    send(&engine, &id, "title-failure", "Keep my task successful").await;
    wait(&engine, &id, |_| !failed.title_requests.lock().unwrap().is_empty()).await;
    tokio::time::timeout(Duration::from_secs(2), engine.settle_background_tasks()).await.unwrap();
    let result = snapshot(&engine, &id).await;
    assert_eq!(result["status"], "idle");
    assert!(result["error"].is_null());
    assert_eq!(result["titlePending"], false);
    assert_eq!(result["session"]["title"], "Keep my task successful");
    engine.shutdown().await.unwrap();

    let late = Fake::start_with_titles(|_| text("Done"), |_| {
        let mut reply = text("Do not resurrect this session"); reply.pause = true; reply
    }).await;
    let (data, _project, engine, id) = setup(&late).await;
    send(&engine, &id, "title-delete", "Delete this session when done").await;
    wait(&engine, &id, |_| !late.title_requests.lock().unwrap().is_empty()).await;
    engine.call("deleteSession", json!({"sessionId":id})).await.unwrap();
    late.resume.notify_one();
    tokio::time::timeout(Duration::from_secs(2), engine.settle_background_tasks()).await.unwrap();
    assert!(engine.call("getSession", json!({"sessionId":id})).await.is_err());
    assert_eq!(std::fs::read_dir(data.path().join("sessions")).unwrap().count(), 0);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn title_pending_is_visible_before_idle_and_is_cleared_on_shutdown_and_restart() {
    let fake = Fake::start_with_titles(|_| text("Done"), |_| {
        let mut reply = text("Slow title"); reply.pause = true; reply
    }).await;
    let (data, project, engine, id) = setup(&fake).await;
    send(&engine, &id, "pending-title", "Summarize this task").await;
    let pending = wait(&engine, &id, |value| value["status"] == "idle").await;
    assert_eq!(pending["titlePending"], true, "idle must not appear before pending title metadata");
    engine.shutdown().await.unwrap();
    assert_eq!(snapshot(&engine, &id).await["titlePending"], false);

    // Simulate a persisted title request whose process did not shut down cleanly.
    let path = std::fs::read_dir(data.path().join("sessions")).unwrap().next().unwrap().unwrap().path();
    let mut persisted: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    persisted["snapshot"]["titlePending"] = json!(true);
    persisted["snapshot"]["session"]["activity"] = json!({"status":"running","titlePending":true});
    std::fs::write(&path, serde_json::to_vec(&persisted).unwrap()).unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened.bind(project.path().into(), catalog(), fake.gateway()).await.unwrap();
    assert_eq!(snapshot(&reopened, &id).await["titlePending"], false);
    assert!(snapshot(&reopened, &id).await["session"].get("activity").is_none());
    let listed = reopened.call("listSessions", json!({})).await.unwrap();
    assert_eq!(listed[0]["activity"], json!({"status":"idle","titlePending":false}));
    reopened.shutdown().await.unwrap();

    // Pre-upgrade snapshots have no titlePending field and remain readable.
    persisted["snapshot"].as_object_mut().unwrap().remove("titlePending");
    persisted["snapshot"]["session"].as_object_mut().unwrap().remove("activity");
    let old: crate::AgentSnapshot = serde_json::from_value(persisted["snapshot"].clone()).unwrap();
    assert!(!old.title_pending);
    assert!(old.session.activity.is_none());
}

#[tokio::test]
async fn session_lists_project_real_background_activity_without_loading_message_bodies() {
    let fake = Fake::start_with_titles(|input| {
        let user = input["messages"].as_array().unwrap().iter().rev()
            .find(|message| message["role"] == "user").unwrap()["content"].as_str().unwrap();
        match user {
            "Wait for an answer" => tool("ask_user", json!({"questions":[{"question":"Which direction?","options":[{"label":"Continue"}]}]})),
            "Wait for permission" => tool("write_file", json!({"path":"approval.txt","content":"needs approval","expected_content":null})),
            "Keep running" => { let mut reply = text("STREAMED_BODY_MUST_NOT_APPEAR_IN_LIST"); reply.pause = true; reply },
            "Generate a title" => text("Completed task with a slow title"),
            _ => unreachable!(),
        }
    }, |_| { let mut reply = text("Slow automatic title"); reply.pause = true; reply }).await;
    let (data, _project, engine, question) = setup(&fake).await;
    let pinned = engine.call("createSession", json!({"title":"Pinned idle session"})).await.unwrap()["id"].as_str().unwrap().to_string();
    engine.call("setSessionMetadata", json!({"sessionId":pinned,"pinned":true})).await.unwrap();
    let running = engine.call("createSession", json!({})).await.unwrap()["id"].as_str().unwrap().to_string();
    let permission = engine.call("createSession", json!({"permissionMode":"ask"})).await.unwrap()["id"].as_str().unwrap().to_string();
    let title = engine.call("createSession", json!({})).await.unwrap()["id"].as_str().unwrap().to_string();
    send(&engine, &question, "background-question", "Wait for an answer").await;
    wait(&engine, &question, |value| value["status"] == "waiting_question").await;
    send(&engine, &running, "background-running", "Keep running").await;
    wait(&engine, &running, |value| value.to_string().contains("STREAMED_BODY_MUST_NOT_APPEAR_IN_LIST")).await;
    send(&engine, &permission, "background-permission", "Wait for permission").await;
    wait(&engine, &permission, |value| value["status"] == "waiting_permission").await;
    send(&engine, &title, "background-title", "Generate a title").await;
    wait(&engine, &title, |value| value["status"] == "idle").await;

    let sessions = engine.call("listSessions", json!({})).await.unwrap();
    assert_eq!(sessions[0]["id"], pinned, "active sessions must be discoverable beyond the first entry");
    for (id, expected) in [(&question, "waiting_question"), (&running, "running"), (&permission, "waiting_permission"), (&title, "idle")] {
        let session = sessions.as_array().unwrap().iter().find(|session| session["id"] == *id).unwrap();
        assert_eq!(session["activity"]["status"], expected);
        assert_eq!(session["activity"]["titlePending"], true);
        assert!(session.get("messages").is_none());
    }
    assert!(!sessions.to_string().contains("STREAMED_BODY_MUST_NOT_APPEAR_IN_LIST"));
    for record in std::fs::read_dir(data.path().join("sessions")).unwrap() {
        let stored: Value = serde_json::from_slice(&std::fs::read(record.unwrap().path()).unwrap()).unwrap();
        assert!(stored["snapshot"]["session"].get("activity").is_none(), "list projections must not become persisted activity truth");
    }
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_later_task_failure_does_not_hide_a_title_request_already_in_flight() {
    let fake = Fake::start_with_titles(|input| {
        let user = input["messages"].as_array().unwrap().iter().rev()
            .find(|message| message["role"] == "user").unwrap()["content"].as_str().unwrap();
        if user == "First task succeeds" { text("Done") }
        else { Reply { frames: Vec::new(), pause: false, status: 500, json_response: false } }
    }, |_| {
        let mut reply = text("主任务归纳"); reply.pause = true; reply
    }).await;
    let (_data, _project, engine, id) = setup(&fake).await;
    send(&engine, &id, "first-title", "First task succeeds").await;
    wait(&engine, &id, |_| !fake.title_requests.lock().unwrap().is_empty()).await;
    send(&engine, &id, "second-error", "Second task fails").await;
    let failed = wait(&engine, &id, |value| value["status"] == "error").await;
    assert_eq!(failed["titlePending"], true, "the earlier title request is still outstanding");
    fake.resume.notify_one();
    tokio::time::timeout(Duration::from_secs(2), engine.settle_background_tasks()).await.unwrap();
    let result = snapshot(&engine, &id).await;
    assert_eq!(result["session"]["title"], "主任务归纳");
    assert_eq!(result["titlePending"], false);
    assert_eq!(result["status"], "error");
    assert_eq!(result["error"], failed["error"], "title writes must preserve newer task results");
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn real_read_patch_continuation_persists_and_idempotent_restart_uses_no_process() {
    let fake = Fake::start(|input| match last_tool(input) {
        None => tool("read_file", json!({"path":"sum.rs"})),
        Some("call-read_file") => {
            assert!(input.to_string().contains("a-b"));
            tool(
                "apply_patch",
                json!({"path":"sum.rs","old_text":"a-b","new_text":"a+b"}),
            )
        }
        _ => text("DONE"),
    })
    .await;
    let (data, project, engine, id) = setup(&fake).await;
    tokio::fs::write(
        project.path().join("sum.rs"),
        "fn add(a:i32,b:i32)->i32 {a-b}\n",
    )
    .await
    .unwrap();
    send(&engine, &id, "request-once", "Fix the owned fixture").await;
    let result = wait(&engine, &id, |v| v["status"] == "idle").await;
    assert_eq!(fake.count(), 3);
    assert!(tokio::fs::read_to_string(project.path().join("sum.rs"))
        .await
        .unwrap()
        .contains("a+b"));
    assert!(!result["diffs"].as_array().unwrap().is_empty());
    assert_eq!(result["messages"][0]["id"], "request-once");
    assert_eq!(result["permissions"], json!([]));
    send(&engine, &id, "request-once", "Fix the owned fixture").await;
    assert_eq!(fake.count(), 3);
    assert!(engine
        .call(
            "sendMessage",
            json!({"sessionId":id,"requestId":"request-once","text":"different"})
        )
        .await
        .is_err());
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    let recovered = snapshot(&reopened, &id).await;
    assert_eq!(result["messages"], recovered["messages"]);
    send(&reopened, &id, "request-once", "Fix the owned fixture").await;
    assert_eq!(fake.count(), 3);
    assert_eq!(
        reopened
            .call(
                "queryCommand",
                json!({"sessionId":id,"requestId":"request-once"})
            )
            .await
            .unwrap()["results"][0]["result"]["status"],
        "completed"
    );
    let files = std::fs::read_dir(data.path().join("sessions")).unwrap();
    for file in files {
        let content = std::fs::read_to_string(file.unwrap().path()).unwrap();
        assert!(!content.contains("owned-private-gateway"));
    }
    assert_eq!(
        reopened.call("activity", json!({})).await.unwrap()["inProcess"],
        true
    );
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn dangerous_guarded_permissions_are_single_use_and_session_scoped() {
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() {
            tool(
                "run_command",
                json!({"command":"git clean -fd -- fixture.txt"}),
            )
        } else {
            text("DENIED_AND_CONTINUED")
        }
    })
    .await;
    let (_data, project, engine, a) = setup(&fake).await;
    tokio::fs::write(project.path().join("fixture.txt"), "preserve")
        .await
        .unwrap();
    let b = engine
        .call(
            "createSession",
            json!({"mode":"build","permissionMode":"auto"}),
        )
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    send(&engine, &a, "a-once", "Run guarded fixture").await;
    send(&engine, &b, "b-once", "Run guarded fixture").await;
    let pa =
        wait(&engine, &a, |v| v["status"] == "waiting_permission").await["permissions"][0].clone();
    let pb =
        wait(&engine, &b, |v| v["status"] == "waiting_permission").await["permissions"][0].clone();
    assert_eq!(pa["approvalMode"], "user-once");
    assert_eq!(pa["toolInput"]["command"], "git clean -fd -- fixture.txt");
    assert!(engine
        .call(
            "replyPermission",
            json!({"sessionId":b,"requestId":pa["id"],"decision":"reject"})
        )
        .await
        .is_err());
    assert!(engine
        .call(
            "replyPermission",
            json!({"sessionId":a,"requestId":pa["id"],"decision":"always"})
        )
        .await
        .is_err());
    assert!(engine.call("beginUpdate", json!({})).await.is_err());
    send(&engine, &a, "a-once", "Run guarded fixture").await;
    for (id, permission) in [(&a, pa), (&b, pb)] {
        engine
            .call(
                "replyPermission",
                json!({"sessionId":id,"requestId":permission["id"],"decision":"reject"}),
            )
            .await
            .unwrap();
        let value = wait(&engine, id, |v| v["status"] == "idle").await;
        assert_eq!(value["permissions"], json!([]));
    }
    assert_eq!(
        tokio::fs::read_to_string(project.path().join("fixture.txt"))
            .await
            .unwrap(),
        "preserve"
    );
    assert_eq!(fake.count(), 4);
    engine.call("beginUpdate", json!({})).await.unwrap();
    assert!(engine.call("createSession", json!({})).await.is_err());
    engine.call("endUpdate", json!({})).await.unwrap();
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn plan_write_is_denied_and_real_plan_approval_enables_next_round_write() {
    let fake = Fake::start(|input| match last_tool(input) {
        None => tool(
            "write_file",
            json!({"path":"plan.txt","content":"approved","expected_content":null}),
        ),
        Some("call-write_file") => {
            if input.to_string().contains("Plan approved") {
                text("DONE")
            } else {
                tool(
                    "exit_plan_mode",
                    json!({"plan":"Inspect the fixture.\nThen create plan.txt after approval."}),
                )
            }
        }
        _ => tool(
            "write_file",
            json!({"path":"plan.txt","content":"approved","expected_content":null}),
        ),
    })
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    engine
        .call("updateSession", json!({"sessionId":id,"mode":"plan"}))
        .await
        .unwrap();
    send(&engine, &id, "plan-once", "Plan this fixture").await;
    let question = wait(&engine, &id, |v| v["status"] == "waiting_question").await;
    assert!(!project.path().join("plan.txt").exists());
    assert_eq!(
        question["questions"][0]["fields"][0]["description"],
        "Inspect the fixture.\nThen create plan.txt after approval."
    );
    engine.call("replyQuestion",json!({"sessionId":id,"requestId":question["questions"][0]["id"],"answer":{"answer_0":"approve"}})).await.unwrap();
    let value = wait(&engine, &id, |v| v["status"] == "idle").await;
    assert_eq!(value["session"]["mode"], "build");
    assert_eq!(
        tokio::fs::read_to_string(project.path().join("plan.txt"))
            .await
            .unwrap(),
        "approved"
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn questions_preserve_multi_and_single_answers_then_continue() {
    let fake=Fake::start(|input|if last_tool(input).is_none(){tool("ask_user",json!({"questions":[{"question":"Choose many","multiSelect":true,"options":[{"label":"First"},{"label":"Second"}]},{"question":"Choose one","options":[{"label":"Third"}]}]}))}else{assert!(input.to_string().contains("Second"));text("ANSWER_RECEIVED")}).await;
    let (_data, _project, engine, id) = setup(&fake).await;
    send(&engine, &id, "question-once", "Ask fixture").await;
    let value = wait(&engine, &id, |v| v["status"] == "waiting_question").await;
    let question = &value["questions"][0];
    assert_eq!(question["fields"][0]["type"], "multiselect");
    assert_eq!(question["fields"][1]["type"], "string");
    engine.call("replyQuestion",json!({"sessionId":id,"requestId":question["id"],"answer":{"answer_0":["First","Second"],"answer_1":"Third"}})).await.unwrap();
    let value = wait(&engine, &id, |v| v["status"] == "idle").await;
    assert_eq!(value["questions"], json!([]));
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn stop_cancels_http_keeps_streamed_text_and_admission_is_not_replayed() {
    let fake = Fake::start(|_| Reply {
        frames: vec![
            json!({"choices":[{"delta":{"content":"真实流式前缀"},"finish_reason":null}]}),
        ],
        pause: true,
        status: 200,
        json_response: false,
    })
    .await;
    let (data, project, engine, id) = setup(&fake).await;
    let skills = json!({"revision":1,"skills":[{"id":"cancel-skill","name":"Cancel fixture","description":"fixture","content":"Complete fixture instructions"}]});
    engine
        .call("configureSkills", skills.clone())
        .await
        .unwrap();
    send(&engine, &id, "cancel-once", "Wait fixture").await;
    wait(&engine, &id, |v| v.to_string().contains("真实流式前缀")).await;
    assert!(engine.busy().await.unwrap());
    engine.call("configureSkills", skills).await.unwrap();
    assert!(engine
        .call("configureSkills", json!({"revision":2,"skills":[]}))
        .await
        .is_err());
    engine
        .call("interruptSession", json!({"sessionId":id}))
        .await
        .unwrap();
    let value = wait(&engine, &id, |v| v["status"] == "idle").await;
    assert!(value.to_string().contains("真实流式前缀"));
    assert!(!engine.busy().await.unwrap());
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    send(&reopened, &id, "cancel-once", "Wait fixture").await;
    assert_eq!(fake.count(), 1);
    assert!(snapshot(&reopened, &id)
        .await
        .to_string()
        .contains("真实流式前缀"));
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelling_permission_repairs_tool_history_without_executing_or_replaying_it() {
    let fake = Fake::start(|input| {
        let user = input["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "user")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        if user == "Wait for permission" {
            tool(
                "run_command",
                json!({"command":"git clean -fd -- fixture.txt"}),
            )
        } else {
            let history = input["messages"].as_array().unwrap();
            assert_eq!(
                history
                    .iter()
                    .filter(|m| m["tool_call_id"] == "call-run_command")
                    .count(),
                1
            );
            assert!(input.to_string().contains("interrupted"));
            text("RESUMED_WITHOUT_REPLAY")
        }
    })
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    tokio::fs::write(project.path().join("fixture.txt"), "preserved")
        .await
        .unwrap();
    send(&engine, &id, "cancel-permission", "Wait for permission").await;
    wait(&engine, &id, |v| v["status"] == "waiting_permission").await;
    engine
        .call("interruptSession", json!({"sessionId":id}))
        .await
        .unwrap();
    let stopped = wait(&engine, &id, |v| v["status"] == "idle").await;
    assert_eq!(stopped["permissions"], json!([]));
    send(&engine, &id, "after-permission", "Continue safely").await;
    let value = wait(&engine, &id, |v| v["status"] == "idle").await;
    assert!(value.to_string().contains("RESUMED_WITHOUT_REPLAY"));
    assert_eq!(fake.count(), 2);
    assert_eq!(
        tokio::fs::read_to_string(project.path().join("fixture.txt"))
            .await
            .unwrap(),
        "preserved"
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn oversized_skill_is_not_truncated_loaded_or_sent_to_a_known_small_context() {
    let body = "PRIVATE_BUDGETED_BODY".repeat(2000);
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() {
            tool("read_skill", json!({"id":"large"}))
        } else {
            assert!(!input.to_string().contains("PRIVATE_BUDGETED_BODY"));
            assert!(input.to_string().contains("上下文预算"));
            text("BUDGET_REJECTED_HONESTLY")
        }
    })
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    let mut small = catalog();
    small["models"][0]["contextLimit"] = json!(8192);
    engine
        .bind(project.path().into(), small, fake.gateway())
        .await
        .unwrap();
    engine.call("configureSkills",json!({"revision":1,"skills":[{"id":"large","name":"Large skill","description":"Relevant fixture","content":body}]})).await.unwrap();
    send(&engine, &id, "budgeted", "Read large skill").await;
    let value = wait(&engine, &id, |v| v["status"] == "idle").await;
    assert!(value.to_string().contains("BUDGET_REJECTED_HONESTLY"));
    assert_eq!(
        engine.call("loadedSkills", json!({})).await.unwrap(),
        json!([])
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_failed_atomic_admission_keeps_the_previous_record_and_starts_no_inference() {
    let fake = Fake::start(|_| text("MUST_NOT_BE_CALLED")).await;
    let (data, _project, engine, id) = setup(&fake).await;
    let sessions = data.path().join("sessions");
    let backup = data.path().join("saved-sessions");
    tokio::fs::rename(&sessions, &backup).await.unwrap();
    tokio::fs::write(&sessions, "Owned obstruction")
        .await
        .unwrap();
    assert!(engine
        .call(
            "sendMessage",
            json!({"sessionId":id,"requestId":"not-admitted","text":"Must remain a draft"})
        )
        .await
        .is_err());
    assert_eq!(fake.count(), 0);
    assert!(!engine.busy().await.unwrap());
    assert_eq!(snapshot(&engine, &id).await["messages"], json!([]));
    tokio::fs::remove_file(&sessions).await.unwrap();
    tokio::fs::rename(&backup, &sessions).await.unwrap();
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    assert_eq!(snapshot(&reopened, &id).await["messages"], json!([]));
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn skills_are_indexed_and_loaded_only_on_demand_with_budget_errors() {
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() {
            assert!(!input["messages"][0]["content"]
                .as_str()
                .unwrap()
                .contains("PRIVATE_SKILL_BODY"));
            tool("read_skill", json!({"id":"fixture-skill"}))
        } else {
            assert!(input.to_string().contains("PRIVATE_SKILL_BODY"));
            text("SKILL_USED")
        }
    })
    .await;
    let (_data, _project, engine, id) = setup(&fake).await;
    engine.call("configureSkills",json!({"revision":3,"skills":[{"id":"fixture-skill","name":"Fixture","description":"Use this fixture","content":"PRIVATE_SKILL_BODY"}]})).await.unwrap();
    assert_eq!(
        engine.call("loadedSkills", json!({})).await.unwrap(),
        json!([])
    );
    send(&engine, &id, "skill-once", "Use fixture skill").await;
    wait(&engine, &id, |v| v["status"] == "idle").await;
    assert_eq!(
        engine.call("loadedSkills", json!({})).await.unwrap(),
        json!(["fixture-skill"])
    );
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn gateway_failures_never_echo_tokens_and_invalid_endpoints_are_rejected() {
    let fake = Fake::start(|_| Reply {
        frames: Vec::new(),
        pause: false,
        status: 401,
        json_response: false,
    })
    .await;
    let (_data, project, engine, id) = setup(&fake).await;
    assert!(engine
        .bind(
            project.path().into(),
            catalog(),
            NativeGateway {
                base_url: "https://external.invalid/v1".into(),
                bearer_token: "owned-private-gateway".into()
            }
        )
        .await
        .is_err());
    send(&engine, &id, "error-once", "Fixture").await;
    let value = wait(&engine, &id, |v| v["status"] == "error").await;
    assert!(!value.to_string().contains("owned-private-gateway"));
    assert!(value["error"].as_str().unwrap().contains("401"));
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn fragmented_tool_arguments_and_pretty_json_compatible_replies_are_real_results() {
    let fake=Fake::start(|input| if last_tool(input).is_none() {
        let args=json!({"path":"分片.txt","content":"真实分片写入","expected_content":null}).to_string();
        let split=args.char_indices().nth(8).unwrap().0;
        Reply{frames:vec![
            json!({"choices":[{"delta":{"reasoning_content":"先检查工具参数。","tool_calls":[{"index":0,"id":"fragmented-write","function":{"name":"write_file","arguments":&args[..split]}}]},"finish_reason":null}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":&args[split..]}}]},"finish_reason":"tool_calls"}]})],pause:false,status:200,json_response:false}
    } else {
        let assistant=input["messages"].as_array().unwrap().iter().find(|message|message["role"]=="assistant").unwrap();
        assert_eq!(assistant["reasoning_content"], "先检查工具参数。");
        assert_eq!(assistant["tool_calls"][0]["id"], "fragmented-write");
        Reply{frames:vec![json!({"choices":[{"message":{"role":"assistant","content":"PRETTY_JSON_FINISHED"},"finish_reason":"stop"}]})],pause:false,status:200,json_response:true}
    }).await;
    let (_data, project, engine, id) = setup(&fake).await;
    send(
        &engine,
        &id,
        "fragmented-request",
        "Write the fragmented fixture",
    )
    .await;
    let value = wait(&engine, &id, |v| v["status"] == "idle").await;
    assert_eq!(
        tokio::fs::read_to_string(project.path().join("分片.txt"))
            .await
            .unwrap(),
        "真实分片写入"
    );
    assert!(value.to_string().contains("先检查工具参数。"));
    assert!(value.to_string().contains("PRETTY_JSON_FINISHED"));
    assert_eq!(fake.count(), 2);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn stream_eof_or_done_without_finish_reason_never_claims_a_successful_turn() {
    let fake = Fake::start(|_| Reply {
        frames: vec![
            json!({"choices":[{"delta":{"content":"Incomplete prefix"},"finish_reason":null}]}),
        ],
        pause: false,
        status: 200,
        json_response: false,
    })
    .await;
    let (_data, _project, engine, id) = setup(&fake).await;
    send(&engine, &id, "unfinished-stream", "Read fixture").await;
    let value = wait(&engine, &id, |v| v["status"] == "error").await;
    assert!(value.to_string().contains("Incomplete prefix"));
    assert!(value["error"].as_str().unwrap().contains("完成状态"));
    assert!(!engine.busy().await.unwrap());
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn successive_edits_keep_a_persistent_baseline_and_restoring_it_removes_the_diff() {
    let fake = Fake::start(|input| {
        let messages = input["messages"].as_array().unwrap();
        let start = messages.iter().rposition(|m| m["role"] == "user").unwrap();
        let user = messages[start]["content"].as_str().unwrap();
        let count = messages[start..]
            .iter()
            .filter(|m| m["role"] == "tool")
            .count();
        match (user, count) {
            ("existing", 0) => tool(
                "apply_patch",
                json!({"path":"existing.txt","old_text":"baseline","new_text":"middle"}),
            ),
            ("existing", 1) => tool(
                "apply_patch",
                json!({"path":"existing.txt","old_text":"middle","new_text":"final"}),
            ),
            ("restore", 0) => tool(
                "apply_patch",
                json!({"path":"existing.txt","old_text":"final","new_text":"baseline"}),
            ),
            ("new", 0) => tool(
                "write_file",
                json!({"path":"new.txt","content":"first\n","expected_content":null}),
            ),
            ("new", 1) => tool(
                "apply_patch",
                json!({"path":"new.txt","old_text":"first","new_text":"second"}),
            ),
            _ => text("CUMULATIVE_DONE"),
        }
    })
    .await;
    let (data, project, engine, id) = setup(&fake).await;
    tokio::fs::write(project.path().join("existing.txt"), "baseline\n")
        .await
        .unwrap();
    send(&engine, &id, "existing-edits", "existing").await;
    let value = wait(&engine, &id, |v| v["status"] == "idle").await;
    let patch = value["diffs"][0]["patch"].as_str().unwrap();
    assert!(patch.contains("-baseline"));
    assert!(patch.contains("+final"));
    assert!(!patch.contains("+middle"));
    assert_eq!(value["diffs"][0]["additions"], 1);
    assert_eq!(value["diffs"][0]["deletions"], 1);
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    send(&reopened, &id, "restore-edit", "restore").await;
    let value = wait(&reopened, &id, |v| v["status"] == "idle").await;
    assert_eq!(value["diffs"], json!([]));
    assert_eq!(
        tokio::fs::read_to_string(project.path().join("existing.txt"))
            .await
            .unwrap(),
        "baseline\n"
    );
    send(&reopened, &id, "new-edits", "new").await;
    let value = wait(&reopened, &id, |v| v["status"] == "idle").await;
    assert_eq!(value["diffs"][0]["status"], "added");
    assert!(value["diffs"][0]["patch"]
        .as_str()
        .unwrap()
        .contains("+second"));
    assert!(!value["diffs"][0]["patch"]
        .as_str()
        .unwrap()
        .contains("+first"));
    assert_eq!(fake.count(), 8);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_real_waiting_checkpoint_recovers_as_interrupted_without_replaying_its_tool() {
    let fake = Fake::start(|input| {
        let user = input["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "user")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        if user == "Wait at crash checkpoint" {
            tool(
                "run_command",
                json!({"command":"git clean -fd -- preserve.txt"}),
            )
        } else {
            assert!(input.to_string().contains("interrupted"));
            text("RECOVERED_WITHOUT_REPLAY")
        }
    })
    .await;
    let (data, project, engine, id) = setup(&fake).await;
    tokio::fs::write(project.path().join("preserve.txt"), "preserve")
        .await
        .unwrap();
    send(
        &engine,
        &id,
        "checkpoint-command",
        "Wait at crash checkpoint",
    )
    .await;
    wait(&engine, &id, |v| v["status"] == "waiting_permission").await;
    let recovery = tempfile::tempdir().unwrap();
    tokio::fs::create_dir(recovery.path().join("sessions"))
        .await
        .unwrap();
    let filename = format!("{}.json", id.trim_start_matches("lc:"));
    tokio::fs::copy(
        data.path().join("sessions").join(&filename),
        recovery.path().join("sessions").join(filename),
    )
    .await
    .unwrap();
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(recovery.path().into()).await.unwrap();
    let recovered = snapshot(&reopened, &id).await;
    assert_eq!(recovered["status"], "error");
    assert_eq!(recovered["permissions"], json!([]));
    assert!(recovered["error"].as_str().unwrap().contains("中断"));
    assert!(!reopened.busy().await.unwrap());
    reopened
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    send(
        &reopened,
        &id,
        "checkpoint-command",
        "Wait at crash checkpoint",
    )
    .await;
    assert_eq!(fake.count(), 1);
    send(&reopened, &id, "recover-next", "Continue after checkpoint").await;
    let result = wait(&reopened, &id, |v| v["status"] == "idle").await;
    assert!(result.to_string().contains("RECOVERED_WITHOUT_REPLAY"));
    assert_eq!(fake.count(), 2);
    assert_eq!(
        tokio::fs::read_to_string(project.path().join("preserve.txt"))
            .await
            .unwrap(),
        "preserve"
    );
    reopened.shutdown().await.unwrap();
}


struct HostedFixture {
    enabled: std::sync::atomic::AtomicBool,
    executions: std::sync::atomic::AtomicUsize,
}
impl applications::ApplicationTools for HostedFixture {
    fn schemas(&self) -> Vec<Value> {
        if !self.enabled.load(std::sync::atomic::Ordering::SeqCst) { return vec![]; }
        vec![json!({"type":"function","function":{"name":"tavern_fixture","description":"Host test","parameters":{"type":"object","properties":{}}}})]
    }
    fn inspect(&self, _: &std::path::Path, name: &str, _: &Value) -> Option<Result<applications::ToolInspection, String>> {
        if name != "tavern_fixture" { return None; }
        Some(if self.enabled.load(std::sync::atomic::Ordering::SeqCst) {
            Ok(applications::ToolInspection { action: name.into(), resources: vec!["tavern:fixture".into()], description: "Create fixture".into(), mutating: true, requires_approval: true, dangerous: false })
        } else { Err("APP_DISABLED_NO_SIDE_EFFECT".into()) })
    }
    fn execute<'a>(&'a self, project: &'a std::path::Path, name: &'a str, input: &'a Value, cancel: tokio::sync::watch::Receiver<bool>) -> applications::ApplicationResult<'a> {
        Box::pin(async move {
            if *cancel.borrow() { return Err("cancelled".into()); }
            self.inspect(project, name, input).unwrap()?;
            self.executions.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok("HOST_STORE_UPDATED".into())
        })
    }
}

#[tokio::test]
async fn application_tools_use_engine_permissions_and_revocation() {
    for revoke in [false, true] {
        let fake = Fake::start(|input| {
            if last_tool(input).is_none() { tool("tavern_fixture", json!({})) }
            else { text("HOST_TOOL_FINISHED") }
        }).await;
        let (_data, _project, engine, id) = setup(&fake).await;
        let host = Arc::new(HostedFixture { enabled: true.into(), executions: 0.into() });
        engine.set_application_tools(host.clone()).await;
        engine.call("updateSession", json!({"sessionId":id,"permissionMode":"ask"})).await.unwrap();
        send(&engine, &id, "host-approval", "Use the added application").await;
        let pending = wait(&engine, &id, |v| v["status"] == "waiting_permission").await;
        assert_eq!(host.executions.load(std::sync::atomic::Ordering::SeqCst), 0);
        host.enabled.store(!revoke, std::sync::atomic::Ordering::SeqCst);
        engine.call("replyPermission", json!({"sessionId":id,"requestId":pending["permissions"][0]["id"],"decision":"once"})).await.unwrap();
        let result = wait(&engine, &id, |v| v["status"] == "idle").await;
        assert_eq!(host.executions.load(std::sync::atomic::Ordering::SeqCst), usize::from(!revoke));
        assert!(result.to_string().contains(if revoke { "APP_DISABLED_NO_SIDE_EFFECT" } else { "HOST_STORE_UPDATED" }));
        let requests = fake.requests.lock().unwrap();
        let has_tool = |request: &Value| request["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "tavern_fixture");
        assert!(has_tool(&requests[0]));
        assert_eq!(has_tool(requests.last().unwrap()), !revoke);
        drop(requests);
        engine.shutdown().await.unwrap();
    }
}

struct RemoteHostFixture {
    target: std::sync::atomic::AtomicUsize,
    executions: std::sync::atomic::AtomicUsize,
}
impl applications::ApplicationTools for RemoteHostFixture {
    fn schemas(&self) -> Vec<Value> {
        vec![json!({"type":"function","function":{"name":"local_domain_only"}})]
    }
    fn project_schemas(&self, _: &std::path::Path) -> Option<Vec<Value>> {
        Some(applications::core_tool_schemas())
    }
    fn project_context(&self, _: &std::path::Path) -> Option<String> {
        Some("REMOTE_FIXTURE: tools operate on the remote project, never on the private local anchor.".into())
    }
    fn inspect(&self, _: &std::path::Path, name: &str, _: &Value) -> Option<Result<applications::ToolInspection, String>> {
        if name != "write_file" { return None; }
        Some(Ok(applications::ToolInspection {
            action: "remote-edit".into(),
            resources: vec![format!("remote-target-{}/remote.txt", self.target.load(std::sync::atomic::Ordering::SeqCst))],
            description: "Edit remote fixture".into(), mutating: true, requires_approval: true, dangerous: false,
        }))
    }
    fn execute<'a>(&'a self, _: &'a std::path::Path, _: &'a str, _: &'a Value, _: tokio::sync::watch::Receiver<bool>) -> applications::ApplicationResult<'a> {
        Box::pin(async { panic!("structured outputs must not be reduced to text") })
    }
    fn execute_output<'a>(&'a self, _: &'a std::path::Path, _: &'a str, _: &'a Value, cancel: tokio::sync::watch::Receiver<bool>) -> applications::ApplicationOutput<'a> {
        Box::pin(async move {
            if *cancel.borrow() { return Err("任务已停止".into()); }
            self.executions.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(applications::ToolOutput {
                text: "REMOTE_RECEIPT_ONLY".into(),
                image_data_url: Some("data:image/png;base64,REMOTE_IMAGE_FIXTURE".into()),
                diffs: vec![],
                file_changes: vec![applications::FileChange { path: "remote.txt".into(), before: Some("PRIVATE_BEFORE_SNAPSHOT".into()), after: Some("PRIVATE_AFTER_SNAPSHOT".into()) }],
            })
        })
    }
}

#[tokio::test]
async fn hosted_structured_results_preserve_private_diffs_and_model_images() {
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() { tool("write_file", json!({"path":"remote.txt","content":"ignored","expected_content":null})) }
        else { text("REMOTE_TASK_FINISHED") }
    }).await;
    let (data, project, engine, id) = setup(&fake).await;
    let host = Arc::new(RemoteHostFixture { target: 1.into(), executions: 0.into() });
    engine.set_application_tools(host.clone()).await;
    send(&engine, &id, "remote-structured", "Edit the remote file").await;
    let result = wait(&engine, &id, |v| v["status"] == "idle").await;
    assert_eq!(host.executions.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(!project.path().join("remote.txt").exists(), "no write may hit the local anchor");
    assert_eq!(result["diffs"][0]["path"], "remote.txt");
    assert!(result["diffs"].to_string().contains("PRIVATE_AFTER_SNAPSHOT"));
    {
        let requests = fake.requests.lock().unwrap();
        let next = requests.last().unwrap();
        assert!(next["messages"][0]["content"].as_str().unwrap().contains("REMOTE_FIXTURE"));
        assert!(next["messages"].to_string().contains("REMOTE_IMAGE_FIXTURE"));
        assert!(next["messages"].to_string().contains("REMOTE_RECEIPT_ONLY"));
        assert!(!next["messages"].to_string().contains("PRIVATE_BEFORE_SNAPSHOT"));
        assert!(!next["messages"].to_string().contains("PRIVATE_AFTER_SNAPSHOT"));
        assert!(!next["tools"].to_string().contains("local_domain_only"));
        assert!(next["tools"].to_string().contains("ask_user"));
    }
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    assert_eq!(snapshot(&reopened, &id).await["diffs"], result["diffs"], "remote cumulative diffs survive a real store reopen");
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn hosted_approval_cannot_be_reused_after_target_change() {
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() { tool("write_file", json!({"path":"remote.txt","content":"x","expected_content":null})) }
        else { text("RETARGET_CHECK_FINISHED") }
    }).await;
    let (_data, project, engine, id) = setup(&fake).await;
    let host = Arc::new(RemoteHostFixture { target: 1.into(), executions: 0.into() });
    engine.set_application_tools(host.clone()).await;
    engine.call("updateSession", json!({"sessionId":id,"permissionMode":"ask"})).await.unwrap();
    send(&engine, &id, "remote-retarget", "Edit the remote file").await;
    let pending = wait(&engine, &id, |v| v["status"] == "waiting_permission").await;
    host.target.store(2, std::sync::atomic::Ordering::SeqCst);
    engine.call("replyPermission", json!({"sessionId":id,"requestId":pending["permissions"][0]["id"],"decision":"once"})).await.unwrap();
    let result = wait(&engine, &id, |v| v["status"] == "idle").await;
    assert_eq!(host.executions.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(result.to_string().contains("工具目标或权限范围已经改变"));
    assert!(!project.path().join("remote.txt").exists());
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn project_tool_replacement_fails_closed_for_unhandled_local_tools() {
    let fake = Fake::start(|input| {
        if last_tool(input).is_none() { tool("read_file", json!({"path":"private-local.txt"})) }
        else { text("NO_LOCAL_FALLBACK") }
    }).await;
    let (_data, project, engine, id) = setup(&fake).await;
    std::fs::write(project.path().join("private-local.txt"), "LOCAL_ANCHOR_SECRET").unwrap();
    engine.set_application_tools(Arc::new(RemoteHostFixture { target: 1.into(), executions: 0.into() })).await;
    send(&engine, &id, "no-fallback", "Read a remote file").await;
    let result = wait(&engine, &id, |v| v["status"] == "idle").await;
    assert!(result.to_string().contains("没有可用的远程执行接口"));
    assert!(!fake.requests.lock().unwrap().last().unwrap()["messages"].to_string().contains("LOCAL_ANCHOR_SECRET"));
    engine.shutdown().await.unwrap();
}
