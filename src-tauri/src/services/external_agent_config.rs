//! Additive model configuration for external agents, independent of AppType.
//! Only synthetic fixture homes are used by the tests in this module.
use super::channel_center::{ChannelModel, ChannelSource};
use crate::{
    config::{atomic_write_private, get_home_dir, stage_write},
    error::AppError,
    jsonc_document::JsoncDocument,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

pub const TARGETS: [&str; 4] = ["workbuddy", "deepseek-harness", "zcode", "mimocode"];
const LIMIT: u64 = 4 * 1024 * 1024;
static WRITE_GATE: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub files: Vec<String>,
    pub backups: Vec<String>,
    pub message: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ownership {
    format: u32,
    target: String,
    files: BTreeMap<String, BTreeMap<String, String>>,
}

/// An explicit path environment keeps tests independent of the operator's home.
#[derive(Clone)]
pub struct Locations {
    pub home: PathBuf,
    pub local_app_data: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    pub mimocode_home: Option<PathBuf>,
    pub dsh_home: Option<PathBuf>,
    pub zcode_data_base_dir: Option<PathBuf>,
    pub zcode_personal_config: Option<PathBuf>,
}
impl Locations {
    pub fn fixture(home: &Path) -> Self {
        Self {
            home: home.into(),
            local_app_data: Some(home.join("AppData/Local")),
            xdg_config_home: None,
            mimocode_home: None,
            dsh_home: None,
            zcode_data_base_dir: None,
            zcode_personal_config: None,
        }
    }
    fn system() -> Self {
        Self {
            home: get_home_dir(),
            local_app_data: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
            xdg_config_home: std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
            mimocode_home: std::env::var_os("MIMOCODE_HOME").map(PathBuf::from),
            dsh_home: std::env::var_os("DSH_HOME").map(PathBuf::from),
            zcode_data_base_dir: zcode_env_path("ZCODE_DATA_BASE_DIR"),
            zcode_personal_config: zcode_env_path("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"),
        }
    }
}

fn zcode_env_path(name: &str) -> Option<PathBuf> {
    std::env::var(name).ok().and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| PathBuf::from(value))
    })
}

pub fn apply(
    target: &str,
    source: &ChannelSource,
    default_route: &str,
) -> Result<Outcome, AppError> {
    apply_with_locations(target, source, default_route, &Locations::system())
}
pub fn apply_at(
    target: &str,
    source: &ChannelSource,
    default_route: &str,
    home: &Path,
) -> Result<Outcome, AppError> {
    apply_with_locations(target, source, default_route, &Locations::fixture(home))
}
pub fn apply_with_locations(
    target: &str,
    source: &ChannelSource,
    default_route: &str,
    locations: &Locations,
) -> Result<Outcome, AppError> {
    let _guard = WRITE_GATE
        .lock()
        .map_err(|_| AppError::Lock("外部应用配置锁不可用".into()))?;
    apply_inner(target, source, default_route, locations, None)
}

fn fail(message: &str) -> AppError {
    AppError::Config(message.into())
}
fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn json_digest(value: &Value) -> Result<String, AppError> {
    Ok(digest(
        &serde_json::to_vec(value).map_err(|source| AppError::JsonSerialize { source })?,
    ))
}
fn json_bytes(value: &Value) -> Result<Vec<u8>, AppError> {
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|source| AppError::JsonSerialize { source })?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn valid_path(path: &Path) -> Result<(), AppError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(fail("配置目录必须是没有上级跳转的绝对路径"));
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if is_redirect(&metadata) => {
                return Err(fail("拒绝通过符号链接或目录联接写入外部应用配置"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(AppError::io(&current, error)),
        }
    }
    Ok(())
}

fn is_redirect(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // A junction is a reparse point without necessarily being a symbolic
        // link. Reject all reparse points while walking the destination path.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn read(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    valid_path(path)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.len() > LIMIT {
                return Err(fail("外部应用配置不是有界普通文件；原文件保留"));
            }
            fs::read(path)
                .map(Some)
                .map_err(|error| AppError::io(path, error))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io(path, error)),
    }
}
fn text(bytes: Option<&[u8]>) -> Result<&str, AppError> {
    std::str::from_utf8(bytes.unwrap_or(b"{}"))
        .map_err(|_| fail("外部配置必须是 UTF-8 文本，未修改原文件"))
}
fn available(source: &ChannelSource, default_route: &str) -> Result<Vec<ChannelModel>, AppError> {
    if source.protocol != "openai_chat"
        || source.api_key.is_empty()
        || source.api_key.len() > 4096
        || source.api_key.chars().any(char::is_control)
        || !source.enabled
    {
        return Err(fail("外部应用需要有效的 OpenAI Chat 本地聚合渠道"));
    }
    let url = url::Url::parse(&source.base_url).map_err(|_| fail("本地聚合地址无效"))?;
    if url.scheme() != "http"
        || !matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(fail(
            "外部一键配置只接受本机 HTTP 聚合网关，不写入真实上游凭据",
        ));
    }
    let models = source
        .models
        .iter()
        .filter(|model| model.available())
        .cloned()
        .collect::<Vec<_>>();
    let mut ids = BTreeSet::new();
    if models.is_empty()
        || models.len() > 10000
        || !models.iter().any(|model| model.id == default_route)
        || models.iter().any(|model| {
            model.id.is_empty()
                || model.id.len() > 2048
                || model.id.chars().any(char::is_control)
                || !ids.insert(&model.id)
        })
    {
        return Err(fail("模型目录或默认模型无效，未修改外部配置"));
    }
    Ok(models)
}

