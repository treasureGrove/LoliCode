//! Explicit desktop publication. A worker or GitHub source cannot call this path.
use super::{
    agent_dispatch::get_agent_session,
    agent_secretary::verify_task,
    agent_secretary_github::{secretary_project, task_registry},
};
use crate::{
    database::Database,
    services::{
        secretary_draft_pr::{self as git, ChangedFile, TaskGit},
        secretary_github::{self as github, GithubReplyClient, Source},
    },
    store::AppState,
};
use lolicode_agent::{AgentSecretaryExecutionMode, AgentSecretaryTask, AgentStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

static PR_GATE: Mutex<()> = Mutex::const_new(());
const TITLE_LIMIT: usize = 200;
const BODY_LIMIT: usize = 16_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReceiptStatus {
    Pending,
    Published,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum PullLifecycle {
    Draft,
    Open,
    Merged,
    Closed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftReceipt {
    status: ReceiptStatus,
    title: String,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lifecycle: Option<PullLifecycle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Destination {
    repository: String,
    repo_id: u64,
    account_id: u64,
    login: String,
    base_branch: String,
    head_branch: String,
}

#[derive(Deserialize, Serialize)]
struct Delivery {
    destination: Destination,
    head: String,
    base: String,
    tree: String,
    commit: String,
    receipt: DraftReceipt,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftPreview {
    repository: String,
    login: String,
    base_branch: String,
    head_branch: String,
    head_revision: String,
    base_revision: String,
    tree_revision: String,
    changed_file_count: usize,
    changes: Vec<ChangedFile>,
    patch: String,
    patch_truncated: bool,
    title: String,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    receipt: Option<DraftReceipt>,
}

async fn task(
    app: &AppHandle,
    session_id: &str,
    task_id: &str,
) -> Result<AgentSecretaryTask, String> {
    let project = secretary_project(app, session_id).await?;
    let registry = task_registry(app, session_id).await?;
    let task = registry
        .tasks
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or("任务不存在")?;
    verify_task(app, session_id, &project, Some(task_id), &task)?;
    if task.worktree.is_none() || task.execution_mode != AgentSecretaryExecutionMode::Worktree {
        return Err("草稿 PR 需要独立工作树任务".into());
    }
    Ok(task)
}

async fn task_git(
    app: &AppHandle,
    task: &AgentSecretaryTask,
    repo: &str,
) -> Result<TaskGit, String> {
    let worker = get_agent_session(app.clone(), task.session_id.clone()).await?;
    if task.status != "completed"
        || worker.status != AgentStatus::Idle
        || !worker.queued_messages.is_empty()
        || !worker.session.coordination.as_ref().is_some_and(|link| {
            link.role == "worker"
                && link.task_id.as_deref() == Some(task.id.as_str())
                && link.parent_session_id.as_deref() == Some(task.parent_session_id.as_str())
        })
    {
        return Err("请等独立工作树任务完成后再准备草稿 PR".into());
    }
    TaskGit::open(
        &crate::config::get_app_config_dir().join("agent/native"),
        Path::new(&task.project_path),
        &task.id,
        task.worktree.as_ref().ok_or("任务没有工作树")?,
        repo,
    )
    .await
}

fn source_for_task(db: &Database, task: &AgentSecretaryTask) -> Result<(String, u64, u64), String> {
    let source = Source::load(db, &task.parent_session_id)?;
    let repo = github::repository(
        source
            .state
            .repository
            .as_deref()
            .ok_or("请先绑定 GitHub 仓库")?,
    )?;
    if let Some(url) = &task.source_url {
        let root = format!("https://github.com/{repo}/");
        if !url
            .get(..root.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&root))
        {
            return Err("任务的 GitHub 来源与当前绑定仓库不一致".into());
        }
    }
    Ok((
        repo,
        source.repository_id.ok_or("仓库身份未验证")?,
        source.account_id.ok_or("GitHub 账户身份未验证")?,
    ))
}

async fn destination(
    app: &AppHandle,
    task: &AgentSecretaryTask,
    client: &GithubReplyClient,
) -> Result<Destination, String> {
    let (repository, repo_id, account_id) = source_for_task(&app.state::<AppState>().db, task)?;
    let endpoint = format!("repos/{repository}");
    let (account, repo) = tokio::try_join!(
        client.request("user", None),
        client.request(&endpoint, None)
    )?;
    if account["id"].as_u64() != Some(account_id)
        || repo["id"].as_u64() != Some(repo_id)
        || !repo["full_name"]
            .as_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(&repository))
    {
        return Err("GitHub 账户或仓库已变化，请恢复原绑定后重试".into());
    }
    let login = account["login"]
        .as_str()
        .filter(|login| {
            !login.is_empty()
                && login.len() <= 100
                && login
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        .ok_or("GitHub 登录名无效")?;
    let base = repo["default_branch"]
        .as_str()
        .filter(|name| !name.is_empty() && name.len() < 255 && !name.chars().any(char::is_control))
        .ok_or("无法读取 GitHub 默认分支")?;
    let head_branch = task
        .worktree
        .as_ref()
        .ok_or("任务没有工作树")?
        .branch
        .clone();
    if head_branch == base {
        return Err("草稿 PR 的任务分支不能是默认分支".into());
    }
    Ok(Destination {
        repository,
        repo_id,
        account_id,
        login: login.into(),
        base_branch: base.into(),
        head_branch,
    })
}

async fn base(client: &GithubReplyClient, target: &Destination) -> Result<String, String> {
    let response = client
        .draft_pr_base(&target.repository, &target.base_branch)
        .await?;
    if response["name"].as_str() != Some(target.base_branch.as_str()) {
        return Err("GitHub 默认分支已变化，请重新预览".into());
    }
    Ok(git::revision(
        response["commit"]["sha"]
            .as_str()
            .ok_or("GitHub 基线无效")?,
    )?
    .into())
}

fn key(session: &str, task: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{session}:{task}").as_bytes())
    )
}

fn load(db: &Database, key: &str) -> Result<Option<Delivery>, String> {
    db.get_setting(&format!("lolicode_secretary_draft_pr:{key}"))
        .map_err(|_| "无法读取草稿 PR 回执".to_owned())?
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| "草稿 PR 回执无法读取，原记录已保留".into())
        })
        .transpose()
}

fn save(db: &Database, key: &str, delivery: &Delivery) -> Result<(), String> {
    let value = serde_json::to_string(delivery).map_err(|_| "无法编码草稿 PR 回执")?;
    db.set_setting(&format!("lolicode_secretary_draft_pr:{key}"), &value)
        .map_err(|_| "无法保存草稿 PR 回执".into())
}

fn verify_destination(saved: &Destination, current: &Destination) -> Result<(), String> {
    if saved.repo_id != current.repo_id
        || saved.account_id != current.account_id
        || saved.head_branch != current.head_branch
        || !saved.repository.eq_ignore_ascii_case(&current.repository)
    {
        return Err("请恢复原 GitHub 账户和仓库后核对草稿 PR".into());
    }
    Ok(())
}

fn verified_pull(
    pull: &Value,
    delivery: &Delivery,
    marker: &str,
    previously_published: bool,
) -> Option<(u64, String, PullLifecycle)> {
    let target = &delivery.destination;
    if pull["user"]["id"].as_u64()? != target.account_id
        || pull["head"]["repo"]["id"].as_u64()? != target.repo_id
        || pull["base"]["repo"]["id"].as_u64()? != target.repo_id
        || pull["head"]["ref"].as_str()? != target.head_branch
        || pull["base"]["ref"].as_str()? != target.base_branch
        || (!previously_published
            && (pull["head"]["sha"].as_str()? != delivery.commit
                || !pull["body"].as_str()?.trim_end().ends_with(marker)))
    {
        return None;
    }
    let number = pull["number"].as_u64().filter(|value| *value > 0)?;
    if previously_published && delivery.receipt.number != Some(number) {
        return None;
    }
    let url = format!("https://github.com/{}/pull/{number}", target.repository);
    if pull["html_url"].as_str()? != url {
        return None;
    }
    let lifecycle = if pull["merged_at"].is_string() {
        PullLifecycle::Merged
    } else {
        match pull["state"].as_str()? {
            "closed" => PullLifecycle::Closed,
            "open" if pull["draft"] == true => PullLifecycle::Draft,
            "open" => PullLifecycle::Open,
            _ => return None,
        }
    };
    Some((number, url, lifecycle))
}

fn update_receipt(
    receipt: &mut DraftReceipt,
    (number, url, lifecycle): (u64, String, PullLifecycle),
) {
    receipt.status = ReceiptStatus::Published;
    receipt.number = Some(number);
    receipt.url = Some(url);
    receipt.lifecycle = Some(lifecycle);
    receipt.error = None;
}

async fn candidates(
    client: &GithubReplyClient,
    delivery: &Delivery,
    marker: &str,
) -> Result<Option<(u64, String, PullLifecycle)>, String> {
    let target = &delivery.destination;
    let response = client
        .draft_pr_candidates(&target.repository, &target.head_branch)
        .await?;
    let pulls = response.as_array().ok_or("GitHub PR 列表格式无效")?;
    let mut matched = pulls
        .iter()
        .filter_map(|pull| verified_pull(pull, delivery, marker, false));
    let result = matched.next();
    if matched.next().is_some() || result.is_none() && !pulls.is_empty() {
        return Err("远端任务分支已有其他 PR，请在 GitHub 核对".into());
    }
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_agent_secretary_draft_pr(
    app: AppHandle,
    session_id: String,
    task_id: String,
) -> Result<DraftPreview, String> {
    let task = task(&app, &session_id, &task_id).await?;
    let app_state = app.state::<AppState>();
    let key = key(&session_id, &task_id);
    if let Some(mut saved) = load(&app_state.db, &key)? {
        let (repo, repo_id, account_id) = source_for_task(&app_state.db, &task)?;
        if !saved.destination.repository.eq_ignore_ascii_case(&repo)
            || saved.destination.repo_id != repo_id
            || saved.destination.account_id != account_id
        {
            return Err("请恢复原 GitHub 账户和仓库后查看草稿 PR".into());
        }
        if matches!(saved.receipt.status, ReceiptStatus::Published) {
            let observed = async {
                let client = github::reply_client().await?;
                let current = destination(&app, &task, &client).await?;
                verify_destination(&saved.destination, &current)?;
                let number = saved.receipt.number.ok_or("草稿 PR 回执缺少编号")?;
                let pull = client
                    .draft_pr_detail(&saved.destination.repository, number)
                    .await?;
                Ok::<_, String>(verified_pull(&pull, &saved, "", true))
            }
            .await;
            match observed {
                Ok(Some(found)) => update_receipt(&mut saved.receipt, found),
                _ => saved.receipt.error = Some("PR 状态暂未刷新，可在 GitHub 查看".into()),
            }
        }
        let target = saved.destination;
        return Ok(DraftPreview {
            repository: target.repository,
            login: target.login,
            base_branch: target.base_branch,
            head_branch: target.head_branch,
            head_revision: saved.head,
            base_revision: saved.base,
            tree_revision: saved.tree,
            changes: vec![],
            changed_file_count: 0,
            patch: String::new(),
            patch_truncated: true,
            title: saved.receipt.title.clone(),
            body: saved.receipt.body.clone(),
            receipt: Some(saved.receipt),
        });
    }
    let client = github::reply_client().await?;
    let target = destination(&app, &task, &client).await?;
    let git = task_git(&app, &task, &target.repository).await?;
    let base = base(&client, &target).await?;
    let snapshot = git.snapshot(&base).await?;
    let mut body: String = task
        .summary
        .as_deref()
        .unwrap_or("")
        .chars()
        .take(3000)
        .collect();
    if let Some(url) = &task.source_url {
        body.push_str(&format!("\n\nSource: {url}"));
    }
    Ok(DraftPreview {
        repository: target.repository,
        login: target.login,
        base_branch: target.base_branch,
        head_branch: target.head_branch,
        head_revision: snapshot.head,
        base_revision: base,
        tree_revision: snapshot.tree,
        changed_file_count: snapshot.changes.len(),
        changes: snapshot.changes,
        patch: snapshot.patch,
        patch_truncated: snapshot.patch_truncated,
        title: task.title.chars().take(150).collect(),
        body: body.trim().into(),
        receipt: None,
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "Named arguments are the desktop publish contract."
)]
#[tauri::command(rename_all = "camelCase")]
pub async fn publish_agent_secretary_draft_pr(
    app: AppHandle,
    session_id: String,
    task_id: String,
    head_revision: String,
    base_revision: String,
    tree_revision: String,
    title: String,
    body: String,
) -> Result<DraftReceipt, String> {
    let title = title.trim();
    let body = body.trim();
    if title.is_empty()
        || title.chars().count() > TITLE_LIMIT
        || title.chars().any(char::is_control)
        || body.len() > BODY_LIMIT
        || body.contains('\0')
        || body.contains("<!-- lolicode-draft-pr:")
    {
        return Err("请输入有效的草稿 PR 标题和正文，正文最多 16000 字节".into());
    }
    let head = git::revision(&head_revision)?;
    let expected_base = git::revision(&base_revision)?;
    let tree = git::revision(&tree_revision)?;
    let _gate = PR_GATE.lock().await;
    let task = task(&app, &session_id, &task_id).await?;
    let client = github::reply_client().await?;
    let current = destination(&app, &task, &client).await?;
    let app_state = app.state::<AppState>();
    let db = &app_state.db;
    let key = key(&session_id, &task_id);
    let marker = format!("<!-- lolicode-draft-pr:{key} -->");
    let mut delivery = if let Some(saved) = load(db, &key)? {
        verify_destination(&saved.destination, &current)?;
        if saved.head != head
            || saved.base != expected_base
            || saved.tree != tree
            || saved.receipt.title != title
            || saved.receipt.body != body
        {
            return Err("已有待核对的草稿 PR，请重试原审阅内容".into());
        }
        if matches!(saved.receipt.status, ReceiptStatus::Published) {
            return Ok(saved.receipt);
        }
        saved
    } else {
        let git = task_git(&app, &task, &current.repository).await?;
        if base(&client, &current).await? != expected_base {
            return Err("GitHub 基线已变化，请重新预览".into());
        }
        let snapshot = git.snapshot(expected_base).await?;
        if snapshot.head != head || snapshot.tree != tree {
            return Err("工作树内容已变化，请重新预览".into());
        }
        let commit = git
            .commit(head, tree, &current.login, current.account_id)
            .await?;
        Delivery {
            destination: current,
            head: head.into(),
            base: expected_base.into(),
            tree: tree.into(),
            commit,
            receipt: DraftReceipt {
                status: ReceiptStatus::Pending,
                title: title.into(),
                body: body.into(),
                url: None,
                number: None,
                lifecycle: None,
                error: None,
            },
        }
    };
    save(db, &key, &delivery)?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(100), async {
        if let Some(found) = candidates(&client, &delivery, &marker).await? {
            return Ok(found);
        }
        let target = &delivery.destination;
        let git = task_git(&app, &task, &target.repository).await?;
        git.check_reviewed_base(
            &delivery.base,
            &base(&client, target).await?,
            &delivery.commit,
        )
        .await?;
        let (_, repo_id, account_id) = source_for_task(db, &task)?;
        if repo_id != target.repo_id || account_id != target.account_id {
            return Err("当前 GitHub 绑定已变化".into());
        }
        git.push(
            &target.repository,
            &delivery.commit,
            &client.draft_pr_git_header()?,
        )
        .await?;
        git.check_reviewed_base(
            &delivery.base,
            &base(&client, target).await?,
            &delivery.commit,
        )
        .await?;
        let response = client
            .create_secretary_draft_pr(
                &target.repository,
                &target.head_branch,
                &target.base_branch,
                title,
                &format!("{body}\n\n{marker}"),
            )
            .await?;
        verified_pull(&response, &delivery, &marker, false)
            .ok_or_else(|| "草稿 PR 结果尚未核对，请重试".into())
    })
    .await
    .unwrap_or_else(|_| Err("草稿 PR 结果尚未确认，请重试核对".into()));
    match result {
        Ok(found) => update_receipt(&mut delivery.receipt, found),
        Err(error) => delivery.receipt.error = Some(error),
    }
    save(db, &key, &delivery)?;
    Ok(delivery.receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovers_only_its_own_reviewed_pull_and_observes_lifecycle() {
        let branch = "TG/secretary/0123456789abcdef0123456789abcdef";
        let mut delivery = Delivery {
            destination: Destination {
                repository: "owner/repo".into(),
                repo_id: 17,
                account_id: 42,
                login: "member".into(),
                base_branch: "main".into(),
                head_branch: branch.into(),
            },
            head: "original-head".into(),
            tree: "reviewed-tree".into(),
            base: "original-base".into(),
            commit: "published-commit".into(),
            receipt: DraftReceipt {
                status: ReceiptStatus::Pending,
                title: "Draft".into(),
                body: "Reviewed".into(),
                url: None,
                number: None,
                lifecycle: None,
                error: None,
            },
        };
        let marker = "<!-- lolicode-draft-pr:fixture -->";
        let mut pull = json!({
            "number": 3, "draft": true, "state": "open", "user": { "id": 42 },
            "body": format!("Reviewed\n\n{marker}"),
            "head": {"repo":{"id":17},"ref":branch,"sha":"published-commit"},
            "base": {"repo":{"id":17},"ref":"main"},
            "html_url": "https://github.com/owner/repo/pull/3"
        });
        let observed = verified_pull(&pull, &delivery, marker, false).unwrap();
        assert!(matches!(observed.2, PullLifecycle::Draft));
        pull["user"]["id"] = json!(99);
        assert!(verified_pull(&pull, &delivery, marker, false).is_none());
        pull["user"]["id"] = json!(42);
        pull["head"]["sha"] = json!("different-commit");
        assert!(verified_pull(&pull, &delivery, marker, false).is_none());
        update_receipt(&mut delivery.receipt, observed);
        pull["merged_at"] = json!("2026-11-03T10:00:00Z");
        assert!(matches!(
            verified_pull(&pull, &delivery, "", true).unwrap().2,
            PullLifecycle::Merged
        ));
        pull["head"]["repo"]["id"] = json!(99);
        assert!(verified_pull(&pull, &delivery, "", true).is_none());
    }
}
