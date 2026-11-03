//! GitHub source management stays on the trusted desktop IPC surface.
use super::{
    agent_dispatch::{check_project, get_agent_session, native},
    agent_secretary::verify_task,
};
use crate::{
    services::secretary_github::{self as github, GithubState, Source, SOURCE_GATE},
    store::AppState,
};
use lolicode_agent::{AgentSecretaryState, AgentSecretaryTask};
use serde_json::json;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub(super) async fn secretary_project(app: &AppHandle, id: &str) -> Result<String, String> {
    if !id.starts_with("lc:") {
        return Err("只有当前本体秘书可连接 GitHub 来源".into());
    }
    let session = get_agent_session(app.clone(), id.into()).await?.session;
    if !session
        .coordination
        .as_ref()
        .is_some_and(|value| value.role == "secretary")
    {
        return Err("只有秘书主会话可管理 GitHub 来源".into());
    }
    Ok(session.project_path)
}

pub(super) async fn task_registry(
    app: &AppHandle,
    id: &str,
) -> Result<AgentSecretaryState, String> {
    let state: AgentSecretaryState = native(
        app,
        "getSecretary",
        json!({"sessionId": id, "refresh": false}),
        false,
    )
    .await?;
    if state.session_id != id {
        return Err("返回的秘书与当前选择不一致".into());
    }
    Ok(state)
}

fn project_receipts(source: &mut Source, tasks: &[AgentSecretaryTask]) {
    let Some(repo_id) = source.repository_id else {
        return;
    };
    for item in &mut source.state.items {
        let request = github::import_request_id(repo_id, &item.id);
        if let Some(task) = tasks.iter().find(|task| task.request_id == request) {
            item.task_id = Some(task.id.clone());
        }
    }
}

