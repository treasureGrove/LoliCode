//! User-facing Gateway lifecycle and Claude Code configuration. All inference
//! goes through the shared authenticated proxy and its existing adapters.
use super::channel_center;
use crate::{app_config::AppType, error::AppError, store::AppState};
use serde::Serialize;
use serde_json::Value;

const REVISION_KEY: &str = "channel_center_gateway_revision";

pub(super) fn record_revision(state: &AppState, revision: u64) -> Result<(), AppError> {
    state.db.set_setting(REVISION_KEY, &revision.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub running: bool,
    pub base_url: Option<String>,
    pub revision: Option<u64>,
    pub saved_revision: u64,
    pub model_count: usize,
    pub default_model: Option<String>,
    pub total_requests: u64,
    pub active_connections: usize,
}

fn revision(state: &AppState) -> Result<Option<u64>, AppError> {
    state
        .db
        .get_setting(REVISION_KEY)?
        .map(|raw| {
            raw.parse()
                .map_err(|_| AppError::Config("Gateway 目录版本无效，请重新启动 Gateway".into()))
        })
        .transpose()
}

pub async fn status(state: &AppState) -> Result<GatewayStatus, AppError> {
    let proxy = state
        .proxy_service
        .get_status()
        .await
        .map_err(AppError::Message)?;
    let revision = revision(state)?;
    let catalog = revision
        .map(|revision| channel_center::load_catalog(state.db.as_ref(), revision))
        .transpose()?;
    let source = catalog
        .as_ref()
        .map(|snapshot| channel_center::claude_gateway_source(snapshot, "", ""));
    let default_model = source.as_ref().and_then(|source| {
        catalog
            .as_ref()
            .and_then(|snapshot| snapshot.default_model.as_ref())
            .filter(|selected| source.models.iter().any(|model| &model.id == *selected))
            .cloned()
            .or_else(|| source.models.first().map(|model| model.id.clone()))
    });
    let base_url = if proxy.running {
        revision
            .map(|revision| {
                let base = crate::proxy::channel_gateway::gateway_catalog_base_url(
                    &proxy.address,
                    proxy.port,
                    revision,
                )?;
                crate::proxy::channel_gateway::catalog_client_base_url(&base, "claude")
                    .map(|base| base.trim_end_matches("/v1").to_string())
            })
            .transpose()?
    } else {
        None
    };
    Ok(GatewayStatus {
        running: proxy.running,
        base_url,
        revision,
        saved_revision: channel_center::agent_source_snapshot(state.db.as_ref())?.revision,
        model_count: source.map(|source| source.models.len()).unwrap_or(0),
        default_model,
        total_requests: proxy.total_requests,
        active_connections: proxy.active_connections,
    })
}

pub async fn start(
    state: &AppState,
    expected_revision: Option<u64>,
) -> Result<GatewayStatus, AppError> {
    channel_center::prepare_external_gateway_binding(state, expected_revision).await?;
    status(state).await
}

pub async fn claude_config(state: &AppState) -> Result<Value, AppError> {
    let status = status(state).await?;
    let base = status
        .base_url
        .ok_or_else(|| AppError::InvalidInput("请先启动 Gateway".into()))?;
    let revision = status
        .revision
        .ok_or_else(|| AppError::InvalidInput("请先启动 Gateway".into()))?;
    let snapshot = channel_center::load_catalog(state.db.as_ref(), revision)?;
    let token = channel_center::gateway_token(state.db.as_ref())?;
    let source = channel_center::claude_gateway_source(&snapshot, &format!("{base}/v1"), &token);
    let default = status
        .default_model
        .ok_or_else(|| AppError::InvalidInput("Gateway 没有默认模型".into()))?;
    Ok(channel_center::gateway_provider(&AppType::Claude, &source, &default)?.settings_config)
}

/// An authenticated local catalog request verifies the real listener, token and
/// pinned routes without consuming any upstream model quota.
pub async fn check(state: &AppState) -> Result<GatewayStatus, AppError> {
    let config = claude_config(state).await?;
    let base = config["env"]["ANTHROPIC_BASE_URL"]
        .as_str()
        .unwrap_or_default();
    let token = config["env"]["ANTHROPIC_AUTH_TOKEN"]
        .as_str()
        .unwrap_or_default();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|_| AppError::Message("无法创建 Gateway 连接检查".into()))?;
    let response = client
        .get(format!("{base}/v1/models"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| AppError::Message("无法连接本机 Gateway，请启动服务后重试".into()))?;
    if !response.status().is_success() {
        return Err(AppError::Message(format!(
            "Gateway 连接检查失败（HTTP {}），请重新启动服务",
            response.status().as_u16()
        )));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| AppError::Message("Gateway 模型目录响应无效".into()))?;
    if !body["data"]
        .as_array()
        .is_some_and(|models| !models.is_empty())
    {
        return Err(AppError::Message(
            "Gateway 没有可用模型，请更新渠道后重新启动".into(),
        ));
    }
    status(state).await
}
