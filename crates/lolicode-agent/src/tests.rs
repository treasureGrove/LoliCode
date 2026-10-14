use crate::{
    mapping,
    runtime::test_access,
    stream::{LiveState, SseDecoder},
    *,
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
};

fn event(kind: &str, ordinal: u64, extra: Value) -> Value {
    let mut data =
        json!({ "sessionID":"ses_test", "assistantMessageID":"msg_assistant", "ordinal":ordinal });
    data.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    json!({ "id":uuid::Uuid::new_v4().to_string(), "type":kind, "created":1001, "data":data })
}

fn assistant(content: Value, completed: bool) -> AgentMessage {
    let mut raw =
        json!({"id":"msg_assistant","type":"assistant","time":{"created":1000},"content":content});
    if completed {
        raw["time"]["completed"] = json!(1002);
    }
    mapping::message(&raw).unwrap()
}

#[test]
fn live_text_is_streamed_without_duplicating_persisted_final_text() {
    let mut state = LiveState::default();
    state.track("ses_test");
    state.apply(&event("session.text.started", 0, json!({})));
    state.apply(&event("session.text.delta", 0, json!({"delta":"修改"})));
    state.apply(&event("session.text.delta", 0, json!({"delta":"完成"})));
    let mut partial = vec![assistant(json!([{"type":"text","text":""}]), false)];
    assert!(!state.overlay("ses_test", &mut partial));
    assert_eq!(
        partial[0].parts[0],
        AgentPart::Text {
            text: "修改完成".into()
        }
    );
    // A second snapshot starts from DB again and must not append the same prefix.
    let mut again = vec![assistant(json!([{"type":"text","text":""}]), false)];
    state.overlay("ses_test", &mut again);
    assert_eq!(again, partial);
    state.apply(&event("session.text.ended", 0, json!({"text":"修改完成"})));
    let mut final_messages = vec![assistant(
        json!([{"type":"text","text":"修改完成\n已测试"}]),
        true,
    )];
    state.overlay("ses_test", &mut final_messages);
    assert_eq!(
        final_messages[0].parts[0],
        AgentPart::Text {
            text: "修改完成\n已测试".into()
        }
    );
}

#[test]
fn stream_reconnect_does_not_join_fragments_over_a_gap_and_end_repairs_text() {
    let mut state = LiveState::default();
    state.track("ses_test");
    state.apply(&event("session.text.started", 0, json!({})));
    state.apply(&event("session.text.delta", 0, json!({"delta":"before"})));
    state.disconnected();
    state.apply(&json!({"type":"server.connected","data":{}}));
    state.apply(&event("session.text.delta", 0, json!({"delta":"after"})));
    let mut partial = vec![assistant(json!([]), false)];
    assert!(state.overlay("ses_test", &mut partial));
    assert_eq!(
        partial[0].parts[0],
        AgentPart::Text {
            text: "before".into()
        }
    );
    state.apply(&event(
        "session.text.ended",
        0,
        json!({"text":"before missing after"}),
    ));
    let mut repaired = vec![assistant(json!([]), false)];
    assert!(!state.overlay("ses_test", &mut repaired));
    assert_eq!(
        repaired[0].parts[0],
        AgentPart::Text {
            text: "before missing after".into()
        }
    );
}