async fn fetch_source(repository: &str, source: &Source) -> Result<Source, String> {
    tokio::time::timeout(
        Duration::from_secs(22),
        github::synchronize(repository, source),
    )
    .await
    .map_err(|_| "GitHub 同步超时，原收件与游标已保留".to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_agent_secretary_github(
    app: AppHandle,
    session_id: String,
) -> Result<GithubState, String> {
    secretary_project(&app, &session_id).await?;
    let db = &app.state::<AppState>().db;
    Ok(Source::load(db, &session_id)?.state)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn bind_agent_secretary_github(
    app: AppHandle,
    session_id: String,
    repository: String,
) -> Result<GithubState, String> {
    let project = secretary_project(&app, &session_id).await?;
    let repository = github::repository(&repository)?;
    let db = &app.state::<AppState>().db;
    let old = Source::load(db, &session_id)?;
    let mut next = fetch_source(&repository, &Source::default()).await?;

    let _gate = SOURCE_GATE.lock().await;
    check_project(&app, &project)?;
    if Source::load(db, &session_id)?.revision != old.revision {
        return Err("GitHub 来源已更新，请刷新后重试绑定".into());
    }
    let tasks = task_registry(&app, &session_id).await?.tasks;
    project_receipts(&mut next, &tasks);
    next.state.monitoring = old.state.monitoring
        && old.repository_id == next.repository_id
        && old.account_id == next.account_id;
    next.revision = old.revision.checked_add(1).ok_or("GitHub 来源版本溢出")?;
    next.save(db, &session_id)?;
    Ok(next.state)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn refresh_agent_secretary_github(
    app: AppHandle,
    session_id: String,
) -> Result<GithubState, String> {
    refresh_source(&app, &session_id, false).await
}

pub(crate) async fn refresh_monitored_secretary(app: &AppHandle, id: &str) -> Result<(), String> {
    refresh_source(app, id, true).await.map(|_| ())
}

async fn refresh_source(
    app: &AppHandle,
    session_id: &str,
    monitored_only: bool,
) -> Result<GithubState, String> {
    let db = &app.state::<AppState>().db;
    if monitored_only {
        let cached = Source::load(db, session_id)?;
        if !cached.state.monitoring || cached.state.repository.is_none() {
            return Ok(cached.state);
        }
    }
    let project = secretary_project(app, session_id).await?;
    let before = Source::load(db, session_id)?;
    if monitored_only && (!before.state.monitoring || before.state.repository.is_none()) {
        return Ok(before.state);
    }
    let repo = before
        .state
        .repository
        .as_deref()
        .ok_or("请先绑定 GitHub 仓库")?;
    let updated = fetch_source(repo, &before).await;

    let _gate = SOURCE_GATE.lock().await;
    check_project(app, &project)?;
    let current = Source::load(db, session_id)?;
    if current.revision != before.revision {
        return Ok(current.state);
    }
    let mut next = match updated {
        Ok(mut next) => {
            let tasks = task_registry(app, session_id).await?.tasks;
            project_receipts(&mut next, &tasks);
            next
        }
        Err(error) => {
            let mut next = current;
            next.state.error = Some(error);
            next
        }
    };
    next.revision = before
        .revision
        .checked_add(1)
        .ok_or("GitHub 来源版本溢出")?;
    next.save(db, session_id)?;
    Ok(next.state)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_agent_secretary_github_monitoring(
    app: AppHandle,
    session_id: String,
    enabled: bool,
) -> Result<GithubState, String> {
    let project = secretary_project(&app, &session_id).await?;
    let _gate = SOURCE_GATE.lock().await;
    check_project(&app, &project)?;
    let db = &app.state::<AppState>().db;
    let mut source = Source::load(db, &session_id)?;
    if enabled && source.state.repository.is_none() {
        return Err("请先绑定 GitHub 仓库".into());
    }
    if source.state.monitoring != enabled {
        source.revision = source
            .revision
            .checked_add(1)
            .ok_or("GitHub 来源版本溢出")?;
        source.state.monitoring = enabled;
        source.save(db, &session_id)?;
    }
    Ok(source.state)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn disconnect_agent_secretary_github(
    app: AppHandle,
    session_id: String,
) -> Result<GithubState, String> {
    let project = secretary_project(&app, &session_id).await?;
    let _gate = SOURCE_GATE.lock().await;
    check_project(&app, &project)?;
    let db = &app.state::<AppState>().db;
    let current = Source::load(db, &session_id)?;
    let next = Source {
        revision: current
            .revision
            .checked_add(1)
            .ok_or("GitHub 来源版本溢出")?,
        ..Source::default()
    };
    next.save(db, &session_id)?;
    Ok(next.state)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delegate_agent_secretary_github_item(
    app: AppHandle,
    session_id: String,
    item_id: String,
    instructions: String,
    request_id: String,
    locale: Option<String>,
) -> Result<AgentSecretaryTask, String> {
    if request_id.trim().is_empty() || request_id.len() > 200 || request_id.contains('\0') {
        return Err("GitHub 交办请求编号无效".into());
    }
    if instructions.trim().is_empty() || instructions.len() > 65536 {
        return Err("请填写明确的任务要求，最多 64 KiB".into());
    }
    let project = secretary_project(&app, &session_id).await?;
    let _gate = SOURCE_GATE.lock().await;
    check_project(&app, &project)?;
    let db = &app.state::<AppState>().db;
    let mut source = Source::load(db, &session_id)?;
    let repo = source
        .state
        .repository
        .as_deref()
        .ok_or("请先绑定 GitHub 仓库")?;
    let repo_id = source.repository_id.ok_or("GitHub 仓库身份记录不完整")?;
    let item = source
        .state
        .items
        .iter()
        .position(|item| item.id == item_id)
        .ok_or("此 GitHub 条目已不在当前来源的收件箱中")?;
    let record = &source.state.items[item];
    let stable_id = github::import_request_id(repo_id, &record.id);

    // The native task registry is the delivery receipt. If the desktop lost
    // its IPC reply or restarted before writing the inbox receipt, the next
    // attempt recovers that exact task instead of launching a second worker.
    let registry = task_registry(&app, &session_id).await?;
    let task = if let Some(existing) = registry
        .tasks
        .into_iter()
        .find(|task| task.request_id == stable_id)
    {
        existing
    } else {
        let title: String = format!("GitHub #{} · {}", record.number, record.title)
            .chars()
            .take(160)
            .collect();
        native(
            &app,
            "delegateSecretaryTask",
            json!({
                "sessionId": session_id,
                "title": title,
                "instructions": instructions,
                "sourceContext": github::source_context(repo, record, &source.state.items),
                "requestId": stable_id,
                "executionMode": "worktree",
                "locale": locale,
            }),
            true,
        )
        .await?
    };
    verify_task(&app, &session_id, &project, None, &task)?;
    source.state.items[item].task_id = Some(task.id.clone());
    source.save(db, &session_id)?;
    Ok(task)
}
