//! GitHub source management stays on the trusted desktop IPC surface.
use super::{
    agent_dispatch::{accounts, check_project, get_agent_session, native},
    agent_secretary::verify_task,
};
use crate::{
    services::{
        inprocess_agent::InprocessAgentState,
        secretary_github::{
            self as github, AutoCandidate, DecisionStatus, GithubRule, GithubState, Source,
            SOURCE_GATE,
        },
    },
    store::AppState,
};
use lolicode_agent::{AgentSecretaryState, AgentSecretaryTask};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

// Serialize reconciliation and launch batches. The source mutation lock is
// released between launches so an explicit pause can stop the next one.
static POLICY_DISPATCH_GATE: Mutex<()> = Mutex::const_new(());

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

fn reconcile_policy_receipts(source: &mut Source, tasks: &[AgentSecretaryTask]) {
    if let Some(repo_id) = source.repository_id {
        for decision in &mut source.state.policy.decisions {
            if decision.status == DecisionStatus::Dispatched {
                continue;
            }
            let request = github::import_request_id(repo_id, &decision.item_id);
            if let Some(task) = tasks.iter().find(|task| task.request_id == request) {
                if task.automatic {
                    decision.status = DecisionStatus::Dispatched;
                    decision.task_id = Some(task.id.clone());
                    decision.error = None;
                } else if decision.status == DecisionStatus::Queued {
                    decision.status = DecisionStatus::Failed;
                    decision.error = Some("该条目已手动交办，自动派工已跳过".into());
                }
            }
        }
    }
    source.fail_queued_decisions("上次自动派工已中断，可手动交办该条目");
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
    if old.repository_id == next.repository_id && old.account_id == next.account_id {
        next.state.policy = old.state.policy;
        reconcile_policy_receipts(&mut next, &tasks);
        next.disable_policy("来源已重新绑定，请重新启用自动派工")?;
    } else {
        next.state.policy.revision = old
            .state
            .policy
            .revision
            .checked_add(1)
            .ok_or("自动派工规则版本溢出")?;
    }
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

    let _dispatch = POLICY_DISPATCH_GATE.lock().await;
    let gate = SOURCE_GATE.lock().await;
    check_project(app, &project)?;
    let current = Source::load(db, session_id)?;
    if current.revision != before.revision {
        return Ok(current.state);
    }
    let mut next = match updated {
        Ok(next) => next,
        Err(error) => {
            let mut next = current;
            next.state.error = Some(error);
            next
        }
    };
    let tasks = task_registry(app, session_id).await?.tasks;
    project_receipts(&mut next, &tasks);
    reconcile_policy_receipts(&mut next, &tasks);
    if let Some(repo_id) = next.repository_id {
        next.auto_candidates.retain(|candidate| {
            let request = github::import_request_id(repo_id, &candidate.item.id);
            !tasks.iter().any(|task| task.request_id == request)
        });
    }
    let candidates = next.reserve_candidates();
    next.revision = before
        .revision
        .checked_add(1)
        .ok_or("GitHub 来源版本溢出")?;
    next.save(db, session_id)?;
    if candidates.is_empty() {
        return Ok(next.state);
    }
    drop(gate);
    let binding = bind_auto_project(app, &project).await;
    for candidate in candidates {
        launch_candidate(app, session_id, &project, candidate, &binding).await?;
    }
    Ok(Source::load(db, session_id)?.state)
}

async fn bind_auto_project(app: &AppHandle, project: &str) -> Result<(), String> {
    let accounts = accounts(app).await?;
    let state = app.state::<AppState>();
    app.state::<InprocessAgentState>()
        .bind_background_project(app, &state, project.into(), accounts)
        .await?;
    Ok(())
}

