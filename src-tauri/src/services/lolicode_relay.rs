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
    #[serde(default)]
    request_limit: Option<u64>,
    token_limit: u64,
    requests_used: u64,
    tokens_used: u64,
    tokens_reserved: u64,
    #[serde(default)]
    requests_remaining: Option<u64>,
    #[serde(default)]
    requests_unlimited: bool,
    tokens_remaining: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credit_unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credit_limit: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credits_used: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credits_reserved: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credits_remaining: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credit_balance: Option<RelayCreditBalance>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayCreditBalance {
    unit: String,
    limit: f64,
    used: f64,
    reserved: f64,
    remaining: f64,
    pricing_revision: u64,
    ledger_revision: u64,
}

impl RelayCreditBalance {
    fn valid(&self) -> bool {
        self.unit == "Credit"
            && [self.limit, self.used, self.reserved, self.remaining]
                .into_iter()
                .all(|value| value.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&value))
            && self.pricing_revision <= 9_007_199_254_740_991
            && self.ledger_revision <= 9_007_199_254_740_991
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayCreditRate {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
}

impl RelayCreditRate {
    fn valid(&self) -> bool {
        [self.input, self.output, self.cache_read, self.cache_write]
            .into_iter()
            .all(|value| value.is_finite() && (0.0..=10_000.0).contains(&value))
    }

