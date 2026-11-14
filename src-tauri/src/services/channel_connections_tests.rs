use super::*;
use crate::{database::Database, proxy::types::ProxyConfig};
use serial_test::serial;
use std::{ffi::OsString, fs, sync::Arc};

struct Home {
    _dir: tempfile::TempDir,
    previous: Option<OsString>,
}
impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("CC_SWITCH_TEST_HOME");
        std::env::set_var("CC_SWITCH_TEST_HOME", dir.path());
        crate::settings::reload_settings().unwrap();
        Self {
            _dir: dir,
            previous,
        }
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        let _ = crate::settings::reload_settings();
    }
}
fn write(path: &std::path::Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
async fn state() -> AppState {
    let db = Arc::new(Database::memory().unwrap());
    db.update_proxy_config(ProxyConfig {
        listen_port: 0,
        ..Default::default()
    })
    .await
    .unwrap();
    let state = AppState::new(db);
    channel_center::save(state.db.as_ref(), serde_json::from_value(json!({
        "revision":0,"targets":["deepseek-harness"],"defaultModel":"fixture/model",
        "channels":[{"id":"fixture","name":"Offline fixture","baseUrl":"http://127.0.0.1:1/v1",
            "apiKey":"synthetic-only","authKind":"api_key","protocol":"openai_chat","enabled":true,
            "models":[{"id":"model","contextLimit":128000,"supportsTools":true}]}]
    })).unwrap()).unwrap();
    state
}

#[tokio::test]
#[serial]
async fn claude_connections_restore_native_credentials_preserve_user_settings_and_never_capture_the_route(
) {
    let _home = Home::new();
    let state = state().await;
    let original = json!({"env":{"ANTHROPIC_BASE_URL":"https://native.example.test","ANTHROPIC_AUTH_TOKEN":"synthetic-native-key","ANTHROPIC_MODEL":"native-model"},
        "hooks":{"keep":true},"mcpServers":{"mine":{"command":"synthetic"}}});
    let path = crate::config::get_claude_settings_path();
    write(&path, original.to_string().as_bytes());
    assert_eq!(status(&state, "claude").unwrap().mode, "native");
    let route = set(&state, "claude", "lolicode", Some(1)).await.unwrap();
    assert_eq!(route.mode, "lolicode");
    assert!(route.configured && route.has_native_profile);
    let backup = state
        .db
        .get_provider_by_id(&native_id(&AppType::Claude), "claude")
        .unwrap()
        .unwrap();
    assert_eq!(backup.settings_config, original);
    assert!(
        !crate::codex_config::get_codex_config_path().exists(),
        "one target must not configure another"
    );
    assert!(!crate::config::get_home_dir().join(".dsh").exists());
    assert_eq!(
        channel_center::load(state.db.as_ref()).unwrap().targets,
        vec!["deepseek-harness"]
    );
    set(&state, "claude", "lolicode", Some(1)).await.unwrap();
    assert_eq!(
        state
            .db
            .get_provider_by_id(&native_id(&AppType::Claude), "claude")
            .unwrap()
            .unwrap()
            .settings_config,
        original
    );
    let mut during: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    during["hooks"]["addedWhileRouted"] = json!(true);
    write(&path, during.to_string().as_bytes());
    set(&state, "claude", "native", Some(0)).await.unwrap(); // restoring needs no catalog revision
    let mut restored = read_live(&AppType::Claude).unwrap();
    assert_eq!(
        restored["env"]["ANTHROPIC_AUTH_TOKEN"],
        "synthetic-native-key"
    );
    assert_eq!(restored["hooks"]["addedWhileRouted"], true);
    assert_eq!(restored["mcpServers"], original["mcpServers"]);
    restored["env"]["ANTHROPIC_AUTH_TOKEN"] = json!("new-synthetic-native-key");
    write(&path, restored.to_string().as_bytes());
    set(&state, "claude", "lolicode", Some(1)).await.unwrap();
    set(&state, "claude", "native", None).await.unwrap();
    assert_eq!(
        read_live(&AppType::Claude).unwrap()["env"]["ANTHROPIC_AUTH_TOKEN"],
        "new-synthetic-native-key"
    );
    state.proxy_service.stop().await.unwrap();
}

#[tokio::test]
#[serial]
async fn codex_connections_roundtrip_oauth_and_api_key_profiles_without_touching_mcp() {
    for oauth in [false, true] {
        let _home = Home::new();
        let state = state().await;
        let auth = if oauth {
            json!({"tokens":{"access_token":"synthetic-native-access","refresh_token":"synthetic-native-refresh","account_id":"fixture"}})
        } else {
            json!({"OPENAI_API_KEY":"synthetic-native-key"})
        };
        let config = if oauth {
            "model = \"native-model\"\n[mcp_servers.mine]\ncommand = \"synthetic\"\n"
        } else {
            "model_provider = \"native\"\nmodel = \"native-model\"\n[model_providers.native]\nname = \"Native\"\nbase_url = \"https://native.example.test/v1\"\nwire_api = \"responses\"\n[mcp_servers.mine]\ncommand = \"synthetic\"\n"
        };
        write(
            &crate::codex_config::get_codex_config_path(),
            config.as_bytes(),
        );
        write(
            &crate::codex_config::get_codex_auth_path(),
            auth.to_string().as_bytes(),
        );
        let result = set(&state, "codex", "lolicode", Some(1)).await.unwrap();
        assert_eq!(result.mode, "lolicode");
        assert!(result.has_native_profile);
        assert!(!crate::config::get_claude_settings_path().exists());
        let live = read_live(&AppType::Codex).unwrap();
        assert!(live["config"]
            .as_str()
            .unwrap()
            .contains("[mcp_servers.mine]"));
        assert_ne!(live["auth"], auth);
        // A broken/unavailable model catalog must not prevent restoring native access.
        state
            .db
            .set_setting("channel_center", "invalid synthetic catalog")
            .unwrap();
        let native = set(&state, "codex", "native", None).await.unwrap();
        assert_eq!(native.mode, "native");
        let restored = read_live(&AppType::Codex).unwrap();
        if oauth {
            assert_eq!(restored["auth"], auth);
        } else {
            // The existing Codex writer can move an API key from auth.json into
            // its route table. Verify the effective credential, not its storage.
            assert_eq!(
                crate::codex_config::extract_codex_api_key(
                    restored.get("auth"),
                    restored["config"].as_str()
                ),
                Some("synthetic-native-key".into())
            );
            assert_eq!(
                live_base(&AppType::Codex, &restored).as_deref(),
                Some("https://native.example.test/v1")
            );
        }
        assert!(restored["config"]
            .as_str()
            .unwrap()
            .contains("[mcp_servers.mine]"));
        assert_eq!(status(&state, "codex").unwrap().mode, "native");
        state.proxy_service.stop().await.unwrap();
    }
}

#[tokio::test]
#[serial]
async fn connections_fail_closed_on_invalid_files_stale_revisions_or_unsupported_targets() {
    let _home = Home::new();
    let state = state().await;
    let path = crate::config::get_claude_settings_path();
    write(&path, b"{ invalid synthetic document");
    let before = fs::read(&path).unwrap();
    assert_eq!(status(&state, "claude").unwrap().mode, "unknown");
    assert!(set(&state, "claude", "lolicode", Some(1)).await.is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(state
        .db
        .get_provider_by_id(&native_id(&AppType::Claude), "claude")
        .unwrap()
        .is_none());
    assert!(set(&state, "claude", "lolicode", Some(0)).await.is_err());
    assert!(set(&state, "zcode", "native", None).await.is_err());
    let unrelated = json!({"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1234/tai/my-api"}});
    assert!(!is_gateway(&AppType::Claude, &unrelated));
    state.proxy_service.stop().await.unwrap();
}

#[tokio::test]
#[serial]
async fn old_routed_installs_without_native_profiles_can_return_to_official_configuration() {
    let _home = Home::new();
    let state = state().await;
    let path = crate::config::get_claude_settings_path();
    write(&path,json!({"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1234/tai/catalogs/1","ANTHROPIC_AUTH_TOKEN":"synthetic-local-gateway"},"hooks":{"keep":true}}).to_string().as_bytes());
    assert_eq!(status(&state, "claude").unwrap().mode, "lolicode");
    let restored = set(&state, "claude", "native", None).await.unwrap();
    assert_eq!(restored.mode, "native");
    assert!(read_live(&AppType::Claude).unwrap()["env"]["ANTHROPIC_AUTH_TOKEN"].is_null());
    assert_eq!(read_live(&AppType::Claude).unwrap()["hooks"]["keep"], true);
}

