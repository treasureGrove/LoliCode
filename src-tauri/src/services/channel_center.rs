//! One channel catalog, projected through each application's existing config writer.
//! Discovery reads model catalogs only; it never performs a generation request.

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;
use crate::provider::{Provider, ProviderMeta};
use crate::store::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};

const SETTINGS_KEY: &str = "channel_center";
const TOKEN_KEY: &str = "channel_center_gateway_token";
const APPLIED_KEY: &str = "channel_center_applied";
const BACKGROUND_KEY: &str = "channel_center_requires_background";
const TARGETS: [&str; 15] = [
    "claude",
    "claude-desktop",
    "codex",
    "gemini",
    "grokbuild",
    "opencode",
    "hermes",
    "openclaw",
    "pi",
    "mcode",
    "workbuddy",
    "deepseek-harness",
    "zcode",
    "mimocode",
    "codebuddy",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limits: Option<Vec<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_context_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_efforts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort_transport: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_tools: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

impl ChannelModel {
    pub fn effective_context_limit(&self) -> Option<u64> {
        self.selected_context_limit
            .filter(|selected| {
                self.context_limits
                    .as_ref()
                    .is_some_and(|windows| windows.contains(selected))
            })
            .or(self.context_limit)
    }

    pub fn available(&self) -> bool {
        self.enabled != Some(false) && self.supports_tools != Some(false)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSource {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub auth_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub protocol: String,
    #[serde(default)]
    pub models: Vec<ChannelModel>,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
}

fn enabled_default() -> bool {
    true
}
fn default_targets() -> Vec<String> {
    ["opencode", "hermes", "openclaw"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelCenterSnapshot {
    #[serde(default)]
    pub channels: Vec<ChannelSource>,
    #[serde(default = "default_targets")]
    pub targets: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default)]
    pub revision: u64,
}

impl Default for ChannelCenterSnapshot {
    fn default() -> Self {
        Self {
            channels: Vec::new(),
            targets: default_targets(),
            default_model: None,
            revision: 0,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelApplyResult {
    pub app: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelApplyReport {
    pub results: Vec<ChannelApplyResult>,
    pub requires_background: bool,
}

/// Safe model references for the desktop renderer and the future CLI.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalogModel {
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    pub channel_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limits: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_efforts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort_transport: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalog {
    pub revision: u64,
    pub models: Vec<AgentCatalogModel>,
    pub default_model: Option<String>,
    pub excluded_sources: Vec<String>,
}

/// The engine-owned config contains a local gateway credential. Do not serialize
/// or log this wrapper, or return it from a renderer-facing command.
#[cfg(any(test, feature = "test-hooks"))]
pub struct PreparedAgentCatalog {
    pub catalog: AgentCatalog,
    pub config: Value,
}

/// Host-local binding shared by native execution; never serialize credentials.
pub struct AgentGatewayBinding {
    pub catalog: AgentCatalog,
    pub base_url: String,
    pub bearer_token: String,
}

fn catalog_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_stored(db: &Database) -> Result<Option<ChannelCenterSnapshot>, AppError> {
    db.get_setting(SETTINGS_KEY)?
        .map(|raw| {
            serde_json::from_str(&raw)
                .map_err(|_| AppError::Config("渠道中心数据无法解析，原数据已保留".into()))
        })
        .transpose()
}

/// Preserve universal_providers; migration writes a separate, reversible snapshot.
pub fn load(db: &Database) -> Result<ChannelCenterSnapshot, AppError> {
    let _guard = catalog_lock().lock()?;
    if let Some(snapshot) = read_stored(db)? {
        return Ok(snapshot);
    }
    let mut legacy: Vec<_> = db.get_all_universal_providers()?.into_values().collect();
    legacy.sort_by(|a, b| a.sort_index.cmp(&b.sort_index).then(a.id.cmp(&b.id)));
    let mut snapshot = ChannelCenterSnapshot::default();
    for provider in legacy {
        let mut ids = Vec::new();
        if let Some(m) = &provider.models.claude {
            ids.extend(
                [
                    m.model.as_ref(),
                    m.haiku_model.as_ref(),
                    m.sonnet_model.as_ref(),
                    m.opus_model.as_ref(),
                ]
                .into_iter()
                .flatten()
                .cloned(),
            );
        }
        if let Some(m) = &provider.models.codex {
            ids.extend(m.model.clone());
        }
        if let Some(m) = &provider.models.gemini {
            ids.extend(m.model.clone());
        }
        let mut seen = HashSet::new();
        let models = ids
            .into_iter()
            .filter(|id| !id.trim().is_empty() && seen.insert(id.clone()))
            .map(blank_model)
            .collect();
        let mut channel = ChannelSource {
            id: if valid_id(&provider.id) {
                provider.id
            } else {
                uuid::Uuid::new_v4().to_string()
            },
            name: provider.name,
            base_url: provider.base_url,
            api_key: provider.api_key,
            auth_kind: "api_key".into(),
            account_id: None,
            protocol: provider
                .meta
                .and_then(|m| m.api_format)
                .filter(|p| valid_protocol(p))
                .unwrap_or_else(|| "openai_chat".into()),
            models,
            enabled: true,
        };
        let mut recognized = channel.clone();
        if recognize_endpoint(&mut recognized).is_ok() {
            channel = recognized;
        }
        exclude_known_non_agent_models(&mut channel);
        snapshot.channels.push(channel);
    }
    db.set_setting(SETTINGS_KEY, &serialize(&snapshot)?)?;
    Ok(snapshot)
}

pub fn save(db: &Database, mut snapshot: ChannelCenterSnapshot) -> Result<(), AppError> {
    for channel in &mut snapshot.channels {
        if channel.auth_kind != "api_key" {
            channel.account_id = channel
                .account_id
                .as_deref()
                .map(str::trim)
                .map(str::to_string);
        }
        if let Some((base, protocol)) = managed_subscription_route(&channel.auth_kind) {
            channel.base_url = base.into();
            channel.protocol = protocol.into();
            for model in &mut channel.models {
                model.protocol = Some(protocol.into());
            }
        }
        exclude_known_non_agent_models(channel);
    }
    validate(&snapshot)?;
    for channel in &mut snapshot.channels {
        if channel.auth_kind != "api_key" {
            channel.api_key.clear();
        }
    }
    let _guard = catalog_lock().lock()?;
    let revision = read_stored(db)?.map_or(0, |s| s.revision);
    if snapshot.revision != revision {
        return Err(AppError::Conflict(
            "渠道列表已被另一处修改。请重新加载后再保存；你的编辑尚未覆盖现有配置".into(),
        ));
    }
    snapshot.revision = revision
        .checked_add(1)
        .ok_or_else(|| AppError::Config("渠道版本号已超出范围".into()))?;
    let mut targets = HashSet::new();
    snapshot
        .targets
        .retain(|target| targets.insert(target.clone()));
    db.set_setting(SETTINGS_KEY, &serialize(&snapshot)?)
}

fn serialize<T: Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value).map_err(|source| AppError::JsonSerialize { source })
}

/// Requests use this committed snapshot, never an unsaved or unapplied editor draft.
pub fn load_applied(db: &Database) -> Result<ChannelCenterSnapshot, AppError> {
    db.get_setting(APPLIED_KEY)?
        .map(|raw| {
            serde_json::from_str(&raw)
                .map_err(|_| AppError::Config("已应用渠道数据无法解析，原数据已保留".into()))
        })
        .transpose()
        .map(|snapshot| snapshot.unwrap_or_default())
}

/// Client URLs pin an immutable revision so failures in one client cannot change another's routes.
pub fn load_catalog(db: &Database, revision: u64) -> Result<ChannelCenterSnapshot, AppError> {
    let raw = db
        .get_setting(&format!("channel_center_catalog_{revision}"))?
        .ok_or_else(|| {
            AppError::InvalidInput("此客户端引用的渠道目录不存在，请重新应用配置".into())
        })?;
    serde_json::from_str(&raw)
        .map_err(|_| AppError::Config("已应用渠道版本无法解析，原数据已保留".into()))
}

fn publish_catalog(db: &Database, snapshot: &ChannelCenterSnapshot) -> Result<(), AppError> {
    let _guard = catalog_lock().lock()?;
    let key = format!("channel_center_catalog_{}", snapshot.revision);
    let raw = serialize(snapshot)?;
    if let Some(existing) = db.get_setting(&key)? {
        if existing != raw {
            return Err(AppError::Conflict(
                "此渠道版本已经应用且内容不同，请重新保存以创建新版本".into(),
            ));
        }
        return Ok(());
    }
    db.set_setting(&key, &raw)
}

/// Versioned client files may be written even if the final applied marker failed.
pub async fn restore_gateway(state: &AppState) -> Result<(), String> {
    if state
        .db
        .get_bool_flag(BACKGROUND_KEY)
        .map_err(|e| e.to_string())?
    {
        state.proxy_service.start().await?;
    }
    Ok(())
}

pub fn gateway_token(db: &Database) -> Result<String, AppError> {
    let _guard = catalog_lock().lock()?;
    if let Some(token) = db.get_setting(TOKEN_KEY)? {
        if !token.trim().is_empty() {
            return Ok(token);
        }
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    db.set_setting(TOKEN_KEY, &token)?;
    Ok(token)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
fn valid_protocol(protocol: &str) -> bool {
    matches!(
        protocol,
        "openai_chat" | "openai_responses" | "anthropic" | "gemini_native"
    )
}
fn validate_channel(channel: &ChannelSource) -> Result<(), AppError> {
    if !valid_id(&channel.id) || channel.name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "请填写渠道名称，并使用字母、数字或短横线作为渠道标识".into(),
        ));
    }
    if !matches!(
        channel.auth_kind.as_str(),
        "api_key"
            | "github_copilot"
            | "zhipu_oauth"
            | "codex_oauth"
            | "xai_oauth"
            | "claude_subscription"
            | "gemini_subscription"
            | "lolicode_account"
    ) || !valid_protocol(&channel.protocol)
    {
        return Err(AppError::InvalidInput(
            "请选择支持的渠道认证方式与 API 格式".into(),
        ));
    }
    if channel.auth_kind != "api_key"
        && channel
            .account_id
            .as_deref()
            .is_none_or(|id| id.trim().is_empty())
    {
        return Err(AppError::InvalidInput(
            "登录渠道必须绑定明确账户，请先完成账户授权".into(),
        ));
    }
    if channel.auth_kind == "lolicode_account"
        && (channel.id != super::lolicode_relay::CHANNEL_ID
            || channel.base_url != super::lolicode_relay::BASE_URL
            || channel.protocol != "openai_chat"
            || channel.models.iter().any(|model| model.protocol.as_deref().is_some_and(|p| p != "openai_chat")))
    {
        return Err(AppError::InvalidInput("公益模型必须使用固定的 LoliCode 服务地址。".into()));
    }
    if native_auth_target(&channel.auth_kind).is_some()
        && (channel.account_id.as_deref() != Some("native") || !channel.base_url.is_empty())
    {
        return Err(AppError::InvalidInput(
            "原生订阅只能引用本机官方工具登录，不能设置自定义 API 地址".into(),
        ));
    }
    if !channel.base_url.trim().is_empty() {
        validated_url(&channel.base_url)?;
    }
    let mut ids = HashSet::new();
    for model in &channel.models {
        if model.id.trim().is_empty()
            || model.id.chars().any(char::is_control)
            || !ids.insert(&model.id)
        {
            return Err(AppError::InvalidInput(
                "模型标识不能为空、重复或含控制字符".into(),
            ));
        }
        if model
            .protocol
            .as_deref()
            .is_some_and(|p| !valid_protocol(p))
        {
            return Err(AppError::InvalidInput("模型使用了不支持的 API 格式".into()));
        }
        if model.context_limits.as_ref().is_some_and(|windows| {
            windows.is_empty()
                || windows.len() > 128
                || windows
                    .iter()
                    .any(|value| *value == 0 || *value > 9_007_199_254_740_991)
                || windows.iter().collect::<HashSet<_>>().len() != windows.len()
        }) || model.selected_context_limit.is_some_and(|selected| {
            !model
                .context_limits
                .as_ref()
                .is_some_and(|windows| windows.contains(&selected))
        }) {
            return Err(AppError::InvalidInput(
                "上下文窗口档位无效，请选择渠道提供的窗口".into(),
            ));
        }
        if model.context_limit == Some(0) || model.output_limit == Some(0) {
            return Err(AppError::InvalidInput(
                "模型上下文和输出上限需要填写正整数，未知时请留空".into(),
            ));
        }
    }
    Ok(())
}
fn validate(snapshot: &ChannelCenterSnapshot) -> Result<(), AppError> {
    let mut ids = HashSet::new();
    for channel in &snapshot.channels {
        validate_channel(channel)?;
        if !ids.insert(&channel.id) {
            return Err(AppError::InvalidInput(
                "渠道标识重复，请为每家使用不同标识".into(),
            ));
        }
    }
    for target in &snapshot.targets {
        if !TARGETS.contains(&target.as_str()) {
            return Err(AppError::InvalidInput("存在不支持的客户端".into()));
        }
    }
    if let Some(default) = &snapshot.default_model {
        if !snapshot.channels.iter().any(|source| {
            source.enabled
                && source
                    .models
                    .iter()
                    .any(|model| model.available() && route_id(source, model) == *default)
        }) {
            return Err(AppError::InvalidInput(
                "默认模型已移除、关闭或不支持工具，请重新选择".into(),
            ));
        }
    }
    Ok(())
}
fn validated_url(raw: &str) -> Result<url::Url, AppError> {
    let url = url::Url::parse(raw.trim())
        .map_err(|_| AppError::InvalidInput("请填写完整 API 地址（包含 https://）".into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::InvalidInput(
            "API 地址必须是 HTTP(S)，且不能夹带密码、查询凭据或片段".into(),
        ));
    }
    Ok(url)
}
pub fn route_id(channel: &ChannelSource, model: &ChannelModel) -> String {
    format!("{}/{}", channel.id, model.id)
}
pub fn claude_route_id(channel: &ChannelSource, model: &ChannelModel) -> String {
    claude_code_gateway_alias(&route_id(channel, model))
}

pub fn claude_route_matches(
    channel: &ChannelSource,
    model: &ChannelModel,
    published: &str,
) -> bool {
    let published = published
        .strip_suffix("[1M]")
        .or_else(|| published.strip_suffix("[1m]"))
        .unwrap_or(published);
    published == claude_route_id(channel, model)
        || published == claude_desktop_gateway_alias(&route_id(channel, model))
        || published == claude_gateway_alias(&route_id(channel, model))
}
fn blank_model(id: String) -> ChannelModel {
    ChannelModel {
        id,
        name: None,
        context_limit: None,
        context_limits: None,
        selected_context_limit: None,
        output_limit: None,
        reasoning_efforts: None,
        reasoning_effort_source: None,
        reasoning_effort_transport: None,
        supports_tools: None,
        input_modalities: None,
        protocol: None,
        enabled: None,
    }
}

pub async fn discover_api_models(mut channel: ChannelSource) -> Result<ChannelSource, AppError> {
    validate_channel(&channel)?;
    if channel.auth_kind != "api_key" {
        return Err(AppError::InvalidInput(
            "此渠道需要使用已登录的 Copilot 账户查询模型".into(),
        ));
    }
    validated_url(&channel.base_url)?;
    recognize_endpoint(&mut channel)?;
    if channel.api_key.trim().is_empty() {
        return Err(AppError::InvalidInput("请先填写 API Key".into()));
    }
    let mut discovered = if channel.protocol == "gemini_native" {
        discover_gemini_models(&channel).await?
    } else {
        let mut headers = BTreeMap::new();
        let api = catalog_auth_format(&channel)?;
        if api == "anthropic-messages" {
            headers.insert("anthropic-version".into(), "2023-06-01".into());
        }
        let initial = crate::services::model_fetch::fetch_model_catalog(
            &channel.base_url,
            &channel.api_key,
            false,
            None,
            None,
            Some(api),
            Some(&headers),
        )
        .await;
        let (raw, fallback) = match initial {
            Ok(raw) => (raw, false),
            Err(error) if error.contains("All candidates failed") => {
                let Some(url) = known_catalog_fallback(&channel.base_url)? else {
                    return Err(discovery_error(&error));
                };
                // The alternate directory is on the same known host. It does not change the
                // inference endpoint, plan, model transport or credentials sent to clients.
                let raw = crate::services::model_fetch::fetch_model_catalog(
                    &channel.base_url,
                    &channel.api_key,
                    false,
                    Some(&url),
                    None,
                    Some("openai-completions"),
                    None,
                )
                .await
                .map_err(|error| discovery_error(&error))?;
                (raw, true)
            }
            Err(error) => return Err(discovery_error(&error)),
        };
        let mut parsed = parse_channel_catalog(&raw)?;
        if fallback {
            for model in &mut parsed {
                model.protocol = None;
            }
        }
        parsed
    };
    super::litellm_capabilities::enrich(&channel, &mut discovered).await;
    channel.models = merge_discovered(&channel.models, discovered);
    exclude_known_non_agent_models(&mut channel);
    Ok(channel)
}

fn discovery_error(raw: &str) -> AppError {
    let message = if raw.contains("401") || raw.contains("403") {
        "无法读取模型列表，请检查 Key 权限或账户授权"
    } else if raw.contains("404") || raw.contains("405") || raw.contains("All candidates failed") {
        "此地址没有开放模型目录，请检查 API 地址，或手动添加模型"
    } else if raw.contains("timeout") || raw.contains("timed out") {
        "读取模型列表超时，请检查网络后重试"
    } else if raw.contains("parse") {
        "此上游的模型目录格式暂不支持，请手动添加模型"
    } else {
        "无法读取模型列表，请检查网络、API 地址与认证方式"
    };
    AppError::Message(message.into())
}

fn merge_discovered(existing: &[ChannelModel], discovered: Vec<ChannelModel>) -> Vec<ChannelModel> {
    let mut unique = BTreeMap::new();
    for mut model in discovered {
        if let Some(saved) = existing.iter().find(|saved| saved.id == model.id) {
            model.name = model.name.or_else(|| saved.name.clone());
            model.context_limit = model.context_limit.or(saved.context_limit);
            model.context_limits = model
                .context_limits
                .or_else(|| saved.context_limits.clone());
            model.selected_context_limit = saved.selected_context_limit.filter(|selected| {
                model
                    .context_limits
                    .as_ref()
                    .is_some_and(|windows| windows.contains(selected))
            });
            model.output_limit = model.output_limit.or(saved.output_limit);
            // Keep capability provenance attached to the exact enum it describes.
            // Saved values without provenance can be user-provided; a registry
            // suggestion must not silently overwrite that explicit choice.
            // Successful auxiliary refreshes mark unknown routes with transport;
            // failed requests leave it absent and retain cached capabilities.
            let stale_inference = model.reasoning_efforts.is_none()
                && model.reasoning_effort_transport.is_some()
                && matches!(
                    saved.reasoning_effort_source.as_deref(),
                    Some(super::litellm_capabilities::REGISTRY_SOURCE | "litellm:model-info")
                );
            let saved_enum_wins = saved.reasoning_efforts.is_some()
                && ((model.reasoning_efforts.is_none() && !stale_inference)
                    || (saved.reasoning_effort_source.is_none()
                        && model.reasoning_effort_source.as_deref()
                            == Some(super::litellm_capabilities::REGISTRY_SOURCE)));
            if saved_enum_wins {
                model.reasoning_efforts = saved.reasoning_efforts.clone();
                model.reasoning_effort_source = saved.reasoning_effort_source.clone();
                model.reasoning_effort_transport = saved.reasoning_effort_transport.clone();
            }
            model.supports_tools = model.supports_tools.or(saved.supports_tools);
            model.input_modalities = model
                .input_modalities
                .or_else(|| saved.input_modalities.clone());
            model.protocol = model.protocol.or_else(|| saved.protocol.clone());
            model.enabled = if model.supports_tools == Some(false) {
                Some(false)
            } else {
                saved.enabled.or(model.enabled)
            };
        }
        unique.insert(model.id.clone(), model);
    }
    unique.into_values().collect()
}

fn recognize_endpoint(channel: &mut ChannelSource) -> Result<(), AppError> {
    let url = validated_url(&channel.base_url)?;
    let base = channel.base_url.trim().trim_end_matches('/').to_string();
    let explicit = [
        ("/chat/completions", "openai_chat"),
        ("/responses", "openai_responses"),
        ("/messages", "anthropic"),
    ]
    .into_iter()
    .find(|(suffix, _)| base.ends_with(suffix));
    if let Some((suffix, protocol)) = explicit {
        channel.base_url = base.trim_end_matches(suffix).to_string();
        channel.protocol = protocol.into();
    } else {
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        let path = url.path().trim_end_matches('/');
        let known_anthropic = match host.as_str() {
            "api.deepseek.com" | "api.moonshot.cn" | "api.moonshot.ai" => path == "/anthropic",
            "open.bigmodel.cn" | "api.z.ai" => path == "/api/anthropic",
            _ => false,
        };
        if known_anthropic {
            channel.protocol = "anthropic".into();
            return Ok(());
        }
        channel.protocol = match url
            .host_str()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "api.anthropic.com" => "anthropic".into(),
            "generativelanguage.googleapis.com" => "gemini_native".into(),
            "api.deepseek.com" | "api.moonshot.cn" | "api.moonshot.ai"
                if !url.path().ends_with("/anthropic") =>
            {
                "openai_chat".into()
            }
            "api.openai.com" => "openai_responses".into(),
            "open.bigmodel.cn" | "api.z.ai"
                if url.path().trim_end_matches('/').ends_with("/api/v1") =>
            {
                "openai_responses".into()
            }
            _ => channel.protocol.clone(),
        };
    }
    Ok(())
}

fn known_catalog_fallback(raw: &str) -> Result<Option<String>, AppError> {
    let url = validated_url(raw)?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if matches!(host.as_str(), "open.bigmodel.cn" | "api.z.ai")
        && matches!(
            url.path().trim_end_matches('/'),
            "/api/coding/paas/v4" | "/api/anthropic"
        )
    {
        let mut catalog = url.clone();
        catalog.set_path("/api/v1/models");
        return Ok(Some(catalog.to_string()));
    }
    Ok(None)
}

fn catalog_auth_format(channel: &ChannelSource) -> Result<&'static str, AppError> {
    let url = validated_url(&channel.base_url)?;
    let openai_directory = matches!(
        url.host_str()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "api.deepseek.com"
            | "api.moonshot.cn"
            | "api.moonshot.ai"
            | "open.bigmodel.cn"
            | "api.z.ai"
    );
    Ok(if channel.protocol == "anthropic" && !openai_directory {
        "anthropic-messages"
    } else {
        "openai-completions"
    })
}

fn catalog_u64(entry: &Value, pointers: &[&str]) -> Option<u64> {
    pointers.iter().find_map(|pointer| {
        entry
            .pointer(pointer)
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
    })
}
fn catalog_protocol(entry: &Value) -> Option<String> {
    for key in ["protocol", "api_format", "apiFormat", "api", "wire_api"] {
        if let Some(value) = entry.get(key).and_then(Value::as_str) {
            let protocol = match value {
                "openai-completions" | "chat" | "chat_completions" => "openai_chat",
                "openai-responses" | "responses" | "codex_responses" => "openai_responses",
                "anthropic-messages" | "anthropic_messages" => "anthropic",
                "google-generative-ai" => "gemini_native",
                other => other,
            };
            if valid_protocol(protocol) {
                return Some(protocol.into());
            }
        }
    }
    let endpoints = entry.get("supported_endpoints").and_then(Value::as_array)?;
    for (endpoint, protocol) in [
        ("/responses", "openai_responses"),
        ("/chat/completions", "openai_chat"),
        ("/messages", "anthropic"),
    ] {
        if endpoints.iter().any(|value| {
            value
                .as_str()
                .is_some_and(|value| value.ends_with(endpoint))
        }) {
            return Some(protocol.into());
        }
    }
    None
}
fn parse_channel_catalog(raw: &Value) -> Result<Vec<ChannelModel>, AppError> {
    let openai_data = raw.get("data").and_then(Value::as_array).is_some();
    let entries = raw
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| raw.get("models").and_then(Value::as_array))
        .ok_or_else(|| discovery_error("parse"))?;
    let mut models = Vec::new();
    for entry in entries {
        let fields = if openai_data {
            ["id", "slug"]
        } else {
            ["slug", "id"]
        };
        let Some(id) = fields.into_iter().find_map(|key| {
            entry
                .get(key)
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
        }) else {
            continue;
        };
        let mut model = blank_model(id.into());
        model.name = ["display_name", "displayName", "name"]
            .into_iter()
            .find_map(|key| entry.get(key).and_then(Value::as_str).map(str::to_string));
        model.context_limit = catalog_u64(
            entry,
            &[
                "/context_window",
                "/contextWindow",
                "/context_length",
                "/max_context_tokens",
                "/inputTokenLimit",
                "/input_token_limit",
                "/capabilities/limits/max_prompt_tokens",
                "/capabilities/limits/max_context_window_tokens",
                "/limit/context",
            ],
        );
        model.output_limit = catalog_u64(
            entry,
            &[
                "/max_output_tokens",
                "/max_tokens",
                "/maxTokens",
                "/outputTokenLimit",
                "/output_token_limit",
                "/capabilities/limits/max_output_tokens",
                "/limit/output",
            ],
        );
        let metadata = crate::services::model_fetch::declared_model_metadata(entry);
        model.context_limit = metadata.context_limit.or(model.context_limit);
        model.context_limits = metadata.context_limits;
        model.output_limit = metadata.output_limit.or(model.output_limit);
        model.reasoning_efforts = metadata.reasoning_efforts;
        if model.reasoning_efforts.is_some() {
            model.reasoning_effort_source = Some("relay:model-directory".into());
            model.reasoning_effort_transport = Some("declared".into());
        }
        model.supports_tools = [
            "/supports_tools",
            "/supportsTools",
            "/tool_call",
            "/supports_tool_calls",
            "/capabilities/supports/tool_calls",
            "/capabilities/supports/tools",
            "/capabilities/tools",
        ]
        .into_iter()
        .find_map(|pointer| entry.pointer(pointer).and_then(Value::as_bool));
        model.input_modalities = [
            "/input_modalities",
            "/inputModalities",
            "/modalities/input",
            "/capabilities/input",
        ]
        .into_iter()
        .find_map(|pointer| {
            entry
                .pointer(pointer)
                .and_then(Value::as_array)
                .and_then(|values| {
                    values
                        .iter()
                        .map(|value| value.as_str().map(str::to_string))
                        .collect::<Option<Vec<_>>>()
                })
        });
        model.protocol = catalog_protocol(entry);
        if model.supports_tools == Some(false) || declares_non_agent_task(entry) {
            model.supports_tools = Some(false);
            model.enabled = Some(false);
        }
        models.push(model);
    }
    Ok(models)
}

fn declares_non_agent_task(entry: &Value) -> bool {
    let non_agent_task = [
        "/task_type",
        "/taskType",
        "/type",
        "/task",
        "/capabilities/task_type",
        "/capabilities/type",
    ]
    .into_iter()
    .filter_map(|pointer| entry.pointer(pointer).and_then(Value::as_str))
    .map(|task| task.to_ascii_lowercase().replace('_', "-"))
    .any(|task| {
        matches!(
            task.as_str(),
            "embedding"
                | "embeddings"
                | "text-embedding"
                | "rerank"
                | "reranker"
                | "re-ranking"
                | "text-to-speech"
                | "speech-to-text"
                | "speech-recognition"
                | "transcription"
                | "audio-transcription"
                | "image-generation"
                | "text-to-image"
                | "image-to-image"
                | "video-generation"
                | "text-to-video"
                | "moderation"
                | "content-moderation"
                | "classification"
        )
    });
    if non_agent_task {
        return true;
    }
    if entry
        .pointer("/capabilities/text_generation")
        .and_then(Value::as_bool)
        == Some(false)
        || entry
            .pointer("/capabilities/textGeneration")
            .and_then(Value::as_bool)
            == Some(false)
    {
        return true;
    }
    [
        "/output_modalities",
        "/outputModalities",
        "/modalities/output",
        "/architecture/output_modalities",
        "/capabilities/output",
    ]
    .into_iter()
    .filter_map(|pointer| entry.pointer(pointer).and_then(Value::as_array))
    .any(|outputs| {
        !outputs.is_empty()
            && outputs.iter().all(|output| {
                output.as_str().is_some_and(|output| {
                    matches!(
                        output,
                        "image" | "audio" | "video" | "embedding" | "embeddings"
                    )
                })
            })
    })
}

fn exclude_known_non_agent_models(channel: &mut ChannelSource) {
    // Exact IDs only, scoped to the actual official host. Unknown deployments and
    // future suffixes remain unverified rather than inheriting guessed capabilities.
    // Confirmed 2026-10-14 against https://developers.openai.com/api/docs/models/all,
    // /models/gpt-image-2, /models/gpt-4o-mini-tts and /models/gpt-4o-transcribe.
    const OPENAI_NON_AGENT_IDS: &[&str] = &[
        "text-embedding-ada-002",
        "text-embedding-3-small",
        "text-embedding-3-large",
        "omni-moderation-latest",
        "omni-moderation-2024-09-26",
        "text-moderation-latest",
        "text-moderation-stable",
        "text-moderation-007",
        "dall-e-2",
        "dall-e-3",
        "gpt-image-1",
        "gpt-image-1-mini",
        "gpt-image-1.5",
        "chatgpt-image-latest",
        "gpt-image-2",
        "gpt-image-2-2026-04-21",
        "sora-2",
        "sora-2-pro",
        "whisper-1",
        "tts-1",
        "tts-1-hd",
        "tts-1-1106",
        "tts-1-hd-1106",
        "gpt-4o-mini-tts",
        "gpt-4o-mini-tts-2025-03-20",
        "gpt-4o-mini-tts-2025-12-15",
        "gpt-4o-transcribe",
        "gpt-4o-mini-transcribe",
        "gpt-4o-transcribe-diarize",
        "gpt-transcribe",
        "gpt-live-transcribe",
        "gpt-realtime-whisper",
    ];
    let official = url::Url::parse(&channel.base_url)
        .ok()
        .and_then(|url| {
            url.host_str()
                .map(|host| host.eq_ignore_ascii_case("api.openai.com"))
        })
        .unwrap_or(false);
    for model in &mut channel.models {
        if model.supports_tools == Some(false)
            || (official && OPENAI_NON_AGENT_IDS.contains(&model.id.as_str()))
        {
            model.supports_tools = Some(false);
            model.enabled = Some(false);
        }
    }
}

pub fn merge_copilot_models(
    mut channel: ChannelSource,
    models: Vec<crate::proxy::providers::copilot_auth::CopilotModel>,
) -> ChannelSource {
    let discovered = models
        .into_iter()
        .map(|model| {
            let protocol = if model
                .supported_endpoints
                .iter()
                .any(|p| p.ends_with("/responses"))
            {
                Some("openai_responses".into())
            } else if model
                .supported_endpoints
                .iter()
                .any(|p| p.ends_with("/chat/completions"))
            {
                Some("openai_chat".into())
            } else if model
                .supported_endpoints
                .iter()
                .any(|p| p.ends_with("/messages"))
            {
                Some("anthropic".into())
            } else {
                None
            };
            ChannelModel {
                id: model.id,
                name: Some(model.name),
                context_limit: model.context_window.or_else(|| {
                    model
                        .context_windows
                        .as_ref()
                        .and_then(|windows| windows.first().copied())
                }),
                context_limits: model.context_windows,
                selected_context_limit: None,
                output_limit: model.output_limit,
                reasoning_efforts: model.reasoning_effort.map(|efforts| {
                    efforts
                        .into_iter()
                        .filter_map(|effort| {
                            serde_json::to_value(effort)
                                .ok()?
                                .as_str()
                                .map(str::to_string)
                        })
                        .collect()
                }),
                reasoning_effort_source: None,
                reasoning_effort_transport: None,
                // Lack of parallel calls does not mean lack of ordinary tool calls.
                supports_tools: if model.supports_parallel_tool_calls == Some(true) {
                    Some(true)
                } else {
                    None
                },
                input_modalities: None,
                protocol,
                enabled: None,
            }
        })
        .collect();
    channel.models = merge_discovered(&channel.models, discovered);
    channel.api_key.clear();
    channel
}

/// Preserve user identity and selection while refreshing managed account capabilities.
pub(crate) fn managed_subscription_route(auth_kind: &str) -> Option<(&'static str, &'static str)> {
    match auth_kind {
        "codex_oauth" => Some((
            crate::proxy::providers::CHATGPT_CODEX_BASE_URL,
            "openai_responses",
        )),
        "xai_oauth" => Some((
            crate::proxy::providers::XAI_API_BASE_URL,
            "openai_responses",
        )),
        _ => None,
    }
}

pub fn native_auth_target(auth_kind: &str) -> Option<AppType> {
    match auth_kind {
        "claude_subscription" => Some(AppType::Claude),
        "gemini_subscription" => Some(AppType::Gemini),
        _ => None,
    }
}

/// This is a local CLI-default selector, not a remote model or entitlement list.
pub fn native_subscription_channel(tool: &str) -> Result<ChannelSource, AppError> {
    let (kind, name, protocol) = match tool {
        "claude" => ("claude_subscription", "Claude 原生订阅", "anthropic"),
        "gemini" => ("gemini_subscription", "Gemini 原生账号", "gemini_native"),
        _ => {
            return Err(AppError::InvalidInput(
                "请选择 Claude Code 或 Gemini CLI".into(),
            ))
        }
    };
    Ok(ChannelSource {
        id: format!("{tool}-native"),
        name: name.into(),
        base_url: String::new(),
        api_key: String::new(),
        auth_kind: kind.into(),
        account_id: Some("native".into()),
        protocol: protocol.into(),
        enabled: true,
        models: vec![ChannelModel {
            id: "native-default".into(),
            name: Some("原生工具默认模型（工具维护目录）".into()),
            context_limit: None,
            context_limits: None,
            selected_context_limit: None,
            output_limit: None,
            reasoning_efforts: None,
            reasoning_effort_source: None,
            reasoning_effort_transport: None,
            supports_tools: None,
            input_modalities: None,
            protocol: Some(protocol.into()),
            enabled: Some(true),
        }],
    })
}

/// Local preflight only. A saved source keeps its account reference so removal
/// is reported clearly instead of silently falling back to a different account.
pub fn validate_managed_account_references(
    snapshot: &ChannelCenterSnapshot,
    accounts: &[(String, String)],
) -> Result<(), AppError> {
    for source in snapshot
        .channels
        .iter()
        .filter(|source| source.enabled && source.models.iter().any(ChannelModel::available))
    {
        if matches!(
            source.auth_kind.as_str(),
            "github_copilot" | "codex_oauth" | "xai_oauth"
        ) {
            let id = source.account_id.as_deref().unwrap_or("");
            if !accounts
                .iter()
                .any(|(kind, account)| kind == &source.auth_kind && account == id)
            {
                return Err(AppError::InvalidInput(format!(
                    "渠道 {} 绑定的账号已退出或移除，请重新登录并选择账户",
                    source.id
                )));
            }
        }
    }
    Ok(())
}

/// Reuse the existing managed-auth catalog. Its absence of capability metadata
/// stays unknown; no token, endpoint or model entitlement is synthesized.
pub fn merge_subscription_models(
    mut channel: ChannelSource,
    models: Vec<crate::services::model_fetch::FetchedModel>,
) -> Result<ChannelSource, AppError> {
    let (base, protocol) = managed_subscription_route(&channel.auth_kind)
        .ok_or_else(|| AppError::InvalidInput("此订阅没有已接入的通用模型调用链路".into()))?;
    let discovered = models
        .into_iter()
        .map(|model| ChannelModel {
            name: Some(model.id.clone()),
            id: model.id,
            context_limit: model.metadata.context_limit,
            context_limits: model.metadata.context_limits,
            selected_context_limit: None,
            output_limit: model.metadata.output_limit,
            reasoning_efforts: model.metadata.reasoning_efforts,
            reasoning_effort_source: None,
            reasoning_effort_transport: None,
            supports_tools: None,
            input_modalities: None,
            protocol: Some(protocol.into()),
            enabled: None,
        })
        .collect();
    channel.base_url = base.into();
    channel.protocol = protocol.into();
    channel.models = merge_discovered(&channel.models, discovered);
    channel.api_key.clear();
    exclude_known_non_agent_models(&mut channel);
    validate_channel(&channel)?;
    Ok(channel)
}

pub fn merge_managed_discovery(
    mut channel: ChannelSource,
    discovered: ChannelSource,
) -> ChannelSource {
    channel.base_url = discovered.base_url;
    channel.protocol = discovered.protocol;
    channel.models = merge_discovered(&channel.models, discovered.models);
    channel.api_key.clear();
    channel
}

fn effective_protocol<'a>(channel: &'a ChannelSource, model: &'a ChannelModel) -> &'a str {
    if let Some((_, protocol)) = managed_subscription_route(&channel.auth_kind) {
        return protocol;
    }
    model.protocol.as_deref().unwrap_or(&channel.protocol)
}

fn native_api(protocol: &str) -> &'static str {
    match protocol {
        "anthropic" => "anthropic-messages",
        "openai_responses" => "openai-responses",
        "gemini_native" => "google-generative-ai",
        _ => "openai-completions",
    }
}

