//! Billing credentials stay in the backend and optional PATs are never persisted.

use super::copilot::CopilotAuthState;
use crate::{
    error::AppError,
    services::copilot_billing::{self, CopilotBillingKind, CopilotBillingReport},
    store::AppState,
};
use tauri::State;

#[tauri::command]
pub async fn copilot_billing_list_reports(
    state: State<'_, AppState>,
) -> Result<Vec<CopilotBillingReport>, AppError> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || copilot_billing::list_reports(&db))
        .await
        .map_err(|_| AppError::Message("读取 Copilot 官方账本失败".into()))?
}

#[tauri::command]
pub async fn copilot_billing_sync(
    state: State<'_, AppState>,
    auth: State<'_, CopilotAuthState>,
    account_id: Option<String>,
    username: String,
    token: Option<String>,
    year: i32,
    month: u32,
    kind: CopilotBillingKind,
) -> Result<CopilotBillingReport, AppError> {
    copilot_billing::validate_query(&username, year, month)?;
    let credential = match token {
        Some(value) if !value.is_empty() => value,
        _ => {
            let account_id = account_id.ok_or_else(|| {
                AppError::Message(
                    "请先选择已登录的个人 Copilot 账号，或提供有 Plan 只读权限的 PAT".into(),
                )
            })?;
            let manager = auth.0.read().await;
            manager
                .github_billing_credential(&account_id, &username)
                .await
                .map_err(AppError::Message)?
        }
    };
    let report = copilot_billing::fetch_report(&username, &credential, year, month, kind).await?;
    let saved_report = report.clone();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || copilot_billing::save_report(&db, saved_report))
        .await
        .map_err(|_| AppError::Message("保存 Copilot 官方账本失败".into()))??;
    Ok(report)
}