#[tokio::test]
#[serial]
async fn explicit_route_choice_overrides_a_native_account_default_without_changing_saved_targets() {
    let _home = Home::new();
    let state = state().await;
    let mut snapshot = channel_center::load(state.db.as_ref()).unwrap();
    let native = channel_center::native_subscription_channel("claude").unwrap();
    snapshot.default_model = Some(format!("{}/native-default", native.id));
    snapshot.channels.push(native);
    channel_center::save(state.db.as_ref(), snapshot).unwrap();
    let route = set(&state, "claude", "lolicode", Some(2)).await.unwrap();
    assert_eq!(route.mode, "lolicode");
    assert_eq!(
        channel_center::load(state.db.as_ref()).unwrap().targets,
        vec!["deepseek-harness"]
    );
    assert!(!crate::codex_config::get_codex_config_path().exists());
    let safe = serde_json::to_value(list(&state).unwrap())
        .unwrap()
        .to_string();
    assert!(!safe.contains("synthetic-only"));
    assert!(!safe.contains("apiKey"));
    state.proxy_service.stop().await.unwrap();
}

#[tokio::test]
#[serial]
async fn reapplying_claude_route_removes_the_old_catalog_minimum_without_losing_native_output_preferences(
) {
    let _home = Home::new();
    let state = state().await;
    let path = crate::config::get_claude_settings_path();
    write(&path, json!({"env":{"ANTHROPIC_AUTH_TOKEN":"synthetic-native-key","CLAUDE_CODE_MAX_OUTPUT_TOKENS":"7000"},
        "effortLevel":"high","hooks":{"keep":true}}).to_string().as_bytes());
    set(&state, "claude", "lolicode", Some(1)).await.unwrap();
    assert_eq!(
        read_live(&AppType::Claude).unwrap()["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"],
        "7000"
    );
    let mut previous = state
        .db
        .get_provider_by_id(ROUTE_ID, "claude")
        .unwrap()
        .unwrap();
    previous.settings_config["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = json!("4096");
    state.db.save_provider("claude", &previous).unwrap();
    let mut live = read_live(&AppType::Claude).unwrap();
    live["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = json!("4096");
    write(&path, live.to_string().as_bytes());
    set(&state, "claude", "lolicode", Some(1)).await.unwrap();
    let live = read_live(&AppType::Claude).unwrap();
    assert!(live["env"].get("CLAUDE_CODE_MAX_OUTPUT_TOKENS").is_none());
    assert_eq!(live["effortLevel"], "high");
    assert_eq!(live["hooks"]["keep"], true);
    set(&state, "claude", "native", None).await.unwrap();
    let native = read_live(&AppType::Claude).unwrap();
    assert_eq!(native["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "7000");
    assert_eq!(
        native["env"]["ANTHROPIC_AUTH_TOKEN"],
        "synthetic-native-key"
    );
    state.proxy_service.stop().await.unwrap();
}

#[tokio::test]
#[serial]
async fn gateway_publishes_private_claude_catalogs_and_restores_the_listener_without_writing_tools()
{
    use crate::services::channel_gateway as gateway;
    let _home = Home::new();
    let state = state().await;
    assert!(!gateway::status(&state).await.unwrap().running);
    assert!(gateway::claude_config(&state).await.is_err());
    assert!(gateway::start(&state, Some(0)).await.is_err());
    assert!(!state.proxy_service.is_running().await);
    let started = gateway::start(&state, Some(1)).await.unwrap();
    assert!(started.running);
    assert_eq!(started.model_count, 1);
    let base = started.base_url.unwrap();
    assert!(base.ends_with("/tai/catalogs/1/clients/claude"));
    assert!(!crate::config::get_claude_settings_path().exists());
    assert!(!crate::codex_config::get_codex_config_path().exists());
    assert!(state
        .db
        .get_provider_by_id(ROUTE_ID, "claude")
        .unwrap()
        .is_none());
    let config = gateway::claude_config(&state).await.unwrap();
    let token = config["env"]["ANTHROPIC_AUTH_TOKEN"].as_str().unwrap();
    assert_ne!(token, "synthetic-only");
    let safe = serde_json::to_string(&gateway::check(&state).await.unwrap()).unwrap();
    assert!(!safe.contains(token));
    assert!(!safe.contains("synthetic-only"));
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        client
            .get(format!("{base}/v1/models"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let models: Value = client
        .get(format!("{base}/v1/models"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["has_more"], false);
    assert_eq!(models["data"][0]["type"], "model");
    assert_eq!(models["data"][0]["display_name"], "Offline fixture · model");
    assert_eq!(models["data"][0]["id"], config["env"]["ANTHROPIC_MODEL"]);
    assert_eq!(models["first_id"], models["data"][0]["id"]);
    assert!(!models.to_string().contains("synthetic-only"));
    let mut updated = channel_center::load(state.db.as_ref()).unwrap();
    updated.channels[0].models[0].id = "new-model".into();
    updated.default_model = Some("fixture/new-model".into());
    channel_center::save(state.db.as_ref(), updated).unwrap();
    assert_eq!(gateway::status(&state).await.unwrap().saved_revision, 2);
    assert_eq!(gateway::claude_config(&state).await.unwrap(), config);
    assert!(gateway::start(&state, Some(1)).await.is_err());
    assert_eq!(
        gateway::start(&state, Some(2)).await.unwrap().revision,
        Some(2)
    );
    // Already-generated client URLs keep their original immutable catalog.
    let previous: Value = client
        .get(format!("{base}/v1/models"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(previous, models);
    let new_base = gateway::status(&state).await.unwrap().base_url.unwrap();
    state.proxy_service.stop().await.unwrap();
    assert!(gateway::check(&state).await.is_err());
    channel_center::restore_gateway(&state).await.unwrap();
    assert_eq!(
        gateway::check(&state).await.unwrap().base_url.unwrap(),
        new_base
    );
    state.proxy_service.stop().await.unwrap();
}

#[tokio::test]
#[serial]
async fn gateway_claude_streams_openai_tool_calls_and_accepts_tool_results_with_private_auth() {
    use crate::services::channel_gateway as gateway;
    use axum::{extract::Json, http::HeaderMap, routing::post, Router};
    let _home = Home::new();
    let captured = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let requests = captured.clone();
    let upstream = Router::new().route("/v1/chat/completions", post(move |headers: HeaderMap, Json(body): Json<Value>| {
        let requests = requests.clone();
        async move {
            assert_eq!(headers["authorization"], "Bearer synthetic-only");
            assert!(!headers.contains_key("x-api-key"));
            assert_eq!(body["model"], "model");
            let continued = body["messages"].as_array().unwrap().iter().any(|message| message["role"] == "tool");
            requests.lock().await.push(body);
            let delta = if continued { json!({"content":"Read the file successfully."}) } else {
                json!({"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"hello.txt\"}"}}]})
            };
            let first = json!({"id":"chatcmpl-fixture","object":"chat.completion.chunk","model":"model","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
            let last = json!({"id":"chatcmpl-fixture","object":"chat.completion.chunk","model":"model","choices":[{"index":0,"delta":{},"finish_reason":if continued {"stop"} else {"tool_calls"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}});
            ([("content-type", "text/event-stream")], format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n"))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    let state = state().await;
    let mut snapshot = channel_center::load(state.db.as_ref()).unwrap();
    snapshot.channels[0].base_url = format!("http://{address}/v1");
    channel_center::save(state.db.as_ref(), snapshot).unwrap();
    gateway::start(&state, Some(2)).await.unwrap();
    let config = gateway::claude_config(&state).await.unwrap();
    let env = &config["env"];
    let mut request = json!({"model":env["ANTHROPIC_MODEL"],"max_tokens":1024,"stream":true,
        "messages":[{"role":"user","content":"Read hello.txt"}],
        "tools":[{"name":"read_file","description":"Read a file","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}]});
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for continued in [false, true] {
        let response = client
            .post(format!(
                "{}/v1/messages",
                env["ANTHROPIC_BASE_URL"].as_str().unwrap()
            ))
            .bearer_auth(env["ANTHROPIC_AUTH_TOKEN"].as_str().unwrap())
            .header("anthropic-version", "2023-06-01")
            .json(&request)
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success(), "{}", response.status());
        let stream = response.text().await.unwrap();
        assert!(stream.contains("event: message_start"), "{stream}");
        assert!(stream.contains("event: message_stop"), "{stream}");
        assert!(!stream.contains("synthetic-only"));
        if continued {
            assert!(stream.contains("Read the file successfully."), "{stream}");
        } else {
            assert!(
                stream.contains("tool_use") && stream.contains("read_file"),
                "{stream}"
            );
            request["messages"].as_array_mut().unwrap().extend([
                json!({"role":"assistant","content":[{"type":"tool_use","id":"call_read","name":"read_file","input":{"path":"hello.txt"}}]}),
                json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"call_read","content":"Hello from the fixture"}]})]);
        }
    }
    let requests = captured.lock().await;
    assert_eq!(requests.len(), 2);
    let tool = requests[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap();
    assert_eq!(tool["tool_call_id"], "call_read");
    assert_eq!(tool["content"], "Hello from the fixture");
    drop(requests);
    state.proxy_service.stop().await.unwrap();
    task.abort();
}

#[tokio::test]
#[serial]
async fn gateway_excludes_built_in_public_quota_and_native_logins_from_claude_models() {
    use crate::services::{channel_gateway as gateway, lolicode_relay};
    let _home = Home::new();
    let state = state().await;
    let mut snapshot = channel_center::load(state.db.as_ref()).unwrap();
    let mut public = snapshot.channels[0].clone();
    public.id = lolicode_relay::CHANNEL_ID.into();
    public.base_url = lolicode_relay::BASE_URL.into();
    public.auth_kind = "lolicode_account".into();
    public.account_id = Some("fixture-account".into());
    public.api_key.clear();
    snapshot.default_model = Some(format!("{}/model", public.id));
    snapshot.channels.push(public);
    snapshot
        .channels
        .push(channel_center::native_subscription_channel("claude").unwrap());
    snapshot.channels[0].models[0].context_limit = Some(1_000_000);
    channel_center::save(state.db.as_ref(), snapshot).unwrap();
    assert_eq!(
        gateway::start(&state, Some(2)).await.unwrap().model_count,
        1
    );
    let config = gateway::claude_config(&state).await.unwrap();
    let selected = config["env"]["ANTHROPIC_MODEL"].as_str().unwrap();
    assert!(selected.ends_with("[1M]"));
    let response: Value = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!(
            "{}/v1/models",
            config["env"]["ANTHROPIC_BASE_URL"].as_str().unwrap()
        ))
        .bearer_auth(config["env"]["ANTHROPIC_AUTH_TOKEN"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["data"].as_array().unwrap().len(), 1);
    assert_eq!(response["data"][0]["id"], selected);
    let mut snapshot = channel_center::load(state.db.as_ref()).unwrap();
    snapshot.channels[0].enabled = false;
    channel_center::save(state.db.as_ref(), snapshot).unwrap();
    assert!(gateway::start(&state, Some(3)).await.is_err());
    assert_eq!(gateway::status(&state).await.unwrap().revision, Some(2));
    state.proxy_service.stop().await.unwrap();
}
