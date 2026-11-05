//! Local model, managed process, and real browser acceptance for the chief view.
use super::*;
use crate::{database::Database, store::AppState};
use axum::{body::Body, http::HeaderMap, response::Response, routing::post, Json, Router};
use lolicode_agent::{NativeEngine, NativeGateway};
use std::time::Duration;
use tokio::net::TcpListener;

const GOAL: &str = "请分派一个任务，做一个本地网页并展示运行结果。";
const TITLE: &str = "Secretary live preview fixture";
const PAGE: &str = "<!doctype html><title>Secretary live preview fixture</title><h1>Secretary live preview fixture</h1>";

fn tool(name: &str, arguments: Value) -> Value {
    json!({"tool_calls":[{"index":0,"id":format!("acceptance-{name}"),"type":"function",
        "function":{"name":name,"arguments":arguments.to_string()}}]})
}

fn model_response(request: &Value, is_chief: bool, port: u16) -> Response {
    let messages = request["messages"].as_array().unwrap();
    let title_request = messages[0]["content"]
        .as_str()
        .is_some_and(|text| text.starts_with("You generate a short session title"));
    let delta = if title_request {
        json!({"content":"Acceptance session"})
    } else if is_chief {
        if messages.last().unwrap()["content"] == GOAL {
            tool(
                "delegate_task",
                json!({"title":"Build the preview fixture", "instructions":"Write index.html, start the provided local server and open the running page.","execution_mode":"shared"}),
            )
        } else {
            json!({"content":"Worker status received."})
        }
    } else {
        let completed_tools = messages
            .iter()
            .filter(|message| message["role"] == "tool")
            .count();
        match completed_tools {
            0 => tool(
                "write_file",
                json!({"path":"index.html","content":PAGE,"expected_content":null}),
            ),
            1 => tool(
                "manage_process",
                json!({"action":"start","command":"node server.cjs","port":port}),
            ),
            2 => tool(
                "browser_open",
                json!({"url":format!("http://127.0.0.1:{port}/"),"width":640,"height":480}),
            ),
            _ => json!({"content":"The local page is ready."}),
        }
    };
    let finish = if delta.get("tool_calls").is_some() {
        "tool_calls"
    } else {
        "stop"
    };
    let frame = json!({"choices":[{"delta":delta,"finish_reason":finish}]});
    Response::builder()
        .header("Content-Type", "text/event-stream")
        .body(Body::from(format!("data: {frame}\n\ndata: [DONE]\n\n")))
        .unwrap()
}

#[tokio::test]
#[ignore = "requires an installed Node.js and Chromium browser"]
async fn delegated_worker_hands_off_live_browser_preview() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let page_port = TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    std::fs::write(
        project.join("server.cjs"),
        format!(
            "const fs = require('node:fs');\n\
             require('node:http').createServer((req, res) => {{\n\
             res.setHeader('Content-Type', 'text/html; charset=utf-8');\n\
             res.end(fs.readFileSync('index.html'));\n\
             }}).listen({page_port}, '127.0.0.1');"
        ),
    )
    .unwrap();
    let db = Arc::new(Database::memory().unwrap());
    let (remote, _) =
        super::super::remote_projects::fixture(db.clone(), temp.path().join("anchors"));
    let host = Arc::new(DesktopToolHost {
        local: DesktopApplicationTools(AppState::new(db)),
        remote,
        mcp: None,
        browser: BrowserTools::default(),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let engine = NativeEngine::open(temp.path().join("sessions"))
        .await
        .unwrap();
    engine.set_application_tools(host.clone()).await;
    let model = "owned/channel/model";
    let catalog = json!({
        "revision": 1,
        "models": [{
            "id": model,
            "providerId": "owned",
            "modelId": "channel/model",
            "name": "Loopback fixture",
            "channelName": "Loopback fixture",
            "contextLimit": 128000
        }],
        "defaultModel": model,
        "excludedSources": []
    });
    engine
        .bind(
            project.clone(),
            catalog,
            NativeGateway {
                base_url: format!("http://{address}/v1"),
                bearer_token: "owned-loopback-model".into(),
            },
        )
        .await
        .unwrap();
    let chief = engine
        .call(
            "openSecretary",
            json!({"projectPath":project,"modelId":model,"permissionMode":"full_access"}),
        )
        .await
        .unwrap();
    let chief_id = chief["id"].as_str().unwrap();
    let expected_chief = Arc::<str>::from(chief_id);
    let router = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap, Json(request): Json<Value>| {
            let is_chief = headers
                .get("x-lolicode-session-id")
                .and_then(|header| header.to_str().ok())
                == Some(expected_chief.as_ref());
            async move { model_response(&request, is_chief, page_port) }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    engine
        .call(
            "sendMessage",
            json!({"sessionId":chief_id,"requestId":"owned-preview-goal","text":GOAL}),
        )
        .await
        .unwrap();

    let (worker_id, hint) = tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let graph = engine
                .call("getSecretary", json!({"sessionId":chief_id}))
                .await
                .unwrap();
            let chief = engine
                .call("getSession", json!({"sessionId":chief_id}))
                .await
                .unwrap();
            let task = &graph["tasks"][0];
            assert!(
                !matches!(
                    task["status"].as_str(),
                    Some("failed" | "cancelled" | "interrupted")
                ),
                "{task}"
            );
            if task["status"] == "completed" && chief["status"] == "idle" {
                assert_eq!(graph["tasks"].as_array().unwrap().len(), 1);
                break (
                    task["sessionId"].as_str().unwrap().to_owned(),
                    chief["preview"].clone(),
                );
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the chief and worker should settle");
    assert_eq!(
        std::fs::read_to_string(project.join("index.html")).unwrap(),
        PAGE
    );
    assert_eq!(hint["kind"], "browser", "expected live handoff, got {hint}");
    assert_eq!(hint["sessionId"], worker_id);
    let local_url = format!("http://127.0.0.1:{page_port}/");
    assert_eq!(hint["url"], local_url);
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
        .get(local_url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(response.text().await.unwrap(), PAGE);
    let browser_id = hint["browserId"].as_str().unwrap();
    assert!(engine
        .call(
            "getSessionExecutionRoot",
            json!({"sessionId":chief_id,"browserId":browser_id})
        )
        .await
        .is_err());
    let (_, root): (String, String) = serde_json::from_value(
        engine
            .call(
                "getSessionExecutionRoot",
                json!({"sessionId":worker_id,"browserId":browser_id}),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    let root = Path::new(&root);
    let frame = host.browser.preview_frame(root, browser_id).await.unwrap();
    let bytes = STANDARD
        .decode(frame.strip_prefix("data:image/png;base64,").unwrap())
        .unwrap();
    let png = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).unwrap();
    assert_eq!((png.width(), png.height()), (640, 480));
    let (_stop, cancel) = watch::channel(false);
    let snapshot = host
        .execute_output(
            root,
            "browser_snapshot",
            &json!({"browser_id":browser_id}),
            cancel,
        )
        .await
        .unwrap();
    assert!(snapshot.text.contains(TITLE), "{}", snapshot.text);

    host.browser.shutdown().await;
    engine.shutdown().await.unwrap();
    server.abort();
}
