use super::*;
use tempfile::tempdir;

fn source() -> ChannelSource {
    serde_json::from_value(json!({"id":"gateway","name":"LoliCode","baseUrl":"http://127.0.0.1:19318/v1","apiKey":"synthetic-local-lease","authKind":"api_key","protocol":"openai_chat","enabled":true,
        "models":[{"id":"channel/model","name":"示例模型","contextLimit":128000,"outputLimit":8192,"supportsTools":true,"inputModalities":["text","image"],"reasoningEfforts":["medium","high"]}]})).unwrap()
}
fn write(path: &Path, source: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, source).unwrap();
}
fn parsed(path: &Path) -> Value {
    json5::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn assert_zcode_personal_reader(path: &Path) {
    // Optional acceptance against the pinned upstream decoder (provided as a
    // bundled Node script). Normal Rust tests need no Node/dependency install.
    if let Some(decoder) = std::env::var_os("LOLICODE_ZCODE_DECODER") {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("node")
            .arg(decoder)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&fs::read(path).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "upstream decoder rejected synthetic fixture: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("UPSTREAM_ZCODE_PERSONAL_OK"));
    }
}

#[test]
fn external_workbuddy_adds_models_without_erasing_user_entries_and_updates_only_its_owned_entries()
{
    for original in [
        r#"[{"id":"mine","name":"Keep","apiKey":"synthetic-user-key"}]"#,
        r#"{"models": [{"id":"mine","name":"Keep"}],"theme":"custom"}"#,
    ] {
        let directory = tempdir().unwrap();
        let path = directory.path().join(".workbuddy/models.json");
        write(&path, original);
        let outcome = apply_at("workbuddy", &source(), "channel/model", directory.path()).unwrap();
        assert_eq!(outcome.files.len(), 1);
        assert_eq!(fs::read_to_string(&outcome.backups[0]).unwrap(), original);
        let first = parsed(&path);
        assert!(first.to_string().contains("Keep"));
        assert!(first.to_string().contains("/v1/chat/completions"));
        assert!(first.to_string().contains("128000"));
        let mut changed = source();
        changed.api_key = "rotated-synthetic-lease".into();
        apply_at("workbuddy", &changed, "channel/model", directory.path()).unwrap();
        assert!(parsed(&path)
            .to_string()
            .contains("rotated-synthetic-lease"));
        assert!(parsed(&path).to_string().contains("Keep"));
        let repeat = apply_at("workbuddy", &changed, "channel/model", directory.path()).unwrap();
        assert!(
            repeat.backups.is_empty(),
            "unchanged apply should not accumulate backups"
        );
    }
    for unsupported in [
        r#"{"models":{"mine":{"id":"mine","name":"Keep"}},"theme":"custom"}"#,
        r#"{"mine":{"id":"mine","name":"Keep"}}"#,
    ] {
        let directory = tempdir().unwrap();
        let path = directory.path().join(".workbuddy/models.json");
        write(&path, unsupported);
        assert!(apply_at("workbuddy", &source(), "channel/model", directory.path()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), unsupported);
    }
}

#[test]
fn external_codebuddy_keeps_user_models_and_makes_managed_models_visible_with_capabilities() {
    let directory = tempdir().unwrap();
    let path = directory.path().join(".codebuddy/models.json");
    let old = r#"{"models":[{"id":"mine","name":"Keep","url":"https://example.invalid/v1/chat/completions"}],"availableModels":["mine"],"theme":{"name":"custom"}}"#;
    write(&path, old);
    let outcome = apply_at("codebuddy", &source(), "channel/model", directory.path()).unwrap();
    assert_eq!(fs::read_to_string(&outcome.backups[0]).unwrap(), old);
    let value = parsed(&path);
    assert_eq!(value["theme"]["name"], "custom");
    assert_eq!(value["models"][0]["name"], "Keep");
    let model = &value["models"][1];
    assert_eq!(model["url"], "http://127.0.0.1:19318/v1/chat/completions");
    assert_eq!(model["supportsToolCall"], true);
    assert_eq!(model["supportsImages"], true);
    assert_eq!(model["supportsReasoning"], true);
    assert_eq!(model["maxInputTokens"], 128000);
    assert_eq!(value["availableModels"], json!(["mine", "channel/model"]));
    assert!(
        apply_at("codebuddy", &source(), "channel/model", directory.path())
            .unwrap()
            .backups
            .is_empty()
    );
    let mut changed = source();
    changed.models[0].id = "channel/new".into();
    apply_at("codebuddy", &changed, "channel/new", directory.path()).unwrap();
    assert_eq!(
        parsed(&path)["availableModels"],
        json!(["mine", "channel/new"])
    );
    assert!(!directory.path().join(".workbuddy/models.json").exists());
}

#[test]
fn external_codebuddy_defaults_to_documented_object_schema_and_preserves_conflicts() {
    let directory = tempdir().unwrap();
    let path = directory.path().join(".codebuddy/models.json");
    apply_at("codebuddy", &source(), "channel/model", directory.path()).unwrap();
    assert!(parsed(&path).is_object());
    assert_eq!(parsed(&path)["models"][0]["id"], "channel/model");
    let mut value = parsed(&path);
    value["models"][0]["apiKey"] = json!("synthetic-user-edit");
    write(&path, &value.to_string());
    let before = fs::read(&path).unwrap();
    assert!(matches!(
        apply_at("codebuddy", &source(), "channel/model", directory.path()),
        Err(AppError::Conflict(_))
    ));
    assert_eq!(fs::read(&path).unwrap(), before);
    for invalid in [
        r#"[]"#,
        r#"{"availableModels":{}}"#,
        r#"{"models":[{"id":"channel/model","name":"User"}]}"#,
    ] {
        let isolated = tempdir().unwrap();
        let path = isolated.path().join(".codebuddy/models.json");
        write(&path, invalid);
        assert!(apply_at("codebuddy", &source(), "channel/model", isolated.path()).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), invalid);
    }
    assert!(apply_at("qoder", &source(), "channel/model", directory.path()).is_err());
    assert!(!directory.path().join(".qoder/settings.json").exists());
}