#[test]
fn per_kind_ordinals_do_not_overwrite_reasoning_or_tools_and_terminal_tools_win() {
    let mut state = LiveState::default();
    state.track("ses_test");
    state.apply(&event("session.reasoning.started", 0, json!({})));
    state.apply(&event(
        "session.reasoning.delta",
        0,
        json!({"delta":"think"}),
    ));
    state.apply(&event("session.text.started", 0, json!({})));
    state.apply(&event("session.text.delta", 0, json!({"delta":"answer"})));
    state.apply(&event(
        "session.tool.input.started",
        0,
        json!({"id":"call1","name":"edit"}),
    ));
    state.apply(&event(
        "session.tool.called",
        0,
        json!({"id":"call1","input":{"path":"main.rs"}}),
    ));
    let mut raw = vec![assistant(
        json!([
            {"type":"reasoning","text":""}, {"type":"text","text":""},
            {"type":"tool","id":"call1","name":"edit","state":{"status":"completed","input":{"path":"main.rs"},"content":[{"type":"text","text":"saved"}]}}
        ]),
        false,
    )];
    state.overlay("ses_test", &mut raw);
    assert_eq!(
        raw[0].parts[0],
        AgentPart::Reasoning {
            text: "think".into()
        }
    );
    assert_eq!(
        raw[0].parts[1],
        AgentPart::Text {
            text: "answer".into()
        }
    );
    assert!(
        matches!(&raw[0].parts[2], AgentPart::Tool { state, output, .. } if state == "completed" && output.as_deref() == Some("saved"))
    );
}

#[test]
fn sse_handles_utf8_chunk_boundaries_comments_and_mixed_line_endings() {
    let mut decoder = SseDecoder::default();
    let encoded = "data: {\"type\":\"session.text.delta\",\"data\":{\"delta\":\"中文\"}}\r\n\r\n: heartbeat\n\ndata: {\"type\":\"server.connected\",\"data\":{}}\n\n".as_bytes();
    let mut events = Vec::new();
    for byte in encoded {
        events.extend(decoder.push(&[*byte]).unwrap());
    }
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["data"]["delta"], "中文");
    assert_eq!(events[1]["type"], "server.connected");
    let mut decoder = SseDecoder::default();
    assert_eq!(decoder.push(encoded).unwrap().len(), 2);
}

#[test]
fn untracked_sessions_and_duplicate_events_cannot_pollute_the_current_chat() {
    let mut state = LiveState::default();
    let started = event("session.text.started", 0, json!({}));
    state.apply(&started);
    let mut messages = Vec::new();
    state.overlay("ses_test", &mut messages);
    assert!(messages.is_empty());
    state.track("ses_test");
    state.apply(&started);
    let delta = event("session.text.delta", 0, json!({"delta":"once"}));
    state.apply(&delta);
    state.apply(&delta);
    state.overlay("ses_test", &mut messages);
    assert_eq!(
        messages[0].parts[0],
        AgentPart::Text {
            text: "once".into()
        }
    );
}

#[test]
fn prompt_ids_and_listener_validation_prevent_path_or_external_address_injection() {
    assert_eq!(test_access::request_id("uuid-1").unwrap(), "msg_uuid-1");
    assert_eq!(test_access::request_id("msg_uuid-1").unwrap(), "msg_uuid-1");
    for id in ["", "../escape", "a?x=1", "a/b"] {
        assert!(test_access::request_id(id).is_err());
    }
    assert_eq!(
        test_access::validate_url("http://127.0.0.1:1234/").unwrap(),
        "http://127.0.0.1:1234"
    );
    for url in [
        "http://example.com:1234",
        "http://localhost:1234",
        "http://127.0.0.1:0",
        "http://user:pass@127.0.0.1:1234",
        "http://127.0.0.1:1234/other",
        "http://127.0.0.1:1234?key=x",
    ] {
        assert!(test_access::validate_url(url).is_err());
    }
}

#[test]
fn lifecycle_completion_uses_message_order_not_clock_resolution() {
    let messages = vec![
        json!({"id":"msg_old_idle","type":"idle","time":{"created":123}}),
        json!({"id":"msg_user","type":"user","time":{"created":123}}),
        json!({"id":"msg_new_idle","type":"idle","time":{"created":123},"outcome":"succeeded"}),
    ];
    assert!(!test_access::pending("msg_user", &messages));
    assert!(test_access::pending("msg_user", &messages[..2]));
    assert!(test_access::pending("msg_queued", &messages));
}

