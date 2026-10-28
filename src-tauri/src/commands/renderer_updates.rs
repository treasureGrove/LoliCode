use crate::services::{
    renderer_host::{DevelopmentFrontendBuild, RendererHost, RendererStatus},
    renderer_updates::PackView,
};
use std::sync::Arc;
use tauri::Manager;

#[tauri::command]
pub async fn rebuild_development_frontend(
    host: tauri::State<'_, Arc<RendererHost>>,
) -> Result<DevelopmentFrontendBuild, String> {
    host.rebuild_development_frontend().await
}

#[tauri::command]
pub async fn get_renderer_status(
    host: tauri::State<'_, Arc<RendererHost>>,
) -> Result<RendererStatus, String> {
    let host = host.inner().clone();
    tokio::task::spawn_blocking(move || host.status())
        .await
        .map_err(|_| "界面状态读取失败")?
}
#[tauri::command]
pub async fn check_renderer_update(
    host: tauri::State<'_, Arc<RendererHost>>,
) -> Result<Option<u64>, String> {
    let _operation = host.operation.try_lock().map_err(|_| "界面更新正在进行")?;
    host.store()?.check().await
}
#[tauri::command]
pub async fn install_renderer_update(
    host: tauri::State<'_, Arc<RendererHost>>,
) -> Result<PackView, String> {
    let _operation = host.operation.try_lock().map_err(|_| "界面更新正在进行")?;
    let store = host.store()?;
    let (envelope, bytes) = store.download().await?;
    tokio::task::spawn_blocking(move || store.install_verified_archive(&envelope, &bytes))
        .await
        .map_err(|_| "界面暂存未完成")?
}
#[tauri::command]
pub async fn confirm_renderer_boot(
    host: tauri::State<'_, Arc<RendererHost>>,
    id: String,
    ticket: String,
) -> Result<(), String> {
    let host = host.inner().clone();
    tokio::task::spawn_blocking(move || host.confirm(&id, &ticket))
        .await
        .map_err(|_| "界面显示确认未完成")?
}
#[tauri::command]
pub async fn rollback_renderer_update(
    host: tauri::State<'_, Arc<RendererHost>>,
    id: String,
) -> Result<PackView, String> {
    let _operation = host.operation.try_lock().map_err(|_| "界面更新正在进行")?;
    let store = host.store()?;
    tokio::task::spawn_blocking(move || store.rollback(&id))
        .await
        .map_err(|_| "界面回退未完成")?
}
#[tauri::command]
pub async fn restart_renderer(
    app: tauri::AppHandle,
    host: tauri::State<'_, Arc<RendererHost>>,
) -> Result<(), String> {
    let _operation = host.operation.try_lock().map_err(|_| "界面更新正在进行")?;
    let status = host.status()?;
    if !status.state.restart_required && !status.state.pending_confirmation {
        return Err("没有等待应用或回退的界面更新".into());
    }
    // Same lifecycle lease as native updates: covers all workspaces, queued
    // sends, approvals and native automation; failure never stops a task.
    let native = app.try_state::<crate::services::inprocess_agent::InprocessAgentState>();
    let _idle = match native.as_ref() {
        Some(agent) => Some(agent.acquire_idle_for_update().await?),
        None => None,
    };
    crate::save_window_state_before_exit(&app);
    crate::cleanup_before_exit(&app).await;
    crate::restart_process(&app)
}
