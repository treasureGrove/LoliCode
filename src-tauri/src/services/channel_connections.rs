//! Codex / Claude connection choice. UI receives status only, never profiles or keys.
//! Native profiles use the existing private provider store and transactional writers.
use super::channel_center;
use crate::{
    app_config::AppType, error::AppError, provider::Provider, services::ProviderService,
    store::AppState,
};
use serde::Serialize;
use serde_json::{json, Value};

const NATIVE_NOTE: &str = "LoliCode channel connection native profile";
const ROUTE_ID: &str = "tai-channel-gateway";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConnection {
    pub app: String,
    pub mode: String,
    pub configured: bool,
    pub has_native_profile: bool,
    pub message: Option<String>,
}

fn supported(app: &str) -> Result<AppType, AppError> {
    match app {
        "claude" => Ok(AppType::Claude),
        "codex" => Ok(AppType::Codex),
        _ => Err(AppError::InvalidInput(
            "仅 Codex 和 Claude Code 支持原生 / LoliCode 路由切换".into(),
        )),
    }
}

fn native_id(app: &AppType) -> String {
    format!("lolicode-channel-native-{}", app.as_str())
}

fn read_live(app: &AppType) -> Result<Value, AppError> {
    let exists = match app {
        AppType::Claude => crate::config::get_claude_settings_path().try_exists(),
        AppType::Codex => {
            let config = crate::codex_config::get_codex_config_path();
            let auth = crate::codex_config::get_codex_auth_path();
            Ok(config
                .try_exists()
                .map_err(|_| AppError::Config("无法检查 Codex 配置".into()))?
                || auth
                    .try_exists()
                    .map_err(|_| AppError::Config("无法检查 Codex 登录配置".into()))?)
        }
        _ => unreachable!(),
    }
    .map_err(|_| AppError::Config("无法检查原生配置文件".into()))?;
    if !exists {
        return Ok(if *app == AppType::Claude {
            json!({"env":{}})
        } else {
            json!({"auth":{},"config":""})
        });
    }
    ProviderService::read_live_settings(app.clone()).map_err(|_| {
        AppError::Config("无法读取原生配置，请修复配置格式后重试；未改写原文件".into())
    })
}

fn live_base(app: &AppType, live: &Value) -> Option<String> {
    match app {
        AppType::Claude => live
            .pointer("/env/ANTHROPIC_BASE_URL")
            .and_then(Value::as_str)
            .map(str::to_owned),
        AppType::Codex => {
            let text = live["config"].as_str().unwrap_or_default();
            crate::codex_config::extract_codex_base_url(text).or_else(|| {
                let doc = text.parse::<toml::Value>().ok()?;
                if doc
                    .get("model_provider")
                    .and_then(toml::Value::as_str)
                    .is_some_and(|id| id != "openai")
                {
                    return None;
                }
                doc.get("openai_base_url")
                    .and_then(toml::Value::as_str)
                    .map(str::to_owned)
            })
        }
        _ => None,
    }
}

fn is_gateway(app: &AppType, live: &Value) -> bool {
    live_base(app, live)
        .and_then(|base| url::Url::parse(&base).ok())
        .is_some_and(|url| {
            let loopback = url.host_str().is_some_and(|host| {
                host == "localhost"
                    || host
                        .trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            });
            let path = url.path().trim_end_matches('/');
            let catalog = path.strip_prefix("/tai/catalogs/").is_some_and(|suffix| {
                let revision = suffix.strip_suffix("/v1").unwrap_or(suffix);
                !revision.is_empty() && revision.bytes().all(|byte| byte.is_ascii_digit())
            });
            loopback && url.scheme() == "http" && (matches!(path, "/tai" | "/tai/v1") || catalog)
        })
}

pub fn status(state: &AppState, app: &str) -> Result<ChannelConnection, AppError> {
    let app = supported(app)?;
    let configured = state
        .db
        .get_provider_by_id(ROUTE_ID, app.as_str())?
        .is_some_and(|provider| provider.notes.as_deref() == Some(channel_center::MANAGED_NOTE));
    let has_native_profile = state
        .db
        .get_provider_by_id(&native_id(&app), app.as_str())?
        .is_some_and(|provider| provider.notes.as_deref() == Some(NATIVE_NOTE));
    let (mode, message) = match read_live(&app) {
        Ok(live) if is_gateway(&app, &live) => ("lolicode", None),
        Ok(_) if crate::mode::current::is_proxy(&app) => (
            "unknown",
            Some("当前由旧路由模式管理，可切回原生配置或切换 LoliCode 路由。".into()),
        ),
        Ok(_) => ("native", None),
        Err(_) => (
            "unknown",
            Some("无法读取当前配置，修复格式后请刷新状态。".into()),
        ),
    };
    Ok(ChannelConnection {
        app: app.as_str().into(),
        mode: mode.into(),
        configured,
        has_native_profile,
        message,
    })
}

