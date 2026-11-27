use crate::services::harness_reasoning_translation;
use tauri::{Manager, WebviewWindow};

#[tauri::command]
pub async fn translate_agent_reasoning(
    window: WebviewWindow,
    text: String,
    target_language: String,
    request_id: String,
    provider: Option<String>,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("思考内容翻译只在应用主窗口可用".into());
    }
    harness_reasoning_translation::translate(
        window.app_handle(),
        text,
        target_language,
        &request_id,
        provider,
    )
    .await
}

#[tauri::command]
pub fn cancel_agent_reasoning_translation(
    window: WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("思考内容翻译只在应用主窗口可用".into());
    }
    harness_reasoning_translation::cancel(&request_id)
}
