//! Public-API acceptance of the production secretary/worker chain. The model
//! transport is a bounded local fixture; file writes and durable sessions are real.
use lolicode_agent::{NativeEngine, NativeGateway};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

struct ModelFixture {
    address: String,
    parent: Arc<Mutex<String>>,
    requests: Arc<Mutex<HashMap<String, usize>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for ModelFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn request(stream: &mut TcpStream) -> Option<(String, Value)> {
    let mut bytes = Vec::new();
    let end = loop {
        let mut chunk = [0; 8192];
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break end + 4;
        }
        assert!(bytes.len() < 65536, "bounded HTTP fixture header");
    };
    let headers = String::from_utf8(bytes[..end].to_vec()).ok()?;
    assert!(headers.starts_with("POST /v1/chat/completions "));
    let header = |name: &str| {
        headers.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    };
    let length: usize = header("content-length")?.parse().ok()?;
    assert!(length < 2 * 1024 * 1024, "bounded model request");
    while bytes.len() < end + length {
        let mut chunk = [0; 8192];
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
    Some((
        header("x-lolicode-session-id")?,
        serde_json::from_slice(&bytes[end..end + length]).ok()?,
    ))
}

fn call(id: &str, name: &str, arguments: Value) -> Value {
    json!({"index":0,"id":id,"type":"function","function":{"name":name,"arguments":arguments.to_string()}})
}

impl ModelFixture {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/v1", listener.local_addr().unwrap());
        let parent = Arc::new(Mutex::new(String::new()));
        let requests = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
        let (owner, counts) = (parent.clone(), requests.clone());
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let (owner, counts) = (owner.clone(), counts.clone());
                tokio::spawn(async move {
                    let Some((session, body)) = request(&mut stream).await else {
                        return;
                    };
                    let system = body["messages"][0]["content"].as_str().unwrap_or_default();
                    let title = system.starts_with("You generate a short session title");
                    let parent = *owner.lock().unwrap() == session;
                    let count = if title {
                        0
                    } else {
                        let mut counts = counts.lock().unwrap();
                        let count = counts.entry(session).or_default();
                        *count += 1;
                        *count
                    };
                    let serialized = body["messages"].to_string();
                    let (delta, finish) = if title {
                        (json!({"content":"验收工作对话"}), "stop")
                    } else if parent && count == 1 {
                        let a = call(
                            "acceptance-delegate-a",
                            "delegate_task",
                            json!({"title":"创建说明 A","instructions":"在项目根目录创建 a.txt，内容为 ACCEPTANCE_A；完成后报告 WORKER_A_CONFIRMED。"}),
                        );
                        let mut b = call(
                            "acceptance-delegate-b",
                            "delegate_task",
                            json!({"title":"创建说明 B","instructions":"在项目根目录创建 b.txt，内容为 ACCEPTANCE_B；完成后报告 WORKER_B_CONFIRMED。"}),
                        );
                        b["index"] = json!(1);
                        (json!({"tool_calls":[a,b]}), "tool_calls")
                    } else if parent {
                        let mut result = String::from("总秘书已接收工作状态。");
                        // Report only facts which actually arrived from workers,
                        // rather than the original assignment's requested marker.
                        for marker in ["WORKER_A_CONFIRMED", "WORKER_B_CONFIRMED"] {
                            let reported =
                                body["messages"].as_array().unwrap().iter().any(|message| {
                                    message["role"] == "user"
                                        && message["content"].to_string().contains(marker)
                                });
                            if reported {
                                result.push_str(marker);
                            }
                        }
                        (json!({"content":result}), "stop")
                    } else if count == 1 {
                        let a = serialized.contains("ACCEPTANCE_A");
                        (
                            json!({"tool_calls":[call("acceptance-write", "write_file", json!({"path":if a {"a.txt"} else {"b.txt"},"content":if a {"ACCEPTANCE_A"} else {"ACCEPTANCE_B"},"expected_content":null}))]}),
                            "tool_calls",
                        )
                    } else {
                        (
                            json!({"content":if serialized.contains("ACCEPTANCE_A") {"WORKER_A_CONFIRMED"} else {"WORKER_B_CONFIRMED"}}),
                            "stop",
                        )
                    };
                    let frame = json!({"choices":[{"delta":delta,"finish_reason":finish}]});
                    let response = format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/event-stream\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n");
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        Self {
            address,
            parent,
            requests,
            task,
        }
    }
    fn gateway(&self) -> NativeGateway {
        NativeGateway {
            base_url: self.address.clone(),
            bearer_token: "isolated-secretary-fixture".into(),
        }
    }
}

#[tokio::test]
async fn natural_language_delegation_writes_files_reports_and_survives_reopen() {
    let transport = ModelFixture::start().await;
    let data = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let project = workspace.path().join("秘书 验收项目");
    tokio::fs::create_dir(&project).await.unwrap();
    let catalog = json!({"revision":1,"models":[{"id":"lolicode/fixture/model","providerId":"lolicode","modelId":"fixture/model","name":"Local protocol fixture","channelName":"Local fixture","contextLimit":128000}],"defaultModel":"lolicode/fixture/model","excludedSources":[]});
    let engine = NativeEngine::open(data.path().into()).await.unwrap();
    engine
        .bind(project.clone(), catalog.clone(), transport.gateway())
        .await
        .unwrap();
    let parent = engine.call("openSecretary", json!({"projectPath":project,"modelId":"lolicode/fixture/model","permissionMode":"auto","locale":"zh"})).await.unwrap();
    assert_eq!(parent["coordination"]["role"], "secretary");
    let id = parent["id"].as_str().unwrap();
    *transport.parent.lock().unwrap() = id.into();
    engine.call("sendMessage", json!({"sessionId":id,"requestId":"public-acceptance-request","text":"帮我分别创建两份说明文件，做完后统一告诉我结果。","locale":"zh"})).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let state = loop {
        let tasks = engine
            .call("getSecretary", json!({"sessionId":id}))
            .await
            .unwrap();
        let parent = engine
            .call("getSession", json!({"sessionId":id}))
            .await
            .unwrap();
        let completed = tasks["tasks"].as_array().is_some_and(|items| {
            items.len() == 2 && items.iter().all(|item| item["status"] == "completed")
        });
        let final_text = parent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "assistant")
            .map(Value::to_string)
            .collect::<String>();
        if completed
            && parent["status"] == "idle"
            && final_text.contains("WORKER_A_CONFIRMED")
            && final_text.contains("WORKER_B_CONFIRMED")
        {
            break tasks;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "secretary chain did not settle: tasks={tasks}, parent={parent}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(
        tokio::fs::read_to_string(project.join("a.txt"))
            .await
            .unwrap(),
        "ACCEPTANCE_A"
    );
    assert_eq!(
        tokio::fs::read_to_string(project.join("b.txt"))
            .await
            .unwrap(),
        "ACCEPTANCE_B"
    );
    for task in state["tasks"].as_array().unwrap() {
        let worker = engine
            .call("getSession", json!({"sessionId":task["sessionId"]}))
            .await
            .unwrap();
        assert_eq!(worker["session"]["coordination"]["parentSessionId"], id);
        assert_eq!(worker["session"]["permissionMode"], "auto");
        assert_eq!(worker["session"]["model"], parent["model"]);
        assert!(
            worker["diffs"]
                .as_array()
                .is_some_and(|diffs| !diffs.is_empty()),
            "file evidence remains in native diff history"
        );
    }
    engine.shutdown().await.unwrap();
    let requests_before = transport.requests.lock().unwrap().values().sum::<usize>();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.clone(), catalog, transport.gateway())
        .await
        .unwrap();
    let same_parent = reopened.call("openSecretary", json!({"projectPath":project,"modelId":"lolicode/fixture/model","permissionMode":"auto"})).await.unwrap();
    assert_eq!(
        same_parent["id"], id,
        "one persistent secretary per project"
    );
    let after = reopened
        .call("getSecretary", json!({"sessionId":id}))
        .await
        .unwrap();
    assert_eq!(
        after["tasks"], state["tasks"],
        "completed task graph survives restart"
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        transport.requests.lock().unwrap().values().sum::<usize>(),
        requests_before,
        "restart does not rerun completed work"
    );
    reopened.shutdown().await.unwrap();
    eprintln!(
        "{}",
        json!({"scenario":"native-secretary-public-workflow","passed":true,"modelTransport":"local-deterministic-SSE","externalModelCalls":0,"realProjectFiles":2,"workerTasks":2,"automaticReports":true,"persistentSecretary":true,"completedWorkReplayed":false})
    );
}
