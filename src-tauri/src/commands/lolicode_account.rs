use crate::{services::lolicode_relay, store::AppState};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::services::lolicode_account::{LolicodeAccountState, LolicodeAccountStatus};

#[tauri::command]
pub async fn lolicode_account_status(
    state: State<'_, LolicodeAccountState>,
    _app_state: State<'_, AppState>,
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<LolicodeAccountStatus, String> {
    let status = state.status(refresh.unwrap_or(false)).await;
    app.state::<crate::services::mobile_companion::MobileCompanionState>()
        .account_changed(&app, status.account.as_ref().map(|a| a.id.clone()))
        .await;
    // The shared relay query refreshes balance and models with one snapshot.
    // A relay outage must not turn a successful forum login into a failure.
    Ok(status)
}

#[tauri::command]
pub async fn lolicode_account_login(
    state: State<'_, LolicodeAccountState>,
    _app_state: State<'_, AppState>,
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
    Ok(status)
}

#[tauri::command]
pub async fn lolicode_relay_status(
    state: State<'_, LolicodeAccountState>,
    app_state: State<'_, AppState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let (snapshot, revision) = lolicode_relay::refresh(app_state.inner(), state.inner()).await?;
    emit_relay_catalog_revision(&app, revision);
    Ok(snapshot)
}

#[tauri::command]
pub async fn lolicode_relay_connect(
    state: State<'_, LolicodeAccountState>,
    app_state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let revision = lolicode_relay::sync_channel(app_state.inner(), state.inner()).await?;
    emit_relay_catalog_revision(&app, revision);
    Ok(())
}

fn emit_relay_catalog_revision(app: &AppHandle, revision: Option<u64>) {
    if let Some(revision) = revision {
        let _ = app.emit(
            "channel-center-updated",
            serde_json::json!({
                "revision": revision, "source": "lolicode-relay-refresh"
            }),
        );
    }
}

#[tauri::command]
pub async fn lolicode_account_logout(
    state: State<'_, LolicodeAccountState>,
    app: AppHandle,
) -> Result<LolicodeAccountStatus, String> {
    app.state::<crate::services::mobile_companion::MobileCompanionState>()
        .logout_account(&app)
        .await;
    let status = state.logout().await;
    app.state::<crate::services::mobile_companion::MobileCompanionState>()
        .fence_account(&app)
        .await;
    Ok(status)
}
