//! Renderer access to the main Agent's private memory, not external Hermes files.
use crate::commands::agent_dispatch::native;
use serde_json::{json, Value};
use tauri::AppHandle;

#[tauri::command(rename_all = "camelCase")]
pub async fn get_agent_memory(
    app: AppHandle,
    project_path: Option<String>,
) -> Result<Value, String> {
    native(
        &app,
        "getMemory",
        json!({"projectPath":project_path}),
        false,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn edit_agent_memory(
    app: AppHandle,
    input: Value,
    project_path: Option<String>,
) -> Result<Value, String> {
    let mut input = input;
    input
        .as_object_mut()
        .ok_or("记忆参数无效")?
        .insert("projectPath".into(), json!(project_path));
    native(&app, "editMemory", input, true).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn configure_agent_memory(
    app: AppHandle,
    input: Value,
    project_path: Option<String>,
) -> Result<Value, String> {
    let mut input = input;
    input
        .as_object_mut()
        .ok_or("记忆参数无效")?
        .insert("projectPath".into(), json!(project_path));
    native(&app, "configureMemory", input, true).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn clear_agent_memory(
    app: AppHandle,
    revision: u64,
    scope: String,
    project_path: Option<String>,
) -> Result<Value, String> {
    native(
        &app,
        "clearMemory",
        json!({"revision":revision,"scope":scope,"projectPath":project_path}),
        true,
    )
    .await
}
