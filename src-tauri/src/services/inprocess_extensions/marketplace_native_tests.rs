use super::*;
use axum::{body::Body, extract::State, response::Response, routing::post, Json};
use lolicode_agent::native::{NativeEngine, NativeGateway};
use std::{
    io::Write,
    sync::{Arc, Mutex},
};

async fn upstream(
    State(requests): State<Arc<Mutex<Vec<Value>>>>,
    Json(body): Json<Value>,
) -> Response {
    let title = body["messages"][0]["content"]
        .as_str()
        .is_some_and(|text| text.starts_with("You generate a short session title"));
    let count = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .count();
    let command = if cfg!(windows) {
        "powershell -NoProfile -ExecutionPolicy Bypass -File ./fixture-cli.ps1 --version"
    } else {
        "sh ./fixture-cli.sh --version"
    };
    let choice = if title {
        json!({"delta":{"content":"Fixture CLI"},"finish_reason":"stop"})
    } else {
        match count {
            0 => {
                json!({"delta":{"tool_calls":[{"index":0,"id":"read-cli-skill","type":"function","function":{"name":"read_skill","arguments":json!({"id":"cli-github-setup"}).to_string()}}]},"finish_reason":"tool_calls"})
            }
            1 => {
                json!({"delta":{"tool_calls":[{"index":0,"id":"run-cli-fixture","type":"function","function":{"name":"run_command","arguments":json!({"command":command,"timeout_seconds":15}).to_string()}}]},"finish_reason":"tool_calls"})
            }
            _ => json!({"delta":{"content":"OWNED_CLI_TASK_COMPLETED"},"finish_reason":"stop"}),
        }
    };
    if !title {
        requests.lock().unwrap().push(body);
    }
    let sse = format!("data: {}\n\ndata: [DONE]\n\n", json!({"choices":[choice]}));
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(sse))
        .unwrap()
}

#[tokio::test]
async fn cli_marketplace_native_skill_and_permission_controlled_cli_execute_in_sandbox() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("extensions/cli-marketplace");
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path,content) in [
        ("github/.zcode-plugin/plugin.json",r#"{"name":"github","version":"0.1.2"}"#),
        ("github/skills/setup/SKILL.md","---\nname: setup\ndescription: OWNED_CLI_SETUP_DISCOVERY\n---\nOWNED_CLI_PRIVATE_BODY\nRead ../../references/preflight.md first."),
        ("github/references/preflight.md","OWNED_CLI_PREFLIGHT_INLINE"),
    ] {writer.start_file(path,zip::write::SimpleFileOptions::default()).unwrap();writer.write_all(content.as_bytes()).unwrap();}
    let bytes = writer.finish().unwrap().into_inner();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    install_archive(&root, "github", "0.1.2", &hash, bytes).unwrap();
    let (skills, issues) = skills(&root).unwrap();
    assert!(issues.is_empty());
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    if cfg!(windows) {
        fs::write(project.join("fixture-cli.ps1"),"Set-Content -LiteralPath cli-result.txt -Value OWNED_CLI_VERSION\nWrite-Output OWNED_CLI_VERSION").unwrap();
    } else {
        fs::write(
            project.join("fixture-cli.sh"),
            "printf OWNED_CLI_VERSION > cli-result.txt\nprintf OWNED_CLI_VERSION",
        )
        .unwrap();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = requests.clone();
    struct Server(tokio::task::JoinHandle<()>);
    impl Drop for Server {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _server = Server(tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new()
                .route("/v1/chat/completions", post(upstream))
                .with_state(captured),
        )
        .await
        .unwrap();
    }));
    let engine = NativeEngine::open(temp.path().join("native"))
        .await
        .unwrap();
    engine.bind(project.clone(),json!({"revision":1,"models":[{"id":"lolicode/owned/cli","providerId":"lolicode","modelId":"owned/cli","name":"Fixture","channelName":"Owned","contextLimit":128000}],"defaultModel":"lolicode/owned/cli","excludedSources":[]}),NativeGateway{base_url:format!("http://{address}/v1"),bearer_token:"owned-fixture-only".into()}).await.unwrap();
    engine
        .call("configureSkills", json!({"revision":1,"skills":skills}))
        .await
        .unwrap();
    let session = engine
        .call(
            "createSession",
            json!({"mode":"build","permissionMode":"ask"}),
        )
        .await
        .unwrap();
    let id = session["id"].as_str().unwrap();
    engine
        .call(
            "sendMessage",
            json!({"sessionId":id,"requestId":"owned-cli-run","text":"Use the owned CLI fixture."}),
        )
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut approved = false;
    let snapshot = loop {
        let value = engine
            .call("getSession", json!({"sessionId":id}))
            .await
            .unwrap();
        if value["status"] == "waiting_permission" {
            assert!(
                !project.join("cli-result.txt").exists(),
                "The CLI script must not execute before approval"
            );
            assert_eq!(value["permissions"][0]["toolName"], "run_command");
            engine.call("replyPermission",json!({"sessionId":id,"requestId":value["permissions"][0]["id"],"decision":"once"})).await.unwrap();
            approved = true;
        }
        if value["status"] == "idle" || value["status"] == "error" {
            break value;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "CLI fixture did not finish"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(snapshot["status"], "idle", "{}", snapshot["error"]);
    assert!(approved);
    assert!(fs::read_to_string(project.join("cli-result.txt"))
        .unwrap()
        .contains("OWNED_CLI_VERSION"));
    assert_eq!(
        engine.call("loadedSkills", json!({})).await.unwrap(),
        json!(["cli-github-setup"])
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(
        !requests[0].to_string().contains("OWNED_CLI_PRIVATE_BODY"),
        "Skill bodies must remain on demand"
    );
    assert!(requests[1].to_string().contains("OWNED_CLI_PRIVATE_BODY"));
    assert!(requests[1]
        .to_string()
        .contains("OWNED_CLI_PREFLIGHT_INLINE"));
    assert!(requests[2].to_string().contains("OWNED_CLI_VERSION"));
    drop(requests);
    engine.shutdown().await.unwrap();
    println!("CLI_NATIVE_ACCEPTANCE_OK: isolated install -> on-demand read_skill + references -> approval -> real local CLI script -> verified output");
}