fn choose(directory: &Path, base: &str) -> Result<PathBuf, AppError> {
    let jsonc = directory.join(format!("{base}.jsonc"));
    let json = directory.join(format!("{base}.json"));
    if jsonc.exists() && json.exists() {
        return Err(fail(
            "同一目录存在 JSON 与 JSONC 两份配置，请先在目标应用确认生效文件",
        ));
    }
    Ok(if json.exists() { json } else { jsonc })
}
fn paths(target: &str, locations: &Locations) -> Result<Vec<PathBuf>, AppError> {
    valid_path(&locations.home)?;
    match target {
        "workbuddy" => {
            let candidates = [
                locations.home.join(".workbuddy/models.json"),
                locations.home.join(".workbuddy-ai/models.json"),
            ];
            let existing = candidates
                .iter()
                .filter(|path| path.exists())
                .cloned()
                .collect::<Vec<_>>();
            Ok(if existing.is_empty() {
                vec![candidates[0].clone()]
            } else {
                existing
            })
        }
        "zcode" => {
            let base = locations
                .zcode_data_base_dir
                .as_ref()
                .unwrap_or(&locations.home);
            valid_path(base)?;
            let personal = locations
                .zcode_personal_config
                .clone()
                .unwrap_or_else(|| base.join(".zcode/v2/provider_config.json"));
            valid_path(&personal)?;
            if personal.exists() {
                // Both modern Desktop and CLI consume this one Personal file.
                return Ok(vec![personal]);
            }
            if locations.zcode_personal_config.is_some() {
                return Err(fail(
                    "指定的 ZCode Personal 配置尚不存在，请先启动 ZCode 完成原配置迁移",
                ));
            }
            // Do not create an empty Personal file: that would prevent ZCode's
            // first-run importer from carrying over the user's legacy models.
            Ok(vec![
                base.join(".zcode/v2/config.json"),
                base.join(".zcode/cli/config.json"),
            ])
        }
        "deepseek-harness" => Ok(vec![locations
            .dsh_home
            .as_ref()
            .unwrap_or(&locations.home.join(".dsh"))
            .join("profiles/web/cordis.patch.yml")]),
        "mimocode" => {
            if let Some(root) = &locations.mimocode_home {
                valid_path(root)?;
                return Ok(vec![choose(&root.join("config"), "mimocode")?]);
            }
            if let Some(root) = &locations.xdg_config_home {
                valid_path(root)?;
                return Ok(vec![choose(&root.join("mimocode"), "mimocode")?]);
            }
            let existing = locations.home.join(".config/mimocode");
            if existing.join("mimocode.jsonc").exists() || existing.join("mimocode.json").exists() {
                return Ok(vec![choose(&existing, "mimocode")?]);
            }
            let directory = if cfg!(windows) {
                locations
                    .local_app_data
                    .as_ref()
                    .ok_or_else(|| fail("无法确定 MiMo 的 LOCALAPPDATA 目录"))?
                    .join("mimocode")
            } else {
                existing
            };
            Ok(vec![choose(&directory, "mimocode")?])
        }
        _ => Err(fail("不支持的外部应用")),
    }
}

fn object(value: &mut Value) -> Result<&mut Map<String, Value>, AppError> {
    value
        .as_object_mut()
        .ok_or_else(|| fail("配置字段不是对象，未覆盖原内容"))
}
fn owned(
    old: Option<&Value>,
    key: &str,
    ownership: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    if let Some(old) = old {
        if ownership.get(key) != Some(&json_digest(old)?) {
            return Err(AppError::Conflict(
                "目标已存在同名模型/提供商且不属于 LoliCode，或已被用户修改；未覆盖".into(),
            ));
        }
    } else if ownership.contains_key(key) {
        return Err(AppError::Conflict(
            "LoliCode 管理的配置已从目标移除，请重新确认应用配置后再接入".into(),
        ));
    }
    Ok(())
}

// ZCode may import legacy providers into its Personal file or rewrite object
// ordering. Missing ownership is not permission to replace that configuration:
// reserve a separate provider and retain it in our ledger for later applies.
fn zcode_fingerprint(value: &Value) -> Result<String, AppError> {
    fn ordered(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut keys = map.keys().collect::<Vec<_>>();
                keys.sort_unstable();
                Value::Object(
                    keys.into_iter()
                        .map(|key| (key.clone(), ordered(&map[key])))
                        .collect(),
                )
            }
            Value::Array(array) => Value::Array(array.iter().map(ordered).collect()),
            _ => value.clone(),
        }
    }
    let mut value = value.clone();
    // Personal rule arrays are keyed by model ID; their source order is not
    // configuration. The explicit modelOrder inside the provider still is.
    if value.get("provider").is_some() {
        for key in ["models", "manualModels"] {
            if let Some(array) = value.get_mut(key).and_then(Value::as_array_mut) {
                array.sort_by(|a, b| a["modelId"].as_str().cmp(&b["modelId"].as_str()));
            }
        }
    }
    json_digest(&ordered(&value))
}

fn zcode_provider_key(
    existing: &BTreeMap<String, Value>,
    ownership: &BTreeMap<String, String>,
) -> Result<String, AppError> {
    let managed = |id: &str| {
        id == "lolicode"
            || id == "lolicode-managed"
            || id
                .strip_prefix("lolicode-managed-")
                .is_some_and(|suffix| suffix.parse::<u32>().is_ok())
    };
    for (key, hash) in ownership.iter().filter(|(key, _)| managed(key)) {
        if let Some(value) = existing.get(key) {
            if *hash == zcode_fingerprint(value)? || *hash == json_digest(value)? {
                return Ok(key.clone());
            }
        }
    }
    for suffix in 0..10000 {
        let key = match suffix {
            0 => "lolicode".to_owned(),
            1 => "lolicode-managed".to_owned(),
            _ => format!("lolicode-managed-{suffix}"),
        };
        if !existing.contains_key(&key) {
            return Ok(key);
        }
    }
    Err(fail("ZCode 已有过多同名配置，原配置未修改"))
}

