//! Authenticated local API for channel-center sources. No live provider selection,
//! takeover, failover, or Codex aggregation state participates in these requests.

use super::{
    content_encoding::{decompress_body_with_limit, get_content_encoding},
    forwarder::CodexUpstreamFormat,
    handler_config::{
        CLAUDE_PARSER_CONFIG, CODEX_PARSER_CONFIG, GEMINI_PARSER_CONFIG, OPENAI_PARSER_CONFIG,
    },
    handler_context::RequestContext,
    handlers,
    providers::{
        get_adapter, get_claude_api_format,
        streaming_codex_anthropic::{
            create_responses_sse_stream_from_anthropic_with_context,
            responses_sse_events_from_anthropic_message,
        },
        transform_codex_anthropic, transform_codex_chat,
    },
    response_processor::{
        process_response, strip_entity_headers_for_rebuilt_body, strip_hop_by_hop_response_headers,
    },
    server::ProxyState,
    sse::{strip_sse_field, take_sse_block},
    ProxyError,
};
use crate::{
    app_config::AppType,
    error::AppError,
    mode::stack::StackTarget,
    provider::{AuthBinding, AuthBindingSource, Provider, ProviderMeta},
    services::channel_center::{self, ChannelCenterSnapshot, ChannelModel, ChannelSource},
};
use axum::{
    extract::{Path, Request, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use bytes::Bytes;
use futures::StreamExt;
use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr};

const MAX_REQUEST_BYTES: usize = 200 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES: usize = 4 * 1024 * 1024;

/// Inserted from the actual accepted TCP connection, never a forwarded header.
#[derive(Clone, Copy)]
pub(crate) struct GatewayPeer(pub SocketAddr);

/// Local credentials must also be hidden if an upstream echoes them in an error.
#[derive(Clone)]
pub(crate) struct GatewaySecrets(pub Vec<String>);

#[derive(Clone, Copy)]
struct GatewayClient(&'static str);

pub(crate) fn is_attributed_client(client: &str) -> bool {
    matches!(
        client,
        "lolicode" | "tavern" | "workbuddy" | "deepseek-harness" | "zcode" | "mimocode"
    )
}

/// Attribution comes from the generated configuration URL, never upstream model
/// names or user-controlled forwarding headers.
fn client_for_uri(uri: &http::Uri) -> Result<&'static str, ProxyError> {
    let Some(path) = uri.path().strip_prefix("/tai/catalogs/") else {
        return Ok("channel-gateway");
    };
    let segments: Vec<_> = path.split('/').collect();
    if segments.get(1) != Some(&"clients") {
        return Ok("channel-gateway");
    }
    match segments.get(2).copied() {
        Some("lolicode") => Ok("lolicode"),
        Some("tavern") => Ok("tavern"),
        Some("workbuddy") => Ok("workbuddy"),
        Some("deepseek-harness") => Ok("deepseek-harness"),
        Some("zcode") => Ok("zcode"),
        Some("mimocode") => Ok("mimocode"),
        _ => Err(ProxyError::InvalidRequest("未知的客户端配置入口".into())),
    }
}

pub(crate) fn catalog_client_base_url(
    catalog_base: &str,
    client: &str,
) -> Result<String, AppError> {
    if !is_attributed_client(client) {
        return Err(AppError::InvalidInput("未知的客户端配置入口".into()));
    }
    Ok(format!(
        "{}/clients/{client}/v1",
        catalog_base.trim_end_matches("/v1")
    ))
}

pub(crate) fn gateway_base_url(address: &str, port: u16) -> Result<String, AppError> {
    let host = if address == "localhost" {
        "127.0.0.1".to_string()
    } else {
        let ip: IpAddr = address
            .parse()
            .map_err(|_| AppError::InvalidInput("本地网关监听地址无效".into()))?;
        if !ip.is_loopback() && !ip.is_unspecified() {
            return Err(AppError::InvalidInput(
                "渠道中心网关仅支持本机环回连接".into(),
            ));
        }
        match ip {
            IpAddr::V4(_) => "127.0.0.1".to_string(),
            IpAddr::V6(_) => "[::1]".to_string(),
        }
    };
    Ok(format!("http://{host}:{port}/tai/v1"))
}

pub(crate) fn gateway_catalog_base_url(
    address: &str,
    port: u16,
    revision: u64,
) -> Result<String, AppError> {
    Ok(gateway_base_url(address, port)?
        .trim_end_matches("/v1")
        .to_string()
        + &format!("/catalogs/{revision}/v1"))
}

fn snapshot_for_uri(
    state: &ProxyState,
    uri: &http::Uri,
) -> Result<ChannelCenterSnapshot, ProxyError> {
    let result = if let Some(path) = uri.path().strip_prefix("/tai/catalogs/") {
        let revision = path.split('/').next().unwrap_or("");
        if revision.is_empty() || !revision.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(ProxyError::InvalidRequest("渠道目录版本无效".into()));
        }
        let revision = revision
            .parse::<u64>()
            .map_err(|_| ProxyError::InvalidRequest("渠道目录版本无效".into()))?;
        channel_center::load_catalog(state.db.as_ref(), revision)
    } else {
        channel_center::load_applied(state.db.as_ref())
    };
    result.map_err(|error| ProxyError::ConfigError(error.to_string()))
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn authorize(
    peer: Option<&GatewayPeer>,
    headers: &HeaderMap,
    expected: &str,
) -> Result<(), ProxyError> {
    if !peer.is_some_and(|peer| peer.0.ip().is_loopback()) {
        return Err(ProxyError::AuthError("渠道中心网关仅接受本机连接".into()));
    }
    let bearer = headers
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token.trim());
    let api_key = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok());
    if expected.is_empty()
        || !bearer
            .or(api_key)
            .is_some_and(|token| constant_time_equal(token.as_bytes(), expected.as_bytes()))
    {
        return Err(ProxyError::AuthError("渠道中心本地网关密钥无效".into()));
    }
    Ok(())
}

fn authorize_request(state: &ProxyState, request: &Request) -> Result<(), ProxyError> {
    let expected = channel_center::gateway_token(state.db.as_ref())
        .map_err(|error| ProxyError::ConfigError(error.to_string()))?;
    let mut headers = request.headers().clone();
    // Google's native SDK uses either x-goog-api-key or a key query parameter.
    // Neither is forwarded: the upstream credential comes from the selected source.
    if request.uri().path().contains("/v1beta/")
        && !headers.contains_key("authorization")
        && !headers.contains_key("x-api-key")
    {
        let key = headers.get("x-goog-api-key").cloned().or_else(|| {
            url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
                .find(|(name, _)| name == "key")
                .and_then(|(_, value)| http::HeaderValue::from_str(&value).ok())
        });
        if let Some(key) = key {
            headers.insert("x-api-key", key);
        }
    }
    authorize(
        request.extensions().get::<GatewayPeer>(),
        &headers,
        &expected,
    )
}

fn model_enabled(model: &ChannelModel) -> bool {
    model.available()
}

fn protocol<'a>(source: &'a ChannelSource, model: &'a ChannelModel) -> &'a str {
    if let Some((_, protocol)) = channel_center::managed_subscription_route(&source.auth_kind) {
        return protocol;
    }
    model.protocol.as_deref().unwrap_or(&source.protocol)
}

fn normalize_protocol(protocol: &str) -> Result<&'static str, ProxyError> {
    match protocol {
        "openai_chat" | "openai-completions" | "chat" => Ok("openai_chat"),
        "openai_responses" | "openai-responses" | "responses" => Ok("openai_responses"),
        "anthropic" | "anthropic-messages" => Ok("anthropic"),
        "gemini_native" | "google-generative-ai" | "gemini" => Ok("gemini_native"),
        _ => Err(ProxyError::ConfigError(format!(
            "渠道协议 {protocol} 尚不支持本地网关"
        ))),
    }
}

fn resolve_model(
    channels: &[ChannelSource],
    published_id: &str,
) -> Result<(ChannelSource, ChannelModel), ProxyError> {
    // Claude Code requires a Claude-shaped role id for its default model and
    // model picker. Match the exact generated alias; it is not an upstream id.
    if let Some(found) = channels
        .iter()
        .filter(|source| {
            source.enabled && channel_center::native_auth_target(&source.auth_kind).is_none()
        })
        .find_map(|source| {
            source
                .models
                .iter()
                .filter(|model| model_enabled(model))
                .find(|model| channel_center::claude_route_matches(source, model, published_id))
                .map(|model| (source, model))
        })
    {
        normalize_protocol(protocol(found.0, found.1))?;
        return Ok((found.0.clone(), found.1.clone()));
    }
    let (source_id, upstream_id) = published_id.split_once('/').ok_or_else(|| {
        ProxyError::InvalidRequest("模型必须使用渠道中心的 渠道/模型 标识".into())
    })?;
    let source = channels
        .iter()
        .find(|source| source.enabled && source.id == source_id)
        .ok_or_else(|| ProxyError::InvalidRequest("指定渠道不存在或已禁用".into()))?;
    if channel_center::native_auth_target(&source.auth_kind).is_some() {
        return Err(ProxyError::InvalidRequest(
            "原生订阅只能在对应官方工具中使用，请在渠道中心切换原生配置".into(),
        ));
    }
    let model = source
        .models
        .iter()
        .find(|model| model_enabled(model) && model.id == upstream_id)
        .ok_or_else(|| {
            ProxyError::InvalidRequest("指定模型不存在或已禁用，请刷新模型列表".into())
        })?;
    normalize_protocol(protocol(source, model))?;
    Ok((source.clone(), model.clone()))
}

