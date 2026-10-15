//! Stable renderer IPC for the in-process Rust agent and read-only history.
use crate::{
    commands::{CodexOAuthState, CopilotAuthState, XaiOAuthState},
    services::{
        agent_history,
        agent_host::{AgentOpenProject, AgentRuntimeStatus},
        agent_preferences::{self as preferences, AgentProject},
        channel_center::AgentCatalog,
        inprocess_agent::InprocessAgentState,
    },
    store::AppState,
};
use lolicode_agent::{AgentSession, AgentSnapshot};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn legacy_id(id: &str) -> Result<bool, String> {
    if (id.starts_with("ses_") || id.starts_with("zc:")) && id.len() <= 512 && !id.contains('\0') {
        return Ok(true);
    }
    if id.starts_with("lc:") && id.len() > 3 && id.len() <= 512 && !id.contains('\0') {
        return Ok(false);
    }
    Err("无法识别此会话的引擎，请重新读取会话列表".into())
}
async fn accounts(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let copilot = app
        .try_state::<CopilotAuthState>()
        .ok_or("账户服务尚未就绪")?;
    let codex = app
        .try_state::<CodexOAuthState>()
        .ok_or("账户服务尚未就绪")?;
    let xai = app.try_state::<XaiOAuthState>().ok_or("账户服务尚未就绪")?;
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
    Ok(accounts)
}
async fn native<T: DeserializeOwned>(
    app: &AppHandle,
    method: &str,
    args: Value,
    mutation: bool,
) -> Result<T, String> {
    let carrier = app.state::<InprocessAgentState>();
    carrier.ensure_started(app).await?;
    carrier.call(method, args, mutation).await
}
fn old_root() -> std::path::PathBuf {
    crate::config::get_app_config_dir().join("agent/runtime")
}
async fn old_sessions(project: Option<String>) -> Result<Vec<AgentSession>, String> {
    tokio::task::spawn_blocking(move || {
        agent_history::legacy_sessions(&old_root(), project.as_deref())
    })
    .await
    .map_err(|_| "旧会话记录读取未完成")?
}
fn historical_read_only<T>() -> Result<T, String> {
    Err("旧引擎会话保持只读，原数据已保留；请新建本体会话继续，不会启动旧引擎。".into())
}

fn check_project(app: &AppHandle, path: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    if !preferences::load(&state.db)?
        .projects
        .contains_key(&preferences::path_key(path))
    {
        return Err("此会话不属于已打开的工作台项目".into());
    }
    Ok(())
}
fn decorate(app: &AppHandle, session: &mut AgentSession) -> Result<(), String> {
    check_project(app, &session.project_path)?;
    preferences::decorate(&preferences::load(&app.state::<AppState>().db)?, session);
    Ok(())
}
fn sort_sessions(sessions: &mut [AgentSession]) {
    sessions.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.updated_at.cmp(&a.updated_at))
    });
}

pub(crate) async fn session_project(app: &AppHandle, session_id: &str) -> Result<String, String> {
    Ok(get_agent_session(app.clone(), session_id.into())
        .await?
        .session
        .project_path)
}