fn native_supported(app: &AppType, protocol: &str) -> bool {
    app.is_additive_mode()
        && (protocol != "gemini_native"
            || matches!(app, AppType::OpenCode | AppType::OpenClaw | AppType::Pi))
}

pub(super) const MANAGED_NOTE: &str = "TAI Channel Center managed";

/// Pure projection: no API request, database mutation or filesystem access.
fn native_provider(
    app: &AppType,
    source: &ChannelSource,
    protocol: &str,
    models: &[ChannelModel],
    id: String,
) -> Result<Provider, AppError> {
    if !native_supported(app, protocol) {
        return Err(AppError::InvalidInput(
            "该客户端不能原生使用此 API 格式".into(),
        ));
    }
    let api = native_api(protocol);
    let base_url = client_base_url(&source.base_url, protocol)?;
    let model_map: Map<String, Value> = models
        .iter()
        .map(|model| {
            let mut entry = Map::new();
            entry.insert(
                "name".into(),
                json!(model.name.as_deref().unwrap_or(&model.id)),
            );
            let mut limit = Map::new();
            if let Some(context) = model.effective_context_limit() {
                limit.insert("context".into(), json!(context));
            }
            if let Some(output) = model.output_limit {
                limit.insert("output".into(), json!(output));
            }
            if !limit.is_empty() {
                entry.insert("limit".into(), Value::Object(limit));
            }
            if let Some(input) = &model.input_modalities {
                entry.insert(
                    "modalities".into(),
                    json!({"input":input,"output":["text"]}),
                );
            }
            (model.id.clone(), Value::Object(entry))
        })
        .collect();
    let list: Vec<Value> = models
        .iter()
        .map(|model| {
            let mut entry =
                json!({"id":model.id,"name":model.name.as_deref().unwrap_or(&model.id)});
            if let Some(context) = model.effective_context_limit() {
                entry["contextWindow"] = json!(context);
            }
            if let Some(output) = model.output_limit {
                entry["maxTokens"] = json!(output);
            }
            if let Some(input) = &model.input_modalities {
                entry["input"] = json!(input);
            }
            entry
        })
        .collect();
    let settings = match app {
        AppType::OpenCode => {
            json!({"npm":match protocol {"anthropic"=>"@ai-sdk/anthropic","openai_responses"=>"@ai-sdk/openai","gemini_native"=>"@ai-sdk/google",_=>"@ai-sdk/openai-compatible"},"name":source.name,"options":{"baseURL":base_url,"apiKey":source.api_key},"models":model_map})
        }
        AppType::OpenClaw => {
            json!({"baseUrl":base_url,"apiKey":source.api_key,"api":api,"models":list})
        }
        AppType::Hermes => {
            json!({"name":id,"base_url":base_url,"api_key":source.api_key,"api_mode":match protocol {"anthropic"=>"anthropic_messages","openai_responses"=>"codex_responses",_=>"chat_completions"},"models":models.iter().map(|model| { let mut entry=json!({"id":model.id,"name":model.name}); if let Some(context)=model.effective_context_limit() {entry["context_length"]=json!(context);} entry }).collect::<Vec<_>>()})
        }
        AppType::Pi => {
            json!({"name":source.name,"baseUrl":base_url,"apiKey":source.api_key,"api":api,"models":list})
        }
        AppType::Mcode => {
            json!({"name":source.name,"kind":"custom","enabled":true,"api":api,"options":{"baseURL":base_url,"apiKey":source.api_key},"models":model_map})
        }
        _ => unreachable!(),
    };
    Ok(managed_provider(
        id,
        source.name.clone(),
        settings,
        protocol,
    ))
}