#[test]
fn three_hundred_background_steps_do_not_fill_live_cache_or_fake_a_disconnect() {
    let mut state = LiveState::default();
    state.track("ses_test");
    state.apply(&json!({"type":"server.connected","data":{}}));
    for index in 0..300 {
        for (kind, extra) in [
            ("session.step.started", json!({})),
            ("session.text.started", json!({})),
            ("session.text.delta", json!({"delta":"finished"})),
            ("session.text.ended", json!({"text":"finished"})),
            ("session.step.ended", json!({})),
        ] {
            let mut value = event(kind, 0, extra);
            value["data"]["assistantMessageID"] = json!(format!("msg_step_{index}"));
            state.apply(&value);
        }
    }
    assert_eq!(state.cached_messages(), 0);
    assert!(state.connected);
    // A tool may settle after the provider's step-ended marker.
    state.apply(&event(
        "session.tool.input.started",
        0,
        json!({"id":"call1","name":"read"}),
    ));
    state.apply(&event(
        "session.tool.called",
        0,
        json!({"id":"call1","input":{"path":"main.rs"}}),
    ));
    state.apply(&event("session.step.ended", 0, json!({})));
    assert_eq!(state.cached_messages(), 1);
    state.apply(&event(
        "session.tool.success",
        0,
        json!({"id":"call1","content":[{"type":"text","text":"read complete"}]}),
    ));
    assert_eq!(state.cached_messages(), 0);
}

#[test]
fn failed_or_interrupted_step_keeps_arrived_text_until_database_contains_it() {
    let mut state = LiveState::default();
    state.track("ses_test");
    state.apply(&event("session.text.started", 0, json!({})));
    state.apply(&event(
        "session.text.delta",
        0,
        json!({"delta":"already delivered"}),
    ));
    state.apply(&event(
        "session.step.failed",
        0,
        json!({"error":{"message":"interrupted"}}),
    ));
    let mut failed = vec![assistant(json!([{"type":"text","text":""}]), true)];
    state.overlay("ses_test", &mut failed);
    assert_eq!(
        failed[0].parts[0],
        AgentPart::Text {
            text: "already delivered".into()
        }
    );
    assert_eq!(state.cached_messages(), 1);
    let mut persisted = vec![assistant(
        json!([{"type":"text","text":"already delivered"}]),
        true,
    )];
    state.overlay("ses_test", &mut persisted);
    assert_eq!(state.cached_messages(), 0);
}