#[tauri::command]
pub async fn get_agent_status(app: AppHandle) -> Result<AgentRuntimeStatus, String> {
    app.state::<InprocessAgentState>().status(&app).await
}
#[tauri::command]
pub async fn get_agent_catalog(app: AppHandle) -> Result<AgentCatalog, String> {
    app.state::<InprocessAgentState>()
        .catalog(app.state::<AppState>().inner())
        .await
}
#[tauri::command]
pub async fn get_agent_catalog_revision(app: AppHandle) -> Result<u64, String> {
    crate::services::channel_center::load(&app.state::<AppState>().db)
        .map(|snapshot| snapshot.revision)
        .map_err(|error| error.to_string())
}
#[tauri::command(rename_all = "camelCase")]
pub async fn open_agent_project(
    app: AppHandle,
    path: String,
    refresh_models: Option<bool>,
) -> Result<AgentOpenProject, String> {
    let accounts = accounts(&app).await?;

    let mut opened = app
        .state::<InprocessAgentState>()
        .open_project(
            &app,
            app.state::<AppState>().inner(),
            path,
            accounts,
            refresh_models.unwrap_or(false),
        )
        .await?;
    let history = match old_sessions(Some(opened.workspace.path.clone())).await {
        Ok(sessions) => sessions,
        Err(error) => {
            log::warn!("旧会话暂无法读取：{error}");
            opened
                .warnings
                .push("本体项目已打开。旧会话暂无法读取，原始数据已保留；请新建会话继续。".into());
            Vec::new()
        }
    };
    for mut session in history {
        decorate(&app, &mut session)?;
        if !session.archived
            && !opened
                .sessions
                .iter()
                .any(|existing| existing.id == session.id)
        {
            opened.sessions.push(session);
        }
    }
    sort_sessions(&mut opened.sessions);
    Ok(opened)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn list_agent_sessions(
    app: AppHandle,
    project_path: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<AgentSession>, String> {
    let selected = match project_path {
        Some(path) => Some(path),
        None => app.state::<InprocessAgentState>().workspace_path().await,
    };
    if let Some(path) = &selected {
        check_project(&app, path)?;
    }
    let mut result: Vec<AgentSession> = native(
        &app,
        "listSessions",
        json!({"projectPath":selected,"includeArchived":true}),
        false,
    )
    .await?;
    if let Some(path) = selected {
        match old_sessions(Some(path)).await {
            Ok(sessions) => result.extend(sessions),
            Err(error) => log::warn!("旧会话列表暂不可用：{error}"),
        }
    }
    let registered = preferences::load(&app.state::<AppState>().db)?;
    result.retain(|session| {
        registered
            .projects
            .contains_key(&preferences::path_key(&session.project_path))
    });
    for session in &mut result {
        decorate(&app, session)?;
    }
    result.retain(|session| include_archived.unwrap_or(false) || !session.archived);
    sort_sessions(&mut result);
    result.dedup_by(|a, b| a.id == b.id);
    Ok(result)
}
#[tauri::command]
pub async fn list_agent_projects(app: AppHandle) -> Result<Vec<AgentProject>, String> {
    Ok(preferences::sorted_projects(&preferences::load(
        &app.state::<AppState>().db,
    )?))
}
#[tauri::command]
pub async fn set_agent_project_metadata(
    app: AppHandle,
    path: String,
    pinned: bool,
) -> Result<AgentProject, String> {
    app.state::<InprocessAgentState>()
        .project_metadata(app.state::<AppState>().inner(), &path, pinned)
        .await
}
#[tauri::command]
pub async fn remove_agent_project(app: AppHandle, path: String) -> Result<(), String> {
    app.state::<InprocessAgentState>()
        .remove_project(app.state::<AppState>().inner(), &path)
        .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn create_agent_session(
    app: AppHandle,
    model_id: String,
    mode: String,
    title: Option<String>,
    permission_mode: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<AgentSession, String> {
    let mut session: AgentSession = native(&app, "createSession", json!({"modelId":model_id,"mode":mode,"title":title,"permissionMode":permission_mode.unwrap_or_else(|| "ask".into()),"reasoningEffort":reasoning_effort}), true).await?;
    decorate(&app, &mut session)?;
    Ok(session)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn update_agent_session(
    app: AppHandle,
    session_id: String,
    model_id: Option<String>,
    mode: Option<String>,
    permission_mode: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<AgentSession, String> {
    if legacy_id(&session_id)? {
        return historical_read_only();
    }
    let mut result: AgentSession = native(&app, "updateSession", json!({"sessionId":session_id,"modelId":model_id,"mode":mode,"permissionMode":permission_mode,"reasoningEffort":reasoning_effort}), true).await?;
    if result.id != session_id {
        return Err("返回的会话与当前选择不一致".into());
    }
    decorate(&app, &mut result)?;
    Ok(result)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn rename_agent_session(
    app: AppHandle,
    session_id: String,
    title: String,
) -> Result<AgentSession, String> {
    if legacy_id(&session_id)? {
        return historical_read_only();
    }
    let mut session: AgentSession = native(
        &app,
        "renameSession",
        json!({"sessionId":session_id,"title":title}),
        true,
    )
    .await?;
    decorate(&app, &mut session)?;
    Ok(session)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn set_agent_session_metadata(
    app: AppHandle,
    session_id: String,
    pinned: Option<bool>,
    archived: Option<bool>,
) -> Result<AgentSession, String> {
    if legacy_id(&session_id)? {
        return historical_read_only();
    }
    let mut session: AgentSession = native(
        &app,
        "setSessionMetadata",
        json!({"sessionId":session_id,"pinned":pinned,"archived":archived}),
        true,
    )
    .await?;
    check_project(&app, &session.project_path)?;
    let state = app.state::<AppState>();
    let mut prefs = preferences::load(&state.db)?;
    let entry = prefs.sessions.entry(session_id).or_default();
    if let Some(pinned) = pinned {
        entry.pinned = pinned;
    }
    if let Some(archived) = archived {
        entry.archived = archived;
    }
    preferences::save(&state.db, &prefs)?;
    preferences::decorate(&prefs, &mut session);
    Ok(session)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn delete_agent_session(app: AppHandle, session_id: String) -> Result<(), String> {
    if legacy_id(&session_id)? {
        return historical_read_only();
    }
    native(&app, "deleteSession", json!({"sessionId":session_id}), true).await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn get_agent_session(
    app: AppHandle,
    session_id: String,
) -> Result<AgentSnapshot, String> {
    if legacy_id(&session_id)? {
        if session_id.starts_with("zc:") {
            return Err(
                "旧 ZCode 会话数据已保留，历史读取尚未迁入本体；请新建本体会话继续。".into(),
            );
        }
        let id = session_id.clone();
        let mut snapshot =
            tokio::task::spawn_blocking(move || agent_history::legacy_snapshot(&old_root(), &id))
                .await
                .map_err(|_| "旧会话只读加载未完成")??;
        decorate(&app, &mut snapshot.session)?;
        return Ok(snapshot);
    }
    let mut snapshot: AgentSnapshot =
        native(&app, "getSession", json!({"sessionId":session_id}), false).await?;
    if snapshot.session.id != session_id {
        return Err("返回的会话与当前选择不一致".into());
    }
    decorate(&app, &mut snapshot.session)?;
    Ok(snapshot)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn send_agent_message(
    app: AppHandle,
    session_id: String,
    text: String,
    request_id: String,
) -> Result<(), String> {
    if text.trim().is_empty() || text.len() > 1024 * 1024 {
        return Err("请输入不超过 1MiB 的任务内容".into());
    }
    if legacy_id(&session_id)? {
        return historical_read_only();
    }
    native(
        &app,
        "sendMessage",
        json!({"sessionId":session_id,"text":text,"requestId":request_id}),
        true,
    )
    .await
}
fn command_receipt(value: &Value, session_id: &str, request_id: &str) -> Value {
    let native_id = session_id
        .strip_prefix("lc:")
        .or_else(|| session_id.strip_prefix("zc:"))
        .unwrap_or(session_id);
    let item = value["results"].as_array().and_then(|items| {
        items.iter().find(|item| {
            item["key"]["commandId"].as_str() == Some(request_id)
                && item["key"]["sessionId"]
                    .as_str()
                    .is_some_and(|id| id == native_id || id == session_id)
        })
    });
    let Some(result) = item
        .map(|item| &item["result"])
        .filter(|result| result.is_object())
    else {
        return json!({"status":"unknown"});
    };
    if result["commandId"].as_str() != Some(request_id) {
        return json!({"status":"unknown"});
    }
    let status = match result["status"].as_str() {
        Some("accepted" | "duplicate") => "accepted",
        Some("rejected") => "rejected",
        Some("failed") => "failed",
        _ => "unknown",
    };
    json!({"status":status,"message":result["message"].as_str().map(|text| text.chars().take(500).collect::<String>())})
}
#[tauri::command(rename_all = "camelCase")]
pub async fn query_agent_command(
    app: AppHandle,
    session_id: String,
    request_id: String,
) -> Result<Value, String> {
    if legacy_id(&session_id)? {
        return Ok(json!({"status":"rejected","message":"旧会话只读，请新建本体会话继续"}));
    }
    let result: Value = native(
        &app,
        "queryCommand",
        json!({"sessionId":session_id,"requestId":request_id}),
        false,
    )
    .await?;
    Ok(command_receipt(&result, &session_id, &request_id))
}
#[tauri::command(rename_all = "camelCase")]
pub async fn interrupt_agent_session(app: AppHandle, session_id: String) -> Result<(), String> {
    if legacy_id(&session_id)? {
        return historical_read_only();
    }
    native(
        &app,
        "interruptSession",
        json!({"sessionId":session_id}),
        false,
    )
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn reply_agent_permission(
    app: AppHandle,
    session_id: String,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    if legacy_id(&session_id)? {
        return historical_read_only();
    }
    native(
        &app,
        "replyPermission",
        json!({"sessionId":session_id,"requestId":request_id,"decision":decision}),
        false,
    )
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn reply_agent_question(
    app: AppHandle,
    session_id: String,
    request_id: String,
    answer: Value,
) -> Result<(), String> {
    if legacy_id(&session_id)? {
        return historical_read_only();
    }
    native(
        &app,
        "replyQuestion",
        json!({"sessionId":session_id,"requestId":request_id,"answer":answer}),
        false,
    )
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn reject_agent_question(
    app: AppHandle,
    session_id: String,
    request_id: String,
) -> Result<(), String> {
    if legacy_id(&session_id)? {
        return historical_read_only();
    }
    native(
        &app,
        "rejectQuestion",
        json!({"sessionId":session_id,"requestId":request_id}),
        false,
    )
    .await
}
#[tauri::command]
pub async fn close_agent_project(app: AppHandle) -> Result<(), String> {
    app.state::<InprocessAgentState>().close_project().await
}

#[tauri::command]
pub async fn list_agent_native_capabilities(app: AppHandle) -> Result<Value, String> {
    native(&app, "capabilities", json!({}), false).await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn run_agent_saved_workflow(
    app: AppHandle,
    session_id: String,
    name: String,
    request_id: String,
    scope: String,
    args: Value,
) -> Result<AgentSession, String> {
    if legacy_id(&session_id)? {
        return Err("工作流需要本体会话，请新建会话后运行".into());
    }
    if !matches!(scope.as_str(), "project" | "global")
        || name.trim().is_empty()
        || request_id.trim().is_empty()
        || !args.is_object()
    {
        return Err("工作流名称、参数或运行编号无效".into());
    }
    let mut session: AgentSession = native(&app, "runSavedWorkflow", json!({"sessionId":session_id,"name":name,"requestId":request_id,"scope":scope,"args":args}), true).await?;
    if session.id != session_id {
        return Err("返回的工作流会话不一致，请重新读取".into());
    }
    decorate(&app, &mut session)?;
    Ok(session)
}
#[tauri::command]
pub async fn get_agent_native_activity(app: AppHandle) -> Result<Value, String> {
    native(&app, "activity", json!({}), false).await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn invoke_agent_native_service(
    app: AppHandle,
    service: String,
    method: String,
    args: Option<Vec<Value>>,
    scope: Option<Value>,
) -> Result<Value, String> {
    let mutation = !(service == "IZCodeTaskService" && method == "stopGeneration");
    native(
        &app,
        "capability",
        json!({"service":service,"method":method,"args":args.unwrap_or_default(),"scope":scope}),
        mutation,
    )
    .await
}
#[tauri::command]
pub async fn invoke_agent_automation(
    app: AppHandle,
    method: String,
    args: Option<Vec<Value>>,
) -> Result<Value, String> {
    native(
        &app,
        "automation",
        json!({"method":method,"args":args.unwrap_or_default()}),
        true,
    )
    .await
}
#[tauri::command]
pub async fn invoke_agent_remote(
    app: AppHandle,
    method: String,
    args: Option<Vec<Value>>,
) -> Result<Value, String> {
    native(
        &app,
        "remote",
        json!({"method":method,"args":args.unwrap_or_default()}),
        true,
    )
    .await
}

#[tauri::command]
pub async fn get_agent_extensions(app: AppHandle) -> Result<Value, String> {
    native(&app, "getExtensions", json!({}), false).await
}
#[tauri::command]
pub async fn set_agent_skill_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Value, String> {
    native(
        &app,
        "setSkillEnabled",
        json!({"id":id,"enabled":enabled}),
        true,
    )
    .await
}
#[tauri::command]
pub async fn import_agent_skill(app: AppHandle, path: String) -> Result<Value, String> {
    native(&app, "importSkill", json!({"path":path}), true).await
}
#[tauri::command]
pub async fn remove_agent_skill(app: AppHandle, id: String) -> Result<Value, String> {
    native(&app, "removeSkill", json!({"id":id}), true).await
}
#[tauri::command]
pub async fn install_agent_plugin(app: AppHandle, path: String) -> Result<Value, String> {
    native(&app, "installPlugin", json!({"path":path}), true).await
}
#[tauri::command]
pub async fn set_agent_plugin_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Value, String> {
    native(
        &app,
        "setPluginEnabled",
        json!({"id":id,"enabled":enabled}),
        true,
    )
    .await
}
#[tauri::command]
pub async fn uninstall_agent_plugin(app: AppHandle, id: String) -> Result<Value, String> {
    native(&app, "uninstallPlugin", json!({"id":id}), true).await
}
#[tauri::command]
pub async fn get_agent_extension_config(app: AppHandle) -> Result<Value, String> {
    native(&app, "getExtensionConfig", json!({}), false).await
}
#[tauri::command]
pub async fn save_agent_extension_config(app: AppHandle, config: Value) -> Result<Value, String> {
    native(&app, "saveExtensionConfig", json!({"config":config}), true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uncertain_commands_are_only_resolved_by_the_exact_native_command_key() {
        assert_eq!(
            command_receipt(
                &json!({"results":[{"key":{"sessionId":"owned","commandId":"msg_exact"},"result":"unknown"}]}),
                "zc:owned",
                "msg_exact"
            )["status"],
            "unknown"
        );
        let receipt = json!({"results":[{"key":{"sessionId":"owned","commandId":"msg_exact"},"result":{"commandId":"msg_exact","status":"rejected","message":"Owned rejection"}}]});
        assert_eq!(
            command_receipt(&receipt, "zc:owned", "msg_exact")["status"],
            "rejected"
        );
        assert_eq!(
            command_receipt(&receipt, "zc:other", "msg_exact")["status"],
            "unknown"
        );
        assert_eq!(
            command_receipt(&receipt, "zc:owned", "msg_other")["status"],
            "unknown"
        );
        assert!(legacy_id("ses_old").unwrap());
        assert!(legacy_id("zc:owned").unwrap());
        assert!(!legacy_id("lc:owned").unwrap());
        assert_eq!(
            command_receipt(&receipt, "lc:owned", "msg_exact")["status"],
            "rejected"
        );
        assert!(legacy_id("unknown").is_err());
    }
}
