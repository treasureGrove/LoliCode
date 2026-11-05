use crate::{
    services::{
        agent_host::canonical_project,
        agent_terminal::{dimensions, AgentTerminals, TerminalSnapshot},
        inprocess_agent::InprocessAgentState,
    },
    store::AppState,
};
use serde_json::json;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

fn key(session_id: String, terminal_id: String) -> Result<(String, String), String> {
    if session_id.is_empty()
        || session_id.len() > 128
        || terminal_id != format!("{session_id}:terminal")
    {
        return Err("无效的会话终端".into());
    }
    Ok((session_id, terminal_id))
}

#[tauri::command]
pub(crate) async fn start_agent_terminal(
    app: AppHandle,
    session_id: String,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let key = key(session_id, terminal_id)?;
    let terminals = app.state::<AgentTerminals>();
    let _lifecycle = terminals.lifecycle.lock().await;
    let project = super::agent_dispatch::session_file_root(&app, &key.0).await?;
    let remote = app
        .state::<InprocessAgentState>()
        .remote_projects(&app.state::<AppState>())
        .await;
    if remote.owns(Path::new(&project)) {
        return Err("交互终端目前仅支持本地工作区".into());
    }
    let path = tauri::async_runtime::spawn_blocking(move || canonical_project(&project))
        .await
        .map_err(|_| "无法读取终端工作区")??;
    terminals.start(app.clone(), key, &path, cols, rows).await
}

#[tauri::command]
pub(crate) fn get_agent_terminal(
    terminals: State<'_, AgentTerminals>,
    session_id: String,
    terminal_id: String,
) -> Result<TerminalSnapshot, String> {
    terminals.snapshot(&key(session_id, terminal_id)?)
}

#[tauri::command]
pub(crate) fn write_agent_terminal(
    terminals: State<'_, AgentTerminals>,
    session_id: String,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > 256 * 1024 {
        return Err("单次终端输入过长".into());
    }
    terminals.send(
        &key(session_id, terminal_id)?,
        json!({ "type": "input", "data": data }),
    )
}

#[tauri::command]
pub(crate) fn resize_agent_terminal(
    terminals: State<'_, AgentTerminals>,
    session_id: String,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    dimensions(cols, rows)?;
    terminals.send(
        &key(session_id, terminal_id)?,
        json!({ "type": "resize", "cols": cols, "rows": rows }),
    )
}

#[tauri::command]
pub(crate) async fn close_agent_terminal(
    terminals: State<'_, AgentTerminals>,
    session_id: String,
    terminal_id: String,
) -> Result<(), String> {
    let _lifecycle = terminals.lifecycle.lock().await;
    terminals.close(&key(session_id, terminal_id)?)
}
