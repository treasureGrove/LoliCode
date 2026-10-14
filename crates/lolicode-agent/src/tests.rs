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
    sync::{Mutex, Notify},
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
    requests: Vec<(String, Value)>,
    pending_permission: bool,
    pending_question: bool,
    session: Value,
    running: bool,
    queued: bool,
    fail_agent_once: bool,
    deleted: bool,
    permission_command: Option<String>,
    permission_workdir: Option<String>,
    fail_policy_after_write_once: bool,
    fail_restore_policy: bool,
    reject_next_policy: bool,
    include_child: bool,
    permission_failure: bool,
    misleading_metadata_404: bool,
    tool_output: Option<String>,
    plugin_inventory: Option<Value>,
    native_messages: Option<Value>,
    interrupt_result: Option<bool>,
    permission_reply_barrier: Option<(Arc<Notify>, Arc<Notify>)>,
    inbox_items: Option<Value>,
    native_active: Option<Value>,
    child_gate: Option<String>,
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
            session: json!({"id":"ses_fixture","title":"fixture","agent":"build","model":{"providerID":"lolicode","id":"source/opaque/model"},"location":{"directory":project},"time":{"created":1000,"updated":1002}}),
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
    let mut response_status = None;
    let value = if method == "GET"
        && fixture.deleted
        && (path.starts_with("/api/session/ses_fixture")
            || path.starts_with("/api/session/ses_child"))
    {
        response_status = Some("404 Not Found");
        json!({"_tag":"SessionNotFoundError","sessionID":if path.contains("ses_child") {"ses_child"}else{"ses_fixture"},"message":"Session not found"})
    } else if method == "GET"
        && path == "/api/session/ses_fixture/permission"
        && fixture.permission_failure
    {
        response_status = Some("503 Service Unavailable");
        json!({"_tag":"ServiceUnavailableError","message":"permission service unavailable"})
    } else if method == "GET"
        && path == "/api/session/ses_fixture"
        && fixture.misleading_metadata_404
    {
        response_status = Some("404 Not Found");
        json!({"_tag":"DifferentResourceNotFound","message":"wrong route not found"})
    } else if method == "POST" && path == "/api/session" {
        for key in ["title", "agent", "model", "permissions", "location"] {
            if let Some(value) = body.get(key) {
                fixture.session[key] = value.clone();
            }
        }
        fixture.deleted = false;
        json!({"data":fixture.session})
    } else if path.starts_with("/api/session?") {
        let mut sessions = if fixture.deleted {
            vec![]
        } else {
            vec![fixture.session.clone()]
        };
        if fixture.include_child && !fixture.deleted {
            let mut child = fixture.session.clone();
            child["id"] = json!("ses_child");
            child["parentID"] = json!("ses_fixture");
            sessions.push(child);
        }
        if let Some(parent) = url::Url::parse(&format!("http://fixture{path}"))
            .unwrap()
            .query_pairs()
            .find(|(name, _)| name == "parentID")
            .map(|(_, value)| value.into_owned())
        {
            sessions.retain(|session| session["parentID"].as_str() == Some(parent.as_str()));
        }
        json!({"data":sessions,"cursor":{}})
    } else if path == "/api/session/ses_child/permission"
        || path == "/api/session/ses_child/form"
        || path == "/api/session/ses_child/inbox"
    {
        let value = match (path.as_str(), fixture.child_gate.as_deref()) {
            ("/api/session/ses_child/inbox", Some("inbox")) => {
                json!([{"id":"msg_child_queued","type":"user"}])
            }
            ("/api/session/ses_child/permission", Some("permission")) => {
                json!([{"id":"per_child","sessionID":"ses_child","action":"shell","resources":[]}])
            }
            ("/api/session/ses_child/form", Some("question")) => {
                json!([{"id":"frm_child","sessionID":"ses_child","fields":[]}])
            }
            _ => json!([]),
        };
        json!({"data":value})
    } else if method == "PATCH" && path == "/api/session/ses_fixture" {
        if fixture.reject_next_policy && body.get("permissions").is_some() {
            fixture.reject_next_policy = false;
            response_status = Some("400 Bad Request");
            json!({"message":"fixture restore failed"})
        } else {
            for key in ["title", "permissions"] {
                if let Some(value) = body.get(key) {
                    fixture.session[key] = value.clone();
                }
            }
            if fixture.fail_policy_after_write_once && body.get("permissions").is_some() {
                fixture.fail_policy_after_write_once = false;
                response_status = Some("400 Bad Request");
                json!({"message":"fixture response failed after write"})
            } else {
                Value::Null
            }
        }
    } else if method == "DELETE" && path == "/api/session/ses_fixture" {
        fixture.deleted = true;
        Value::Null
    } else if method == "POST" && path == "/api/session/ses_fixture/model" {
        fixture.session["model"] = body["model"].clone();
        Value::Null
    } else if method == "POST" && path == "/api/session/ses_fixture/agent" {
        if fixture.fail_agent_once {
            fixture.fail_agent_once = false;
            fixture.reject_next_policy = fixture.fail_restore_policy;
            response_status = Some("400 Bad Request");
            json!({"message":"fixture agent failed"})
        } else {
            fixture.session["agent"] = body["agent"].clone();
            Value::Null
        }
    } else if path == "/api/session/ses_fixture" {
        if fixture.deleted {
            response_status = Some("404 Not Found");
            json!({"message":"session removed"})
        } else {
            json!({"data":fixture.session})
        }
    } else if path == "/api/session/active" {
        let mut active = json!({});
        if fixture.running {
            active["ses_fixture"] = json!({"type":"running"});
        }
        if fixture.child_gate.as_deref() == Some("actor") {
            active["ses_child"] = json!({"type":"running"});
        }
        json!({"data":fixture.native_active.clone().unwrap_or(active)})
    } else if path == "/api/session/ses_fixture/inbox" {
        json!({"data":fixture.inbox_items.clone().unwrap_or_else(||if fixture.queued {json!([{"id":"msg_queued"}])} else {json!([])})})
    } else if path.starts_with("/api/session/ses_fixture/message?") {
        json!({"data":fixture.native_messages.clone().unwrap_or_else(||json!([
            {"id":"msg_request-1","type":"user","text":"do work","time":{"created":1000}},
            {"id":"msg_assistant","type":"assistant","time":{"created":1000,"completed":1000},"content":[{"type":"text","text":"private-server-password was hidden"},{"type":"tool","id":"call1","name":"edit","state":{"status":"completed","input":{"path":"test.rs"},"content":[{"type":"text","text":fixture.tool_output.as_deref().unwrap_or("saved")}]}}]},
            {"id":"msg_idle","type":"idle","outcome":"succeeded","time":{"created":1000}}
        ])),"cursor":{}})
    } else if path == "/api/session/ses_fixture/message/msg_shell" {
        json!({"data":{"id":"msg_shell","type":"assistant","content":[{"type":"tool","id":"call1","name":"shell","state":{"status":"running","input":{"command":fixture.permission_command,"workdir":fixture.permission_workdir}}}]}})
    } else if path == "/api/session/ses_fixture/permission" {
        if fixture.pending_permission {
            let source = if fixture.permission_command.is_some() {
                json!({"type":"tool","id":"call1","messageID":"msg_shell"})
            } else {
                json!({"type":"tool","id":"call1"})
            };
            json!({"data":[{"id":"per_fixture","sessionID":"ses_fixture","action":"shell","resources":["node --version"],"source":source}]})
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
    } else if path.starts_with("/api/skill?") {
        json!({"data":[{"id":"owned-skill","name":"Useful skill","description":"Description","path":"private/skills/secret-path","content":"must never leave the runtime","autoinvoke":false}]})
    } else if path.starts_with("/api/plugin?") {
        json!({"data":fixture.plugin_inventory.clone().unwrap_or_else(||json!([{"id":"owned-plugin","source":{"type":"package","target":"https://user:unlisted-secret@example.test/plugin?token=unlisted-token","version":"1.0"},"features":{"server":true,"rpc":true},"state":{"status":"failed","error":"unlisted-secret"}}]))})
    } else if path.starts_with("/api/mcp?") {
        json!({"data":[{"name":"owned-mcp","status":{"status":"needs_auth","error":"unlisted-secret"},"integrationID":"not-published"}]})
    } else if path == "/api/experimental/session/ses_fixture/skill" {
        Value::Null
    } else if path.contains("/interrupt") {
        json!({"interrupted":fixture.interrupt_result.unwrap_or(true)})
    } else if path.ends_with("/reply") || (method == "DELETE" && path.contains("/form/")) {
        if path.contains("/permission/") && body["decision"] == "once" {
            fixture.pending_permission = false;
        }
        Value::Null
    } else {
        panic!("unexpected fixture request {method} {path}")
    };
    let reply_barrier = fixture.permission_reply_barrier.clone().filter(|_| {
        path.ends_with("/reply") && path.contains("/permission/") && body["decision"] == "once"
    });
    drop(fixture);
    if let Some((started, release)) = reply_barrier {
        started.notify_one();
        release.notified().await;
    }
    let data = if value.is_null() {
        Vec::new()
    } else {
        serde_json::to_vec(&value).unwrap()
    };
    let status = if let Some(status) = response_status {
        status
    } else if value.is_null() {
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
    assert!(rules
        .iter()
        .any(|rule| rule["action"] == "read" && rule["effect"] == "allow"));
    assert_eq!(fixture.requests[1].1["agent"], "build");
    assert_eq!(fixture.requests[1].1["permissions"][0]["effect"], "ask");
}

#[tokio::test]
async fn real_model_and_mode_changes_persist_and_plan_to_build_restores_permissions() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    let model = AgentModelRef {
        provider_id: "lolicode".into(),
        model_id: "channel/new/opaque:free".into(),
    };
    let switched = engine.switch_model("ses_fixture", &model).await.unwrap();
    assert_eq!(switched.model, Some(model));
    let plan = engine
        .configure_session("ses_fixture", "plan", "full_access")
        .await
        .unwrap();
    assert_eq!(plan.mode, "plan");
    assert_eq!(plan.permission_mode, "full_access");
    assert!(!plan.pinned && !plan.archived);
    let plan_rules = fixture.state.lock().await.session["permissions"].clone();
    for action in ["edit", "shell", "subagent", "task", "mcp_unknown_write"] {
        assert_eq!(rule_effect(&plan_rules, action), "deny");
    }
    assert_eq!(rule_effect(&plan_rules, "read"), "allow");
    // A new handle simulates a reload: the mode comes from persisted permissions.
    let reloaded = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    assert_eq!(
        reloaded
            .session("ses_fixture")
            .await
            .unwrap()
            .permission_mode,
        "full_access"
    );
    let build = engine
        .configure_session("ses_fixture", "build", "auto")
        .await
        .unwrap();
    assert_eq!(build.mode, "build");
    assert_eq!(build.permission_mode, "auto");
    let fixture = fixture.state.lock().await;
    assert_eq!(
        rule_effect(&fixture.session["permissions"], "edit"),
        "allow"
    );
    for action in ["shell", "subagent", "task", "mcp_unknown_write"] {
        assert_eq!(rule_effect(&fixture.session["permissions"], action), "ask");
    }
    assert!(fixture.requests.iter().any(|(route, body)| route
        == "POST /api/session/ses_fixture/model"
        && body["model"]["id"] == "channel/new/opaque:free"));
}

