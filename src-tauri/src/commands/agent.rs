use crate::commands::{CodexOAuthState, CopilotAuthState, XaiOAuthState};
use crate::services::agent::{AgentOpenProject, AgentRuntimeStatus, AgentState};
use crate::services::channel_center::AgentCatalog;
use crate::store::AppState;
use lolicode_agent::{AgentSession, AgentSnapshot};
use serde_json::Value;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn get_agent_status(
    app: AppHandle,
    agent: State<'_, AgentState>,
) -> Result<AgentRuntimeStatus, String> {
    Ok(agent.status(&app).await)
}

#[tauri::command]
pub async fn get_agent_catalog(
    state: State<'_, AppState>,
    agent: State<'_, AgentState>,
) -> Result<AgentCatalog, String> {
    agent.catalog(state.inner()).await
}

#[tauri::command]
pub async fn open_agent_project(
    app: AppHandle,
    state: State<'_, AppState>,
    agent: State<'_, AgentState>,
    path: String,
    copilot: State<'_, CopilotAuthState>,
    codex: State<'_, CodexOAuthState>,
    xai: State<'_, XaiOAuthState>,
) -> Result<AgentOpenProject, String> {
    let mut accounts = Vec::new();
    for account in copilot.0.read().await.list_accounts().await {
        accounts.push(("github_copilot".into(), account.id));
    }
    for account in codex.0.list_accounts().await {
        accounts.push(("codex_oauth".into(), account.id));
    }
    for account in xai.0.read().await.list_accounts().await {
        accounts.push(("xai_oauth".into(), account.id));
    }
    agent
        .open_project(&app, state.inner(), path, accounts)
        .await
}

#[tauri::command]
pub async fn list_agent_sessions(
    agent: State<'_, AgentState>,
) -> Result<Vec<AgentSession>, String> {
    agent.list_sessions().await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn create_agent_session(
    agent: State<'_, AgentState>,
    model_id: String,
    mode: String,
    title: Option<String>,
) -> Result<AgentSession, String> {
    agent
        .create_session(&model_id, &mode, title.as_deref())
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_agent_session(
    agent: State<'_, AgentState>,
    session_id: String,
) -> Result<AgentSnapshot, String> {
    agent.snapshot(&session_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn send_agent_message(
    agent: State<'_, AgentState>,
    session_id: String,
    text: String,
    request_id: String,
) -> Result<(), String> {
    agent.send(&session_id, &text, &request_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn interrupt_agent_session(
    agent: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    agent.interrupt(&session_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn reply_agent_permission(
    agent: State<'_, AgentState>,
    session_id: String,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    agent.permission(&session_id, &request_id, &decision).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn reply_agent_question(
    agent: State<'_, AgentState>,
    session_id: String,
    request_id: String,
    answer: Value,
) -> Result<(), String> {
    agent.question(&session_id, &request_id, &answer).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn reject_agent_question(
    agent: State<'_, AgentState>,
    session_id: String,
    request_id: String,
) -> Result<(), String> {
    agent.reject_question(&session_id, &request_id).await
}

#[tauri::command]
pub async fn close_agent_project(agent: State<'_, AgentState>) -> Result<(), String> {
    agent.close_project().await
}
