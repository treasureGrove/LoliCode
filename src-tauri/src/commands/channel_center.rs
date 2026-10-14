use crate::commands::copilot::CopilotAuthState;
use crate::services::channel_center::{
    self, ChannelApplyReport, ChannelCenterSnapshot, ChannelSource,
};
use crate::store::AppState;
use tauri::State;

#[tauri::command]
pub fn get_channel_center(state: State<'_, AppState>) -> Result<ChannelCenterSnapshot, String> {
    channel_center::load(state.db.as_ref()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_channel_center(
    state: State<'_, AppState>,
    snapshot: ChannelCenterSnapshot,
) -> Result<(), String> {
    channel_center::save(state.db.as_ref(), snapshot).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn discover_channel_models(
    channel: ChannelSource,
    copilot: State<'_, CopilotAuthState>,
) -> Result<ChannelSource, String> {
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
            .fetch_models_for_account(account)
            .await
            .map_err(|_| "无法读取 Copilot 模型，请检查账户登录、订阅与网络后重试".to_string())?;
        return Ok(channel_center::merge_copilot_models(channel, models));
    }
    channel_center::discover_api_models(channel)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn apply_channel_center(
    state: State<'_, AppState>,
    expected_revision: Option<u64>,
) -> Result<ChannelApplyReport, String> {
    channel_center::apply(state.inner(), expected_revision)
        .await
        .map_err(|error| error.to_string())
}