fn zcode_provider_name(key: &str) -> String {
    if key == "lolicode" {
        "LoliCode".into()
    } else {
        format!("LoliCode · {key}")
    }
}
fn model_value(model: &ChannelModel) -> Value {
    let mut value = json!({"id":model.id,"name":model.name.as_deref().unwrap_or(&model.id),"tool_call":model.supports_tools != Some(false)});
    if let Some(context) = model.effective_context_limit() {
        value["limit"]["context"] = json!(context);
    }
    if let Some(output) = model.output_limit {
        value["limit"]["output"] = json!(output);
    }
    if let Some(input) = &model.input_modalities {
        value["modalities"] = json!({"input":input,"output":["text"]});
    }
    value
}
fn provider(source: &ChannelSource, models: &[ChannelModel], zcode: bool) -> Value {
    let models: Map<String, Value> = models
        .iter()
        .map(|model| (model.id.clone(), model_value(model)))
        .collect();
    let mut value = json!({"name":"LoliCode","options":{"baseURL":source.base_url.trim_end_matches('/'),"apiKey":source.api_key},"models":models});
    if zcode {
        value["kind"] = json!("openai-compatible");
    } else {
        value["npm"] = json!("@ai-sdk/openai-compatible");
    }
    value
}

fn json_config(
    raw: Option<&[u8]>,
    source: &ChannelSource,
    models: &[ChannelModel],
    default_route: &str,
    zcode: bool,
    cli: bool,
    ownership: &BTreeMap<String, String>,
) -> Result<(Vec<u8>, BTreeMap<String, String>), AppError> {
    let mut document = JsoncDocument::parse(text(raw)?)?;
    if document.root_key_count("provider")? > 1 || document.root_key_count("model")? > 1 {
        return Err(fail("模型配置存在重复键，未修改原文件"));
    }
    let mut value = document.value().clone();
    let providers = object(
        value
            .as_object_mut()
            .unwrap()
            .entry("provider")
            .or_insert_with(|| json!({})),
    )?;
    let provider_key = if zcode {
        zcode_provider_key(
            &providers
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
            ownership,
        )?
    } else {
        owned(providers.get("lolicode"), "lolicode", ownership)?;
        "lolicode".into()
    };
    let mut next = provider(source, models, zcode);
    if zcode {
        next["name"] = json!(zcode_provider_name(&provider_key));
    }
    providers.insert(provider_key.clone(), next.clone());
    let route = format!("{provider_key}/{default_route}");
    if zcode && cli {
        match value.get("model") {
            Some(Value::Object(existing))
                if existing
                    .keys()
                    .any(|key| !matches!(key.as_str(), "main" | "lite")) =>
            {
                return Err(fail("ZCode CLI 模型字段含未知结构，未覆盖"))
            }
            Some(Value::String(_)) | Some(Value::Object(_)) | None => {}
            _ => return Err(fail("ZCode CLI 模型字段无效")),
        }
        value["model"] = json!({"main":route,"lite":route});
    } else {
        value["model"] = json!(route);
    }
    // Restricted provider lists must admit the newly applied route.
    if let Some(enabled) = value.get_mut("enabled_providers") {
        let enabled = enabled
            .as_array_mut()
            .ok_or_else(|| fail("enabled_providers 必须是数组"))?;
        if !enabled.iter().any(|entry| entry == &provider_key) {
            enabled.push(json!(provider_key));
        }
    }
    if let Some(disabled) = value.get_mut("disabled_providers") {
        disabled
            .as_array_mut()
            .ok_or_else(|| fail("disabled_providers 必须是数组"))?
            .retain(|entry| entry != &provider_key);
    }
    document.apply(&value)?;
    Ok((
        document.validated_source()?.into_bytes(),
        BTreeMap::from([(
            provider_key,
            if zcode {
                zcode_fingerprint(&next)?
            } else {
                json_digest(&next)?
            },
        )]),
    ))
}

fn known_object<'a>(value: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>, AppError> {
    let object = value
        .as_object()
        .ok_or_else(|| fail("ZCode Personal 配置字段不是对象，原文件未修改"))?;
    if object.keys().any(|field| !fields.contains(&field.as_str())) {
        return Err(fail(
            "ZCode Personal 配置包含当前未支持的字段，原文件未修改",
        ));
    }
    Ok(object)
}

fn validate_zcode_personal(value: &Value) -> Result<(), AppError> {
    known_object(value, &["schemaVersion", "config"])?;
    if value["schemaVersion"].as_u64() != Some(1) {
        return Err(fail("仅支持 ZCode Personal schemaVersion 1，原文件未修改"));
    }
    let config = known_object(
        &value["config"],
        &[
            "providerOrder",
            "providerConfigRules",
            "modelConfigRules",
            "defaultModelSelection",
        ],
    )?;
    let providers = known_object(&value["config"]["providerConfigRules"], &["providerRules"])?;
    let rules = providers
        .get("providerRules")
        .and_then(Value::as_array)
        .ok_or_else(|| fail("ZCode providerRules 必须是数组，原文件未修改"))?;
    let mut seen = BTreeSet::new();
    for rule in rules {
        known_object(
            rule,
            &[
                "providerId",
                "templateId",
                "providerName",
                "enabled",
                "config",
            ],
        )?;
        let id = rule["providerId"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| fail("ZCode providerId 无效，原文件未修改"))?;
        if !seen.insert(id) {
            return Err(fail("ZCode providerId 重复，原文件未修改"));
        }
        known_object(
            &rule["config"],
            &[
                "group",
                "logo",
                "access",
                "api",
                "personalModelIds",
                "modelOrder",
                "visibility",
            ],
        )?;
    }
    let model_rules = known_object(
        &value["config"]["modelConfigRules"],
        &["providerModelRules", "manualProviderModelRules"],
    )?;
    let mut seen_models = BTreeSet::new();
    for name in ["providerModelRules", "manualProviderModelRules"] {
        let rules = model_rules
            .get(name)
            .and_then(Value::as_array)
            .ok_or_else(|| fail("ZCode 模型规则必须是数组，原文件未修改"))?;
        for rule in rules {
            known_object(rule, &["providerId", "modelId", "config"])?;
            let provider = rule["providerId"]
                .as_str()
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| fail("ZCode 模型规则 providerId 无效"))?;
            let model = rule["modelId"]
                .as_str()
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| fail("ZCode 模型规则 modelId 无效"))?;
            if !seen_models.insert((provider, model)) {
                return Err(fail(
                    "ZCode 模型规则重复或同时声明智能与手动配置，原文件未修改",
                ));
            }
            known_object(&rule["config"], &["enabled", "properties", "optionSpecs"])?;
        }
    }
    if let Some(order) = config.get("providerOrder") {
        let order = order
            .as_array()
            .ok_or_else(|| fail("ZCode providerOrder 无效"))?;
        if order
            .iter()
            .any(|id| id.as_str().is_none_or(|id| id.trim().is_empty()))
        {
            return Err(fail("ZCode providerOrder 无效"));
        }
    }
    if let Some(selection) = config.get("defaultModelSelection") {
        known_object(selection, &["providerId", "modelId", "options"])?;
        if ["providerId", "modelId"].iter().any(|key| {
            selection[*key]
                .as_str()
                .is_none_or(|id| id.trim().is_empty())
        }) {
            return Err(fail("ZCode 默认模型选择无效"));
        }
        if let Some(options) = selection.get("options") {
            known_object(options, &["reasoningLevel"])?;
        }
    }
    Ok(())
}

