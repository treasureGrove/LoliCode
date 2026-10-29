//! Public relay metadata; forum and upstream credentials never cross IPC.
use super::{channel_center, lolicode_account::LolicodeAccountState};
use crate::{error::AppError, store::AppState};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const BASE_URL: &str = "https://lolicode.com/relay/v1";
pub const CHANNEL_ID: &str = "lolicode-public";
pub(crate) const DEFAULT_REQUEST_BYTES: u64 = 128 * 1024;

fn relay_request_byte_limit(value: &Value) -> Option<u64> {
    value
        .pointer("/limits/maxRequestBytes")
        .and_then(Value::as_u64)
        .filter(|limit| *limit > 0 && *limit <= channel_center::MAX_MODEL_REQUEST_BYTES)
}

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

fn public_status(mut value: Value, id: &str) -> Result<Value, String> {
    let request_limit = relay_request_byte_limit(&value);
    if let Some(models) = value.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            // Older clients still receive a conservative legacy contextLimit.
            // Canonicalize the real upstream window before the typed allowlist.
            if let Some(limit) = model
                .get("upstreamContextLimit")
                .and_then(Value::as_u64)
                .filter(|limit| *limit > 0 && *limit <= 9_007_199_254_740_991)
            {
                model["contextLimit"] = json!(limit);
            }
            if model.get("maxRequestBytes").is_some_and(|value| {
                value.as_u64().is_none_or(|limit| {
                    limit == 0 || limit > channel_center::MAX_MODEL_REQUEST_BYTES
                })
            }) {
                if let Some(model) = model.as_object_mut() {
                    model.remove("maxRequestBytes");
                }
            }
        }
    }
    let public: RelayStatus =
        serde_json::from_value(value).map_err(|_| "公益模型账户资料无效。")?;
    if public.account.id != id || public.models.len() > 128 {
        return Err("公益模型账户资料无效。".into());
    }
    let mut value = serde_json::to_value(public).map_err(|_| "公益模型账户资料无效。")?;
    // Retain only the public integer needed for context planning, never the
    // entire upstream limits object or any additional server-side fields.
    if let Some(limit) = request_limit {
        value["limits"] = json!({"maxRequestBytes": limit});
    }
    Ok(value)
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
    use crate::database::Database;

    fn sponsored_source() -> channel_center::ChannelSource {
        serde_json::from_value(json!({
            "id": CHANNEL_ID,
            "name": "LoliCode 公益模型",
            "baseUrl": BASE_URL,
            "authKind": "lolicode_account",
            "accountId": "42",
            "protocol": "openai_chat",
            "models": [{"id": "flash", "supportsTools": true}],
            "enabled": true
        }))
        .unwrap()
    }

    fn paid_source() -> channel_center::ChannelSource {
        let mut source = sponsored_source();
        source.id = "private".into();
        source.name = "Private channel".into();
        source.base_url = "https://example.test/v1".into();
        source.auth_kind = "api_key".into();
        source.account_id = None;
        source.api_key = "test-fixture-key".into();
        source
    }

    #[test]
    fn public_allowance_drops_undeclared_secrets_and_binds_account_id() {
        let value = json!({"account":{"id":"42","username":"member","displayName":"Member",
            "email":"private@example.invalid","token":"private-secret"},
            "quota":{"day":"2026-10-21","timezone":"Asia/Singapore","resetsAt":"2026-10-22T00:00:00+08:00",
                "requestLimit":20,"tokenLimit":100000,"requestsUsed":0,"tokensUsed":0,"tokensReserved":0,
                "requestsRemaining":20,"tokensRemaining":100000},
            "models":[{"id":"model","apiKey":"private-secret", "contextLimit":61440,
                "upstreamContextLimit":1000000,"contextLimits":[128000,1000000],"maxRequestBytes":131072}],
            "ready":true,"gateway_key":"private-secret",
            "limits":{"maxRequestBytes":131072,"apiKey":"private-secret","token":"private-secret"}});
        let public = public_status(value.clone(), "42").unwrap();
        let encoded = public.to_string();
        assert!(
            !encoded.contains("private-secret") && !encoded.contains("private@example.invalid")
        );
        assert_eq!(public["limits"], json!({"maxRequestBytes": 131072}));
        assert_eq!(public["models"][0]["contextLimit"], 1000000);
        assert_eq!(
            public["models"][0]["contextLimits"],
            json!([128000, 1000000])
        );
        assert_eq!(public["models"][0]["maxRequestBytes"], 131072);
        assert!(public["models"][0].get("upstreamContextLimit").is_none());
        for invalid in [
            json!(null),
            json!(true),
            json!("131072"),
            json!(-1),
            json!(0),
            json!(1.5),
            json!(channel_center::MAX_MODEL_REQUEST_BYTES + 1),
        ] {
            let mut invalid_status = value.clone();
            invalid_status["limits"]["maxRequestBytes"] = invalid;
            let public = public_status(invalid_status, "42").unwrap();
            assert!(public.get("limits").is_none());
        }
        for invalid in [
            json!(null),
            json!(true),
            json!("1000000"),
            json!(0),
            json!(-1),
            json!(1.5),
            json!(u64::MAX),
        ] {
            let mut invalid_status = value.clone();
            invalid_status["models"][0]["upstreamContextLimit"] = invalid.clone();
            invalid_status["models"][0]["maxRequestBytes"] = invalid;
            let public = public_status(invalid_status, "42").unwrap();
            assert_eq!(public["models"][0]["contextLimit"], 61440);
            assert!(public["models"][0].get("maxRequestBytes").is_none());
            assert_eq!(
                relay_models(&public).unwrap()[0].max_request_bytes,
                Some(131072)
            );
        }
        assert!(public_status(value, "7").is_err());
    }

    #[test]
    fn relay_discovery_keeps_model_context_and_transport_limits_independent() {
        let value = json!({"limits":{"maxRequestBytes":131072},"models":[
            {"id":"large","contextLimit":1000000,"contextLimits":[128000,1000000]},
            {"id":"small","contextLimit":32768,"maxRequestBytes":16384},
            {"id":"missing"}]});
        let models = relay_models(&value).unwrap();
        assert_eq!(models[0].context_limit, Some(1000000));
        assert_eq!(models[0].context_limits, Some(vec![128000, 1000000]));
        assert_eq!(models[0].max_request_bytes, Some(131072));
        assert_eq!(models[1].context_limit, Some(32768));
        assert_eq!(models[1].max_request_bytes, Some(16384));
        assert_eq!(models[2].context_limit, Some(1000000));
        assert_eq!(models[2].context_limits, None);
    }

    #[test]
    fn missing_or_invalid_request_limits_keep_the_public_transport_fallback() {
        for limit in [
            json!(null),
            json!(0),
            json!(true),
            json!("131072"),
            json!(-1),
            json!(u64::MAX),
        ] {
            let value = json!({"limits":{"maxRequestBytes":limit},"models":[{"id":"large","contextLimit":1000000}]});
            let model = relay_models(&value).unwrap().remove(0);
            assert_eq!(model.context_limit, Some(1000000));
            assert_eq!(model.max_request_bytes, Some(DEFAULT_REQUEST_BYTES));
        }
    }

    #[test]
    fn small_request_limits_and_nondefault_context_windows_are_preserved() {
        for limit in [1, 4096, 8192, 8193] {
            let value = json!({"limits":{"maxRequestBytes":limit},"models":[
                {"id":"large","contextLimit":128000,"contextLimits":[128000,1000000],"maxRequestBytes":131072}]});
            let model = relay_models(&value).unwrap().remove(0);
            assert_eq!(model.context_limit, Some(128000));
            assert_eq!(model.context_limits, Some(vec![128000, 1000000]));
            assert_eq!(model.max_request_bytes, Some(limit));
        }
    }

    #[test]
    fn sponsored_refresh_preserves_only_still_declared_context_choices() {
        let db = Database::memory().unwrap();
        let mut saved = sponsored_source();
        saved.models[0].context_limit = Some(128000);
        saved.models[0].context_limits = Some(vec![128000, 1000000]);
        let mut discovered = saved.clone();
        saved.models[0].selected_context_limit = Some(1000000);
        channel_center::save(
            &db,
            channel_center::ChannelCenterSnapshot {
                channels: vec![saved],
                ..Default::default()
            },
        )
        .unwrap();
        sync_discovered_channel(&db, discovered.clone()).unwrap();
        assert_eq!(
            channel_center::load(&db).unwrap().channels[0].models[0].selected_context_limit,
            Some(1000000)
        );
        discovered.models[0].context_limits = Some(vec![128000]);
        sync_discovered_channel(&db, discovered).unwrap();
        assert_eq!(
            channel_center::load(&db).unwrap().channels[0].models[0].selected_context_limit,
            None
        );
    }

    #[test]
    fn identical_channel_repairs_missing_default_without_repeated_saves() {
        let db = Database::memory().unwrap();
        let source = sponsored_source();
        channel_center::save(
            &db,
            channel_center::ChannelCenterSnapshot {
                channels: vec![source.clone()],
                ..Default::default()
            },
        )
        .unwrap();
        let initial = channel_center::load(&db).unwrap();
        sync_discovered_channel(&db, source.clone()).unwrap();
        let repaired = channel_center::load(&db).unwrap();
        assert_eq!(
            repaired.default_model.as_deref(),
            Some("lolicode-public/flash")
        );
        assert_eq!(repaired.revision, initial.revision + 1);

        sync_discovered_channel(&db, source).unwrap();
        assert_eq!(channel_center::load(&db).unwrap(), repaired);
    }

    #[test]
    fn identical_channel_repairs_unavailable_sponsored_default_and_keeps_disabling() {
        for unavailable in ["removed", "model-disabled", "channel-disabled"] {
            let db = Database::memory().unwrap();
            let discovered = sponsored_source();
            let mut saved = discovered.clone();
            if unavailable == "model-disabled" {
                saved.models[0].enabled = Some(false);
            }
            if unavailable == "channel-disabled" {
                saved.enabled = false;
            }
            let mut snapshot = channel_center::ChannelCenterSnapshot {
                channels: vec![saved.clone(), paid_source()],
                ..Default::default()
            };
            channel_center::save(&db, snapshot.clone()).unwrap();
            snapshot = channel_center::load(&db).unwrap();
            snapshot.default_model = Some(format!(
                "{CHANNEL_ID}/{}",
                if unavailable == "removed" {
                    "removed"
                } else {
                    "flash"
                }
            ));
            // Model removal or an old client can leave a stale stored binding.
            db.set_setting("channel_center", &serde_json::to_string(&snapshot).unwrap())
                .unwrap();

            sync_discovered_channel(&db, discovered).unwrap();
            let repaired = channel_center::load(&db).unwrap();
            assert_eq!(repaired.channels[0], saved, "{unavailable}");
            assert_eq!(
                repaired.default_model.as_deref(),
                Some(if unavailable == "removed" {
                    "lolicode-public/flash"
                } else {
                    "private/flash"
                }),
                "{unavailable}"
            );
            assert_eq!(repaired.revision, snapshot.revision + 1);
        }
    }

    #[test]
    fn catalog_refresh_preserves_manual_default_and_disabled_models() {
        let db = Database::memory().unwrap();
        let mut saved = sponsored_source();
        saved.models[0].enabled = Some(false);
        channel_center::save(
            &db,
            channel_center::ChannelCenterSnapshot {
                channels: vec![saved, paid_source()],
                default_model: Some("private/flash".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let initial = channel_center::load(&db).unwrap();
        let mut discovered = sponsored_source();
        discovered.models.push(
            serde_json::from_value(json!({"id": "new-model", "supportsTools": true})).unwrap(),
        );

        sync_discovered_channel(&db, discovered).unwrap();
        let refreshed = channel_center::load(&db).unwrap();
        assert_eq!(refreshed.default_model, initial.default_model);
        assert_eq!(refreshed.channels[0].models[0].enabled, Some(false));
        assert!(refreshed.channels[0].models[1].available());
    }
}

pub async fn discover(
    account: &LolicodeAccountState,
) -> Result<channel_center::ChannelSource, String> {
    let value = status(account).await?;
    let id = value["account"]["id"].as_str().ok_or("账户资料无效。")?;
    account.relay_credential(Some(id)).await?;
    let models = relay_models(&value)?;
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

fn relay_models(value: &Value) -> Result<Vec<channel_center::ChannelModel>, String> {
    let request_limit = relay_request_byte_limit(value).unwrap_or(DEFAULT_REQUEST_BYTES);
    value["models"]
        .as_array()
        .ok_or("公益模型列表无效。")?
        .iter()
        .map(|model| {
            let mut model: channel_center::ChannelModel = serde_json::from_value(model.clone())
                .map_err(|_| "公益模型列表无效。".to_owned())?;
            model.name = Some(model.name.unwrap_or_else(|| model.id.clone()));
            model.context_limit = model
                .context_limit
                .or_else(|| {
                    model
                        .context_limits
                        .as_ref()
                        .and_then(|windows| windows.first().copied())
                })
                .or(Some(channel_center::DEFAULT_CONTEXT_LIMIT));
            model.max_request_bytes = Some(
                model
                    .max_request_bytes
                    .filter(|limit| *limit > 0 && *limit <= channel_center::MAX_MODEL_REQUEST_BYTES)
                    .unwrap_or(request_limit)
                    .min(request_limit),
            );
            model.output_limit = model.output_limit.or(Some(4096));
            model.supports_tools = Some(true);
            model.input_modalities = Some(vec!["text".into()]);
            model.protocol = Some("openai_chat".into());
            Ok(model)
        })
        .collect()
}

pub async fn sync_channel(state: &AppState, account: &LolicodeAccountState) -> Result<(), String> {
    sync_discovered_channel(state.db.as_ref(), discover(account).await?)
}

fn sync_discovered_channel(
    db: &crate::database::Database,
    mut source: channel_center::ChannelSource,
) -> Result<(), String> {
    let mut snapshot = channel_center::load(db).map_err(|e| e.to_string())?;
    let previous = snapshot.clone();
    if let Some(existing) = snapshot.channels.iter_mut().find(|s| s.id == CHANNEL_ID) {
        if existing.auth_kind != "lolicode_account" {
            return Err("公益渠道标识被其他配置占用，请在渠道中心检查。".into());
        }
        for model in &mut source.models {
            if let Some(previous) = existing.models.iter().find(|m| m.id == model.id) {
                model.enabled = previous.enabled;
                model.selected_context_limit = previous.selected_context_limit.filter(|selected| {
                    model
                        .context_limits
                        .as_ref()
                        .is_some_and(|windows| windows.contains(selected))
                });
            }
        }
        source.enabled = existing.enabled;
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
    if snapshot == previous {
        return Ok(());
    }
    channel_center::save(db, snapshot).map_err(|error: AppError| error.to_string())
}
