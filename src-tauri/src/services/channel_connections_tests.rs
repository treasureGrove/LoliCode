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