#[test]
fn external_zcode_preserves_plugins_and_config_comments_and_rolls_back_multifile_failure() {
    let directory = tempdir().unwrap();
    let desktop = directory.path().join(".zcode/v2/config.json");
    let cli = directory.path().join(".zcode/cli/config.json");
    let old_desktop = "{\n // keep plugin config\n \"plugins\": [\"mine\"], \"provider\":{\"mine\":{\"kind\":\"openai\"}}\n}";
    let old_cli = "{\"plugin\":[\"mine-cli\"],\"model\":{\"main\":\"mine/old\"}}";
    write(&desktop, old_desktop);
    write(&cli, old_cli);
    let locations = Locations::fixture(directory.path());
    assert!(apply_inner("zcode", &source(), "channel/model", &locations, Some(1)).is_err());
    assert_eq!(fs::read_to_string(&desktop).unwrap(), old_desktop);
    assert_eq!(fs::read_to_string(&cli).unwrap(), old_cli);
    assert!(!directory
        .path()
        .join(crate::channel::profile_directory())
        .join("external-model-config/zcode.json")
        .exists());
    apply_at("zcode", &source(), "channel/model", directory.path()).unwrap();
    assert!(fs::read_to_string(&desktop)
        .unwrap()
        .contains("// keep plugin config"));
    assert_eq!(parsed(&desktop)["plugins"], json!(["mine"]));
    assert_eq!(
        parsed(&desktop)["provider"]["lolicode"]["kind"],
        "openai-compatible"
    );
    assert!(parsed(&desktop)["provider"]["lolicode"]
        .get("npm")
        .is_none());
    assert_eq!(
        parsed(&cli)["model"],
        json!({"main":"lolicode/channel/model","lite":"lolicode/channel/model"})
    );
    assert_eq!(parsed(&cli)["plugin"], json!(["mine-cli"]));
}

fn modern_zcode() -> Value {
    json!({"schemaVersion":1,"config":{
        "providerOrder":["mine"],
        "providerConfigRules":{"providerRules":[{"providerId":"mine","providerName":"Keep","config":{
            "group":"standard-personal","access":{"type":"api-key","apiKey":"synthetic-user-key"},
            "api":{"type":"openai-chat-completions","baseUrl":"https://example.invalid/v1"},"personalModelIds":["old","manual"]}}]},
        "modelConfigRules":{"providerModelRules":[{"providerId":"mine","modelId":"old","config":{"properties":{"contextWindow":32000}}}],"manualProviderModelRules":[{
            "providerId":"mine","modelId":"manual","config":{
                "properties":{"contextWindow":32000,"supportsJsonSchemaOutput":false,"supportsNativeWebSearch":false,"supportsMidConversationSystem":true,
                    "inputFormat":{"supportsImage":false,"supportsVideo":false,"supportsPdf":false}},
                "optionSpecs":{"reasoningLevel":{"values":["default"],"map":"{}"},"maxOutputTokens":{"max":2048}}
            }}]},
        "defaultModelSelection":{"providerId":"mine","modelId":"old","options":{"reasoningLevel":"low"}}
    }})
}