fn zcode_model_rule(model: &ChannelModel, provider_key: &str) -> Value {
    let mut config = json!({});
    if let Some(context) = model.effective_context_limit() {
        config["properties"]["contextWindow"] = json!(context);
    }
    if let Some(supports_tools) = model.supports_tools {
        config["properties"]["supportsToolCall"] = json!(supports_tools);
    }
    if let Some(modalities) = &model.input_modalities {
        let format = &mut config["properties"]["inputFormat"];
        *format = json!({"supportsText":modalities.iter().any(|value| value == "text"),
            "supportsImage":modalities.iter().any(|value| value == "image"),
            "supportsVideo":modalities.iter().any(|value| value == "video"),
            "supportsAudio":modalities.iter().any(|value| value == "audio"),
            "supportsPdf":modalities.iter().any(|value| value == "pdf")});
    }
    if let Some(limit) = model.output_limit {
        config["optionSpecs"]["maxOutputTokens"] =
            json!({"max":limit,"map":"{\"max_tokens\": maxOutputTokens}"});
    }
    config["optionSpecs"]["reasoningLevel"] = if let Some(efforts) = model
        .reasoning_efforts
        .as_ref()
        .filter(|efforts| !efforts.is_empty())
    {
        json!({"values":efforts,"map":"{\"reasoning_effort\": reasoningLevel}"})
    } else {
        // ZCode requires an explicit UI reasoning option even when the upstream
        // publishes no effort levels. This option emits no wire parameter.
        json!({"values":["default"],"map":"{}"})
    };
    json!({"providerId":provider_key,"modelId":model.id,"config":config})
}

fn zcode_personal(
    raw: Option<&[u8]>,
    source: &ChannelSource,
    models: &[ChannelModel],
    default_route: &str,
    ownership: &BTreeMap<String, String>,
) -> Result<(Vec<u8>, BTreeMap<String, String>), AppError> {
    let raw = raw.ok_or_else(|| fail("ZCode Personal 文件已被移除，请先启动 ZCode 迁移原配置"))?;
    let value: Value = serde_json::from_slice(raw)
        .map_err(|_| fail("ZCode Personal JSON 无法解析，原文件未修改"))?;
    validate_zcode_personal(&value)?;
    let mut document = JsoncDocument::parse(text(Some(raw))?)?;
    let mut value = value;
    let providers = value["config"]["providerConfigRules"]["providerRules"]
        .as_array()
        .unwrap();
    let rule_group = &value["config"]["modelConfigRules"];
    let mut existing = BTreeMap::new();
    let mut ids = BTreeSet::new();
    for rule in providers
        .iter()
        .chain(rule_group["providerModelRules"].as_array().unwrap())
        .chain(rule_group["manualProviderModelRules"].as_array().unwrap())
    {
        ids.insert(rule["providerId"].as_str().unwrap().to_owned());
    }
    for id in ids {
        let provider = providers.iter().find(|rule| rule["providerId"] == id);
        let smart: Vec<_> = rule_group["providerModelRules"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|rule| rule["providerId"] == id)
            .cloned()
            .collect();
        let manual: Vec<_> = rule_group["manualProviderModelRules"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|rule| rule["providerId"] == id)
            .cloned()
            .collect();
        existing.insert(
            id,
            json!({"provider":provider,"models":smart,"manualModels":manual}),
        );
    }
    let provider_key = zcode_provider_key(&existing, ownership)?;
    let ids = models
        .iter()
        .map(|model| model.id.clone())
        .collect::<Vec<_>>();
    let next_provider = json!({"providerId":provider_key,"providerName":zcode_provider_name(&provider_key),"enabled":true,"config":{
        "group":"standard-personal","access":{"type":"api-key","apiKey":source.api_key},
        "api":{"type":"openai-chat-completions","baseUrl":source.base_url.trim_end_matches('/')},
        "personalModelIds":ids,"modelOrder":ids}});
    let next_models = models
        .iter()
        .map(|model| zcode_model_rule(model, &provider_key))
        .collect::<Vec<_>>();
    let next_owned = json!({"provider":next_provider,"models":next_models,"manualModels":[]});
    let providers = value["config"]["providerConfigRules"]["providerRules"]
        .as_array_mut()
        .unwrap();
    providers.retain(|rule| rule["providerId"] != provider_key);
    providers.push(next_provider);
    for group in ["providerModelRules", "manualProviderModelRules"] {
        value["config"]["modelConfigRules"][group]
            .as_array_mut()
            .unwrap()
            .retain(|rule| rule["providerId"] != provider_key);
    }
    value["config"]["modelConfigRules"]["providerModelRules"]
        .as_array_mut()
        .unwrap()
        .extend(next_models);
    if let Some(order) = value["config"].get_mut("providerOrder") {
        let order = order.as_array_mut().unwrap();
        if !order.iter().any(|id| id == &provider_key) {
            order.push(json!(provider_key));
        }
    }
    let model = models
        .iter()
        .find(|model| model.id == default_route)
        .unwrap();
    let efforts = model
        .reasoning_efforts
        .as_ref()
        .filter(|efforts| !efforts.is_empty());
    let level = efforts
        .and_then(|efforts| {
            ["medium", "high"]
                .into_iter()
                .find(|level| efforts.iter().any(|effort| effort == level))
                .or_else(|| efforts.first().map(String::as_str))
        })
        .unwrap_or("default");
    value["config"]["defaultModelSelection"] = json!({"providerId":provider_key,"modelId":default_route,"options":{"reasoningLevel":level}});
    validate_zcode_personal(&value)?;
    document.apply(&value)?;
    Ok((
        document.validated_source()?.into_bytes(),
        BTreeMap::from([(provider_key, zcode_fingerprint(&next_owned)?)]),
    ))
}