fn client_base_url(raw: &str, protocol: &str) -> Result<String, AppError> {
    let url = validated_url(raw)?;
    let base = raw.trim().trim_end_matches('/');
    Ok(if url.path().trim_matches('/').is_empty() {
        match protocol {
            "openai_chat" | "openai_responses" => format!("{base}/v1"),
            "gemini_native" => format!("{base}/v1beta"),
            _ => base.into(),
        }
    } else {
        base.into()
    })
}

fn managed_provider(id: String, name: String, settings: Value, protocol: &str) -> Provider {
    let mut provider = Provider::with_id(id, name, settings, None);
    provider.category = Some("custom".into());
    provider.notes = Some(MANAGED_NOTE.into());
    provider.meta = Some(ProviderMeta {
        api_format: Some(protocol.into()),
        common_config_enabled: Some(false),
        live_config_managed: Some(true),
        ..Default::default()
    });
    provider
}

fn aggregate_source(
    snapshot: &ChannelCenterSnapshot,
    base_url: &str,
    token: &str,
    protocol: &str,
) -> ChannelSource {
    let models = snapshot
        .channels
        .iter()
        .filter(|channel| channel.enabled)
        .flat_map(|channel| {
            channel
                .models
                .iter()
                .filter(|model| model.available())
                .map(move |model| {
                    let mut result = model.clone();
                    result.id = route_id(channel, model);
                    result.name = Some(format!(
                        "{} · {}",
                        channel.name,
                        model.name.as_deref().unwrap_or(&model.id)
                    ));
                    result.protocol = None;
                    result
                })
        })
        .collect();
    ChannelSource {
        id: "gateway".into(),
        name: "LoliCode Gateway".into(),
        base_url: base_url.into(),
        api_key: token.into(),
        auth_kind: "api_key".into(),
        account_id: None,
        protocol: protocol.into(),
        models,
        enabled: true,
    }
}

pub(crate) fn gateway_provider(
    app: &AppType,
    source: &ChannelSource,
    default: &str,
) -> Result<Provider, AppError> {
    if app.is_additive_mode() {
        return native_provider(
            app,
            source,
            &source.protocol,
            &source.models,
            "tai-channel-gateway".into(),
        );
    }
    let settings = match app {
        AppType::Claude => {
            let selected = source
                .models
                .iter()
                .find(|model| model.id == default)
                .ok_or_else(|| AppError::InvalidInput("所选 Claude 默认模型不在目录中".into()))?;
            let alias = claude_client_alias(selected);
            let mut env = json!({"ANTHROPIC_BASE_URL":source.base_url.trim_end_matches("/v1"),"ANTHROPIC_AUTH_TOKEN":source.api_key,"ANTHROPIC_MODEL":alias,"ANTHROPIC_DEFAULT_SONNET_MODEL":alias,"ANTHROPIC_DEFAULT_OPUS_MODEL":alias,"ANTHROPIC_DEFAULT_HAIKU_MODEL":alias,"ANTHROPIC_DEFAULT_FABLE_MODEL":alias});
            // Match the original Claude Stack contract: a non-Claude-prefixed
            // alias lets the client honor the smallest declared non-1M window.
            if let Some(window) = source
                .models
                .iter()
                .map(|model| {
                    model
                        .effective_context_limit()
                        .filter(|limit| *limit > 0)
                        .unwrap_or(crate::mode::stack::CLAUDE_DEFAULT_WINDOW)
                })
                .filter(|window| *window < 1_000_000)
                .min()
            {
                env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = json!(window.to_string());
            }
            // Output limits belong to each routed request. A process-wide
            // minimum makes one small catalog model constrain every other
            // model's answer and thinking budget, even after /model switches.
            // The gateway caps requests against the actual selected model.
            json!({"env":env,"modelPicker":{"replaceBuiltInOptions":true,"options":source.models.iter().map(|m| json!({"model":claude_client_alias(m),"label":m.name.as_deref().unwrap_or(&m.id),"description":"渠道目录"})).collect::<Vec<_>>()}})
        }
        AppType::ClaudeDesktop => {
            json!({"env":{"ANTHROPIC_BASE_URL":source.base_url.trim_end_matches("/v1"),"ANTHROPIC_AUTH_TOKEN":source.api_key}})
        }
        AppType::Codex => {
            let mut doc = toml_edit::DocumentMut::new();
            doc["model_provider"] = toml_edit::value("custom");
            doc["model"] = toml_edit::value(default);
            doc["model_providers"]["custom"]["name"] = toml_edit::value("LoliCode Gateway");
            doc["model_providers"]["custom"]["base_url"] =
                toml_edit::value(source.base_url.as_str());
            doc["model_providers"]["custom"]["wire_api"] = toml_edit::value("responses");
            doc["model_providers"]["custom"]["experimental_bearer_token"] =
                toml_edit::value(source.api_key.as_str());
            json!({"auth":{"OPENAI_API_KEY":source.api_key},"config":doc.to_string(),"modelCatalog":{"models":source.models.iter().map(|m| {let mut item=json!({"model":m.id,"displayName":m.name});if let Some(c)=m.effective_context_limit() {item["contextWindow"]=json!(c);}if let Some(i)=&m.input_modalities {item["inputModalities"]=json!(i);}item}).collect::<Vec<_>>()}})
        }
        AppType::GrokBuild => {
            let mut doc = toml_edit::DocumentMut::new();
            for (index, model) in source.models.iter().enumerate() {
                let key = format!("tai-channel-{}", index + 1);
                if model.id == default {
                    doc["models"]["default"] = toml_edit::value(key.as_str());
                }
                let entry = &mut doc["model"][&key];
                entry["model"] = toml_edit::value(model.id.as_str());
                entry["base_url"] = toml_edit::value(source.base_url.as_str());
                entry["name"] = toml_edit::value(model.name.as_deref().unwrap_or(&model.id));
                entry["api_key"] = toml_edit::value(source.api_key.as_str());
                entry["api_backend"] = toml_edit::value("responses");
                entry["context_window"] = toml_edit::value(
                    model
                        .effective_context_limit()
                        .unwrap_or(128_000)
                        .min(i64::MAX as u64) as i64,
                );
            }
            json!({"config":doc.to_string()})
        }
        AppType::Gemini => {
            json!({"env":{"GOOGLE_GEMINI_BASE_URL":source.base_url.trim_end_matches("/v1"),"GEMINI_API_KEY":source.api_key,"GEMINI_MODEL":default},"config":{"model":{"name":default}}})
        }
        _ => {
            return Err(AppError::InvalidInput(
                "该客户端的完整目录写入尚不支持".into(),
            ))
        }
    };
    let mut provider = managed_provider(
        "tai-channel-gateway".into(),
        source.name.clone(),
        settings,
        &source.protocol,
    );
    if *app == AppType::Claude {
        provider.meta.as_mut().unwrap().stack_models = Some(
            source
                .models
                .iter()
                .map(|m| crate::provider::ClaudeStackModel {
                    model: m.id.clone(),
                    display_name: m.name.clone(),
                    one_m: m.effective_context_limit().is_some_and(|c| c >= 1_000_000),
                })
                .collect(),
        );
    }
    if *app == AppType::ClaudeDesktop {
        let meta = provider.meta.as_mut().unwrap();
        // This profile already targets the versioned local Messages gateway.
        // A second Desktop proxy would replace its immutable routing boundary.
        meta.claude_desktop_mode = Some(crate::provider::ClaudeDesktopMode::Direct);
        meta.claude_desktop_model_routes = source
            .models
            .iter()
            .map(|model| {
                (
                    claude_desktop_gateway_alias(&model.id),
                    crate::provider::ClaudeDesktopModelRoute {
                        model: claude_desktop_gateway_alias(&model.id),
                        label_override: model.name.clone(),
                        supports_1m: model.effective_context_limit().map(|c| c >= 1_000_000),
                    },
                )
            })
            .collect();
    }
    Ok(provider)
}

fn claude_gateway_alias(route: &str) -> String {
    match route.split_once('/') {
        Some((source, model)) => format!("claude-sonnet-tai-{source}--{model}"),
        None => route.into(),
    }
}

fn claude_code_gateway_alias(route: &str) -> String {
    match route.split_once('/') {
        Some((source, model)) => {
            let key: String = source
                .as_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            format!("tai-claude-{key}--{model}")
        }
        None => route.into(),
    }
}

fn claude_desktop_gateway_alias(route: &str) -> String {
    match route.split_once('/') {
        Some((source, model)) => {
            let key: String = source
                .as_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            format!("claude-sonnet-tai-{key}--{model}")
        }
        None => route.into(),
    }
}

fn claude_client_alias(model: &ChannelModel) -> String {
    let alias = claude_code_gateway_alias(&model.id);
    if model
        .effective_context_limit()
        .is_some_and(|limit| limit >= 1_000_000)
    {
        format!("{alias}[1M]")
    } else {
        alias
    }
}

fn upsert_projection(
    state: &AppState,
    app: &AppType,
    mut provider: Provider,
) -> Result<(), AppError> {
    let previous = state.db.get_provider_by_id(&provider.id, app.as_str())?;
    if *app == AppType::OpenCode {
        let live = crate::opencode_config::get_providers_with_format()?;
        let format = previous
            .as_ref()
            .and_then(Provider::opencode_config_format)
            .or_else(|| live.get(&provider.id).map(|(_, format)| *format))
            .unwrap_or(
                if crate::opencode_config::read_opencode_config()?
                    .get("providers")
                    .is_some()
                {
                    crate::provider::OpenCodeConfigFormat::V2
                } else {
                    crate::provider::OpenCodeConfigFormat::V1
                },
            );
        if format == crate::provider::OpenCodeConfigFormat::V2 {
            project_opencode_v2(&mut provider);
        }
        provider.meta.as_mut().unwrap().opencode_config_format = Some(format);
    }
    if let Some(previous) = previous {
        if previous.notes.as_deref() != Some(MANAGED_NOTE) {
            return Err(AppError::Conflict(
                "渠道配置标识已被已有供应商使用，现有配置已保留".into(),
            ));
        }
        // Preserve application-specific fields; the catalog itself is owned and replaced.
        if let (Some(existing), Some(next)) = (
            previous.settings_config.as_object(),
            provider.settings_config.as_object_mut(),
        ) {
            for (key, value) in existing {
                next.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
        provider.created_at = previous.created_at;
        provider.sort_index = previous.sort_index;
        if *app == AppType::ClaudeDesktop
            && crate::claude_desktop_config::provider_mode(&previous)
                == crate::provider::ClaudeDesktopMode::Proxy
            && crate::claude_desktop_config::provider_mode(&provider)
                == crate::provider::ClaudeDesktopMode::Direct
        {
            write_desktop_channel_projection(
                state.db.as_ref(),
                &provider,
                crate::claude_desktop_config::apply_provider,
            )?;
        } else {
            crate::services::ProviderService::update(state, app.clone(), None, provider.clone())?;
        }
    } else if app.is_additive_mode() {
        let exists = match app {
            AppType::OpenCode => {
                crate::opencode_config::get_providers()?.contains_key(&provider.id)
            }
            AppType::OpenClaw => crate::openclaw_config::get_provider(&provider.id)?.is_some(),
            AppType::Hermes => crate::hermes_config::get_provider(&provider.id)?.is_some(),
            AppType::Pi => crate::pi_config::pi_provider_exists(&provider.id)?,
            AppType::Mcode => crate::mcode_config::provider_key_exists(&provider.id)?,
            _ => false,
        };
        if exists {
            return Err(AppError::Conflict(
                "客户端已有同名供应商，原配置已保留，请修改渠道标识后重试".into(),
            ));
        }
        crate::services::ProviderService::add(state, app.clone(), provider.clone(), true)?;
    } else {
        crate::services::ProviderService::add_without_switching(
            state,
            app.clone(),
            provider.clone(),
        )?;
    }
    // Enable through each application's native writer.
    if app.is_additive_mode() {
        match app {
            AppType::OpenCode => crate::opencode_config::set_provider_with_format(
                &provider.id,
                provider.settings_config.clone(),
                provider
                    .opencode_config_format()
                    .unwrap_or(crate::provider::OpenCodeConfigFormat::V1),
            )?,
            AppType::OpenClaw => {
                crate::openclaw_config::set_provider(
                    &provider.id,
                    provider.settings_config.clone(),
                )?;
            }
            AppType::Hermes => {
                crate::hermes_config::set_provider(&provider.id, provider.settings_config.clone())?;
            }
            AppType::Pi => {
                if crate::pi_config::replace_pi_provider_if_present(
                    &provider.id,
                    &provider.settings_config,
                )?
                .is_none()
                {
                    crate::pi_config::insert_pi_provider(&provider.id, &provider.settings_config)?;
                }
            }
            AppType::Mcode => {
                crate::mcode_config::set_provider(&provider.id, provider.settings_config.clone())?
            }
            _ => {}
        }
        if let Some(stored) = state.db.get_provider_by_id(&provider.id, app.as_str())? {
            let mut stored = stored;
            stored
                .meta
                .get_or_insert_with(ProviderMeta::default)
                .live_config_managed = Some(true);
            state.db.save_provider(app.as_str(), &stored)?;
        }
        return Ok(());
    }
    let switched = crate::services::ProviderService::switch(state, app.clone(), &provider.id)?;
    if !switched.warnings.is_empty() {
        return Err(AppError::Message(format!(
            "目录已写入，但默认模型未完全生效：{}",
            switched.warnings.join("、")
        )));
    }
    Ok(())
}

/// Keep the old /claude-desktop routing row until its replacement profile is
/// completely published. On partial failure the native writer retains pending
/// files for recovery; restoring old files here would discard that intent.
pub(crate) fn write_desktop_channel_projection(
    db: &Database,
    provider: &Provider,
    write: impl FnOnce(&Database, &Provider) -> Result<(), AppError>,
) -> Result<(), AppError> {
    write(db, provider)?;
    db.save_provider("claude-desktop", provider)
}

fn project_opencode_v2(provider: &mut Provider) {
    let Some(settings) = provider.settings_config.as_object_mut() else {
        return;
    };
    if let Some(package) = settings.shift_remove("npm") {
        settings.insert("package".into(), package);
    }
    if let Some(options) = settings.shift_remove("options") {
        settings.insert("settings".into(), options);
    }
    if let Some(models) = settings.get_mut("models").and_then(Value::as_object_mut) {
        for (id, model) in models {
            if let Some(model) = model.as_object_mut() {
                model.insert("modelID".into(), json!(id));
            }
        }
    }
}

pub(super) fn apply_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn needs_gateway(snapshot: &ChannelCenterSnapshot, app: &AppType) -> bool {
    !app.is_additive_mode()
        || snapshot
            .channels
            .iter()
            .filter(|c| c.enabled)
            .any(|channel| {
                channel.auth_kind != "api_key"
                    || channel
                        .models
                        .iter()
                        .filter(|m| m.available())
                        .any(|m| !native_supported(app, effective_protocol(channel, m)))
            })
}

fn native_plans(
    snapshot: &ChannelCenterSnapshot,
    app: &AppType,
) -> Result<Vec<Provider>, AppError> {
    let mut plans = Vec::new();
    for source in snapshot.channels.iter().filter(|channel| channel.enabled) {
        if native_auth_target(&source.auth_kind).is_some() {
            continue;
        }
        let mut groups: BTreeMap<&str, Vec<ChannelModel>> = BTreeMap::new();
        for model in source.models.iter().filter(|m| m.available()) {
            groups
                .entry(effective_protocol(source, model))
                .or_default()
                .push(model.clone());
        }
        for (protocol, mut models) in groups {
            if let Some(default) = &snapshot.default_model {
                models.sort_by_key(|model| route_id(source, model) != *default);
            }
            plans.push(native_provider(
                app,
                source,
                protocol,
                &models,
                format!("tai-channel-{}-{}", source.id, protocol.replace('_', "-")),
            )?);
        }
    }
    Ok(plans)
}

fn api_catalog_snapshot(snapshot: &ChannelCenterSnapshot) -> ChannelCenterSnapshot {
    let mut api = snapshot.clone();
    api.channels
        .retain(|channel| native_auth_target(&channel.auth_kind).is_none());
    let first = api
        .channels
        .iter()
        .filter(|channel| channel.enabled)
        .flat_map(|channel| {
            channel
                .models
                .iter()
                .filter(|model| model.available())
                .map(move |model| route_id(channel, model))
        })
        .collect::<Vec<_>>();
    if api
        .default_model
        .as_ref()
        .is_none_or(|selected| !first.contains(selected))
    {
        api.default_model = first.first().cloned();
    }
    api
}

/// Read only the saved channel center, without triggering legacy migration or
/// touching any external client's applied catalog or native configuration.
pub fn agent_source_snapshot(db: &Database) -> Result<ChannelCenterSnapshot, AppError> {
    let _guard = catalog_lock().lock()?;
    let snapshot = read_stored(db)?.unwrap_or_default();
    validate(&snapshot)?;
    if snapshot
        .channels
        .iter()
        .any(|source| source.auth_kind != "api_key" && !source.api_key.is_empty())
    {
        return Err(AppError::Config(
            "登录渠道含有不应保留的临时凭据，请重新保存渠道后重试".into(),
        ));
    }
    Ok(snapshot)
}

fn agent_catalog_from_snapshot(snapshot: &ChannelCenterSnapshot) -> AgentCatalog {
    let api = api_catalog_snapshot(snapshot);
    let models = api
        .channels
        .iter()
        .filter(|source| source.enabled)
        .flat_map(|source| {
            source
                .models
                .iter()
                .filter(|model| model.available())
                .map(move |model| {
                    let model_id = route_id(source, model);
                    AgentCatalogModel {
                        id: format!("lolicode/{model_id}"),
                        provider_id: "lolicode".into(),
                        model_id,
                        name: format!(
                            "{} · {}",
                            source.name,
                            model.name.as_deref().unwrap_or(&model.id)
                        ),
                        channel_name: source.name.clone(),
                        context_limit: model.effective_context_limit(),
                        context_limits: model.context_limits.clone(),
                        output_limit: model.output_limit,
                        reasoning_efforts: model.reasoning_efforts.clone(),
                        reasoning_effort_source: model.reasoning_effort_source.clone(),
                        reasoning_effort_transport: model.reasoning_effort_transport.clone(),
                    }
                })
        })
        .collect();
    AgentCatalog {
        revision: snapshot.revision,
        models,
        default_model: api.default_model.map(|id| format!("lolicode/{id}")),
        excluded_sources: snapshot
            .channels
            .iter()
            .filter(|source| source.enabled)
            .filter_map(|source| {
                native_auth_target(&source.auth_kind).map(|app| {
                    format!(
                        "{}：此原生账号仅可用于 {}，不能用于 LoliCode agent",
                        source.name,
                        app.as_str()
                    )
                })
            })
            .collect(),
    }
}

/// This is a stored model catalog, not a paid inference or entitlement check.
pub fn agent_catalog(db: &Database) -> Result<AgentCatalog, AppError> {
    Ok(agent_catalog_from_snapshot(&agent_source_snapshot(db)?))
}

#[cfg(any(test, feature = "test-hooks"))]
fn agent_opencode_v2_config(
    catalog: &AgentCatalog,
    base_url: &str,
    local_token: &str,
) -> Result<Value, AppError> {
    let default = catalog
        .default_model
        .as_deref()
        .filter(|id| catalog.models.iter().any(|model| model.id == *id))
        .ok_or_else(|| {
            AppError::InvalidInput(
                "请先在渠道与模型中添加并启用支持工具调用的 API 或订阅模型；原生 Claude/Gemini 账号只能用于各自官方工具".into(),
            )
        })?;
    let models: Map<String, Value> = catalog
        .models
        .iter()
        .map(|model| {
            let mut entry = json!({"modelID":model.model_id,"name":model.name});
            let mut limit = Map::new();
            if let Some(context) = model.context_limit {
                limit.insert("context".into(), json!(context));
            }
            if let Some(output) = model.output_limit {
                limit.insert("output".into(), json!(output));
            }
            if !limit.is_empty() {
                entry["limit"] = Value::Object(limit);
            }
            // Missing capability metadata stays unknown; it is not a false
            // declaration that would disable the engine's coding tools.
            (model.model_id.clone(), entry)
        })
        .collect();
    let provider = json!({
        "name":"LoliCode",
        "package":"@ai-sdk/openai-compatible",
        "settings":{"baseURL":base_url,"apiKey":local_token},
        "models":models
    });
    crate::opencode_config::validate_native_provider("lolicode", &provider)?;
    Ok(json!({
        "providers":{"lolicode":provider},
        "model":default,
        "default_agent":"build",
        "update":"disable",
        "share":"disabled",
        "snapshots":true,
        "permissions":[
            {"action":"*","resource":"*","effect":"ask"},
            {"action":"read","resource":"*","effect":"allow"},
            {"action":"glob","resource":"*","effect":"allow"},
            {"action":"grep","resource":"*","effect":"allow"},
            {"action":"list","resource":"*","effect":"allow"},
            {"action":"edit","resource":"*","effect":"allow"},
            {"action":"question","resource":"*","effect":"allow"},
            {"action":"shell","resource":"*","effect":"ask"},
            {"action":"external_directory","resource":"*","effect":"ask"}
        ],
        "experimental":{"policies":[
            {"action":"provider.use","resource":"*","effect":"deny"},
            {"action":"provider.use","resource":"lolicode","effect":"allow"}
        ]}
    }))
}

/// Roll back only our background marker if preparation fails or its future is
/// cancelled. Successful preparation deliberately keeps the persisted marker,
/// so restart can restore agent-only catalogs without writing LAST_APPLIED.
struct AgentGatewayPreparation<'db> {
    db: &'db Database,
    previous_background: Option<String>,
    committed: bool,
}

impl Drop for AgentGatewayPreparation<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let restored = (|| -> Result<(), AppError> {
            let conn = crate::database::lock_conn!(self.db.conn);
            match &self.previous_background {
                Some(previous) => {
                    conn.execute(
                        "INSERT OR REPLACE INTO settings (key,value) VALUES (?1,?2)",
                        rusqlite::params![BACKGROUND_KEY, previous],
                    )?;
                }
                None => {
                    conn.execute("DELETE FROM settings WHERE key=?1", [BACKGROUND_KEY])?;
                }
            }
            Ok(())
        })();
        if let Err(error) = restored {
            // Keeping the service alive is safer than discarding an existing
            // external tool's background requirement on a damaged database.
            log::warn!("恢复 agent 渠道服务后台标记失败：{error}");
        }
    }
}