#[test]
fn external_zcode_unknown_efforts_emit_no_reasoning_parameter_and_foreign_rules_never_get_claimed()
{
    let directory = tempdir().unwrap();
    let path = directory.path().join(".zcode/v2/provider_config.json");
    let original = modern_zcode();
    write(&path, &original.to_string());
    let mut unknown = source();
    unknown.models[0].reasoning_efforts = None;
    apply_at("zcode", &unknown, "channel/model", directory.path()).unwrap();
    let applied = parsed(&path);
    assert_eq!(
        applied["config"]["defaultModelSelection"]["options"]["reasoningLevel"],
        "default"
    );
    assert_eq!(
        applied["config"]["modelConfigRules"]["providerModelRules"][1]["config"]["optionSpecs"]
            ["reasoningLevel"],
        json!({"values":["default"],"map":"{}"})
    );
    let collision = tempdir().unwrap();
    let collision_path = collision.path().join(".zcode/v2/provider_config.json");
    let mut foreign = original;
    foreign["config"]["modelConfigRules"]["providerModelRules"]
        .as_array_mut()
        .unwrap()
        .push(json!({"providerId":"lolicode","modelId":"user-owned","config":{}}));
    let before = foreign.to_string();
    write(&collision_path, &before);
    apply_at("zcode", &source(), "channel/model", collision.path()).unwrap();
    let applied = parsed(&collision_path);
    assert!(applied["config"]["modelConfigRules"]["providerModelRules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|rule| rule == &json!({"providerId":"lolicode","modelId":"user-owned","config":{}})));
    assert_eq!(
        applied["config"]["defaultModelSelection"]["providerId"],
        "lolicode-managed"
    );
    assert_zcode_personal_reader(&collision_path);
}

#[test]
fn external_zcode_personal_updates_the_real_shared_file_without_touching_legacy_configs() {
    let directory = tempdir().unwrap();
    let path = directory.path().join(".zcode/v2/provider_config.json");
    let legacy = directory.path().join(".zcode/v2/config.json");
    let legacy_cli = directory.path().join(".zcode/cli/config.json");
    let original = modern_zcode();
    write(&path, &serde_json::to_string_pretty(&original).unwrap());
    write(&legacy, "{\"plugins\":[\"keep-desktop\"]}");
    write(&legacy_cli, "{\"plugins\":[\"keep-cli\"]}");
    let outcome = apply_at("zcode", &source(), "channel/model", directory.path()).unwrap();
    assert_eq!(outcome.files, vec![path.to_string_lossy().into_owned()]);
    assert_eq!(
        fs::read_to_string(&legacy).unwrap(),
        "{\"plugins\":[\"keep-desktop\"]}"
    );
    assert_eq!(
        fs::read_to_string(&legacy_cli).unwrap(),
        "{\"plugins\":[\"keep-cli\"]}"
    );
    let mut applied = parsed(&path);
    assert_eq!(
        applied["config"]["defaultModelSelection"],
        json!({"providerId":"lolicode","modelId":"channel/model","options":{"reasoningLevel":"medium"}})
    );
    assert_eq!(
        applied["config"]["providerConfigRules"]["providerRules"][1]["config"]["api"]["type"],
        "openai-chat-completions"
    );
    assert_eq!(
        applied["config"]["modelConfigRules"]["providerModelRules"][1]["config"]["optionSpecs"]
            ["reasoningLevel"],
        json!({"values":["medium","high"],"map":"{\"reasoning_effort\": reasoningLevel}"})
    );
    assert_zcode_personal_reader(&path);
    applied["config"]["providerConfigRules"]["providerRules"]
        .as_array_mut()
        .unwrap()
        .retain(|rule| rule["providerId"] != "lolicode");
    applied["config"]["modelConfigRules"]["providerModelRules"]
        .as_array_mut()
        .unwrap()
        .retain(|rule| rule["providerId"] != "lolicode");
    applied["config"]["providerOrder"] = original["config"]["providerOrder"].clone();
    applied["config"]["defaultModelSelection"] =
        original["config"]["defaultModelSelection"].clone();
    assert_eq!(
        applied, original,
        "unrelated provider/model sections must remain equal"
    );
    assert!(
        apply_at("zcode", &source(), "channel/model", directory.path())
            .unwrap()
            .backups
            .is_empty()
    );
    let mut rotated = source();
    rotated.api_key = "rotated-synthetic-lease".into();
    apply_at("zcode", &rotated, "channel/model", directory.path()).unwrap();
    let mut edited = parsed(&path);
    edited["config"]["modelConfigRules"]["providerModelRules"][1]["config"]["properties"]
        ["contextWindow"] = json!(9999);
    let before = serde_json::to_string_pretty(&edited).unwrap();
    fs::write(&path, &before).unwrap();
    apply_at("zcode", &rotated, "channel/model", directory.path()).unwrap();
    let applied = parsed(&path);
    assert_eq!(
        applied["config"]["modelConfigRules"]["providerModelRules"][1],
        edited["config"]["modelConfigRules"]["providerModelRules"][1]
    );
    assert_eq!(
        applied["config"]["defaultModelSelection"]["providerId"],
        "lolicode-managed"
    );
    assert_zcode_personal_reader(&path);
    assert!(
        apply_at("zcode", &rotated, "channel/model", directory.path())
            .unwrap()
            .backups
            .is_empty()
    );
    let mut custom = parsed(&path);
    custom["config"]["providerConfigRules"]["providerRules"][2]["providerName"] =
        json!("My customized provider");
    write(&path, &custom.to_string());
    apply_at("zcode", &rotated, "channel/model", directory.path()).unwrap();
    let next = parsed(&path);
    assert_eq!(
        next["config"]["providerConfigRules"]["providerRules"][2],
        custom["config"]["providerConfigRules"]["providerRules"][2]
    );
    assert_eq!(
        next["config"]["defaultModelSelection"]["providerId"],
        "lolicode-managed-2"
    );
    assert_zcode_personal_reader(&path);
    assert!(
        apply_at("zcode", &rotated, "channel/model", directory.path())
            .unwrap()
            .backups
            .is_empty()
    );
}

#[test]
fn external_zcode_respects_modern_environment_paths_and_rejects_unknown_schema_without_legacy_fallback(
) {
    let directory = tempdir().unwrap();
    let mut locations = Locations::fixture(directory.path());
    locations.zcode_data_base_dir = Some(directory.path().join("zcode-home"));
    let modern = directory
        .path()
        .join("zcode-home/.zcode/v2/provider_config.json");
    write(&modern, &modern_zcode().to_string());
    assert_eq!(paths("zcode", &locations).unwrap(), vec![modern.clone()]);
    let explicit = directory.path().join("explicit/provider.json");
    write(&explicit, "{\"schemaVersion\":2,\"config\":{}}");
    locations.zcode_personal_config = Some(explicit.clone());
    assert_eq!(paths("zcode", &locations).unwrap(), vec![explicit.clone()]);
    assert!(apply_with_locations("zcode", &source(), "channel/model", &locations).is_err());
    assert_eq!(
        fs::read_to_string(&explicit).unwrap(),
        "{\"schemaVersion\":2,\"config\":{}}"
    );
    assert!(!directory
        .path()
        .join("zcode-home/.zcode/cli/config.json")
        .exists());
    fs::remove_file(&explicit).unwrap();
    assert!(apply_with_locations("zcode", &source(), "channel/model", &locations).is_err());
    assert!(!explicit.exists());
    let mut unknown = modern_zcode();
    unknown["config"]["futureSection"] = json!({"doNotDiscard":true});
    write(&modern, &unknown.to_string());
    locations.zcode_personal_config = None;
    assert!(apply_with_locations("zcode", &source(), "channel/model", &locations).is_err());
    assert_eq!(parsed(&modern), unknown);
}

#[test]
fn external_mimo_resolves_explicit_homes_then_existing_legacy_and_preserves_jsonc_headers() {
    let directory = tempdir().unwrap();
    let legacy = directory.path().join(".config/mimocode/mimocode.jsonc");
    write(&legacy, "{\n // preserve MCP and headers\n \"mcp\":{\"mine\":{\"headers\":{\"private\":\"synthetic-only\"}}},\"enabled_providers\":[\"mine\"]\n}");
    apply_at("mimocode", &source(), "channel/model", directory.path()).unwrap();
    let value = parsed(&legacy);
    assert_eq!(value["mcp"]["mine"]["headers"]["private"], "synthetic-only");
    assert!(fs::read_to_string(&legacy)
        .unwrap()
        .contains("// preserve MCP and headers"));
    assert_eq!(
        value["provider"]["lolicode"]["npm"],
        "@ai-sdk/openai-compatible"
    );
    assert_eq!(value["enabled_providers"], json!(["mine", "lolicode"]));
    let mut locations = Locations::fixture(directory.path());
    locations.mimocode_home = Some(directory.path().join("explicit-mimo"));
    locations.xdg_config_home = Some(directory.path().join("xdg"));
    assert_eq!(
        paths("mimocode", &locations).unwrap(),
        vec![directory.path().join("explicit-mimo/config/mimocode.jsonc")]
    );
    locations.mimocode_home = None;
    assert_eq!(
        paths("mimocode", &locations).unwrap(),
        vec![directory.path().join("xdg/mimocode/mimocode.jsonc")]
    );
}

#[test]
fn external_dsh_preserves_javascript_tags_other_routes_and_user_comments_verbatim() {
    let directory = tempdir().unwrap();
    let path = directory.path().join(".dsh/profiles/web/cordis.patch.yml");
    let original = "# keep entire composition\n- id: unrelated\n  config:\n    code: !!js |-\n      () => ({ neverExecute: true })\n- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      mine:\n        baseURL: https://example.invalid/v1\n        models:\n          - id: mine\n    retry: !!js process.env.NEVER_EXECUTE\n- id: footer\n  config: { untouched: true }\n";
    write(&path, original);
    apply_at(
        "deepseek-harness",
        &source(),
        "channel/model",
        directory.path(),
    )
    .unwrap();
    let next = fs::read_to_string(&path).unwrap();
    assert!(next.contains("code: !!js |-\n      () => ({ neverExecute: true })"));
    assert!(next.contains("retry: !!js process.env.NEVER_EXECUTE"));
    assert!(next.contains("      mine:\n        baseURL: https://example.invalid/v1\n        models:\n          - id: mine\n"));
    assert!(next.contains("- id: footer\n  config: { untouched: true }\n"));
    let tree = yaml(&next).unwrap();
    assert_eq!(
        tree[1]["config"]["providers"]["lolicode"]["api"].as_str(),
        Some("openai-completions")
    );
    assert_eq!(
        tree[1]["config"]["providers"]["lolicode"]["models"][0]["input"][1].as_str(),
        Some("image")
    );
    let repeat = apply_at(
        "deepseek-harness",
        &source(),
        "channel/model",
        directory.path(),
    )
    .unwrap();
    assert!(repeat.backups.is_empty());
}

#[test]
fn external_collisions_dynamic_provider_blocks_and_invalid_sources_never_overwrite() {
    let directory = tempdir().unwrap();
    let desktop = directory.path().join(".zcode/v2/config.json");
    let original = "{\"provider\":{\"lolicode\":{\"kind\":\"openai\",\"options\":{\"apiKey\":\"USER-OWNED\"}}}}";
    write(&desktop, original);
    apply_at("zcode", &source(), "channel/model", directory.path()).unwrap();
    assert_eq!(
        parsed(&desktop)["provider"]["lolicode"],
        json!({"kind":"openai","options":{"apiKey":"USER-OWNED"}})
    );
    assert_eq!(parsed(&desktop)["model"], "lolicode-managed/channel/model");
    let dsh_path = directory.path().join(".dsh/profiles/web/cordis.patch.yml");
    let dynamic = "- id: llm-pi-ai\n  config:\n    providers: !!js () => ({ userOwned: true })\n";
    write(&dsh_path, dynamic);
    assert!(apply_at(
        "deepseek-harness",
        &source(),
        "channel/model",
        directory.path()
    )
    .is_err());
    assert_eq!(fs::read_to_string(&dsh_path).unwrap(), dynamic);
    let mut remote = source();
    remote.base_url = "https://example.invalid/v1".into();
    assert!(apply_at("workbuddy", &remote, "channel/model", directory.path()).is_err());
    assert!(!directory.path().join(".workbuddy/models.json").exists());
}

#[test]
fn external_dsh_preserves_provider_names_with_a_colon_and_all_non_owned_yaml_values() {
    let directory = tempdir().unwrap();
    let path = directory.path().join(".dsh/profiles/web/cordis.patch.yml");
    let original = "# keep the entire composition\n- id: llm-pi-ai\n  config:legacy: { untouched: true }\n  config:\n    providers:legacy: { untouched: true }\n    providers:\n      lolicode:custom:\n        api: openai-completions\n        baseURL: https://example.invalid/v1\n        headers: { private: synthetic-user-key }\n      mine:\n        api: openai-completions\n    retry: !!js process.env.NEVER_EXECUTE\n- id: footer\n  config: { untouched: true }\n";
    write(&path, original);
    let mut expected = yaml(original).unwrap();
    apply_at(
        "deepseek-harness",
        &source(),
        "channel/model",
        directory.path(),
    )
    .unwrap();
    let next = fs::read_to_string(&path).unwrap();
    let mut actual = yaml(&next).unwrap();
    let key = serde_yaml::Value::String("lolicode".into());
    let managed = actual[0]["config"]["providers"]
        .as_mapping_mut()
        .unwrap()
        .remove(&key)
        .expect("new managed provider");
    assert_eq!(
        actual, expected,
        "the entire non-owned tree must remain equal"
    );
    assert!(next.contains("      lolicode:custom:\n        api: openai-completions\n        baseURL: https://example.invalid/v1\n        headers: { private: synthetic-user-key }\n"));
    assert!(next.contains("retry: !!js process.env.NEVER_EXECUTE"));
    // The same invariants apply when replacing our existing owned provider.
    expected[0]["config"]["providers"]
        .as_mapping_mut()
        .unwrap()
        .insert(key, managed);
    let mut changed = source();
    changed.api_key = "rotated-synthetic-lease".into();
    apply_at(
        "deepseek-harness",
        &changed,
        "channel/model",
        directory.path(),
    )
    .unwrap();
    let mut updated = yaml(&fs::read_to_string(&path).unwrap()).unwrap();
    updated[0]["config"]["providers"]
        .as_mapping_mut()
        .unwrap()
        .remove(serde_yaml::Value::String("lolicode".into()));
    expected[0]["config"]["providers"]
        .as_mapping_mut()
        .unwrap()
        .remove(serde_yaml::Value::String("lolicode".into()));
    assert_eq!(updated, expected);
    assert!(yaml_key("      lolicode: # own\n", 6, "lolicode"));
    assert!(yaml_key("      lolicode:\n", 6, "lolicode"));
    assert!(!yaml_key("      lolicode:custom:\n", 6, "lolicode"));
}

#[cfg(windows)]
#[test]
fn external_windows_junction_cannot_redirect_model_config_writes() {
    let directory = tempdir().unwrap();
    let home = directory.path().join("home");
    let redirected = directory.path().join("unrelated");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&redirected).unwrap();
    let junction = home.join(".workbuddy");
    let created = std::process::Command::new("cmd.exe")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&redirected)
        .output()
        .unwrap();
    assert!(
        created.status.success(),
        "isolated junction fixture must be available"
    );
    let result = apply_at("workbuddy", &source(), "channel/model", &home);
    let escaped = redirected.join("models.json").exists();
    // Remove the junction itself before tempfile recursively cleans its root.
    fs::remove_dir(&junction).unwrap();
    assert!(result.is_err());
    assert!(!escaped, "no file may be written through the junction");
    assert!(!home
        .join(crate::channel::profile_directory())
        .join("external-model-config/workbuddy.json")
        .exists());
}