// The source evaluator is ordered last-match; all resources in our canonical
// policy are '*'. This checks effective behavior, not only presence of a rule.
fn rule_effect<'a>(rules: &'a Value, action: &str) -> &'a str {
    rules
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|r| r["action"] == "*" || r["action"] == action)
        .unwrap()["effect"]
        .as_str()
        .unwrap()
}

#[tokio::test]
async fn busy_queued_permissions_and_questions_reject_mutations_without_writing() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    let model = AgentModelRef {
        provider_id: "lolicode".into(),
        model_id: "other".into(),
    };
    for pending in 0..4 {
        {
            let mut f = fixture.state.lock().await;
            f.running = pending == 0;
            f.queued = pending == 1;
            f.pending_permission = pending == 2;
            f.pending_question = pending == 3;
        }
        assert!(engine.switch_model("ses_fixture", &model).await.is_err());
        assert!(engine
            .configure_session("ses_fixture", "build", "full_access")
            .await
            .is_err());
        assert!(engine.delete_session("ses_fixture").await.is_err());
        assert!(engine
            .activate_skill("ses_fixture", "owned-skill")
            .await
            .is_err());
    }
    assert!(fixture
        .state
        .lock()
        .await
        .requests
        .iter()
        .all(|(route, _)| route.starts_with("GET ")));
}

