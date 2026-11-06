use crate::services::harness_plugins::{self, PluginCatalog};
use tauri::AppHandle;

#[tauri::command]
pub async fn get_agent_harness_plugins(app: AppHandle) -> Result<PluginCatalog, String> {
    harness_plugins::catalog(&app, None).await
}

#[tauri::command]
pub async fn set_agent_harness_plugin_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<PluginCatalog, String> {
    harness_plugins::catalog(&app, Some((id, enabled))).await
}
