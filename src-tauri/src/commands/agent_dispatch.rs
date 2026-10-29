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
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
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
pub(crate) async fn accounts(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
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
pub(crate) async fn native<T: DeserializeOwned>(
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
#[tauri::command]
pub async fn open_agent_standalone(app: AppHandle) -> Result<AgentOpenProject, String> {
    let path = tokio::task::spawn_blocking(|| {
        crate::services::agent_host::standalone_workspace_at(&crate::config::get_app_config_dir())
    }).await.map_err(|_| "独立任务目录检查未完成")??;
    open_agent_project(app, path.to_string_lossy().into_owned(), None).await
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
    pinned: Option<bool>,
    name: Option<String>,
) -> Result<AgentProject, String> {
    app.state::<InprocessAgentState>()
        .project_metadata(app.state::<AppState>().inner(), &path, pinned, name.as_deref())
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
    context_limit: Option<u64>,
    project_path: Option<String>,
) -> Result<AgentSession, String> {
    if let Some(path) = &project_path { check_project(&app, path)?; }
    let mut session: AgentSession = native(&app, "createSession", json!({"projectPath":project_path,"modelId":model_id,"mode":mode,"title":title,"permissionMode":permission_mode.unwrap_or_else(|| "ask".into()),"reasoningEffort":reasoning_effort,"contextLimit":context_limit}), true).await?;
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
    context_limit: Option<u64>,
    reset_context_limit: Option<bool>,
) -> Result<AgentSession, String> {
    if legacy_id(&session_id)? {
        return historical_read_only();
    }
    let mut result: AgentSession = native(&app, "updateSession", json!({"sessionId":session_id,"modelId":model_id,"mode":mode,"permissionMode":permission_mode,"reasoningEffort":reasoning_effort,"contextLimit":context_limit,"resetContextLimit":reset_context_limit}), true).await?;
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
    locale: Option<String>,
    attachments: Option<Vec<AgentAttachmentInput>>,
) -> Result<(), String> {
    let attachments = attachments.unwrap_or_default();
    if (text.trim().is_empty() && attachments.is_empty()) || text.len() > 1024 * 1024 {
        return Err("请输入任务内容或添加附件；文本不能超过 1MiB".into());
    }
    if attachments.len() > 8 {
        return Err("一次最多发送 4 张图片和 4 个文档".into());
    }
    let mut image_count = 0usize;
    let mut document_count = 0usize;
    let mut image_total_bytes = 0u64;
    let mut document_total_bytes = 0u64;
    let mut attachment_values = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        if let Some(reference) = attachment.reference {
            const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
            let allowed_mime = matches!(
                attachment.mime.as_str(),
                "image/png"
                    | "image/jpeg"
                    | "image/webp"
                    | "image/gif"
                    | "image/bmp"
                    | "image/avif"
            );
            let prefix = format!("data:{};base64,", attachment.mime);
            let Some(encoded) = reference.strip_prefix(&prefix) else {
                return Err("图片数据格式无效，请重新添加图片".into());
            };
            if attachment.data_base64.is_some()
                || attachment.local_path.is_some()
                || !allowed_mime
                || attachment.bytes == 0
                || attachment.bytes > MAX_IMAGE_BYTES
            {
                return Err("图片格式不受支持或单张图片超过 5 MB".into());
            }
            image_count += 1;
            image_total_bytes = image_total_bytes.saturating_add(attachment.bytes);
            if image_count > 4 || image_total_bytes > 10 * 1024 * 1024 {
                return Err("最多发送 4 张图片，图片总大小不能超过 10 MB".into());
            }
            let decoded = STANDARD
                .decode(encoded)
                .map_err(|_| "图片数据编码无效，请重新添加图片".to_string())?;
            if decoded.len() as u64 != attachment.bytes
                || super::agent_images::image_media_type(&decoded)
                    != Some(attachment.mime.as_str())
            {
                return Err("图片内容与格式不匹配，请重新添加图片".into());
            }
            attachment_values.push(json!({
                "ref": reference,
                "fileName": attachment.file_name,
                "mime": attachment.mime,
                "bytes": attachment.bytes,
            }));
        } else if let Some(local_path) = attachment.local_path {
            if attachment.data_base64.is_some() {
                return Err("附件数据无效，请重新添加文件".into());
            }
            let path = std::path::Path::new(&local_path);
            if !path.is_absolute() {
                return Err("只能添加从本机拖入的文档文件".into());
            }
            let metadata = tokio::fs::metadata(path)
                .await
                .map_err(|_| "无法读取拖入的文档，请确认文件仍然存在".to_string())?;
            if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 20 * 1024 * 1024 {
                return Err("文档格式不受支持或单个文档超过 20 MB".into());
            }
            validate_document_metadata(
                &attachment.file_name,
                &attachment.mime,
                metadata.len(),
                &mut document_count,
                &mut document_total_bytes,
            )?;
            let decoded = tokio::fs::read(path)
                .await
                .map_err(|_| "无法读取拖入的文档，请确认文件仍然存在".to_string())?;
            if decoded.len() as u64 != metadata.len()
                || !valid_document_signature(&attachment.file_name, &decoded)
            {
                return Err("文档内容与文件格式不匹配，请重新拖入文件".into());
            }
            attachment_values.push(json!({
                "localPath": local_path,
                "fileName": attachment.file_name,
                "mime": attachment.mime,
                "bytes": metadata.len(),
            }));
        } else if let Some(data_base64) = attachment.data_base64 {
            validate_document_metadata(
                &attachment.file_name,
                &attachment.mime,
                attachment.bytes,
                &mut document_count,
                &mut document_total_bytes,
            )?;
            let decoded = STANDARD
                .decode(&data_base64)
                .map_err(|_| "文档数据编码无效，请重新添加文件".to_string())?;
            if decoded.len() as u64 != attachment.bytes
                || !valid_document_signature(&attachment.file_name, &decoded)
            {
                return Err("文档内容与文件格式不匹配，请重新添加文件".into());
            }
            attachment_values.push(json!({
                "dataBase64": data_base64,
                "fileName": attachment.file_name,
                "mime": attachment.mime,
                "bytes": attachment.bytes,
            }));
        } else {
            return Err("附件数据无效，请重新添加文件".into());
        }
    }
    if legacy_id(&session_id)? {
        return historical_read_only();
    }
    let mut args = json!({
        "sessionId": session_id,
        "text": text,
        "requestId": request_id,
        "locale": locale,
    });
    if !attachment_values.is_empty() {
        args["attachments"] = Value::Array(attachment_values);
    }
    native(
        &app,
        "sendMessage",
        args,
        true,
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachmentInput {
    #[serde(rename = "ref")]
    reference: Option<String>,
    file_name: String,
    mime: String,
    bytes: u64,
    data_base64: Option<String>,
    local_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDocumentInfo {
    file_name: String,
    mime: String,
    bytes: u64,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn inspect_agent_document(path: String) -> Result<AgentDocumentInfo, String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() {
        return Err("只能添加本机上的文档文件".into());
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty() && name.len() <= 255)
        .ok_or("文档文件名无效")?
        .to_string();
    let mime = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .and_then(|extension| document_mime_for_extension(&extension))
        .ok_or("支持 PDF、Word、PowerPoint、Excel 和常见文本文件")?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| "无法读取文档，请确认文件仍然存在".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 20 * 1024 * 1024 {
        return Err("单个文档不能超过 20 MB，且文件不能为空".into());
    }
    let contents = tokio::fs::read(&path)
        .await
        .map_err(|_| "无法读取文档，请确认文件仍然存在".to_string())?;
    if contents.len() as u64 != metadata.len()
        || !valid_document_signature(&file_name, &contents)
    {
        return Err("文件内容与扩展名不匹配".into());
    }
    Ok(AgentDocumentInfo {
        file_name,
        mime: mime.into(),
        bytes: metadata.len(),
    })
}

fn validate_document_metadata(
    file_name: &str,
    mime: &str,
    bytes: u64,
    document_count: &mut usize,
    document_total_bytes: &mut u64,
) -> Result<(), String> {
    const MAX_DOCUMENT_BYTES: u64 = 20 * 1024 * 1024;
    if file_name.trim().is_empty()
        || file_name.len() > 255
        || !supported_document_mime(file_name, mime)
        || bytes == 0
        || bytes > MAX_DOCUMENT_BYTES
    {
        return Err("文档格式不受支持或单个文档超过 20 MB".into());
    }
    *document_count += 1;
    *document_total_bytes = document_total_bytes.saturating_add(bytes);
    if *document_count > 4 || *document_total_bytes > 40 * 1024 * 1024 {
        return Err("最多发送 4 个文档，文档总大小不能超过 40 MB".into());
    }
    Ok(())
}

fn supported_document_mime(file_name: &str, mime: &str) -> bool {
    let extension = file_name.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase());
    extension
        .as_deref()
        .and_then(document_mime_for_extension)
        .is_some_and(|expected| mime == expected)
}

fn document_mime_for_extension(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docm" => "application/vnd.ms-word.document.macroEnabled.12",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pptm" => "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsm" => "application/vnd.ms-excel.sheet.macroEnabled.12",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "rtf" => "application/rtf",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "odp" => "application/vnd.oasis.opendocument.presentation",
        "json" => "application/json",
        _ => return None,
    })
}

fn valid_document_signature(file_name: &str, bytes: &[u8]) -> bool {
    let extension = file_name.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase());
    match extension.as_deref() {
        Some("docx" | "docm" | "pptx" | "pptm" | "xlsx" | "xlsm" | "odt" | "ods" | "odp") => {
            bytes.starts_with(b"PK\x03\x04")
        }
        Some("doc" | "ppt" | "xls") => {
            bytes.starts_with(b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1")
        }
        Some("pdf") => bytes.starts_with(b"%PDF-"),
        Some("rtf") => bytes.starts_with(b"{\\rtf"),
        Some("txt" | "md" | "markdown" | "csv" | "json") => {
            std::str::from_utf8(bytes).is_ok()
        }
        _ => false,
    }
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
        Some("accepted" | "duplicate" | "completed" | "cancelled") => "accepted",
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
    let mut value: Value = native(&app, "capabilities", json!({}), false).await?;
    // CLI/content plugins are adapted by the desktop extension host. The core's
    // generic JS-plugin/MCP flags remain false until those runtimes exist.
    value["features"]["cliPlugins"] = json!(true);
    value["features"]["pluginMarketplace"] = json!(true);
    value["features"]["remote"] = json!(true);
    Ok(value)
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
        || request_id.len() > 256
        || request_id.contains('\0')
        || !args.is_object()
    {
        return Err("工作流名称、参数或运行编号无效".into());
    }
    let snapshot: AgentSnapshot = native(
        &app,
        "getSession",
        json!({"sessionId":session_id}),
        false,
    )
    .await?;
    if snapshot.session.id != session_id {
        return Err("返回的工作流会话不一致，请重新读取".into());
    }
    let project_path = snapshot.session.project_path.clone();
    check_project(&app, &project_path)?;
    let remote = app.state::<InprocessAgentState>().remote_projects(&app.state::<AppState>()).await;
    let prompt = crate::services::agent_workflows::workflow_prompt_with_remote(
        &remote,
        &project_path,
        &name,
        &scope,
        &args,
    )
    .await?;
    crate::services::agent_workflows::record_run(&app, &project_path, &session_id, &name, &scope, &request_id, &prompt).await?;
    let locale = crate::settings::get_settings().language.unwrap_or_else(|| "zh".into());
    let _: Value = native(
        &app,
        "sendMessage",
        json!({"sessionId":session_id,"requestId":request_id,"text":prompt,"locale":locale}),
        true,
    )
    .await?;
    let mut result: AgentSnapshot = native(
        &app,
        "getSession",
        json!({"sessionId":session_id}),
        false,
    )
    .await?;
    decorate(&app, &mut result.session)?;
    Ok(result.session)
}
#[tauri::command]
pub async fn get_agent_native_activity(app: AppHandle) -> Result<Value, String> {
    let mut value: Value = native(&app, "activity", json!({}), false).await?;
    value["features"]["remote"] = json!(true);
    Ok(value)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn invoke_agent_native_service(
    app: AppHandle,
    service: String,
    method: String,
    args: Option<Vec<Value>>,
    scope: Option<Value>,
) -> Result<Value, String> {
    if service == "IZCodeAgentService"
        && matches!(
            method.as_str(),
            "listSavedWorkflows"
                | "getSavedWorkflow"
                | "saveSavedWorkflow"
                | "deleteSavedWorkflow"
                | "listSavedWorkflowRuns"
        )
    {
        return crate::services::agent_workflows::invoke_service(
            &app,
            &method,
            args.unwrap_or_default(),
        )
        .await;
    }
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
    crate::services::agent_automation::invoke(&app, &method, args.unwrap_or_default()).await
}
#[tauri::command]
pub async fn invoke_agent_remote(
    app: AppHandle,
    method: String,
    args: Option<Vec<Value>>,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let remote = app.state::<InprocessAgentState>().remote_projects(&state).await;
    remote.invoke(&method, args.unwrap_or_default()).await
}

#[tauri::command]
pub async fn get_agent_extensions(app: AppHandle) -> Result<Value, String> {
    native(&app, "getExtensions", json!({}), false).await
}
#[tauri::command]
pub async fn get_agent_plugin_store(app: AppHandle) -> Result<Value, String> {
    native(&app, "getPluginStore", json!({}), false).await
}
#[tauri::command]
pub async fn add_agent_plugin_marketplace(
    app: AppHandle,
    source: String,
) -> Result<Value, String> {
    native(&app, "addPluginMarketplace", json!({"source":source}), true).await
}
#[tauri::command]
pub async fn update_agent_plugin_marketplace(
    app: AppHandle,
    marketplace: Option<String>,
) -> Result<Value, String> {
    native(
        &app,
        "updatePluginMarketplace",
        json!({"marketplace":marketplace}),
        true,
    )
    .await
}
#[tauri::command]
pub async fn remove_agent_plugin_marketplace(
    app: AppHandle,
    marketplace: String,
) -> Result<Value, String> {
    native(
        &app,
        "removePluginMarketplace",
        json!({"marketplace":marketplace}),
        true,
    )
    .await
}
#[tauri::command]
pub async fn install_agent_marketplace_plugin(
    app: AppHandle,
    marketplace: String,
    plugin_name: String,
) -> Result<Value, String> {
    native(
        &app,
        "installMarketplacePlugin",
        json!({"marketplace":marketplace,"pluginName":plugin_name}),
        true,
    )
    .await
}
#[tauri::command]
pub async fn restore_agent_builtin_plugin(
    app: AppHandle,
    plugin_id: String,
) -> Result<Value, String> {
    native(
        &app,
        "restoreBuiltinPlugin",
        json!({"pluginId":plugin_id}),
        true,
    )
    .await
}
#[tauri::command]
pub async fn update_agent_marketplace_plugin(
    app: AppHandle,
    plugin_id: String,
) -> Result<Value, String> {
    native(
        &app,
        "updateMarketplacePlugin",
        json!({"pluginId":plugin_id}),
        true,
    )
    .await
}
#[tauri::command]
pub async fn uninstall_agent_marketplace_plugin(
    app: AppHandle,
    plugin_id: String,
) -> Result<Value, String> {
    native(
        &app,
        "uninstallMarketplacePlugin",
        json!({"pluginId":plugin_id}),
        true,
    )
    .await
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
    fn completed_and_cancelled_receipts_remain_accepted_after_lost_renderer_ack() {
        for status in ["accepted", "completed", "cancelled"] {
            let result=json!({"results":[{"key":{"sessionId":"owned","commandId":"owned-request"},"result":{"commandId":"owned-request","status":status}}]});
            assert_eq!(command_receipt(&result,"lc:owned","owned-request")["status"],"accepted");
            assert_eq!(command_receipt(&result,"lc:other","owned-request")["status"],"unknown");
        }
    }
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
