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
use std::path::Path;
use tauri::{AppHandle, Manager};

/// Deliberately separate from the full task DTO: global companion polling must
/// not expose instructions, summaries, tool output or model configuration.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSecretaryTaskActivity {
    id: String,
    session_id: String,
    #[serde(default)]
    project_path: String,
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
    #[serde(default)]
    global: bool,
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
    // Read only the registered secretary summaries and their current task views.
    let activity = native(&app, "getSecretaryActivity", json!({}), false).await?;
    let preferences = agent_preferences::load(&app.state::<AppState>().db)?;
    let mut activity = registered_activity(activity, &preferences);
    for secretary in &mut activity {
        secretary.global = crate::services::agent_host::is_standalone_workspace(Path::new(
            &secretary.project_path,
        ));
        if let Ok(snapshot) = native::<lolicode_agent::AgentSnapshot>(
            &app,
            "getSession",
            json!({"sessionId":secretary.session_id}),
            false,
        )
        .await
        {
            secretary.status = snapshot.status;
        }
        if let Ok(state) = native::<AgentSecretaryState>(
            &app,
            "getSecretary",
            json!({"sessionId":secretary.session_id,"refresh":false}),
            false,
        )
        .await
        {
            secretary.tasks = state
                .tasks
                .into_iter()
                .filter(|task| {
                    task.parent_session_id == secretary.session_id
                        && preferences
                            .projects
                            .contains_key(&path_key(&task.project_path))
                        && (path_key(&task.project_path) == path_key(&secretary.project_path)
                            || secretary.global)
                })
                .map(|task| AgentSecretaryTaskActivity {
                    id: task.id,
                    session_id: task.session_id,
                    project_path: task.project_path,
                    title: task.title,
                    status: task.status,
                    updated_at: task.updated_at,
                })
                .collect();
        }
    }
    Ok(activity)
}

pub(super) fn verify_task(
    app: &AppHandle,
    parent_session_id: &str,
    project_path: &str,
    task_id: Option<&str>,
    task: &AgentSecretaryTask,
) -> Result<(), String> {
    if task.parent_session_id != parent_session_id
        || (path_key(&task.project_path) != path_key(project_path)
            && !crate::services::agent_host::is_standalone_workspace(Path::new(project_path)))
        || task_id.is_some_and(|expected| task.id != expected)
    {
        return Err("返回的任务与当前秘书不一致".into());
    }
    check_project(app, &task.project_path)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn open_agent_secretary(
    app: AppHandle,
    model_id: String,
    permission_mode: Option<String>,
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
    let mut state: AgentSecretaryState =
        native(&app, "getSecretary", json!({"sessionId":session_id}), false).await?;
    if crate::services::agent_host::is_standalone_workspace(Path::new(&project)) {
        let preferences = agent_preferences::load(&app.state::<AppState>().db)?;
        state.tasks.retain(|task| {
            preferences
                .projects
                .contains_key(&path_key(&task.project_path))
        });
    }
    if state.session_id != session_id {
        return Err("返回的秘书与当前选择不一致".into());
    }
    for task in &state.tasks {
        verify_task(&app, &session_id, &project, None, task)?;
    }
    Ok(state)
}

#[tauri::command(rename_all = "camelCase")]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri IPC exposes the existing payload fields as separate command arguments"
)]
pub async fn delegate_agent_secretary_task(
    app: AppHandle,
    session_id: String,
    title: String,
    instructions: String,
    request_id: String,
    locale: Option<String>,
    execution_mode: Option<String>,
    project_path: Option<String>,
) -> Result<AgentSecretaryTask, String> {
    let project = session_project(&app, &session_id).await?;
    let task: AgentSecretaryTask = native(
        &app,
        "delegateSecretaryTask",
        json!({
            "sessionId":session_id,"title":title,"instructions":instructions,
            "requestId":request_id,"locale":locale,"executionMode":execution_mode,
            "projectPath":project_path,
        }),
        true,
    )
    .await?;
    verify_task(&app, &session_id, &project, None, &task)?;
    if let Some(path) = project_path {
        if path_key(&task.project_path) != path_key(&path) {
            return Err("返回的任务与选中的项目不一致".into());
        }
    }
    Ok(task)
}

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

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_agent_secretary_task(
    app: AppHandle,
    session_id: String,
    task_id: String,
) -> Result<(), String> {
    session_project(&app, &session_id).await?;
    native(
        &app,
        "deleteSecretaryTask",
        json!({"sessionId": session_id, "taskId": task_id}),
        true,
    )
    .await
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
