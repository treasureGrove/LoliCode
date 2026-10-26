//! Public relay metadata; forum and upstream credentials never cross IPC.
use super::{channel_center, lolicode_account::LolicodeAccountState};
use crate::{error::AppError, store::AppState};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const BASE_URL: &str = "https://lolicode.com/relay/v1";
pub const CHANNEL_ID: &str = "lolicode-public";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayAccount {
    id: String,
    username: String,
    display_name: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayQuota {
    day: String,
    timezone: String,
    resets_at: String,
    request_limit: u64,
    token_limit: u64,
    requests_used: u64,
    tokens_used: u64,
    tokens_reserved: u64,
    requests_remaining: u64,
    tokens_remaining: u64,
}

#[derive(Deserialize, Serialize)]
struct RelayStatus {
    account: RelayAccount,
    quota: RelayQuota,
    models: Vec<channel_center::ChannelModel>,
    ready: bool,
}

fn public_status(value: Value, id: &str) -> Result<Value, String> {
    let public: RelayStatus =
        serde_json::from_value(value).map_err(|_| "公益模型账户资料无效。")?;
    if public.account.id != id || public.models.len() > 128 {
        return Err("公益模型账户资料无效。".into());
    }
    serde_json::to_value(public).map_err(|_| "公益模型账户资料无效。".into())
}

pub async fn status(account: &LolicodeAccountState) -> Result<Value, String> {
    let (id, bearer) = account.relay_credential(None).await?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| "无法初始化公益模型连接。")?;
    let response = client
        .get("https://lolicode.com/relay/account")
        .bearer_auth(bearer)
        .send()
        .await
        .map_err(|_| "暂时无法连接公益模型服务，请稍后重试。")?;
    let code = response.status();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "公益模型响应读取失败。")?;
        if chunk.len() > 262_144usize.saturating_sub(bytes.len()) {
            return Err("公益模型响应超过限制。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "公益模型返回了无效资料。")?;
    if !code.is_success() {
        let message = match value.pointer("/error/code").and_then(Value::as_str) {
            Some("forum_suspended") => "此 LoliCode 账号已被封禁，暂时无法使用公益模型。",
            Some("email_unconfirmed") => "请先在 LoliCode 社区完成邮箱验证。",
            Some("login_expired" | "login_required") => "LoliCode 登录已失效，请重新登录。",
            Some("account_disabled") => "此账号的公益模型权限已停用。",
            _ => "公益模型服务暂时不可用，请稍后重试。",
        };
        return Err(message.into());
    }
    public_status(value, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_allowance_drops_undeclared_secrets_and_binds_account_id() {
        let value = json!({"account":{"id":"42","username":"member","displayName":"Member",
            "email":"private@example.invalid","token":"private-secret"},
            "quota":{"day":"2026-10-21","timezone":"Asia/Singapore","resetsAt":"2026-10-22T00:00:00+08:00",
                "requestLimit":20,"tokenLimit":100000,"requestsUsed":0,"tokensUsed":0,"tokensReserved":0,
                "requestsRemaining":20,"tokensRemaining":100000},
            "models":[{"id":"model","apiKey":"private-secret"}],"ready":true,"gateway_key":"private-secret"});
        let public = public_status(value.clone(), "42").unwrap();
        let encoded = public.to_string();
        assert!(
            !encoded.contains("private-secret") && !encoded.contains("private@example.invalid")
        );
        assert!(public_status(value, "7").is_err());
    }
}

pub async fn discover(
    account: &LolicodeAccountState,
) -> Result<channel_center::ChannelSource, String> {
    let value = status(account).await?;
    let id = value["account"]["id"].as_str().ok_or("账户资料无效。")?;
    account.relay_credential(Some(id)).await?;
    let models = value["models"]
        .as_array()
        .ok_or("公益模型列表无效。")?
        .iter()
        .map(|model| {
            serde_json::from_value(json!({
                "id":model["id"],"name":model.get("name").unwrap_or(&model["id"]),
                "contextLimit":model.get("contextLimit").unwrap_or(&json!(32768)),
                "outputLimit":model.get("outputLimit").unwrap_or(&json!(4096)),
                "supportsTools":true,"inputModalities":["text"],"protocol":"openai_chat"
            }))
            .map_err(|_| "公益模型列表无效。".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(channel_center::ChannelSource {
        id: CHANNEL_ID.into(),
        name: "LoliCode 公益模型".into(),
        base_url: BASE_URL.into(),
        api_key: String::new(),
        auth_kind: "lolicode_account".into(),
        account_id: Some(id.into()),
        protocol: "openai_chat".into(),
        models,
        enabled: true,
    })
}

pub async fn sync_channel(state: &AppState, account: &LolicodeAccountState) -> Result<(), String> {
    let mut source = discover(account).await?;
    let mut snapshot = channel_center::load(state.db.as_ref()).map_err(|e| e.to_string())?;
    if let Some(existing) = snapshot.channels.iter_mut().find(|s| s.id == CHANNEL_ID) {
        if existing.auth_kind != "lolicode_account" {
            return Err("公益渠道标识被其他配置占用，请在渠道中心检查。".into());
        }
        for model in &mut source.models {
            if let Some(previous) = existing.models.iter().find(|m| m.id == model.id) {
                model.enabled = previous.enabled;
            }
        }
        source.enabled = existing.enabled;
        if *existing == source {
            return Ok(());
        }
        *existing = source;
    } else {
        snapshot.channels.push(source);
    }
    if snapshot.default_model.as_ref().is_some_and(|selected| {
        selected.starts_with(&format!("{CHANNEL_ID}/"))
            && !snapshot.channels.iter().any(|s| {
                s.enabled
                    && s.models
                        .iter()
                        .any(|m| m.available() && channel_center::route_id(s, m) == *selected)
            })
    }) {
        snapshot.default_model = None;
    }
    if snapshot.default_model.is_none() {
        snapshot.default_model = snapshot
            .channels
            .iter()
            .filter(|s| s.enabled)
            .flat_map(|s| {
                s.models
                    .iter()
                    .filter(|m| m.available())
                    .map(move |m| channel_center::route_id(s, m))
            })
            .next();
    }
    channel_center::save(state.db.as_ref(), snapshot).map_err(|error: AppError| error.to_string())
}