pub fn list(state: &AppState) -> Result<Vec<ChannelConnection>, AppError> {
    ["codex", "claude"]
        .into_iter()
        .map(|app| status(state, app))
        .collect()
}

/// Called after leaving legacy proxy mode, immediately before a channel write.
/// Repeated applies while routed must never replace the native profile with a gateway token.
pub(super) fn capture_native(state: &AppState, app: &AppType) -> Result<(), AppError> {
    if !matches!(app, AppType::Codex | AppType::Claude) {
        return Ok(());
    }
    let _guard = crate::mode::controller::lock_settled_blocking(state, app)?;
    let live = read_live(app)?;
    if is_gateway(app, &live) {
        return Ok(());
    }
    if crate::mode::current::is_proxy(app) {
        return Err(AppError::Conflict(
            "请先退出旧路由模式再保存原生配置".into(),
        ));
    }
    let id = native_id(app);
    if state
        .db
        .get_provider_by_id(&id, app.as_str())?
        .is_some_and(|provider| provider.notes.as_deref() != Some(NATIVE_NOTE))
    {
        return Err(AppError::Conflict(
            "原生配置备份标识已被其它供应商使用，未覆盖".into(),
        ));
    }
    let current = crate::mode::current::direct_provider(state.db.as_ref(), app)?;
    let mut profile = current
        .unwrap_or_else(|| Provider::with_id(id.clone(), "原生配置".into(), live.clone(), None));
    profile.id = id;
    profile.name = "原生配置（切换前）".into();
    profile.settings_config = live;
    profile.notes = Some(NATIVE_NOTE.into());
    if *app == AppType::Codex {
        // Probe with an official category: the shared detector rejects custom
        // endpoints and API keys, and accepts the CLI's native OAuth route.
        profile.category = Some("official".into());
        if !crate::proxy::providers::is_codex_official_provider(&profile) {
            profile.category = Some("custom".into());
        }
    }
    // This is an exact native snapshot, not a new imported provider. The normal
    // add path expands Claude model aliases and would change its meaning.
    state.db.save_provider(app.as_str(), &profile)?;
    Ok(())
}

pub async fn set(
    state: &AppState,
    app: &str,
    mode: &str,
    expected_revision: Option<u64>,
) -> Result<ChannelConnection, AppError> {
    let kind = supported(app)?;
    match mode {
        "lolicode" => {
            let report =
                channel_center::apply_to(state, expected_revision, Some(app), true).await?;
            let result = report
                .results
                .iter()
                .find(|result| result.app == app)
                .ok_or_else(|| AppError::Config("没有收到此工具的配置结果".into()))?;
            if result.status != "success" {
                return Err(AppError::Message(result.message.clone()));
            }
        }
        "native" => {
            let _guard = channel_center::apply_lock().lock().await;
            if status(state, app)?.mode == "native" {
                return status(state, app);
            }
            if crate::mode::current::is_proxy(&kind) {
                crate::mode::controller::exit(state, &kind)
                    .await
                    .map_err(AppError::Message)?;
            }
            let owned_state = state.clone();
            let owned_kind = kind.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let id = native_id(&owned_kind);
                let target = match owned_state
                    .db
                    .get_provider_by_id(&id, owned_kind.as_str())?
                {
                    Some(provider) if provider.notes.as_deref() == Some(NATIVE_NOTE) => id,
                    Some(_) => {
                        return Err(AppError::Conflict("原生配置备份归属不匹配，未覆盖".into()))
                    }
                    None => {
                        let seed = if owned_kind == AppType::Codex {
                            "codex-official"
                        } else {
                            "claude-official"
                        };
                        owned_state
                            .db
                            .ensure_official_seed_by_id(seed, owned_kind.clone())?;
                        seed.into()
                    }
                };
                let result = ProviderService::switch(&owned_state, owned_kind, &target)?;
                if !result.warnings.is_empty() {
                    return Err(AppError::Message(
                        "原生配置未完全恢复，请刷新状态后重试".into(),
                    ));
                }
                Ok(())
            })
            .await
            .map_err(|_| AppError::Message("切换配置任务未完成，请刷新状态后重试".into()))??;
        }
        _ => {
            return Err(AppError::InvalidInput(
                "请选择原生配置或 LoliCode 路由".into(),
            ))
        }
    }
    let result = status(state, app)?;
    if result.mode != mode {
        return Err(AppError::Conflict(
            "配置文件状态与目标不一致，请刷新后重试".into(),
        ));
    }
    Ok(result)
}

#[cfg(test)]
#[path = "channel_connections_tests.rs"]
mod tests;
