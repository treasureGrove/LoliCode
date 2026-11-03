//! Secretary orchestration uses the same native lifecycle and project boundary
//! as ordinary desktop sessions. The renderer never supplies engine credentials.
use super::agent_dispatch::{
    check_project, decorate, native, session_project, validated_message_payload,
    AgentAttachmentInput,
};
use crate::{
    services::agent_preferences::{self, path_key},
    store::AppState,
};
use lolicode_agent::{AgentSecretaryState, AgentSecretaryTask, AgentSession, AgentStatus};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};

/// Deliberately separate from the full task DTO: global companion polling must
/// not expose instructions, summaries, tool output or model configuration.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSecretaryTaskActivity {
    id: String,
    session_id: String,
    title: String,
    status: String,
    updated_at: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSecretaryActivity {
    session_id: String,
    project_path: String,
    title: String,
    status: AgentStatus,
    tasks: Vec<AgentSecretaryTaskActivity>,
}

fn registered_activity(
    activity: Vec<AgentSecretaryActivity>,
    preferences: &agent_preferences::Preferences,
) -> Vec<AgentSecretaryActivity> {
    activity
        .into_iter()
        .filter(|secretary| {
            preferences
                .projects
                .contains_key(&path_key(&secretary.project_path))
        })
        .collect()
}

#[tauri::command]
pub async fn get_agent_secretary_activity(
    app: AppHandle,
) -> Result<Vec<AgentSecretaryActivity>, String> {
    // This RPC reads native sessions directly. It never enumerates legacy
    // history or refreshes a task registry, flushes reports or dispatches work.
    let activity = native(&app, "getSecretaryActivity", json!({}), false).await?;
    let preferences = agent_preferences::load(&app.state::<AppState>().db)?;
    Ok(registered_activity(activity, &preferences))
}

fn verify_task(
    app: &AppHandle,
    parent_session_id: &str,
    project_path: &str,
    task_id: Option<&str>,
    task: &AgentSecretaryTask,
) -> Result<(), String> {
    if task.parent_session_id != parent_session_id
        || path_key(&task.project_path) != path_key(project_path)
        || task_id.is_some_and(|expected| task.id != expected)
    {
        return Err("返回的任务与当前秘书不一致".into());
    }
    check_project(app, &task.project_path)
}

#[expect(
    clippy::too_many_arguments,
    reason = "Named arguments are part of the desktop secretary IPC contract."
)]
#[tauri::command(rename_all = "camelCase")]
pub async fn open_agent_secretary(
    app: AppHandle,
    model_id: String,
    permission_mode: String,
    reasoning_effort: Option<String>,
    project_path: Option<String>,
    context_limit: Option<u64>,
    locale: Option<String>,
) -> Result<AgentSession, String> {
    if let Some(path) = &project_path {
        check_project(&app, path)?;
    }
    let mut session: AgentSession = native(
        &app,
        "openSecretary",
        json!({
            "projectPath": project_path,
            "modelId": model_id,
            "permissionMode": permission_mode,
            "reasoningEffort": reasoning_effort,
            "contextLimit": context_limit,
            "locale": locale,
        }),
        true,
    )
    .await?;
    decorate(&app, &mut session)?;
    Ok(session)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_agent_secretary(
    app: AppHandle,
    session_id: String,
) -> Result<AgentSecretaryState, String> {
    let project = session_project(&app, &session_id).await?;
    let state: AgentSecretaryState =
        native(&app, "getSecretary", json!({"sessionId":session_id}), false).await?;
    if state.session_id != session_id {
        return Err("返回的秘书与当前选择不一致".into());
    }
    for task in &state.tasks {
        verify_task(&app, &session_id, &project, None, task)?;
    }
    Ok(state)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delegate_agent_secretary_task(
    app: AppHandle,
    session_id: String,
    title: String,
    instructions: String,
    request_id: String,
    locale: Option<String>,
) -> Result<AgentSecretaryTask, String> {
    let project = session_project(&app, &session_id).await?;
    let task: AgentSecretaryTask = native(
        &app,
        "delegateSecretaryTask",
        json!({
            "sessionId":session_id,"title":title,"instructions":instructions,
            "requestId":request_id,"locale":locale,
        }),
        true,
    )
    .await?;
    verify_task(&app, &session_id, &project, None, &task)?;
    Ok(task)
}

#[expect(
    clippy::too_many_arguments,
    reason = "Named arguments preserve the existing message and attachment contract."
)]
#[tauri::command(rename_all = "camelCase")]
pub async fn send_agent_secretary_task_message(
    app: AppHandle,
    session_id: String,
    task_id: String,
    text: String,
    request_id: String,
    locale: Option<String>,
    attachments: Option<Vec<AgentAttachmentInput>>,
) -> Result<AgentSecretaryTask, String> {
    let project = session_project(&app, &session_id).await?;
    let mut args =
        validated_message_payload(session_id.clone(), text, request_id, locale, attachments)
            .await?;
    args["taskId"] = json!(task_id);
    let task: AgentSecretaryTask = native(&app, "sendSecretaryTaskMessage", args, true).await?;
    verify_task(&app, &session_id, &project, Some(&task_id), &task)?;
    Ok(task)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cancel_agent_secretary_task(
    app: AppHandle,
    session_id: String,
    task_id: String,
) -> Result<AgentSecretaryTask, String> {
    let project = session_project(&app, &session_id).await?;
    let task: AgentSecretaryTask = native(
        &app,
        "cancelSecretaryTask",
        json!({"sessionId":session_id,"taskId":task_id}),
        false,
    )
    .await?;
    verify_task(&app, &session_id, &project, Some(&task_id), &task)?;
    Ok(task)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn companion_activity_only_contains_registered_projects_and_public_status_fields() {
        let project = "D:/registered project";
        let preferences: agent_preferences::Preferences = serde_json::from_value(json!({
            "projects":{path_key(project):{"path":project,"name":"Project","lastOpenedAt":1}},
            "sessions":{}
        }))
        .unwrap();
        let input = json!([
            {"sessionId":"lc:secretary","projectPath":project,"title":"Secretary","status":"idle",
             "instructions":"private parent instructions","summary":"private parent result",
             "tasks":[{"id":"task-owned","sessionId":"lc:worker","title":"Needs approval",
                 "status":"waiting_permission","updatedAt":42,
                 "instructions":"private task instructions","summary":"private task result","error":"private error"}]},
            {"sessionId":"lc:outside","projectPath":"D:/unregistered","title":"Outside","status":"running","tasks":[]}
        ]);
        let projected = registered_activity(serde_json::from_value(input).unwrap(), &preferences);
        let output = serde_json::to_value(projected).unwrap();
        assert_eq!(output.as_array().unwrap().len(), 1);
        assert_eq!(output[0]["status"], "idle");
        assert_eq!(output[0]["tasks"][0]["status"], "waiting_permission");
        assert_eq!(output[0]["tasks"][0]["updatedAt"], 42);
        let encoded = output.to_string();
        assert!(!encoded.contains("private"));
        assert!(!encoded.contains("instructions"));
        assert!(!encoded.contains("summary"));
        assert!(!encoded.contains("error"));
    }
}
