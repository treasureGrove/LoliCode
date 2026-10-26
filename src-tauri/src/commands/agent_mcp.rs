use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn connect_agent_mcp(app: AppHandle) -> Result<Value, String> {
    let carrier = app.state::<crate::services::inprocess_agent::InprocessAgentState>();
    carrier.ensure_started(&app).await?;
    carrier.connect_mcp().await?;
    carrier.call("getExtensions", json!({}), false).await
}
