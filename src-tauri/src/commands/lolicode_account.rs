use crate::{services::lolicode_relay, store::AppState};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::services::lolicode_account::{LolicodeAccountState, LolicodeAccountStatus};

#[tauri::command]
pub async fn lolicode_account_status(
    state: State<'_, LolicodeAccountState>,
    app_state: State<'_, AppState>,
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<LolicodeAccountStatus, String> {
    let status = state.status(refresh.unwrap_or(false)).await;
    app.state::<crate::services::mobile_companion::MobileCompanionState>()
        .account_changed(&app, status.account.as_ref().map(|a| a.id.clone()))
        .await;
    if status.account.is_some() {
        // A relay outage must not turn a successful forum login into a failure.
        if lolicode_relay::sync_channel(app_state.inner(), state.inner())
            .await
            .is_ok()
        {
            let _ = app.emit("channel-center-updated", serde_json::json!({}));
        }
    }
    Ok(status)
}

#[tauri::command]
pub async fn lolicode_account_login(
    state: State<'_, LolicodeAccountState>,
    app_state: State<'_, AppState>,
    app: AppHandle,
    identification: String,
    password: String,
) -> Result<LolicodeAccountStatus, String> {
    app.state::<crate::services::mobile_companion::MobileCompanionState>()
        .fence_account(&app)
        .await;
    let status = state.login(identification, password).await?;
    app.state::<crate::services::mobile_companion::MobileCompanionState>()
        .account_changed(&app, status.account.as_ref().map(|a| a.id.clone()))
        .await;
    if lolicode_relay::sync_channel(app_state.inner(), state.inner())
        .await
        .is_ok()
    {
        let _ = app.emit("channel-center-updated", serde_json::json!({}));
    }
    Ok(status)
}

#[tauri::command]
pub async fn lolicode_relay_status(
    state: State<'_, LolicodeAccountState>,
) -> Result<serde_json::Value, String> {
    lolicode_relay::status(state.inner()).await
}

#[tauri::command]
pub async fn lolicode_relay_connect(
    state: State<'_, LolicodeAccountState>,
    app_state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    lolicode_relay::sync_channel(app_state.inner(), state.inner()).await?;
    let _ = app.emit("channel-center-updated", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
pub async fn lolicode_account_logout(
    state: State<'_, LolicodeAccountState>,
    app: AppHandle,
) -> Result<LolicodeAccountStatus, String> {
    app.state::<crate::services::mobile_companion::MobileCompanionState>()
        .logout_account(&app)
        .await;
    let status=state.logout().await;
    app.state::<crate::services::mobile_companion::MobileCompanionState>().fence_account(&app).await;
    Ok(status)
}