async fn launch_candidate(
    app: &AppHandle,
    session_id: &str,
    project: &str,
    candidate: AutoCandidate,
    binding: &Result<(), String>,
) -> Result<(), String> {
    let _gate = SOURCE_GATE.lock().await;
    let state = app.state::<AppState>();
    let db = &state.db;
    let mut source = Source::load(db, session_id)?;
    let decision = &candidate.decision;
    if !source.state.monitoring
        || !source.state.policy.enabled
        || source.state.policy.revision != decision.policy_revision
    {
        return Ok(());
    }
    let Some(index) = source.state.policy.decisions.iter().position(|entry| {
        entry.item_id == decision.item_id
            && entry.policy_revision == decision.policy_revision
            && entry.status == DecisionStatus::Queued
    }) else {
        return Ok(());
    };
    let result = async {
        binding.as_ref().map_err(Clone::clone)?;
        check_project(app, project)?;
        let repo = source
            .state
            .repository
            .as_deref()
            .ok_or("GitHub 来源已断开")?;
        let repo_id = source.repository_id.ok_or("GitHub 仓库身份记录不完整")?;
        let request_id = github::import_request_id(repo_id, &decision.item_id);
        let registry = task_registry(app, session_id).await?;
        if let Some(task) = registry
            .tasks
            .into_iter()
            .find(|task| task.request_id == request_id)
        {
            if task.automatic {
                return Ok(task);
            }
            return Err("该条目已手动交办，自动派工已跳过".into());
        }
        let mut context: Value = serde_json::from_str(&github::source_context(
            repo,
            &candidate.item,
            &source.state.items,
        ))
        .map_err(|_| "无法编码 GitHub 来源依据")?;
        context["authorization"] = json!({
            "kind": "explicit_rule",
            "ruleId": decision.rule_id,
            "policyRevision": decision.policy_revision,
            "actorId": decision.actor_id,
            "repositoryId": repo_id,
        });
        let title: String = format!(
            "GitHub #{} · {}",
            candidate.item.number, candidate.item.title
        )
        .chars()
        .take(160)
        .collect();
        let task: AgentSecretaryTask = native(
            app,
            "delegateSecretaryTask",
            json!({
                "sessionId": session_id,
                "title": title,
                "instructions": candidate.instructions,
                "sourceContext": context.to_string(),
                "requestId": request_id,
                "executionMode": "worktree",
                "automatic": true,
            }),
            true,
        )
        .await?;
        verify_task(app, session_id, project, None, &task)?;
        Ok::<_, String>(task)
    }
    .await;
    let saved = &mut source.state.policy.decisions[index];
    match result {
        Ok(task) => {
            saved.status = DecisionStatus::Dispatched;
            saved.task_id = Some(task.id.clone());
            if let Some(item) = source
                .state
                .items
                .iter_mut()
                .find(|item| item.id == decision.item_id)
            {
                item.task_id = Some(task.id);
            }
        }
        Err(error) => {
            saved.status = DecisionStatus::Failed;
            saved.error = Some(error.chars().take(500).collect());
        }
    }
    source.revision = source
        .revision
        .checked_add(1)
        .ok_or("GitHub 来源版本溢出")?;
    source.save(db, session_id)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_agent_secretary_github_policy(
    app: AppHandle,
    session_id: String,
    enabled: bool,
    mut rules: Vec<GithubRule>,
    expected_revision: Option<u64>,
) -> Result<GithubState, String> {
    let logins = github::validate_rules(&mut rules)?;
    let project = secretary_project(&app, &session_id).await?;
    let state = app.state::<AppState>();
    let db = &state.db;
    let before = Source::load(db, &session_id)?;
    let account = before.account_id.ok_or("请先绑定 GitHub 仓库")?;
    if expected_revision.is_some_and(|revision| revision != before.state.policy.revision) {
        return Err("自动派工规则已更新，请刷新后重试".into());
    }
    if enabled && (!before.state.monitoring || logins.is_empty()) {
        return Err("请先开启自动收件并保存至少一条启用的规则".into());
    }
    let actors = if enabled {
        tokio::time::timeout(
            Duration::from_secs(22),
            github::resolve_policy_actors(account, logins),
        )
        .await
        .map_err(|_| "验证规则账户超时，请重试")??
    } else {
        Default::default()
    };
    let _gate = SOURCE_GATE.lock().await;
    check_project(&app, &project)?;
    let mut source = Source::load(db, &session_id)?;
    if source.account_id != before.account_id
        || source.repository_id != before.repository_id
        || source.state.policy.revision != before.state.policy.revision
        || (enabled && !source.state.monitoring)
    {
        return Err("GitHub 来源或规则已更新，请刷新后重试".into());
    }
    source.set_policy(enabled, rules, actors)?;
    source.revision = source
        .revision
        .checked_add(1)
        .ok_or("GitHub 来源版本溢出")?;
    source.save(db, &session_id)?;
    Ok(source.state)
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
        if !enabled {
            source.disable_policy("自动收件已关闭，可手动交办该条目")?;
        }
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
    let mut next = Source {
        revision: current
            .revision
            .checked_add(1)
            .ok_or("GitHub 来源版本溢出")?,
        ..Source::default()
    };
    next.state.policy.revision = current
        .state
        .policy
        .revision
        .checked_add(1)
        .ok_or("自动派工规则版本溢出")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_dispatch_reconciles_existing_native_task_without_replay() {
        let mut source = Source {
            repository_id: Some(10),
            ..Source::default()
        };
        source.state.policy.decisions = ["issue:1", "issue:2", "issue:3"]
            .into_iter()
            .map(|id| {
                serde_json::from_value(json!({
                "itemId": id, "title": "Request", "url": "https://github.com/test/repo/issues/1",
                "ruleId": "triage", "ruleName": "Triage", "policyRevision": 1,
                "actorId": 17, "status": "queued", "decidedAt": 100,
            })).unwrap()
            })
            .collect();
        let task = |id: &str, automatic: bool| {
            serde_json::from_value::<AgentSecretaryTask>(json!({
                "id": id, "parentSessionId": "lc:secretary", "sessionId": "lc:worker",
                "title": "Request", "instructions": "Inspect", "status": "cancelled",
                "createdAt": 100, "updatedAt": 101, "projectPath": "D:/repo",
                "requestId": github::import_request_id(10, id), "automatic": automatic,
            }))
            .unwrap()
        };
        reconcile_policy_receipts(
            &mut source,
            &[task("issue:1", true), task("issue:2", false)],
        );
        assert_eq!(
            source.state.policy.decisions[0].status,
            DecisionStatus::Dispatched
        );
        assert_eq!(
            source.state.policy.decisions[0].task_id.as_deref(),
            Some("issue:1")
        );
        assert_eq!(
            source.state.policy.decisions[1].status,
            DecisionStatus::Failed
        );
        assert!(source.state.policy.decisions[1]
            .error
            .as_deref()
            .unwrap()
            .contains("手动"));
        assert_eq!(
            source.state.policy.decisions[2].status,
            DecisionStatus::Failed
        );
        assert!(source.reserve_candidates().is_empty());
    }
}