#[test]
fn javascript_project_paths_use_ordinary_windows_drive_and_unc_forms() {
    assert_eq!(
        test_access::js_path(r"\\?\D:\project\repo"),
        r"D:\project\repo"
    );
    assert_eq!(
        test_access::js_path(r"\\?\UNC\server\share\repo"),
        r"\\server\share\repo"
    );
    assert_eq!(test_access::js_path("/workspace/repo"), "/workspace/repo");
    let command = test_access::environment(std::path::Path::new(r"\\?\D:\lolicode-private"));
    let environment: HashMap<_, _> = command
        .as_std()
        .get_envs()
        .filter_map(|(k, v)| {
            v.map(|v| {
                (
                    k.to_string_lossy().to_string(),
                    v.to_string_lossy().to_string(),
                )
            })
        })
        .collect();
    for name in [
        "OPENCODE_TEST_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_DB",
        "TEMP",
        "TMP",
        "TMPDIR",
    ] {
        assert!(!environment[name].starts_with(r"\\?\"));
        assert!(environment[name].starts_with(r"D:\lolicode-private"));
    }
}

#[test]
fn private_child_environment_does_not_inherit_provider_credentials_or_user_opencode_config() {
    let root = std::env::temp_dir().join("lolicode-agent-env-fixture");
    let command = test_access::environment(&root);
    let environment: HashMap<_, _> = command
        .as_std()
        .get_envs()
        .filter_map(|(k, v)| {
            v.map(|v| {
                (
                    k.to_string_lossy().to_string(),
                    v.to_string_lossy().to_string(),
                )
            })
        })
        .collect();
    assert_eq!(
        environment["OPENCODE_TEST_HOME"],
        root.join("home").to_string_lossy()
    );
    assert_eq!(environment["OPENCODE_DISABLE_PROJECT_CONFIG"], "1");
    assert_eq!(environment["OPENCODE_DISABLE_MODELS_FETCH"], "1");
    assert_eq!(
        environment["OPENCODE_DB"],
        root.join("data/lolicode-agent.db").to_string_lossy()
    );
    assert!(!environment.contains_key("ANTHROPIC_API_KEY"));
    assert!(!environment.contains_key("OPENAI_API_KEY"));
    assert!(!environment.contains_key("OPENCODE_CONFIG_CONTENT"));
}

#[tokio::test]
async fn private_config_can_be_replaced_without_touching_other_files() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("opencode.json");
    let unrelated = temporary.path().join("user-config.json");
    tokio::fs::write(&unrelated, "untouched").await.unwrap();
    test_access::config(
        &path,
        &json!({"model":"lolicode/a","settings":{"apiKey":"fake"}}),
    )
    .await
    .unwrap();
    test_access::config(&path, &json!({"model":"lolicode/b"}))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&tokio::fs::read(&path).await.unwrap()).unwrap()["model"],
        "lolicode/b"
    );
    assert_eq!(
        tokio::fs::read_to_string(&unrelated).await.unwrap(),
        "untouched"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn v2_form_constraints_and_model_refs_survive_normalization() {
    let session = mapping::session(&json!({"id":"ses_a","location":{"directory":"/project"},"agent":"plan","model":{"providerID":"lolicode","id":"channel/opaque/model"},"time":{"created":1,"updated":2}})).unwrap();
    assert_eq!(session.model.unwrap().model_id, "channel/opaque/model");
    let question = mapping::question(
        &json!({"id":"frm_1","sessionID":"ses_a","title":"Choose","fields":[{"key":"q0","type":"multiselect","options":[{"value":"a","label":"A"}],"custom":true,"minItems":1,"maxItems":2,"when":[{"key":"toggle","op":"eq","value":true}],"default":["a"]}]}),
    );
    let encoded = serde_json::to_value(question).unwrap();
    assert_eq!(encoded["fields"][0]["minItems"], 1);
    assert_eq!(encoded["fields"][0]["when"][0]["op"], "eq");
    assert_eq!(encoded["fields"][0]["default"], json!(["a"]));
    assert_eq!(encoded["fields"][0]["options"][0]["value"], "a");
}

#[derive(Default)]
struct FixtureState {
    project: String,
    requests: Vec<(String, Value)>,
    pending_permission: bool,
    pending_question: bool,
}

struct HttpFixture {
    endpoint: String,
    state: Arc<Mutex<FixtureState>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl HttpFixture {
    async fn start(project: String) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(FixtureState {
            project,
            ..Default::default()
        }));
        let shared = state.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let state = shared.clone();
                tokio::spawn(async move {
                    handle_http(stream, state).await;
                });
            }
        });
        Self {
            endpoint,
            state,
            task,
        }
    }
}