#[tokio::test]
async fn failed_agent_switch_restores_old_policy_and_no_fake_archive_route_is_used() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    engine
        .configure_session("ses_fixture", "plan", "ask")
        .await
        .unwrap();
    let old = fixture.state.lock().await.session.clone();
    fixture.state.lock().await.fail_agent_once = true;
    assert!(engine
        .configure_session("ses_fixture", "build", "full_access")
        .await
        .is_err());
    assert_eq!(fixture.state.lock().await.session, old);
    assert_eq!(
        engine
            .rename_session("ses_fixture", " Renamed ")
            .await
            .unwrap()
            .title,
        "Renamed"
    );
    engine.delete_session("ses_fixture").await.unwrap();
    assert!(engine
        .list_sessions(project.path())
        .await
        .unwrap()
        .is_empty());
    assert!(engine.session("ses_fixture").await.is_err());
    let f = fixture.state.lock().await;
    assert!(f
        .requests
        .iter()
        .any(|(route, _)| route == "DELETE /api/session/ses_fixture"));
    assert!(!f
        .requests
        .iter()
        .any(|(route, body)| route.contains("archive") || body.get("time").is_some()));
}

#[tokio::test]
async fn extension_catalog_uses_v2_namespaces_and_hides_content_credentials_and_loader_errors() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    let skills = engine.list_skills(project.path()).await.unwrap();
    assert_eq!(skills[0].id, "owned-skill");
    let plugins = engine.list_plugins(project.path()).await.unwrap();
    assert_eq!(plugins[0].status, "failed");
    assert!(plugins[0].server && plugins[0].rpc);
    let mcp = engine.list_mcp(project.path()).await.unwrap();
    assert_eq!(mcp[0].status, "needs_auth");
    let encoded = serde_json::to_string(&(skills, plugins, mcp)).unwrap();
    for secret in [
        "unlisted-secret",
        "unlisted-token",
        "must never leave",
        "secret-path",
        "not-published",
    ] {
        assert!(!encoded.contains(secret), "{secret} leaked");
    }
    engine
        .activate_skill("ses_fixture", "owned-skill")
        .await
        .unwrap();
    let f = fixture.state.lock().await;
    assert!(f
        .requests
        .iter()
        .filter(|(r, _)| r.starts_with("GET /api/skill?")
            || r.starts_with("GET /api/plugin?")
            || r.starts_with("GET /api/mcp?"))
        .all(|(r, _)| r.contains("location%5Bdirectory%5D=")));
    assert!(f.requests.iter().any(|(r, b)| r
        == "POST /api/experimental/session/ses_fixture/skill"
        && b == &json!({"id":"owned-skill","resume":true})));
}

