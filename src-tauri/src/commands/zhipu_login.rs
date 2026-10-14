use crate::services::zhipu_login::{self, LoginPoll, LoginStart};

#[tauri::command]
pub async fn start_zhipu_login(provider: String) -> Result<LoginStart, String> {
    zhipu_login::start(&provider).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn poll_zhipu_login(flow_id: String) -> Result<LoginPoll, String> {
    Ok(zhipu_login::poll(&flow_id).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cancel_zhipu_login(flow_id: String) -> Result<(), String> {
    zhipu_login::cancel(&flow_id).await;
    Ok(())
}