pub(crate) async fn handle_models(
    State(state): State<ProxyState>,
    request: Request,
) -> Result<Json<Value>, ProxyError> {
    authorize_request(&state, &request)?;
    client_for_uri(request.uri())?;
    let snapshot = snapshot_for_uri(&state, request.uri())?;
    let data: Vec<Value> = snapshot
        .channels
        .iter()
        .filter(|source| {
            source.enabled && channel_center::native_auth_target(&source.auth_kind).is_none()
        })
        .flat_map(|source| {
            source.models.iter().filter_map(move |model| {
                if !model_enabled(model) || normalize_protocol(protocol(source, model)).is_err() {
                    return None;
                }
                Some(json!({
                    "id": format!("{}/{}", source.id, model.id),
                    "object": "model",
                    "created": 0,
                    "owned_by": source.name,
                }))
            })
        })
        .collect();
    Ok(Json(json!({"object": "list", "data": data})))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wire {
    Messages,
    Chat,
    Responses,
}

pub(crate) async fn handle_messages(
    State(state): State<ProxyState>,
    request: Request,
) -> Result<Response, ProxyError> {
    handle(state, request, Wire::Messages).await
}

pub(crate) async fn handle_chat(
    State(state): State<ProxyState>,
    request: Request,
) -> Result<Response, ProxyError> {
    handle(state, request, Wire::Chat).await
}

pub(crate) async fn handle_responses(
    State(state): State<ProxyState>,
    request: Request,
) -> Result<Response, ProxyError> {
    handle(state, request, Wire::Responses).await
}

/// Native Gemini clients currently support native Gemini sources only. No
/// unrelated Chat model is advertised as a working generateContent endpoint.
pub(crate) async fn handle_gemini(
    State(state): State<ProxyState>,
    Path(parameters): Path<std::collections::HashMap<String, String>>,
    request: Request,
) -> Result<Response, ProxyError> {
    authorize_request(&state, &request)?;
    let snapshot = snapshot_for_uri(&state, request.uri())?;
    let decoded = parameters.get("path").map(String::as_str).unwrap_or("");
    if decoded == "models" && request.method() == http::Method::GET {
        let models: Vec<_> = snapshot.channels.iter().filter(|source| source.enabled && source.auth_kind=="api_key")
            .flat_map(|source| source.models.iter().filter_map(move |model| {
                if !model_enabled(model) || normalize_protocol(protocol(source, model)).ok() != Some("gemini_native") { return None; }
                Some(json!({
                    "name":format!("models/{}/{}",source.id,model.id),
                    "displayName":model.name.as_deref().unwrap_or(&model.id),
                    "inputTokenLimit":model.context_limit,"outputTokenLimit":model.output_limit,
                    "supportedGenerationMethods":["generateContent","streamGenerateContent","countTokens"]
                }))
            })).collect();
        return Ok(Json(json!({"models":models})).into_response());
    }
    let model_path = decoded
        .strip_prefix("models/")
        .ok_or_else(|| ProxyError::InvalidRequest("不支持的 Gemini 网关路径".into()))?;
    if request.method() == http::Method::GET && !model_path.contains(':') {
        let (source, model) = resolve_model(&snapshot.channels, model_path)?;
        if normalize_protocol(protocol(&source, &model))? != "gemini_native"
            || source.auth_kind != "api_key"
        {
            return Err(ProxyError::InvalidRequest(
                "Gemini CLI 当前仅支持原生 Gemini API Key 渠道".into(),
            ));
        }
        return Ok(Json(json!({
            "name":format!("models/{}/{}",source.id,model.id),
            "displayName":model.name.as_deref().unwrap_or(&model.id),
            "inputTokenLimit":model.context_limit,"outputTokenLimit":model.output_limit,
            "supportedGenerationMethods":["generateContent","streamGenerateContent","countTokens"]
        }))
        .into_response());
    }
    let (published_id, operation) = model_path
        .rsplit_once(':')
        .ok_or_else(|| ProxyError::InvalidRequest("Gemini 请求缺少操作".into()))?;
    if request.method() != http::Method::POST
        || !matches!(
            operation,
            "generateContent" | "streamGenerateContent" | "countTokens"
        )
    {
        return Err(ProxyError::InvalidRequest(
            "不支持的 Gemini 网关操作".into(),
        ));
    }
    let (source, model) = resolve_model(&snapshot.channels, published_id)?;
    if normalize_protocol(protocol(&source, &model))? != "gemini_native"
        || source.auth_kind != "api_key"
    {
        return Err(ProxyError::InvalidRequest(
            "Gemini CLI 当前仅支持原生 Gemini API Key 渠道".into(),
        ));
    }
    let published_id = published_id.to_string();
    let operation = operation.to_string();
    let (mut parts, body) = request.into_parts();
    parts
        .extensions
        .insert(GatewaySecrets(vec![channel_center::gateway_token(
            state.db.as_ref(),
        )
        .map_err(|error| ProxyError::ConfigError(error.to_string()))?]));
    for name in [
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "cookie",
        "proxy-authorization",
    ] {
        parts.headers.remove(name);
    }
    let bytes = axum::body::to_bytes(body, MAX_REQUEST_BYTES)
        .await
        .map_err(|_| ProxyError::InvalidRequest("请求体超过限制或无法读取".into()))?;
    let bytes = decode_request_body(&mut parts.headers, bytes)?;
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ProxyError::InvalidRequest("请求体必须是 JSON 对象".into()))?;
    validate_capabilities(&model, &body)?;
    if source.api_key.trim().is_empty() {
        return Err(ProxyError::AuthError("该渠道缺少 API Key".into()));
    }
    let provider = Provider::with_id(
        format!("channel-{}", source.id),
        source.name.clone(),
        json!({"env":{
            "GOOGLE_GEMINI_BASE_URL":source.base_url,"GEMINI_API_KEY":source.api_key,
        }}),
        None,
    );
    let target = StackTarget {
        provider,
        upstream_model: model.id.clone(),
        original_model: published_id,
    };
    let mut ctx = RequestContext::new(
        &state,
        &body,
        &parts.headers,
        AppType::Gemini,
        "Channel center",
        "channel-gateway",
        Some(target),
    )
    .await?;
    let upstream_id = model.id.trim_start_matches("models/");
    let endpoint = format!(
        "/v1beta/models/{upstream_id}:{operation}{}",
        if operation == "streamGenerateContent" {
            "?alt=sse"
        } else {
            ""
        }
    );
    let mut result = ctx
        .create_forwarder(&state)
        .forward_with_retry(
            &AppType::Gemini,
            http::Method::POST,
            &endpoint,
            body,
            parts.headers,
            parts.extensions,
            ctx.get_providers(),
        )
        .await
        .map_err(|error| error.error)?;
    ctx.outbound_model = result.outbound_model.take();
    ctx.provider = result.provider;
    process_response(
        result.response,
        &ctx,
        &state,
        &GEMINI_PARSER_CONFIG,
        operation == "streamGenerateContent",
        result.connection_guard.take(),
    )
    .await
}

async fn handle(state: ProxyState, request: Request, wire: Wire) -> Result<Response, ProxyError> {
    authorize_request(&state, &request)?;
    let client = client_for_uri(request.uri())?;
    let snapshot = snapshot_for_uri(&state, request.uri())?;
    let (mut parts, raw_body) = request.into_parts();
    parts.extensions.insert(GatewayClient(client));
    parts
        .extensions
        .insert(GatewaySecrets(vec![channel_center::gateway_token(
            state.db.as_ref(),
        )
        .map_err(|error| ProxyError::ConfigError(error.to_string()))?]));
    // These are local credentials. No client-supplied credential or cookie is
    // eligible for forwarding to an upstream.
    for name in [
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "cookie",
        "proxy-authorization",
    ] {
        parts.headers.remove(name);
    }
    let bytes = axum::body::to_bytes(raw_body, MAX_REQUEST_BYTES)
        .await
        .map_err(|_| ProxyError::InvalidRequest("请求体超过限制或无法读取".into()))?;
    let bytes = decode_request_body(&mut parts.headers, bytes)?;
    let mut body: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ProxyError::InvalidRequest("请求体必须是 JSON 对象".into()))?;
    let published_id = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| ProxyError::InvalidRequest("请求缺少 model".into()))?
        .to_string();
    let (source, model) = resolve_model(&snapshot.channels, &published_id)?;
    let source = resolve_source_material(source).await?;
    validate_capabilities(&model, &body)?;
    body["model"] = json!(model.id);
    let source_protocol = normalize_protocol(protocol(&source, &model))?;
    let is_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);

    // Chat can use the existing native path for Chat and managed Copilot.
    // Other upstreams bridge through Messages, which already has streaming
    // conversions for Responses and Gemini as well as native Anthropic.
    if wire == Wire::Chat && source_protocol != "openai_chat" {
        let messages = chat_request_to_messages(body, model.output_limit)?;
        let response = forward(
            &state,
            &source,
            &model,
            &published_id,
            messages,
            parts.headers,
            parts.extensions,
            Wire::Messages,
        )
        .await?;
        return messages_response_to_chat(response, published_id, is_stream).await;
    }
    if wire == Wire::Responses && source_protocol == "gemini_native" {
        let context = transform_codex_chat::build_codex_tool_context_from_request(&body);
        let messages = transform_codex_anthropic::responses_request_to_anthropic(
            body,
            model.output_limit.unwrap_or(16384),
        )?;
        let response = forward(
            &state,
            &source,
            &model,
            &published_id,
            messages,
            parts.headers,
            parts.extensions,
            Wire::Messages,
        )
        .await?;
        return messages_response_to_responses(response, is_stream, context).await;
    }
    forward(
        &state,
        &source,
        &model,
        &published_id,
        body,
        parts.headers,
        parts.extensions,
        wire,
    )
    .await
}

fn validate_capabilities(model: &ChannelModel, body: &Value) -> Result<(), ProxyError> {
    if model.supports_tools == Some(false)
        && body
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| !tools.is_empty())
    {
        return Err(ProxyError::InvalidRequest("该模型不支持工具调用".into()));
    }
    if model
        .input_modalities
        .as_ref()
        .is_some_and(|modalities| !modalities.iter().any(|modality| modality == "image"))
        && contains_image(body)
    {
        return Err(ProxyError::InvalidRequest("该模型不支持图片输入".into()));
    }
    Ok(())
}

async fn resolve_source_material(mut source: ChannelSource) -> Result<ChannelSource, ProxyError> {
    if source.auth_kind == "zhipu_oauth" {
        let account = source
            .account_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| ProxyError::AuthError("智谱登录渠道缺少账号引用，请重新登录".into()))?;
        let material = crate::services::zhipu_login::resolve_account(account)
            .await
            .map_err(ProxyError::AuthError)?;
        source.base_url = material.base_url;
        source.api_key = material.api_key;
        source.protocol = material.protocol;
        source.auth_kind = "api_key".into();
    }
    Ok(source)
}

fn contains_image(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| matches!(kind, "image" | "image_url" | "input_image"))
                || object.values().any(contains_image)
        }
        Value::Array(values) => values.iter().any(contains_image),
        _ => false,
    }
}