#[test]
fn arbitrary_mcp_header_and_environment_values_are_redacted_and_custom_policy_is_not_claimed() {
    let secrets = test_access::secrets(
        &json!({"mcp":{"servers":{"local":{"environment":{"MY_SECRET":"custom-env-secret"}},"remote":{"headers":{"X-Custom-Auth":"custom-header-secret"}}}}}),
    );
    assert!(secrets.contains(&"custom-env-secret".into()));
    assert!(secrets.contains(&"custom-header-secret".into()));
    let raw = json!({"id":"ses_a","location":{"directory":"/project"},"agent":"build","permissions":[{"action":"*","resource":"*","effect":"allow"}]});
    assert_eq!(mapping::session(&raw).unwrap().permission_mode, "custom");
    for mode in ["build", "plan"] {
        for policy in ["ask", "auto", "full_access"] {
            let mut raw = raw.clone();
            raw["agent"] = json!(mode);
            raw["permissions"] = crate::policy::rules(mode, policy).unwrap();
            assert_eq!(mapping::session(&raw).unwrap().permission_mode, policy);
        }
    }
}

#[tokio::test]
async fn pending_shell_reads_exact_input_not_a_safe_looking_parsed_resource() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    {
        let mut f = fixture.state.lock().await;
        f.pending_permission = true;
        f.permission_command = Some("node --version > changed.txt".into());
        f.permission_workdir = Some("outside/project".into());
    }
    let requests = engine.pending_permissions("ses_fixture").await.unwrap();
    assert_eq!(requests[0].resources, vec!["node --version"]);
    assert_eq!(
        requests[0].tool_input.as_ref().unwrap()["command"],
        "node --version > changed.txt"
    );
    assert_eq!(
        requests[0].tool_input.as_ref().unwrap()["workdir"],
        "outside/project"
    );
    let f = fixture.state.lock().await;
    assert_eq!(f.requests.len(), 2);
    assert!(f
        .requests
        .iter()
        .any(|(r, _)| r == "GET /api/session/ses_fixture/message/msg_shell"));
    assert!(!f
        .requests
        .iter()
        .any(|(r, _)| r.contains("diff") || r.contains("message?")));
    drop(f);
    {
        let mut f = fixture.state.lock().await;
        f.permission_command = None;
        f.requests.clear();
    }
    assert!(engine.pending_permissions("ses_fixture").await.unwrap()[0]
        .tool_input
        .is_none());
    assert_eq!(fixture.state.lock().await.requests.len(), 1);
}

#[tokio::test]
async fn failed_policy_ack_is_rolled_back_and_incomplete_rollback_blocks_execution_until_repaired()
{
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    engine
        .configure_session("ses_fixture", "plan", "ask")
        .await
        .unwrap();
    let old = fixture.state.lock().await.session.clone();
    fixture.state.lock().await.fail_policy_after_write_once = true;
    assert!(engine
        .configure_session("ses_fixture", "build", "full_access")
        .await
        .is_err());
    assert_eq!(fixture.state.lock().await.session, old);
    {
        let mut f = fixture.state.lock().await;
        f.fail_agent_once = true;
        f.fail_restore_policy = true;
    }
    assert!(engine
        .configure_session("ses_fixture", "build", "full_access")
        .await
        .is_err());
    assert!(engine
        .send_message("ses_fixture", "do work", "request-1")
        .await
        .is_err());
    assert!(engine
        .activate_skill("ses_fixture", "owned-skill")
        .await
        .is_err());
    assert!(!fixture
        .state
        .lock()
        .await
        .requests
        .iter()
        .any(|(r, _)| r.ends_with("/prompt") || r.ends_with("/skill")));
    // Restarting must not let an agent:'plan' with build/full permissions write.
    let reloaded = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    assert!(reloaded
        .send_message("ses_fixture", "do work", "request-1")
        .await
        .is_err());
    engine
        .configure_session("ses_fixture", "plan", "ask")
        .await
        .unwrap();
    engine
        .send_message("ses_fixture", "do work", "request-1")
        .await
        .unwrap();
}

