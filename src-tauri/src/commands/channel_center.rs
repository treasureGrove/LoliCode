use crate::commands::codex_oauth::CodexOAuthState;
use crate::commands::copilot::CopilotAuthState;
use crate::commands::xai_oauth::XaiOAuthState;
use crate::services::channel_center::{
    self, ChannelApplyReport, ChannelCenterSnapshot, ChannelSource,
};
use crate::store::AppState;
use tauri::{AppHandle, Emitter, State};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelUsageLabel {
    pub provider_id: String,
    pub name: String,
}

#[tauri::command]
pub fn get_channel_center(state: State<'_, AppState>) -> Result<ChannelCenterSnapshot, String> {
    channel_center::load(state.db.as_ref()).map_err(|error| error.to_string())
}

/// Return only channel identity and display names for usage views; never serialize channel keys.
#[tauri::command]
pub fn list_channel_usage_labels(
    state: State<'_, AppState>,
) -> Result<Vec<ChannelUsageLabel>, String> {
    let snapshot = channel_center::load(state.db.as_ref()).map_err(|error| error.to_string())?;
    Ok(snapshot
        .channels
        .into_iter()
        .map(|channel| ChannelUsageLabel {
            provider_id: format!("channel-{}", channel.id),
            name: channel.name,
        })
        .collect())
}

#[tauri::command]
pub fn save_channel_center(
    app: AppHandle,
    state: State<'_, AppState>,
    snapshot: ChannelCenterSnapshot,
) -> Result<(), String> {
    let revision = snapshot.revision.checked_add(1);
    channel_center::save(state.db.as_ref(), snapshot).map_err(|error| error.to_string())?;
    let _ = app.emit(
        "channel-center-updated",
        serde_json::json!({"revision":revision}),
    );
    Ok(())
}

#[tauri::command]
pub async fn discover_channel_models(
    channel: ChannelSource,
    lolicode: State<'_, crate::services::lolicode_account::LolicodeAccountState>,
    copilot: State<'_, CopilotAuthState>,
    codex: State<'_, CodexOAuthState>,
    xai: State<'_, XaiOAuthState>,
) -> Result<ChannelSource, String> {
    if channel.auth_kind == "lolicode_account" {
        return crate::services::lolicode_relay::discover(lolicode.inner()).await;
    }
    if let Some(target) = channel_center::native_auth_target(&channel.auth_kind) {
        let discovered = discover_native_subscription_channel(target.as_str().into()).await?;
        return Ok(channel_center::merge_managed_discovery(channel, discovered));
    }
    if matches!(channel.auth_kind.as_str(), "codex_oauth" | "xai_oauth") {
        let account = channel
            .account_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "请先为订阅渠道选择已授权账户".to_string())?
            .to_string();
        let models = match channel.auth_kind.as_str() {
            "codex_oauth" => {
                crate::commands::codex_oauth::get_codex_oauth_models(Some(account), codex).await
            }
            "xai_oauth" => {
                crate::commands::xai_oauth::get_xai_oauth_models(Some(account), xai).await
            }
            _ => unreachable!(),
        }
        .map_err(|_| "无法读取订阅模型，请检查此账户授权、套餐权限与网络后重试".to_string())?;
        return channel_center::merge_subscription_models(channel, models)
            .map_err(|error| error.to_string());
    }
    if channel.auth_kind == "zhipu_oauth" {
        let account = channel
            .account_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "请先登录智谱或 Z.ai 账户".to_string())?;
        let discovered = crate::services::zhipu_login::discover_account(account).await?;
        return Ok(channel_center::merge_managed_discovery(channel, discovered));
    }
    if channel.auth_kind == "github_copilot" {
        let account = channel
            .account_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "请先为此渠道选择已登录的 Copilot 账户".to_string())?;
        let manager = copilot.0.read().await;
        let models = manager
            .refresh_models_for_account(account)
            .await
            .map_err(|_| "无法读取 Copilot 模型，请检查账户登录、订阅与网络后重试".to_string())?;
        return Ok(channel_center::merge_copilot_models(channel, models));
    }
    channel_center::discover_api_models(channel)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn discover_native_subscription_channel(tool: String) -> Result<ChannelSource, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let channel = channel_center::native_subscription_channel(&tool)
            .map_err(|error| error.to_string())?;
        if crate::commands::local_tool_version(&tool).is_none() {
            return Err("本机没有检测到官方工具，请先在应用管理页安装后重试".into());
        }
        if !crate::services::subscription::native_channel_authenticated(&tool)? {
            return Err("官方工具尚未登录，请点击打开工具登录，完成后重新检测".into());
        }
        Ok(channel)
    })
    .await
    .map_err(|_| "原生登录检测无法完成，请重试".to_string())?
}