fn decode_request_body(headers: &mut HeaderMap, bytes: Bytes) -> Result<Bytes, ProxyError> {
    let Some(encoding) = get_content_encoding(headers) else {
        return Ok(bytes);
    };
    let decoded = decompress_body_with_limit(&encoding, &bytes, MAX_REQUEST_BYTES)
        .map_err(|_| ProxyError::InvalidRequest("请求体解压失败或超过大小限制".into()))?
        .ok_or_else(|| ProxyError::InvalidRequest("不支持的请求压缩格式".into()))?;
    headers.remove(http::header::CONTENT_ENCODING);
    headers.remove(http::header::CONTENT_LENGTH);
    Ok(Bytes::from(decoded))
}

fn provider_for(
    source: &ChannelSource,
    model: &ChannelModel,
    wire: Wire,
) -> Result<Provider, ProxyError> {
    let api_format = normalize_protocol(protocol(source, model))?;
    let managed_kind = match source.auth_kind.as_str() {
        "github_copilot" | "copilot" => Some("github_copilot"),
        "codex_oauth" => Some("codex_oauth"),
        "xai_oauth" => Some("xai_oauth"),
        _ => None,
    };
    let managed = managed_kind.is_some();
    if !managed && !matches!(source.auth_kind.as_str(), "api_key" | "apikey") {
        return Err(ProxyError::ConfigError(
            "该渠道认证方式尚不支持本地网关".into(),
        ));
    }
    if !managed && source.api_key.trim().is_empty() {
        return Err(ProxyError::AuthError("该渠道缺少 API Key".into()));
    }
    if managed
        && source
            .account_id
            .as_deref()
            .is_none_or(|id| id.trim().is_empty())
    {
        return Err(ProxyError::AuthError(
            "登录渠道缺少明确账户绑定，请重新选择账号".into(),
        ));
    }
    let base_url = channel_center::managed_subscription_route(&source.auth_kind)
        .map(|(base, _)| base)
        .unwrap_or(&source.base_url);
    let api_key = if managed { "" } else { source.api_key.as_str() };
    let anthropic_key = api_format == "anthropic"
        && url::Url::parse(&source.base_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .as_deref()
            == Some("api.anthropic.com");
    let key_field = if anthropic_key {
        "ANTHROPIC_API_KEY"
    } else {
        "ANTHROPIC_AUTH_TOKEN"
    };
    let settings = if wire == Wire::Messages {
        let mut env = serde_json::Map::new();
        env.insert("ANTHROPIC_BASE_URL".into(), json!(base_url));
        env.insert(key_field.into(), json!(api_key));
        json!({"env": env})
    } else {
        json!({"base_url": base_url, "auth": {"OPENAI_API_KEY": api_key}})
    };
    let mut provider = Provider::with_id(
        format!("channel-{}", source.id),
        source.name.clone(),
        settings,
        None,
    );
    provider.meta = Some(ProviderMeta {
        api_format: Some(api_format.into()),
        api_key_field: anthropic_key.then(|| key_field.into()),
        provider_type: managed_kind.map(str::to_string),
        auth_binding: managed.then(|| AuthBinding {
            source: AuthBindingSource::ManagedAccount,
            auth_provider: managed_kind.map(str::to_string),
            account_id: source.account_id.clone(),
        }),
        // Chat clients require Chat output; auto protocol selection must not
        // replace their endpoint with Responses.
        codex_copilot_api_format: (managed_kind == Some("github_copilot") && wire == Wire::Chat)
            .then(|| "openai_chat".into()),
        ..Default::default()
    });
    Ok(provider)
}

/// Messages clients can send effort without a separate thinking block. During
/// an OpenAI conversion, an omitted block must not turn an explicit high effort
/// into low. This is an internal bridge hint only; native Messages is untouched
/// and an explicit thinking:disable still retains the existing off semantics.
fn prepare_messages_request(
    body: &mut Value,
    model: &ChannelModel,
    upstream_protocol: &str,
) -> Result<(), ProxyError> {
    if matches!(upstream_protocol, "openai_chat" | "openai_responses")
        && body.get("thinking").is_none_or(Value::is_null)
        && body
            .pointer("/output_config/effort")
            .and_then(Value::as_str)
            .is_some_and(|effort| matches!(effort, "low" | "medium" | "high" | "xhigh" | "max"))
    {
        body["thinking"] = json!({"type":"adaptive"});
    }

    if let (Some(limit), Some(requested)) = (
        model.output_limit.filter(|limit| *limit > 0),
        body.get("max_tokens").and_then(Value::as_u64),
    ) {
        if requested > limit {
            body["max_tokens"] = json!(limit);
            // Legacy thinking budgets count toward max_tokens. Keep them valid
            // when switching from a large-output model to a smaller one.
            if body.pointer("/thinking/type").and_then(Value::as_str) == Some("enabled")
                && body
                    .pointer("/thinking/budget_tokens")
                    .and_then(Value::as_u64)
                    .is_some_and(|budget| budget >= limit)
            {
                if limit <= 1024 {
                    return Err(ProxyError::InvalidRequest(
                        "该模型的输出上限不足以容纳当前思考预算，请切换模型或关闭思考".into(),
                    ));
                }
                body["thinking"]["budget_tokens"] = json!(limit - 1);
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn forward(
    state: &ProxyState,
    source: &ChannelSource,
    model: &ChannelModel,
    published_id: &str,
    mut body: Value,
    headers: HeaderMap,
    extensions: http::Extensions,
    wire: Wire,
) -> Result<Response, ProxyError> {
    let client_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    if wire == Wire::Messages {
        prepare_messages_request(&mut body, model, normalize_protocol(protocol(source, model))?)?;
    }
    if source.auth_kind == "codex_oauth" && wire == Wire::Responses {
        super::providers::transform_responses::normalize_codex_oauth_responses_request(
            &mut body, false,
        );
    }
    let provider = provider_for(source, model, wire)?;
    let (app, endpoint) = if wire == Wire::Messages {
        (AppType::Claude, "/v1/messages")
    } else if wire == Wire::Chat {
        (AppType::Codex, "/chat/completions")
    } else {
        (AppType::Codex, "/responses")
    };
    let explicit = StackTarget {
        provider,
        upstream_model: model.id.clone(),
        original_model: published_id.to_string(),
    };
    let mut ctx = RequestContext::new(
        state,
        &body,
        &headers,
        app.clone(),
        "Channel center",
        extensions
            .get::<GatewayClient>()
            .map(|client| client.0)
            .unwrap_or("channel-gateway"),
        Some(explicit),
    )
    .await?;
    // Capability failures belong to this channel's result. Do not turn an
    // unsupported image into a successful text-only request via global fallback.
    ctx.rectifier_config.request_media_fallback = false;
    let is_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let tool_context = transform_codex_chat::build_codex_tool_context_from_request(&body);
    let forwarder = ctx.create_forwarder(state);
    let mut result = forwarder
        .forward_with_retry(
            &app,
            http::Method::POST,
            endpoint,
            body.clone(),
            headers,
            extensions,
            ctx.get_providers(),
        )
        .await
        .map_err(|error| error.error)?;
    ctx.outbound_model = result.outbound_model.take();
    ctx.provider = result.provider;
    let guard = result.connection_guard.take();
    if wire == Wire::Messages {
        let adapter = get_adapter(&app).ok_or(ProxyError::NoAvailableProvider)?;
        if adapter.needs_transform(&ctx.provider) {
            let format = result
                .claude_api_format
                .as_deref()
                .unwrap_or_else(|| get_claude_api_format(&ctx.provider));
            return handlers::handle_claude_transform(
                result.response,
                &ctx,
                state,
                &body,
                is_stream,
                format,
                guard,
            )
            .await;
        }
    } else if wire == Wire::Responses {
        match result.codex_upstream_format {
            Some(CodexUpstreamFormat::Anthropic) => {
                return handlers::handle_codex_anthropic_to_responses_transform(
                    result.response,
                    &ctx,
                    state,
                    is_stream,
                    guard,
                    tool_context,
                )
                .await
            }
            Some(CodexUpstreamFormat::ChatCompletions) => {
                return handlers::handle_codex_chat_to_responses_transform(
                    result.response,
                    &ctx,
                    state,
                    is_stream,
                    guard,
                    tool_context,
                )
                .await
            }
            _ => {}
        }
    }
    let parser = match wire {
        Wire::Messages => &CLAUDE_PARSER_CONFIG,
        Wire::Chat => &OPENAI_PARSER_CONFIG,
        Wire::Responses => &CODEX_PARSER_CONFIG,
    };
    let response = process_response(result.response, &ctx, state, parser, is_stream, guard).await?;
    if source.auth_kind == "codex_oauth" && wire == Wire::Responses && !client_stream {
        return codex_subscription_non_streaming_response(response).await;
    }
    Ok(response)
}

async fn codex_subscription_non_streaming_response(
    response: Response,
) -> Result<Response, ProxyError> {
    if !response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_none_or(|value| value.contains("text/event-stream"))
    {
        return Ok(response);
    }
    let (mut parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, MAX_REQUEST_BYTES)
        .await
        .map_err(|_| ProxyError::TransformError("订阅响应流无法读取或超过限制".into()))?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| ProxyError::TransformError("订阅响应流编码无效".into()))?;
    let value = handlers::responses_sse_to_response_value(text)?;
    strip_entity_headers_for_rebuilt_body(&mut parts.headers);
    parts.headers.insert(
        "content-type",
        http::HeaderValue::from_static("application/json"),
    );
    Ok(Response::from_parts(
        parts,
        axum::body::Body::from(value.to_string()),
    ))
}

/// Convert the function-tool subset of Chat Completions to the existing
/// Messages bridge. Unsupported blocks fail instead of being silently dropped.
fn chat_request_to_messages(body: Value, max_output: Option<u64>) -> Result<Value, ProxyError> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| ProxyError::InvalidRequest("Chat 请求缺少 messages".into()))?;
    if body
        .get("n")
        .and_then(Value::as_u64)
        .is_some_and(|n| n != 1)
    {
        return Err(ProxyError::InvalidRequest("跨协议网关只支持 n = 1".into()));
    }
    let mut system = Vec::new();
    let mut converted: Vec<Value> = Vec::new();
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let mut content = chat_content(message.get("content"))?;
        if matches!(role, "system" | "developer") {
            if content
                .iter()
                .any(|block| block.get("type").and_then(Value::as_str) != Some("text"))
            {
                return Err(ProxyError::InvalidRequest("系统消息仅支持文字内容".into()));
            }
            system.extend(content);
            continue;
        }
        let role = match role {
            "user" => "user",
            "assistant" => "assistant",
            "tool" => {
                let id = message
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProxyError::InvalidRequest("工具结果缺少 tool_call_id".into())
                    })?;
                content = vec![json!({"type":"tool_result","tool_use_id":id,"content":content})];
                "user"
            }
            _ => return Err(ProxyError::InvalidRequest("不支持的 Chat 消息角色".into())),
        };
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                if call.get("type").and_then(Value::as_str) != Some("function") {
                    return Err(ProxyError::InvalidRequest(
                        "跨协议仅支持 function 工具".into(),
                    ));
                }
                let function = call
                    .get("function")
                    .ok_or_else(|| ProxyError::InvalidRequest("工具定义无效".into()))?;
                let arguments = function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}");
                let input: Value = serde_json::from_str(arguments)
                    .map_err(|_| ProxyError::InvalidRequest("工具参数必须是 JSON".into()))?;
                content.push(json!({
                    "type":"tool_use", "id":call.get("id"), "name":function.get("name"), "input":input
                }));
            }
        }
        if let Some(previous) = converted
            .last_mut()
            .filter(|last| last.get("role").and_then(Value::as_str) == Some(role))
        {
            previous["content"]
                .as_array_mut()
                .expect("constructed array")
                .extend(content);
        } else {
            converted.push(json!({"role":role,"content":content}));
        }
    }
    let mut result = json!({
        "model":body.get("model"), "messages":converted,
        "max_tokens":body.get("max_completion_tokens").or_else(|| body.get("max_tokens"))
            .cloned().unwrap_or_else(|| json!(max_output.unwrap_or(16384))),
        "stream":body.get("stream").cloned().unwrap_or(json!(false)),
    });
    if !system.is_empty() {
        result["system"] = json!(system);
    }
    for key in ["temperature", "top_p", "metadata", "reasoning_effort"] {
        if let Some(value) = body.get(key) {
            result[key] = value.clone();
        }
    }
    if let Some(stop) = body.get("stop") {
        result["stop_sequences"] = if stop.is_string() {
            json!([stop])
        } else {
            stop.clone()
        };
    }
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let mut declarations = Vec::new();
        for tool in tools {
            if tool.get("type").and_then(Value::as_str) != Some("function") {
                return Err(ProxyError::InvalidRequest(
                    "跨协议仅支持 function 工具".into(),
                ));
            }
            let function = tool
                .get("function")
                .ok_or_else(|| ProxyError::InvalidRequest("工具定义无效".into()))?;
            declarations.push(json!({
                "name":function.get("name"), "description":function.get("description"),
                "input_schema":function.get("parameters").cloned().unwrap_or(json!({"type":"object","properties":{}}))
            }));
        }
        result["tools"] = json!(declarations);
    }
    if let Some(choice) = body.get("tool_choice") {
        result["tool_choice"] = match choice.as_str() {
            Some("auto") => json!({"type":"auto"}),
            Some("required") => json!({"type":"any"}),
            Some("none") => json!({"type":"none"}),
            _ if choice.get("type").and_then(Value::as_str) == Some("function") => {
                json!({"type":"tool","name":choice.pointer("/function/name")})
            }
            _ => return Err(ProxyError::InvalidRequest("不支持的 tool_choice".into())),
        };
    }
    // These fields require upstream-specific semantics which the Messages
    // bridge cannot preserve.
    for key in [
        "audio",
        "modalities",
        "response_format",
        "logprobs",
        "functions",
        "function_call",
    ] {
        if body.get(key).is_some_and(|value| !value.is_null()) {
            return Err(ProxyError::InvalidRequest(format!(
                "跨协议转换尚不支持 {key}"
            )));
        }
    }
    Ok(result)
}