#[tokio::test]
async fn native_delete_untracks_its_discovered_subtree_before_lifecycle_checks() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    fixture.state.lock().await.include_child = true;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    assert_eq!(engine.list_sessions(project.path()).await.unwrap().len(), 2);
    engine.delete_session("ses_fixture").await.unwrap();
    assert!(!engine.has_active_sessions().await.unwrap());
    let f = fixture.state.lock().await;
    assert!(f
        .requests
        .iter()
        .any(|(r, _)| r.contains("parentID=ses_fixture")));
    drop(f);
    fixture.state.lock().await.requests.clear();
    assert!(!engine.has_active_sessions().await.unwrap());
    let f = fixture.state.lock().await;
    assert_eq!(
        f.requests
            .iter()
            .map(|(r, _)| r.as_str())
            .collect::<Vec<_>>(),
        vec!["GET /api/session/active"]
    );
    drop(f);
    // Session reads and lifecycle checks don't reintroduce phantom tracked IDs.
    assert!(engine.snapshot("ses_fixture").await.is_err());
    assert!(!engine.has_active_sessions().await.unwrap());
    assert!(engine
        .list_sessions(project.path())
        .await
        .unwrap()
        .is_empty());
    engine.shutdown().await.unwrap();
    assert!(!engine.is_running());
}

#[tokio::test]
async fn lifecycle_checks_never_swallow_permission_failures_or_unrelated_not_found_errors() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    engine.list_sessions(project.path()).await.unwrap();
    fixture.state.lock().await.permission_failure = true;
    assert!(engine
        .has_active_sessions()
        .await
        .unwrap_err()
        .contains("permission service unavailable"));
    fixture.state.lock().await.misleading_metadata_404 = true;
    assert!(engine
        .has_active_sessions()
        .await
        .unwrap_err()
        .contains("permission service unavailable"));
    {
        let mut f = fixture.state.lock().await;
        f.permission_failure = false;
        f.misleading_metadata_404 = false;
        f.requests.clear();
    }
    assert!(!engine.has_active_sessions().await.unwrap());
    assert!(fixture
        .state
        .lock()
        .await
        .requests
        .iter()
        .any(|(r, _)| r == "GET /api/session/ses_fixture/permission"));
}

#[tokio::test]
async fn native_tool_output_hides_opaque_plugin_options_and_mcp_argv_without_masking_short_words() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let config = json!({"plugins":[{"package":"file:///owned/plugin.mjs","options":{"opaque":"private-option-123","nested":[{"value":"private-nested-456"}],"short":"ok"}}],"mcp":{"servers":{"fixture":{"type":"local","command":["node","server.mjs","private-argument-789","-x"]}}}});
    let engine = test_access::engine_with_config(
        fixture.endpoint.clone(),
        "private-server-password".into(),
        &config,
    );
    fixture.state.lock().await.tool_output =
        Some("private-option-123 private-nested-456 private-argument-789 token ok -x".into());
    let snapshot = engine.snapshot("ses_fixture").await.unwrap();
    let text = snapshot
        .messages
        .iter()
        .flat_map(|m| &m.parts)
        .find_map(|part| match part {
            AgentPart::Tool { output, .. } => output.as_ref(),
            _ => None,
        })
        .unwrap();
    for secret in [
        "private-option-123",
        "private-nested-456",
        "private-argument-789",
    ] {
        assert!(!text.contains(secret));
    }
    assert!(text.contains("token ok -x"));
    assert_eq!(text.matches("[已隐藏]").count(), 3);
    let secrets = test_access::secrets(&config);
    assert!(!secrets
        .iter()
        .any(|s| matches!(s.as_str(), "node" | "ok" | "-x")));
    // Existing credential-key rules continue to hide short explicit credentials.
    assert!(test_access::secrets(&json!({"apiKey":"abc"})).contains(&"abc".into()));
}

