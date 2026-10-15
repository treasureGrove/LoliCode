//! Stable renderer IPC, native ZCode by default and explicit old-session routing.
use crate::{
    commands::{CodexOAuthState, CopilotAuthState, XaiOAuthState},
    services::{
        agent::{AgentOpenProject, AgentRuntimeStatus, AgentState},
        agent_preferences::{self as preferences, AgentProject},
        channel_center::AgentCatalog,
        zcode_agent::{self, ZcodeAgentState},
    },
    store::AppState,
};
use lolicode_agent::{AgentSession, AgentSnapshot};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn native_default(app: &AppHandle) -> bool {
    // A packaged app must report a broken native installation; only development
    // checkouts may explicitly fall back while preparing their owned resources.
    zcode_agent::runtime_files(app).is_some() || !cfg!(debug_assertions)
}
fn legacy_id(id: &str) -> Result<bool, String> {
    if id.starts_with("ses_") && id.len() <= 512 && !id.contains('\0') {
        return Ok(true);
    }
    if id.starts_with("zc:") && id.len() > 3 && id.len() <= 512 && !id.contains('\0') {
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
    let carrier = app.state::<ZcodeAgentState>();
    carrier.ensure_started(app).await?;
    carrier.call(method, args, mutation).await
}
fn old_root() -> std::path::PathBuf {
    crate::config::get_app_config_dir().join("agent/runtime")
}
async fn old_sessions(project: Option<String>) -> Result<Vec<AgentSession>, String> {
    tokio::task::spawn_blocking(move || {
        zcode_agent::legacy_sessions(&old_root(), project.as_deref())
    })
    .await
    .map_err(|_| "旧会话记录读取未完成")?
}
async fn ensure_legacy(app: &AppHandle, id: &str) -> Result<(), String> {
    let legacy = app.state::<AgentState>();
    if legacy.status(app).await.running {
        return Ok(());
    }
    let session = old_sessions(None)
        .await?
        .into_iter()
        .find(|session| session.id == id)
        .ok_or("旧会话记录不存在，原数据未改动")?;
    check_project(app, &session.project_path)?;
    legacy
        .open_project(
            app,
            app.state::<AppState>().inner(),
            session.project_path,
            accounts(app).await?,
            false,
        )
        .await?;
    Ok(())
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
    if native_default(&app) {
        app.state::<ZcodeAgentState>().status(&app).await
    } else {
        Ok(app.state::<AgentState>().status(&app).await)
    }
}
#[tauri::command]
pub async fn get_agent_catalog(app: AppHandle) -> Result<AgentCatalog, String> {
    if native_default(&app) {
        app.state::<ZcodeAgentState>()
            .catalog(app.state::<AppState>().inner())
            .await
    } else {
        app.state::<AgentState>()
            .catalog(app.state::<AppState>().inner())
            .await
    }
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
    if !native_default(&app) {
        return app
            .state::<AgentState>()
            .open_project(
                &app,
                app.state::<AppState>().inner(),
                path,
                accounts,
                refresh_models.unwrap_or(false),
            )
            .await;
    }
    let mut opened = app
        .state::<ZcodeAgentState>()
        .open_project(
            &app,
            app.state::<AppState>().inner(),
            path,
            accounts,
            refresh_models.unwrap_or(false),
        )
        .await?;
    for mut session in old_sessions(Some(opened.workspace.path.clone())).await? {
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
    if !native_default(&app) {
        return app
            .state::<AgentState>()
            .list_sessions(project_path.as_deref(), include_archived.unwrap_or(false))
            .await;
    }
    let selected = match project_path {
        Some(path) => Some(path),
        None => app.state::<ZcodeAgentState>().workspace_path().await,
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
        result.extend(old_sessions(Some(path)).await?);
    }
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
    app.state::<AgentState>()
        .project_metadata(app.state::<AppState>().inner(), &path, pinned)
        .await
}
#[tauri::command]
pub async fn remove_agent_project(app: AppHandle, path: String) -> Result<(), String> {
    let legacy = app.state::<AgentState>();
    let _legacy_lease = legacy.acquire_idle_for_update().await?;
    let carrier = app.state::<ZcodeAgentState>();
    let _lease = if native_default(&app) {
        Some(carrier.acquire_idle_for_navigation().await?)
    } else {
        None
    };
    legacy
        .remove_project_under_lease(app.state::<AppState>().inner(), &path)
        .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn create_agent_session(
    app: AppHandle,
    model_id: String,
    mode: String,
    title: Option<String>,
    permission_mode: Option<String>,
) -> Result<AgentSession, String> {
    if !native_default(&app) {
        return app
            .state::<AgentState>()
            .create_session(
                &model_id,
                &mode,
                title.as_deref(),
                permission_mode.as_deref().unwrap_or("ask"),
            )
            .await;
    }
    let mut session: AgentSession = native(&app, "createSession", json!({"modelId":model_id,"mode":mode,"title":title,"permissionMode":permission_mode.unwrap_or_else(|| "ask".into())}), true).await?;
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
) -> Result<AgentSession, String> {
    if legacy_id(&session_id)? {
        ensure_legacy(&app, &session_id).await?;
        return app
            .state::<AgentState>()
            .update_session(
                &session_id,
                model_id.as_deref(),
                mode.as_deref(),
                permission_mode.as_deref(),
            )
            .await;
    }
    let mut result: AgentSession = native(&app, "updateSession", json!({"sessionId":session_id,"modelId":model_id,"mode":mode,"permissionMode":permission_mode}), true).await?;
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
        ensure_legacy(&app, &session_id).await?;
        return app
            .state::<AgentState>()
            .rename_session(&session_id, &title)
            .await;
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
        ensure_legacy(&app, &session_id).await?;
        return app
            .state::<AgentState>()
            .session_metadata(&session_id, pinned, archived)
            .await;
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
        ensure_legacy(&app, &session_id).await?;
        return app.state::<AgentState>().delete_session(&session_id).await;
    }
    native(&app, "deleteSession", json!({"sessionId":session_id}), true).await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn get_agent_session(
    app: AppHandle,
    session_id: String,
) -> Result<AgentSnapshot, String> {
    if legacy_id(&session_id)? {
        ensure_legacy(&app, &session_id).await?;
        return app.state::<AgentState>().snapshot(&session_id).await;
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
        ensure_legacy(&app, &session_id).await?;
        return app
            .state::<AgentState>()
            .send(&session_id, &text, &request_id)
            .await;
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
    let native_id = session_id.strip_prefix("zc:").unwrap_or(session_id);
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
        return Ok(json!({"status":"unknown"}));
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
        ensure_legacy(&app, &session_id).await?;
        return app.state::<AgentState>().interrupt(&session_id).await;
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
        ensure_legacy(&app, &session_id).await?;
        return app
            .state::<AgentState>()
            .permission(&session_id, &request_id, &decision)
            .await;
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
        ensure_legacy(&app, &session_id).await?;
        return app
            .state::<AgentState>()
            .question(&session_id, &request_id, &answer)
            .await;
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
        ensure_legacy(&app, &session_id).await?;
        return app
            .state::<AgentState>()
            .reject_question(&session_id, &request_id)
            .await;
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
    let legacy = app.state::<AgentState>();
    let _legacy_lease = legacy.acquire_idle_for_update().await?;
    if native_default(&app) {
        app.state::<ZcodeAgentState>().close_project().await?;
    }
    legacy.shutdown().await
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
        return Err("工作流需要新的 ZCode 会话，请新建会话后运行".into());
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
    if native_default(&app) {
        native(&app, "getExtensions", json!({}), false).await
    } else {
        super::agent_extensions::get_agent_extensions(app.clone(), app.state::<AgentState>()).await
    }
}
#[tauri::command]
pub async fn set_agent_skill_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Value, String> {
    if native_default(&app) {
        native(
            &app,
            "setSkillEnabled",
            json!({"id":id,"enabled":enabled}),
            true,
        )
        .await
    } else {
        super::agent_extensions::set_agent_skill_enabled(
            app.clone(),
            app.state::<AgentState>(),
            id,
            enabled,
        )
        .await
    }
}
#[tauri::command]
pub async fn import_agent_skill(app: AppHandle, path: String) -> Result<Value, String> {
    if native_default(&app) {
        native(&app, "importSkill", json!({"path":path}), true).await
    } else {
        super::agent_extensions::import_agent_skill(app.clone(), app.state::<AgentState>(), path)
            .await
    }
}
#[tauri::command]
pub async fn remove_agent_skill(app: AppHandle, id: String) -> Result<Value, String> {
    if native_default(&app) {
        native(&app, "removeSkill", json!({"id":id}), true).await
    } else {
        super::agent_extensions::remove_agent_skill(app.clone(), app.state::<AgentState>(), id)
            .await
    }
}
#[tauri::command]
pub async fn install_agent_plugin(app: AppHandle, path: String) -> Result<Value, String> {
    if native_default(&app) {
        native(&app, "installPlugin", json!({"path":path}), true).await
    } else {
        super::agent_extensions::install_agent_plugin(app.clone(), app.state::<AgentState>(), path)
            .await
    }
}
#[tauri::command]
pub async fn set_agent_plugin_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Value, String> {
    if native_default(&app) {
        native(
            &app,
            "setPluginEnabled",
            json!({"id":id,"enabled":enabled}),
            true,
        )
        .await
    } else {
        super::agent_extensions::set_agent_plugin_enabled(
            app.clone(),
            app.state::<AgentState>(),
            id,
            enabled,
        )
        .await
    }
}
#[tauri::command]
pub async fn uninstall_agent_plugin(app: AppHandle, id: String) -> Result<Value, String> {
    if native_default(&app) {
        native(&app, "uninstallPlugin", json!({"id":id}), true).await
    } else {
        super::agent_extensions::uninstall_agent_plugin(app.clone(), app.state::<AgentState>(), id)
            .await
    }
}
#[tauri::command]
pub async fn get_agent_extension_config(app: AppHandle) -> Result<Value, String> {
    if native_default(&app) {
        native(&app, "getExtensionConfig", json!({}), false).await
    } else {
        serde_json::to_value(
            super::agent_extensions::get_agent_extension_config(
                app.clone(),
                app.state::<AgentState>(),
            )
            .await?,
        )
        .map_err(|_| "扩展配置无法编码".into())
    }
}
#[tauri::command]
pub async fn save_agent_extension_config(app: AppHandle, config: Value) -> Result<Value, String> {
    if native_default(&app) {
        native(&app, "saveExtensionConfig", json!({"config":config}), true).await
    } else {
        super::agent_extensions::save_agent_extension_config(
            app.clone(),
            app.state::<AgentState>(),
            serde_json::from_value(config).map_err(|_| "旧引擎扩展配置格式不兼容")?,
        )
        .await
    }
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
        assert!(!legacy_id("zc:owned").unwrap());
        assert!(legacy_id("unknown").is_err());
    }
}