async fn handle_http(mut stream: TcpStream, state: Arc<Mutex<FixtureState>>) {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let count = stream.read(&mut chunk).await.unwrap();
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
            break end + 4;
        }
        assert!(bytes.len() < 65536);
    };
    let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
    assert!(headers.lines().any(|line| line
        .split_once(':')
        .is_some_and(|(name, value)| name.eq_ignore_ascii_case("authorization")
            && value.trim() == "Basic b3BlbmNvZGU6cHJpdmF0ZS1zZXJ2ZXItcGFzc3dvcmQ=")));
    assert!(!headers.contains("Bearer"));
    let length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while bytes.len() < header_end + length {
        let count = stream.read(&mut chunk).await.unwrap();
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let request = headers.lines().next().unwrap();
    let method = request.split_whitespace().next().unwrap();
    let path = request.split_whitespace().nth(1).unwrap().to_owned();
    let body: Value = if length > 0 {
        serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
    } else {
        Value::Null
    };
    let mut fixture = state.lock().await;
    fixture
        .requests
        .push((format!("{method} {path}"), body.clone()));
    let session = json!({"id":"ses_fixture","title":"fixture","agent":"build","model":{"providerID":"lolicode","id":"source/opaque/model"},"location":{"directory":fixture.project},"time":{"created":1000,"updated":1002}});
    let value = if method == "POST" && path == "/api/session" {
        json!({"data":session})
    } else if path.starts_with("/api/session?") {
        json!({"data":[session],"cursor":{}})
    } else if path == "/api/session/ses_fixture" {
        json!({"data":session})
    } else if path == "/api/session/active" {
        json!({"data":{}})
    } else if path.starts_with("/api/session/ses_fixture/message?") {
        json!({"data":[
            {"id":"msg_request-1","type":"user","text":"do work","time":{"created":1000}},
            {"id":"msg_assistant","type":"assistant","time":{"created":1000,"completed":1000},"content":[{"type":"text","text":"private-server-password was hidden"},{"type":"tool","id":"call1","name":"edit","state":{"status":"completed","input":{"path":"test.rs"},"content":[{"type":"text","text":"saved"}]}}]},
            {"id":"msg_idle","type":"idle","outcome":"succeeded","time":{"created":1000}}
        ],"cursor":{}})
    } else if path == "/api/session/ses_fixture/permission" {
        if fixture.pending_permission {
            json!({"data":[{"id":"per_fixture","sessionID":"ses_fixture","action":"shell","resources":["cargo test"],"source":{"type":"tool","id":"call1"}}]})
        } else {
            json!({"data":[]})
        }
    } else if path == "/api/session/ses_fixture/form" {
        if fixture.pending_question {
            json!({"data":[{"id":"frm_fixture","sessionID":"ses_fixture","title":"Choose","fields":[{"key":"q0","type":"string","custom":true,"options":[{"value":"a","label":"A"}]}]}]})
        } else {
            json!({"data":[]})
        }
    } else if path == "/api/session/ses_fixture/diff" {
        json!({"data":[{"file":"test.rs","patch":"+saved","additions":1,"deletions":0,"status":"modified"}]})
    } else if path == "/api/session/ses_fixture/prompt" {
        json!({"data":{"id":body["id"],"time":{"created":1000}}})
    } else if path.ends_with("/reply")
        || path.contains("/interrupt")
        || (method == "DELETE" && path.contains("/form/"))
    {
        Value::Null
    } else {
        panic!("unexpected fixture request {method} {path}")
    };
    drop(fixture);
    let data = if value.is_null() {
        Vec::new()
    } else {
        serde_json::to_vec(&value).unwrap()
    };
    let status = if value.is_null() {
        "204 No Content"
    } else {
        "200 OK"
    };
    let headers = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",data.len());
    stream.write_all(headers.as_bytes()).await.unwrap();
    stream.write_all(&data).await.unwrap();
}

#[tokio::test]
async fn http_adapter_uses_v2_routes_opaque_models_and_real_normalized_snapshot() {
    let project = tempfile::tempdir().unwrap();
    let canonical = std::fs::canonicalize(project.path())
        .unwrap()
        .to_string_lossy()
        .to_string();
    let fixture = HttpFixture::start(canonical).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    let session = engine
        .create_session(
            project.path(),
            &AgentModelRef {
                provider_id: "lolicode".into(),
                model_id: "source/opaque/model".into(),
            },
            "build",
            Some("test"),
        )
        .await
        .unwrap();
    assert_eq!(
        session.model.as_ref().unwrap().model_id,
        "source/opaque/model"
    );
    engine
        .send_message(&session.id, "do work", "request-1")
        .await
        .unwrap();
    let snapshot = engine.snapshot(&session.id).await.unwrap();
    assert_eq!(snapshot.status, AgentStatus::Idle);
    assert_eq!(snapshot.messages.len(), 2);
    assert_eq!(snapshot.diffs[0].path, "test.rs");
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("private-server-password"));
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains(&fixture.endpoint));
    assert!(!engine.has_active_sessions().await.unwrap());
    let requests = &fixture.state.lock().await.requests;
    assert!(requests.iter().any(|(path, body)| path.ends_with("/prompt")
        && body["id"] == "msg_request-1"
        && body["text"] == "do work"));
    assert!(requests
        .iter()
        .any(|(path, body)| path == "POST /api/session"
            && body["model"]["id"] == "source/opaque/model"));
    engine.shutdown().await.unwrap();
    assert!(!engine.is_running());
}