#[test]
fn external_managed_provider_manual_edits_are_not_overwritten() {
    let directory = tempdir().unwrap();
    apply_at("mimocode", &source(), "channel/model", directory.path()).unwrap();
    let path = paths("mimocode", &Locations::fixture(directory.path()))
        .unwrap()
        .remove(0);
    let mut value = parsed(&path);
    value["provider"]["lolicode"]["options"]["headers"] = json!({"private":"user-edit"});
    let before = json_bytes(&value).unwrap();
    fs::write(&path, &before).unwrap();
    assert!(apply_at("mimocode", &source(), "channel/model", directory.path()).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn external_mimo_partial_catalog_limits_produce_a_loadable_config() {
    let directory = tempdir().unwrap();
    let mut catalog = source();
    let complete = catalog.models[0].clone();
    catalog.models = [
        ("complete", Some(128000), Some(8192)),
        ("context-only", Some(1000000), None),
        ("output-only", None, Some(64000)),
        ("unknown", None, None),
    ]
    .into_iter()
    .map(|(id, context, output)| {
        let mut model = complete.clone();
        model.id = id.into();
        model.context_limit = context;
        model.output_limit = output;
        model
    })
    .collect();
    let outcome = apply_at("mimocode", &catalog, "context-only", directory.path()).unwrap();
    let document = parsed(Path::new(&outcome.files[0]));
    assert_eq!(document["model"], "lolicode/context-only");
    let models = &document["provider"]["lolicode"]["models"];
    assert_eq!(
        models["complete"]["limit"],
        json!({"context":128000,"output":8192})
    );
    for id in ["context-only", "output-only", "unknown"] {
        assert!(
            models[id].get("limit").is_none(),
            "{id}: MiMo requires both context and output in a limit override"
        );
        assert_eq!(models[id]["tool_call"], true);
        assert_eq!(models[id]["modalities"]["input"], json!(["text", "image"]));
    }
}

#[test]
fn external_mimo_reapply_repairs_owned_partial_limits_with_a_backup() {
    let directory = tempdir().unwrap();
    let mut catalog = source();
    catalog.models[0].output_limit = None;
    apply_at("mimocode", &catalog, "channel/model", directory.path()).unwrap();
    let path = paths("mimocode", &Locations::fixture(directory.path()))
        .unwrap()
        .remove(0);
    // Simulate the previous writer and its ownership ledger, keeping unrelated
    // settings in place. Only the managed provider may be repaired on reapply.
    let mut legacy = parsed(&path);
    legacy["provider"]["lolicode"]["models"]["channel/model"]["limit"] = json!({"context":128000});
    legacy["theme"] = json!("keep-my-theme");
    let before = json_bytes(&legacy).unwrap();
    fs::write(&path, &before).unwrap();
    let marker = directory
        .path()
        .join(crate::channel::profile_directory())
        .join("external-model-config/mimocode.json");
    let mut ledger: Ownership = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
    ledger
        .files
        .get_mut(&path.to_string_lossy().into_owned())
        .unwrap()
        .insert(
            "lolicode".into(),
            json_digest(&legacy["provider"]["lolicode"]).unwrap(),
        );
    fs::write(&marker, serde_json::to_vec(&ledger).unwrap()).unwrap();
    let result = apply_at("mimocode", &catalog, "channel/model", directory.path()).unwrap();
    assert_eq!(fs::read(&result.backups[0]).unwrap(), before);
    assert_eq!(parsed(&path)["theme"], "keep-my-theme");
    assert!(
        parsed(&path)["provider"]["lolicode"]["models"]["channel/model"]
            .get("limit")
            .is_none()
    );
    assert!(
        apply_at("mimocode", &catalog, "channel/model", directory.path())
            .unwrap()
            .backups
            .is_empty()
    );
}

#[test]
fn external_zcode_legacy_collision_reserves_one_provider_and_reuses_it_on_rotation() {
    let directory = tempdir().unwrap();
    let path = directory.path().join(".zcode/v2/config.json");
    let original = json!({"provider":{"lolicode":{"kind":"openai","options":{"apiKey":"synthetic-user-owned"}}},
        "enabled_providers":["lolicode"],"disabled_providers":["lolicode","other"]});
    write(&path, &original.to_string());
    let first = apply_at("zcode", &source(), "channel/model", directory.path()).unwrap();
    assert!(first.message.contains("独立"));
    let mut changed = source();
    changed.api_key = "rotated-synthetic-lease".into();
    apply_at("zcode", &changed, "channel/model", directory.path()).unwrap();
    let value = parsed(&path);
    assert_eq!(value["provider"].as_object().unwrap().len(), 2);
    assert_eq!(
        value["provider"]["lolicode"],
        original["provider"]["lolicode"]
    );
    assert_eq!(
        value["provider"]["lolicode-managed"]["options"]["apiKey"],
        changed.api_key
    );
    assert_eq!(
        value["enabled_providers"],
        json!(["lolicode", "lolicode-managed"])
    );
    assert_eq!(value["disabled_providers"], original["disabled_providers"]);
    assert!(
        apply_at("zcode", &changed, "channel/model", directory.path())
            .unwrap()
            .backups
            .is_empty()
    );
}

#[test]
fn external_zcode_missing_ledger_preserves_imported_personal_rules_and_does_not_accumulate_providers(
) {
    let directory = tempdir().unwrap();
    let path = directory.path().join(".zcode/v2/provider_config.json");
    write(&path, &modern_zcode().to_string());
    apply_at("zcode", &source(), "channel/model", directory.path()).unwrap();
    let before = parsed(&path);
    fs::remove_file(
        directory
            .path()
            .join(crate::channel::profile_directory())
            .join("external-model-config/zcode.json"),
    )
    .unwrap();
    let mut changed = source();
    changed.api_key = "new-synthetic-session-lease".into();
    apply_at("zcode", &changed, "channel/model", directory.path()).unwrap();
    let value = parsed(&path);
    let providers = value["config"]["providerConfigRules"]["providerRules"]
        .as_array()
        .unwrap();
    assert_eq!(providers.len(), 3);
    assert_eq!(
        providers[1],
        before["config"]["providerConfigRules"]["providerRules"][1]
    );
    assert_eq!(
        value["config"]["modelConfigRules"]["providerModelRules"][1],
        before["config"]["modelConfigRules"]["providerModelRules"][1]
    );
    assert_eq!(
        value["config"]["defaultModelSelection"]["providerId"],
        "lolicode-managed"
    );
    assert_zcode_personal_reader(&path);
    assert!(
        apply_at("zcode", &changed, "channel/model", directory.path())
            .unwrap()
            .backups
            .is_empty()
    );
}

#[test]
fn external_zcode_normalized_json_and_rule_order_do_not_look_like_user_edits() {
    fn reverse_keys(value: &Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .rev()
                    .map(|(key, value)| (key.clone(), reverse_keys(value)))
                    .collect(),
            ),
            Value::Array(array) => Value::Array(array.iter().map(reverse_keys).collect()),
            _ => value.clone(),
        }
    }
    let directory = tempdir().unwrap();
    let path = directory.path().join(".zcode/v2/provider_config.json");
    write(&path, &modern_zcode().to_string());
    let mut channel = source();
    let mut second = channel.models[0].clone();
    second.id = "channel/second".into();
    channel.models.push(second);
    apply_at("zcode", &channel, "channel/model", directory.path()).unwrap();
    let mut normalized = reverse_keys(&parsed(&path));
    normalized["config"]["modelConfigRules"]["providerModelRules"]
        .as_array_mut()
        .unwrap()
        .reverse();
    write(&path, &normalized.to_string());
    channel.api_key = "rotated-synthetic-lease".into();
    apply_at("zcode", &channel, "channel/model", directory.path()).unwrap();
    let value = parsed(&path);
    assert_eq!(
        value["config"]["providerConfigRules"]["providerRules"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        value["config"]["defaultModelSelection"]["providerId"],
        "lolicode"
    );
}

#[test]
fn external_zcode_accepts_ownership_hashes_from_the_previous_adapter() {
    for modern in [false, true] {
        let directory = tempdir().unwrap();
        let path = directory.path().join(if modern {
            ".zcode/v2/provider_config.json"
        } else {
            ".zcode/v2/config.json"
        });
        if modern {
            write(&path, &modern_zcode().to_string());
        }
        apply_at("zcode", &source(), "channel/model", directory.path()).unwrap();
        let value = parsed(&path);
        let owned = if modern {
            json!({"provider":value["config"]["providerConfigRules"]["providerRules"][1],
                "models":[value["config"]["modelConfigRules"]["providerModelRules"][1]],"manualModels":[]})
        } else {
            value["provider"]["lolicode"].clone()
        };
        let ledger_path = directory
            .path()
            .join(crate::channel::profile_directory())
            .join("external-model-config/zcode.json");
        let mut ledger = parsed(&ledger_path);
        ledger["files"][path.to_string_lossy().as_ref()]["lolicode"] =
            json!(json_digest(&owned).unwrap());
        write(&ledger_path, &ledger.to_string());
        let mut rotated = source();
        rotated.api_key = "new-synthetic-lease".into();
        apply_at("zcode", &rotated, "channel/model", directory.path()).unwrap();
        let updated = parsed(&path);
        if modern {
            assert_eq!(
                updated["config"]["defaultModelSelection"]["providerId"],
                "lolicode"
            );
            assert_eq!(
                updated["config"]["providerConfigRules"]["providerRules"]
                    .as_array()
                    .unwrap()
                    .len(),
                2
            );
        } else {
            assert_eq!(updated["model"], "lolicode/channel/model");
            assert_eq!(updated["provider"].as_object().unwrap().len(), 1);
        }
    }
}

#[test]
fn external_dsh_single_line_maps_convert_safely_and_repeat_without_yaml_errors() {
    for config in [
        "  config: {providers: {mine: {api: openai-completions, name: 'model #one', description: 'It''s a \"quoted\" !!js *text &text', headers: {Authorization: synthetic-only}}}, retry: 2} # keep config !!js *comment &comment\n",
        "  config:\n    providers: {mine: {api: openai-completions, name: \"model #one\", headers: {Authorization: synthetic-only}}} # keep providers\n    retry: 2\n",
    ] {
        for newline in ["\n", "\r\n"] {
            let directory = tempdir().unwrap();
            let path = directory.path().join(".dsh/profiles/web/cordis.patch.yml");
            let original = format!("# keep composition\n- id: llm-pi-ai\n{config}- id: footer\n  config:\n    retry: !!js process.env.NEVER_EXECUTE\n").replace('\n',newline);
            let expected = yaml(&original).unwrap();
            write(&path, &original);
            apply_at("deepseek-harness", &source(), "channel/model", directory.path()).unwrap();
            let next = fs::read_to_string(&path).unwrap();
            assert!(next.contains("# keep config") || next.contains("# keep providers"));
            assert!(next.contains(&format!("    retry: !!js process.env.NEVER_EXECUTE{newline}")));
            if newline == "\r\n" { assert!(!next.replace("\r\n", "").contains('\n')); }
            let mut actual = yaml(&next).unwrap();
            actual[0]["config"]["providers"].as_mapping_mut().unwrap().remove(serde_yaml::Value::String("lolicode".into()));
            assert_eq!(actual, expected);
            assert!(apply_at("deepseek-harness", &source(), "channel/model", directory.path()).unwrap().backups.is_empty());
        }
    }
}

#[test]
fn external_dsh_dynamic_inline_maps_and_parse_errors_do_not_write_or_expose_values() {
    let directory = tempdir().unwrap();
    let path = directory.path().join(".dsh/profiles/web/cordis.patch.yml");
    for raw in [
        "- id: llm-pi-ai\n  config: {providers: {mine: !!js process.env.NEVER_EXECUTE}}\n",
        "- id: llm-pi-ai\n  config: {providers: {mine: !custom process.env.NEVER_EXECUTE}}\n",
        "- id: llm-pi-ai\n  config: {providers: &routes {mine: {name: keep}}}\n",
        "- id: routes\n  config: &routes {mine: {name: keep}}\n- id: llm-pi-ai\n  config: {providers: *routes}\n",
    ] {
        write(&path, raw);
        assert!(apply_at(
            "deepseek-harness",
            &source(),
            "channel/model",
            directory.path()
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }
    let malformed = "- id: llm-pi-ai\n  config: {apiKey: synthetic-sensitive-value\n";
    write(&path, malformed);
    let error = apply_at(
        "deepseek-harness",
        &source(),
        "channel/model",
        directory.path(),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("行") && error.contains("列"));
    assert!(!error.contains("synthetic-sensitive-value"));
    assert_eq!(fs::read_to_string(path).unwrap(), malformed);
}