fn prepare_agent_gateway_write<'db>(
    db: &'db Database,
    snapshot: &ChannelCenterSnapshot,
) -> Result<AgentGatewayPreparation<'db>, AppError> {
    use rusqlite::OptionalExtension;
    let _guard = catalog_lock().lock()?;
    let mut conn = crate::database::lock_conn!(db.conn);
    let tx = conn.transaction()?;
    let key = format!("channel_center_catalog_{}", snapshot.revision);
    let raw = serialize(snapshot)?;
    let existing: Option<String> = tx
        .query_row("SELECT value FROM settings WHERE key=?1", [&key], |row| {
            row.get(0)
        })
        .optional()?;
    match existing {
        Some(existing) if existing != raw => {
            return Err(AppError::Conflict(
                "此渠道版本已经应用且内容不同，请重新保存以创建新版本".into(),
            ));
        }
        Some(_) => {}
        None => {
            tx.execute(
                "INSERT INTO settings (key,value) VALUES (?1,?2)",
                rusqlite::params![key, raw],
            )?;
        }
    }
    let previous_background = tx
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [BACKGROUND_KEY],
            |row| row.get(0),
        )
        .optional()?;
    tx.execute(
        "INSERT OR REPLACE INTO settings (key,value) VALUES (?1,'true')",
        [BACKGROUND_KEY],
    )?;
    tx.commit()?;
    Ok(AgentGatewayPreparation {
        db,
        previous_background,
        committed: false,
    })
}

/// Prepare only an engine-owned profile. Callers must validate the pinned
/// catalog's managed account references before launching the engine. This does
/// not switch providers, write global OpenCode files, or change LAST_APPLIED.
#[cfg(any(test, feature = "test-hooks"))]
pub async fn prepare_agent_catalog(state: &AppState) -> Result<PreparedAgentCatalog, AppError> {
    let binding = prepare_agent_binding_with(state, |catalog| {
        agent_opencode_v2_config(catalog, "http://127.0.0.1/tai/v1", "validation-only").map(|_| ())
    })
    .await?;
    let config =
        agent_opencode_v2_config(&binding.catalog, &binding.base_url, &binding.bearer_token)?;
    Ok(PreparedAgentCatalog {
        catalog: binding.catalog,
        config,
    })
}

/// Native agent preparation never creates or validates an external-engine profile.
pub async fn prepare_inprocess_agent_binding(
    state: &AppState,
) -> Result<AgentGatewayBinding, AppError> {
    let mut binding = prepare_agent_binding_with(state, |_| Ok(())).await?;
    binding.base_url = crate::proxy::channel_gateway::catalog_client_base_url(
        &binding.base_url,
        "lolicode",
    )?;
    Ok(binding)
}

/// Prepare the shared model catalog for Tavern requests with separate usage
/// attribution. Credentials remain inside this backend-only binding.
pub async fn prepare_tavern_binding(state: &AppState) -> Result<AgentGatewayBinding, AppError> {
    let mut binding = prepare_agent_binding_with(state, |_| Ok(())).await?;
    binding.base_url =
        crate::proxy::channel_gateway::catalog_client_base_url(&binding.base_url, "tavern")?;
    Ok(binding)
}

async fn prepare_agent_binding_with(
    state: &AppState,
    validate_engine: impl FnOnce(&AgentCatalog) -> Result<(), AppError>,
) -> Result<AgentGatewayBinding, AppError> {
    let _guard = apply_lock().lock().await;
    let snapshot = agent_source_snapshot(state.db.as_ref())?;
    let catalog = agent_catalog_from_snapshot(&snapshot);
    if !catalog
        .default_model
        .as_ref()
        .is_some_and(|id| catalog.models.iter().any(|model| &model.id == id))
    {
        return Err(AppError::InvalidInput(
            "请先在渠道与模型中添加并启用一个可通过共享网关调用的模型".into(),
        ));
    }
    validate_engine(&catalog)?;
    let api_snapshot = api_catalog_snapshot(&snapshot);
    let mut preparation = prepare_agent_gateway_write(state.db.as_ref(), &api_snapshot)?;
    let info = state.proxy_service.start().await.map_err(|error| {
        AppError::Message(format!(
            "本地渠道服务无法启动：{}",
            crate::error_for_log(&error)
        ))
    })?;
    let base_url = crate::proxy::channel_gateway::gateway_catalog_base_url(
        &info.address,
        info.port,
        api_snapshot.revision,
    )?;
    let bearer_token = gateway_token(state.db.as_ref())?;
    preparation.committed = true;
    Ok(AgentGatewayBinding {
        catalog,
        base_url,
        bearer_token,
    })
}

fn native_selection_for<'a>(
    snapshot: &'a ChannelCenterSnapshot,
    app: &AppType,
) -> Option<&'a ChannelSource> {
    let enabled = |channel: &&ChannelSource| {
        channel.enabled
            && native_auth_target(&channel.auth_kind).as_ref() == Some(app)
            && channel.models.iter().any(ChannelModel::available)
    };
    if let Some(default) = &snapshot.default_model {
        if let Some(channel) = snapshot.channels.iter().filter(enabled).find(|channel| {
            channel
                .models
                .iter()
                .any(|model| model.available() && route_id(channel, model) == *default)
        }) {
            return Some(channel);
        }
    }
    let api = api_catalog_snapshot(snapshot);
    let has_api = api
        .channels
        .iter()
        .filter(|channel| channel.enabled)
        .any(|channel| {
            channel.models.iter().any(|model| {
                model.available()
                    && (*app != AppType::Gemini
                        || (channel.auth_kind == "api_key"
                            && effective_protocol(channel, model) == "gemini_native"))
            })
        });
    if !has_api {
        snapshot.channels.iter().find(enabled)
    } else {
        None
    }
}

fn native_login_provider(app: &AppType, source: &ChannelSource) -> Result<Provider, AppError> {
    if native_auth_target(&source.auth_kind).as_ref() != Some(app) {
        return Err(AppError::InvalidInput(
            "此登录账号只能用于对应的原生工具".into(),
        ));
    }
    let settings = match app {
        AppType::Claude => json!({"env":{}}),
        AppType::Gemini => json!({"env":{},"config":{}}),
        _ => {
            return Err(AppError::InvalidInput(
                "此工具不能使用该原生登录账号".into(),
            ))
        }
    };
    let mut provider = managed_provider(
        format!("tai-channel-native-{}", app.as_str()),
        source.name.clone(),
        settings,
        &source.protocol,
    );
    // Existing official writers clear custom routing/auth and restore CLI login.
    provider.category = Some("official".into());
    Ok(provider)
}

fn validate_native_login(app: &AppType) -> Result<(), AppError> {
    if crate::commands::local_tool_version(app.as_str()).is_none() {
        return Err(AppError::InvalidInput(
            "原生工具尚未安装，配置未改动".into(),
        ));
    }
    if !crate::services::subscription::native_channel_authenticated(app.as_str())
        .map_err(AppError::Message)?
    {
        return Err(AppError::InvalidInput(
            "原生登录状态已失效，请先在对应工具重新登录".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn prepare_native_login_mode(
    state: &AppState,
    app: &AppType,
    preflight: impl FnOnce() -> Result<(), AppError> + Send + 'static,
) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(preflight)
        .await
        .map_err(|_| AppError::Message("原生登录检查任务执行失败".into()))??;
    if app.supports_local_proxy() && crate::mode::current::is_proxy(app) {
        crate::mode::controller::exit(state, app)
            .await
            .map_err(|error| {
                AppError::Message(format!(
                    "旧应用路由无法退出：{}",
                    crate::error_for_log(&error)
                ))
            })?;
    }
    Ok(())
}

fn apply_native_login(
    state: &AppState,
    app: &AppType,
    source: &ChannelSource,
) -> Result<(), AppError> {
    let seed = if *app == AppType::Claude {
        "claude-official"
    } else {
        "gemini-official"
    };
    state.db.ensure_official_seed_by_id(seed, app.clone())?;
    upsert_projection(state, app, native_login_provider(app, source)?)
}

fn reconcile_managed(state: &AppState, app: &AppType, ids: &[String]) -> Result<(), AppError> {
    let key = format!("channel_center_managed_{}", app.as_str());
    let old: Vec<String> = state
        .db
        .get_setting(&key)?
        .map(|s| {
            serde_json::from_str(&s)
                .map_err(|_| AppError::Config("渠道托管目录记录无法解析，未删除任何配置".into()))
        })
        .transpose()?
        .unwrap_or_default();
    for id in old.iter().filter(|id| !ids.contains(id)) {
        if state
            .db
            .get_provider_by_id(id, app.as_str())?
            .is_some_and(|p| p.notes.as_deref() == Some(MANAGED_NOTE))
        {
            crate::services::ProviderService::remove_from_live_config(state, app.clone(), id)?;
        }
    }
    state.db.set_setting(&key, &serialize(&ids)?)
}

fn apply_plans(
    state: &AppState,
    app: &AppType,
    plans: Vec<Provider>,
    default_route: &str,
    gateway: bool,
) -> Result<(), AppError> {
    if *app == AppType::Mcode {
        return apply_mcode_plans_at(
            state,
            plans,
            default_route,
            gateway,
            &crate::mcode_config::config_path(),
        );
    }
    if gateway {
        super::channel_connections::capture_native(state, app)?;
    }
    let ids: Vec<String> = plans.iter().map(|p| p.id.clone()).collect();
    for provider in &plans {
        if *app == AppType::GrokBuild {
            if state
                .db
                .get_provider_by_id(&provider.id, app.as_str())?
                .is_some_and(|p| p.notes.as_deref() != Some(MANAGED_NOTE))
            {
                return Err(AppError::Conflict(
                    "渠道配置标识已被已有供应商使用，现有配置已保留".into(),
                ));
            }
            crate::services::channel_grok::apply_catalog(state.db.as_ref(), provider)?;
            state.db.save_provider(app.as_str(), provider)?;
            state.db.set_current_provider(app.as_str(), &provider.id)?;
        } else {
            upsert_projection(state, app, provider.clone())?;
        }
    }
    if *app == AppType::OpenClaw {
        if let Some((provider, model)) = selected_native_model(&plans, default_route, gateway) {
            let key = "channel_center_managed_openclaw";
            let old: Vec<String> = state
                .db
                .get_setting(key)?
                .map(|raw| {
                    serde_json::from_str(&raw)
                        .map_err(|_| AppError::Config("渠道托管目录记录无法解析".into()))
                })
                .transpose()?
                .unwrap_or_default();
            let owned: Vec<String> = old
                .into_iter()
                .filter(|id| {
                    state
                        .db
                        .get_provider_by_id(id, "openclaw")
                        .ok()
                        .flatten()
                        .is_some_and(|p| p.notes.as_deref() == Some(MANAGED_NOTE))
                })
                .collect();
            let live = crate::openclaw_config::read_openclaw_config()?;
            let defaults = project_openclaw_defaults(
                live.pointer("/agents/defaults")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                &plans,
                &owned,
                &format!("{}/{}", provider.id, model),
            )?;
            crate::openclaw_config::set_agents_defaults(&defaults)?;
        }
    }
    if *app == AppType::Hermes {
        if let Some((provider, _)) = selected_native_model(&plans, default_route, gateway) {
            crate::hermes_config::apply_switch_defaults(&provider.id, &provider.settings_config)?;
        }
    }
    if let Some((provider, model)) = selected_native_model(&plans, default_route, gateway) {
        match app {
            AppType::OpenCode => crate::opencode_config::set_default_model(&provider.id, &model)?,
            AppType::Pi => crate::pi_config::set_pi_default_model(&provider.id, &model)?,
            _ => {}
        }
    }
    if app.is_additive_mode() {
        reconcile_managed(state, app, &ids)?;
    }
    Ok(())
}

fn project_openclaw_defaults(
    mut defaults: Value,
    plans: &[Provider],
    managed_ids: &[String],
    default: &str,
) -> Result<crate::openclaw_config::OpenClawAgentsDefaults, AppError> {
    let root = defaults.as_object_mut().ok_or_else(|| {
        AppError::Config("OpenClaw agents.defaults 必须是对象，原配置已保留".into())
    })?;
    let mut refs = BTreeMap::new();
    for provider in plans {
        for model in provider
            .settings_config
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = model.get("id").and_then(Value::as_str) {
                refs.insert(
                    format!("{}/{id}", provider.id),
                    model
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                );
            }
        }
    }
    let was_managed = |reference: &str| {
        reference
            .split_once('/')
            .is_some_and(|(id, _)| managed_ids.iter().any(|owned| owned == id))
    };
    if let Some(catalog) = root.get_mut("models") {
        let catalog = catalog
            .as_object_mut()
            .ok_or_else(|| AppError::Config("OpenClaw 模型目录必须是对象，原配置已保留".into()))?;
        catalog.retain(|reference, _| !was_managed(reference) || refs.contains_key(reference));
        for (reference, name) in &refs {
            catalog
                .entry(reference.clone())
                .or_insert_with(|| match name {
                    Some(name) => json!({"alias":name}),
                    None => json!({}),
                });
        }
    }
    if let Some(policy) = root.get_mut("modelPolicy") {
        let policy = policy.as_object_mut().ok_or_else(|| {
            AppError::Config("OpenClaw modelPolicy 必须是对象，原配置已保留".into())
        })?;
        if let Some(allow) = policy.get_mut("allow") {
            let allow = allow.as_array_mut().ok_or_else(|| {
                AppError::Config("OpenClaw modelPolicy.allow 必须是数组，原配置已保留".into())
            })?;
            if !allow.is_empty() {
                allow.retain(|entry| {
                    entry.as_str().is_none_or(|reference| {
                        !was_managed(reference) || refs.contains_key(reference)
                    })
                });
                for reference in refs.keys() {
                    if !allow.iter().any(|entry| entry.as_str() == Some(reference)) {
                        allow.push(json!(reference));
                    }
                }
            }
        }
    }
    let previous = root.remove("model");
    let mut selected = previous
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    selected["primary"] = json!(default);
    root.insert("model".into(), selected);
    serde_json::from_value(defaults)
        .map_err(|_| AppError::Config("OpenClaw 默认模型配置无法解析，原配置已保留".into()))
}

fn apply_mcode_plans_at(
    state: &AppState,
    mut plans: Vec<Provider>,
    default_route: &str,
    gateway: bool,
    path: &std::path::Path,
) -> Result<(), AppError> {
    let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app("mcode"));
    let manifest_key = "channel_center_managed_mcode";
    let old: Vec<String> = state
        .db
        .get_setting(manifest_key)?
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| AppError::Config("渠道托管目录记录无法解析，未删除任何配置".into()))
        })
        .transpose()?
        .unwrap_or_default();
    let mut managed = Vec::new();
    let mut removed = Vec::new();
    let ids: Vec<String> = plans.iter().map(|provider| provider.id.clone()).collect();
    for id in &old {
        if let Some(mut previous) = state.db.get_provider_by_id(id, "mcode")? {
            if previous.notes.as_deref() == Some(MANAGED_NOTE) {
                managed.push(id.clone());
                if !ids.contains(id) {
                    previous
                        .meta
                        .get_or_insert_with(ProviderMeta::default)
                        .live_config_managed = Some(false);
                    removed.push(previous);
                }
            }
        }
    }
    for provider in &mut plans {
        if let Some(previous) = state.db.get_provider_by_id(&provider.id, "mcode")? {
            if previous.notes.as_deref() != Some(MANAGED_NOTE) {
                return Err(AppError::Conflict(
                    "渠道配置标识已被已有供应商使用，现有配置已保留".into(),
                ));
            }
            if !managed.contains(&provider.id) {
                managed.push(provider.id.clone());
            }
            if let (Some(existing), Some(next)) = (
                previous.settings_config.as_object(),
                provider.settings_config.as_object_mut(),
            ) {
                for (key, value) in existing {
                    next.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
            provider.created_at = previous.created_at;
            provider.sort_index = previous.sort_index;
        }
        provider
            .meta
            .get_or_insert_with(ProviderMeta::default)
            .live_config_managed = Some(true);
    }
    let (selected, model) = selected_native_model(&plans, default_route, gateway)
        .ok_or_else(|| AppError::InvalidInput("所选 Mcode 默认模型不在本次模型目录中".into()))?;
    let catalog = plans
        .iter()
        .map(|provider| (provider.id.clone(), provider.settings_config.clone()))
        .collect();
    crate::mcode_config::apply_channel_catalog(
        path,
        &catalog,
        &managed,
        &selected.id,
        &model,
        || {
            let mut conn = crate::database::lock_conn!(state.db.conn);
            let tx = conn.transaction()?;
            for provider in &plans {
                // Preserve the existing current/queue bits and endpoint rows on update.
                tx.execute(
                "INSERT INTO providers (id,app_type,name,settings_config,website_url,category,created_at,sort_index,notes,icon,icon_color,meta,in_failover_queue)
                 VALUES (?1,'mcode',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                 ON CONFLICT(id,app_type) DO UPDATE SET name=excluded.name,settings_config=excluded.settings_config,
                 website_url=excluded.website_url,category=excluded.category,created_at=excluded.created_at,
                 sort_index=excluded.sort_index,notes=excluded.notes,icon=excluded.icon,icon_color=excluded.icon_color,meta=excluded.meta",
                rusqlite::params![provider.id, provider.name, serialize(&provider.settings_config)?, provider.website_url,
                    provider.category, provider.created_at, provider.sort_index, provider.notes, provider.icon,
                    provider.icon_color, serialize(&provider.meta)?, provider.in_failover_queue],
            )?;
            }
            for provider in &removed {
                tx.execute(
                    "UPDATE providers SET meta=?1 WHERE id=?2 AND app_type='mcode' AND notes=?3",
                    rusqlite::params![serialize(&provider.meta)?, provider.id, MANAGED_NOTE],
                )?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO settings (key,value) VALUES (?1,?2)",
                rusqlite::params![manifest_key, serialize(&ids)?],
            )?;
            tx.commit()?;
            Ok(())
        },
    )
}

fn selected_native_model<'a>(
    plans: &'a [Provider],
    route: &str,
    gateway: bool,
) -> Option<(&'a Provider, String)> {
    let (channel, model) = route.split_once('/')?;
    let selected = if gateway { route } else { model };
    let provider = plans.iter().find(|p| {
        let belongs = gateway
            || p.meta
                .as_ref()
                .and_then(|meta| meta.api_format.as_deref())
                .is_some_and(|protocol| {
                    p.id == format!("tai-channel-{channel}-{}", protocol.replace('_', "-"))
                });
        let models = p.settings_config.get("models");
        belongs
            && (models
                .and_then(Value::as_object)
                .is_some_and(|m| m.contains_key(selected))
                || models.and_then(Value::as_array).is_some_and(|models| {
                    models
                        .iter()
                        .any(|m| m.get("id").and_then(Value::as_str) == Some(selected))
                }))
    })?;
    Some((provider, selected.into()))
}

fn commit_applied(db: &Database, snapshot: &ChannelCenterSnapshot) -> Result<(), AppError> {
    let mut conn = crate::database::lock_conn!(db.conn);
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR REPLACE INTO settings (key,value) VALUES (?1,?2)",
        rusqlite::params![APPLIED_KEY, serialize(snapshot)?],
    )?;
    tx.execute(
        "INSERT OR REPLACE INTO settings (key,value) VALUES (?1,'true')",
        [BACKGROUND_KEY],
    )?;
    tx.commit()?;
    Ok(())
}