fn workbuddy(
    raw: Option<&[u8]>,
    source: &ChannelSource,
    models: &[ChannelModel],
    ownership: &BTreeMap<String, String>,
) -> Result<(Vec<u8>, BTreeMap<String, String>), AppError> {
    let mut value: Value = match raw {
        Some(raw) => serde_json::from_slice(raw)
            .map_err(|_| fail("WorkBuddy models.json 无法解析，未修改原文件"))?,
        None => json!([]),
    };
    let root_record = value.as_object().is_some_and(|root| {
        !root.is_empty() && !root.contains_key("models") && root.values().all(Value::is_object)
    });
    if root_record {
        return Err(fail(
            "当前 WorkBuddy 不支持顶层模型字典，请先在应用中转换为模型数组",
        ));
    }
    let entries = if value.is_array() {
        &mut value
    } else {
        object(&mut value)?
            .entry("models")
            .or_insert_with(|| json!([]))
    };
    let mut result = BTreeMap::new();
    let next = models.iter().map(|model| {
        let mut entry = json!({"id":model.id,"name":model.name.as_deref().unwrap_or(&model.id),"vendor":"openai","url":format!("{}/chat/completions", source.base_url.trim_end_matches('/')),"apiKey":source.api_key});
        if let Some(context) = model.effective_context_limit() { entry["maxInputTokens"] = json!(context); }
        if let Some(output) = model.output_limit { entry["maxOutputTokens"] = json!(output); }
        entry
    }).collect::<Vec<_>>();
    if let Some(array) = entries.as_array_mut() {
        let mut seen = BTreeSet::new();
        for entry in array.iter() {
            let id = entry["id"]
                .as_str()
                .ok_or_else(|| fail("WorkBuddy 模型条目缺少字符串 id"))?;
            if !seen.insert(id) {
                return Err(fail("WorkBuddy 已有模型 id 重复，未修改"));
            }
            if ownership.contains_key(id) || next.iter().any(|candidate| candidate["id"] == id) {
                owned(Some(entry), id, ownership)?;
            }
        }
        for key in ownership.keys() {
            if !seen.contains(key.as_str()) {
                return Err(AppError::Conflict(
                    "WorkBuddy 自有模型已被移除，请先确认配置".into(),
                ));
            }
        }
        array.retain(|entry| !ownership.contains_key(entry["id"].as_str().unwrap_or_default()));
        for entry in next {
            result.insert(entry["id"].as_str().unwrap().into(), json_digest(&entry)?);
            array.push(entry);
        }
    } else {
        return Err(fail(
            "当前 WorkBuddy 只读取顶层数组或 models 数组，未覆盖其它结构",
        ));
    }
    Ok((json_bytes(&value)?, result))
}

fn yaml(raw: &str) -> Result<serde_yaml::Value, AppError> {
    parse_yaml(raw, "DSH YAML 无法安全解析")
}

fn parse_yaml(raw: &str, phase: &str) -> Result<serde_yaml::Value, AppError> {
    serde_yaml::from_str(raw).map_err(|error| {
        let position = error
            .location()
            .map(|p| format!("（第 {} 行，第 {} 列）", p.line(), p.column()))
            .unwrap_or_default();
        fail(&format!("{phase}{position}，未执行任何标签或修改原配置"))
    })
}
fn yaml_key(line: &str, indent: usize, key: &str) -> bool {
    let without_newline = line.trim_end_matches(['\r', '\n']);
    let start = without_newline.len() - without_newline.trim_start_matches(' ').len();
    start == indent
        && [
            format!("{key}:"),
            format!("\"{key}\":"),
            format!("'{key}':"),
        ]
        .iter()
        .any(|pattern| {
            without_newline[indent..]
                .strip_prefix(pattern)
                .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with([' ', '\t']))
        })
}
fn section_end(lines: &[&str], start: usize, indent: usize, end: usize) -> usize {
    (start + 1..end)
        .find(|index| {
            let line = lines[*index].trim();
            !line.is_empty()
                && !line.starts_with('#')
                && lines[*index].len() - lines[*index].trim_start_matches(' ').len() <= indent
        })
        .unwrap_or(end)
}