#[tokio::test]
async fn native_local_plugin_identity_uses_owned_relative_target_and_never_exposes_external_paths()
{
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    let items = [
        (
            "owned-windows",
            json!({"type":"local","path":"C:\\private-root\\extensions\\catalogs\\7-0123456789abcdef\\plugins\\local-plugin-123\\index.js"}),
        ),
        (
            "owned-posix",
            json!({"type":"local","path":"/owned/engine/extensions/catalogs/7-0123456789abcdef/plugins/local-plugin-456/source/server.js"}),
        ),
        (
            "external",
            json!({"type":"local","path":"D:\\user-selected\\external-plugin\\index.js","target":"file:///D:/user-selected/external-plugin"}),
        ),
        (
            "invalid-catalog",
            json!({"type":"local","path":"/external/extensions/catalogs/not-versioned/plugins/local-plugin-789/index.js"}),
        ),
        (
            "traversal",
            json!({"type":"local","path":"/owned/engine/extensions/catalogs/7-0123456789abcdef/plugins/local-plugin-123/../outside.js"}),
        ),
        (
            "npm",
            json!({"type":"package","target":"@example/native-v2@1.0.0"}),
        ),
    ];
    fixture.state.lock().await.plugin_inventory=Some(Value::Array(items.iter().map(|(id,source)|json!({"id":id,"source":source,"features":{"server":true},"state":{"status":"active"}})).collect()));
    let plugins = engine.list_plugins(project.path()).await.unwrap();
    assert_eq!(
        plugins[0].target.as_deref(),
        Some("plugins/local-plugin-123/index.js")
    );
    assert_eq!(
        plugins[1].target.as_deref(),
        Some("plugins/local-plugin-456/source/server.js")
    );
    for plugin in &plugins[2..5] {
        assert!(plugin.target.is_none());
    }
    assert_eq!(
        plugins[5].target.as_deref(),
        Some("@example/native-v2@1.0.0")
    );
    let public = serde_json::to_string(&plugins).unwrap();
    for private in [
        "private-root",
        "user-selected",
        "external-plugin",
        "/owned/engine",
        "/extensions/catalogs/",
        "outside.js",
    ] {
        assert!(!public.contains(private));
    }
}

#[tokio::test]
async fn lifecycle_diagnostic_reports_native_settlement_metadata_without_message_bodies() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    engine
        .send_message("ses_fixture", "do work", "request-1")
        .await
        .unwrap();
    let facts = engine.lifecycle_diagnostic("ses_fixture").await.unwrap();
    assert_eq!(facts["pendingRequestId"], "msg_request-1");
    assert_eq!(facts["pendingPresent"], true);
    assert_eq!(facts["idleAfterPending"], 1);
    assert_eq!(facts["inboxCount"], 0);
    assert_eq!(facts["messages"][1]["tools"][0]["status"], "completed");
    let encoded = serde_json::to_string(&facts).unwrap();
    for private in [
        "do work",
        "private-server-password",
        "test.rs",
        "saved",
        &fixture.endpoint,
    ] {
        assert!(!encoded.contains(private));
    }
    assert!(facts["messages"][1].get("content").is_none());
}