fn prepare_gateway_write(db: &Database, revision: u64) -> Result<(), AppError> {
    // The immutable catalog must exist before a client may acquire its URL.
    load_catalog(db, revision)?;
    db.set_setting(BACKGROUND_KEY, "true")
}

async fn ensure_gateway_running(
    state: &AppState,
    expected: &str,
    revision: u64,
) -> Result<(), AppError> {
    let info = state.proxy_service.start().await.map_err(|error| {
        AppError::Message(format!(
            "本地渠道服务无法启动：{}",
            crate::error_for_log(&error)
        ))
    })?;
    let actual = crate::proxy::channel_gateway::gateway_catalog_base_url(
        &info.address,
        info.port,
        revision,
    )?;
    if actual != expected {
        return Err(AppError::Conflict(
            "本地渠道端口已变化，客户端配置尚未确认生效，请重新应用".into(),
        ));
    }
    Ok(())
}

async fn apply_external_target(
    state: &AppState,
    snapshot: &ChannelCenterSnapshot,
    target: &str,
    gateway: &(String, String),
) -> Result<String, AppError> {
    prepare_gateway_write(state.db.as_ref(), snapshot.revision)?;
    ensure_gateway_running(state, &gateway.0, snapshot.revision).await?;
    let base = crate::proxy::channel_gateway::catalog_client_base_url(&gateway.0, target)?;
    let source = aggregate_source(snapshot, &base, &gateway.1, "openai_chat");
    let default = snapshot.default_model.clone().ok_or_else(|| {
        AppError::InvalidInput("没有可用的默认 API 模型，客户端配置未改动".into())
    })?;
    let owned_target = target.to_string();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        super::external_agent_config::apply(&owned_target, &source, &default)
    })
    .await
    .map_err(|_| AppError::Message("客户端配置任务执行失败".into()))??;
    ensure_gateway_running(state, &gateway.0, snapshot.revision).await?;
    commit_applied(state.db.as_ref(), snapshot)?;
    Ok(outcome.message)
}

/// Every selected target gets an independent result. A successful DB save alone is not success.
pub async fn apply(
    state: &AppState,
    expected_revision: Option<u64>,
) -> Result<ChannelApplyReport, AppError> {
    apply_to(state, expected_revision, None, false).await
}

pub(super) async fn apply_to(
    state: &AppState,
    expected_revision: Option<u64>,
    target: Option<&str>,
    force_route: bool,
) -> Result<ChannelApplyReport, AppError> {
    let _guard = apply_lock().lock().await;
    let snapshot = load(state.db.as_ref())?;
    let targets = target
        .map(|app| vec![app.to_owned()])
        .unwrap_or_else(|| snapshot.targets.clone());
    if expected_revision.is_some_and(|expected| expected != snapshot.revision) {
        return Err(AppError::Conflict(
            "渠道已在另一处修改，请重新加载后再应用；客户端配置尚未改动".into(),
        ));
    }
    validate(&snapshot)?;
    let enabled: Vec<_> = snapshot.channels.iter().filter(|c| c.enabled).collect();
    let models: Vec<_> = enabled
        .iter()
        .flat_map(|channel| {
            channel
                .models
                .iter()
                .filter(|m| m.available())
                .map(move |m| (*channel, m))
        })
        .collect();
    let default = snapshot
        .default_model
        .clone()
        .or_else(|| models.first().map(|(c, m)| route_id(c, m)));
    let mut report = ChannelApplyReport {
        results: Vec::new(),
        requires_background: state.db.get_bool_flag(BACKGROUND_KEY)?,
    };
    if models.is_empty() {
        for app in &targets {
            report.results.push(ChannelApplyResult {
                app: app.clone(),
                status: "skipped".into(),
                message: "没有已启用且适合工具调用的模型，客户端配置未改动".into(),
            });
        }
        return Ok(report);
    }
    for channel in &enabled {
        if channel.models.iter().any(|m| m.available()) {
            if channel.auth_kind == "api_key" {
                validated_url(&channel.base_url)?;
                if channel.api_key.trim().is_empty() {
                    return Err(AppError::InvalidInput(
                        "已启用的渠道缺少 API Key，请先补齐".into(),
                    ));
                }
            } else if channel
                .account_id
                .as_deref()
                .is_none_or(|id| id.trim().is_empty())
            {
                return Err(AppError::InvalidInput("请为登录渠道选择已授权账户".into()));
            }
        }
    }
    let default = default.unwrap();
    let api_snapshot = api_catalog_snapshot(&snapshot);
    let api_models: Vec<_> = api_snapshot
        .channels
        .iter()
        .filter(|channel| channel.enabled)
        .flat_map(|channel| {
            channel
                .models
                .iter()
                .filter(|model| model.available())
                .map(move |model| (channel, model))
        })
        .collect();
    let native_count = models.len().saturating_sub(api_models.len());
    let any_gateway = !api_models.is_empty()
        && targets.iter().any(|target| {
            super::external_agent_config::TARGETS.contains(&target.as_str())
                || AppType::from_str(target).ok().is_some_and(|app| {
                    (force_route || native_selection_for(&snapshot, &app).is_none())
                        && needs_gateway(&api_snapshot, &app)
                })
        });
    let mut gateway_error = None;
    let gateway = if any_gateway {
        match state.proxy_service.start().await {
            Ok(info) => {
                let prepared = (|| {
                    publish_catalog(state.db.as_ref(), &api_snapshot)?;
                    let base = crate::proxy::channel_gateway::gateway_catalog_base_url(
                        &info.address,
                        info.port,
                        snapshot.revision,
                    )?;
                    Ok::<_, AppError>((base, gateway_token(state.db.as_ref())?))
                })();
                match prepared {
                    Ok(gateway) => Some(gateway),
                    Err(error) => {
                        gateway_error = Some(format!(
                            "本地渠道服务不可用：{}",
                            crate::error_for_log(&error.to_string())
                        ));
                        None
                    }
                }
            }
            Err(error) => {
                gateway_error = Some(format!(
                    "本地渠道服务启动失败：{}",
                    crate::error_for_log(&error)
                ));
                None
            }
        }
    } else {
        None
    };
    for target in &targets {
        if super::external_agent_config::TARGETS.contains(&target.as_str()) {
            let (status, message) = if api_models.is_empty() {
                ("skipped", "此工具没有可用 API 渠道；原生登录账号只用于对应工具，配置未改动".into())
            } else if let Some(gateway) = &gateway {
                match apply_external_target(state, &api_snapshot, target, gateway).await {
                    Ok(message) => ("success", message),
                    Err(error) => ("error", crate::error_for_log(&error.to_string())),
                }
            } else {
                ("error", gateway_error.clone().unwrap_or_else(|| "本地渠道服务不可用".into()))
            };
            report.results.push(ChannelApplyResult { app: target.clone(), status: status.into(), message });
            continue;
        }
        let app = AppType::from_str(target)?;
        if let Some(native) = native_selection_for(&snapshot, &app).filter(|_| !force_route) {
            let checked_app = app.clone();
            if let Err(error) =
                prepare_native_login_mode(state, &app, move || validate_native_login(&checked_app))
                    .await
            {
                report.results.push(ChannelApplyResult {
                    app: target.clone(),
                    status: "error".into(),
                    message: crate::error_for_log(&error.to_string()),
                });
                continue;
            }
            let native = native.clone();
            let native_name = native.name.clone();
            let owned_state = state.clone();
            let owned_app = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                apply_native_login(&owned_state, &owned_app, &native)
            })
            .await
            .map_err(|_| AppError::Message("客户端配置任务执行失败".into()))
            .and_then(|result| result);
            let (status, message) = match result {
                Ok(()) => ("success", format!("已切换到 {native_name}，模型和额度由原生工具的登录账号维护；API 渠道需选 API 模型为默认后另行应用")),
                Err(error) => ("error", crate::error_for_log(&error.to_string())),
            };
            report.results.push(ChannelApplyResult {
                app: target.clone(),
                status: status.into(),
                message,
            });
            continue;
        }
        if api_models.is_empty() {
            report.results.push(ChannelApplyResult {app:target.clone(),status:"skipped".into(),message:"所选原生登录账号仅可用于对应的 Claude Code 或 Gemini CLI；此工具没有可用 API 渠道，配置未改动".into()});
            continue;
        }
        let use_gateway = needs_gateway(&api_snapshot, &app);
        if use_gateway && gateway.is_none() {
            report.results.push(ChannelApplyResult {
                app: target.clone(),
                status: "error".into(),
                message: gateway_error
                    .clone()
                    .unwrap_or_else(|| "本地渠道服务不可用".into()),
            });
            continue;
        }
        let mut configured_count = api_models.len();
        let mut effective_default = api_snapshot
            .default_model
            .clone()
            .expect("nonempty API catalog");
        let plans = if use_gateway {
            let (base, token) = gateway.as_ref().expect("gateway started");
            let protocol = if matches!(app, AppType::Claude | AppType::ClaudeDesktop) {
                "anthropic"
            } else if matches!(app, AppType::Codex | AppType::GrokBuild) {
                "openai_responses"
            } else if app == AppType::Gemini {
                "gemini_native"
            } else {
                "openai_chat"
            };
            let mut source = aggregate_source(&api_snapshot, base, token, protocol);
            if app == AppType::Gemini {
                let native_ids: HashSet<String> = api_models
                    .iter()
                    .filter(|(channel, model)| {
                        channel.auth_kind == "api_key"
                            && effective_protocol(channel, model) == "gemini_native"
                    })
                    .map(|(channel, model)| route_id(channel, model))
                    .collect();
                source.models.retain(|model| native_ids.contains(&model.id));
                configured_count = source.models.len();
                if source.models.is_empty() {
                    report.results.push(ChannelApplyResult{app:target.clone(),status:"skipped".into(),message:"Gemini CLI 仅能使用原生 Gemini 协议；所选模型没有符合的上游，配置未改动".into()});
                    continue;
                }
            }
            source
                .models
                .sort_by_key(|model| model.id != effective_default);
            if !source
                .models
                .iter()
                .any(|model| model.id == effective_default)
            {
                effective_default = source.models[0].id.clone();
            }
            gateway_provider(&app, &source, &effective_default).map(|p| vec![p])
        } else {
            native_plans(&api_snapshot, &app)
        };
        let plans = match plans {
            Ok(plans) => plans,
            Err(error) => {
                report.results.push(ChannelApplyResult {
                    app: target.clone(),
                    status: "skipped".into(),
                    message: error.to_string(),
                });
                continue;
            }
        };
        if use_gateway {
            // Exiting an older route can stop the shared listener. Pin the
            // published gateway before any old-mode write or native profile write.
            if let Err(error) = prepare_gateway_write(state.db.as_ref(), snapshot.revision) {
                report.results.push(ChannelApplyResult {
                    app: target.clone(),
                    status: "error".into(),
                    message: error.to_string(),
                });
                continue;
            }
        }
        if app.supports_local_proxy() && crate::mode::current::is_proxy(&app) {
            if let Err(error) = crate::mode::controller::exit(state, &app).await {
                report.results.push(ChannelApplyResult {
                    app: target.clone(),
                    status: "error".into(),
                    message: format!("旧应用路由无法退出：{}", crate::error_for_log(&error)),
                });
                continue;
            }
        }
        if use_gateway {
            if let Err(error) =
                ensure_gateway_running(state, &gateway.as_ref().unwrap().0, snapshot.revision).await
            {
                report.results.push(ChannelApplyResult {
                    app: target.clone(),
                    status: "error".into(),
                    message: error.to_string(),
                });
                continue;
            }
        }
        let owned_state = state.clone();
        let owned_app = app.clone();
        let owned_default = effective_default.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            apply_plans(&owned_state, &owned_app, plans, &owned_default, use_gateway)
        })
        .await
        .map_err(|_| AppError::Message("客户端配置任务执行失败".into()))
        .and_then(|r| r);
        match result {
            Ok(()) => {
                if use_gateway {
                    let healthy = ensure_gateway_running(
                        state,
                        &gateway.as_ref().unwrap().0,
                        snapshot.revision,
                    )
                    .await
                    .and_then(|_| commit_applied(state.db.as_ref(), &api_snapshot));
                    if let Err(error) = healthy {
                        report.results.push(ChannelApplyResult {
                            app: target.clone(),
                            status: "error".into(),
                            message: error.to_string(),
                        });
                        continue;
                    }
                    report.requires_background = true;
                }
                let mut message = if app == AppType::Gemini {
                    format!("已配置默认模型，原生目录包含 {configured_count} 个模型。Gemini CLI 菜单显示取决于版本；可手动 /model channelId/modelId，其他协议未配置")
                } else if app == AppType::ClaudeDesktop {
                    format!("已配置 {configured_count} 个模型，请完全退出并重启 Claude Desktop，在模型菜单选择需要的模型")
                } else {
                    format!(
                        "已配置 {configured_count} 个模型与默认模型{}",
                        if app == AppType::Codex {
                            "，请重启 Codex 刷新列表"
                        } else {
                            "，请在工具里刷新模型列表"
                        }
                    )
                };
                if native_count > 0 {
                    message.push_str(&format!("；已过滤 {native_count} 个原生账号入口，它们仅能在对应工具以原生登录模式使用"));
                }
                if effective_default != default {
                    message.push_str(&format!("；本工具使用默认模型 {effective_default}"));
                }
                report.results.push(ChannelApplyResult {
                    app: target.clone(),
                    status: "success".into(),
                    message,
                });
            }
            Err(error) => report.results.push(ChannelApplyResult {
                app: target.clone(),
                status: "error".into(),
                message: crate::error_for_log(&error.to_string()),
            }),
        }
    }
    report.requires_background = state.db.get_bool_flag(BACKGROUND_KEY)?;
    let secrets: Vec<String> = snapshot
        .channels
        .iter()
        .map(|channel| channel.api_key.clone())
        .chain(gateway.as_ref().map(|(_, token)| token.clone()))
        .collect();
    for result in &mut report.results {
        result.message = crate::redact_known_secrets_strict(&result.message, &secrets);
    }
    Ok(report)
}