#[tauri::command]
pub async fn open_native_subscription_login(tool: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (command, label) = match tool.as_str() {
            "claude" => ("claude auth login", "claude_native_login"),
            "gemini" => ("gemini", "gemini_native_login"),
            _ => return Err("请选择 Claude Code 或 Gemini CLI".into()),
        };
        if crate::commands::local_tool_version(&tool).is_none() {
            return Err("本机没有检测到官方工具，请先在应用管理页安装后重试".into());
        }
        super::tool_management::launch_terminal_running(command, label)
    })
    .await
    .map_err(|_| "官方工具无法启动，请重试".to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn apply_channel_center(
    state: State<'_, AppState>,
    expected_revision: Option<u64>,
    copilot: State<'_, CopilotAuthState>,
    codex: State<'_, CodexOAuthState>,
    xai: State<'_, XaiOAuthState>,
) -> Result<ChannelApplyReport, String> {
    let snapshot = channel_center::load(state.db.as_ref()).map_err(|error| error.to_string())?;
    let accounts = managed_accounts(&copilot, &codex, &xai).await;
    channel_center::validate_managed_account_references(&snapshot, &accounts)
        .map_err(|error| error.to_string())?;
    channel_center::apply(state.inner(), expected_revision)
        .await
        .map_err(|error| error.to_string())
}

async fn managed_accounts(
    copilot: &CopilotAuthState,
    codex: &CodexOAuthState,
    xai: &XaiOAuthState,
) -> Vec<(String, String)> {
    let mut accounts = Vec::new();
    for account in copilot.0.read().await.list_accounts().await {
        accounts.push(("github_copilot".into(), account.id));
    }
    for account in codex.0.list_accounts().await {
        accounts.push(("codex_oauth".into(), account.id));
    }
    for account in xai.0.read().await.list_accounts().await {
        accounts.push(("xai_oauth".into(), account.id));
    }
    accounts
}

#[tauri::command]
pub fn get_channel_connections(
    state: State<'_, AppState>,
) -> Result<Vec<crate::services::channel_connections::ChannelConnection>, String> {
    crate::services::channel_connections::list(state.inner()).map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_channel_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    target: String,
    mode: String,
    expected_revision: Option<u64>,
    copilot: State<'_, CopilotAuthState>,
    codex: State<'_, CodexOAuthState>,
    xai: State<'_, XaiOAuthState>,
) -> Result<crate::services::channel_connections::ChannelConnection, String> {
    if mode == "lolicode" {
        let snapshot =
            channel_center::load(state.db.as_ref()).map_err(|error| error.to_string())?;
        let accounts = managed_accounts(&copilot, &codex, &xai).await;
        channel_center::validate_managed_account_references(&snapshot, &accounts)
            .map_err(|error| error.to_string())?;
    }
    let result =
        crate::services::channel_connections::set(state.inner(), &target, &mode, expected_revision)
            .await
            .map_err(|error| crate::error_for_log(&error.to_string()))?;
    let _ = app.emit("channel-connection-changed", &result);
    Ok(result)
}