#[tokio::test]
async fn rejected_permission_settles_only_its_completed_aborted_turn_when_native_work_is_empty() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    let user =
        json!({"id":"msg_reject","type":"user","text":"unsafe task","time":{"created":1000}});
    let aborted = json!({"id":"msg_aborted","type":"assistant","time":{"created":1001,"completed":1002},"error":{"type":"aborted","message":"Permission declined"},"content":[{"type":"text","text":"partial prefix survives"},{"type":"tool","id":"call_reject","name":"shell","state":{"status":"error","error":{"type":"aborted","message":"Permission declined"}}}]});
    engine
        .send_message("ses_fixture", "unsafe task", "reject")
        .await
        .unwrap();
    let mut incomplete = aborted.clone();
    incomplete["time"]
        .as_object_mut()
        .unwrap()
        .remove("completed");
    let mut completed = aborted.clone();
    completed.as_object_mut().unwrap().remove("error");
    let another_user =
        json!({"id":"msg_other","type":"user","text":"next task","time":{"created":1003}});
    for messages in [
        json!([user.clone()]), // Native prompt ACK is not completion.
        json!([aborted.clone(), user.clone()]),
        json!([user.clone(), incomplete.clone()]),
        json!([user.clone(), completed]), // Tool-only abort is not a terminal.
        json!([user.clone(), another_user, aborted.clone()]),
        json!([user.clone(), aborted.clone(), incomplete]),
    ] {
        fixture.state.lock().await.native_messages = Some(messages);
        assert_eq!(
            engine.snapshot("ses_fixture").await.unwrap().status,
            AgentStatus::Running
        );
        assert!(engine.is_session_busy("ses_fixture").await.unwrap());
        assert!(engine.has_active_sessions().await.unwrap());
    }
    fixture.state.lock().await.native_messages = Some(json!([user.clone(), aborted.clone()]));
    for gate in ["actor", "inbox", "permission", "question"] {
        {
            let mut state = fixture.state.lock().await;
            state.running = gate == "actor";
            state.queued = gate == "inbox";
            state.pending_permission = gate == "permission";
            state.pending_question = gate == "question";
        }
        let expected = match gate {
            "permission" => AgentStatus::WaitingPermission,
            "question" => AgentStatus::WaitingQuestion,
            _ => AgentStatus::Running,
        };
        assert_eq!(
            engine.snapshot("ses_fixture").await.unwrap().status,
            expected
        );
        assert!(engine.is_session_busy("ses_fixture").await.unwrap());
        assert!(engine.has_active_sessions().await.unwrap());
    }
    {
        let mut state = fixture.state.lock().await;
        state.running = false;
        state.queued = false;
        state.pending_permission = false;
        state.pending_question = false;
    }
    // The lightweight busy checks and full snapshot must agree before snapshot
    // has had a chance to clear the local pending marker.
    assert!(!engine.is_session_busy("ses_fixture").await.unwrap());
    assert!(!engine.has_active_sessions().await.unwrap());
    let terminal = engine.snapshot("ses_fixture").await.unwrap();
    assert_eq!(terminal.status, AgentStatus::Error);
    assert_eq!(terminal.error.as_deref(), Some("Permission declined"));
    assert!(terminal
        .messages
        .iter()
        .flat_map(|m| &m.parts)
        .any(|part| matches!(part,AgentPart::Text{text} if text=="partial prefix survives")));
    let switched = engine
        .switch_model(
            "ses_fixture",
            &AgentModelRef {
                provider_id: "lolicode".into(),
                model_id: "next-model".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(switched.model.unwrap().model_id, "next-model");
    engine
        .send_message("ses_fixture", "new task", "next")
        .await
        .unwrap();
    fixture.state.lock().await.native_messages = Some(
        json!([user, aborted, {"id":"msg_next","type":"user","text":"new task","time":{"created":1004}}]),
    );
    let pending_next = engine.snapshot("ses_fixture").await.unwrap();
    assert_eq!(pending_next.status, AgentStatus::Running);
    assert!(pending_next.error.is_none());
    assert!(engine.has_active_sessions().await.unwrap());
    let restored = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    let restored_next = restored.snapshot("ses_fixture").await.unwrap();
    assert_ne!(restored_next.status, AgentStatus::Error); // Old aborted turns don't contaminate later input.
}

#[tokio::test]
async fn permission_decline_uses_scoped_user_stop_without_treating_interrupt_ack_as_finished() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    let user =
        json!({"id":"msg_reject","type":"user","text":"unsafe task","time":{"created":1000}});
    {
        let mut state = fixture.state.lock().await;
        state.pending_permission = true;
        state.running = true;
        state.native_messages = Some(json!([user.clone()]));
    }
    engine
        .send_message("ses_fixture", "unsafe task", "reject")
        .await
        .unwrap();
    assert!(engine
        .reply_permission("ses_fixture", "per_missing", "reject")
        .await
        .is_err());
    assert!(!fixture
        .state
        .lock()
        .await
        .requests
        .iter()
        .any(|(path, _)| path.contains("/interrupt")));
    engine
        .reply_permission("ses_fixture", "per_fixture", "reject")
        .await
        .unwrap();
    {
        let state = fixture.state.lock().await;
        assert!(state.requests.iter().any(|(path, body)| path
            == "POST /api/session/ses_fixture/interrupt?resume=false"
            && body.is_null()));
        assert!(!state
            .requests
            .iter()
            .any(|(path, _)| path.ends_with("/permission/per_fixture/reply")));
    }
    assert_eq!(
        engine.snapshot("ses_fixture").await.unwrap().status,
        AgentStatus::WaitingPermission
    );
    assert!(engine.has_active_sessions().await.unwrap());
    {
        let mut state = fixture.state.lock().await;
        state.pending_permission = false;
        state.running = false;
        state.native_messages = Some(json!([user,
            {"id":"msg_aborted","type":"assistant","time":{"created":1001,"completed":1002},"error":{"type":"aborted","message":"User stopped"},"content":[{"type":"text","text":"partial stopped text"}]},
            {"id":"msg_idle","type":"idle","outcome":"interrupted","time":{"created":1002}}
        ]));
    }
    let settled = engine.snapshot("ses_fixture").await.unwrap();
    assert_eq!(settled.status, AgentStatus::Idle);
    assert!(!engine.has_active_sessions().await.unwrap());
    assert!(settled
        .messages
        .iter()
        .flat_map(|m| &m.parts)
        .any(|p| matches!(p,AgentPart::Text{text} if text=="partial stopped text")));
    {
        let mut state = fixture.state.lock().await;
        state.pending_permission = true;
        state.interrupt_result = Some(false);
    }
    assert!(engine
        .reply_permission("ses_fixture", "per_fixture", "reject")
        .await
        .unwrap_err()
        .contains("未接受"));
}

