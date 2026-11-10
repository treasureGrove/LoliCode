//! A short-lived, single-route lease for the Harness child. The existing channel
//! gateway keeps the upstream credentials and performs protocol translation.
use super::{agent_host, channel_center};
use crate::store::AppState;
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{net::TcpListener, task::JoinHandle, time::Instant};

pub(super) const PROVIDER: &str = "lolicode-gateway";
pub(super) const TOKEN_ENV: &str = "DSH_LOLICODE_GATEWAY_TOKEN";
const LEASE_DURATION: Duration = Duration::from_secs(60 * 60);

pub(super) struct HarnessGateway {
    pub model: String,
    pub profile_patch: Value,
    pub token: String,
    /// Stable private route identity; never includes the disposable listener.
    pub reuse_fingerprint: String,
    active: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl Drop for HarnessGateway {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        self.task.abort();
    }
}

struct Lease {
    token: String,
    active: Arc<AtomicBool>,
    expires_at: Instant,
    model: String,
    route: String,
    upstream: reqwest::Url,
    gateway_bearer: String,
    client: reqwest::Client,
}

impl HarnessGateway {
    pub(super) async fn open(
        state: &AppState,
        selected_model: &str,
        session_id: &str,
        accounts: &[(String, String)],
    ) -> Result<Self, String> {
        let session_uuid = session_id
            .strip_prefix("lc:")
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
            .filter(|uuid| session_id == format!("lc:{uuid}"))
            .ok_or("无效的 LoliCode 会话编号")?;
        let binding = agent_host::prepare_native_binding(state, accounts).await?;
        let selected = binding
            .catalog
            .models
            .iter()
            .find(|model| model.id == selected_model)
            .ok_or("选中的渠道模型已不可用")?;
        let catalog = channel_center::load_catalog(state.db.as_ref(), binding.catalog.revision)
            .map_err(|error| error.to_string())?;
        let model = catalog
            .channels
            .iter()
            .filter(|channel| channel.enabled)
            .find_map(|channel| {
                channel.models.iter().find(|model| {
                    model.available()
                        && channel_center::route_id(channel, model) == selected.model_id
                })
            })
            .ok_or("渠道版本缺少选中的模型")?;
        let upstream = reqwest::Url::parse(&format!("{}/chat/completions", binding.base_url))
            .map_err(|_| "本机渠道网关地址无效")?;
        if upstream.scheme() != "http" || upstream.host_str() != Some("127.0.0.1") {
            return Err("Harness 只接受本机渠道网关".into());
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "无法创建 Harness 渠道连接")?;
        let base_url = format!(
            "http://{}/v1",
            listener
                .local_addr()
                .map_err(|_| "无法读取 Harness 渠道地址")?
        );
        let token = uuid::Uuid::new_v4().simple().to_string();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .default_headers(HeaderMap::from_iter([(
                header::HeaderName::from_static("x-lolicode-session-id"),
                header::HeaderValue::from_str(&format!("lc:{session_uuid}"))
                    .map_err(|_| "无效的 LoliCode 会话编号")?,
            )]))
            .build()
            .map_err(|_| "无法创建 Harness 渠道客户端")?;
        let profile_patch = profile_patch(&base_url, &model.id, selected, model);
        let reuse_fingerprint = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!({
                    "revision": binding.catalog.revision,
                    "route": selected.model_id,
                    "model": selected_model,
                    "upstream": upstream.as_str(),
                    "bearer": binding.bearer_token,
                    "accounts": accounts,
                }))
                .map_err(|_| "无法校验 Harness 渠道配置")?
            )
        );
        let active = Arc::new(AtomicBool::new(true));
        let lease = Arc::new(Lease {
            token: token.clone(),
            active: active.clone(),
            expires_at: Instant::now() + LEASE_DURATION,
            model: model.id.clone(),
            route: selected.model_id.clone(),
            upstream,
            gateway_bearer: binding.bearer_token,
            client,
        });
        let task = tokio::spawn(async move {
            let router = Router::new()
                .route("/v1/chat/completions", post(complete))
                .layer(DefaultBodyLimit::max(
                    channel_center::MAX_MODEL_REQUEST_BYTES as usize,
                ))
                .with_state(lease);
            let _ = axum::serve(listener, router).await;
        });
        Ok(Self {
            model: model.id.clone(),
            profile_patch,
            token,
            reuse_fingerprint,
            active,
            task,
        })
    }
}

fn profile_patch(
    base_url: &str,
    model_id: &str,
    selected: &channel_center::AgentCatalogModel,
    raw: &channel_center::ChannelModel,
) -> Value {
    // The desktop forwards attachments to the selected channel, whose
    // endpoint decides whether it can process the image.
    let mut model = json!({"id": model_id, "name": selected.name, "input": ["text", "image"]});
    if let Some(limit) = raw.reported_context_limit() {
        model["contextWindow"] = json!(limit);
    }
    if let Some(limit) = raw.output_limit {
        model["maxTokens"] = json!(limit);
    }
    json!([{
        "id": "llm-pi-ai",
        "config": {"providers": {(PROVIDER): {
            "apiKeyEnv": TOKEN_ENV,
            "api": "openai-completions",
            "baseURL": base_url,
            "compat": {"supportsDeveloperRole": false, "maxTokensField": "max_tokens"},
            "models": [model]
        }}}
    }])
}

async fn complete(
    State(lease): State<Arc<Lease>>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Response {
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|supplied| {
            crate::proxy::channel_gateway::constant_time_equal(
                supplied.as_bytes(),
                lease.token.as_bytes(),
            )
        });
    if !authorized || !lease.active.load(Ordering::Acquire) || Instant::now() >= lease.expires_at {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if body.get("model").and_then(Value::as_str) != Some(lease.model.as_str()) {
        return (StatusCode::BAD_REQUEST, "model outside Harness lease").into_response();
    }
    body["model"] = json!(lease.route);
    let result = lease
        .client
        .post(lease.upstream.clone())
        .bearer_auth(&lease.gateway_bearer)
        .json(&body)
        .send()
        .await;
    let Ok(result) = result else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let status = result.status();
    let content_type = result.headers().get(header::CONTENT_TYPE).cloned();
    let mut response = Response::new(Body::from_stream(result.bytes_stream()));
    *response.status_mut() = status;
    if let Some(content_type) = content_type {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    response
}
