use tauri::State;

use crate::services::lolicode_account::{LolicodeAccountState, LolicodeAccountStatus};

#[tauri::command]
pub async fn lolicode_account_status(
    state: State<'_, LolicodeAccountState>,
    refresh: Option<bool>,
) -> Result<LolicodeAccountStatus, String> {
    Ok(state.status(refresh.unwrap_or(false)).await)
}

#[tauri::command]
pub async fn lolicode_account_login(
    state: State<'_, LolicodeAccountState>,
    identification: String,
    password: String,
) -> Result<LolicodeAccountStatus, String> {
    state.login(identification, password).await
}

#[tauri::command]
pub async fn lolicode_account_logout(
    state: State<'_, LolicodeAccountState>,
) -> Result<LolicodeAccountStatus, String> {
    Ok(state.logout().await)
}