async fn discover_gemini_models(channel: &ChannelSource) -> Result<Vec<ChannelModel>, AppError> {
    let base = channel.base_url.trim_end_matches('/');
    let root = if base.ends_with("/v1") || base.ends_with("/v1beta") {
        base.to_string()
    } else {
        format!("{base}/v1beta")
    };
    let endpoint = format!("{root}/models");
    let client = crate::proxy::http_client::get();
    let mut models = Vec::new();
    let mut page_token: Option<String> = None;
    let mut seen_tokens = HashSet::new();
    for _ in 0..100 {
        let mut request = client
            .get(&endpoint)
            .header("x-goog-api-key", &channel.api_key)
            .timeout(std::time::Duration::from_secs(15));
        if let Some(token) = &page_token {
            request = request.query(&[("pageToken", token)]);
        }
        let response = request
            .send()
            .await
            .map_err(|error| discovery_error(&error.to_string()))?;
        if !response.status().is_success() {
            return Err(discovery_error(&response.status().as_u16().to_string()));
        }
        let response: Value = response
            .json()
            .await
            .map_err(|_| discovery_error("parse"))?;
        let entries = response
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| discovery_error("parse"))?;
        for entry in entries {
            if entry
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .is_some_and(|methods| {
                    !methods
                        .iter()
                        .any(|m| m.as_str() == Some("generateContent"))
                })
            {
                continue;
            }
            let Some(name) = entry.get("name").and_then(Value::as_str) else {
                continue;
            };
            let mut model = blank_model(name.strip_prefix("models/").unwrap_or(name).to_string());
            model.name = entry
                .get("displayName")
                .and_then(Value::as_str)
                .map(str::to_string);
            model.context_limit = entry.get("inputTokenLimit").and_then(Value::as_u64);
            model.output_limit = entry.get("outputTokenLimit").and_then(Value::as_u64);
            models.push(model);
        }
        page_token = response
            .get("nextPageToken")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        match &page_token {
            None => return Ok(models),
            Some(token) if !seen_tokens.insert(token.clone()) => {
                return Err(AppError::Message(
                    "上游模型目录分页重复，请手动添加模型".into(),
                ))
            }
            _ => {}
        }
    }
    Err(AppError::Message(
        "上游模型目录超过分页上限，请缩小目录或手动添加模型".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str) -> ChannelSource {
        ChannelSource {
            id: id.into(),
            name: format!("Channel {id}"),
            base_url: "https://example.test/v1".into(),
            api_key: "test-fixture-key".into(),
            auth_kind: "api_key".into(),
            account_id: None,
            protocol: "openai_chat".into(),
            models: vec![blank_model("model-a".into()), blank_model("model-b".into())],
            enabled: true,
        }
    }
    fn snapshot() -> ChannelCenterSnapshot {
        ChannelCenterSnapshot {
            channels: vec![source("one")],
            default_model: Some("one/model-b".into()),
            ..Default::default()
        }
    }

    #[test]
    fn sponsored_channel_pins_credentials_to_the_lolicode_origin_and_clears_supplied_keys() {
        let mut sponsored = source(super::super::lolicode_relay::CHANNEL_ID);
        sponsored.base_url = super::super::lolicode_relay::BASE_URL.into();
        sponsored.auth_kind = "lolicode_account".into();
        sponsored.account_id = Some("42".into());
        assert!(validate_channel(&sponsored).is_ok());
        let db = Database::memory().unwrap();
        save(&db, ChannelCenterSnapshot { channels: vec![sponsored.clone()], ..Default::default() }).unwrap();
        assert!(load(&db).unwrap().channels[0].api_key.is_empty());
        sponsored.base_url = "https://untrusted.example/v1".into();
        assert!(validate_channel(&sponsored).is_err());
        sponsored.base_url = super::super::lolicode_relay::BASE_URL.into();
        sponsored.models[0].protocol = Some("openai_responses".into());
        assert!(validate_channel(&sponsored).is_err());
    }

    #[test]
    fn selected_context_windows_survive_refresh_and_project_to_agent_and_external_clients() {
        let mut saved = source("multi");
        saved.models = parse_channel_catalog(&json!({"data":[{"id":"model","context_window":128000,"context_windows":[128000,1000000]}]})).unwrap();
        saved.models[0].selected_context_limit = Some(1000000);
        let snapshot = ChannelCenterSnapshot {
            channels: vec![saved.clone()],
            ..Default::default()
        };
        validate(&snapshot).unwrap();
        let catalog = agent_catalog_from_snapshot(&snapshot);
        assert_eq!(catalog.models[0].context_limit, Some(1000000));
        assert_eq!(
            catalog.models[0].context_limits,
            Some(vec![128000, 1000000])
        );
        let provider = native_provider(
            &AppType::OpenCode,
            &saved,
            "openai_chat",
            &saved.models,
            "owned".into(),
        )
        .unwrap();
        assert!(provider.settings_config.to_string().contains("1000000"));
        let fresh = parse_channel_catalog(&json!({"data":[{"id":"model","context_window":128000,"context_windows":[128000,1000000]}]})).unwrap();
        assert_eq!(
            merge_discovered(&saved.models, fresh)[0].selected_context_limit,
            Some(1000000)
        );
        let smaller = parse_channel_catalog(
            &json!({"data":[{"id":"model","context_window":128000,"context_windows":[128000]}]}),
        )
        .unwrap();
        assert_eq!(
            merge_discovered(&saved.models, smaller)[0].selected_context_limit,
            None
        );
        saved.models[0].selected_context_limit = Some(777777);
        assert!(validate_channel(&saved).is_err());
    }

    #[test]
    fn external_targets_roundtrip_without_changing_client_files() {
        let db = Database::memory().unwrap();
        let mut configured = snapshot();
        configured.targets = super::super::external_agent_config::TARGETS.iter().map(|target| target.to_string()).collect();
        save(&db, configured).unwrap();
        assert_eq!(load(&db).unwrap().targets, ["workbuddy", "deepseek-harness", "zcode", "mimocode", "codebuddy"]);
        assert!(db.get_setting(APPLIED_KEY).unwrap().is_none());
    }

    #[test]
    fn model_reasoning_capabilities_save_project_and_refresh_without_claiming_support() {
        let db = Database::memory().unwrap();
        let mut configured = snapshot();
        configured.channels[0].models[0].reasoning_efforts = Some(vec!["low".into()]);
        configured.channels[0].models[0].reasoning_effort_source = Some("relay:model-directory".into());
        save(&db, configured).unwrap();
        let saved = load(&db).unwrap();
        let catalog = agent_catalog(&db).unwrap();
        let model = catalog.models.iter().find(|model| model.model_id == "one/model-a").unwrap();
        assert_eq!(model.reasoning_efforts, Some(vec!["low".into()]));
        assert_eq!(model.reasoning_effort_source.as_deref(), Some("relay:model-directory"));
        let refreshed = merge_discovered(&saved.channels[0].models, vec![blank_model("model-a".into())]);
        assert_eq!(refreshed[0].reasoning_efforts, Some(vec!["low".into()]));
        assert!(db.get_setting(APPLIED_KEY).unwrap().is_none(), "saving channel capabilities must not write external tool configuration");
    }

    #[test]
    fn agent_catalog_is_read_only_and_does_not_migrate_legacy_providers() {
        let db = Database::memory().unwrap();
        let legacy = crate::provider::UniversalProvider::new(
            "agent-readonly-fixture".into(),
            "Legacy".into(),
            "custom".into(),
            "https://example.test/v1".into(),
            "legacy-private-key".into(),
        );
        db.save_universal_provider(&legacy).unwrap();
        let before = db.get_all_universal_providers().unwrap();
        let catalog = agent_catalog(&db).unwrap();
        assert!(catalog.models.is_empty());
        assert!(catalog.default_model.is_none());
        assert!(db.get_setting(SETTINGS_KEY).unwrap().is_none());
        assert!(db.get_setting(TOKEN_KEY).unwrap().is_none());
        assert!(db.get_setting(APPLIED_KEY).unwrap().is_none());
        assert!(db.get_setting(BACKGROUND_KEY).unwrap().is_none());
        assert_eq!(
            serialize(&db.get_all_universal_providers().unwrap()).unwrap(),
            serialize(&before).unwrap()
        );
        db.set_setting(SETTINGS_KEY, "{invalid-private-data")
            .unwrap();
        let error = agent_catalog(&db).err().unwrap().to_string();
        assert!(!error.contains("invalid-private-data"));
        assert_eq!(
            db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
            Some("{invalid-private-data")
        );
        assert!(!db.get_bool_flag(BACKGROUND_KEY).unwrap());
    }

    #[test]
    fn agent_catalog_projects_all_managed_sources_without_credentials_or_native_accounts() {
        let db = Database::memory().unwrap();
        let mut saved = snapshot();
        saved.revision = 17;
        saved.channels[0].models[0].id = "vendor/model-a".into();
        saved.channels[0].models[0].context_limit = Some(131072);
        saved.channels[0].models[0].output_limit = Some(8192);
        let mut no_tools = blank_model("no-tools".into());
        no_tools.supports_tools = Some(false);
        saved.channels[0].models.push(no_tools);
        let mut disabled = source("disabled");
        disabled.enabled = false;
        saved.channels.push(disabled);
        for kind in ["github_copilot", "codex_oauth", "xai_oauth", "zhipu_oauth"] {
            let mut managed = source(kind);
            managed.auth_kind = kind.into();
            managed.account_id = Some(format!("selected-{kind}"));
            managed.api_key.clear();
            if let Some((base, protocol)) = managed_subscription_route(kind) {
                managed.base_url = base.into();
                managed.protocol = protocol.into();
            }
            saved.channels.push(managed);
        }
        saved
            .channels
            .push(native_subscription_channel("claude").unwrap());
        saved
            .channels
            .push(native_subscription_channel("gemini").unwrap());
        saved.default_model = Some("claude-native/native-default".into());
        db.set_setting(SETTINGS_KEY, &serialize(&saved).unwrap())
            .unwrap();
        let catalog = agent_catalog(&db).unwrap();
        assert_eq!(catalog.revision, 17);
        assert_eq!(catalog.models.len(), 10);
        assert_eq!(
            catalog.default_model.as_deref(),
            Some("lolicode/one/vendor/model-a")
        );
        assert_eq!(catalog.excluded_sources.len(), 2);
        assert!(catalog.models.iter().all(|model| {
            model.provider_id == "lolicode"
                && model.id == format!("lolicode/{}", model.model_id)
                && !model.model_id.contains("native-default")
                && !model.model_id.starts_with("disabled/")
                && !model.model_id.ends_with("/no-tools")
        }));
        for kind in ["github_copilot", "codex_oauth", "xai_oauth", "zhipu_oauth"] {
            assert!(catalog
                .models
                .iter()
                .any(|model| { model.model_id == format!("{kind}/model-a") }));
        }
        let exposed = serialize(&catalog).unwrap();
        assert!(!exposed.contains("test-fixture-key"));
        assert!(!exposed.contains("selected-"));
        assert!(!exposed.contains("example.test"));
        assert!(!exposed.contains("apiKey"));
        let config = agent_opencode_v2_config(
            &catalog,
            "http://127.0.0.1:1234/tai/catalogs/17/v1",
            "agent-local-token-fixture",
        )
        .unwrap();
        let provider = &config["providers"]["lolicode"];
        assert_eq!(provider["package"], "@ai-sdk/openai-compatible");
        assert_eq!(provider["settings"]["apiKey"], "agent-local-token-fixture");
        assert_eq!(
            provider["models"]["one/vendor/model-a"]["modelID"],
            "one/vendor/model-a"
        );
        assert_eq!(
            provider["models"]["one/vendor/model-a"]["limit"]["context"],
            131072
        );
        assert_eq!(
            provider["models"]["one/vendor/model-a"]["limit"]["output"],
            8192
        );
        assert!(provider["models"]["one/model-b"].get("limit").is_none());
        assert!(provider["models"]["one/model-b"]
            .get("capabilities")
            .is_none());
        assert!(config.get("provider").is_none());
        assert_eq!(config["model"], "lolicode/one/vendor/model-a");
        assert_eq!(config["default_agent"], "build");
        assert_eq!(config["update"], "disable");
        assert_eq!(config["share"], "disabled");
        assert_eq!(config["snapshots"], true);
        let permissions = config["permissions"].as_array().unwrap();
        for action in ["shell", "external_directory"] {
            assert_eq!(
                permissions
                    .iter()
                    .rev()
                    .find(|rule| rule["action"] == action)
                    .unwrap()["effect"],
                "ask"
            );
        }
        assert!(!permissions.iter().any(|rule| rule["action"] == "bash"));
        assert_eq!(config["experimental"]["policies"][0]["effect"], "deny");
        assert_eq!(
            config["experimental"]["policies"][1]["resource"],
            "lolicode"
        );
        assert!(!serialize(&config).unwrap().contains("test-fixture-key"));
        assert_eq!(agent_source_snapshot(&db).unwrap(), saved);
    }

    #[test]
    fn agent_catalog_rejects_retained_managed_tokens_and_invalid_engine_limits() {
        let db = Database::memory().unwrap();
        let mut saved = snapshot();
        saved.channels[0].auth_kind = "github_copilot".into();
        saved.channels[0].account_id = Some("account-fixture".into());
        saved.channels[0].api_key = "retained-short-token-fixture".into();
        db.set_setting(SETTINGS_KEY, &serialize(&saved).unwrap())
            .unwrap();
        let error = agent_catalog(&db).err().unwrap().to_string();
        assert!(!error.contains("retained-short-token-fixture"));
        assert!(!db.get_bool_flag(BACKGROUND_KEY).unwrap());
        let mut saved = snapshot();
        saved.channels[0].models[0].context_limit = Some(u64::MAX);
        let catalog = agent_catalog_from_snapshot(&saved);
        assert!(agent_opencode_v2_config(&catalog, "http://127.0.0.1/v1", "private").is_err());
        let empty = agent_catalog_from_snapshot(&ChannelCenterSnapshot::default());
        assert!(agent_opencode_v2_config(&empty, "http://127.0.0.1/v1", "private").is_err());
    }

    #[test]
    fn agent_gateway_publication_and_background_acquisition_are_atomic_and_rollback_on_failure() {
        let db = Database::memory().unwrap();
        let mut catalog = snapshot();
        catalog.revision = 9;
        let before_applied = snapshot();
        commit_applied(&db, &before_applied).unwrap();
        db.set_setting(BACKGROUND_KEY, "false").unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("CREATE TRIGGER fail_agent_background BEFORE INSERT ON settings WHEN NEW.key='channel_center_requires_background' BEGIN SELECT RAISE(ABORT,'fixture marker failure'); END;").unwrap();
        }
        assert!(prepare_agent_gateway_write(&db, &catalog).is_err());
        assert!(db
            .get_setting("channel_center_catalog_9")
            .unwrap()
            .is_none());
        assert!(!db.get_bool_flag(BACKGROUND_KEY).unwrap());
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("DROP TRIGGER fail_agent_background;")
                .unwrap();
        }
        {
            let _cancelled = prepare_agent_gateway_write(&db, &catalog).unwrap();
            assert!(db.get_bool_flag(BACKGROUND_KEY).unwrap());
        }
        assert_eq!(
            db.get_setting(BACKGROUND_KEY).unwrap().as_deref(),
            Some("false")
        );
        assert_eq!(load_catalog(&db, 9).unwrap(), catalog);
        assert_eq!(load_applied(&db).unwrap(), before_applied);
        let mut changed = catalog.clone();
        changed.channels[0].api_key = "changed-api-fixture".into();
        assert!(prepare_agent_gateway_write(&db, &changed).is_err());
        assert!(!db.get_bool_flag(BACKGROUND_KEY).unwrap());
        assert_eq!(load_catalog(&db, 9).unwrap(), catalog);
        db.set_setting(BACKGROUND_KEY, "1").unwrap();
        drop(prepare_agent_gateway_write(&db, &catalog).unwrap());
        assert_eq!(
            db.get_setting(BACKGROUND_KEY).unwrap().as_deref(),
            Some("1")
        );
        let missing = Database::memory().unwrap();
        drop(prepare_agent_gateway_write(&missing, &catalog).unwrap());
        assert!(missing.get_setting(BACKGROUND_KEY).unwrap().is_none());
    }

    #[tokio::test]
    async fn agent_only_catalog_restores_gateway_without_applying_external_clients() {
        use std::sync::Arc;
        let db = Arc::new(Database::memory().unwrap());
        let credentials = tempfile::tempdir().unwrap();
        let state = AppState {
            db: db.clone(),
            proxy_service: crate::services::ProxyService::new(db.clone()),
            usage_cache: Arc::new(crate::services::UsageCache::new()),
            codex_oauth_manager: Arc::new(
                crate::proxy::providers::codex_oauth_auth::CodexOAuthManager::new(
                    credentials.path().to_path_buf(),
                ),
            ),
        };
        let mut proxy = db.get_global_proxy_config().await.unwrap();
        proxy.listen_address = "127.0.0.1".into();
        proxy.listen_port = 0;
        db.update_global_proxy_config(proxy).await.unwrap();
        let mut saved = snapshot();
        saved.revision = 22;
        saved
            .channels
            .push(native_subscription_channel("claude").unwrap());
        db.set_setting(SETTINGS_KEY, &serialize(&saved).unwrap())
            .unwrap();
        let expected = api_catalog_snapshot(&saved);
        // Occupy a local port to exercise a real start failure without contacting
        // any upstream or using the user's listener or credentials.
        let occupied = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let mut proxy = db.get_global_proxy_config().await.unwrap();
        proxy.listen_port = occupied.local_addr().unwrap().port();
        db.update_global_proxy_config(proxy).await.unwrap();
        db.set_setting(BACKGROUND_KEY, "false").unwrap();
        assert!(prepare_agent_catalog(&state).await.is_err());
        assert!(!db.get_bool_flag(BACKGROUND_KEY).unwrap());
        assert!(db.get_setting(APPLIED_KEY).unwrap().is_none());
        assert_eq!(load_catalog(&db, 22).unwrap(), expected);
        drop(occupied);
        let mut proxy = db.get_global_proxy_config().await.unwrap();
        proxy.listen_port = 0;
        db.update_global_proxy_config(proxy).await.unwrap();
        let prepared = prepare_agent_catalog(&state).await.unwrap();
        assert_eq!(prepared.catalog.revision, 22);
        assert_eq!(
            prepared.catalog.default_model.as_deref(),
            Some("lolicode/one/model-b")
        );
        assert_eq!(load_catalog(&db, 22).unwrap(), expected);
        assert_eq!(agent_source_snapshot(&db).unwrap(), saved);
        assert!(db.get_setting(APPLIED_KEY).unwrap().is_none());
        assert!(db.get_bool_flag(BACKGROUND_KEY).unwrap());
        let settings = &prepared.config["providers"]["lolicode"]["settings"];
        let base = settings["baseURL"].as_str().unwrap();
        assert!(base.ends_with("/tai/catalogs/22/v1"));
        state.proxy_service.stop().await.unwrap();
        assert!(!state.proxy_service.is_running().await);
        restore_gateway(&state).await.unwrap();
        assert!(state.proxy_service.is_running().await);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        let response = client
            .get(format!("{base}/models"))
            .bearer_auth(settings["apiKey"].as_str().unwrap())
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["data"].as_array().unwrap().len(), 2);
        assert!(body["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|model| { !model["id"].as_str().unwrap().contains("native-default") }));
        assert!(db.get_setting(APPLIED_KEY).unwrap().is_none());
        state.proxy_service.stop().await.unwrap();
    }

    #[test]
    fn migration_keeps_original_universal_data_and_default_targets() {
        let db = Database::memory().unwrap();
        let mut legacy = crate::provider::UniversalProvider::new(
            "legacy".into(),
            "Legacy".into(),
            "newapi".into(),
            "https://example.test".into(),
            "test-fixture-key".into(),
        );
        legacy.models.codex = Some(crate::provider::CodexModelConfig {
            model: Some("old-model".into()),
            reasoning_effort: None,
        });
        db.save_universal_provider(&legacy).unwrap();
        let before = db.get_setting("universal_providers").unwrap();
        let migrated = load(&db).unwrap();
        assert_eq!(migrated.targets, vec!["opencode", "hermes", "openclaw"]);
        assert_eq!(migrated.channels[0].models[0].id, "old-model");
        assert_eq!(db.get_setting("universal_providers").unwrap(), before);
        assert_eq!(load(&db).unwrap(), migrated);
    }

    #[test]
    fn migration_recognizes_official_native_protocol_without_requiring_metadata() {
        let db = Database::memory().unwrap();
        let mut legacy = crate::provider::UniversalProvider::new(
            "legacy-gemini".into(),
            "Gemini".into(),
            "custom".into(),
            "https://generativelanguage.googleapis.com".into(),
            "fixture-key".into(),
        );
        legacy.meta = None;
        legacy.models.gemini = Some(crate::provider::GeminiModelConfig {
            model: Some("gemini-fixture".into()),
        });
        db.save_universal_provider(&legacy).unwrap();
        let migrated = load(&db).unwrap();
        assert_eq!(migrated.channels[0].protocol, "gemini_native");
        assert_eq!(migrated.channels[0].models[0].id, "gemini-fixture");
        assert!(db
            .get_all_universal_providers()
            .unwrap()
            .contains_key("legacy-gemini"));
        let db_invalid = Database::memory().unwrap();
        legacy.base_url = "invalid legacy endpoint".into();
        db_invalid.save_universal_provider(&legacy).unwrap();
        let preserved = load(&db_invalid).unwrap();
        assert_eq!(preserved.channels[0].base_url, legacy.base_url);
        assert_eq!(preserved.channels[0].models[0].id, "gemini-fixture");
    }

    #[test]
    fn gateway_write_marker_survives_failed_final_commit_and_rejects_missing_catalog() {
        let db = Database::memory().unwrap();
        assert!(prepare_gateway_write(&db, 0).is_err());
        assert!(!db.get_bool_flag(BACKGROUND_KEY).unwrap());
        let catalog = snapshot();
        publish_catalog(&db, &catalog).unwrap();
        prepare_gateway_write(&db, catalog.revision).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("CREATE TRIGGER fail_applied BEFORE INSERT ON settings WHEN NEW.key='channel_center_applied' BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END;").unwrap();
        }
        assert!(commit_applied(&db, &catalog).is_err());
        assert!(db.get_bool_flag(BACKGROUND_KEY).unwrap());
        assert!(db.get_setting(APPLIED_KEY).unwrap().is_none());
        assert_eq!(load_catalog(&db, catalog.revision).unwrap(), catalog);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("CREATE TRIGGER fail_background BEFORE INSERT ON settings WHEN NEW.key='channel_center_requires_background' BEGIN SELECT RAISE(ABORT,'fixture marker failure'); END;").unwrap();
        }
        assert!(prepare_gateway_write(&db, catalog.revision).is_err());
    }

    #[test]
    fn stale_saves_are_rejected_and_drafts_do_not_change_applied_catalogs() {
        let db = Database::memory().unwrap();
        let initial = load(&db).unwrap();
        let mut draft = snapshot();
        draft.revision = initial.revision;
        save(&db, draft.clone()).unwrap();
        assert!(save(&db, draft).is_err());
        let published = load(&db).unwrap();
        assert_eq!(published.revision, 1);
        publish_catalog(&db, &published).unwrap();
        commit_applied(&db, &published).unwrap();
        let mut later = published.clone();
        later.channels[0].api_key = "new-test-fixture".into();
        save(&db, later).unwrap();
        assert_eq!(load_catalog(&db, 1).unwrap(), published);
        assert_eq!(load_applied(&db).unwrap(), published);
        assert_ne!(load(&db).unwrap(), published);
        let mut conflicting = published.clone();
        conflicting.channels[0].api_key = "conflict-fixture".into();
        assert!(publish_catalog(&db, &conflicting).is_err());
        assert_eq!(load_catalog(&db, 1).unwrap(), published);
    }

    #[test]
    fn managed_accounts_save_only_bindings_and_refresh_without_exposing_credentials() {
        let db = Database::memory().unwrap();
        let mut draft = snapshot();
        draft.channels[0].auth_kind = "zhipu_oauth".into();
        draft.channels[0].account_id = Some("account-fixture".into());
        draft.channels[0].api_key = "short-lived-fixture".into();
        save(&db, draft).unwrap();
        let saved = load(&db).unwrap();
        assert_eq!(saved.channels[0].api_key, "");
        assert!(needs_gateway(&saved, &AppType::OpenCode));
        let mut refreshed = source("unrelated-new-id");
        refreshed.api_key = "provider-internal-fixture".into();
        refreshed.models[0].context_limit = Some(32768);
        let merged = merge_managed_discovery(saved.channels[0].clone(), refreshed);
        assert_eq!(merged.id, "one");
        assert_eq!(merged.account_id.as_deref(), Some("account-fixture"));
        assert_eq!(merged.models[0].context_limit, Some(32768));
        assert!(merged.api_key.is_empty());
    }

    #[test]
    fn channel_subscription_bindings_and_default_survive_catalog_refresh_without_tokens() {
        for kind in ["codex_oauth", "xai_oauth"] {
            let db = Database::memory().unwrap();
            let mut draft = snapshot();
            let channel = &mut draft.channels[0];
            channel.auth_kind = kind.into();
            channel.account_id = Some("selected-account".into());
            channel.api_key = "must-never-be-a-harness-token".into();
            let original_default = draft.default_model.clone();
            save(&db, draft).unwrap();
            let saved = load(&db).unwrap();
            let original = saved.channels[0].clone();
            assert_eq!(saved.default_model, original_default);
            assert!(original.api_key.is_empty());
            assert_eq!(
                original.base_url,
                managed_subscription_route(kind).unwrap().0
            );
            assert!(needs_gateway(&saved, &AppType::OpenCode));
            let selected = original.models[0].id.clone();
            let merged = merge_subscription_models(
                original,
                vec![crate::services::model_fetch::FetchedModel {
                    id: selected.clone(),
                    owned_by: None,
                    metadata: Default::default(),
                }],
            )
            .unwrap();
            assert!(merged.api_key.is_empty());
            assert_eq!(merged.account_id.as_deref(), Some("selected-account"));
            assert_eq!(merged.models[0].id, selected);
            assert_eq!(
                merged.models[0].protocol.as_deref(),
                Some("openai_responses")
            );
            let serialized = serde_json::to_string(&merged).unwrap();
            assert!(!serialized.contains("must-never-be-a-harness-token"));
            let mut unbound = merged;
            unbound.account_id = None;
            assert!(validate_channel(&unbound).is_err());
        }
    }

    #[test]
    fn channel_native_subscription_is_a_tool_reference_and_never_an_api_token() {
        for tool in ["claude", "gemini"] {
            let mut channel = native_subscription_channel(tool).unwrap();
            assert!(validate_channel(&channel).is_ok());
            assert_eq!(
                native_auth_target(&channel.auth_kind).unwrap().as_str(),
                tool
            );
            assert_eq!(channel.account_id.as_deref(), Some("native"));
            assert!(channel.base_url.is_empty() && channel.api_key.is_empty());
            assert_eq!(channel.models.len(), 1);
            assert_eq!(channel.models[0].id, "native-default");
            channel.base_url = "https://example.invalid/custom".into();
            assert!(validate_channel(&channel).is_err());
        }
        assert!(native_subscription_channel("codex").is_err());
    }

    #[test]
    fn channel_managed_account_removal_fails_without_falling_back_to_another_account() {
        let mut snapshot = snapshot();
        let channel = &mut snapshot.channels[0];
        channel.auth_kind = "codex_oauth".into();
        channel.account_id = Some("selected-account".into());
        assert!(validate_managed_account_references(
            &snapshot,
            &[("codex_oauth".into(), "different-default".into())]
        )
        .is_err());
        assert!(validate_managed_account_references(
            &snapshot,
            &[("codex_oauth".into(), "selected-account".into())]
        )
        .is_ok());
        assert!(validate_managed_account_references(
            &snapshot,
            &[("xai_oauth".into(), "selected-account".into())]
        )
        .is_err());
    }

    #[test]
    fn catalog_parser_retains_explicit_capabilities_without_guessing_tools() {
        let raw = json!({"data":[
            {"id":"code","display_name":"Code","context_window":262144,"max_output_tokens":8192,"supports_tools":true,"modalities":{"input":["text","image"]},"supported_endpoints":["/responses"]},
            {"id":"text","capabilities":{"supports":{"parallel_tool_calls":false}}},
            {"id":"embedding","tool_call":false},
            {"id":7}
        ],"models":"unrelated-extension"});
        let models = parse_channel_catalog(&raw).unwrap();
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].context_limit, Some(262144));
        assert_eq!(models[0].output_limit, Some(8192));
        assert_eq!(models[0].supports_tools, Some(true));
        assert_eq!(models[0].protocol.as_deref(), Some("openai_responses"));
        assert_eq!(
            models[0].input_modalities,
            Some(vec!["text".into(), "image".into()])
        );
        assert_eq!(models[1].supports_tools, None);
        assert!(!models[2].available());
        assert_eq!(
            parse_channel_catalog(&json!({"data":[{"id":"actual","slug":"view-alias"}]})).unwrap()
                [0]
            .id,
            "actual"
        );
        assert_eq!(
            parse_channel_catalog(&json!({"models":[{"id":"view-alias","slug":"actual"}]}))
                .unwrap()[0]
                .id,
            "actual"
        );
    }

    #[test]
    fn new_metadata_wins_but_model_selection_survives_refresh() {
        let mut old = blank_model("model".into());
        old.context_limit = Some(100);
        old.reasoning_efforts = Some(vec!["medium".into()]);
        old.protocol = Some("openai_chat".into());
        old.supports_tools = Some(true);
        old.enabled = Some(false);
        let mut fresh = blank_model("model".into());
        fresh.context_limit = Some(200);
        fresh.reasoning_efforts = Some(vec!["low".into(), "high".into()]);
        fresh.protocol = Some("anthropic".into());
        fresh.supports_tools = Some(false);
        let merged = merge_discovered(&[old], vec![fresh]);
        assert_eq!(merged[0].context_limit, Some(200));
        assert_eq!(
            merged[0].reasoning_efforts,
            Some(vec!["low".into(), "high".into()])
        );
        assert_eq!(merged[0].protocol.as_deref(), Some("anthropic"));
        assert_eq!(merged[0].supports_tools, Some(false));
        assert_eq!(merged[0].enabled, Some(false));
    }

    #[test]
    fn endpoint_recognition_is_exact_and_unknown_hosts_keep_selected_protocol() {
        let mut channel = source("one");
        channel.base_url = "https://api.anthropic.com".into();
        recognize_endpoint(&mut channel).unwrap();
        assert_eq!(channel.protocol, "anthropic");
        channel.base_url = "https://generativelanguage.googleapis.com".into();
        recognize_endpoint(&mut channel).unwrap();
        assert_eq!(channel.protocol, "gemini_native");
        channel.base_url = "https://custom.test/v1/responses".into();
        recognize_endpoint(&mut channel).unwrap();
        assert_eq!(channel.protocol, "openai_responses");
        assert_eq!(channel.base_url, "https://custom.test/v1");
        channel.base_url = "https://api.anthropic.com.custom.test".into();
        channel.protocol = "openai_chat".into();
        recognize_endpoint(&mut channel).unwrap();
        assert_eq!(channel.protocol, "openai_chat");
        assert!(validated_url("https://user:pass@example.test/v1").is_err());
        assert!(validated_url("https://example.test/v1?api_key=test").is_err());
        for base in [
            "https://api.deepseek.com/anthropic",
            "https://api.moonshot.cn/anthropic",
            "https://api.moonshot.ai/anthropic",
            "https://open.bigmodel.cn/api/anthropic",
            "https://api.z.ai/api/anthropic",
        ] {
            channel.base_url = base.into();
            channel.protocol = "openai_chat".into();
            recognize_endpoint(&mut channel).unwrap();
            assert_eq!(channel.protocol, "anthropic");
            assert_eq!(channel.base_url, base);
            assert_eq!(catalog_auth_format(&channel).unwrap(), "openai-completions");
        }
        channel.base_url = "https://api.z.ai.fake.test/api/anthropic".into();
        channel.protocol = "openai_chat".into();
        recognize_endpoint(&mut channel).unwrap();
        assert_eq!(channel.protocol, "openai_chat");
        assert_eq!(
            known_catalog_fallback("https://api.z.ai/api/coding/paas/v4")
                .unwrap()
                .as_deref(),
            Some("https://api.z.ai/api/v1/models")
        );
        assert_eq!(
            known_catalog_fallback("https://open.bigmodel.cn/api/anthropic")
                .unwrap()
                .as_deref(),
            Some("https://open.bigmodel.cn/api/v1/models")
        );
        assert_eq!(
            known_catalog_fallback("https://api.z.ai/api/paas/v4").unwrap(),
            None
        );
        assert_eq!(
            known_catalog_fallback("https://api.z.ai.fake.test/api/coding/paas/v4").unwrap(),
            None
        );
    }

    #[test]
    fn native_plans_filter_disabled_models_and_resolve_exact_protocol_and_channel() {
        let mut catalog = snapshot();
        catalog.channels[0].models[1].protocol = Some("openai_responses".into());
        let mut denied = blank_model("denied".into());
        denied.supports_tools = Some(false);
        catalog.channels[0].models.push(denied);
        catalog.channels.insert(0, source("one-long"));
        for app in [
            AppType::OpenCode,
            AppType::OpenClaw,
            AppType::Hermes,
            AppType::Pi,
            AppType::Mcode,
        ] {
            let plans = native_plans(&catalog, &app).unwrap();
            let (selected, model) = selected_native_model(&plans, "one/model-b", false).unwrap();
            assert_eq!(selected.id, "tai-channel-one-openai-responses");
            assert_eq!(model, "model-b");
            assert!(!serialize(&plans).unwrap().contains("denied"));
        }
    }

    #[test]
    fn model_type_filter_retains_catalog_but_disables_declared_non_agent_tasks() {
        let models = parse_channel_catalog(&json!({"data":[
            {"id":"embed","task_type":"text_embedding","supports_tools":true},
            {"id":"speech","type":"text-to-speech"},
            {"id":"images","architecture":{"output_modalities":["image"]}},
            {"id":"nongenerative","capabilities":{"text_generation":false}},
            {"id":"tools-off","supports_tools":false},
            {"id":"vision-chat","modalities":{"output":["text","image"]}},
            {"id":"unknown-audio-name"}
        ]}))
        .unwrap();
        assert_eq!(models.len(), 7);
        for model in &models[..5] {
            assert_eq!(model.supports_tools, Some(false));
            assert_eq!(model.enabled, Some(false));
            assert!(!model.available());
        }
        assert!(models[5].available());
        assert_eq!(models[5].supports_tools, None);
        assert!(models[6].available());
        assert_eq!(models[6].supports_tools, None);
        let mut previously_selected = blank_model("tools-off".into());
        previously_selected.enabled = Some(true);
        assert_eq!(
            merge_discovered(&[previously_selected], vec![models[4].clone()])[0].enabled,
            Some(false)
        );
    }

    #[test]
    fn model_type_filter_uses_exact_official_registry_without_guessing_on_other_hosts() {
        let mut channel = source("official");
        channel.base_url = "https://api.openai.com/v1".into();
        channel.models = [
            "text-embedding-3-small",
            "whisper-1",
            "gpt-image-2",
            "sora-2",
            "gpt-4o-mini-tts",
            "gpt-audio",
            "gpt-6",
            "text-embedding-future-chat",
        ]
        .into_iter()
        .map(|id| blank_model(id.into()))
        .collect();
        exclude_known_non_agent_models(&mut channel);
        for model in &channel.models[..5] {
            assert!(!model.available());
            assert_eq!(model.enabled, Some(false));
        }
        for model in &channel.models[5..] {
            assert!(model.available());
            assert_eq!(model.supports_tools, None);
        }
        for host in [
            "https://other.test/v1",
            "https://api.openai.com.other.test/v1",
        ] {
            let mut custom = source("custom");
            custom.base_url = host.into();
            custom.models = vec![
                blank_model("text-embedding-3-small".into()),
                blank_model("gpt-image-2".into()),
            ];
            exclude_known_non_agent_models(&mut custom);
            assert!(custom.models.iter().all(ChannelModel::available));
        }
        let db = Database::memory().unwrap();
        let snapshot = ChannelCenterSnapshot {
            channels: vec![channel],
            default_model: Some("official/gpt-6".into()),
            ..Default::default()
        };
        save(&db, snapshot).unwrap();
        assert!(!load(&db).unwrap().channels[0].models[0].available());
    }

    #[test]
    fn gateway_profiles_publish_complete_catalogs_with_pinned_urls() {
        let catalog = snapshot();
        let base = "http://127.0.0.1:15721/tai/catalogs/9/v1";
        let source = aggregate_source(&catalog, base, "test-local-token", "anthropic");
        let claude = gateway_provider(&AppType::Claude, &source, "one/model-b").unwrap();
        assert_eq!(
            claude.settings_config["modelPicker"]["options"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            claude.settings_config["env"]["ANTHROPIC_BASE_URL"],
            "http://127.0.0.1:15721/tai/catalogs/9"
        );
        let desktop = gateway_provider(&AppType::ClaudeDesktop, &source, "one/model-b").unwrap();
        crate::claude_desktop_config::validate_provider(&desktop).unwrap();
        assert_eq!(desktop.meta.unwrap().claude_desktop_model_routes.len(), 2);
        let codex = gateway_provider(&AppType::Codex, &source, "one/model-b").unwrap();
        assert_eq!(
            codex.settings_config["modelCatalog"]["models"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        crate::codex_config::validate_config_toml(
            codex.settings_config["config"].as_str().unwrap(),
        )
        .unwrap();
        let actual = crate::codex_config::plan_codex_model_catalog(
            &codex.settings_config,
            codex.settings_config["config"].as_str().unwrap(),
            crate::codex_config::CodexCatalogToolProfile::NativeResponses,
        )
        .unwrap()
        .catalog
        .unwrap();
        assert_eq!(actual["models"].as_array().unwrap().len(), 2);
        assert_eq!(actual["models"][1]["slug"], "one/model-b");
        let grok = gateway_provider(&AppType::GrokBuild, &source, "one/model-b").unwrap();
        let doc = grok.settings_config["config"]
            .as_str()
            .unwrap()
            .parse::<toml::Value>()
            .unwrap();
        assert_eq!(doc["model"].as_table().unwrap().len(), 2);
        crate::grok_config::validate_config_toml(grok.settings_config["config"].as_str().unwrap())
            .unwrap();
        assert!(!serialize(&[claude, codex, grok])
            .unwrap()
            .contains("test-fixture-key"));
    }

    #[test]
    fn claude_gateway_aliases_keep_context_safety_without_a_catalog_wide_output_cap() {
        let mut catalog = snapshot();
        catalog.channels[0].models[0].context_limit = Some(32768);
        catalog.channels[0].models[0].output_limit = Some(4096);
        catalog.channels[0].models[1].context_limit = Some(1_000_000);
        catalog.channels[0].models[1].output_limit = Some(16384);
        let gateway_source = aggregate_source(
            &catalog,
            "http://127.0.0.1:1/tai/catalogs/2/v1",
            "fake-local",
            "anthropic",
        );
        let provider = gateway_provider(&AppType::Claude, &gateway_source, "one/model-b").unwrap();
        let env = &provider.settings_config["env"];
        assert_eq!(env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "32768");
        assert!(env.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS").is_none());
        let selected = env["ANTHROPIC_MODEL"].as_str().unwrap();
        assert!(selected.starts_with("tai-claude-") && !selected.starts_with("claude-"));
        assert!(selected.ends_with("[1M]"));
        for role in [
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
        ] {
            assert_eq!(env[role].as_str(), Some(selected));
        }
        let channel = &catalog.channels[0];
        let model = &channel.models[1];
        assert!(claude_route_matches(channel, model, selected));
        assert!(claude_route_matches(
            channel,
            model,
            &claude_route_id(channel, model)
        ));
        assert!(claude_route_matches(
            channel,
            model,
            &claude_gateway_alias("one/model-b")
        ));
        assert!(claude_route_matches(
            channel,
            model,
            &claude_desktop_gateway_alias("one/model-b")
        ));
        assert!(!claude_route_matches(
            channel,
            model,
            "tai-claude-one--missing"
        ));
        let mut left = source("a--b");
        left.models[0].id = "c".into();
        let mut right = source("a");
        right.models[0].id = "b--c".into();
        assert_ne!(
            claude_route_id(&left, &left.models[0]),
            claude_route_id(&right, &right.models[0])
        );
        assert_ne!(
            claude_desktop_gateway_alias("a--b/c"),
            claude_desktop_gateway_alias("a/b--c")
        );
    }

    #[test]
    fn native_login_mode_never_publishes_native_placeholders_to_other_tools() {
        let claude_native = native_subscription_channel("claude").unwrap();
        let gemini_native = native_subscription_channel("gemini").unwrap();
        let mut combined = snapshot();
        combined
            .channels
            .extend([claude_native.clone(), gemini_native.clone()]);
        combined.default_model = Some("claude-native/native-default".into());
        assert_eq!(
            native_selection_for(&combined, &AppType::Claude)
                .unwrap()
                .id,
            "claude-native"
        );
        assert_eq!(
            native_selection_for(&combined, &AppType::Gemini)
                .unwrap()
                .id,
            "gemini-native"
        );
        assert!(native_selection_for(&combined, &AppType::ClaudeDesktop).is_none());
        assert!(native_selection_for(&combined, &AppType::OpenCode).is_none());
        let api = api_catalog_snapshot(&combined);
        assert_eq!(api.channels.len(), 1);
        assert_eq!(api.default_model.as_deref(), Some("one/model-a"));
        assert_eq!(
            native_plans(&combined, &AppType::Pi).unwrap()[0].settings_config["models"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let provider = native_login_provider(&AppType::Claude, &claude_native).unwrap();
        assert_eq!(provider.category.as_deref(), Some("official"));
        let live = json!({"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1/tai/catalogs/1","ANTHROPIC_AUTH_TOKEN":"fake-local","ANTHROPIC_MODEL":"old-alias"},"modelPicker":{"options":[]},"hooks":{"Stop":[]}});
        let cleared = crate::live::project::claude::project_onto(
            std::path::Path::new("settings.json"),
            &live,
            None,
            &crate::live::project::claude::ClaudeProjection::of(&provider.settings_config),
        )
        .unwrap();
        assert!(cleared["env"].get("ANTHROPIC_BASE_URL").is_none());
        assert!(cleared["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
        assert!(cleared["env"].get("ANTHROPIC_MODEL").is_none());
        assert!(cleared.get("modelPicker").is_none());
        assert_eq!(cleared["hooks"], live["hooks"]);
        let gemini = native_login_provider(&AppType::Gemini, &gemini_native).unwrap();
        let projected =
            crate::live::project::gemini::GeminiProjection::of(&gemini.settings_config, true);
        assert_eq!(projected.selected_type, Some("oauth-personal"));
        assert!(projected.env.is_empty() && projected.model_name.is_none());
        assert!(native_login_provider(&AppType::ClaudeDesktop, &claude_native).is_err());
        combined.default_model = Some("one/model-b".into());
        assert!(
            native_selection_for(&combined, &AppType::Claude).is_none(),
            "an API default must select the API-only catalog"
        );
    }

    #[test]
    fn openclaw_catalog_expands_legacy_and_explicit_policy_without_removing_user_models() {
        let mut catalog = snapshot();
        catalog.channels[0].models[0].enabled = Some(false);
        let plans = native_plans(&catalog, &AppType::OpenClaw).unwrap();
        let original = json!({"model":"user/keep", "models":{
            "user/keep":{"alias":"Personal","temperature":0.2},
            "tai-channel-one-openai-chat/model-a":{},
            "tai-channel-one-long-openai-chat/keep":{}
        },"modelPolicy":{"allow":["user/*","tai-channel-one-openai-chat/model-a","tai-channel-one-long-openai-chat/keep"],"unknown":true},"contextTokens":88888});
        let projected = project_openclaw_defaults(
            original.clone(),
            &plans,
            &["tai-channel-one-openai-chat".into()],
            "tai-channel-one-openai-chat/model-b",
        )
        .unwrap();
        let next = serde_json::to_value(projected).unwrap();
        assert_eq!(
            next["model"]["primary"],
            "tai-channel-one-openai-chat/model-b"
        );
        assert_eq!(next["contextTokens"], 88888);
        assert_eq!(next["models"]["user/keep"], original["models"]["user/keep"]);
        assert!(next["models"]
            .get("tai-channel-one-long-openai-chat/keep")
            .is_some());
        assert!(next["models"]
            .get("tai-channel-one-openai-chat/model-a")
            .is_none());
        assert!(next["models"]
            .get("tai-channel-one-openai-chat/model-b")
            .is_some());
        assert_eq!(
            next["modelPolicy"]["allow"],
            json!([
                "user/*",
                "tai-channel-one-long-openai-chat/keep",
                "tai-channel-one-openai-chat/model-b"
            ])
        );
        assert_eq!(next["modelPolicy"]["unknown"], true);
        let unrestricted = project_openclaw_defaults(
            json!({"modelPolicy":{"allow":[]}}),
            &plans,
            &[],
            "tai-channel-one-openai-chat/model-b",
        )
        .unwrap();
        assert!(unrestricted.models.is_none());
        assert_eq!(unrestricted.extra["modelPolicy"]["allow"], json!([]));
        assert!(project_openclaw_defaults(
            json!({"modelPolicy":{"allow":"invalid"}}),
            &plans,
            &[],
            "tai-channel-one-openai-chat/model-b"
        )
        .is_err());
    }

    #[test]
    fn native_v2_projection_has_current_package_settings_and_catalog() {
        let mut provider = native_plans(&snapshot(), &AppType::OpenCode)
            .unwrap()
            .remove(0);
        project_opencode_v2(&mut provider);
        assert_eq!(
            provider.settings_config["package"],
            "@ai-sdk/openai-compatible"
        );
        assert_eq!(
            provider.settings_config["settings"]["baseURL"],
            "https://example.test/v1"
        );
        assert_eq!(
            provider.settings_config["models"]["model-b"]["modelID"],
            "model-b"
        );
        crate::opencode_config::validate_native_provider(&provider.id, &provider.settings_config)
            .unwrap();
    }

    #[tokio::test]
    async fn discovery_reads_declared_catalog_metadata_without_generation_requests() {
        use axum::{routing::get, Json, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router=Router::new().route("/v1/models",get(|headers:axum::http::HeaderMap|async move{
            assert_eq!(headers.get("authorization").unwrap(),"Bearer test-fixture-key");
            Json(json!({"data":[{"id":"catalog-code","context_window":64000,"max_output_tokens":8192,"supports_tools":true,"supported_endpoints":["/responses"],"supported_reasoning_efforts":["low","high"]}]}))
        }));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut channel = source("one");
        channel.base_url = format!("http://{address}");
        let discovered = discover_api_models(channel).await.unwrap();
        assert_eq!(discovered.models[0].id, "catalog-code");
        assert_eq!(
            discovered.models[0].reasoning_efforts,
            Some(vec!["low".into(), "high".into()])
        );
        assert_eq!(discovered.models[0].context_limit, Some(64000));
        assert_eq!(discovered.models[0].supports_tools, Some(true));
        assert_eq!(
            discovered.models[0].protocol.as_deref(),
            Some("openai_responses")
        );
        server.abort();
    }

    #[tokio::test]
    async fn litellm_discovery_joins_exact_model_names_and_keeps_relay_limits_and_selection() {
        use axum::{routing::get, Json, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .route("/v1/models", get(|| async { Json(json!({"data":[{"id":"published","max_input_tokens":32000,"max_output_tokens":4000}]})) }))
            .route("/model/info", get(|headers: axum::http::HeaderMap| async move {
                assert_eq!(headers.get("authorization").unwrap(), "Bearer test-fixture-key");
                Json(json!({"data":[
                    {"model_name":"published","litellm_params":{"model":"openai/gpt-6-astra","api_key":"must-not-escape"},"model_info":{"max_input_tokens":200000,"max_output_tokens":128000,"supported_openai_params":["reasoning_effort"]}},
                    {"model_name":"not-published","litellm_params":{"model":"openai/gpt-6-astra"},"model_info":{}}
                ]}))
            }));
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        let mut channel = source("fixture");
        channel.name = "LiteLLM".into();
        channel.base_url = format!("http://{address}/v1");
        channel.models = vec![blank_model("published".into())];
        channel.models[0].enabled = Some(false);
        let discovered = discover_api_models(channel).await.unwrap();
        assert_eq!(discovered.models.len(), 1);
        let model = &discovered.models[0];
        assert_eq!(model.id, "published");
        assert_eq!(model.context_limit, Some(32000));
        assert_eq!(model.output_limit, Some(4000));
        assert_eq!(model.enabled, Some(false));
        assert!(model.reasoning_efforts.as_ref().unwrap().contains(&"xhigh".into()));
        assert_eq!(model.reasoning_effort_transport.as_deref(), Some("declared"));
        assert!(!serde_json::to_string(model).unwrap().contains("must-not-escape"));
        let expected_source = model.reasoning_effort_source.clone();
        let mut snapshot = ChannelCenterSnapshot { channels: vec![discovered], ..Default::default() };
        snapshot.channels[0].models[0].enabled = Some(true);
        let catalog = agent_catalog_from_snapshot(&snapshot);
        assert_eq!(catalog.models[0].reasoning_effort_source, expected_source);
        assert_eq!(catalog.models[0].reasoning_effort_transport.as_deref(), Some("declared"));
        server.abort();
    }

    #[test]
    fn inferred_reasoning_refresh_preserves_manual_values_and_their_provenance() {
        let mut saved = blank_model("alias".into());
        saved.reasoning_efforts = Some(vec!["custom".into()]);
        let mut fresh = blank_model("alias".into());
        fresh.reasoning_efforts = Some(vec!["low".into(), "high".into()]);
        fresh.reasoning_effort_source = Some(super::super::litellm_capabilities::REGISTRY_SOURCE.into());
        fresh.reasoning_effort_transport = Some("unconfirmed".into());
        let merged = merge_discovered(&[saved], vec![fresh]);
        assert_eq!(merged[0].reasoning_efforts, Some(vec!["custom".into()]));
        assert!(merged[0].reasoning_effort_source.is_none());
        assert!(merged[0].reasoning_effort_transport.is_none());
    }

    #[test]
    fn successful_unknown_refresh_discards_stale_inferences_but_failure_keeps_them() {
        for source in [super::super::litellm_capabilities::REGISTRY_SOURCE, "litellm:model-info"] {
            let mut saved = blank_model("alias".into());
            saved.reasoning_efforts = Some(vec!["low".into(), "high".into()]);
            saved.reasoning_effort_source = Some(source.into());
            saved.reasoning_effort_transport = Some("declared".into());
            saved.enabled = Some(false);
            let failed = merge_discovered(&[saved.clone()], vec![blank_model("alias".into())]);
            assert_eq!(failed[0].reasoning_efforts, saved.reasoning_efforts);
            let mut unknown = blank_model("alias".into());
            unknown.reasoning_effort_transport = Some("mixed".into());
            let refreshed = merge_discovered(&[saved], vec![unknown.clone()]);
            assert!(refreshed[0].reasoning_efforts.is_none());
            assert!(refreshed[0].reasoning_effort_source.is_none());
            assert_eq!(refreshed[0].reasoning_effort_transport.as_deref(), Some("mixed"));
            assert_eq!(refreshed[0].enabled, Some(false));
            let mut manual = blank_model("alias".into());
            manual.reasoning_efforts = Some(vec!["custom".into()]);
            let preserved = merge_discovered(&[manual], vec![unknown]);
            assert_eq!(preserved[0].reasoning_efforts, Some(vec!["custom".into()]));
            assert!(preserved[0].reasoning_effort_source.is_none());
        }
    }

    #[test]
    #[serial_test::serial]
    fn pi_native_apply_sets_default_and_removes_only_previously_managed_providers() {
        use std::sync::Arc;
        let temp = tempfile::tempdir().unwrap();
        let agent = temp.path().join("agent");
        let _native = crate::pi_config::test_support::TestAgentDir::at(&agent);
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(
            agent.join("models.json"),
            r#"{"customFlag":true,"providers":{"user-owned":{"models":[{"id":"keep"}]}}}"#,
        )
        .unwrap();
        std::fs::write(
            agent.join("settings.json"),
            r#"{"theme":"keep-theme","sessionDir":"keep-sessions"}"#,
        )
        .unwrap();
        let db = Arc::new(Database::memory().unwrap());
        let state = AppState {
            db: db.clone(),
            proxy_service: crate::services::ProxyService::new(db),
            usage_cache: Arc::new(crate::services::UsageCache::new()),
            codex_oauth_manager: Arc::new(
                crate::proxy::providers::codex_oauth_auth::CodexOAuthManager::new(
                    temp.path().join("oauth"),
                ),
            ),
        };
        let initial = snapshot();
        apply_plans(
            &state,
            &AppType::Pi,
            native_plans(&initial, &AppType::Pi).unwrap(),
            "one/model-b",
            false,
        )
        .unwrap();
        let settings: Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(settings["defaultProvider"], "tai-channel-one-openai-chat");
        assert_eq!(settings["defaultModel"], "model-b");
        assert_eq!(settings["theme"], "keep-theme");
        assert_eq!(settings["sessionDir"], "keep-sessions");
        let later = ChannelCenterSnapshot {
            channels: vec![source("two")],
            default_model: Some("two/model-a".into()),
            ..Default::default()
        };
        apply_plans(
            &state,
            &AppType::Pi,
            native_plans(&later, &AppType::Pi).unwrap(),
            "two/model-a",
            false,
        )
        .unwrap();
        let models: Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("models.json")).unwrap())
                .unwrap();
        assert_eq!(models["customFlag"], true);
        assert_eq!(models["providers"]["user-owned"]["models"][0]["id"], "keep");
        assert!(models["providers"]
            .get("tai-channel-one-openai-chat")
            .is_none());
        assert_eq!(
            models["providers"]["tai-channel-two-openai-chat"]["models"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn mcode_native_apply_replaces_deselected_default_atomically_and_rolls_back_commit_failure() {
        use std::sync::Arc;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.yaml");
        std::fs::write(&path, "defaultLightModel: custom_provider:user-owned/light\nminimax_api:\n  apiKey: untouched-fixture\nunknown: [a, b]\ncustom_provider:\n  user-owned:\n    models:\n      light: {}\n").unwrap();
        let db = Arc::new(Database::memory().unwrap());
        let state = AppState {
            db: db.clone(),
            proxy_service: crate::services::ProxyService::new(db.clone()),
            usage_cache: Arc::new(crate::services::UsageCache::new()),
            codex_oauth_manager: Arc::new(
                crate::proxy::providers::codex_oauth_auth::CodexOAuthManager::new(
                    temp.path().join("oauth"),
                ),
            ),
        };
        let initial = snapshot();
        apply_mcode_plans_at(
            &state,
            native_plans(&initial, &AppType::Mcode).unwrap(),
            "one/model-a",
            false,
            &path,
        )
        .unwrap();
        let mut previous: serde_yaml::Value =
            serde_yaml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            previous["defaultModel"],
            "custom_provider:tai-channel-one-openai-chat/model-a"
        );
        previous["custom_provider"]["tai-channel-one-openai-chat"]["nativeExtra"] = true.into();
        std::fs::write(&path, serde_yaml::to_string(&previous).unwrap()).unwrap();
        let mut later = initial.clone();
        later.channels[0].models[0].enabled = Some(false);
        later.default_model = Some("one/model-b".into());
        apply_mcode_plans_at(
            &state,
            native_plans(&later, &AppType::Mcode).unwrap(),
            "one/model-b",
            false,
            &path,
        )
        .unwrap();
        let after: serde_yaml::Value =
            serde_yaml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            after["defaultModel"],
            "custom_provider:tai-channel-one-openai-chat/model-b"
        );
        for field in ["defaultLightModel", "unknown", "minimax_api"] {
            assert_eq!(after[field], previous[field]);
        }
        assert_eq!(
            after["custom_provider"]["user-owned"],
            previous["custom_provider"]["user-owned"]
        );
        assert_eq!(
            after["custom_provider"]["tai-channel-one-openai-chat"]["nativeExtra"],
            true
        );
        let models = after["custom_provider"]["tai-channel-one-openai-chat"]["models"]
            .as_mapping()
            .unwrap();
        assert!(!models.contains_key(serde_yaml::Value::from("model-a")));
        assert!(models.contains_key(serde_yaml::Value::from("model-b")));
        let saved = db
            .get_provider_by_id("tai-channel-one-openai-chat", "mcode")
            .unwrap()
            .unwrap();
        assert!(saved.settings_config["models"].get("model-a").is_none());
        assert_eq!(saved.meta.as_ref().unwrap().live_config_managed, Some(true));
        let before_failed_write = std::fs::read(&path).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("CREATE TRIGGER fail_mcode_manifest BEFORE INSERT ON settings WHEN NEW.key='channel_center_managed_mcode' BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END;").unwrap();
        }
        assert!(apply_mcode_plans_at(
            &state,
            native_plans(&initial, &AppType::Mcode).unwrap(),
            "one/model-a",
            false,
            &path
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before_failed_write);
        assert_eq!(
            db.get_provider_by_id(&saved.id, "mcode")
                .unwrap()
                .unwrap()
                .settings_config,
            saved.settings_config
        );
        assert!(!path.with_extension("yaml.lock").exists());
    }
}

#[cfg(test)]
#[path = "channel_center_apply_tests.rs"]
mod apply_tests;
