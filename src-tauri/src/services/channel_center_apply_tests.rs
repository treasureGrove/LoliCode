use super::*;
use crate::proxy::types::ProxyConfig;
use serial_test::serial;
use std::{ffi::OsString, path::Path, sync::Arc};

struct IsolatedPaths {
    previous: Vec<(&'static str, Option<OsString>)>,
    _directory: tempfile::TempDir,
}

impl IsolatedPaths {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path();
        let previous = [
            ("CC_SWITCH_TEST_HOME", home.to_path_buf()),
            ("LOCALAPPDATA", home.join("AppData/Local")),
            ("XDG_CONFIG_HOME", home.join(".config")),
            ("HERMES_HOME", home.join(".hermes")),
            ("PI_CODING_AGENT_DIR", home.join(".pi/agent")),
            ("MINIMAX_DATA_DIR", home.join(".minimax")),
            ("MAVIS_DATA_DIR", home.join(".minimax")),
            ("MIMOCODE_HOME", home.join(".mimo")),
            ("DSH_HOME", home.join(".dsh")),
            ("ZCODE_DATA_BASE_DIR", home.join(".zcode")),
            (
                "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
                home.join(".zcode/personal.jsonc"),
            ),
        ]
        .into_iter()
        .map(|(key, value)| {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            (key, previous)
        })
        .collect();
        crate::settings::reload_settings().unwrap();
        Self {
            previous,
            _directory: directory,
        }
    }
}

impl Drop for IsolatedPaths {
    fn drop(&mut self) {
        for (key, value) in self.previous.drain(..) {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let _ = crate::settings::reload_settings();
    }
}

fn seed_json(path: &Path, value: Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

#[tokio::test]
#[serial]
async fn all_target_writers_apply_and_reapply_partial_metadata_without_losing_user_config() {
    let paths = IsolatedPaths::new();
    let home = paths._directory.path();
    seed_json(
        &crate::config::get_claude_settings_path(),
        json!({"hooks":{"userHook":true}}),
    );
    seed_json(
        &crate::opencode_config::get_opencode_config_path().unwrap(),
        json!({"theme":"user-theme"}),
    );
    seed_json(
        &home.join(".workbuddy/models.json"),
        json!({"models":[],"userFlag":true}),
    );
    // An explicitly selected Personal file must already exist; ZCode owns its
    // first-run migration. Seed the format that a completed migration produces.
    seed_json(
        &home.join(".zcode/personal.jsonc"),
        json!({
            "schemaVersion":1,"config":{
                "providerConfigRules":{"providerRules":[]},
                "modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}
            }
        }),
    );
    let db = Arc::new(Database::memory().unwrap());
    db.update_proxy_config(ProxyConfig {
        listen_port: 0,
        ..Default::default()
    })
    .await
    .unwrap();
    let state = AppState::new(db);
    save(state.db.as_ref(), serde_json::from_value(json!({
        "revision":0,"targets":TARGETS,"defaultModel":"api/unknown-limits",
        "channels":[
            {"id":"api","name":"Offline API","baseUrl":"http://127.0.0.1:1/v1","apiKey":"synthetic-only",
             "authKind":"api_key","protocol":"openai_chat","enabled":true,"models":[
                {"id":"unknown-limits","supportsTools":true},
                {"id":"output-only","outputLimit":8192},
                {"id":"context-only","contextLimit":128000},
                {"id":"image-model","contextLimit":200000,"outputLimit":4096,"inputModalities":["text","image"]}
             ]},
            {"id":"gemini","name":"Offline native Gemini","baseUrl":"http://127.0.0.1:1/v1beta","apiKey":"synthetic-gemini",
             "authKind":"api_key","protocol":"gemini_native","enabled":true,"models":[{"id":"gemini-test","supportsTools":true}]}
        ]
    })).unwrap()).unwrap();
    for pass in 1..=2 {
        let report = apply(&state, Some(1)).await.unwrap();
        let failures = report
            .results
            .iter()
            .filter(|result| result.status != "success")
            .map(|result| format!("{}: {}", result.app, result.message))
            .collect::<Vec<_>>();
        // Stop the listener before assertions so a failing test leaves no owned service running.
        if !failures.is_empty() {
            state.proxy_service.stop().await.unwrap();
        }
        assert!(
            failures.is_empty(),
            "apply pass {pass}: {}",
            failures.join("\n")
        );
        assert_eq!(report.results.len(), TARGETS.len());
    }
    assert_eq!(
        crate::config::read_json_file::<Value>(&crate::config::get_claude_settings_path()).unwrap()
            ["hooks"]["userHook"],
        true
    );
    assert_eq!(
        crate::config::read_json_file::<Value>(&home.join(".workbuddy/models.json")).unwrap()
            ["userFlag"],
        true
    );
    state.proxy_service.stop().await.unwrap();
}