fn chat_content(content: Option<&Value>) -> Result<Vec<Value>, ProxyError> {
    match content {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(text)) => Ok(vec![json!({"type":"text","text":text})]),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| match block.get("type").and_then(Value::as_str) {
                Some("text") => Ok(json!({"type":"text","text":block.get("text")})),
                Some("image_url") => {
                    let url = block
                        .pointer("/image_url/url")
                        .and_then(Value::as_str)
                        .ok_or_else(|| ProxyError::InvalidRequest("图片 URL 无效".into()))?;
                    let source = if let Some(data) = url.strip_prefix("data:") {
                        let (media_type, payload) =
                            data.split_once(";base64,").ok_or_else(|| {
                                ProxyError::InvalidRequest("图片仅支持 base64 data URL".into())
                            })?;
                        json!({"type":"base64","media_type":media_type,"data":payload})
                    } else {
                        json!({"type":"url","url":url})
                    };
                    Ok(json!({"type":"image","source":source}))
                }
                _ => Err(ProxyError::InvalidRequest(
                    "跨协议不支持此消息内容类型".into(),
                )),
            })
            .collect(),
        _ => Err(ProxyError::InvalidRequest("消息 content 无效".into())),
    }
}

fn finish_reason(reason: Option<&str>) -> &'static str {
    match reason {
        Some("tool_use") => "tool_calls",
        Some("max_tokens") => "length",
        _ => "stop",
    }
}

fn prompt_tokens(usage: Option<&Value>) -> u64 {
    [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .into_iter()
    .fold(0u64, |total, key| {
        total.saturating_add(
            usage
                .and_then(|usage| usage.get(key))
                .and_then(Value::as_u64)
                .unwrap_or(0),
        )
    })
}

fn reported_chat_usage(usage: &Value) -> Value {
    let mut result=serde_json::Map::new();
    let input=usage.get("input_tokens").and_then(Value::as_u64).map(|_|prompt_tokens(Some(usage)));
    let output=usage.get("output_tokens").and_then(Value::as_u64);
    if let Some(value)=input {result.insert("prompt_tokens".into(),json!(value));}
    if let Some(value)=output {result.insert("completion_tokens".into(),json!(value));}
    if let (Some(input),Some(output))=(input,output) {result.insert("total_tokens".into(),json!(input.saturating_add(output)));}
    if let Some(value)=usage.get("cache_read_input_tokens").and_then(Value::as_u64) {
        result.insert("prompt_tokens_details".into(),json!({"cached_tokens":value}));
    }
    if let Some(value)=usage.get("cache_creation_input_tokens").and_then(Value::as_u64) {
        result.insert("cache_creation_input_tokens".into(),json!(value));
    }
    Value::Object(result)
}

fn messages_json_to_chat(body: Value, model: &str) -> Value {
    let content = body.get("content").and_then(Value::as_array);
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut calls = Vec::new();
    for block in content.into_iter().flatten() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => text.push_str(block.get("text").and_then(Value::as_str).unwrap_or("")),
            Some("thinking") => reasoning.push_str(block.get("thinking").and_then(Value::as_str).unwrap_or("")),
            Some("tool_use") => calls.push(json!({
                "id":block.get("id"),"type":"function",
                "function":{"name":block.get("name"),"arguments":block.get("input").unwrap_or(&json!({})).to_string()}
            })),
            _ => {}
        }
    }
    let mut message = json!({"role":"assistant","content":text});
    if !calls.is_empty() {
        message["tool_calls"] = json!(calls);
    }
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    let usage=reported_chat_usage(body.get("usage").unwrap_or(&Value::Null));
    json!({
        "id":body.get("id"), "object":"chat.completion", "created":chrono::Utc::now().timestamp(),
        "model":model,"choices":[{"index":0,"message":message,
            "finish_reason":finish_reason(body.get("stop_reason").and_then(Value::as_str))}],
        "usage":usage
    })
}

async fn messages_response_to_chat(
    response: Response,
    model: String,
    is_stream: bool,
) -> Result<Response, ProxyError> {
    if !response.status().is_success() {
        return Ok(response);
    }
    let (mut parts, body) = response.into_parts();
    let upstream_sse = parts
        .headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"));
    strip_hop_by_hop_response_headers(&mut parts.headers);
    strip_entity_headers_for_rebuilt_body(&mut parts.headers);
    if is_stream && upstream_sse {
        parts.headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("text/event-stream"),
        );
        let stream = messages_sse_to_chat(body.into_data_stream(), model);
        return Ok(Response::from_parts(
            parts,
            axum::body::Body::from_stream(stream),
        ));
    }
    let bytes = axum::body::to_bytes(body, super::hyper_client::MAX_RESPONSE_BODY_BYTES)
        .await
        .map_err(|_| ProxyError::TransformError("无法读取跨协议响应".into()))?;
    let value = parse_messages_response(&bytes, upstream_sse)?;
    if is_stream {
        let chat = messages_json_to_chat(value, &model);
        let id = chat["id"].as_str().unwrap_or("chatcmpl-gateway");
        let mut message = chat["choices"][0]["message"].clone();
        if let Some(tools) = message.get_mut("tool_calls").and_then(Value::as_array_mut) {
            for (index, tool) in tools.iter_mut().enumerate() {
                tool["index"] = json!(index);
            }
        }
        let mut output = chat_chunk(id, &model, message, Value::Null).to_vec();
        output.extend_from_slice(&chat_chunk(
            id,
            &model,
            json!({}),
            chat["choices"][0]["finish_reason"].clone(),
        ));
        output.extend_from_slice(format!("data: {}\n\ndata: [DONE]\n\n",json!({
            "id":id,"object":"chat.completion.chunk","created":chrono::Utc::now().timestamp(),
            "model":model,"choices":[],"usage":chat["usage"]
        })).as_bytes());
        parts.headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("text/event-stream"),
        );
        return Ok(Response::from_parts(parts, axum::body::Body::from(output)));
    }
    parts.headers.insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("application/json"),
    );
    Ok(Response::from_parts(
        parts,
        axum::body::Body::from(messages_json_to_chat(value, &model).to_string()),
    ))
}

async fn messages_response_to_responses(
    response: Response,
    is_stream: bool,
    context: transform_codex_chat::CodexToolContext,
) -> Result<Response, ProxyError> {
    if !response.status().is_success() {
        return Ok(response);
    }
    let (mut parts, body) = response.into_parts();
    let upstream_sse = parts
        .headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"));
    strip_hop_by_hop_response_headers(&mut parts.headers);
    strip_entity_headers_for_rebuilt_body(&mut parts.headers);
    if is_stream && upstream_sse {
        parts.headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("text/event-stream"),
        );
        let stream = create_responses_sse_stream_from_anthropic_with_context(
            body.into_data_stream(),
            context,
        );
        return Ok(Response::from_parts(
            parts,
            axum::body::Body::from_stream(stream),
        ));
    }
    let bytes = axum::body::to_bytes(body, super::hyper_client::MAX_RESPONSE_BODY_BYTES)
        .await
        .map_err(|_| ProxyError::TransformError("无法读取跨协议响应".into()))?;
    let value = parse_messages_response(&bytes, upstream_sse)?;
    if is_stream {
        let events = responses_sse_events_from_anthropic_message(&value, context);
        let stream = futures::stream::iter(events.into_iter().map(Ok::<_, std::io::Error>));
        parts.headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("text/event-stream"),
        );
        return Ok(Response::from_parts(
            parts,
            axum::body::Body::from_stream(stream),
        ));
    }
    let value =
        transform_codex_anthropic::anthropic_response_to_responses_with_context(value, &context)?;
    parts.headers.insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("application/json"),
    );
    Ok(Response::from_parts(
        parts,
        axum::body::Body::from(value.to_string()),
    ))
}

