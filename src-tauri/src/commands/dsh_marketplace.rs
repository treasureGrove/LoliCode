use crate::services::dsh_marketplace::{
    self, InstallPluginRequest, MarketOverview, MarketplaceDetail, MarketplacePage,
    MarketplaceQuery,
};
use tauri::AppHandle;

#[tauri::command]
pub async fn get_dsh_marketplace_overview(app: AppHandle) -> Result<MarketOverview, String> {
    dsh_marketplace::overview(&app).await
}

#[tauri::command]
pub async fn query_dsh_marketplace(query: MarketplaceQuery) -> Result<MarketplacePage, String> {
    dsh_marketplace::query(query).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_dsh_marketplace_detail(
    name: String,
    version: Option<String>,
    source_url: Option<String>,
) -> Result<MarketplaceDetail, String> {
    dsh_marketplace::get_detail(name, version, source_url).await
}

#[tauri::command]
pub async fn add_dsh_marketplace_source(
    app: AppHandle,
    url: String,
) -> Result<MarketOverview, String> {
    dsh_marketplace::add_source(&app, url).await
}

#[tauri::command]
pub async fn remove_dsh_marketplace_source(
    app: AppHandle,
    url: String,
) -> Result<MarketOverview, String> {
    dsh_marketplace::remove_source(&app, url).await
}

#[tauri::command]
pub async fn select_dsh_marketplace_source(
    app: AppHandle,
    url: String,
) -> Result<MarketOverview, String> {
    dsh_marketplace::select_source(&app, url).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn refresh_dsh_marketplace_source(
    app: AppHandle,
    source_url: Option<String>,
) -> Result<MarketOverview, String> {
    dsh_marketplace::refresh_source(&app, source_url).await
}

#[tauri::command]
pub async fn install_dsh_marketplace_plugin(
    app: AppHandle,
    request: InstallPluginRequest,
) -> Result<MarketOverview, String> {
    dsh_marketplace::install_plugin(&app, request).await
}

#[tauri::command]
pub async fn set_dsh_marketplace_plugin_enabled(
    app: AppHandle,
    name: String,
    enabled: bool,
) -> Result<MarketOverview, String> {
    dsh_marketplace::set_plugin_enabled(&app, name, enabled).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn update_dsh_marketplace_plugin(
    app: AppHandle,
    name: String,
    version: Option<String>,
    registry: Option<String>,
    accept_incompatible: Option<bool>,
) -> Result<MarketOverview, String> {
    dsh_marketplace::update_plugin(
        &app,
        name,
        version,
        registry,
        accept_incompatible.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn uninstall_dsh_marketplace_plugin(
    app: AppHandle,
    name: String,
) -> Result<MarketOverview, String> {
    dsh_marketplace::uninstall_plugin(&app, name).await
}
