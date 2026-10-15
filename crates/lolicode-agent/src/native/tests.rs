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
    task: tokio::task::JoinHandle<()>,
    children: Arc<StdMutex<Vec<tokio::task::JoinHandle<()>>>>,
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/v1", listener.local_addr().unwrap());
        let handler = Arc::new(handler);
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let children = Arc::new(StdMutex::new(Vec::new()));
        let recorded = requests.clone();
        let child_list = children.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let handler = handler.clone();
                let requests = recorded.clone();
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
                    assert_eq!(body["model"], "channel/opaque/model");
                    requests.lock().unwrap().push(body.clone());
                    let reply = handler(&body);
                    if reply.status != 200 {
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
                            tokio::time::sleep(Duration::from_secs(60)).await;
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
            task,
            children,
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
        "accepted"
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
async fn oversized_skill_is_not_truncated_loaded_or_sent_to_a_small_unknown_context() {
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
    small["models"][0]
        .as_object_mut()
        .unwrap()
        .remove("contextLimit");
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