fn yaml_flow_block(
    line: &str,
    indent: usize,
    key: &str,
    value: &serde_yaml::Value,
    newline: &str,
) -> Result<Option<String>, AppError> {
    if !yaml_key(line, indent, key) || !value.is_mapping() {
        return Ok(None);
    }
    let line = line.trim_end_matches(['\r', '\n']);
    let prefix = [
        format!("{key}:"),
        format!("\"{key}\":"),
        format!("'{key}':"),
    ]
    .into_iter()
    .find(|prefix| line[indent..].starts_with(prefix))
    .unwrap();
    let offset = indent + prefix.len();
    let text = &line[offset..];
    if !text.trim_start().starts_with('{') {
        return Ok(None);
    }
    let mut quote = None;
    let mut escaped = false;
    let mut chars = text.char_indices().peekable();
    let mut comment = text.len();
    let mut source_operators = false;
    while let Some((index, ch)) = chars.next() {
        if quote == Some('"') && escaped {
            escaped = false;
            continue;
        }
        if quote == Some('"') && ch == '\\' {
            escaped = true;
            continue;
        }
        if quote == Some(ch) {
            if ch == '\'' && chars.peek().is_some_and(|(_, next)| *next == '\'') {
                chars.next();
            } else {
                quote = None;
            }
        } else if quote.is_none() {
            let before = text[..index].chars().next_back();
            let boundary = before.is_none_or(|ch| ch.is_whitespace() || ",:[{".contains(ch));
            if boundary && matches!(ch, '!' | '&' | '*') {
                source_operators = true;
            }
            if (ch == '\'' || ch == '"') && boundary {
                quote = Some(ch);
            }
            if ch == '#' && before.is_none_or(char::is_whitespace) {
                comment = index;
                break;
            }
        }
    }
    if !text[..comment].trim_end().ends_with('}') {
        return Ok(None);
    }
    fn tagged(value: &serde_yaml::Value) -> bool {
        match value {
            serde_yaml::Value::Tagged(_) => true,
            serde_yaml::Value::Mapping(map) => {
                map.iter().any(|(key, value)| tagged(key) || tagged(value))
            }
            serde_yaml::Value::Sequence(seq) => seq.iter().any(tagged),
            _ => false,
        }
    }
    // serde_yaml::Value can discard unknown global tags and resolve aliases.
    // Check raw unquoted operators as well as the parsed tree before encoding.
    // Unrelated tagged plugins remain byte-for-byte intact.
    if source_operators || tagged(value) {
        return Err(fail(
            "DSH 行内映射含标签或锚点引用，已保留原配置；请先在 DSH 转为分行配置",
        ));
    }
    let encoded =
        serde_yaml::to_string(value).map_err(|_| fail("DSH 行内映射无法转换，原配置未修改"))?;
    let comment = if comment < text.len() {
        format!(" {}", &text[comment..])
    } else {
        String::new()
    };
    let body = encoded
        .lines()
        .map(|line| format!("{}{line}{newline}", " ".repeat(indent + 2)))
        .collect::<String>();
    Ok(Some(format!("{}{comment}{newline}{body}", &line[..offset])))
}
fn dsh(
    raw: Option<&[u8]>,
    source: &ChannelSource,
    models: &[ChannelModel],
    ownership: &BTreeMap<String, String>,
) -> Result<(Vec<u8>, BTreeMap<String, String>), AppError> {
    let raw = match raw {
        Some(raw) => text(Some(raw))?,
        None => "",
    };
    let root = if raw.trim().is_empty() {
        serde_yaml::Value::Sequence(Vec::new())
    } else {
        yaml(raw)?
    };
    let sequence = root
        .as_sequence()
        .ok_or_else(|| fail("DSH patch 必须是顶层序列，未覆盖其它格式"))?;
    let matching = sequence
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            item["id"].as_str() == Some("llm-pi-ai")
                || item["name"].as_str() == Some("@deepseek-ai/dsh-llm-pi-ai")
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if matching.len() > 1 {
        return Err(fail("DSH 存在重复 llm-pi-ai 条目，请先在 DSH 合并"));
    }
    let provider_models = models.iter().map(|model| {
        let mut value = json!({"id":model.id,"name":model.name.as_deref().unwrap_or(&model.id),"api":"openai-completions","input":model.input_modalities.clone().unwrap_or_else(|| vec!["text".into()])});
        if let Some(context) = model.effective_context_limit() { value["contextWindow"] = json!(context); }
        if let Some(output) = model.output_limit { value["maxTokens"] = json!(output); }
        if let Some(efforts) = &model.reasoning_efforts { value["reasoningEfforts"] = Value::Object(efforts.iter().map(|effort| (effort.clone(), json!(effort))).collect()); }
        value
    }).collect::<Vec<_>>();
    let next = json!({"displayName":"LoliCode","api":"openai-completions","baseURL":source.base_url.trim_end_matches('/'),"headers":{"Authorization":format!("Bearer {}",source.api_key)},"models":provider_models});
    let next_yaml = serde_yaml::to_string(&next).map_err(|_| fail("无法编码 DSH 提供商"))?;
    let newline = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let provider_block = format!(
        "      lolicode:{newline}{}",
        next_yaml
            .lines()
            .map(|line| format!("        {line}{newline}"))
            .collect::<String>()
    );
    let result = if let Some(index) = matching.first() {
        let item = &sequence[*index];
        let config = &item["config"];
        if !config.is_null() && !config.is_mapping() {
            return Err(fail("DSH 动态 config 无法安全局部修改，已保留原表达式"));
        }
        let providers = &config["providers"];
        if !providers.is_null() && !providers.is_mapping() {
            return Err(fail("DSH 动态 providers 无法安全局部修改，已保留原表达式"));
        }
        if providers
            .as_mapping()
            .is_some_and(|map| map.contains_key(serde_yaml::Value::String("<<".into())))
        {
            return Err(fail("DSH providers 使用 YAML 合并键，需先确认继承关系"));
        }
        let old = if providers["lolicode"].is_null() {
            None
        } else {
            Some(
                serde_json::to_value(&providers["lolicode"])
                    .map_err(|_| fail("DSH 同名提供商包含动态标签，未覆盖"))?,
            )
        };
        owned(old.as_ref(), "lolicode", ownership)?;
        let lines = raw.split_inclusive('\n').collect::<Vec<_>>();
        let starts = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| {
                line.starts_with("- ") || line.trim_end_matches(['\r', '\n']) == "-"
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if starts.len() != sequence.len() {
            return Err(fail("DSH 序列布局无法安全定位，未改写原文件"));
        }
        let start = starts[*index];
        let end = starts.get(*index + 1).copied().unwrap_or(lines.len());
        let configs = (start..end)
            .filter(|line| yaml_key(lines[*line], 2, "config"))
            .collect::<Vec<_>>();
        if configs.len() > 1 {
            return Err(fail("DSH config 存在重复键"));
        }
        let (from, to, insertion) = if let Some(config_line) = configs.first().copied() {
            let config_end = section_end(&lines, config_line, 2, end);
            if let Some(block) = yaml_flow_block(lines[config_line], 2, "config", config, newline)?
            {
                let normalized = format!(
                    "{}{block}{}",
                    lines[..config_line].concat(),
                    lines[config_line + 1..].concat()
                );
                if parse_yaml(&normalized, "DSH 行内配置转换后无法校验")? != root {
                    return Err(fail("DSH 行内配置转换校验失败，原文件未修改"));
                }
                return dsh(Some(normalized.as_bytes()), source, models, ownership);
            }
            let provider_lines = (config_line + 1..config_end)
                .filter(|line| yaml_key(lines[*line], 4, "providers"))
                .collect::<Vec<_>>();
            if provider_lines.len() > 1 {
                return Err(fail("DSH providers 存在重复键"));
            }
            if let Some(provider_line) = provider_lines.first().copied() {
                let provider_end = section_end(&lines, provider_line, 4, config_end);
                if let Some(block) =
                    yaml_flow_block(lines[provider_line], 4, "providers", providers, newline)?
                {
                    let normalized = format!(
                        "{}{block}{}",
                        lines[..provider_line].concat(),
                        lines[provider_line + 1..].concat()
                    );
                    if parse_yaml(&normalized, "DSH 行内提供商转换后无法校验")? != root
                    {
                        return Err(fail("DSH 行内提供商转换校验失败，原文件未修改"));
                    }
                    return dsh(Some(normalized.as_bytes()), source, models, ownership);
                }
                let own_lines = (provider_line + 1..provider_end)
                    .filter(|line| yaml_key(lines[*line], 6, "lolicode"))
                    .collect::<Vec<_>>();
                if old.is_some() && own_lines.len() != 1 {
                    return Err(fail("DSH 自有提供商布局无法安全定位"));
                }
                if let Some(own_line) = own_lines.first().copied() {
                    (
                        own_line,
                        section_end(&lines, own_line, 6, provider_end),
                        provider_block.clone(),
                    )
                } else if providers.is_null()
                    || providers.as_mapping().is_some_and(|map| map.is_empty())
                {
                    (
                        provider_line,
                        provider_end,
                        format!("    providers:{newline}{provider_block}"),
                    )
                } else {
                    (provider_end, provider_end, provider_block.clone())
                }
            } else if config.is_null() || config.as_mapping().is_some_and(|map| map.is_empty()) {
                (
                    config_line,
                    config_end,
                    format!("  config:{newline}    providers:{newline}{provider_block}"),
                )
            } else {
                (
                    config_end,
                    config_end,
                    format!("    providers:{newline}{provider_block}"),
                )
            }
        } else {
            (
                end,
                end,
                format!("  config:{newline}    providers:{newline}{provider_block}"),
            )
        };
        let prefix = lines[..from].concat();
        format!(
            "{prefix}{}{insertion}{}",
            if prefix.is_empty() || prefix.ends_with('\n') {
                ""
            } else {
                newline
            },
            lines[to..].concat()
        )
    } else {
        if !ownership.is_empty() {
            return Err(AppError::Conflict(
                "DSH 已移除自有提供商条目，请先确认配置".into(),
            ));
        }
        format!("{raw}{}- id: llm-pi-ai{newline}  name: '@deepseek-ai/dsh-llm-pi-ai'{newline}  config:{newline}    providers:{newline}{provider_block}", if raw.is_empty() || raw.ends_with('\n') { "" } else { newline })
    };
    let verified = parse_yaml(&result, "DSH 生成配置无法校验")?;
    let mut expected = root;
    let entries = expected.as_sequence_mut().unwrap();
    if let Some(index) = matching.first() {
        let entry = entries[*index]
            .as_mapping_mut()
            .ok_or_else(|| fail("DSH 模型条目不是对象，未修改原文件"))?;
        let config = entry
            .entry(serde_yaml::Value::String("config".into()))
            .or_insert(serde_yaml::Value::Null);
        if config.is_null() {
            *config = serde_yaml::Value::Mapping(Default::default());
        }
        let providers = config
            .as_mapping_mut()
            .ok_or_else(|| fail("DSH config 无法校验，未修改原文件"))?
            .entry(serde_yaml::Value::String("providers".into()))
            .or_insert(serde_yaml::Value::Null);
        if providers.is_null() {
            *providers = serde_yaml::Value::Mapping(Default::default());
        }
        providers
            .as_mapping_mut()
            .ok_or_else(|| fail("DSH providers 无法校验，未修改原文件"))?
            .insert(
                serde_yaml::Value::String("lolicode".into()),
                serde_yaml::to_value(&next).map_err(|_| fail("DSH 模型无法校验"))?,
            );
    } else {
        entries.push(
            serde_yaml::to_value(json!({"id":"llm-pi-ai","name":"@deepseek-ai/dsh-llm-pi-ai","config":{"providers":{"lolicode":next}}}))
                .map_err(|_| fail("DSH 新条目无法校验"))?,
        );
    }
    // Validate the complete tree, including opaque !!js tagged values. A
    // plausible-looking local splice must never remove or alter another key.
    if verified != expected {
        return Err(fail("DSH 写后发现非自有配置变化，未修改原文件"));
    }
    Ok((
        result.into_bytes(),
        BTreeMap::from([("lolicode".into(), json_digest(&next)?)]),
    ))
}

struct Planned {
    path: PathBuf,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}
struct TemporaryFiles(Vec<PathBuf>);
impl Drop for TemporaryFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}
fn apply_inner(
    target: &str,
    source: &ChannelSource,
    default_route: &str,
    locations: &Locations,
    fail_after: Option<usize>,
) -> Result<Outcome, AppError> {
    if !TARGETS.contains(&target) {
        return Err(fail("不支持的外部应用"));
    }
    let models = available(source, default_route)?;
    let configs = paths(target, locations)?;
    let modern_zcode = target == "zcode" && configs.len() == 1;
    let marker = locations
        .home
        .join(".tai-switch/external-model-config")
        .join(format!("{target}.json"));
    let marker_before = read(&marker)?;
    let previous: Ownership = match &marker_before {
        Some(raw) => serde_json::from_slice(raw)
            .map_err(|_| fail("外部配置所有权记录损坏，未覆盖用户配置"))?,
        None => Ownership {
            format: 1,
            target: target.into(),
            ..Default::default()
        },
    };
    if previous.format != 1 || previous.target != target {
        return Err(fail("外部配置所有权记录无效"));
    }
    let mut ownership = Ownership {
        format: 1,
        target: target.into(),
        ..Default::default()
    };
    let mut plans = Vec::new();
    let mut independent_zcode = false;
    for path in &configs {
        let before = read(path)?;
        let key = path.to_string_lossy().into_owned();
        let prior = previous.files.get(&key).cloned().unwrap_or_default();
        let (after, own) = match target {
            "workbuddy" => workbuddy(before.as_deref(), source, &models, &prior)?,
            "deepseek-harness" => dsh(before.as_deref(), source, &models, &prior)?,
            "zcode" if modern_zcode => {
                zcode_personal(before.as_deref(), source, &models, default_route, &prior)?
            }
            "zcode" | "mimocode" => json_config(
                before.as_deref(),
                source,
                &models,
                default_route,
                target == "zcode",
                path.parent()
                    .and_then(Path::file_name)
                    .is_some_and(|name| name == "cli"),
                &prior,
            )?,
            _ => unreachable!(),
        };
        if after.len() as u64 > LIMIT {
            return Err(fail("生成的配置超过容量上限，未修改原文件"));
        }
        independent_zcode |= target == "zcode" && own.keys().any(|key| key != "lolicode");
        ownership.files.insert(key, own);
        if before.as_deref() != Some(after.as_slice()) {
            plans.push(Planned {
                path: path.clone(),
                before,
                after,
            });
        }
    }
    let marker_after = serde_json::to_vec_pretty(&ownership)
        .map_err(|source| AppError::JsonSerialize { source })?;
    if marker_before.as_deref() != Some(marker_after.as_slice()) {
        plans.push(Planned {
            path: marker,
            before: marker_before,
            after: marker_after,
        });
    }
    let mut backups = Vec::new();
    let batch = Uuid::new_v4();
    let mut staged = Vec::new();
    let mut temporaries = TemporaryFiles(Vec::new());
    for plan in &plans {
        if let Some(before) = &plan.before {
            let backup = plan.path.with_file_name(format!(
                "{}.lolicode-backup-{batch}",
                plan.path.file_name().unwrap().to_string_lossy()
            ));
            if fs::symlink_metadata(&backup).is_ok() {
                return Err(fail("备份路径碰撞，未覆盖现有文件"));
            }
            atomic_write_private(&backup, before)?;
            backups.push(backup.to_string_lossy().into_owned());
        }
        match stage_write(&plan.path, &plan.after, Some(0o600), true) {
            Ok(stage) => {
                temporaries.0.push(stage.tmp_path().into());
                staged.push(stage);
            }
            Err(error) => {
                for stage in staged {
                    let _ = fs::remove_file(stage.tmp_path());
                }
                return Err(error);
            }
        }
    }
    for plan in &plans {
        if read(&plan.path)? != plan.before {
            for stage in &staged {
                let _ = fs::remove_file(stage.tmp_path());
            }
            return Err(AppError::Conflict(
                "外部应用在配置期间修改了文件，请重试".into(),
            ));
        }
    }
    let mut committed = 0;
    let mut failure = None;
    for (index, stage) in staged.into_iter().enumerate() {
        if failure.is_some() {
            let _ = fs::remove_file(stage.tmp_path());
            continue;
        }
        let result = if fail_after == Some(index) {
            let _ = fs::remove_file(stage.tmp_path());
            Err(fail("测试注入：提交失败"))
        } else {
            stage.commit()
        };
        match result {
            Ok(()) => committed += 1,
            Err(error) => failure = Some(error),
        }
    }
    if let Some(error) = failure {
        let mut uncertain = false;
        for plan in plans.iter().take(committed).rev() {
            if read(&plan.path).ok().flatten().as_deref() != Some(plan.after.as_slice()) {
                uncertain = true;
                continue;
            }
            let restored = match &plan.before {
                Some(before) => atomic_write_private(&plan.path, before),
                None => {
                    fs::remove_file(&plan.path).map_err(|error| AppError::io(&plan.path, error))
                }
            };
            uncertain |= restored.is_err();
        }
        return if uncertain {
            Err(fail(
                "配置未完成且回滚状态不确定，请通过保留的私有备份恢复；未覆盖同时发生的用户修改",
            ))
        } else {
            Err(error)
        };
    }
    Ok(Outcome {
        files: configs
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        backups,
        message: if independent_zcode {
            "已使用独立的 LoliCode 托管提供商，保留原有同名或已修改配置；请重新打开目标应用或新建会话。"
        } else if target == "workbuddy" || target == "deepseek-harness" {
            "已添加 LoliCode 模型；请在目标应用中选择模型，现有会话保持原选择。"
        } else {
            "已添加 LoliCode 模型并设置默认模型；请重新打开目标应用或新建会话。"
        }
        .into(),
    })
}

#[cfg(test)]
#[path = "external_agent_config_tests.rs"]
mod tests;