    fn valid_price(&self) -> bool {
        [self.input, self.output, self.cache_read, self.cache_write]
            .into_iter()
            .all(|value| value.is_finite() && (0.0..=1_000_000_000_000.0).contains(&value))
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum RelayCreditPricing {
    Tokens {
        unit: String,
        #[serde(rename = "perTokens")]
        per_tokens: u64,
        prices: RelayCreditRate,
    },
    Request {
        unit: String,
        #[serde(rename = "creditsPerRequest")]
        credits_per_request: f64,
    },
}

impl RelayCreditPricing {
    fn valid(&self) -> bool {
        match self {
            Self::Tokens {
                unit,
                per_tokens,
                prices,
            } => unit == "Credit" && *per_tokens == 1_000_000 && prices.valid_price(),
            Self::Request {
                unit,
                credits_per_request,
            } => {
                unit == "Credit"
                    && credits_per_request.is_finite()
                    && (0.0..=1_000_000_000_000.0).contains(credits_per_request)
            }
        }
    }
}

#[derive(Deserialize, Serialize)]
struct RelayStatus {
    account: RelayAccount,
    quota: RelayQuota,
    models: Vec<channel_center::ChannelModel>,
    ready: bool,
}

fn public_status(mut value: Value, id: &str) -> Result<Value, String> {
    if let Some(raw) = value.pointer("/quota/creditBalance") {
        let balance: RelayCreditBalance =
            serde_json::from_value(raw.clone()).map_err(|_| "公益模型 Credit 资料无效。")?;
        if !balance.valid() {
            return Err("公益模型 Credit 资料无效。".into());
        }
        // The canonical snapshot is authoritative. Legacy fields are a projection,
        // never an independently recalculated balance or a token conversion.
        value["quota"]["creditUnit"] = json!("Credit");
        value["quota"]["creditLimit"] = json!(balance.limit);
        value["quota"]["creditsUsed"] = json!(balance.used);
        value["quota"]["creditsReserved"] = json!(balance.reserved);
        value["quota"]["creditsRemaining"] = json!(balance.remaining);
    }
    let request_limit = relay_request_byte_limit(&value);
    let has_credit_fields = [
        "creditUnit",
        "creditLimit",
        "creditsUsed",
        "creditsReserved",
        "creditsRemaining",
    ]
    .iter()
    .any(|key| {
        value
            .get("quota")
            .is_some_and(|quota| quota.get(key).is_some())
    });
    let global_credits = value
        .pointer("/limits/globalDailyCredits")
        .and_then(|value| {
            if value.is_null() {
                Some(Value::Null)
            } else {
                value
                    .as_f64()
                    .filter(|number| number.is_finite() && (0.0..=100_000_000.0).contains(number))
                    .map(|_| value.clone())
            }
        });
    let credit_rates = value
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .map(|model| {
                    model
                        .get("creditRate")
                        .cloned()
                        .and_then(|rate| serde_json::from_value::<RelayCreditRate>(rate).ok())
                        .filter(RelayCreditRate::valid)
                        .and_then(|rate| serde_json::to_value(rate).ok())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let credit_pricing = value
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .map(|model| {
                    model
                        .get("creditPricing")
                        .cloned()
                        .and_then(|pricing| {
                            serde_json::from_value::<RelayCreditPricing>(pricing).ok()
                        })
                        .filter(RelayCreditPricing::valid)
                        .and_then(|pricing| serde_json::to_value(pricing).ok())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
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
    let credits = [
        public.quota.credit_limit,
        public.quota.credits_used,
        public.quota.credits_reserved,
        public.quota.credits_remaining,
    ];
    if has_credit_fields
        && (public.quota.credit_unit.as_deref() != Some("Credit")
            || credits.iter().any(|value| {
                value.is_none_or(|number| {
                    !number.is_finite() || !(0.0..=9_007_199_254_740_991.0).contains(&number)
                })
            }))
    {
        return Err("公益模型 Credit 资料无效。".into());
    }
    let mut value = serde_json::to_value(public).map_err(|_| "公益模型账户资料无效。")?;
    for (model, rate) in value["models"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(credit_rates)
    {
        if let Some(rate) = rate {
            model["creditRate"] = rate;
        }
    }
    for (model, pricing) in value["models"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(credit_pricing)
    {
        if let Some(pricing) = pricing {
            model["creditPricing"] = pricing;
        }
    }
    // Retain only declared public limits, never an arbitrary upstream object.
    let mut limits = serde_json::Map::new();
    if let Some(limit) = request_limit {
        limits.insert("maxRequestBytes".into(), json!(limit));
    }
    if let Some(credits) = global_credits {
        limits.insert("globalDailyCredits".into(), credits);
    }
    if !limits.is_empty() {
        value["limits"] = Value::Object(limits);
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
        .bearer_auth(&bearer)
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
    // Identity can change while HTTP is in flight, including a fresh login with
    // the same forum ID. An old credential's response must not update the catalog.
    let (_, current_bearer) = account.relay_credential(Some(&id)).await?;
    if current_bearer != bearer {
        return Err("账户已变化，请重新读取额度。".into());
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
    fn canonical_credit_balance_and_pricing_are_the_only_source_for_public_projections() {
        let value = json!({"account":{"id":"42","username":"member","displayName":"Member"},
            "quota":{"day":"2026-10-30","timezone":"Asia/Singapore","resetsAt":"2026-10-31T00:00:00+08:00",
                "requestLimit":9007199254740991_u64,"tokenLimit":100000,"requestsUsed":230,"tokensUsed":1200,"tokensReserved":800,
                "requestsRemaining":9007199254740991_u64,"requestsUnlimited":true,"tokensRemaining":0,
                "creditsRemaining":0,"creditBalance":{"unit":"Credit","limit":100,"used":20,"reserved":5,"remaining":75,
                    "pricingRevision":4,"ledgerRevision":30,"key":"private-secret"}},
            "models":[{"id":"token-model","creditPricing":{"unit":"Credit","mode":"tokens","perTokens":1000000,
                "prices":{"input":22,"output":88,"cacheRead":2.2,"cacheWrite":22,"key":"private-secret"}}},
                {"id":"request-model","creditPricing":{"unit":"Credit","mode":"request","creditsPerRequest":0.25,
                    "key":"private-secret"}}],"ready":true});
        let public = public_status(value.clone(), "42").unwrap();
        assert_eq!(public["quota"]["creditsRemaining"], 75.0);
        assert_eq!(public["quota"]["creditLimit"], 100.0);
        assert_eq!(public["quota"]["creditBalance"]["pricingRevision"], 4);
        assert_eq!(public["quota"]["creditBalance"]["ledgerRevision"], 30);
        assert_eq!(public["models"][0]["creditPricing"]["perTokens"], 1000000);
        assert_eq!(
            public["models"][0]["creditPricing"]["prices"]["input"],
            22.0
        );
        assert_eq!(
            public["models"][1]["creditPricing"]["creditsPerRequest"],
            0.25
        );
        assert!(!public.to_string().contains("private-secret"));
        for invalid in [json!(null), json!(true), json!("75"), json!(-1)] {
            let mut malformed = value.clone();
            malformed["quota"]["creditBalance"]["remaining"] = invalid;
            assert!(public_status(malformed, "42").is_err());
        }
        let mut foreign_unit = value.clone();
        foreign_unit["quota"]["creditBalance"]["unit"] = json!("USD");
        assert!(public_status(foreign_unit, "42").is_err());
        let mut missing_revision = value;
        missing_revision["quota"]["creditBalance"]
            .as_object_mut()
            .unwrap()
            .remove("ledgerRevision");
        assert!(public_status(missing_revision, "42").is_err());
    }

    #[test]
    fn one_public_snapshot_updates_models_once_and_returns_its_actual_catalog_revision() {
        let db = Database::memory().unwrap();
        let value = json!({"account":{"id":"42"},"models":[{"id":"public-a"},{"id":"public-b"}]});
        let source = relay_source(&value).unwrap();
        let revision = sync_discovered_channel(&db, source.clone())
            .unwrap()
            .unwrap();
        let stored = channel_center::load(&db).unwrap();
        assert_eq!(stored.revision, revision);
        assert_eq!(stored.channels[0].account_id.as_deref(), Some("42"));
        assert_eq!(
            stored.channels[0]
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["public-a", "public-b"]
        );
        assert_eq!(sync_discovered_channel(&db, source).unwrap(), None);
        assert_eq!(channel_center::load(&db).unwrap().revision, revision);
    }

    #[test]
    fn unlimited_request_metadata_keeps_old_numbers_and_accepts_future_null_limits() {
        let base = json!({"account":{"id":"42","username":"member","displayName":"Member"},
            "quota":{"day":"2026-10-30","timezone":"Asia/Singapore","resetsAt":"2026-10-31T00:00:00+08:00",
                "requestLimit":20,"tokenLimit":100000,"requestsUsed":230,"tokensUsed":1200,"tokensReserved":800,
                "requestsRemaining":17,"tokensRemaining":98000},"models":[],"ready":true});
        for limit in [json!(20), json!(9_007_199_254_740_991_u64), Value::Null] {
            let mut value = base.clone();
            value["quota"]["requestLimit"] = limit.clone();
            value["quota"]["requestsRemaining"] = limit.clone();
            value["quota"]["requestsUnlimited"] = json!(true);
            let public = public_status(value, "42").unwrap();
            assert_eq!(public["quota"]["requestLimit"], limit);
            assert_eq!(public["quota"]["requestsRemaining"], limit);
            assert_eq!(public["quota"]["requestsUsed"], 230);
            assert_eq!(public["quota"]["requestsUnlimited"], true);
            assert!(public["quota"].get("requestLimit").is_some());
            assert!(public["quota"].get("requestsRemaining").is_some());
        }
        assert_eq!(
            public_status(base.clone(), "42").unwrap()["quota"]["requestsUnlimited"],
            false
        );
        for invalid in [json!(-1), json!("unlimited"), json!(true)] {
            let mut value = base.clone();
            value["quota"]["requestLimit"] = invalid;
            assert!(public_status(value, "42").is_err());
        }
    }

    #[test]
    fn credit_metadata_keeps_only_valid_public_numbers_without_leaking_secrets() {
        let value = json!({"account":{"id":"42","username":"member","displayName":"Member"},
            "quota":{"day":"2026-10-30","timezone":"Asia/Singapore","resetsAt":"2026-10-31T00:00:00+08:00",
                "requestLimit":20,"tokenLimit":100000,"requestsUsed":3,"tokensUsed":1200,"tokensReserved":800,
                "requestsRemaining":17,"tokensRemaining":98000,"creditUnit":"Credit","creditLimit":100,
                "creditsUsed":2.4,"creditsReserved":1.25,"creditsRemaining":96.35,"key":"private-secret"},
            "models":[{"id":"model","creditRate":{"input":0.5,"output":4,"cacheRead":0.05,
                "cacheWrite":1.25,"key":"private-secret"}}],"ready":true,
            "limits":{"globalDailyCredits":10000.5,"key":"private-secret"}});
        let public = public_status(value.clone(), "42").unwrap();
        assert_eq!(public["quota"]["creditsRemaining"], 96.35);
        assert_eq!(public["limits"], json!({"globalDailyCredits":10000.5}));
        assert_eq!(
            public["models"][0]["creditRate"],
            json!({"input":0.5,"output":4.0,"cacheRead":0.05,"cacheWrite":1.25})
        );
        assert!(!public.to_string().contains("private-secret"));
        for invalid in [json!(null), json!(-1), json!(true), json!("96.35")] {
            let mut invalid_status = value.clone();
            invalid_status["quota"]["creditsRemaining"] = invalid;
            assert!(public_status(invalid_status, "42").is_err());
        }
        let mut partial = value.clone();
        partial["quota"]
            .as_object_mut()
            .unwrap()
            .remove("creditLimit");
        assert!(public_status(partial, "42").is_err());
        for invalid in [json!(-1), json!(10000.1), json!("1"), json!(true)] {
            let mut invalid_status = value.clone();
            invalid_status["models"][0]["creditRate"]["input"] = invalid;
            assert!(public_status(invalid_status, "42").unwrap()["models"][0]
                .get("creditRate")
                .is_none());
        }
        let mut unlimited = value;
        unlimited["limits"]["globalDailyCredits"] = Value::Null;
        assert_eq!(
            public_status(unlimited, "42").unwrap()["limits"]["globalDailyCredits"],
            Value::Null
        );
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
    relay_source(&value)
}

fn relay_source(value: &Value) -> Result<channel_center::ChannelSource, String> {
    let id = value["account"]["id"].as_str().ok_or("账户资料无效。")?;
    let models = relay_models(value)?;
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

pub async fn refresh(
    state: &AppState,
    account: &LolicodeAccountState,
) -> Result<(Value, Option<u64>), String> {
    let value = status(account).await?;
    let source = relay_source(&value)?;
    account
        .relay_credential(source.account_id.as_deref())
        .await?;
    let revision = sync_discovered_channel(state.db.as_ref(), source)?;
    Ok((value, revision))
}

pub async fn sync_channel(
    state: &AppState,
    account: &LolicodeAccountState,
) -> Result<Option<u64>, String> {
    Ok(refresh(state, account).await?.1)
}

fn sync_discovered_channel(
    db: &crate::database::Database,
    mut source: channel_center::ChannelSource,
) -> Result<Option<u64>, String> {
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
        return Ok(None);
    }
    channel_center::save(db, snapshot).map_err(|error: AppError| error.to_string())?;
    Ok(Some(
        channel_center::load(db)
            .map_err(|error| error.to_string())?
            .revision,
    ))
}