fn parse_messages_response(bytes: &[u8], sse: bool) -> Result<Value, ProxyError> {
    let value = if sse {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| ProxyError::TransformError("上游 SSE 编码无效".into()))?;
        transform_codex_anthropic::anthropic_sse_to_message_value(text)?
    } else {
        serde_json::from_slice(bytes)
            .map_err(|_| ProxyError::TransformError("上游响应不是有效的 Messages JSON".into()))?
    };
    if !value.is_object()
        || value.get("content").and_then(Value::as_array).is_none()
        || value.get("error").is_some()
    {
        return Err(ProxyError::TransformError(
            "上游未返回有效的 Messages 响应".into(),
        ));
    }
    Ok(value)
}

fn sse_json(block: &str) -> Option<Value> {
    let data = block
        .lines()
        .filter_map(|line| strip_sse_field(line, "data"))
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::from_str(&data).ok()
}

fn chat_chunk(id: &str, model: &str, delta: Value, finish: Value) -> Bytes {
    Bytes::from(format!(
        "data: {}\n\n",
        json!({
            "id":id, "object":"chat.completion.chunk", "created":chrono::Utc::now().timestamp(),
            "model":model, "choices":[{"index":0,"delta":delta,"finish_reason":finish}]
        })
    ))
}

fn messages_sse_to_chat<S, E>(
    input: S,
    model: String,
) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> + Send
where
    S: futures::Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + 'static,
{
    async_stream::stream! {
        let mut input = Box::pin(input);
        let mut buffer = String::new();
        let mut utf8 = Vec::new();
        let mut id = format!("chatcmpl-{}", uuid::Uuid::new_v4());
        let mut tools = std::collections::HashMap::new();
        let mut reported_usage = json!({});
        let mut finished = false;
        while let Some(chunk) = input.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => { yield Err(std::io::Error::other(error.to_string())); return; }
            };
            utf8.extend_from_slice(&chunk);
            match std::str::from_utf8(&utf8) {
                Ok(text) => { buffer.push_str(text); utf8.clear(); }
                Err(error) if error.error_len().is_none() => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        buffer.push_str(std::str::from_utf8(&utf8[..valid]).expect("valid prefix"));
                        utf8.drain(..valid);
                    }
                }
                Err(_) => { yield Err(std::io::Error::other("Invalid UTF-8 in upstream SSE")); return; }
            }
            if buffer.len() > MAX_SSE_EVENT_BYTES {
                yield Err(std::io::Error::other("Upstream SSE event exceeds limit")); return;
            }
            while let Some(block) = take_sse_block(&mut buffer) {
                let Some(event) = sse_json(&block) else { continue; };
                match event.get("type").and_then(Value::as_str) {
                    Some("message_start") => {
                        if let Some(value) = event.pointer("/message/id").and_then(Value::as_str) { id = value.to_string(); }
                        if let Some(usage)=event.pointer("/message/usage").and_then(Value::as_object) {
                            reported_usage.as_object_mut().expect("usage object").extend(usage.clone());
                        }
                        yield Ok(chat_chunk(&id,&model,json!({"role":"assistant","content":""}),Value::Null));
                    }
                    Some("content_block_start") => {
                        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                        let block = &event["content_block"];
                        match block.get("type").and_then(Value::as_str) {
                            Some("tool_use") => {
                                let tool_index = tools.len();
                                tools.insert(index,tool_index);
                                let arguments = block.get("input").filter(|value| value.as_object().is_none_or(|object| !object.is_empty()))
                                    .map(Value::to_string).unwrap_or_default();
                                yield Ok(chat_chunk(&id,&model,json!({"tool_calls":[{
                                    "index":tool_index,"id":block.get("id"),"type":"function",
                                    "function":{"name":block.get("name"),"arguments":arguments}
                                }]}),Value::Null));
                            }
                            Some("text") => {
                                if let Some(text) = block.get("text").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                                    yield Ok(chat_chunk(&id,&model,json!({"content":text}),Value::Null));
                                }
                            }
                            _ => {}
                        }
                    }
                    Some("content_block_delta") => {
                        let delta = &event["delta"];
                        match delta.get("type").and_then(Value::as_str) {
                            Some("text_delta") => yield Ok(chat_chunk(&id,&model,json!({"content":delta.get("text")}),Value::Null)),
                            Some("thinking_delta") => yield Ok(chat_chunk(&id,&model,json!({"reasoning_content":delta.get("thinking")}),Value::Null)),
                            Some("input_json_delta") => {
                                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                                if let Some(tool_index) = tools.get(&index) {
                                    yield Ok(chat_chunk(&id,&model,json!({"tool_calls":[{
                                        "index":tool_index,"function":{"arguments":delta.get("partial_json")}
                                    }]}),Value::Null));
                                }
                            }
                            _ => {}
                        }
                    }
                    Some("message_delta") => {
                        if let Some(usage)=event.get("usage").and_then(Value::as_object) {
                            reported_usage.as_object_mut().expect("usage object").extend(usage.clone());
                        }
                        if let Some(reason) = event.pointer("/delta/stop_reason").and_then(Value::as_str) {
                            yield Ok(chat_chunk(&id,&model,json!({}),json!(finish_reason(Some(reason)))));
                        }
                    }
                    Some("message_stop") => {
                        yield Ok(Bytes::from(format!("data: {}\n\n",json!({
                            "id":id,"object":"chat.completion.chunk","created":chrono::Utc::now().timestamp(),
                            "model":model,"choices":[],
                            "usage":reported_chat_usage(&reported_usage)
                        }))));
                        yield Ok(Bytes::from_static(b"data: [DONE]\n\n"));
                        finished = true;
                    }
                    Some("error") => {
                        yield Ok(Bytes::from(format!("data: {}\n\n",json!({"error":event.get("error")}))));
                        yield Ok(Bytes::from_static(b"data: [DONE]\n\n"));
                        return;
                    }
                    _ => {}
                }
            }
            if finished { return; }
        }
        if !finished {
            yield Err(std::io::Error::other("Upstream stream ended before message_stop"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> ChannelSource {
        serde_json::from_value(json!({
            "id":"test","name":"Test","baseUrl":"https://example.invalid/v1",
            "apiKey":"test-secret","authKind":"api_key","protocol":"openai_chat","enabled":true,
            "models":[{"id":"vendor/model","supportsTools":true},{"id":"disabled","enabled":false},{"id":"no-tools","supportsTools":false}]
        }))
        .unwrap()
    }

    #[test]
    fn authentication_requires_tcp_loopback_and_the_local_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            http::HeaderValue::from_static("Bearer local-secret"),
        );
        assert!(authorize(None, &headers, "local-secret").is_err());
        assert!(authorize(
            Some(&GatewayPeer("192.0.2.1:1234".parse().unwrap())),
            &headers,
            "local-secret"
        )
        .is_err());
        assert!(authorize(
            Some(&GatewayPeer("127.0.0.1:1234".parse().unwrap())),
            &headers,
            "local-secret"
        )
        .is_ok());
        assert!(authorize(
            Some(&GatewayPeer("[::1]:1234".parse().unwrap())),
            &headers,
            "wrong"
        )
        .is_err());
        assert!(authorize(
            Some(&GatewayPeer("[::1]:1234".parse().unwrap())),
            &headers,
            ""
        )
        .is_err());
    }

    #[test]
    fn selection_never_falls_back_and_keeps_vendor_model_slashes() {
        let channels = vec![source()];
        assert_eq!(
            resolve_model(&channels, "test/vendor/model").unwrap().1.id,
            "vendor/model"
        );
        for model in [
            "vendor/model",
            "missing/vendor/model",
            "test/missing",
            "test/disabled",
            "test/no-tools",
        ] {
            assert!(resolve_model(&channels, model).is_err(), "{model}");
        }
        let mut disabled = source();
        disabled.enabled = false;
        assert!(resolve_model(&[disabled], "test/vendor/model").is_err());
    }

    #[test]
    fn managed_provider_contains_a_binding_and_no_short_lived_token() {
        let mut source = source();
        source.auth_kind = "github_copilot".into();
        source.api_key.clear();
        source.account_id = Some("account-id".into());
        let provider = provider_for(&source, &source.models[0], Wire::Chat).unwrap();
        assert_eq!(
            provider
                .meta
                .as_ref()
                .unwrap()
                .managed_account_id_for("github_copilot")
                .as_deref(),
            Some("account-id")
        );
        assert_eq!(
            provider.settings_config.pointer("/auth/OPENAI_API_KEY"),
            Some(&json!(""))
        );
    }

    #[test]
    fn channel_subscription_routing_reuses_native_auth_bindings_and_fixed_origins() {
        use super::super::providers::AuthStrategy;
        for (kind, strategy) in [
            ("codex_oauth", AuthStrategy::CodexOAuth),
            ("xai_oauth", AuthStrategy::XaiOAuth),
        ] {
            let mut source = source();
            source.auth_kind = kind.into();
            source.account_id = Some("specifically-selected-account".into());
            source.api_key = "never-used-static-key".into();
            source.base_url = "https://untrusted.invalid".into();
            // Managed protocols cannot be redirected by editable model metadata.
            source.models[0].protocol = Some("anthropic".into());
            for (wire, app) in [
                (Wire::Messages, AppType::Claude),
                (Wire::Responses, AppType::Codex),
            ] {
                let provider = provider_for(&source, &source.models[0], wire).unwrap();
                assert_eq!(
                    provider
                        .meta
                        .as_ref()
                        .unwrap()
                        .managed_account_id_for(kind)
                        .as_deref(),
                    Some("specifically-selected-account")
                );
                let adapter = get_adapter(&app).unwrap();
                if wire == Wire::Responses {
                    assert!(!super::super::providers::is_codex_official_provider(
                        &provider
                    ));
                }
                assert_eq!(adapter.extract_auth(&provider).unwrap().strategy, strategy);
                assert_eq!(
                    adapter.extract_base_url(&provider).unwrap(),
                    channel_center::managed_subscription_route(kind).unwrap().0
                );
                assert!(!provider
                    .settings_config
                    .to_string()
                    .contains("never-used-static-key"));
                assert!(!provider
                    .settings_config
                    .to_string()
                    .contains("untrusted.invalid"));
                assert_eq!(protocol(&source, &source.models[0]), "openai_responses");
            }
            source.account_id = None;
            assert!(provider_for(&source, &source.models[0], Wire::Responses).is_err());
        }
    }

    #[tokio::test]
    async fn channel_native_subscription_is_not_published_or_forwarded_by_gateway() {
        let native = [
            channel_center::native_subscription_channel("claude").unwrap(),
            channel_center::native_subscription_channel("gemini").unwrap(),
        ];
        for channel in &native {
            assert!(resolve_model(&native, &format!("{}/native-default", channel.id)).is_err());
            assert!(provider_for(channel, &channel.models[0], Wire::Messages).is_err());
        }
        let db = std::sync::Arc::new(crate::database::Database::memory().unwrap());
        let mut channels = vec![source()];
        channels.extend(native);
        let snapshot = channel_center::ChannelCenterSnapshot {
            revision: 1,
            channels,
            targets: vec![],
            default_model: None,
        };
        db.set_setting(
            "channel_center_applied",
            &serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let token = channel_center::gateway_token(&db).unwrap();
        let state = ProxyState::for_test(db);
        let mut request = Request::builder()
            .uri("/tai/v1/models")
            .header("authorization", format!("Bearer {token}"))
            .body(axum::body::Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(GatewayPeer("127.0.0.1:7070".parse().unwrap()));
        let Json(catalog) = handle_models(State(state), request).await.unwrap();
        assert_eq!(catalog["data"].as_array().unwrap().len(), 1);
        assert_eq!(catalog["data"][0]["id"], "test/vendor/model");
        assert!(!catalog.to_string().contains("native-default"));
    }

    #[tokio::test]
    async fn channel_codex_subscription_nonstream_reply_preserves_tools_and_usage() {
        let value = json!({"id":"resp_subscription","object":"response","status":"completed",
            "output":[{"type":"function_call","call_id":"call1","name":"read","arguments":"{\"path\":\"文件\"}"}],
            "usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":80}}});
        let data = format!(
            "event: response.completed\ndata: {}\n\n",
            json!({"type":"response.completed","response":value})
        );
        for explicit_content_type in [true, false] {
            let mut builder = Response::builder();
            if explicit_content_type {
                builder = builder.header("content-type", "text/event-stream");
            }
            let chunks = data
                .as_bytes()
                .chunks(3)
                .map(|chunk| Ok::<_, std::io::Error>(Bytes::copy_from_slice(chunk)))
                .collect::<Vec<_>>();
            let response = builder
                .body(axum::body::Body::from_stream(futures::stream::iter(chunks)))
                .unwrap();
            let response = codex_subscription_non_streaming_response(response)
                .await
                .unwrap();
            assert_eq!(response.headers()["content-type"], "application/json");
            let body = axum::body::to_bytes(response.into_body(), MAX_REQUEST_BYTES)
                .await
                .unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), value);
        }
    }

    #[test]
    fn explicit_unsupported_model_capabilities_fail_before_forwarding() {
        let mut unsupported = source().models[0].clone();
        unsupported.supports_tools = Some(false);
        assert!(
            validate_capabilities(&unsupported, &json!({"tools":[{"type":"function"}]})).is_err()
        );
    }

    #[test]
    fn messages_limits_preserve_lower_user_caps_and_keep_legacy_thinking_valid() {
        let mut model = source().models.remove(0);
        model.output_limit = Some(4096);
        let mut request = json!({"max_tokens":16384,"thinking":{"type":"enabled","budget_tokens":12000}});
        prepare_messages_request(&mut request, &model, "anthropic").unwrap();
        assert_eq!(request["max_tokens"], 4096);
        assert_eq!(request["thinking"]["budget_tokens"], 4095);

        let mut lower = json!({"max_tokens":2048,"output_config":{"effort":"low"}});
        prepare_messages_request(&mut lower, &model, "anthropic").unwrap();
        assert_eq!(lower["max_tokens"], 2048);
        assert!(lower.get("thinking").is_none(), "native Messages stays native");

        model.output_limit = Some(1024);
        let mut too_small = json!({"max_tokens":16384,"thinking":{"type":"enabled","budget_tokens":12000}});
        assert!(prepare_messages_request(&mut too_small, &model, "anthropic").is_err());

        model.output_limit = None;
        let unchanged = json!({"max_tokens":16384});
        let mut unknown = unchanged.clone();
        prepare_messages_request(&mut unknown, &model, "openai_chat").unwrap();
        assert_eq!(unknown, unchanged, "unknown limits and omitted effort are not guessed");
    }

    #[tokio::test]
    async fn claude_gateway_preserves_explicit_effort_and_uses_each_models_output_limit() {
        use super::super::{server::ProxyServer, types::ProxyConfig};
        use crate::database::Database;
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let captured = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let capture = {
            let captured = captured.clone();
            move |request: Request| {
                let captured = captured.clone();
                async move {
                    let path = request.uri().path().to_string();
                    let bytes = axum::body::to_bytes(request.into_body(), MAX_REQUEST_BYTES).await.unwrap();
                    let body: Value = serde_json::from_slice(&bytes).unwrap();
                    captured.lock().await.push((path.clone(), body.clone()));
                    let reply = if path.ends_with("/chat/completions") {
                        json!({"id":"chat_test","object":"chat.completion","model":body["model"],
                            "choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],
                            "usage":{"prompt_tokens":3,"completion_tokens":2}})
                    } else if path.ends_with("/responses") {
                        json!({"id":"resp_test","object":"response","model":body["model"],"status":"completed",
                            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],
                            "usage":{"input_tokens":3,"output_tokens":2}})
                    } else {
                        json!({"id":"msg_test","type":"message","model":body["model"],"role":"assistant",
                            "content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn",
                            "usage":{"input_tokens":3,"output_tokens":2}})
                    };
                    Json(reply)
                }
            }
        };
        let upstream = axum::Router::new()
            .route("/v1/messages", axum::routing::post(capture.clone()))
            .route("/v1/chat/completions", axum::routing::post(capture.clone()))
            .route("/v1/responses", axum::routing::post(capture));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let upstream_task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap(); });
        let db = Arc::new(Database::memory().unwrap());
        let token = channel_center::gateway_token(&db).unwrap();
        let proxy = ProxyServer::new(ProxyConfig { listen_port:0, ..Default::default() }, db.clone(), None);
        let info = proxy.start().await.unwrap();
        let base = gateway_base_url(&info.address, info.port).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut source = source();
        source.base_url = format!("http://{address}/v1");
        source.models.truncate(1);
        source.models[0].id = "gpt-5.4".into();
        source.models[0].output_limit = Some(32768);
        let mut small = source.models[0].clone();
        small.id = "gpt-5.4-mini".into();
        small.output_limit = Some(4096);
        source.models.push(small);

        for upstream_protocol in ["openai_chat", "openai_responses", "anthropic"] {
            source.protocol = upstream_protocol.into();
            db.set_setting("channel_center_applied", &serde_json::to_string(&ChannelCenterSnapshot {
                channels:vec![source.clone()], ..Default::default()
            }).unwrap()).unwrap();
            for (model_index, output_cap) in [(0,16384), (1,4096), (0,16384)] {
                for thinking_off in [false, true] {
                    let published = channel_center::claude_route_id(&source, &source.models[model_index]);
                    let mut request = json!({"model":published,"max_tokens":16384,"output_config":{"effort":"high"},
                        "system":"Keep the task instructions unchanged.",
                        "messages":[{"role":"user","content":"inspect x"},
                            {"role":"assistant","content":[{"type":"tool_use","id":"call_test","name":"read","input":{"path":"x"}}]},
                            {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_test","content":"original file contents"}]}],
                        "tools":[{"name":"read","description":"read a file","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}]});
                    if thinking_off { request["thinking"] = json!({"type":"disabled"}); }
                    let response = client.post(format!("{base}/messages")).bearer_auth(&token)
                        .json(&request).send().await.unwrap();
                    assert!(response.status().is_success(), "{upstream_protocol}: {}", response.text().await.unwrap());
                    let output: Value = response.json().await.unwrap();
                    assert_eq!(output["content"][0]["text"], "ok");
                    let captured = captured.lock().await;
                    let (_, sent) = captured.last().unwrap();
                    assert_eq!(sent["model"], source.models[model_index].id);
                    if upstream_protocol == "anthropic" {
                        assert_eq!(sent["max_tokens"], output_cap);
                        assert_eq!(sent["output_config"]["effort"], "high");
                        assert_eq!(sent.get("thinking"), request.get("thinking"));
                        assert_eq!(sent["system"], request["system"]);
                        assert_eq!(sent["tools"], request["tools"]);
                        assert_eq!(sent["messages"], request["messages"]);
                    } else {
                        let effort = if upstream_protocol == "openai_chat" {
                            assert_eq!(sent["max_tokens"], output_cap);
                            &sent["reasoning_effort"]
                        } else {
                            assert_eq!(sent["max_output_tokens"], output_cap);
                            &sent["reasoning"]["effort"]
                        };
                        assert_eq!(effort, if thinking_off { "low" } else { "high" });
                        assert!(sent.to_string().contains("Keep the task instructions unchanged."));
                        assert!(sent.to_string().contains("original file contents"));
                        assert!(sent.to_string().contains("call_test"));
                        assert!(sent["tools"].as_array().is_some_and(|tools| !tools.is_empty()));
                    }
                }
            }
        }
        assert_eq!(captured.lock().await.len(), 18);
        proxy.stop().await.unwrap();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn native_lolicode_streamed_requests_are_billed_once_under_the_app_and_channel() {
        use super::super::{server::ProxyServer, types::ProxyConfig};
        use crate::database::Database;
        use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
        let sequence=Arc::new(AtomicUsize::new(0));
        let capture=move |request:Request| {
            let id=sequence.fetch_add(1,Ordering::SeqCst);
            async move {
                let path=request.uri().path();
                if path.ends_with("/chat/completions") {
                    let sse=format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                        json!({"id":format!("chat_{id}"),"model":"meter-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}),
                        json!({"id":format!("chat_{id}"),"model":"meter-model","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":20}}}));
                    Response::builder().header("content-type","text/event-stream").body(axum::body::Body::from(sse)).unwrap()
                } else if path.ends_with("/responses") {
                    Json(json!({"id":format!("resp_{id}"),"object":"response","model":"meter-model","status":"completed",
                        "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],
                        "usage":{"input_tokens":100,"output_tokens":10,"input_tokens_details":{"cached_tokens":20}}})).into_response()
                } else {
                    Json(json!({"id":format!("msg_{id}"),"type":"message","role":"assistant","model":"meter-model",
                        "content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn",
                        "usage":{"input_tokens":80,"output_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":0}})).into_response()
                }
            }
        };
        let upstream=axum::Router::new()
            .route("/v1/chat/completions",axum::routing::post(capture.clone()))
            .route("/v1/responses",axum::routing::post(capture.clone()))
            .route("/v1/messages",axum::routing::post(capture));
        let listener=tokio::net::TcpListener::bind(("127.0.0.1",0)).await.unwrap();
        let address=listener.local_addr().unwrap();
        let task=tokio::spawn(async move {axum::serve(listener,upstream).await.unwrap();});
        let db=Arc::new(Database::memory().unwrap());
        {
            let conn=db.conn.lock().unwrap();
            conn.execute("INSERT INTO model_pricing(model_id,display_name,input_cost_per_million,output_cost_per_million,cache_read_cost_per_million,cache_creation_cost_per_million)
                VALUES('meter-model','Meter model','1','2','0.5','1.25')",[]).unwrap();
        }
        let token=channel_center::gateway_token(&db).unwrap();
        let proxy=ProxyServer::new(ProxyConfig {listen_port:0,..Default::default()},db.clone(),None);
        let info=proxy.start().await.unwrap();
        let base=gateway_catalog_base_url(&info.address,info.port,42).unwrap();
        let base=catalog_client_base_url(&base,"lolicode").unwrap();
        let client=reqwest::Client::builder().no_proxy().build().unwrap();
        let mut source=source();
        source.base_url=format!("http://{address}/v1"); source.models.truncate(1); source.models[0].id="meter-model".into();
        for (index,protocol) in ["openai_chat","anthropic","openai_responses"].into_iter().enumerate() {
            source.protocol=protocol.into();
            db.set_setting("channel_center_catalog_42",&serde_json::to_string(&ChannelCenterSnapshot {channels:vec![source.clone()],..Default::default()}).unwrap()).unwrap();
            let response=client.post(format!("{base}/chat/completions")).bearer_auth(&token)
                .json(&json!({"model":"test/meter-model","messages":[{"role":"user","content":"hello"}],"stream":true,"stream_options":{"include_usage":true}}))
                .send().await.unwrap();
            assert!(response.status().is_success(),"{protocol}: {}",response.text().await.unwrap());
            assert!(response.text().await.unwrap().contains("ok"));
            tokio::time::timeout(std::time::Duration::from_secs(5),async {
                loop {
                    if db.get_usage_summary(None,None,Some("lolicode"),None,None).unwrap().total_requests == (index+1) as u64 {break;}
                    tokio::task::yield_now().await;
                }
            }).await.unwrap();
        }
        let own=db.get_usage_summary(None,None,Some("lolicode"),None,None).unwrap();
        assert_eq!(own.total_requests,3); assert_eq!(own.total_input_tokens,240);
        assert_eq!(own.total_output_tokens,30); assert_eq!(own.total_cache_read_tokens,60);
        assert_eq!(own.real_total_tokens,330); assert_eq!(own.total_cost,"0.000330");
        let channels=db.get_provider_stats(None,None,Some("lolicode"),None,None).unwrap();
        assert_eq!(channels.len(),1); assert_eq!(channels[0].provider_id,"channel-test");
        assert_eq!(channels[0].request_count,3); assert_eq!(channels[0].total_tokens,330);
        assert_eq!(db.get_usage_summary(None,None,Some("channel-gateway"),None,None).unwrap().total_requests,0);
        assert_eq!(db.get_usage_summary(None,None,None,None,None).unwrap().total_requests,3);
        proxy.stop().await.unwrap(); task.abort();
    }

    #[test]
    fn chat_bridge_preserves_tool_results_and_images_and_rejects_unsupported_fields() {
        let input = json!({"model":"m","messages":[
            {"role":"system","content":"instructions"},
            {"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"read","arguments":"{\"path\":\"x\"}"}}]},
            {"role":"tool","tool_call_id":"call-1","content":"result"},
            {"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8="}}]}
        ],"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}]});
        let converted = chat_request_to_messages(input.clone(), Some(4096)).unwrap();
        assert_eq!(converted["max_tokens"], 4096);
        assert_eq!(converted["messages"][0]["content"][0]["input"]["path"], "x");
        assert_eq!(
            converted["messages"][1]["content"][0]["tool_use_id"],
            "call-1"
        );
        assert_eq!(
            converted["messages"][1]["content"][1]["source"]["media_type"],
            "image/png"
        );
        let mut unsupported = input;
        unsupported["response_format"] = json!({"type":"json_schema"});
        assert!(chat_request_to_messages(unsupported, None).is_err());
    }

    #[tokio::test]
    async fn chat_stream_preserves_split_utf8_and_tool_arguments() {
        let sse = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"usage\":{\"input_tokens\":3}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call\",\"name\":\"read\",\"input\":{}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"文件\\\"}\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":4}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let chunks = sse
            .as_bytes()
            .chunks(7)
            .map(|bytes| Ok::<_, std::io::Error>(Bytes::copy_from_slice(bytes)))
            .collect::<Vec<_>>();
        let stream = messages_sse_to_chat(futures::stream::iter(chunks), "test/model".into());
        let output = Box::pin(stream)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let output = output
            .into_iter()
            .flat_map(|bytes| bytes.to_vec())
            .collect::<Vec<_>>();
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("文件"));
        assert!(output.contains("tool_calls"));
        assert!(output.contains("\"total_tokens\":7"));
        assert!(output.ends_with("data: [DONE]\n\n"));
    }

    #[tokio::test]
    async fn cross_protocol_json_stream_fallback_preserves_tools_and_rejects_invalid_success_bodies(
    ) {
        let message = json!({"id":"msg_1","type":"message","role":"assistant","model":"m",
            "content":[{"type":"tool_use","id":"call","name":"read","input":{"path":"x"}}],
            "stop_reason":"tool_use","usage":{"input_tokens":3,"output_tokens":4}});
        let chat =
            messages_response_to_chat(Json(message.clone()).into_response(), "test/m".into(), true)
                .await
                .unwrap();
        assert_eq!(
            chat.headers().get("content-type").unwrap(),
            "text/event-stream"
        );
        let output = axum::body::to_bytes(chat.into_body(), MAX_REQUEST_BYTES)
            .await
            .unwrap();
        let output = String::from_utf8(output.to_vec()).unwrap();
        assert!(output.contains("\"index\":0"));
        assert!(output.contains("\"name\":\"read\""));
        assert!(output.contains("tool_calls"));
        assert!(output.ends_with("data: [DONE]\n\n"));
        let responses = messages_response_to_responses(
            Json(message).into_response(),
            true,
            transform_codex_chat::CodexToolContext::default(),
        )
        .await
        .unwrap();
        let output = axum::body::to_bytes(responses.into_body(), MAX_REQUEST_BYTES)
            .await
            .unwrap();
        let output = String::from_utf8(output.to_vec()).unwrap();
        assert!(output.contains("response.completed"));
        assert!(output.contains("function_call"));
        assert!(
            messages_response_to_chat(Json(json!([])).into_response(), "test/m".into(), false)
                .await
                .is_err()
        );
    }

    /// Real HTTP only to ephemeral loopback mock servers. No external service,
    /// harness configuration, or live Codex provider participates in this test.
    #[tokio::test]
    async fn gateway_bridges_tools_and_keeps_applied_sources_and_credentials_isolated() {
        use super::super::{server::ProxyServer, types::ProxyConfig};
        use crate::database::Database;
        use std::sync::Arc;
        use tokio::sync::Mutex;
        let captured = Arc::new(Mutex::new(Vec::<(String, HeaderMap, Value)>::new()));
        let capture = {
            let captured = captured.clone();
            move |request: Request| {
                let captured = captured.clone();
                async move {
                    let (parts, body) = request.into_parts();
                    let bytes = axum::body::to_bytes(body, MAX_REQUEST_BYTES).await.unwrap();
                    let body: Value = serde_json::from_slice(&bytes).unwrap();
                    let path = parts.uri.path().to_string();
                    captured
                        .lock()
                        .await
                        .push((path.clone(), parts.headers, body.clone()));
                    if path.ends_with("/responses") {
                        Json(json!({
                            "id":"resp_1","object":"response","created_at":1,"model":"vendor/model",
                            "status":"completed","output":[{"type":"function_call","id":"fc_1",
                                "call_id":"call_1","name":"read","arguments":"{\"path\":\"x\"}"}],
                            "usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}
                        }))
                        .into_response()
                    } else if body["stream"] == true {
                        let sse = concat!(
                            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":3}}}\n\n",
                            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"read\",\"input\":{}}}\n\n",
                            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"文件\\\"}\"}}\n\n",
                            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":4}}\n\n",
                            "data: {\"type\":\"message_stop\"}\n\n",
                        );
                        let chunks = sse
                            .as_bytes()
                            .chunks(7)
                            .map(|chunk| Ok::<_, std::io::Error>(Bytes::copy_from_slice(chunk)))
                            .collect::<Vec<_>>();
                        Response::builder()
                            .header("content-type", "text/event-stream")
                            .body(axum::body::Body::from_stream(futures::stream::iter(chunks)))
                            .unwrap()
                    } else {
                        Json(json!({
                            "id":"msg_1","type":"message","role":"assistant","model":"vendor/model",
                            "content":[{"type":"tool_use","id":"call_1","name":"read","input":{"path":"x"}}],
                            "stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":4}
                        })).into_response()
                    }
                }
            }
        };
        let upstream = axum::Router::new()
            .route("/v1/messages", axum::routing::post(capture.clone()))
            .route("/v1/responses", axum::routing::post(capture));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let upstream_address = listener.local_addr().unwrap();
        let upstream_task = tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let db = Arc::new(Database::memory().unwrap());
        let token = channel_center::gateway_token(db.as_ref()).unwrap();
        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                ..Default::default()
            },
            db.clone(),
            None,
        );
        let info = proxy.start().await.unwrap();
        let base = gateway_base_url(&info.address, info.port).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut source = source();
        source.base_url = format!("http://{upstream_address}/v1");
        source.api_key = "upstream-static-secret".into();
        source.models[0].supports_tools = Some(true);
        let mut snapshot = channel_center::ChannelCenterSnapshot {
            channels: vec![source.clone()],
            ..Default::default()
        };
        let request = json!({
            "model":"test/vendor/model","messages":[{"role":"user","content":"read x"}],
            "tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}]
        });
        for protocol in ["anthropic", "openai_responses"] {
            snapshot.channels[0].protocol = protocol.into();
            db.set_setting(
                "channel_center_applied",
                &serde_json::to_string(&snapshot).unwrap(),
            )
            .unwrap();
            // Saving an empty draft must not change the already applied gateway.
            db.set_setting("channel_center", "{\"channels\":[]}")
                .unwrap();
            let models = client
                .get(format!("{base}/models"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap();
            assert_eq!(models["data"][0]["id"], "test/vendor/model");
            assert_eq!(models["data"].as_array().unwrap().len(), 1);
            assert!(!models.to_string().contains("upstream-static-secret"));
            let response = client
                .post(format!("{base}/chat/completions"))
                .bearer_auth(&token)
                .header("cookie", "client-secret=must-not-leak")
                .json(&request)
                .send()
                .await
                .unwrap();
            assert!(
                response.status().is_success(),
                "{protocol}: {}",
                response.status()
            );
            let output: Value = response.json().await.unwrap();
            assert_eq!(
                output["choices"][0]["finish_reason"], "tool_calls",
                "{protocol}: {output}"
            );
            assert_eq!(
                output["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
                "read"
            );
            assert_eq!(
                output["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
                "{\"path\":\"x\"}"
            );
        }
        snapshot.channels[0].protocol = "anthropic".into();
        db.set_setting(
            "channel_center_applied",
            &serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let mut streamed_request = request.clone();
        streamed_request["stream"] = json!(true);
        let output = client
            .post(format!("{base}/chat/completions"))
            .bearer_auth(&token)
            .json(&streamed_request)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(output.contains("文件"));
        assert!(output.contains("\"finish_reason\":\"tool_calls\""));
        assert!(output.ends_with("data: [DONE]\n\n"));
        // Existing clients keep their immutable catalog when a different client
        // successfully applies a new catalog, or its own write fails.
        db.set_setting(
            "channel_center_catalog_7",
            &serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let version_base = gateway_catalog_base_url(&info.address, info.port, 7).unwrap();
        let mut next = snapshot.clone();
        next.channels[0].models[0].id = "new-model".into();
        db.set_setting(
            "channel_center_applied",
            &serde_json::to_string(&next).unwrap(),
        )
        .unwrap();
        let previous = client
            .get(format!("{version_base}/models"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        let latest = client
            .get(format!("{base}/models"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(previous["data"][0]["id"], "test/vendor/model");
        assert_eq!(latest["data"][0]["id"], "test/new-model");
        let previous_response = client
            .post(format!("{version_base}/chat/completions"))
            .bearer_auth(&token)
            .json(&request)
            .send()
            .await
            .unwrap();
        assert!(previous_response.status().is_success());
        for app in [
            "lolicode",
            "tavern",
            "workbuddy",
            "deepseek-harness",
            "zcode",
            "mimocode",
        ] {
            let client_base = catalog_client_base_url(&version_base, app).unwrap();
            let uri: http::Uri = format!("{client_base}/chat/completions").parse().unwrap();
            assert_eq!(client_for_uri(&uri).unwrap(), app);
            let response = client
                .post(format!("{client_base}/chat/completions"))
                .bearer_auth(&token)
                .json(&request)
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success(), "{app}: {}", response.status());
            let output: Value = response.json().await.unwrap();
            assert_eq!(output["choices"][0]["finish_reason"], "tool_calls");
        }
        assert!(catalog_client_base_url(&version_base, "unknown").is_err());
        assert_eq!(client.get(format!("{}/clients/unknown/v1/models",version_base.trim_end_matches("/v1")))
            .bearer_auth(&token).send().await.unwrap().status(), http::StatusCode::BAD_REQUEST);
        assert_eq!(
            client
                .post(format!("{base}/chat/completions"))
                .bearer_auth(&token)
                .json(&request)
                .send()
                .await
                .unwrap()
                .status(),
            http::StatusCode::BAD_REQUEST
        );
        let before_rejections = captured.lock().await.len();
        let mut missing = request;
        missing["model"] = json!("unknown/vendor/model");
        assert_eq!(
            client
                .post(format!("{base}/chat/completions"))
                .bearer_auth(&token)
                .json(&missing)
                .send()
                .await
                .unwrap()
                .status(),
            http::StatusCode::BAD_REQUEST
        );
        assert_eq!(
            client
                .get(format!("{base}/models"))
                .send()
                .await
                .unwrap()
                .status(),
            http::StatusCode::UNAUTHORIZED
        );
        let captured = captured.lock().await;
        assert_eq!(captured.len(), before_rejections);
        for (_, headers, body) in captured.iter() {
            assert_eq!(
                headers.get("authorization").unwrap(),
                "Bearer upstream-static-secret"
            );
            assert!(!headers.contains_key("cookie"));
            assert_eq!(body["model"], "vendor/model");
            assert!(body.to_string().contains("read"));
            assert!(!format!("{headers:?}").contains(&token));
        }
        drop(captured);
        proxy.stop().await.unwrap();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn versioned_gemini_discovery_accepts_local_sdk_auth_and_filters_other_protocols() {
        use super::super::{server::ProxyServer, types::ProxyConfig};
        use crate::database::Database;
        use std::sync::Arc;
        let db = Arc::new(Database::memory().unwrap());
        let token = channel_center::gateway_token(db.as_ref()).unwrap();
        let mut google = source();
        google.id = "google".into();
        google.protocol = "gemini_native".into();
        google.models[0].id = "gemini-local".into();
        let snapshot = ChannelCenterSnapshot {
            channels: vec![source(), google],
            revision: 9,
            ..Default::default()
        };
        db.set_setting(
            "channel_center_catalog_9",
            &serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                ..Default::default()
            },
            db,
            None,
        );
        let info = proxy.start().await.unwrap();
        let base = gateway_catalog_base_url(&info.address, info.port, 9)
            .unwrap()
            .trim_end_matches("/v1")
            .to_string();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client
            .get(format!("{base}/v1beta/models"))
            .query(&[("key", &token)])
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let models: Value = response.json().await.unwrap();
        assert_eq!(models["models"].as_array().unwrap().len(), 1);
        assert_eq!(models["models"][0]["name"], "models/google/gemini-local");
        let model: Value = client
            .get(format!("{base}/v1beta/models/google/gemini-local"))
            .header("x-goog-api-key", &token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(model["name"], "models/google/gemini-local");
        assert_eq!(
            client
                .get(format!("{base}/v1beta/models"))
                .query(&[("key", "wrong")])
                .send()
                .await
                .unwrap()
                .status(),
            http::StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .post(format!(
                    "{base}/v1beta/models/test/vendor/model:generateContent"
                ))
                .header("x-goog-api-key", &token)
                .json(&json!({"contents":[]}))
                .send()
                .await
                .unwrap()
                .status(),
            http::StatusCode::BAD_REQUEST
        );
        proxy.stop().await.unwrap();
    }

    #[tokio::test]
    async fn gateway_redacts_echoed_upstream_and_local_credentials_in_http_and_semantic_errors() {
        use super::super::{server::ProxyServer, types::ProxyConfig};
        use crate::database::Database;
        use std::sync::Arc;
        let db = Arc::new(Database::memory().unwrap());
        let token = channel_center::gateway_token(db.as_ref()).unwrap();
        let echo = token.clone();
        let upstream=axum::Router::new().route("/v1/chat/completions",axum::routing::post(
            move |Json(body):Json<Value>| {
                let echo=echo.clone();
                async move {
                    let status=if body["messages"][0]["content"]=="semantic" {http::StatusCode::OK} else {http::StatusCode::UNAUTHORIZED};
                    (status,Json(json!({"error":{"message":format!("echo upstream-static-secret {echo}"),"type":"authentication_error"}}))).into_response()
                }
            }
        ));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let upstream_task = tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let mut source = source();
        source.base_url = format!("http://{address}/v1");
        source.api_key = "upstream-static-secret".into();
        let snapshot = ChannelCenterSnapshot {
            channels: vec![source],
            ..Default::default()
        };
        db.set_setting(
            "channel_center_applied",
            &serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                ..Default::default()
            },
            db,
            None,
        );
        let info = proxy.start().await.unwrap();
        let base = gateway_base_url(&info.address, info.port).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for (prompt, status) in [
            ("http", http::StatusCode::UNAUTHORIZED),
            ("semantic", http::StatusCode::UNPROCESSABLE_ENTITY),
        ] {
            let response=client.post(format!("{base}/chat/completions")).bearer_auth(&token)
                .json(&json!({"model":"test/vendor/model","messages":[{"role":"user","content":prompt}]}))
                .send().await.unwrap();
            assert_eq!(response.status(), status);
            let body = response.text().await.unwrap();
            assert!(!body.contains("upstream-static-secret"), "{body}");
            assert!(!body.contains(&token), "{body}");
            assert!(body.contains("[REDACTED]"), "{body}");
        }
        proxy.stop().await.unwrap();
        upstream_task.abort();
    }

    #[test]
    fn chat_usage_projection_preserves_cache_counts_and_does_not_invent_missing_usage() {
        let reported=reported_chat_usage(&json!({"input_tokens":20,"output_tokens":10,"cache_read_input_tokens":60,"cache_creation_input_tokens":20}));
        assert_eq!(reported["prompt_tokens"],100);
        assert_eq!(reported["completion_tokens"],10);
        assert_eq!(reported["prompt_tokens_details"]["cached_tokens"],60);
        assert_eq!(reported["cache_creation_input_tokens"],20);
        assert_eq!(reported_chat_usage(&json!({})),json!({}));
        let ordinary=reported_chat_usage(&json!({"input_tokens":3,"output_tokens":4}));
        assert!(ordinary.get("prompt_tokens_details").is_none());
        assert!(ordinary.get("cache_creation_input_tokens").is_none());
    }
}