#[tokio::test]
async fn concurrent_auto_grant_and_manual_decline_do_not_interrupt_a_later_task() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    {
        let mut state = fixture.state.lock().await;
        state.pending_permission = true;
        state.permission_reply_barrier = Some((started.clone(), release.clone()));
    }
    let grant_engine = engine.clone();
    let grant = tokio::spawn(async move {
        grant_engine
            .reply_permission("ses_fixture", "per_fixture", "once")
            .await
    });
    started.notified().await;
    let decline = engine.reply_permission("ses_fixture", "per_fixture", "reject");
    tokio::pin!(decline);
    // The native grant was applied but its ACK is deliberately held. A decline
    // must wait for that mutation, then revalidate the now-expired request.
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(30), &mut decline)
            .await
            .is_err()
    );
    assert!(!fixture
        .state
        .lock()
        .await
        .requests
        .iter()
        .any(|(path, _)| path == "GET /api/session/ses_fixture/permission"));
    release.notify_one();
    grant.await.unwrap().unwrap();
    assert!(decline.await.unwrap_err().contains("已结束"));
    assert!(!fixture
        .state
        .lock()
        .await
        .requests
        .iter()
        .any(|(path, _)| path.contains("/interrupt")));
}

#[tokio::test]
async fn pinned_plan_context_notes_are_idle_but_unknown_synthetic_and_queued_work_still_block() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    let note = |text: String| json!({"id":"msg_note","type":"synthetic","delivery":"steer","payload":{"text":text}});
    for entering in [true, false] {
        fixture.state.lock().await.inbox_items =
            Some(json!([note(test_access::plan_note(entering))]));
        assert_eq!(
            engine.snapshot("ses_fixture").await.unwrap().status,
            AgentStatus::Idle
        );
        assert!(!engine.is_session_busy("ses_fixture").await.unwrap());
        assert!(!engine.has_active_sessions().await.unwrap());
        engine
            .configure_session(
                "ses_fixture",
                if entering { "plan" } else { "build" },
                "ask",
            )
            .await
            .unwrap();
    }
    let mut queue_note = note(test_access::plan_note(false));
    queue_note["delivery"] = json!("queue");
    let mut custom_note = note(test_access::plan_note(false));
    custom_note["payload"]["metadata"] = json!({"custom":true});
    for queued in [
        note("Run a new background task".into()),
        note(format!(
            "{}\nDo additional work",
            test_access::plan_note(false)
        )),
        queue_note,
        custom_note,
        json!({"type":"user","id":"msg_next"}),
        json!({"type":"compaction","id":"msg_compact"}),
        json!({"type":"move","id":"msg_move"}),
        json!({"type":"future_unknown","id":"msg_unknown"}),
    ] {
        fixture.state.lock().await.inbox_items = Some(json!([queued]));
        assert_eq!(
            engine.snapshot("ses_fixture").await.unwrap().status,
            AgentStatus::Running
        );
        assert!(engine.is_session_busy("ses_fixture").await.unwrap());
        assert!(engine.has_active_sessions().await.unwrap());
    }
    fixture.state.lock().await.inbox_items = Some(json!([note(test_access::plan_note(false))]));
    fixture.state.lock().await.running = true;
    assert!(engine.is_session_busy("ses_fixture").await.unwrap());
    fixture.state.lock().await.running = false;
    engine
        .send_message("ses_fixture", "new task", "unsettled")
        .await
        .unwrap();
    assert_eq!(
        engine.snapshot("ses_fixture").await.unwrap().status,
        AgentStatus::Running
    );
    assert!(engine.has_active_sessions().await.unwrap()); // An inert note never settles a prompt ACK.
}

#[tokio::test]
async fn subtree_delete_allows_unrelated_work_and_protects_untracked_child_tasks() {
    let project = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::start(project.path().to_string_lossy().into()).await;
    {
        let mut state = fixture.state.lock().await;
        state.include_child = true;
        state.native_active = Some(json!({"ses_elsewhere":{"type":"running"}}));
    }
    let engine = test_access::engine(fixture.endpoint.clone(), "private-server-password".into());
    engine.delete_session("ses_fixture").await.unwrap();
    assert!(fixture.state.lock().await.deleted);
    assert!(engine.has_active_sessions().await.unwrap()); // The unrelated drain is still running.
    assert!(!fixture
        .state
        .lock()
        .await
        .requests
        .iter()
        .any(|(path, _)| path.contains("ses_elsewhere/")));

    let protected = HttpFixture::start(project.path().to_string_lossy().into()).await;
    protected.state.lock().await.include_child = true;
    let engine = test_access::engine(protected.endpoint.clone(), "private-server-password".into());
    // Don't list/track the child first: its native parentID relationship is the
    // authority, including a child that moved to a different directory.
    for gate in ["actor", "inbox", "permission", "question"] {
        protected.state.lock().await.child_gate = Some(gate.into());
        assert!(engine
            .delete_session("ses_fixture")
            .await
            .unwrap_err()
            .contains("子会话"));
        assert!(!protected.state.lock().await.deleted);
    }
    protected.state.lock().await.child_gate = None;
    engine.delete_session("ses_fixture").await.unwrap();
    assert!(!engine.has_active_sessions().await.unwrap());
}