#[tokio::test]
async fn lightweight_session_scope_check_does_not_wait_for_messages_or_diffs() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(
        std::fs::canonicalize(project.path())
            .unwrap()
            .to_string_lossy()
            .into(),
    )
    .await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    assert_eq!(
        engine.session("ses_fixture").await.unwrap().id,
        "ses_fixture"
    );
    let fixture = fixture.state.lock().await;
    assert_eq!(fixture.requests.len(), 1);
    assert_eq!(fixture.requests[0].0, "GET /api/session/ses_fixture");
}

#[tokio::test]
async fn permissions_and_questions_block_workspace_switch_and_use_v2_replies() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(
        std::fs::canonicalize(project.path())
            .unwrap()
            .to_string_lossy()
            .into(),
    )
    .await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    fixture.state.lock().await.pending_permission = true;
    let snapshot = engine.snapshot("ses_fixture").await.unwrap();
    assert_eq!(snapshot.status, AgentStatus::WaitingPermission);
    assert_eq!(snapshot.permissions[0].tool_name.as_deref(), Some("edit"));
    assert!(engine.has_active_sessions().await.unwrap());
    engine
        .reply_permission("ses_fixture", "per_fixture", "once")
        .await
        .unwrap();
    fixture.state.lock().await.pending_permission = false;
    fixture.state.lock().await.pending_question = true;
    let snapshot = engine.snapshot("ses_fixture").await.unwrap();
    assert_eq!(snapshot.status, AgentStatus::WaitingQuestion);
    assert!(engine.has_active_sessions().await.unwrap());
    engine
        .reply_question("ses_fixture", "frm_fixture", &json!({"q0":"a"}))
        .await
        .unwrap();
    engine
        .reject_question("ses_fixture", "frm_fixture")
        .await
        .unwrap();
    engine.interrupt("ses_fixture").await.unwrap();
    let requests = &fixture.state.lock().await.requests;
    assert!(requests.iter().any(
        |(path, body)| path.ends_with("/permission/per_fixture/reply")
            && body["decision"] == "once"
    ));
    assert!(requests.iter().any(
        |(path, body)| path.ends_with("/form/frm_fixture/reply") && body["answer"]["q0"] == "a"
    ));
    assert!(requests
        .iter()
        .any(|(path, _)| path == "DELETE /api/session/ses_fixture/form/frm_fixture"));
    assert!(requests
        .iter()
        .any(|(path, _)| path == "POST /api/session/ses_fixture/interrupt?resume=false"));
}

#[tokio::test]
async fn plan_uses_session_denies_that_cannot_be_overridden_by_project_saved_allow() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(
        std::fs::canonicalize(project.path())
            .unwrap()
            .to_string_lossy()
            .into(),
    )
    .await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    let model = AgentModelRef {
        provider_id: "lolicode".into(),
        model_id: "source/opaque/model".into(),
    };
    engine
        .create_session(project.path(), &model, "plan", None)
        .await
        .unwrap();
    engine
        .create_session(project.path(), &model, "build", None)
        .await
        .unwrap();
    let fixture = fixture.state.lock().await;
    let plan = &fixture.requests[0].1;
    assert_eq!(plan["agent"], "plan");
    let rules = plan["permissions"].as_array().unwrap();
    for action in ["edit", "shell", "subagent", "task"] {
        assert!(rules.iter().any(|rule| rule["action"] == action
            && rule["resource"] == "*"
            && rule["effect"] == "deny"));
    }
    assert!(!rules
        .iter()
        .any(|rule| rule["action"] == "read" || rule["action"] == "question"));
    assert!(fixture.requests[1].1.get("permissions").is_none());
}
