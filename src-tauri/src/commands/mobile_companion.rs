use crate::services::mobile_companion::{
    AccountCompanionStatus, CompanionStatus, MobileCompanionState, PairingQr,
    LEGACY_PAIRING_DISABLED,
};
use tauri::{AppHandle, State, WebviewWindow};
fn local(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("仅电脑主窗口可以管理手机配对".into())
    }
}
#[tauri::command]
pub async fn get_mobile_companion_status(
    window: WebviewWindow,
    state: State<'_, MobileCompanionState>,
) -> Result<CompanionStatus, String> {
    local(&window)?;
    Ok(state.status().await)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn start_mobile_companion_pairing(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, MobileCompanionState>,
    relay_url: String,
) -> Result<PairingQr, String> {
    local(&window)?;
    let _ = (app, state, relay_url);
    Err(LEGACY_PAIRING_DISABLED.to_owned())
}
#[tauri::command(rename_all = "camelCase")]
pub async fn approve_mobile_companion_device(
    window: WebviewWindow,
    state: State<'_, MobileCompanionState>,
    room_id: String,
    device_id: String,
) -> Result<(), String> {
    local(&window)?;
    let _ = (state, room_id, device_id);
    Err(LEGACY_PAIRING_DISABLED.to_owned())
}
#[tauri::command(rename_all = "camelCase")]
pub async fn revoke_mobile_companion_device(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, MobileCompanionState>,
    room_id: String,
) -> Result<(), String> {
    local(&window)?;
    state.revoke(&app, &room_id).await
}

#[tauri::command]
pub async fn get_mobile_companion_account_status(
    window: WebviewWindow,
    state: State<'_, MobileCompanionState>,
) -> Result<AccountCompanionStatus, String> {
    local(&window)?;
    Ok(state.account_status().await)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn connect_mobile_companion_account(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, MobileCompanionState>,
    device_name: Option<String>,
) -> Result<AccountCompanionStatus, String> {
    local(&window)?;
    state.connect_account(&app, device_name).await
}
#[tauri::command]
pub async fn set_mobile_companion_account_visible(
    window: WebviewWindow,
    state: State<'_, MobileCompanionState>,
    visible: bool,
) -> Result<AccountCompanionStatus, String> {
    local(&window)?;
    Ok(state.account_visible(visible).await)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn approve_mobile_companion_account_request(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, MobileCompanionState>,
    request_id: String,
    phone_fingerprint: String,
) -> Result<AccountCompanionStatus, String> {
    local(&window)?;
    state
        .approve_account_request(&app, &request_id, &phone_fingerprint)
        .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn reject_mobile_companion_account_request(
    window: WebviewWindow,
    state: State<'_, MobileCompanionState>,
    request_id: String,
) -> Result<AccountCompanionStatus, String> {
    local(&window)?;
    state.reject_account_request(&request_id).await
}
#[tauri::command]
pub async fn disconnect_mobile_companion_account(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, MobileCompanionState>,
) -> Result<AccountCompanionStatus, String> {
    local(&window)?;
    state.disconnect_account(&app).await
}
